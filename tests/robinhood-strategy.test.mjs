import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGY_DEFAULTS, normalizeParams, paramsHash, roundTripCost, computeFeatures, entrySignal,
  requiredHitRate, exitSignal, sizeOrder, limitBuyPrice, paperBuyFill, paperSellFill, markToMarket,
  cooldownUntil, pickCandidates, formatIncrement, ceilIncrement,
} from '../src/robinhoodStrategy.js';

const T0 = 1_700_000_000_000;
const MS = STRATEGY_DEFAULTS.sampleMs;
const FEE = 0.0085;

// Deterministic LCG (no Math.random anywhere in this suite).
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function sample(i, mid, spreadPct = 0.001, t = T0 + i * MS) {
  const half = mid * spreadPct / 2;
  return { t, bid: mid - half, ask: mid + half, mid };
}

function tape(n, midFn, spreadPct = 0.001) {
  return Array.from({ length: n }, (_, i) => sample(i, midFn(i), spreadPct));
}

const nowFor = (samples) => samples[samples.length - 1].t + 1000;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// Flat tape.
const flat = (n = 150, mid = 100) => tape(n, () => mid);

// High-vol uptrend with random noise and a final breakout above the Donchian channel.
function breakoutTape(seed = 7, n = 200) {
  const rnd = lcg(seed);
  const out = [];
  let mid = 100;
  for (let i = 0; i < n; i++) {
    mid *= 1 + 0.004 + (rnd() - 0.5) * 0.02;
    out.push(sample(i, mid, 0.001));
  }
  const prevMax = Math.max(...out.slice(-1 - 90, -1).map((s) => s.mid));
  const last = out[n - 1];
  Object.assign(last, sample(n - 1, prevMax * 1.01, 0.001));
  return out;
}

// ---------- defaults, params, hash, cost ----------

test('STRATEGY_DEFAULTS pinned to the contract values', () => {
  assert.deepEqual({ ...STRATEGY_DEFAULTS }, {
    sampleMs: 15000, warmupSamples: 120, lookbackSamples: 90, volWindow: 60, horizonSamples: 960,
    emaFast: 12, emaSlow: 48, emaSlopeSamples: 6, costMultiple: 1.5, breakoutBufferPct: 0.0005,
    maxSpreadBps: 40, takeMult: 4, stopMult: 1, trailArmMult: 2, trailMult: 1,
    maxHoldMin: 240, fadeExit: true, cooldownWinMin: 5, cooldownLossMin: 30, maxGapRatio: 0.1, slipBps: 5, minSamples: 120,
  });
});

test('normalizeParams clamps, types and drops unknown keys', () => {
  const p = normalizeParams({ takeMult: 999, stopMult: -5, warmupSamples: '30.6', fadeExit: 'false', bogus: 1, slipBps: 'abc' });
  assert.equal(p.takeMult, 20);
  assert.equal(p.stopMult, 0.25);
  assert.equal(p.warmupSamples, 31);
  assert.equal(p.fadeExit, false);
  assert.equal(p.slipBps, STRATEGY_DEFAULTS.slipBps);
  assert.equal('bogus' in p, false);
  assert.deepEqual(Object.keys(p).sort(), Object.keys(STRATEGY_DEFAULTS).sort());
  assert.deepEqual(normalizeParams(null), { ...STRATEGY_DEFAULTS });
});

test('paramsHash is 12 hex, stable across key order, sensitive to values', () => {
  const a = paramsHash({ takeMult: 4, stopMult: 1 });
  const b = paramsHash({ stopMult: 1, takeMult: 4, unknown: 'ignored' });
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, b);
  assert.equal(a, paramsHash({}));
  assert.notEqual(a, paramsHash({ takeMult: 5 }));
});

test('roundTripCost = 2*fee + spread + 2*slipBps/1e4', () => {
  near(roundTripCost(0.0085, 0.001), 0.019);
  near(roundTripCost(0.0085, 0.001, { slipBps: 0 }), 0.018);
  near(roundTripCost(0, 0), 0.001);
});

// ---------- features ----------

test('computeFeatures: warmup below minSamples', () => {
  const s = flat(50);
  const f = computeFeatures(s, STRATEGY_DEFAULTS, nowFor(s));
  assert.equal(f.ok, false);
  assert.equal(f.reason, 'warmup');
  assert.equal(f.n, 50);
  assert.equal(f.mid, 100);
});

