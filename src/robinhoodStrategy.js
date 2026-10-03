// Robinhood Auto Trader — strategy module (work package C).
// Pure strategy rules have no fs/network/signing dependencies; `now` is a parameter everywhere.
// PAPER fill functions delegate execution tuning to the shared friction core (environment-backed config),
// while Date.now() appears only as a default at the API edge.
//
// Contract: docs/ROBINHOOD-AUTO-TRADER.md §7 and §20.
import { createHash } from 'node:crypto';
import { MarketAdapter, FrictionModel, OrderSimulator, frictionConfigFor } from './core/paperTrading.js';

export const STRATEGY_DEFAULTS = Object.freeze({
  sampleMs: 15000, warmupSamples: 120, lookbackSamples: 90, volWindow: 60, horizonSamples: 960,
  emaFast: 12, emaSlow: 48, emaSlopeSamples: 6, costMultiple: 1.5, breakoutBufferPct: 0.0005,
  maxSpreadBps: 40, takeMult: 4, stopMult: 1, trailArmMult: 2, trailMult: 1,
  maxHoldMin: 240, fadeExit: true, cooldownWinMin: 5, cooldownLossMin: 30, maxGapRatio: 0.1, slipBps: 5, minSamples: 120,
});

const ESTIMATE_MAX_AGE_MS = 15000;
const LIMIT_TOLERANCE_CAP = 0.002;

// [min, max, integer]
const PARAM_RANGES = {
  sampleMs: [1000, 600000, true],
  warmupSamples: [10, 720, true],
  lookbackSamples: [5, 720, true],
  volWindow: [5, 720, true],
  horizonSamples: [1, 100000, true],
  emaFast: [2, 500, true],
  emaSlow: [2, 720, true],
  emaSlopeSamples: [1, 200, true],
  costMultiple: [0.1, 10, false], // 0.1 lets the exploration book (never counts) trade below the strict cost wall
  breakoutBufferPct: [0, 0.05, false],
  maxSpreadBps: [1, 1000, false],
  takeMult: [0.5, 20, false],
  stopMult: [0.25, 10, false],
  trailArmMult: [0.25, 20, false],
  trailMult: [0.1, 10, false],
  maxHoldMin: [1, 10080, false],
  cooldownWinMin: [0, 1440, false],
  cooldownLossMin: [0, 1440, false],
  maxGapRatio: [0, 1, false],
  slipBps: [0, 500, false],
  minSamples: [2, 720, true],
};

const num = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN);

export function normalizeParams(p) {
  const src = p && typeof p === 'object' ? p : {};
  const out = {};
  for (const key of Object.keys(STRATEGY_DEFAULTS)) {
    const def = STRATEGY_DEFAULTS[key];
    if (key === 'fadeExit') {
      const v = src[key];
      out[key] = v === undefined || v === null ? def
        : typeof v === 'string' ? v.trim().toLowerCase() !== 'false' && v.trim() !== '0' && v.trim() !== ''
          : Boolean(v);
      continue;
    }
    const [lo, hi, integer] = PARAM_RANGES[key];
    let v = num(src[key]);
    if (!Number.isFinite(v)) v = def;
    if (integer) v = Math.round(v);
    v = Math.min(hi, Math.max(lo, v));
    out[key] = v;
  }
  return out;
}

function canonicalJson(obj) {
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + JSON.stringify(obj[k])).join(',') + '}';
}

export function paramsHash(p) {
  return createHash('sha256').update(canonicalJson(normalizeParams(p))).digest('hex').slice(0, 12);
}

const withDefaults = (params) => (params && params !== STRATEGY_DEFAULTS ? { ...STRATEGY_DEFAULTS, ...params } : STRATEGY_DEFAULTS);

export function roundTripCost(feeRatio, spreadPct, params) {
  const p = withDefaults(params);
  const fee = Number.isFinite(feeRatio) ? feeRatio : 0;
  const spread = Number.isFinite(spreadPct) ? spreadPct : 0;
  return 2 * fee + spread + 2 * p.slipBps / 1e4;
}

// ---------- decimal helpers (local copies; this module imports nothing from the signer) ----------

export function incrementDecimals(increment) {
  const s = String(increment).trim().toLowerCase();
  if (!s || !Number.isFinite(Number(s))) return 0;
  const [mant, expPart] = s.split('e');
  const exp = expPart ? Number(expPart) : 0;
  const dot = mant.indexOf('.');
  const mantDecimals = dot === -1 ? 0 : mant.length - dot - 1;
  return Math.max(0, mantDecimals - exp);
}

