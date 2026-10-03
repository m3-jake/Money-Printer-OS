// Kalshi pricing model shared with the Evolution Lab (run item B4, 2026-10-03). Pure: the trader's paper bots and farm
// (src/kalshiBots.js, src/botFarm.js) and the Lab's weather and BTC replays all price contracts with these exact
// functions, so a Lab replay judges the model the trader actually trades. Shared core: edit only in the trader, then
// node scripts/sync-shared-core.mjs.
import { takerFee } from './core/fees.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Kalshi's quadratic taker fee schedule, for callers whose quotes carry no fee model of their own (the Lab's tapes).
export const KALSHI_TAKER_FEE = Object.freeze({ venue: 'kalshi', kind: 'KALSHI_QUADRATIC_TAKER', rate: 0.07, rounding: 'CENT_PER_ORDER' });

// Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7).
export function normCdf(z) {
  if (z === Infinity) return 1; if (z === -Infinity) return 0;
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
// Probability that a whole-degree daily high lands in [lo, hi] (either may be ±Infinity), continuity-corrected.
export function bucketProbability(lo, hi, mu, sigma) {
  const a = lo === -Infinity || lo == null ? -Infinity : (lo - 0.5 - mu) / sigma, b = hi === Infinity || hi == null ? Infinity : (hi + 0.5 - mu) / sigma;
  return clamp(normCdf(b) - normCdf(a), 0, 1);
}
// The weather bots' forecast distribution for a daily high: the calibrated model (mu, sigma widened by
// calibrationSafety) when one is used, otherwise the NWS point forecast plus bias with sigma growing by the day.
export function weatherMuSigma({ cm = null, nwsHigh = null, hours = 0, settings: s }) {
  if (cm) return { mu: cm.mu, sigma: cm.sigma * s.calibrationSafety, calibrated: true };
  if (nwsHigh == null) return null;
  return { mu: nwsHigh + s.biasF, sigma: s.sigmaBaseF + s.sigmaPerDayF * Math.max(0, hours) / 24, calibrated: false };
}
// P(S_T > K) for spot S, horizon tauSec, per-sqrt-second vol sigma (lognormal, zero drift).
export function probAbove(spot, strike, tauSec, sigmaPerSqrtSec) {
  const s = sigmaPerSqrtSec * Math.sqrt(Math.max(1, tauSec));
  return clamp(normCdf((Math.log(spot / strike) - s * s / 2) / s), 0, 1);
}
// Contract probability for a normalized Kalshi BTC contract (strikeType greater/less/between).
export function btcContractProbability(d, spot, tauSec, sigma) {
  if (d.strikeType === 'greater' && Number.isFinite(d.floorStrike)) return probAbove(spot, d.floorStrike, tauSec, sigma);
  if (d.strikeType === 'less' && Number.isFinite(d.capStrike)) return 1 - probAbove(spot, d.capStrike, tauSec, sigma);
  if (d.strikeType === 'between' && Number.isFinite(d.floorStrike) && Number.isFinite(d.capStrike)) return clamp(probAbove(spot, d.floorStrike, tauSec, sigma) - probAbove(spot, d.capStrike, tauSec, sigma), 0, 1);
  return null;
}
// Realized vol per sqrt-second from Coinbase candles [[time, low, high, open, close, vol], ...] (newest first).
export function realizedVol(candles, granularitySec = 300) {
  const closes = (candles || []).slice().sort((a, b) => a[0] - b[0]).map(c => Number(c[4])).filter(v => v > 0);
  if (closes.length < 30) return null;
  const r = []; for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const m = r.reduce((s, x) => s + x, 0) / r.length, v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v / granularitySec);
}
// Best side of one contract: YES at the YES ask, or NO at the NO ask, after the taker fee for `qty` contracts.
// A side whose model probability differs from the market's by more than maxDisagreement is dropped: a gap that
// large is more often a model error (wrong vol, wrong settlement source) than an edge, so it is logged, not bet.
// Longshot guard: a side priced under longshotPrice is taken only with an edge of at least longshotMinEdge.
export function scoreSides({ pYes, yesAsk, noAsk, yesBid = null, feeModel, stakeUsd, minPrice, maxPrice, maxDisagreement = 1, longshotPrice = 0, longshotMinEdge = 0 }) {
  const marketYes = yesBid != null && yesAsk != null ? (yesBid + yesAsk) / 2 : yesAsk != null ? yesAsk : noAsk != null ? 1 - noAsk : null;
  if (marketYes != null && Math.abs(pYes - marketYes) > maxDisagreement) return { disagree: true, pModel: pYes, marketYes, edge: -Infinity };
  const out = [];
  for (const [side, p, ask] of [['YES', pYes, yesAsk], ['NO', 1 - pYes, noAsk]]) {
    if (!(ask >= minPrice && ask <= maxPrice)) continue;
    const qty = Math.floor(stakeUsd / ask); if (qty < 1) continue;
    const fee = feeModel ? takerFee(feeModel, [{ price: ask, quantity: qty }]) : null; if (fee === null) continue;
    const edge = p - ask - fee / qty;
    if (ask < (longshotPrice || 0) && edge < (longshotMinEdge || 0)) continue;
    out.push({ side, pModel: p, ask, qty, fee, edge });
  }
  return out.sort((a, b) => b.edge - a.edge)[0] || null;
}
