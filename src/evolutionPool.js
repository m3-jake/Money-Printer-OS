import { Worker } from 'node:worker_threads';
import { MC_ROUNDS_WORKER, datasetToMessage } from './evolutionScoring.js';

const DEFAULT_WORKER_URL = new URL('./evolutionWorker.js', import.meta.url);

// Chunks are small enough that idle workers keep pulling work (dynamic load balance) and
// large enough that per-message overhead stays negligible.
export function chunkPlan(total, workers, chunkSize) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const out = [];
  if (!n) return out;
  const w = Math.max(1, Math.floor(Number(workers) || 1));
  let size = Math.floor(Number(chunkSize) || 0);
  if (!(size > 0)) size = Math.max(8, Math.min(64, Math.ceil(n / (w * 6))));
  for (let i = 0; i < n; i += size) out.push({ startIndex: i, count: Math.min(size, n - i) });
  return out;
}

export class EvolutionPool {
  #workers = [];
  #size = 1;
  #url;
  #closed = false;
  #chain = Promise.resolve();
  #job = null;
  #seq = 0;
  #stats = { spawned: 0, terminated: 0, retried: 0, chunksDone: 0, jobs: 0 };

  constructor({ size = 1, workerUrl = DEFAULT_WORKER_URL } = {}) {
    this.#url = workerUrl;
    this.#size = Math.max(1, Math.floor(Number(size) || 1));
  }

