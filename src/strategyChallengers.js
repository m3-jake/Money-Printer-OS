// Trader-owned pure adapters shared with the Lab. Capability is not admission or qualification.
// All decisions consume closed bars through the decision index; fills belong to the existing
// venue paper adapters and their quote, latency, cost, capital and admission checks.
export const CHALLENGER_VERSION = 'bounded-challenger-adapters.v1';
export const CHALLENGER_BOUNDS = Object.freeze({
  'atr-breakout': { entryDays: [20, 55, true], exitDays: [5, 10, true], atrDays: [10, 20, true], atrMultiple: [0.25, 1, false] },
  'lagged-volatility-scaled-trend': { lookback: [20, 60, true], targetVol: [0.05, 0.2, false] },
  'long-only-mean-reversion': { lookback: [20, 40, true], entryDiscount: [0.02, 0.04, false], maxHold: [5, 10, true] },
});
export function validateChallenger(family, params) {
  const bounds = CHALLENGER_BOUNDS[family], reasons = [];
  if (!bounds) return { ok: false, reasons: ['unknown challenger family'] };
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, reasons: ['params missing'] };
  for (const k of Object.keys(params)) if (!(k in bounds)) reasons.push(`unexpected param ${k}`);
  for (const [k, [lo, hi, integer]] of Object.entries(bounds)) {
    const n = params[k];
    if (!Number.isFinite(n) || n < lo || n > hi || integer && !Number.isInteger(n)) reasons.push(`${k} outside declared bounds`);
  }
  if (family === 'atr-breakout' && params.exitDays >= params.entryDays) reasons.push('exitDays must be shorter than entryDays');
  return { ok: !reasons.length, reasons };
}
function requireParams(family, params) { const v = validateChallenger(family, params); if (!v.ok) throw new Error(v.reasons.join('; ')); }
const barValid = b => b && [b.o, b.h, b.l, b.c].every(Number.isFinite) && b.o > 0 && b.l > 0 && b.c > 0 && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c);
export function atrChallengerSignal(params, bars, i, long) {
  requireParams('atr-breakout', params);
  const p = params, look = long ? p.exitDays : p.entryDays;
  if (!Number.isSafeInteger(i) || i < Math.max(look, p.atrDays) || i >= bars.length) return null;
  if (!bars.slice(i - Math.max(look, p.atrDays), i + 1).every(barValid)) return null;
  let atr = 0, bound = long ? Infinity : -Infinity;
  for (let k = i - p.atrDays + 1; k <= i; k++) atr += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  atr /= p.atrDays;
  for (let k = i - look; k < i; k++) bound = long ? Math.min(bound, bars[k].l) : Math.max(bound, bars[k].h);
  return long ? bars[i].c < bound ? false : null : bars[i].c > bound + p.atrMultiple * atr ? true : null;
}
export function equityChallengerTargets(rows, candidate) {
  const { family, params: p } = candidate;
  requireParams(family, p);
  if (family === 'atr-breakout') throw new Error('ATR challenger requires daily crypto adapter');
  const out = []; let long = false, entered = -1;
  for (let i = 0; i < rows.length; i++) {
    if (i < 200 || !rows.slice(i - 200, i + 1).every(barValid)) { out.push(null); continue; }
    const prior = rows.slice(i - p.lookback, i), mean = prior.reduce((n, b) => n + b.c, 0) / prior.length;
    const trend = rows.slice(i - 200, i).reduce((n, b) => n + b.c, 0) / 200;
    if (family === 'long-only-mean-reversion') {
      if (!long && rows[i].c > trend && rows[i].c < mean * (1 - p.entryDiscount)) { long = true; entered = i; }
      else if (long && (rows[i].c >= mean || i - entered >= p.maxHold)) long = false;
      out.push(long ? { SPY: 1 } : {});
    } else {
      const rets = prior.slice(1).map((b, k) => Math.log(b.c / prior[k].c)), m = rets.reduce((n, r) => n + r, 0) / rets.length;
      const vol = Math.sqrt(rets.reduce((n, r) => n + (r - m) ** 2, 0) / Math.max(1, rets.length - 1)) * Math.sqrt(252);
      const w = rows[i].c > trend && vol > 0 ? Math.min(1, p.targetVol / vol) : 0;
      out.push(w > 0 ? { SPY: w } : {});
    }
  }
  return out;
}
export const challengerCapabilities = () => ({ version: CHALLENGER_VERSION, adapterAvailable: true,
  families: Object.keys(CHALLENGER_BOUNDS), admissionRequired: true, paperPromotionAllowed: false, liveActivationAllowed: false,
  qualificationEffect: 'NONE', note: 'Bounded matching signals are available; frozen candidate evidence and existing trader admission checks are still required.' });
