// Market Lab compute off the engine's main thread. Backtests and walk-forward sweeps run in worker
// threads so the HTTP server and the desktop stay responsive while they grind. The worker runs the
// same pure functions as the main thread (replay.js); results are identical (tested).
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import os from 'node:os';
import { ReplaySession, runReplay, walkForward, strategyParams } from './replay.js';
import { acquireComputeLease, renewComputeLease, releaseComputeLease, computeBudgetFile } from './computeLease.js';

export function computeTask(task) {
  const { kind, records, opts } = task;
  if (kind === 'run') return runReplay(new ReplaySession(records, { start: opts.start, end: opts.end }), { key: opts.key, strategy: opts.strategy, params: strategyParams(opts.strategy, opts.params), stepMs: opts.stepMs, feeBps: opts.feeBps, cash: opts.cash });
  if (kind === 'walkforward') return walkForward(records, opts);
  throw new Error('Unknown lab task');
}

if (!isMainThread && parentPort) {
  parentPort.on('message', ({ id, task }) => {
    try { parentPort.postMessage({ id, ok: true, result: computeTask(task) }); }
    catch (e) { parentPort.postMessage({ id, ok: false, error: String(e?.message || e) }); }
  });
}

// Bounded local pool. Each active job also owns one shared CPU lease so the trader and
// Evolution Lab cannot independently allocate the same machine headroom.
export class LabPool {
  constructor({ size = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))), maxQueue = 32, defaultTimeoutMs = 60000, leaseFile = computeBudgetFile() } = {}) {
    if (!Number.isInteger(size) || size < 1 || !Number.isInteger(maxQueue) || maxQueue < 1 || !(defaultTimeoutMs > 0)) throw new Error('Invalid Lab pool limits');
    this.size = size; this.maxQueue = maxQueue; this.defaultTimeoutMs = defaultTimeoutMs; this.leaseFile = leaseFile;
    this.workers = []; this.queue = []; this.pending = new Map(); this.seq = 0; this.closed = false; this.retry = null;
    this.stats = { done: 0, failed: 0, cancelled: 0, timedOut: 0, maxQueue: 0 };
  }
  #spawn() {
    const w = new Worker(new URL(import.meta.url)); w.busy = false; w.job = null; w.unref();
    w.on('message', ({ id, ok, result, error }) => {
      if (w.job?.id !== id) return; // late reply from a cancelled/expired job
      this.#settle(w.job, ok ? null : new Error(error || 'Worker task failed'), result);
    });
    const lost = e => {
      this.workers = this.workers.filter(x => x !== w);
      if (w.job) this.#settle(w.job, e || new Error('Lab worker exited'));
      this.#drain();
    };
    w.on('error', lost);
    w.on('exit', code => lost(new Error(`Lab worker exited (${code})`)));
    this.workers.push(w); return w;
  }
  #settle(job, error, result, outcome = 'failed') {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    clearInterval(job.leaseRenewal);
    if (job.signal && job.abort) job.signal.removeEventListener('abort', job.abort);
    this.queue = this.queue.filter(x => x !== job);
    this.pending.delete(job.id);
    if (job.lease) releaseComputeLease(job.lease, { file: this.leaseFile });
    if (job.worker?.job === job) { job.worker.job = null; job.worker.busy = false; }
    if (error) {
      if (outcome === 'cancelled') this.stats.cancelled++;
      else if (outcome === 'timedOut') this.stats.timedOut++;
      else this.stats.failed++;
      job.reject(error);
    } else { this.stats.done++; job.resolve(result); }
    if ((outcome === 'cancelled' || outcome === 'timedOut' || outcome === 'leaseLost') && job.worker) {
      this.workers = this.workers.filter(x => x !== job.worker);
      job.worker.terminate().catch(() => {});
    }
    this.#drain();
  }
  #drain() {
    if (this.closed) return;
    while (this.queue.length) {
      let w = this.workers.find(x => !x.busy);
      if (!w && this.workers.length >= this.size) return;
      const lease = acquireComputeLease({ owner: 'trader-market-lab', file: this.leaseFile });
      if (!lease.ok) {
        if (!this.retry) { this.retry = setTimeout(() => { this.retry = null; this.#drain(); }, 250); this.retry.unref(); }
        return;
      }
      if (!w) {
        try { w = this.#spawn(); }
        catch (e) { releaseComputeLease(lease.token, { file: this.leaseFile }); this.#settle(this.queue.shift(), e); continue; }
      }
      const job = this.queue.shift();
      if (job.settled) { releaseComputeLease(lease.token, { file: this.leaseFile }); continue; }
      job.worker = w; job.lease = lease.token; w.busy = true; w.job = job; this.pending.set(job.id, job);
      job.leaseRenewal = setInterval(() => {
        const renewed = renewComputeLease(job.lease, { file: this.leaseFile });
        if (!renewed.ok) this.#settle(job, Object.assign(new Error('Shared compute lease lost'), { code: 'LAB_LEASE_LOST' }), null, 'leaseLost');
      }, 20000);
      job.leaseRenewal.unref();
      try { w.postMessage({ id: job.id, task: job.task }); }
      catch (e) { this.#settle(job, e); }
    }
  }
  run(task, { signal = null, timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error('Lab pool is closed'));
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return Promise.reject(new Error('Invalid Lab job deadline'));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Lab job cancelled'), { code: 'LAB_CANCELLED' }));
    if (this.queue.length >= this.maxQueue) return Promise.reject(Object.assign(new Error('Lab queue full'), { code: 'LAB_QUEUE_FULL' }));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.seq, task, resolve, reject, signal, settled: false, worker: null, lease: null };
      job.abort = () => this.#settle(job, Object.assign(new Error('Lab job cancelled'), { code: 'LAB_CANCELLED' }), null, 'cancelled');
      if (signal) signal.addEventListener('abort', job.abort, { once: true });
      job.timer = setTimeout(() => this.#settle(job, Object.assign(new Error('Lab job timed out'), { code: 'LAB_TIMEOUT' }), null, 'timedOut'), timeoutMs);
      this.queue.push(job); this.stats.maxQueue = Math.max(this.stats.maxQueue, this.queue.length); this.#drain();
    });
  }
  status() { return { size: this.size, maxQueue: this.maxQueue, workers: this.workers.length, busy: this.workers.filter(w => w.busy).length, queued: this.queue.length, closed: this.closed, ...this.stats }; }
  async close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.retry);
    for (const job of [...this.queue, ...this.pending.values()]) this.#settle(job, Object.assign(new Error('Lab pool closed'), { code: 'LAB_CLOSED' }));
    const workers = this.workers; this.workers = [];
    await Promise.allSettled(workers.map(w => w.terminate()));
  }
}
