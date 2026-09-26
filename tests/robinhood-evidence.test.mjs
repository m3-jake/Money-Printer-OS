// Batch B evidence measurements: the vol-gate ratio and the cost charged to synthetic (non-venue) rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as S from '../src/robinhoodStrategy.js';
import { backtestTape } from '../src/robinhoodBacktest.js';
import { volGateStats, realisticSpreads, syntheticSpreadPct, isSyntheticRow } from '../src/robinhoodEvidence.js';

const STEP = 15000, DAY = 864e5, NOW = 1_800_000_000_000;
const params = S.normalizeParams({});
function series({ n, drift = 0.0006, noise = 0.004, spread = 0.001, seed = 7, src = 'robinhood' }) {
  let s = seed, mid = 100; const out = [];
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; mid *= 1 + drift + (s / 4294967296 - 0.5) * noise; out.push({ t: NOW - (n - 1 - i) * STEP, bid: mid * (1 - spread / 2), ask: mid * (1 + spread / 2), mid, src }); }
  return out;
}

test('vol gate: only Robinhood rows in the window count; ratio = p95 expected / (costMultiple x C)', () => {
  const quiet = series({ n: 2000, drift: 0, noise: 0.0002 });
  const v = volGateStats([...series({ n: 500, src: 'coinbase-candles' }), ...quiet], { params, feeRatio: 0.0085, now: NOW });
  assert.equal(v.rows, 2000, 'candle rows are not venue evidence');
  assert.ok(Math.abs(v.medianSpreadPct - 0.001) < 1e-6);
  assert.ok(Math.abs(v.costPct - S.roundTripCost(0.0085, v.medianSpreadPct, params)) < 1e-6);
  assert.ok(Math.abs(v.requiredMovePct - params.costMultiple * v.costPct) < 1e-6);
  assert.ok(v.p50ExpectedMovePct <= v.p95ExpectedMovePct);
  assert.ok(Math.abs(v.ratio - v.p95ExpectedMovePct / v.requiredMovePct) < 1e-3);
  assert.equal(v.verdict, 'BINDING'); assert.ok(v.ratio < 1);
  const wild = volGateStats(series({ n: 2000, drift: 0, noise: 0.02 }), { params, feeRatio: 0.0085, now: NOW });
  assert.equal(wild.verdict, 'CAN_TRADE'); assert.ok(wild.ratio >= 1);
  assert.equal(volGateStats([], { params, now: NOW }).verdict, 'INSUFFICIENT');
  assert.equal(volGateStats(quiet, { params, now: NOW + 8 * DAY }).rows, 0, 'older than 7 days drops out');
});

test('synthetic rows: tagged non-Robinhood rows are re-costed, untagged legacy rows and venue rows are untouched', () => {
  const rh = series({ n: 10, spread: 0.002 }), candles = series({ n: 10, spread: 0, src: 'coinbase-candles' }).map(r => ({ ...r, t: r.t + DAY }));
  const legacy = { ...rh[0], src: undefined, t: NOW + 2 * DAY };
  const a = realisticSpreads([...rh, ...candles, legacy], { params });
  assert.equal(a.rowsSynthetic, 10); assert.equal(a.syntheticShare, Math.round(10 / 21 * 1000) / 1000);
  assert.deepEqual(a.rows.slice(0, 10), rh); assert.deepEqual(a.rows[20], legacy);
  for (const r of a.rows.slice(10, 20)) { assert.ok(r.ask > r.bid, 'a candle is never free to cross'); assert.equal(r.src, 'coinbase-candles'); assert.ok(Math.abs((r.bid + r.ask) / 2 - r.mid) < 1e-9, 'mid path unchanged'); }
  assert.equal(isSyntheticRow({ src: null }), false); assert.equal(isSyntheticRow({ src: 'coinbase-public-paper' }), true);
});

test('syntheticSpreadPct: trailing venue median when there is one, the spread gate when there is none, never below the row itself', () => {
  const gate = params.maxSpreadBps / 1e4;
  assert.ok(Math.abs(syntheticSpreadPct({ ownSpreadPct: 0, trailingVenueSpreads: [0.001, 0.003, 0.002], maxSpreadBps: params.maxSpreadBps }) - 0.002) < 1e-12);
  assert.ok(Math.abs(syntheticSpreadPct({ ownSpreadPct: 0, trailingVenueSpreads: [], maxSpreadBps: params.maxSpreadBps }) - gate) < 1e-12);
  assert.ok(syntheticSpreadPct({ ownSpreadPct: 0.005, trailingVenueSpreads: [0.001], maxSpreadBps: params.maxSpreadBps }) >= 0.005);
  assert.ok(syntheticSpreadPct({ ownSpreadPct: null, trailingVenueSpreads: [], maxSpreadBps: params.maxSpreadBps }) > 0);
});

test('the same mid path tagged coinbase-candles never beats it tagged robinhood with a real spread', () => {
  const opts = { params: { ...params, sampleMs: STEP }, feeRatio: 0.0085, orderUsd: 25, startUsd: 1000 };
  for (const seed of [3, 7, 11, 19]) {
    const venue = series({ n: 3000, seed, spread: 0.001 });
    const candles = venue.map(r => ({ t: r.t, bid: r.mid, ask: r.mid, mid: r.mid, src: 'coinbase-candles' }));
    const real = backtestTape(venue, opts).metrics, raw = backtestTape(candles, opts).metrics;
    const costed = backtestTape(realisticSpreads(candles, { params }).rows, opts).metrics;
    assert.ok(costed.pnlUsd <= real.pnlUsd + 1e-9, `seed ${seed}: costed candles ${costed.pnlUsd} > venue ${real.pnlUsd}`);
    assert.ok(raw.pnlUsd >= costed.pnlUsd - 1e-9, `seed ${seed}: re-costing never makes candles look better`);
  }
});

test('wiring: the evolve run re-costs its tape and /api/robinhood serves evolve.volGate', () => {
  const src = fs.readFileSync(new URL('../src/robinhoodAutoTrader.js', import.meta.url), 'utf8');
  assert.match(src, /realisticSpreads\(T\.loadTape\(s,since\)/);
  assert.equal((src.match(/volGate:robinhoodVolGate\(p\)/g) || []).length, 2, 'both the Lab-sourced and local evolve views');
  assert.match(src, /tapeDays,synthetic,/);
});
