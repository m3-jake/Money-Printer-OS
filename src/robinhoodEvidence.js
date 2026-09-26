// Robinhood evidence measurements (Batch B): what the tape says before anything is searched.
// Pure: no fs, env or clock. robinhoodAutoTrader.js loads the tape and caches the result; the Lab
// keeps a verbatim copy so both sides compute the same numbers.
import * as S from './robinhoodStrategy.js';

const DAY_MS = 864e5;
const quantile = (xs, q) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y), i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
const r6 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6;
const spreadOf = r => { const mid = (r.bid + r.ask) / 2; return mid > 0 ? (r.ask - r.bid) / mid : null; };
export const isVenueRow = r => r?.src === 'robinhood';
// Synthetic = explicitly tagged as something other than a Robinhood quote. Untagged legacy rows (pre batch 12)
// are left alone: they cannot be told apart, and the share gates already count them as non-Robinhood.
export const isSyntheticRow = r => r?.src != null && r.src !== 'robinhood';

// Vol-gate ratio over the last `days` of Robinhood-sourced rows: p50/p95 expected move (same formula as
// computeFeatures: stdev of 1-sample log returns over volWindow, times sqrt(horizonSamples)), the median spread,
// the round-trip cost C at that spread, the required move costMultiple*C, and ratio = p95 expected / required.
// ratio < 1 means even the 95th-percentile move cannot clear the gate: the Donchian family cannot trade.
export function volGateStats(rows, { params, feeRatio = 0.0095, now = Date.now(), days = 7, maxPoints = 20000 } = {}) {
  const p = S.normalizeParams(params), since = now - days * DAY_MS;
  const rh = (Array.isArray(rows) ? rows : []).filter(r => isVenueRow(r) && r.t >= since && r.bid > 0 && r.ask >= r.bid);
  const out = { rows: rh.length, spanDays: rh.length > 1 ? Math.round((rh[rh.length - 1].t - rh[0].t) / DAY_MS * 100) / 100 : 0, p50ExpectedMovePct: null, p95ExpectedMovePct: null, medianSpreadPct: null, costPct: null, requiredMovePct: null, ratio: null, verdict: 'INSUFFICIENT' };
  if (rh.length < p.volWindow + 2) return out;
  const mids = rh.map(r => (r.bid + r.ask) / 2), rets = [];
  for (let i = 1; i < mids.length; i++) rets.push(Math.log(mids[i] / mids[i - 1]));
  // Rolling sample stdev over volWindow returns, via running sums; strided so a week of 15 s rows stays cheap.
  const w = p.volWindow, stride = Math.max(1, Math.floor(rets.length / maxPoints)), moves = [];
  let sum = 0, sq = 0;
  for (let i = 0; i < rets.length; i++) {
    sum += rets[i]; sq += rets[i] * rets[i];
    if (i >= w) { sum -= rets[i - w]; sq -= rets[i - w] * rets[i - w]; }
    if (i >= w - 1 && (i % stride === 0)) { const n = w, v = Math.max(0, (sq - sum * sum / n) / (n - 1)); moves.push(Math.sqrt(v) * Math.sqrt(p.horizonSamples)); }
  }
  const spreads = rh.map(spreadOf).filter(Number.isFinite), med = quantile(spreads, 0.5) ?? 0;
  const C = S.roundTripCost(feeRatio, med, p), required = p.costMultiple * C, p95 = quantile(moves, 0.95);
  return { ...out, p50ExpectedMovePct: r6(quantile(moves, 0.5)), p95ExpectedMovePct: r6(p95), medianSpreadPct: r6(med), costPct: r6(C), requiredMovePct: r6(required), ratio: required > 0 ? Math.round(p95 / required * 1000) / 1000 : null, verdict: required > 0 && p95 >= required ? 'CAN_TRADE' : 'BINDING' };
}

// Give tagged non-Robinhood rows a realistic cost before any replay: candles have bid===ask and the public book is
// tighter than what this account pays, so either would out-score the venue on the same mid path.
// Returns { rows, rowsSynthetic, syntheticShare }; rows keep their t/src and mid, only bid/ask are widened.
export function realisticSpreads(rows, { params } = {}) {
  const p = S.normalizeParams(params), list = Array.isArray(rows) ? rows : [];
  let rowsSynthetic = 0;
  const trailing = []; // recent Robinhood spreads, newest last
  const out = list.map(r => {
    if (isVenueRow(r)) { const s = spreadOf(r); if (Number.isFinite(s)) { trailing.push(s); if (trailing.length > 240) trailing.shift(); } return r; }
    if (!isSyntheticRow(r)) return r;
    rowsSynthetic++;
    const spread = syntheticSpreadPct({ ownSpreadPct: spreadOf(r), trailingVenueSpreads: trailing, maxSpreadBps: p.maxSpreadBps });
    const mid = Number.isFinite(r.mid) ? r.mid : (r.bid + r.ask) / 2;
    return { ...r, bid: mid * (1 - spread / 2), ask: mid * (1 + spread / 2), mid };
  });
  return { rows: out, rowsSynthetic, syntheticShare: list.length ? Math.round(rowsSynthetic / list.length * 1000) / 1000 : 0 };
}

// The spread (as a fraction of mid) a synthetic row is charged.
//   ownSpreadPct         the row's own spread (0 for candles), may be null
//   trailingVenueSpreads Robinhood spreads seen before this row in the same tape (may be empty)
//   maxSpreadBps         the strategy's spread gate; entrySignal refuses rows wider than this
export function syntheticSpreadPct({ ownSpreadPct, trailingVenueSpreads, maxSpreadBps }) {
  const own = Number(ownSpreadPct);
  const ownFloor = Number.isFinite(own) && own >= 0 ? own : 0;
  const samples = (Array.isArray(trailingVenueSpreads) ? trailingVenueSpreads : [])
    .map(Number).filter(v => Number.isFinite(v) && v >= 0);
  const bps = Number(maxSpreadBps);
  const gate = Number.isFinite(bps) && bps > 0 ? bps / 1e4 : 0;
  const venueMedian = samples.length ? quantile(samples, 0.5) : null;
  // Prefer the observed venue median. If no usable venue spread exists, charge the strategy's
  // own spread gate; keep a tiny positive floor so a synthetic zero-spread candle is never free.
  const reference = Number.isFinite(venueMedian) && venueMedian > 0 ? venueMedian : gate > 0 ? gate : 1e-6;
  return Math.max(ownFloor, reference);
}