test('computeFeatures: stale when ageMs > 3*sampleMs', () => {
  const s = flat(150);
  const last = s[s.length - 1].t;
  assert.equal(computeFeatures(s, STRATEGY_DEFAULTS, last + 3 * MS).reason, null);
  const f = computeFeatures(s, STRATEGY_DEFAULTS, last + 3 * MS + 1);
  assert.equal(f.ok, false);
  assert.equal(f.reason, 'stale');
  assert.equal(f.ageMs, 3 * MS + 1);
});

test('computeFeatures: gaps when more than maxGapRatio of lookback intervals exceed 2*sampleMs', () => {
  // 90 lookback intervals; shift the last 10 samples by an extra gap each -> 10 gap intervals = 0.111 > 0.1
  const s = flat(150);
  for (let i = 140; i < 150; i++) for (let j = i; j < 150; j++) s[j].t += 2 * MS;
  const f = computeFeatures(s, STRATEGY_DEFAULTS, nowFor(s));
  assert.equal(f.reason, 'gaps');
  near(f.gapRatio, 10 / 90);
  // 9 gaps = 0.1 exactly -> not > maxGapRatio -> ok
  const s2 = flat(150);
  for (let i = 141; i < 150; i++) for (let j = i; j < 150; j++) s2[j].t += 2 * MS;
  const f2 = computeFeatures(s2, STRATEGY_DEFAULTS, nowFor(s2));
  assert.equal(f2.ok, true);
  near(f2.gapRatio, 0.1);
});

test('computeFeatures: sigma1 and expectedMovePct on a known alternating series', () => {
  const r = 0.002;
  const s = tape(200, (i) => (i % 2 ? 100 * Math.exp(r) : 100));
  const f = computeFeatures(s, STRATEGY_DEFAULTS, nowFor(s));
  assert.equal(f.ok, true);
  // 60 log returns alternate +/- r with mean 0 -> sample stdev = r * sqrt(60/59)
  near(f.sigma1, r * Math.sqrt(60 / 59), 1e-12);
  near(f.expectedMovePct, f.sigma1 * Math.sqrt(960), 1e-12);
  const flatF = computeFeatures(flat(), STRATEGY_DEFAULTS, nowFor(flat()));
  assert.equal(flatF.sigma1, 0);
  assert.equal(flatF.expectedMovePct, 0);
  near(flatF.spreadPct, 0.001);
  near(flatF.spreadBps, 10);
});

test('computeFeatures: Donchian excludes the current sample', () => {
  const s = flat(150);
  s[149] = sample(149, 110);
  const f = computeFeatures(s, STRATEGY_DEFAULTS, nowFor(s));
  assert.equal(f.donchianHigh, 100);
  assert.equal(f.donchianLow, 100);
  // and only spans lookbackSamples before it
  const s2 = flat(150);
  s2[58] = sample(58, 150); // outside the 90-sample window ending at index 148 (indices 59..148)
  s2[59] = sample(59, 120); // inside
  const f2 = computeFeatures(s2, STRATEGY_DEFAULTS, nowFor(s2));
  assert.equal(f2.donchianHigh, 120);
});

test('computeFeatures: EMA fast/slow/slowPrev match a hand-computed loop', () => {
  const s = breakoutTape(3, 160);
  const f = computeFeatures(s, STRATEGY_DEFAULTS, nowFor(s));
  const ema = (k) => {
    const a = 2 / (k + 1);
    const out = [];
    let e = s[0].mid;
    for (let i = 0; i < s.length; i++) { e = i === 0 ? e : a * s[i].mid + (1 - a) * e; out.push(e); }
    return out;
  };
  const fast = ema(12); const slow = ema(48);
  near(f.emaFast, fast[159], 1e-9);
  near(f.emaSlow, slow[159], 1e-9);
  near(f.emaSlowPrev, slow[159 - 6], 1e-9);
});

// ---------- entry ----------

const okFeatures = (over = {}) => ({
  ok: true, reason: null, mid: 110, bid: 109.95, ask: 110.05, spreadPct: 0.0009, spreadBps: 9,
  sigma1: 0.002, expectedMovePct: 0.06, donchianHigh: 105, donchianLow: 95,
  emaFast: 104, emaSlow: 102, emaSlowPrev: 101, ...over,
});