  get size() { return this.#size; }
  get activeWorkers() { return this.#workers.length; }
  get closed() { return this.#closed; }
  get threadIds() { return this.#workers.map(r => r.threadId); }
  stats() { return { ...this.#stats }; }

  resize(n) {
    const next = Math.max(1, Math.floor(Number(n) || 1));
    this.#size = next;
    if (this.#closed) return next;
    if (next >= this.#workers.length) for (const rec of this.#workers) rec.retire = false;
    while (this.#workers.length < next) this.#spawn();
    let surplus = this.#workers.length - next;
    for (let i = this.#workers.length - 1; i >= 0 && surplus > 0; i--) {
      const rec = this.#workers[i];
      if (rec.retire) continue;
      // Idle surplus dies now; busy surplus dies when its chunk completes.
      if (rec.busy) { rec.retire = true; surplus--; continue; }
      this.#kill(rec); surplus--;
    }
    this.#pump();
    return next;
  }

  // Concurrent score() calls are serialized so one dataset is resident per worker at a time.
  score(variants, dataset, options = {}) {
    const run = () => this.#runScore(variants, dataset, options);
    const next = this.#chain.then(run, run);
    this.#chain = next.then(() => {}, () => {});
    return next;
  }

  async close() {
    this.#closed = true;
    if (this.#job && !this.#job.settled) this.#fail(this.#job, new Error('evolution pool closed during scoring'));
    const list = this.#workers;
    this.#workers = [];
    await Promise.all(list.map(rec => {
      rec.dead = true; rec.busy = null; this.#stats.terminated++;
      try { return Promise.resolve(rec.worker.terminate()).catch(() => {}); } catch { return Promise.resolve(); }
    }));
  }

  // Test hook: kill the i-th live worker (crash-recovery coverage).
  terminateWorker(i = 0) {
    const rec = this.#workers[i];
    if (!rec) return false;
    const busy = rec.busy;
    rec.busy = null;
    this.#kill(rec);
    if (busy) this.#retry(busy.job, busy.chunk, new Error('evolution worker terminated'));
    else this.#pump();
    return true;
  }

  #runScore(variants, dataset, { chunkSize, rounds = MC_ROUNDS_WORKER, seed = null, onProgress = () => {} } = {}) {
    if (this.#closed) return Promise.reject(new Error('evolution pool is closed'));
    const list = Array.from(variants || []);
    if (!list.length) { this.#emit(onProgress, { completed: 0, total: 0, workers: this.#workers.length }); return Promise.resolve([]); }
    if (!dataset || !dataset.id) return Promise.reject(new Error('evolution pool requires a packed dataset'));
    const envChunk = Number(process.env.EVOLUTION_CHUNK || 0);
    const size = Number(chunkSize) > 0 ? Number(chunkSize) : (envChunk > 0 ? envChunk : 0);
    const plan = chunkPlan(list.length, this.#size, size);
    return new Promise((resolve, reject) => {
      this.#stats.jobs++;
      const job = {
        id: ++this.#seq, variants: list, datasetId: dataset.id, message: datasetToMessage(dataset),
        rounds, seed, onProgress, resolve, reject, settled: false,
        queue: plan.map(c => ({ ...c, attempts: 0 })), results: new Array(list.length),
        remaining: plan.length, completed: 0, total: list.length,
      };
      this.#job = job;
      this.#ensure();
      this.#pump();
    });
  }

  #ensure() {
    if (this.#closed) return;
    while (this.#workers.length < this.#size) this.#spawn();
  }

  #spawn() {
    const worker = new Worker(this.#url);
    const rec = { worker, threadId: worker.threadId, lastDatasetId: null, busy: null, dead: false, retire: false };
    worker.on('message', msg => this.#onMessage(rec, msg));
    worker.on('error', err => { if (rec.dead) return; this.#onFailure(rec, err instanceof Error ? err : new Error(String(err))); });
    worker.on('exit', code => { if (rec.dead) return; this.#onFailure(rec, new Error(`evolution worker exited (code ${code})`)); });
    this.#workers.push(rec);
    this.#stats.spawned++;
    return rec;
  }

  #kill(rec) {
    const idx = this.#workers.indexOf(rec);
    if (idx >= 0) this.#workers.splice(idx, 1);
    if (!rec.dead) {
      rec.dead = true;
      this.#stats.terminated++;
      try { Promise.resolve(rec.worker.terminate()).catch(() => {}); } catch {}
    }
    // Replacement only when the pool is still meant to be this big (shrink lowers #size first).
    if (!this.#closed && this.#workers.length < this.#size) this.#spawn();
  }

  #pump() {
    const job = this.#job;
    if (!job || job.settled) return;
    for (const rec of [...this.#workers]) {
      if (!job.queue.length) break;
      if (rec.busy || rec.retire || rec.dead) continue;
      this.#dispatch(rec, job, job.queue.shift());
    }
  }

  #dispatch(rec, job, chunk) {
    rec.busy = { job, chunk };
    // postMessage is ordered per worker, so the dataset always lands before the chunk using it.
    if (rec.lastDatasetId !== job.datasetId) {
      rec.worker.postMessage({ type: 'dataset', dataset: job.message });
      rec.lastDatasetId = job.datasetId;
    }
    rec.worker.postMessage({
      type: 'score', jobId: job.id, datasetId: job.datasetId, startIndex: chunk.startIndex,
      variants: job.variants.slice(chunk.startIndex, chunk.startIndex + chunk.count),
      rounds: job.rounds, seed: job.seed,
    });
  }

  #onMessage(rec, msg) {
    const busy = rec.busy;
    if (!busy || !msg || msg.jobId !== busy.job.id) return;
    const { job, chunk } = busy;
    if (msg.type === 'error') {
      rec.busy = null;
      if (rec.retire) this.#kill(rec);
      this.#retry(job, chunk, new Error(String(msg.error || 'evolution worker error')));
      return;
    }
    if (msg.type !== 'scored') return;
    rec.busy = null;
    const metrics = msg.metrics || [];
    for (let i = 0; i < chunk.count; i++) {
      const at = chunk.startIndex + i;
      job.results[at] = { variant: job.variants[at], metrics: metrics[i] === undefined ? null : metrics[i] };
    }
    job.completed += chunk.count;
    job.remaining--;
    this.#stats.chunksDone++;
    if (rec.retire) this.#kill(rec);
    this.#pump();
    this.#emit(job.onProgress, { completed: job.completed, total: job.total, workers: this.#workers.length });
    if (job.remaining <= 0) this.#finish(job);
  }

  #onFailure(rec, err) {
    const busy = rec.busy;
    rec.busy = null;
    this.#kill(rec);
    if (busy) this.#retry(busy.job, busy.chunk, err);
    else this.#pump();
  }

  #retry(job, chunk, err) {
    if (!job || job.settled) return;
    chunk.attempts = (chunk.attempts || 0) + 1;
    if (chunk.attempts > 1) { this.#fail(job, err); return; }
    this.#stats.retried++;
    job.queue.unshift(chunk);
    this.#ensure();
    this.#pump();
  }

  #finish(job) {
    if (job.settled) return;
    job.settled = true;
    if (this.#job === job) this.#job = null;
    job.resolve(job.results);
  }

  #fail(job, err) {
    if (job.settled) return;
    job.settled = true;
    if (this.#job === job) this.#job = null;
    job.reject(err instanceof Error ? err : new Error(String(err)));
  }

  // A throwing progress listener must never take the pool (or the daemon) down mid-generation.
  #emit(fn, payload) { try { fn(payload); } catch {} }
}
