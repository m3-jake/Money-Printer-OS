import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfigs, replayFixedWindow } from '../src/replayLab.js';
const T = Date.UTC(2026, 8, 27), config = makeConfigs(['FAST'])[0];
const event = (offset, price) => ({ ts: T + offset, mint: 'fixture-mint', symbol: 'FIX', price,
  liq: 100_000, score: 100, executionScore: 95, eligible: true, warnings: 0, staleResume: false, regime: 'COLD' });
const options = { from: T, to: T + 10_000, startSol: 1, solUsd: 200 };

test('fixed replay is deterministic, net of costs and does not mutate input', () => {
  const rows = [event(0, 1), event(1000, .8)], original = JSON.stringify(rows);
  const a = replayFixedWindow(rows, config, options), b = replayFixedWindow(rows, config, options);
  assert.deepEqual(a, b); assert.equal(JSON.stringify(rows), original);
  assert.equal(a.trades.length, 1); assert.ok(a.trades[0].pnl < 0); assert.ok(a.fees > 0);
  assert.ok(Math.abs(a.finalEquity - (1 + a.realizedPnl)) < 1e-10);
  assert.ok(Math.abs(a.realizedPnl - a.trades[0].pnl) < 1e-10);
});
test('future prices cannot improve the fixed historical window', () => {
  const rows = [event(0, 1), event(1000, .8)];
  assert.deepEqual(replayFixedWindow(rows, config, options),
    replayFixedWindow([...rows, event(20_000, 1_000_000)], config, options));
});
test('unresolved end-of-window positions are censored, not wins', () => {
  const result = replayFixedWindow([event(0, 1)], config, options);
  assert.equal(result.trades.length, 0); assert.equal(result.censored, 1);
  assert.ok(result.realizedPnl < 0, 'Open entry fees stay in total realized P&L');
});
test('replay has no network or order side effects', () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('Network forbidden'); };
  try { replayFixedWindow([event(0, 1), event(1000, .8)], config, options); assert.equal(calls, 0); }
  finally { globalThis.fetch = previous; }
});
test('invalid windows and altered baseline parameters are rejected', () => {
  assert.throws(() => replayFixedWindow([], config, { ...options, to: T }), /window/);
  assert.throws(() => replayFixedWindow([], { ...config, id: 'LIVE' }, options), /reference/);
  assert.throws(() => replayFixedWindow([], { ...config, aggression: 98 }, options), /immutable/);
});