test('entrySignal: reasons fire in order features -> spread -> lowVol -> noBreakout -> noTrend -> breakout', () => {
  const C = 0.019;
  assert.equal(entrySignal({ ok: false, reason: 'warmup' }, { costPct: C }).reason, 'warmup');
  assert.equal(entrySignal({ ok: false, reason: 'stale' }, { costPct: C }).reason, 'stale');
  // spread wins over everything else even when the rest would fail too
  assert.equal(entrySignal(okFeatures({ spreadBps: 41, expectedMovePct: 0, mid: 1, emaFast: 0 }), { costPct: C }).reason, 'spread');
  assert.equal(entrySignal(okFeatures({ expectedMovePct: 0.02, mid: 1, emaFast: 0 }), { costPct: C }).reason, 'lowVol');
  assert.equal(entrySignal(okFeatures({ mid: 105 * 1.0005, emaFast: 0 }), { costPct: C }).reason, 'noBreakout');
  assert.equal(entrySignal(okFeatures({ emaFast: 101 }), { costPct: C }).reason, 'noTrend');
  assert.equal(entrySignal(okFeatures({ emaSlowPrev: 102 }), { costPct: C }).reason, 'noTrend');
  const sig = entrySignal(okFeatures(), { costPct: C });
  assert.equal(sig.enter, true);
  assert.equal(sig.reason, 'breakout');
  assert.equal(entrySignal(okFeatures({ spreadBps: 40 }), { costPct: C }).enter, true);
});

test('entrySignal: cost geometry at the defaults and requiredHitRate 0.4', () => {
  const C = roundTripCost(FEE, 0.001);
  near(C, 0.019);
  const sig = entrySignal(okFeatures({ expectedMovePct: 0.03 }), { costPct: C });
  assert.equal(sig.enter, true);
  near(sig.requiredMovePct, 0.0285);
  near(sig.takePct, 0.076);
  near(sig.stopPct, 0.019);
  near(sig.trailArmPct, 0.038);
  near(sig.trailPct, 0.019);
  near(sig.requiredHitRate, 0.4);
  near(requiredHitRate({ takePct: 4 * C, stopPct: C, costPct: C }), 0.4);
  // take-profit net of both fees is positive at the defaults (pinned)
  const fill = 100;
  const net = fill * (1 + sig.takePct) * (1 - FEE) - fill * (1 + FEE);
  assert.ok(net > 0);
  // large expected move stretches take and stop
  const big = entrySignal(okFeatures({ expectedMovePct: 0.1 }), { costPct: C });
  near(big.takePct, 0.1);
  near(big.stopPct, 0.05);
  near(big.requiredHitRate, (0.05 + C) / 0.15);
});

test('entrySignal: end-to-end synthetic tapes', () => {
  const s = breakoutTape();
  const f = computeFeatures(s, STRATEGY_DEFAULTS, nowFor(s));
  assert.equal(f.ok, true);
  const C = roundTripCost(FEE, f.spreadPct);
  const sig = entrySignal(f, { costPct: C });
  assert.equal(sig.reason, 'breakout');
  // low vol refuses even on a breakout
  const calm = flat(150); calm[149] = sample(149, 100.1);
  const fc = computeFeatures(calm, STRATEGY_DEFAULTS, nowFor(calm));
  assert.ok(fc.mid > fc.donchianHigh);
  assert.equal(entrySignal(fc, { costPct: roundTripCost(FEE, fc.spreadPct) }).reason, 'lowVol');
  // wide spread refuses
  const wide = s.map((x, i) => sample(i, x.mid, 0.005));
  const fw = computeFeatures(wide, STRATEGY_DEFAULTS, nowFor(wide));
  assert.equal(entrySignal(fw, { costPct: roundTripCost(FEE, fw.spreadPct) }).reason, 'spread');
});

test('same tape yields the same features and decisions', () => {
  const a = breakoutTape(11); const b = breakoutTape(11);
  const fa = computeFeatures(a, STRATEGY_DEFAULTS, nowFor(a));
  const fb = computeFeatures(b, STRATEGY_DEFAULTS, nowFor(b));
  assert.deepEqual(fa, fb);
  assert.deepEqual(entrySignal(fa, { costPct: 0.019 }), entrySignal(fb, { costPct: 0.019 }));
});

// ---------- exit ----------

const pos = (over = {}) => ({
  fillPrice: 100, openedAt: T0, stopPct: 0.019, takePct: 0.076, trailArmPct: 0.038, trailPct: 0.019,
  peakBid: 100, trailStop: null, ...over,
});

