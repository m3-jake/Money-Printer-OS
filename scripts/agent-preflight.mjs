#!/usr/bin/env node
// Agent preflight (self-improving loop plan, batch F item 6). Run before an agent session touches
// either app's data. Some agent hosts (the Claude desktop app's MSIX sandbox) see a stale virtualised
// copy of %APPDATA% instead of the live files; an agent that trusts it reads old state and may write
// into the copy. This compares what is on disk with what the running apps report over HTTP.
//
//   node scripts/agent-preflight.mjs          exit 0 = OK, 2 = stale view detected (stop), 3 = cannot verify
//   node scripts/agent-preflight.mjs --json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const JSON_OUT = process.argv.includes('--json');
const TRADER_URL = process.env.MPO_TRADER_URL || 'http://127.0.0.1:8792';
const LAB_URL = process.env.MPO_LAB_URL || 'http://127.0.0.1:8793';
const STALE_MS = Number(process.env.MPO_PREFLIGHT_STALE_MS || 15 * 60000);
function userDataRoot(appName) {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', appName);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}
const TRADER_DATA = process.env.MONEY_PRINTER_DATA_DIR || path.join(userDataRoot('Money Printer OS'), 'data');
const LAB_DATA = process.env.MPO_LAB_DATA_DIR || path.join(userDataRoot('Money Printer Evolution Lab'), 'data');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
async function getJson(url, ms = 6000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } finally { clearTimeout(t); }
}

// Pure comparison, exported for tests: a live app with an on-disk record far older than now is a stale view.
export function compareViews({ name, live, diskUpdatedAt, liveGeneration = null, diskGeneration = null, now = Date.now(), staleMs = STALE_MS }) {
  if (!live) return { name, verdict: 'UNVERIFIED', detail: 'app not reachable over HTTP; cannot compare' };
  if (!Number.isFinite(Number(diskUpdatedAt))) return { name, verdict: 'STALE_VIEW', detail: 'app is running but its status file is missing from this view of the disk' };
  const age = now - Number(diskUpdatedAt);
  if (age > staleMs) return { name, verdict: 'STALE_VIEW', detail: `app is running but the on-disk status is ${Math.round(age / 60000)} min old` };
  if (Number.isFinite(Number(liveGeneration)) && Number.isFinite(Number(diskGeneration)) && Number(diskGeneration) + 1000 < Number(liveGeneration)) return { name, verdict: 'STALE_VIEW', detail: `disk generation ${diskGeneration} is far behind live ${liveGeneration}` };
  return { name, verdict: 'OK', detail: `on-disk status ${Math.round(age / 1000)} s old` };
}

async function main() {
  const now = Date.now(), results = [];
  let trader = null; try { trader = await getJson(`${TRADER_URL}/api/health`); } catch {}
  const ts = readJson(path.join(TRADER_DATA, 'lab-link', 'trader-status.json'));
  results.push(compareViews({ name: 'trader', live: !!trader, diskUpdatedAt: ts?.updatedAt, now }));
  let lab = null; try { lab = await getJson(`${LAB_URL}/api/state`); } catch {}
  const ls = readJson(path.join(LAB_DATA, 'lab-link', 'status.json'));
  results.push(compareViews({ name: 'lab', live: !!lab, diskUpdatedAt: ls?.updatedAt, liveGeneration: lab?.status?.generation, diskGeneration: ls?.generation, now }));
  const stale = results.some(r => r.verdict === 'STALE_VIEW'), unverified = results.every(r => r.verdict === 'UNVERIFIED');
  const overall = stale ? 'STALE_VIEW' : unverified ? 'UNVERIFIED' : 'OK';
  const advice = stale ? 'STOP: this process sees a stale copy of the app data. Read state only through the HTTP APIs and never write under the data dirs from this session.' : unverified ? 'Neither app answered; on-disk state could not be verified. Treat it as possibly stale.' : 'Disk view matches the running apps.';
  if (JSON_OUT) console.log(JSON.stringify({ at: new Date(now).toISOString(), overall, advice, traderData: TRADER_DATA, labData: LAB_DATA, results }, null, 2));
  else { console.log(`AGENT PREFLIGHT // ${overall}`); for (const r of results) console.log(`  ${r.verdict.padEnd(11)} ${r.name.padEnd(7)} ${r.detail}`); console.log(advice); }
  process.exit(stale ? 2 : unverified ? 3 : 0);
}
const entry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (entry) main();