function unitsOf(value, increment, mode) {
  const inc = Number(increment);
  if (!Number.isFinite(value) || !Number.isFinite(inc) || inc <= 0) return null;
  const ratio = value / inc;
  // Guard against 0.3 / 0.1 = 2.9999999999999996 style float artefacts.
  return mode === 'ceil' ? Math.ceil(ratio - 1e-9) : Math.floor(ratio + 1e-9);
}

function formatUnits(units, increment) {
  const inc = Number(increment);
  const decimals = incrementDecimals(increment);
  const raw = units * inc;
  // toFixed never emits exponent notation for decimals <= 100.
  return raw.toFixed(Math.min(100, decimals));
}

export function formatIncrement(value, increment) {
  const units = unitsOf(value, increment, 'floor');
  if (units === null) throw new Error('increment');
  return formatUnits(Math.max(0, units), increment);
}

export function ceilIncrement(value, increment) {
  const units = unitsOf(value, increment, 'ceil');
  if (units === null) throw new Error('increment');
  return formatUnits(Math.max(0, units), increment);
}

// ---------- features ----------

function sampleStdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return Math.sqrt(ss / (n - 1));
}

function emaSeries(values, period) {
  const alpha = 2 / (period + 1);
  const out = new Array(values.length);
  let e = values[0];
  out[0] = e;
  for (let i = 1; i < values.length; i++) {
    e = alpha * values[i] + (1 - alpha) * e;
    out[i] = e;
  }
  return out;
}

const midOf = (s) => (Number.isFinite(s.mid) ? s.mid : (s.bid + s.ask) / 2);

export function computeFeatures(samples, params, now = Date.now()) {
  const p = withDefaults(params);
  const arr = Array.isArray(samples) ? samples : [];
  const n = arr.length;
  const last = n ? arr[n - 1] : null;
  const bid = last ? last.bid : null;
  const ask = last ? last.ask : null;
  const mid = last ? midOf(last) : null;
  const spreadPct = last && mid > 0 ? (ask - bid) / mid : null;
  const spreadBps = spreadPct === null ? null : spreadPct * 1e4;
  const ageMs = last ? now - last.t : null;

  const base = {
    ok: false, reason: null, n, ageMs, mid, bid, ask, spreadPct, spreadBps,
    sigma1: null, expectedMovePct: null, donchianHigh: null, donchianLow: null,
    emaFast: null, emaSlow: null, emaSlowPrev: null, gapRatio: null,
  };

  const need = Math.max(p.warmupSamples, p.minSamples);
  if (n < need) return { ...base, reason: 'warmup' };
  if (ageMs < 0 || ageMs > 3 * p.sampleMs) return { ...base, reason: 'stale' };
  if (arr.some((s,i)=>!Number.isFinite(s.t)||!(s.bid>0)||!Number.isFinite(s.ask)||s.ask<s.bid||!Number.isFinite(midOf(s))||(i>0&&s.t<=arr[i-1].t))) return {...base,reason:'invalid'};

  // Gap check over the lookback intervals (the last lookbackSamples inter-sample gaps).
  const intervals = Math.min(p.lookbackSamples, n - 1);
  let gapCount = 0;
  for (let i = n - intervals; i < n; i++) {
    if (arr[i].t - arr[i - 1].t > 2 * p.sampleMs) gapCount++;
  }
  const gapRatio = intervals > 0 ? gapCount / intervals : 0;
  if (gapRatio > p.maxGapRatio) return { ...base, reason: 'gaps', gapRatio };

  const mids = arr.map(midOf);

  // Realised volatility of 1-sample log returns over volWindow.
  const returns = [];
  const from = Math.max(1, n - p.volWindow);
  for (let i = from; i < n; i++) returns.push(Math.log(mids[i] / mids[i - 1]));
  const sigma1 = sampleStdev(returns);
  const expectedMovePct = sigma1 * Math.sqrt(p.horizonSamples);

  // Donchian channel over lookbackSamples, excluding the current sample.
  let donchianHigh = -Infinity;
  let donchianLow = Infinity;
  const dFrom = Math.max(0, n - 1 - p.lookbackSamples);
  for (let i = dFrom; i < n - 1; i++) {
    if (mids[i] > donchianHigh) donchianHigh = mids[i];
    if (mids[i] < donchianLow) donchianLow = mids[i];
  }
  if (!Number.isFinite(donchianHigh)) { donchianHigh = mids[n - 1]; donchianLow = mids[n - 1]; }

  const fastSeries = emaSeries(mids, p.emaFast);
  const slowSeries = emaSeries(mids, p.emaSlow);
  const emaFast = fastSeries[n - 1];
  const emaSlow = slowSeries[n - 1];
  const emaSlowPrev = slowSeries[Math.max(0, n - 1 - p.emaSlopeSamples)];

  return {
    ...base, ok: true, reason: null, gapRatio,
    sigma1, expectedMovePct, donchianHigh, donchianLow, emaFast, emaSlow, emaSlowPrev,
  };
}