test('exitSignal: priority stop > take > trail > time > fade', () => {
  const ctx = { now: T0 + 1000, feeRatio: FEE };
  assert.equal(exitSignal(pos(), { ...ctx, bid: 98.1 }).reason, 'stop');
  assert.equal(exitSignal(pos(), { ...ctx, bid: 98.11 }).exit, false);
  assert.equal(exitSignal(pos(), { ...ctx, bid: 107.6 }).reason, 'take');
  // stop wins over take when a position carries a nonsense geometry
  assert.equal(exitSignal(pos({ stopPct: -0.1 }), { ...ctx, bid: 108 }).reason, 'stop');
  // take wins over trail
  assert.equal(exitSignal(pos({ trailStop: 200 }), { ...ctx, bid: 108 }).reason, 'take');
  // trail wins over time
  assert.equal(exitSignal(pos({ trailStop: 105, peakBid: 106 }), { ...ctx, bid: 104, now: T0 + 241 * 60000 }).reason, 'trail');
  // time wins over fade
  const fade = { ok: true, emaFast: 99, emaSlow: 101 };
  assert.equal(exitSignal(pos(), { ...ctx, bid: 102, now: T0 + 240 * 60000, features: fade }).reason, 'time');
  assert.equal(exitSignal(pos(), { ...ctx, bid: 102, now: T0 + 240 * 60000 - 1, features: fade }).reason, 'fade');
});

test('exitSignal: trailing stop arms, tracks peakBid and never decreases', () => {
  const ctx = { now: T0 + 1000, feeRatio: FEE };
  let p = pos();
  let x = exitSignal(p, { ...ctx, bid: 103 });
  assert.equal(x.exit, false); assert.equal(x.trailStop, null); assert.equal(x.peakBid, 103);
  x = exitSignal({ ...p, peakBid: x.peakBid, trailStop: x.trailStop }, { ...ctx, bid: 104 });
  assert.equal(x.exit, false); near(x.trailStop, 104 * 0.981); assert.equal(x.peakBid, 104);
  x = exitSignal({ ...p, peakBid: x.peakBid, trailStop: x.trailStop }, { ...ctx, bid: 105 });
  near(x.trailStop, 105 * 0.981); assert.equal(x.peakBid, 105);
  const held = x.trailStop;
  x = exitSignal({ ...p, peakBid: x.peakBid, trailStop: x.trailStop }, { ...ctx, bid: 103.5 });
  assert.equal(x.exit, false); assert.equal(x.trailStop, held); assert.equal(x.peakBid, 105);
  // a stored trailStop higher than the peak-derived candidate is kept
  x = exitSignal({ ...p, peakBid: 105, trailStop: 104 }, { ...ctx, bid: 104.5 });
  assert.equal(x.trailStop, 104);
  x = exitSignal({ ...p, peakBid: 105, trailStop: held }, { ...ctx, bid: 102.9 });
  assert.equal(x.reason, 'trail');
});

test('exitSignal: time exit and fade exit rules', () => {
  const ctx = { feeRatio: FEE };
  assert.equal(exitSignal(pos(), { ...ctx, bid: 101, now: T0 + 240 * 60000 }).reason, 'time');
  assert.equal(exitSignal(pos(), { ...ctx, bid: 101, now: T0 + 240 * 60000 - 1 }).exit, false);
  assert.equal(exitSignal(pos(), { ...ctx, bid: 101, now: T0 + 240 * 60000 - 1, params: { maxHoldMin: 1 } }).reason, 'time');
  const fading = { ok: true, emaFast: 99, emaSlow: 101 };
  const now = T0 + 1000;
  // 101.7146... is the flat-after-fees threshold
  assert.equal(exitSignal(pos(), { ...ctx, bid: 101.72, now, features: fading }).reason, 'fade');
  assert.equal(exitSignal(pos(), { ...ctx, bid: 101.71, now, features: fading }).exit, false);
  assert.equal(exitSignal(pos(), { ...ctx, bid: 102, now, features: { ...fading, ok: false } }).exit, false);
  assert.equal(exitSignal(pos(), { ...ctx, bid: 102, now, features: { ok: true, emaFast: 102, emaSlow: 101 } }).exit, false);
  assert.equal(exitSignal(pos(), { ...ctx, bid: 102, now, features: fading, params: { fadeExit: false } }).exit, false);
});

// ---------- sizing ----------

