// Venue isolation for the paper bots (run item C2, 2026-10-03).
//
// Every paper venue (Kalshi weather / NWS control / BTC, the farm, the Kalshi mirror, the Polymarket copy bot,
// the weather calibration) runs on its own timer with its own run budget and stall watchdog. A run that hangs
// on an await never blocks another venue or the HUD: the hung venue is marked STALLED (it is not run again on
// top of itself, because a second run would race the first over the same book), the others keep their cadence,
// and /api/health reports each venue's state. Same idea as the engine's PF-7 watchdog, one per venue.
export const VENUE_STATES = Object.freeze(['WAITING', 'RUNNING', 'OK', 'ERROR', 'STALLED', 'STOPPED']);

export function createVenueLoops({ now = () => Date.now(), setTimer = setTimeout, setRepeat = setInterval, clearTimer = clearTimeout, clearRepeat = clearInterval } = {}) {
  const venues = new Map(), timers = [];
  const pct = (xs, q) => { const a = xs.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : null; };
  async function tick(v) {
    const t = now();
    if (v.running) {
      if (t - v.startedAt > v.stallMs && v.state !== 'STALLED') {
        v.state = 'STALLED'; v.stalls++; v.lastStall = { at: t, afterMs: t - v.startedAt };
        v.lastError = `run has not finished after ${Math.round((t - v.startedAt) / 1000)} s; this venue waits for it, the others keep running`;
      }
      v.skipped++; return;
    }
    v.running = true; v.startedAt = t; v.state = 'RUNNING'; v.runs++;
    try { await v.run(); v.state = 'OK'; v.lastOkAt = now(); v.lastError = null; }
    catch (e) { v.state = 'ERROR'; v.lastError = String(e?.message || e).slice(0, 200); v.errors++; }
    finally {
      const ms = now() - v.startedAt; v.lastMs = ms; v.durations.push(ms); if (v.durations.length > 100) v.durations.shift();
      if (ms > v.stallMs) v.recoveredFromStall = { at: now(), ms };
      v.running = false; v.lastRunAt = now();
    }
  }
  return {
    // stallMs defaults to twice the cadence, at least a minute.
    add(name, { everyMs, firstMs = 0, stallMs = Math.max(60_000, 2 * everyMs), run }) {
      if (venues.has(name)) throw new Error('duplicate venue ' + name);
      const v = { name, everyMs, stallMs, run, state: 'WAITING', running: false, startedAt: null, runs: 0, errors: 0, stalls: 0, skipped: 0, lastStall: null, recoveredFromStall: null, lastOkAt: null, lastRunAt: null, lastError: null, lastMs: null, durations: [] };
      venues.set(name, v);
      const first = setTimer(() => { tick(v); const r = setRepeat(() => tick(v), everyMs); r.unref?.(); timers.push(['r', r]); }, firstMs); first.unref?.(); timers.push(['t', first]);
      return v;
    },
    tick: name => tick(venues.get(name)),
    status() {
      const out = {};
      for (const [name, v] of venues) out[name] = { state: v.state, everyMs: v.everyMs, stallMs: v.stallMs, runs: v.runs, errors: v.errors, stalls: v.stalls, skipped: v.skipped, lastRunAt: v.lastRunAt, lastOkAt: v.lastOkAt, lastMs: v.lastMs, p95Ms: pct(v.durations, 0.95), runningForMs: v.running ? now() - v.startedAt : null, lastStall: v.lastStall, lastError: v.lastError };
      return out;
    },
    stalled() { return [...venues.values()].filter(v => v.state === 'STALLED').map(v => v.name); },
    stop() { for (const [k, t] of timers.splice(0)) (k === 'r' ? clearRepeat : clearTimer)(t); for (const v of venues.values()) if (!v.running) v.state = 'STOPPED'; },
  };
}
