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
import { loopPersistenceCheck, collectorCaptureCheck, generationAdvanceCheck, diskFreeCheck, orderPostsCheck, switchesCheck, rawRetentionCheck } from '../src/labHealth.js';

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
// Structured sections for --json (a scheduler or the daily self-report reads these).
const sections = { lab: {}, switches: {}, robinhood: {}, disk: {}, researchRaw: {}, fitness: {} };
const HEALTH_STATE = process.env.MPO_HEALTH_STATE_FILE || path.join(TRADER_DATA, 'health-check-state.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(HEALTH_STATE, 'utf8')); } catch { return {}; } };

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
  try {
    const h = await getJson(`${TRADER_URL}/api/health`);
    sections.switches.trader = h.switches || null;
    const sw = switchesCheck(h.switches); add(sw.level, 'switches', sw.detail);
  } catch (e) { add('WARN', 'switches', `trader /api/health unavailable (${e.message})`); }
  try {
    const fit = await getJson(`${TRADER_URL}/api/fitness`);
    for (const [id, m] of Object.entries(fit.modules || {})) sections.fitness[id] = { verdict: m.verdict, closes: m.paperRecord?.closes ?? null, blockers: (m.blockers || []).slice(0, 5), trial: m.trial?.status || null };
    add('OK', 'fitness', Object.entries(sections.fitness).map(([id, m]) => `${id} ${m.verdict}${m.trial ? ' trial ' + m.trial : ''}`).join(', ') || 'no modules');
  } catch (e) { add('WARN', 'fitness', `/api/fitness unavailable (${e.message}) - older build?`); }
} catch (e) {
  add('RED', 'trader', `unreachable at ${TRADER_URL} (${e.message})`);
}

// ---------------------------------------------------------------- robinhood (optional venue; an older build without the route is only a WARN)
try {
  const rh = await getJson(`${TRADER_URL}/api/robinhood`);
  const r = rh.readiness || {}, loop = rh.loop || {}, ev = rh.evolve || {}, ap = rh.journal?.autopilot || {};
  const armedOrReal = r.sessionArmed || r.realEnabled;
  add(armedOrReal ? 'WARN' : 'OK', 'robinhood', `${r.credentialsReady ? 'keys' : 'no keys'} keyValid=${!!r.keyValid} real=${!!r.realEnabled} armed=${!!r.sessionArmed} qualified=${!!r.qualified} auth=${r.authCode || 'n/a'}`);
  add(loop.running ? 'OK' : 'WARN', 'robinhood loop', loop.running ? `running every ${Math.round((loop.tickMs || 0) / 1000)}s, last tick ${loop.lastTickAt ? Math.round((Date.now() - loop.lastTickAt) / 60000) + 'm ago' : 'never'}` : 'not running (ROBINHOOD_AUTOSTART=false or venue disabled)');
  if (r.recoveryRequired || r.paperRecoveryRequired) add('RED', 'robinhood state', `${r.recoveryRequired ? 'real journal' : 'paper book'} requires recovery`);
  if (ap.enabled) add('WARN', 'robinhood real autopilot', `ENABLED on ${(ap.symbols || []).join(',')} (${ap.orderUsd} USD/order)`);
  const open = (rh.journal?.open || []).length, unverified = rh.journal?.stats?.unverified || 0;
  if (open) add(unverified ? 'WARN' : 'OK', 'robinhood exposure', `${open} open real row(s), ${unverified} unverified - the updater holds until flat`);
  const tape = Object.entries(ev.tapeDays || {}).map(([s, d]) => `${s} ${d}d`).join(', ');
  sections.robinhood.outbound = rh.outbound || null;
  const posts = orderPostsCheck(rh.outbound); add(posts.level, 'robinhood.orderPosts', posts.detail);
  add(ev.enabled === false ? 'WARN' : 'OK', 'robinhood evolve', `${ev.enabled === false ? 'disabled' : 'gen ' + (ev.generation || 0)}, ${ev.proposed ? 'champion ' + ev.proposed.paramsHash + ' PROPOSED' : 'no proposal'}, autopromote=${!!ev.autopromote}, tape ${tape || 'empty'}`);
} catch (e) {
  add('WARN', 'robinhood', `readiness unavailable (${e.message}) - older build or trader down`);
}

