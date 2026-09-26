// Resumable 24-hour target soak. Each invocation is bounded (default 120 seconds).
// Usage: node scripts/upgrade-soak.mjs [--dir <isolated directory>] [--max-seconds 120]
// Resume by passing the same --dir on the next run. No installed data or network is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { CoreDatabase } from '../src/core/database.js';
import { UnifiedLedger } from '../src/core/ledger.js';
import { RiskGovernor } from '../src/core/risk.js';
import { MarketEventBus } from '../src/core/eventBus.js';
import { LabPool } from '../src/core/labWorker.js';
import { acquireComputeLease, releaseComputeLease } from '../src/core/computeLease.js';

const args = process.argv.slice(2), value = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const maxSeconds = Number(value('--max-seconds') ?? 120), targetHours = Number(value('--target-hours') ?? 24);
if (!(maxSeconds > 0 && maxSeconds <= 600 && targetHours > 0)) throw new Error('Invalid soak duration');
const dir = path.resolve(value('--dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-upgrade-soak-')));
for (const app of ['Money Printer OS', 'Money Printer Evolution Lab']) {
  const installed = path.resolve(process.env.APPDATA || os.homedir(), app, 'data');
  if (dir === installed || dir.startsWith(installed + path.sep)) throw new Error('Soak directory must not be installed app data');
}
fs.mkdirSync(dir, { recursive: true });
const checkpointFile = path.join(dir, 'checkpoint.json'), dbFile = path.join(dir, 'paper.sqlite'), leaseFile = path.join(dir, 'compute-budget.json');
const load = () => fs.existsSync(checkpointFile) ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) : null;
const atomic = data => { const temp = `${checkpointFile}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(data, null, 2)); fs.renameSync(temp, checkpointFile); };
const previous = load();
if (previous && (previous.schema !== 'mpo.upgrade-soak.v1' || previous.dir !== dir)) throw new Error('Incompatible soak checkpoint');

// Any accidental parent-thread network call fails immediately. The only worker task is
// the pure replay evaluator; this soak never imports an order transport or credentials.
let networkAttempts = 0;
const noNetwork = () => { networkAttempts++; throw new Error('SOAK_NETWORK_FORBIDDEN'); };
globalThis.fetch = noNetwork; http.request = noNetwork; https.request = noNetwork; net.Socket.prototype.connect = noNetwork;

const task = { kind: 'run', records: [0, 15000, 30000, 45000].map((t, i) => ({ key: 'X', observedAt: t, availableAt: t, bid: 100 + i, ask: 100 + i, synthetic: false })),
  opts: { start: 0, end: 45000, key: 'X', strategy: 'buy-hold', feeBps: 10, slippageBps: 5, cash: 1000 } };
let store, ledger, risk, pool;
const open = () => { store = new CoreDatabase(dbFile); ledger = new UnifiedLedger(store); risk = new RiskGovernor(store, ledger, new MarketEventBus()); pool = new LabPool({ size: 1, maxQueue: 2, defaultTimeoutMs: 5000, leaseFile }); };
const close = async () => { await pool?.close(); store?.close(); };
const append = (sourceKey, kind, gross, at, fee = '0') => ledger.append({ sourceKey, at, mode: 'PAPER', venue: 'soak', account: 'isolated', currency: 'USD', kind,
  instrumentId: ['BUY', 'SELL'].includes(kind) ? 'SOAK-USD' : null, strategyId: ['BUY', 'SELL'].includes(kind) ? 'soak-v1' : null,
  eventId: ['BUY', 'SELL'].includes(kind) ? 'soak-event' : null, quantity: ['BUY', 'SELL'].includes(kind) ? '1' : '0', gross, fee, reference: 'isolated deterministic soak' });
const portfolio = () => ledger.portfolio('PAPER').accounts.find(a => a.venue === 'soak' && a.account === 'isolated');
const count = () => store.db.prepare("SELECT COUNT(*) n FROM ledger WHERE source_key LIKE 'soak-sell-%'").get().n;
let failures = [], workerDone = previous?.workerDone || 0, workerCancelled = previous?.workerCancelled || 0, restarts = previous?.restarts || 0;
const startedAt = previous?.startedAt || Date.now(), oldElapsedMs = previous?.observedElapsedMs || 0, startRss = process.memoryUsage().rss;
const baselineRss = previous?.startRssMiB ? previous.startRssMiB * 1048576 : startRss;
let maxRss = Math.max(startRss, (previous?.maxRssMiB || 0) * 1048576), maxQueue = previous?.maxQueue || 0, cycles = previous?.cycles || 0, stop = false;
let runStart = null;
process.once('SIGINT', () => { stop = true; });
process.once('SIGTERM', () => { stop = true; });

try {
  open();
  if (!store.db.prepare("SELECT 1 FROM ledger WHERE source_key='soak-deposit'").get()) append('soak-deposit', 'DEPOSIT', '1000', Date.now());
  // Crash recovery: complete a previously recorded BUY using its original source key.
  const buys = store.db.prepare("SELECT source_key FROM ledger WHERE source_key LIKE 'soak-buy-%'").all();
  for (const row of buys) {
    const suffix = row.source_key.slice('soak-buy-'.length);
    if (!store.db.prepare('SELECT 1 FROM ledger WHERE source_key=?').get(`soak-sell-${suffix}`)) append(`soak-sell-${suffix}`, 'SELL', '10.02', Date.now(), '0.01');
  }
  cycles = count();
  runStart = performance.now();
  const runDeadline = runStart + maxSeconds * 1000, targetMs = targetHours * 3600000;
  let nextReport = runStart + 15000;
  const report = final => {
    const observedElapsedMs = oldElapsedMs + Math.round(performance.now() - runStart), account = portfolio();
    const summary = { schema: 'mpo.upgrade-soak.v1', dir, startedAt, updatedAt: Date.now(), targetHours, observedElapsedMs, targetReached: observedElapsedMs >= targetMs,
      final, cycles, ledgerEntries: store.db.prepare('SELECT COUNT(*) n FROM ledger').get().n, cashUsd: account?.cash ?? null, openPositions: account?.positions.length ?? null,
      workerDone, workerCancelled, restarts, maxQueue, startRssMiB: Math.round(baselineRss / 1048576), maxRssMiB: Math.round(maxRss / 1048576),
      networkAttempts, localApi: { exercised: false, reason: 'Core-only soak forbids network; HTTP latency measured separately' }, failures };
    atomic(summary); console.log(JSON.stringify(summary)); return summary;
  };
  if (oldElapsedMs >= targetMs) report(true);
  else while (!stop && performance.now() < runDeadline && oldElapsedMs + performance.now() - runStart < targetMs) {
    const at = Date.now(), i = cycles + 1;
    const order = { mode: 'PAPER', venue: 'soak', account: 'isolated', instrumentId: 'SOAK-USD', strategyId: 'soak-v1', eventId: 'soak-event',
      currency: 'USD', side: 'BUY', quantity: 1, price: 10, feeUsd: .01, slippageBps: 0, liquidityUsd: 1000, quoteAt: at };
    if (!risk.evaluate(order, at).allowed) throw new Error(`Paper risk unexpectedly blocked cycle ${i}`);
    append(`soak-buy-${i}`, 'BUY', '10', at, '0.01');
    risk.recordMark({ venue: 'soak', account: 'isolated', instrumentId: 'SOAK-USD', bid: 9.99, quantity: 1, liquidationFee: .01, at, source: 'isolated executable bid' });
    const marked = risk.lossMetrics('PAPER', at);
    if (!(marked.equityUsd < 1000 && marked.equityUsd > 999)) throw new Error(`Invalid open marked equity: ${marked.equityUsd}`);
    append(`soak-sell-${i}`, 'SELL', '10.02', at + 1, '0.01');
    if (portfolio().cash !== '1000.000000' || portfolio().positions.length) throw new Error('Paper ledger failed cash/position reconciliation');
    const result = await pool.run(task);
    if (result.evaluatorVersion !== 'market-replay.v2') throw new Error('Unexpected replay evaluator version');
    workerDone++;
    if (i % 10 === 0) {
      const held = acquireComputeLease({ owner: 'soak-cancel-holder', maxSlots: 1, file: leaseFile });
      if (!held.ok) throw new Error(`Cannot hold isolated compute slot: ${held.reason}`);
      try {
        const controller = new AbortController(), cancelled = pool.run(task, { signal: controller.signal });
        controller.abort();
        try { await cancelled; throw new Error('Cancelled worker job resolved'); }
        catch (e) { if (e.code !== 'LAB_CANCELLED') throw e; }
        workerCancelled++;
      } finally { releaseComputeLease(held.token, { file: leaseFile }); }
    }
    if (i % 50 === 0) {
      await close(); open(); restarts++;
      if (count() !== i || portfolio().cash !== '1000.000000') throw new Error('Restart recovery mismatch');
    }
    cycles = i; maxRss = Math.max(maxRss, process.memoryUsage().rss); maxQueue = Math.max(maxQueue, pool.status().maxQueue);
    if (maxQueue > 2 || maxRss - baselineRss > 256 * 1048576 || networkAttempts) throw new Error('Resource or network bound violated');
    if (performance.now() >= nextReport) { report(false); nextReport += 15000; }
    await delay(100);
  }
  report(true);
} catch (e) {
  failures.push(String(e?.stack || e));
  const observedElapsedMs = oldElapsedMs + (runStart === null ? 0 : Math.round(performance.now() - runStart));
  const summary = { schema: 'mpo.upgrade-soak.v1', dir, startedAt, updatedAt: Date.now(), targetHours, observedElapsedMs,
    targetReached: false, final: true, cycles, workerDone, workerCancelled, restarts, maxQueue,
    startRssMiB: Math.round(baselineRss / 1048576), maxRssMiB: Math.round(maxRss / 1048576), networkAttempts, failures };
  atomic(summary);
  console.error(JSON.stringify(summary));
  process.exitCode = 1;
} finally { await close(); }
