// Background mint-risk prefetcher (run item C1, 2026-10-03).
//
// The engine cycle used to await mintRisk() for its top candidates. On a slow Solana RPC that step took 2-11 s,
// so one slow answer stalled every paper book in the process. Now the cycle only asks for mints (request) and
// reads what is already known (get); lookups run here, off the cycle, a few at a time.
//
// Fail closed: a mint whose risk is not known yet is not tradable. The cycle treats get() === null as unknown.
// Circuit breaker: after `breakerFailures` failed lookups in a row, lookups pause for `breakerOpenMs`; cached
// answers are still served, and nothing is guessed while it is open.
export const RISK_PREFETCH_DEFAULTS = Object.freeze({ concurrency: 2, ttlMs: 120_000, maxQueue: 40, maxCache: 500, breakerFailures: 3, breakerOpenMs: 60_000 });

export class RiskPrefetcher {
  constructor({ lookup, now = () => Date.now(), ...opts } = {}) {
    if (typeof lookup !== 'function') throw new Error('RiskPrefetcher needs a lookup function');
    this.lookup = lookup; this.now = now; this.o = { ...RISK_PREFETCH_DEFAULTS, ...opts };
    this.cache = new Map(); this.queue = []; this.queued = new Set(); this.inFlight = new Set();
    this.failStreak = 0; this.openUntil = 0;
    this.counts = { requested: 0, looked: 0, ok: 0, failed: 0, dropped: 0, breakerTrips: 0 };
    this.latencies = []; this.lastError = null; this.idle = Promise.resolve();
  }
  fresh(mint) { const hit = this.cache.get(mint); return hit && this.now() - hit.at < this.o.ttlMs ? hit : null; }
  // Known risk for a mint, or null when it is unknown (never looked up, expired, or failed).
  get(mint) { return this.fresh(mint)?.value ?? null; }
  // Ask for lookups, best first. Never blocks: returns at once and the lookups run in the background.
  request(mints = []) {
    for (const mint of mints) {
      if (!mint || this.fresh(mint) || this.queued.has(mint) || this.inFlight.has(mint)) continue;
      this.counts.requested++;
      if (this.queue.length >= this.o.maxQueue) { this.counts.dropped++; continue; }
      this.queue.push(mint); this.queued.add(mint); this.pump();
    }
    this.pump(); // also resumes a queue that waited for the breaker
  }
  breakerOpen() { return this.now() < this.openUntil; }
  pump() {
    const runs = [];
    while (!this.breakerOpen() && this.inFlight.size < this.o.concurrency && this.queue.length) {
      const mint = this.queue.shift(); this.queued.delete(mint); this.inFlight.add(mint);
      runs.push(this.one(mint));
    }
    if (runs.length) this.idle = Promise.all([this.idle, ...runs]).then(() => {});
  }
  async one(mint) {
    const t0 = this.now(); this.counts.looked++;
    try {
      const value = await this.lookup(mint);
      if (!value || typeof value !== 'object') throw new Error('empty risk answer');
      this.cache.set(mint, { at: this.now(), value }); this.counts.ok++; this.failStreak = 0;
      if (this.cache.size > this.o.maxCache) { const cut = this.now() - this.o.ttlMs; for (const [k, v] of this.cache) if (v.at < cut || this.cache.size > this.o.maxCache) this.cache.delete(k); }
    } catch (e) {
      this.counts.failed++; this.failStreak++; this.lastError = String(e?.message || e).slice(0, 200);
      if (this.failStreak >= this.o.breakerFailures) { this.openUntil = this.now() + this.o.breakerOpenMs; this.failStreak = 0; this.counts.breakerTrips++; }
    } finally {
      this.latencies.push(this.now() - t0); if (this.latencies.length > 200) this.latencies.shift();
      this.inFlight.delete(mint); this.pump();
    }
  }
  // Resolves once every lookup started so far has finished (tests and shutdown).
  async drain() { let seen; do { seen = this.idle; await seen; } while (seen !== this.idle); }
  stats() {
    const l = this.latencies.slice().sort((a, b) => a - b), p = q => l.length ? l[Math.min(l.length - 1, Math.floor(q * l.length))] : null;
    return { cached: this.cache.size, queued: this.queue.length, inFlight: this.inFlight.size, breakerOpen: this.breakerOpen(), breakerOpenUntil: this.openUntil || null,
      lookupMsP50: p(0.5), lookupMsP95: p(0.95), lastError: this.lastError, ...this.counts };
  }
}
