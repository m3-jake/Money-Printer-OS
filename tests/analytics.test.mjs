import test from 'node:test';
import assert from 'node:assert/strict';
import { journalReport, maxDrawdown, rollingSharpe, renderJournalTable } from '../src/analytics/journalReport.js';
import { attributePnl } from '../tools/analytics/attribution.js';
import { edgeBySignal } from '../tools/analytics/edge.js';
import { edgeDecay } from '../tools/analytics/decay.js';
import { priceDivergenceBps, validateCrossSourcePrices } from '../tools/analytics/validation.js';
import { parseWindow } from '../tools/analytics/cli.js';

const fixture = [
  { type: 'trade-close', trade: { strategy: 'MOMO', dominantSignal: 'momentum', signalSource: 'scanner', pnlSol: 2, closedAt: 1000 } },
  { type: 'trade-close', trade: { strategy: 'MOMO', dominantSignal: 'momentum', signalSource: 'scanner', pnlSol: -1, closedAt: 86_401_000 } },
  { type: 'trade-close', trade: { strategy: 'MEAN', dominantSignal: 'range', signalSource: 'copy:abc', pnlSol: 3, closedAt: 172_801_000 } },
];

test('strategy report computes win rate, expectancy, average outcomes, drawdown and observed span', () => {
  const report = journalReport(fixture, { now: 200_000_000 });
  assert.equal(report.tradeCount, 3);
  assert.deepEqual(report.strategies[0], { strategy: 'MEAN', tradeCount: 1, winRate: 1, expectancy: 3, avgWin: 3, avgLoss: null, maxDD: 0, rollingSharpe: null, samples: 1, daysObserved: 0 });
  const momo = report.strategies[1];
  assert.equal(momo.winRate, 0.5); assert.equal(momo.expectancy, 0.5); assert.equal(momo.avgWin, 2); assert.equal(momo.avgLoss, -1); assert.equal(momo.maxDD, 1); assert.equal(momo.daysObserved, 1);
  assert.match(renderJournalTable(report), /\| Strategy \| Trades/);
  assert.equal(maxDrawdown([2, -1, -3, 4]), 4); assert.equal(rollingSharpe([1, 1, 1]), null);
});

test('signal attribution and edge confidence intervals use closed trade fixtures', () => {
  const attribution = attributePnl(fixture);
  assert.deepEqual(attribution.map(x => [x.source, x.tradeCount, x.pnl]), [['copy:abc', 1, 3], ['scanner', 2, 1]]);
  const edge = edgeBySignal(fixture);
  assert.equal(edge.find(x => x.signal === 'momentum').expectancy, 0.5);
  assert.ok(Math.abs(edge.find(x => x.signal === 'momentum').confidenceInterval.low - (-2.44)) < 1e-12);
  assert.equal(edge.find(x => x.signal === 'range').confidenceInterval.low, 3);
});

test('decay flags signals with more than fifty percent trailing expectancy drop', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ trade: { closedAt: i + 1, pnlSol: i < 10 ? 2 : 0.5, dominantSignal: 'trend' } }));
  const result = edgeDecay(rows, { window: 10 })[0];
  assert.equal(result.baselineExpectancy, 2); assert.equal(result.expectancy, 0.5); assert.equal(result.droppedPct, 0.75); assert.equal(result.decayed, true);
});

test('cross-source price validation logs and skips divergences and missing source pairs', () => {
  assert.ok(Math.abs(priceDivergenceBps([100, 101]) - 10000 / 100.5) < 1e-12);
  const logged = [];
  assert.equal(validateCrossSourcePrices({ mint: 'M', dexscreener: 100, jupiter: 103, onchain: 100, maxDivergenceBps: 100, log: x => logged.push(x) }).skipTrade, true);
  assert.equal(validateCrossSourcePrices({ dexscreener: 100, jupiter: 100.5, maxDivergenceBps: 100 }).skipTrade, false);
  assert.equal(validateCrossSourcePrices({ dexscreener: 100 }).reason, 'insufficient-price-sources');
  assert.equal(logged.length, 1); assert.equal(logged[0].type, 'price-validation-skip');
});

test('replay window accepts timestamps and dates and rejects reversed or malformed input', () => {
  assert.deepEqual(parseWindow('100,200'), { start: 100, end: 200 });
  assert.deepEqual(parseWindow('2020-01-01,2020-01-02'), { start: Date.parse('2020-01-01'), end: Date.parse('2020-01-02') });
  assert.throws(() => parseWindow('200,100'), /invalid or reversed/);
  assert.throws(() => parseWindow('bad'), /<start,end>/);
});
