// Market Lab compute off the engine's main thread. Backtests and walk-forward sweeps run in worker
// threads so the HTTP server and the desktop stay responsive while they grind. The worker runs the
// same pure functions as the main thread (replay.js); results are identical (tested).
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import os from 'node:os';
import { ReplaySession, runReplay, walkForward, strategyParams } from './replay.js';

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

// Small pool: at most half the CPUs (never all), at least 1. Jobs queue when all workers are busy.
export class LabPool {
  constructor({ size = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))) } = {}) { this.size = size; this.workers = []; this.queue = []; this.pending = new Map(); this.seq = 0; this.stats = { done: 0, failed: 0, maxQueue: 0 }; }
  #spawn() {
    const w = new Worker(new URL(import.meta.url)); w.busy = false; w.unref();
    w.on('message', ({ id, ok, result, error }) => { const p = this.pending.get(id); this.pending.delete(id); w.busy = false; ok ? (this.stats.done++, p?.resolve(result)) : (this.stats.failed++, p?.reject(new Error(error))); this.#next(); });
    w.on('error', e => { for (const [id, p] of this.pending) if (p.worker === w) { this.pending.delete(id); p.reject(e); } this.workers = this.workers.filter(x => x !== w); this.#next(); });
    this.workers.push(w); return w;
  }
  #next() {
    if (!this.queue.length) return;
    let w = this.workers.find(x => !x.busy); if (!w && this.workers.length < this.size) w = this.#spawn(); if (!w) return;
    const job = this.queue.shift(); w.busy = true; this.pending.set(job.id, { ...job, worker: w }); w.postMessage({ id: job.id, task: job.task });
  }
  run(task) { return new Promise((resolve, reject) => { this.queue.push({ id: ++this.seq, task, resolve, reject }); this.stats.maxQueue = Math.max(this.stats.maxQueue, this.queue.length); this.#next(); }); }
  status() { return { size: this.size, workers: this.workers.length, busy: this.workers.filter(w => w.busy).length, queued: this.queue.length, ...this.stats }; }
  async close() { await Promise.all(this.workers.map(w => w.terminate())); this.workers = []; }
}
