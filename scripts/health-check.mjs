#!/usr/bin/env node
// Daily health check for the trader + Evolution Lab pair.
//
//   node scripts/health-check.mjs            human-readable, exit 1 if anything is RED
//   node scripts/health-check.mjs --json     machine-readable, for a scheduler or the agent lab
//
// Answers the three questions that actually matter day to day: is the lab still running, is the
// trader linked to it, and is the action queue staying small. The third one is not paranoia -
// an in-process research writer filled that queue to 99.74 GB on 2026-09-18, which is why the
// evolution furnace now lives in a separate app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const JSON_OUT = process.argv.includes('--json');
const TRADER_URL = process.env.MPO_TRADER_URL || 'http://127.0.0.1:8792';
const LAB_URL = process.env.MPO_LAB_URL || 'http://127.0.0.1:8793';

// Same layout rule the apps use, so this works unchanged on the Mac.
function userDataRoot(appName) {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', appName);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}
const TRADER_DATA = process.env.MONEY_PRINTER_DATA_DIR || path.join(userDataRoot('Money Printer OS'), 'data');

const QUEUE_WARN_MB = 16;      // store.js quarantines at 64 MB; warn well before that
const CHAMPION_STALE_H = 48;   // a lab that has not published in two days is stuck
const LINK_STALE_MIN = 30;

const checks = [];
const add = (level, name, detail) => checks.push({ level, name, detail });

async function getJson(url, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- trader
let trader = null;
try {
  trader = await getJson(`${TRADER_URL}/api/state`);
  add('OK', 'trader', `up, mode=${trader.mode}`);
  if (trader.mode !== 'paper') add('WARN', 'trader.mode', `mode is ${trader.mode}, not paper - live capital is at risk`);

  const link = trader.labLink || {};
  if (link.connected) {
    const ageMin = Math.round((link.ageMs ?? 0) / 60000);
    add(ageMin > LINK_STALE_MIN ? 'WARN' : 'OK', 'lab link',
      `connected via ${link.source}, gen ${link.generation}, champion ${link.championId}, ${ageMin}m old`);
  } else {
    add('RED', 'lab link', `not connected${link.error ? ': ' + link.error : ''} - the trader is not receiving champions`);
  }
  if (trader.system?.lastError) add('WARN', 'trader.lastError', String(trader.system.lastError).slice(0, 160));
} catch (e) {
  add('RED', 'trader', `unreachable at ${TRADER_URL} (${e.message})`);
}

// ---------------------------------------------------------------- lab
try {
  const lab = await getJson(`${LAB_URL}/api/state`);
  const s = lab.status || {};
  add(s.status === 'RUNNING' ? 'OK' : 'WARN', 'lab', `${s.status}, gen ${s.generation}, ${Number(s.variantsTested || 0).toLocaleString()} variants, ${s.workerCount} workers`);
  if (s.lastError) add('WARN', 'lab.lastError', String(s.lastError).slice(0, 160));
  if (lab.control?.paused) add('WARN', 'lab.control', `paused${lab.control.reason ? ': ' + lab.control.reason : ''}`);

  // A missing research-furnace.json / research-beast.json is read with a silent try/catch and
  // drops the furnace to NORMAL: 513 variants a generation instead of 4097 on 24 workers. It
  // looks healthy from the outside, so check the throughput knobs explicitly.
  const mode = s.researchMode || 'UNKNOWN';
  const batch = Number(s.currentBatchSize || 0);
  add(mode === 'NORMAL' ? 'WARN' : 'OK', 'research mode',
    `${mode}, batch ${batch}, ${s.workerCount} workers` + (mode === 'NORMAL' ? ' - profiles missing or disabled?' : ''));

  // Is the loop actually reaching disk? saveLocalLoop swallowed its failures, so on 2026-09-21
  // evolution-loop.json froze at generation 53,549 for ten hours while every other signal here
  // read healthy and the in-memory loop climbed to 120,602. Only an orphaned .tmp saved it.
  const lw = s.loopWrite || lab.status?.loopWrite;
  if (lw) {
    const staleMin = lw.staleMs == null ? null : Math.round(lw.staleMs / 60000);
    const bad = lw.lastWriteAt === 0 || (staleMin != null && staleMin > 10);
    add(bad ? 'RED' : lw.errors ? 'WARN' : 'OK', 'loop persisted',
      lw.lastWriteAt === 0 ? 'never written this run' :
      `${staleMin}m since last durable write, ${lw.errors} write error(s)` + (lw.lastError ? ` - ${String(lw.lastError).slice(0, 80)}` : ''));
  }

  const pubAt = lab.champion?.publishedAt;
  if (pubAt) {
    const h = (Date.now() - pubAt) / 3600000;
    add(h > CHAMPION_STALE_H ? 'WARN' : 'OK', 'champion', `${lab.champion.champion?.id} published ${h.toFixed(1)}h ago`);
  } else {
    add('WARN', 'champion', 'nothing published yet');
  }
  if (!(lab.traders || []).length) add('WARN', 'lab.traders', 'no trader is reporting back to the lab');
} catch (e) {
  add('RED', 'lab', `unreachable at ${LAB_URL} (${e.message}) - research is not running`);
}

// ---------------------------------------------------------------- disk
try {
  const q = path.join(TRADER_DATA, 'actions.ndjson');
  const mb = fs.existsSync(q) ? fs.statSync(q).size / 1048576 : 0;
  add(mb > QUEUE_WARN_MB ? 'RED' : 'OK', 'action queue', `${mb.toFixed(1)} MB`);

  const strays = fs.readdirSync(TRADER_DATA).filter(n => n.endsWith('.drain') || n.includes('.quarantined-'));
  add(strays.length ? 'WARN' : 'OK', 'stray queue files', strays.length ? strays.join(', ') : 'none');

  let bytes = 0;
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); try { if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size; } catch {} } })(TRADER_DATA);
  const gb = bytes / 1073741824;
  add(gb > 8 ? 'WARN' : 'OK', 'trader data dir', `${gb.toFixed(2)} GB`);
} catch (e) {
  add('WARN', 'disk', `could not inspect ${TRADER_DATA} (${e.message})`);
}

// ---------------------------------------------------------------- report
const worst = checks.some(c => c.level === 'RED') ? 'RED' : checks.some(c => c.level === 'WARN') ? 'WARN' : 'OK';
if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), overall: worst, checks }, null, 2));
} else {
  const mark = { OK: '  ok  ', WARN: ' warn ', RED: ' RED  ' };
  console.log(`MONEY PRINTER HEALTH // ${new Date().toISOString()} // ${worst}`);
  for (const c of checks) console.log(`${mark[c.level]} ${c.name.padEnd(18)} ${c.detail}`);
}
process.exit(worst === 'RED' ? 1 : 0);
