import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

// A timed-out read may ignore cancellation. Retain its flight until it actually settles,
// while each caller has an independent deadline and can never apply a late result.
export class CopyWorkBudget {
  constructor({ runMs = 12000, requestMs = 4000 } = {}) { this.runMs = runMs; this.requestMs = requestMs; this.context = new AsyncLocalStorage(); this.flights = new Map(); }
  run(fn) { return this.context.run({ deadline: performance.now() + this.runMs }, fn); }
  remaining() { return Math.max(0, (this.context.getStore()?.deadline ?? Infinity) - performance.now()); }
  assert() { if (this.remaining() <= 0) throw new Error('paper copy work budget exhausted; pending work retained'); }
  async call(key, fn) {
    this.assert();
    const ms = Math.max(1, Math.min(this.requestMs, this.remaining()));
    let flight = this.flights.get(key);
    if (!flight) {
      const signal = AbortSignal.timeout(Math.ceil(ms));
      flight = { expired: false, task: null };
      flight.task = Promise.resolve().then(() => fn(signal)).then(value => { if (flight.expired) throw new Error('late paper copy provider result discarded'); return value; }); this.flights.set(key, flight);
      flight.task.then(() => { if (this.flights.get(key) === flight) this.flights.delete(key); }, () => { if (this.flights.get(key) === flight) this.flights.delete(key); });
    }
    if (flight.expired) throw new Error('paper copy provider read still draining after timeout; no overlapping request');
    let timer;
    try { return await Promise.race([flight.task, new Promise((_, reject) => { timer = setTimeout(() => { flight.expired = true; reject(new Error('paper copy provider deadline exceeded; pending work retained')); }, ms); })]); }
    finally { clearTimeout(timer); }
  }
}