// ---------- entry ----------

export function requiredHitRate({ takePct, stopPct, costPct }) {
  const denom = takePct + stopPct;
  if (!(denom > 0)) return 1;
  return (stopPct + costPct) / denom;
}

function geometry(C, expectedMovePct, p) {
  const em = Number.isFinite(expectedMovePct) ? expectedMovePct : 0;
  const takePct = Math.max(p.takeMult * C, em);
  const stopPct = Math.max(p.stopMult * C, 0.5 * em);
  const trailArmPct = p.trailArmMult * C;
  const trailPct = p.trailMult * C;
  return {
    requiredMovePct: p.costMultiple * C,
    takePct, stopPct, trailArmPct, trailPct,
    requiredHitRate: requiredHitRate({ takePct, stopPct, costPct: C }),
  };
}

export function entrySignal(features, { costPct, params } = {}) {
  const p = withDefaults(params);
  const C = Number.isFinite(costPct) ? costPct : 0;
  const f = features || { ok: false, reason: 'warmup' };
  const geo = geometry(C, f.expectedMovePct, p);
  const refuse = (reason) => ({ enter: false, reason, ...geo });
  if (!f.ok) return refuse(f.reason || 'warmup');
  if (f.spreadBps > p.maxSpreadBps) return refuse('spread');
  if (f.expectedMovePct < geo.requiredMovePct) return refuse('lowVol');
  if (f.mid <= f.donchianHigh * (1 + p.breakoutBufferPct)) return refuse('noBreakout');
  if (!(f.emaFast > f.emaSlow && f.emaSlow > f.emaSlowPrev)) return refuse('noTrend');
  return { enter: true, reason: 'breakout', ...geo };
}

// ---------- exit ----------

export function exitSignal(position, { bid, features, now = Date.now(), feeRatio = 0, params } = {}) {
  const p = withDefaults(params);
  const fill = position.fillPrice;
  const prevPeak = Number.isFinite(position.peakBid) ? position.peakBid : bid;
  const peakBid = Math.max(prevPeak, bid);
  let trailStop = Number.isFinite(position.trailStop) ? position.trailStop : null;

  const armed = trailStop !== null || bid >= fill * (1 + position.trailArmPct);
  if (armed) {
    const candidate = peakBid * (1 - position.trailPct);
    trailStop = trailStop === null ? candidate : Math.max(trailStop, candidate);
  }

  const result = (exit, reason) => ({ exit, reason, peakBid, trailStop });
  if (bid <= fill * (1 - position.stopPct) + Math.abs(fill)*1e-12) return result(true, 'stop');
  if (bid >= fill * (1 + position.takePct) - Math.abs(fill)*1e-12) return result(true, 'take');
  if (trailStop !== null && bid <= trailStop) return result(true, 'trail');
  if (now - position.openedAt >= p.maxHoldMin * 60000) return result(true, 'time');
  if (p.fadeExit && features && features.ok && features.emaFast < features.emaSlow
    && bid * (1 - feeRatio) >= fill * (1 + feeRatio)) return result(true, 'fade');
  return result(false, null);
}

// ---------- sizing ----------

