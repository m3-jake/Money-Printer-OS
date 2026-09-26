// Compare the pre-upgrade and bounded worker pools on an isolated copy of a real tape.
// Usage: node scripts/bench-marketlab-worker.mjs <BTC-USD.ndjson> [baseline-ref]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { tapeRecords } from '../src/core/replay.js';
import { LabPool } from '../src/core/labWorker.js';

const source = process.argv[2], baselineRef = process.argv[3] || '4a80e90';
if (!source || !fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error('Pass an existing tape file as the first argument');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-worker-bench-'));
try {
  const copy = path.join(dir, path.basename(source));
  fs.copyFileSync(source, copy);
  const rows = fs.readFileSync(copy, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const records = tapeRecords(rows, path.basename(source, '.ndjson'));
  if (records.length < 100) throw new Error('At least 100 valid quotes are needed');
  const old = spawnSync('git', ['show', `${baselineRef}:src/core/labWorker.js`], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') });
  if (old.status !== 0) throw new Error(`Cannot read baseline ${baselineRef}: ${old.stderr}`);
  const replayUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/core/replay.js')).href;
  const baselineFile = path.join(dir, 'baseline-worker.mjs');
  fs.writeFileSync(baselineFile, old.stdout.replace("from './replay.js'", `from '${replayUrl}'`));
  const { LabPool: BaselinePool } = await import(pathToFileURL(baselineFile).href);
  const start = records[0].availableAt, end = records.at(-1).availableAt;
  const task = { kind: 'walkforward', records, opts: { key: records[0].key, strategy: 'momentum', grid: { lookback: [3, 8, 15, 30], thresholdBps: [5, 10, 20, 40] }, folds: 4, start, end, stepMs: 15000, feeBps: 10, cash: 1000 } };
  const workload = async (Pool, options) => {
    const pool = new Pool({ size: 2, ...options });
    let maxLagMs = 0, prev = performance.now(), maxRss = process.memoryUsage().rss;
    const pulse = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - prev - 20); prev = now; maxRss = Math.max(maxRss, process.memoryUsage().rss); }, 20);
    const cpuStart = process.cpuUsage(), t0 = performance.now();
    try {
      const results = await Promise.all(Array.from({ length: 4 }, () => pool.run(task)));
      return { elapsedMs: Math.round(performance.now() - t0), cpuMs: Math.round((process.cpuUsage(cpuStart).user + process.cpuUsage(cpuStart).system) / 1000), maxLagMs: Math.round(maxLagMs * 10) / 10, peakRssMiB: Math.round(maxRss / 1048576), resultHash: createHash('sha256').update(JSON.stringify(results)).digest('hex'), pool: pool.status() };
    } finally { clearInterval(pulse); await pool.close(); }
  };
  const before = await workload(BaselinePool, {});
  const after = await workload(LabPool, { leaseFile: path.join(dir, 'compute-budget.json') });
  if (before.resultHash !== after.resultHash) throw new Error('Baseline and upgraded worker results differ');
  console.log(JSON.stringify({ source: path.basename(copy), copiedBytes: fs.statSync(copy).size, records: records.length, syntheticShare: records.filter(r => r.synthetic).length / records.length, baselineRef, jobs: 4, workers: 2, before, after }, null, 2));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
