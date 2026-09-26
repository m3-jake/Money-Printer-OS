import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LabPool } from '../src/core/labWorker.js';
import { acquireComputeLease, releaseComputeLease } from '../src/core/computeLease.js';

const task = { kind: 'run', records: [
  { key: 'X', observedAt: 0, availableAt: 0, bid: 100, ask: 100, synthetic: false },
  { key: 'X', observedAt: 15000, availableAt: 15000, bid: 101, ask: 101, synthetic: false },
  { key: 'X', observedAt: 30000, availableAt: 30000, bid: 102, ask: 102, synthetic: false },
], opts: { start: 0, end: 30000, key: 'X', strategy: 'buy-hold', feeBps: 10 } };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-lab-pool-'));
  return { file: path.join(dir, 'budget.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('bounded queue, queued cancellation and deadline release capacity', async () => {
  const f = fixture(), held = acquireComputeLease({ owner: 'test-holder', maxSlots: 1, file: f.file });
  assert.equal(held.ok, true);
  const pool = new LabPool({ size: 1, maxQueue: 1, leaseFile: f.file });
  try {
    const controller = new AbortController();
    const cancelled = pool.run(task, { signal: controller.signal, timeoutMs: 1000 });
    await assert.rejects(pool.run(task), { code: 'LAB_QUEUE_FULL' });
    controller.abort();
    await assert.rejects(cancelled, { code: 'LAB_CANCELLED' });
    assert.equal(pool.status().cancelled, 1);
    await assert.rejects(pool.run(task, { timeoutMs: 10 }), { code: 'LAB_TIMEOUT' });
    assert.equal(pool.status().timedOut, 1);
    releaseComputeLease(held.token, { file: f.file });
    const result = await pool.run(task);
    assert.equal(result.evaluatorVersion, 'market-replay.v2');
    assert.equal(pool.status().done, 1);
    assert.equal(pool.status().queued, 0);
  } finally { releaseComputeLease(held.token, { file: f.file }); await pool.close(); f.cleanup(); }
});

test('worker crash and shutdown each settle jobs once and release leases', async () => {
  const f = fixture(), pool = new LabPool({ size: 1, maxQueue: 2, leaseFile: f.file });
  try {
    const crashed = pool.run(task);
    assert.equal(pool.workers.length, 1);
    await pool.workers[0].terminate();
    await assert.rejects(crashed, /worker exited/i);
    assert.equal(pool.status().failed, 1);
    const running = pool.run(task), queued = pool.run(task);
    const runningCheck = assert.rejects(running, { code: 'LAB_CLOSED' });
    const queuedCheck = assert.rejects(queued, { code: 'LAB_CLOSED' });
    await pool.close();
    await runningCheck;
    await queuedCheck;
    assert.equal(pool.status().failed, 3);
    await assert.rejects(pool.run(task), /closed/);
    const probe = acquireComputeLease({ owner: 'test-probe', maxSlots: 1, file: f.file });
    assert.equal(probe.ok, true);
    releaseComputeLease(probe.token, { file: f.file });
  } finally { await pool.close(); f.cleanup(); }
});

test('cancellation holds shared slot until worker exit; lease cleanup errors cannot lose result', async () => {
  const f = fixture(), pool = new LabPool({ size: 1, maxQueue: 1, leaseFile: f.file });
  try {
    const aborter = new AbortController();
    const cancelled = pool.run(task, { signal: aborter.signal });
    aborter.abort();
    assert.equal(pool.status().busy, 1);
    assert.equal(acquireComputeLease({ owner: 'probe', maxSlots: 1, file: f.file }).ok, false);
    await assert.rejects(cancelled, { code: 'LAB_CANCELLED' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(pool.status().workers, 0);
    const slow = { kind: 'walkforward', records: Array.from({ length: 8000 }, (_, i) => ({ key: 'X', observedAt: i * 15000, availableAt: i * 15000, bid: 100 + Math.sin(i / 5), ask: 100.1 + Math.sin(i / 5), synthetic: false })),
      opts: { key: 'X', strategy: 'momentum', grid: { lookback: [3, 5, 8, 13], thresholdBps: [5, 10, 20, 40] }, folds: 6, start: 0, end: 7999 * 15000, feeBps: 10 } };
    const result = pool.run(slow);
    fs.renameSync(f.file, `${f.file}.saved`);
    fs.mkdirSync(f.file);
    assert.ok((await result).evidence);
    assert.ok(pool.status().leaseReleaseErrors >= 1);
    fs.rmdirSync(f.file);
    fs.renameSync(`${f.file}.saved`, f.file);
    await new Promise(resolve => setTimeout(resolve, 150));
    const probe = acquireComputeLease({ owner: 'probe', maxSlots: 1, file: f.file });
    assert.equal(probe.ok, true);
    releaseComputeLease(probe.token, { file: f.file });
  } finally { await pool.close(); f.cleanup(); }
});
