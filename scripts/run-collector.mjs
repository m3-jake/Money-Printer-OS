#!/usr/bin/env node
// Standalone, self-restarting research tape collector (no trader, no orders).
//   node scripts/run-collector.mjs --data "C:/Users/<you>/AppData/Roaming/Money Printer OS/data"
// Safe to run while the trader is also up: src/researchCollector.js holds a per-data-dir lock,
// so whichever collector starts second exits and this loop retries it later (failover).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dataIdx = args.indexOf('--data');
const dataDir = dataIdx >= 0 ? args[dataIdx + 1] : process.env.MONEY_PRINTER_DATA_DIR;
if (!dataDir) {
  console.error('usage: node scripts/run-collector.mjs --data <data dir>  (or set MONEY_PRINTER_DATA_DIR)');
  process.exit(2);
}
const STABLE_AFTER_MS = 5 * 60_000;
const YIELD_RETRY_MS = 30_000;
let restarts = 0, child = null, stopping = false;
const log = (m) => console.log(`${new Date().toISOString()} collector-runner: ${m}`);

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [path.join(ROOT, 'src', 'researchCollector.js')], {
    cwd: ROOT,
    env: { ...process.env, MONEY_PRINTER_DATA_DIR: path.resolve(dataDir), POLYMARKET_AUTOSTART: 'false' },
    stdio: 'inherit',
  });
  log(`started pid ${child.pid} for ${path.resolve(dataDir)}`);
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    if (Date.now() - startedAt > STABLE_AFTER_MS) restarts = 0;
    // code 0 = another collector owns the data dir; poll until it goes away.
    const delay = code === 0 ? YIELD_RETRY_MS : Math.min(60_000, 1000 * 2 ** restarts++);
    log(`exited code=${code} signal=${signal}; restarting in ${delay} ms`);
    setTimeout(start, delay);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; child?.kill(sig); process.exit(0); });
start();