export function sizeOrder({ orderUsd, ask, pair = {}, buyingPowerUsd = Infinity, maxOrderUsd, feeRatio = 0 } = {}) {
  const fee = Number.isFinite(feeRatio) ? feeRatio : 0;
  const cap = Number.isFinite(maxOrderUsd) ? maxOrderUsd : Infinity;
  const usd = Math.min(Number.isFinite(orderUsd) ? orderUsd : 0, cap);
  const increment = pair.assetIncrement ?? null;
  const inc = Number(increment);
  const out = { ok: false, reason: null, qty: 0, qtyStr: '0', notionalUsd: 0, estFeeUsd: 0, costUsd: 0 };

  if (!Number.isFinite(inc) || inc <= 0 || !Number.isFinite(ask) || ask <= 0) return { ...out, reason: 'increment' };

  const rawQty = (usd / (1 + fee)) / ask;
  let qtyStr = formatIncrement(rawQty, increment);
  let qty = Number(qtyStr);

  const fill = (q, qs) => {
    const notionalUsd = q * ask;
    const estFeeUsd = notionalUsd * fee;
    return { qty: q, qtyStr: qs, notionalUsd, estFeeUsd, costUsd: notionalUsd + estFeeUsd };
  };

  const minUsd = Number.isFinite(pair.minOrderAmountUsd) ? pair.minOrderAmountUsd : 0;
  if (qty < inc || qty <= 0) return { ...out, ...fill(qty, qtyStr), reason: 'minOrder' };
  if (qty * ask < minUsd - 1e-9) return { ...out, ...fill(qty, qtyStr), reason: 'minOrder' };

  const maxSize = Number.isFinite(pair.maxOrderSize) && pair.maxOrderSize > 0 ? pair.maxOrderSize : null;
  if (maxSize !== null && qty > maxSize) {
    qtyStr = formatIncrement(maxSize, increment);
    qty = Number(qtyStr);
    return { ...out, ...fill(qty, qtyStr), reason: 'aboveMax' };
  }

  const sized = fill(qty, qtyStr);
  if (sized.costUsd > cap + 1e-9) return { ...out, ...sized, reason: 'orderCap' };
  const bp = Number.isFinite(buyingPowerUsd) ? buyingPowerUsd : Infinity;
  if (sized.costUsd > 0.95 * bp) return { ...out, ...sized, reason: 'buyingPower' };
  return { ...out, ...sized, ok: true, reason: null };
}

export function limitBuyPrice(ask, quoteIncrement, tolerance) {
  const tol = Number.isFinite(tolerance) ? Math.max(0, Math.min(tolerance, LIMIT_TOLERANCE_CAP)) : LIMIT_TOLERANCE_CAP;
  return ceilIncrement(ask * (1 + tol), quoteIncrement);
}

// ---------- paper fills ----------

function halfSpreadOf(bid, ask) {
  const mid = (bid + ask) / 2;
  return mid > 0 ? (ask - bid) / (2 * mid) : 0;
}

const estimateFresh = (estimate, now) => estimate && Number.isFinite(estimate.at) && now - estimate.at <= ESTIMATE_MAX_AGE_MS && now - estimate.at >= 0;
const sharedPaperFill=({side,qty,bid,ask,feeRatio,slipBps,now})=>{
 const halfSpreadBps=halfSpreadOf(bid,ask)*1e4,adapter=new MarketAdapter({venue:'robinhood',staleMs:30000,syntheticDepthUsd:1e6}),tuned=frictionConfigFor('robinhood');
 const market=adapter.normalize({bid,ask,timestamp:now,source:'robinhood-paper-quote'},{now}),friction=new FrictionModel({venue:'robinhood',fee:{kind:'bps',bps:feeRatio*1e4+Number(tuned.fee?.bps||0)},
  slippage:{...tuned.slippage,kind:'fixed-bps',bps:halfSpreadBps+slipBps+Number(tuned.slippage?.bps||0)},latency:tuned.latency,
  // This feed exposes top-of-book price but not executable size. Pretending a random partial would be less honest than a conservative full top-of-book model.
  partialFill:{enabled:false,probability:0,rejectProbability:Number(tuned.partialFill?.rejectProbability||0)},minOrderQty:tuned.minOrderQty,minNotional:tuned.minNotional,maxStaleMs:Math.min(30000,tuned.maxStaleMs)});
 return new OrderSimulator().simulate({order:{side,quantity:qty},market,friction,seed:`robinhood:${side}:${now}:${qty}`,now,mode:'PAPER'});
};