const pair = { assetIncrement: '0.000001', minOrderAmountUsd: 1, maxOrderSize: 100, quoteIncrement: '0.01' };

test('sizeOrder floors to increment and returns net-of-fee cost', () => {
  const r = sizeOrder({ orderUsd: 25, ask: 50000, pair, feeRatio: FEE, maxOrderUsd: 25 });
  assert.equal(r.ok, true);
  assert.equal(r.qtyStr, '0.000495');
  assert.equal(r.qty, 0.000495);
  near(r.notionalUsd, 24.75);
  near(r.estFeeUsd, 24.75 * FEE);
  near(r.costUsd, 24.75 * (1 + FEE));
  assert.ok(r.costUsd <= 25);
});

test('sizeOrder never emits exponent notation for tiny quantities', () => {
  const r = sizeOrder({ orderUsd: 1, ask: 100000, pair: { ...pair, assetIncrement: '0.00000001', minOrderAmountUsd: 0.5 }, feeRatio: FEE, maxOrderUsd: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.qtyStr, '0.00000991');
  assert.doesNotMatch(r.qtyStr, /e/i);
  assert.equal(formatIncrement(1e-7, '0.00000001'), '0.00000010');
  assert.equal(formatIncrement(0.3, '0.1'), '0.3');
  assert.equal(formatIncrement(2.5, '1'), '2');
  assert.equal(ceilIncrement(2.01, '1'), '3');
  assert.equal(ceilIncrement(0.3, '0.1'), '0.3');
});

test('sizeOrder failure reasons: minOrder, increment, aboveMax, orderCap, buyingPower', () => {
  assert.equal(sizeOrder({ orderUsd: 0.5, ask: 50000, pair, feeRatio: FEE, maxOrderUsd: 25 }).reason, 'minOrder');
  assert.equal(sizeOrder({ orderUsd: 1, ask: 100000, pair: { ...pair, assetIncrement: '0.001' }, feeRatio: FEE, maxOrderUsd: 25 }).reason, 'minOrder');
  assert.equal(sizeOrder({ orderUsd: 25, ask: 50000, pair: { ...pair, assetIncrement: 'nope' }, feeRatio: FEE, maxOrderUsd: 25 }).reason, 'increment');
  assert.equal(sizeOrder({ orderUsd: 25, ask: 0, pair, feeRatio: FEE, maxOrderUsd: 25 }).reason, 'increment');
  const above = sizeOrder({ orderUsd: 25, ask: 50000, pair: { ...pair, maxOrderSize: 0.0001 }, feeRatio: FEE, maxOrderUsd: 25 });
  assert.equal(above.ok, false);
  assert.equal(above.reason, 'aboveMax');
  assert.equal(above.qtyStr, '0.000100');
  // maxOrderUsd caps the notional before sizing, so cost never exceeds it
  const capped = sizeOrder({ orderUsd: 25, ask: 50000, pair, feeRatio: FEE, maxOrderUsd: 10 });
  assert.equal(capped.ok, true);
  assert.ok(capped.costUsd <= 10);
  assert.equal(capped.qtyStr, '0.000198');
  const bp = sizeOrder({ orderUsd: 25, ask: 50000, pair, feeRatio: FEE, maxOrderUsd: 25, buyingPowerUsd: 26 });
  assert.equal(bp.reason, 'buyingPower');
  assert.equal(sizeOrder({ orderUsd: 25, ask: 50000, pair, feeRatio: FEE, maxOrderUsd: 25, buyingPowerUsd: 27 }).ok, true);
});

test('limitBuyPrice ceils to quoteIncrement with tolerance capped at 0.2%', () => {
  assert.equal(limitBuyPrice(100.004, '0.01', 0.01), '100.21');
  assert.equal(limitBuyPrice(100.004, '0.01', 0.001), '100.11');
  assert.equal(limitBuyPrice(100, '0.01', 0.001), '100.10');
  assert.equal(limitBuyPrice(100, '1', 0.002), '101');
});

// ---------- fills ----------

test('paperBuyFill / paperSellFill: model path', () => {
  // bid 99 ask 101 -> mid 100, halfSpread 0.01, slip 0.0005
  const b = paperBuyFill({ qty: 2, bid: 99, ask: 101, feeRatio: FEE, now: T0 });
  assert.equal(b.source, 'model');
  near(b.fillPrice, 101 * 1.0105);
  near(b.feeUsd, 2 * b.fillPrice * FEE);
  near(b.costUsd, 2 * b.fillPrice + b.feeUsd);
  const s = paperSellFill({ qty: 2, bid: 99, ask: 101, feeRatio: FEE, now: T0 });
  assert.equal(s.source, 'model');
  near(s.fillPrice, 99 * (1 - 0.0105));
  near(s.feeUsd, 2 * s.fillPrice * FEE);
  near(s.proceedsUsd, 2 * s.fillPrice - s.feeUsd);
  assert.ok(s.proceedsUsd < b.costUsd);
});

test('paperBuyFill / paperSellFill: estimate path only when <= 15 s old', () => {
  const fresh = { estTotalCost: 203, estTotalCredit: 195, estFee: 1.7, at: T0 - 15000 };
  const b = paperBuyFill({ qty: 2, bid: 99, ask: 101, feeRatio: FEE, estimate: fresh, now: T0 });
  assert.equal(b.source, 'estimate');
  assert.equal(b.costUsd, 203);
  assert.equal(b.feeUsd, 1.7);
  near(b.fillPrice, (203 - 1.7) / 2);
  const s = paperSellFill({ qty: 2, bid: 99, ask: 101, feeRatio: FEE, estimate: fresh, now: T0 });
  assert.equal(s.source, 'estimate');
  assert.equal(s.proceedsUsd, 195);
  near(s.fillPrice, (195 + 1.7) / 2);
  const stale = { ...fresh, at: T0 - 15001 };
  assert.equal(paperBuyFill({ qty: 2, bid: 99, ask: 101, feeRatio: FEE, estimate: stale, now: T0 }).source, 'model');
  assert.equal(paperSellFill({ qty: 2, bid: 99, ask: 101, feeRatio: FEE, estimate: stale, now: T0 }).source, 'model');
  // estimate without estFee derives the fee from the ratio
  const noFee = paperBuyFill({ qty: 2, bid: 99, ask: 101, feeRatio: FEE, estimate: { estTotalCost: 201.7, at: T0 }, now: T0 });
  near(noFee.feeUsd, 201.7 * FEE / (1 + FEE));
});

test('markToMarket = qty*bid*(1-fee) - costUsd', () => {
  near(markToMarket({ qty: 0.001, costUsd: 26 }, 50000, FEE), 0.001 * 50000 * (1 - FEE) - 26);
  near(markToMarket({ qty: 0.001, costUsd: 26 }, 50000, FEE), 23.575);
});

// ---------- cooldown and candidates ----------

test('cooldownUntil: win vs loss minutes', () => {
  assert.equal(cooldownUntil({ closedAt: T0, pnlUsd: 1 }), T0 + 5 * 60000);
  assert.equal(cooldownUntil({ closedAt: T0, pnlUsd: 0 }), T0 + 5 * 60000);
  assert.equal(cooldownUntil({ closedAt: T0, pnlUsd: -0.01 }), T0 + 30 * 60000);
  assert.equal(cooldownUntil({ closedAt: T0, pnlUsd: -1 }, { cooldownLossMin: 2 }), T0 + 2 * 60000);
});

test('pickCandidates ranks by expectedMove/cost, ties by symbol, honours open/cooldown/maxOpen', () => {
  const fx = (expectedMovePct) => ({ features: { ok: true, expectedMovePct }, costPct: 0.02 });
  const by = { 'ETH-USD': fx(0.1), 'BTC-USD': fx(0.06), 'SOL-USD': fx(0.1), 'DOGE-USD': fx(0.2), 'XRP-USD': { features: { ok: false, reason: 'warmup' }, costPct: 0.02 } };
  assert.deepEqual(pickCandidates(by, [], {}, 10, T0), ['DOGE-USD', 'ETH-USD', 'SOL-USD', 'BTC-USD']);
  assert.deepEqual(pickCandidates(by, ['DOGE-USD'], { 'ETH-USD': T0 + 1 }, 10, T0), ['SOL-USD', 'BTC-USD']);
  assert.deepEqual(pickCandidates(by, ['DOGE-USD'], { 'ETH-USD': T0 }, 10, T0), ['ETH-USD', 'SOL-USD', 'BTC-USD']);
  assert.deepEqual(pickCandidates(by, ['DOGE-USD'], {}, 3, T0), ['ETH-USD', 'SOL-USD']);
  assert.deepEqual(pickCandidates(by, ['DOGE-USD'], {}, 1, T0), []);
});