// ---------------------------------------------------------------- lab
try {
  const lab = await getJson(`${LAB_URL}/api/state`);
  const s = lab.status || {};
  add(s.status === 'RUNNING' ? 'OK' : 'WARN', 'lab', `${s.status}, gen ${s.generation}, ${Number(s.variantsTested || 0).toLocaleString()} variants, ${s.workerCount} workers`);
  if (s.lastError) add('WARN', 'lab.lastError', String(s.lastError).slice(0, 160));
  if (lab.control?.paused) add('WARN', 'lab.control', `paused${lab.control.reason ? ': ' + lab.control.reason : ''}`);
  sections.lab.status = s.status || null; sections.lab.generation = Number.isFinite(Number(s.generation)) ? Number(s.generation) : null;
  const hs = readState(), gen = generationAdvanceCheck(hs.lab || null, s);
  add(gen.level, 'lab.generation', gen.detail);
  try { fs.writeFileSync(HEALTH_STATE, JSON.stringify({ ...hs, lab: gen.state, at: Date.now() })); } catch {}
  sections.lab.modules = Object.fromEntries(Object.entries(lab.modules || {}).map(([id, m]) => [id, { status: m.status || null, phase: m.phase || null, updatedAt: m.updatedAt || null }]));
  const mods = Object.entries(sections.lab.modules);
  if (mods.length) add(mods.some(([, m]) => m.status === 'ERROR') ? 'WARN' : 'OK', 'lab.modules', mods.map(([id, m]) => `${id} ${m.phase || m.status}`).join(', '));
  try { const lh = await getJson(`${LAB_URL}/api/health`); sections.lab.health = lh.health || lh.status || null; sections.switches.lab = lh.switches || null; } catch {}

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
  const persistence = loopPersistenceCheck(s);
  add(persistence.level, 'loop persisted', persistence.detail);
  if (s.feed) add(s.feed.ready ? 'OK' : 'WARN', 'research observations', s.feed.ready ? `${s.feed.rowsTotal} rows; latest observation ${Math.round(s.feed.observationAgeMs / 60000)}m old` : String(s.feed.blockedReason || 'fresh observations unavailable'));
  add(s.paperPromotionAllowed === true ? 'OK' : 'WARN', 'candidate qualification', s.paperPromotionAllowed === true ? 'Paper comparison authorized by evidence' : 'Research only; no candidate authorized to replace the paper incumbent');

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
  sections.disk.dataDirBytes = bytes;
  try { const st = fs.statfsSync(TRADER_DATA), free = Number(st.bavail) * Number(st.bsize); sections.disk.freeBytes = free; const d = diskFreeCheck(free); add(d.level, 'disk free', d.detail); }
  catch (e) { add('WARN', 'disk free', `unknown (${e.message})`); }
} catch (e) {
  add('WARN', 'disk', `could not inspect ${TRADER_DATA} (${e.message})`);
}

// ---------------------------------------------------------------- tape collector
{
  let status = null;
  try { status = JSON.parse(fs.readFileSync(path.join(TRADER_DATA, 'research-capture-status.json'), 'utf8')); } catch {}
  const c = collectorCaptureCheck(status || {});
  add(c.level, 'tape collector', c.detail);
  const rr = rawRetentionCheck(status || {}); add(rr.level, 'research raw', rr.detail);
  sections.researchRaw = status?.retention || null;
}

// ---------------------------------------------------------------- report
const worst = checks.some(c => c.level === 'RED') ? 'RED' : checks.some(c => c.level === 'WARN') ? 'WARN' : 'OK';
if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), overall: worst, checks, sections }, null, 2));
} else {
  const mark = { OK: '  ok  ', WARN: ' warn ', RED: ' RED  ' };
  console.log(`MONEY PRINTER HEALTH // ${new Date().toISOString()} // ${worst}`);
  for (const c of checks) console.log(`${mark[c.level]} ${c.name.padEnd(18)} ${c.detail}`);
}
process.exit(worst === 'RED' ? 1 : 0);