export function paperBuyFill({ qty, bid, ask, feeRatio = 0, estimate = null, now = Date.now(), params } = {}) {
  const p = withDefaults(params);
  const fee = Number.isFinite(feeRatio) ? feeRatio : 0;
  if (estimateFresh(estimate, now) && Number.isFinite(estimate.estTotalCost) && estimate.estTotalCost > 0) {
    const costUsd = estimate.estTotalCost;
    const feeUsd = Number.isFinite(estimate.estFee) ? estimate.estFee : costUsd * fee / (1 + fee);
    const fillPrice = qty > 0 ? (costUsd - feeUsd) / qty : 0;
    return { fillPrice, feeUsd, costUsd, source: 'estimate' };
  }
  const sim=sharedPaperFill({side:'BUY',qty,bid,ask,feeRatio:fee,slipBps:p.slipBps,now});
  if(sim.status==='REJECTED')return {fillPrice:null,feeUsd:0,costUsd:0,source:'model',status:'REJECTED',reason:sim.reason,latencyMs:sim.latencyMs,simulation:'shared-paper-core'};
  const fillPrice=sim.fillPrice,feeUsd=sim.feeUsd;
  return { fillPrice, feeUsd, costUsd: sim.gross + feeUsd, source: 'model', status:sim.status, fillRatio:sim.fillRatio, latencyMs:sim.latencyMs, simulation:'shared-paper-core' };
}

export function paperSellFill({ qty, bid, ask, feeRatio = 0, estimate = null, now = Date.now(), params } = {}) {
  const p = withDefaults(params);
  const fee = Number.isFinite(feeRatio) ? feeRatio : 0;
  if (estimateFresh(estimate, now) && Number.isFinite(estimate.estTotalCredit) && estimate.estTotalCredit > 0) {
    const proceedsUsd = estimate.estTotalCredit;
    const feeUsd = Number.isFinite(estimate.estFee) ? estimate.estFee : (fee < 1 ? proceedsUsd * fee / (1 - fee) : 0);
    const fillPrice = qty > 0 ? (proceedsUsd + feeUsd) / qty : 0;
    return { fillPrice, feeUsd, proceedsUsd, source: 'estimate' };
  }
  const sim=sharedPaperFill({side:'SELL',qty,bid,ask,feeRatio:fee,slipBps:p.slipBps,now});
  if(sim.status==='REJECTED')return {fillPrice:null,feeUsd:0,proceedsUsd:0,source:'model',status:'REJECTED',reason:sim.reason,latencyMs:sim.latencyMs,simulation:'shared-paper-core'};
  const fillPrice=sim.fillPrice,feeUsd=sim.feeUsd;
  return { fillPrice, feeUsd, proceedsUsd: sim.gross - feeUsd, source: 'model', status:sim.status, fillRatio:sim.fillRatio, latencyMs:sim.latencyMs, simulation:'shared-paper-core' };
}

export function markToMarket(position, bid, feeRatio = 0) {
  const fee = Number.isFinite(feeRatio) ? feeRatio : 0;
  const qty = Number.isFinite(position?.qty) ? position.qty : 0;
  const costUsd = Number.isFinite(position?.costUsd) ? position.costUsd : 0;
  return qty * bid * (1 - fee) - costUsd;
}

// ---------- cooldown and candidates ----------

export function cooldownUntil({ closedAt, pnlUsd }, params) {
  const p = withDefaults(params);
  const minutes = pnlUsd < 0 ? p.cooldownLossMin : p.cooldownWinMin;
  return closedAt + minutes * 60000;
}

// `weights` (optional, §21): { [symbol]: multiplier } applied to the score, e.g. { 'BTC-USD': 1.5 } for the primary symbol.
export function pickCandidates(featuresBySymbol, openSymbols = [], cooldowns = {}, maxOpen = 1, now = Date.now(), weights = null) {
  const open = new Set(openSymbols || []);
  const slots = Math.max(0, Math.floor(maxOpen) - open.size);
  if (slots === 0) return [];
  const ranked = [];
  for (const symbol of Object.keys(featuresBySymbol || {})) {
    if (open.has(symbol)) continue;
    const until = cooldowns ? cooldowns[symbol] : undefined;
    if (Number.isFinite(until) && until > now) continue;
    const row = featuresBySymbol[symbol] || {};
    const f = row.features;
    if (!f || !f.ok || !(row.costPct > 0) || !Number.isFinite(f.expectedMovePct)) continue;
    const w = weights && Number.isFinite(Number(weights[symbol])) && Number(weights[symbol]) > 0 ? Number(weights[symbol]) : 1;
    ranked.push({ symbol, score: (f.expectedMovePct / row.costPct) * w });
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return ranked.slice(0, slots).map((r) => r.symbol);
}
