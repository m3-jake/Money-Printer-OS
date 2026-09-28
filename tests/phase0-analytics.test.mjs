import test from 'node:test';
import assert from 'node:assert/strict';
import { finite, timestamp, sharpe, summarizeTrades, realizedSharpe } from '../src/analytics/edge.js';
import { signalAtEntry, attributeSignals } from '../src/analytics/attribution.js';
const H = 3_600_000;
const T = Date.UTC(2026, 8, 27);
const fixtureTrade = (pnl, i = 0) => ({ id: String(i), strategyId: 'TEST', currency: 'SOL', openedAt: T, closedAt: T + (i + .5) * H, pnl, basis: 100 });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('missing values are not zero', () => {
  for (const value of [null, undefined, '', false, 'bad', Infinity]) assert.equal(finite(value), null);
  assert.equal(finite(0), 0);
  assert.equal(timestamp('2026-09-27T00:00:00Z'), T);
});
test('net statistics and first-loss drawdown match fixture arithmetic', () => {
  const rows = [-10, 20, -5, 0].map(fixtureTrade);
  const m = summarizeTrades(rows, { start: T, end: T + 4 * H, startingCapital: 100 });
  assert.equal(m.tradeCount, 4);
  near(m.winRate, .25); near(m.expectancy, 1.25);
  near(m.avgWin, 20); near(m.avgLoss, -7.5);
  near(m.maxDrawdown, 10); near(m.maxDrawdownPct, 10);
  near(m.totalPnl, 5); near(m.daysObserved, 1 / 6);
  assert.equal(m.breakeven, 1);
});
test('empty and zero-variance samples are not evidence', () => {
  const m = summarizeTrades([]);
  assert.equal(m.expectancy, null); assert.equal(m.winRate, null); assert.equal(m.rollingSharpe, null);
  assert.equal(sharpe([1, 1, 1]), null); assert.equal(sharpe([null, 0, 1]), null);
});
test('Sharpe uses sample SD, excess returns and no annualization', () => {
  near(sharpe([1, 2, 3]), 2); near(sharpe([1, 2, 3], 1), 1);
  const rows = [10, -5, 10, -5].map(fixtureTrade);
  const result = realizedSharpe(rows, { start: T, end: T + 4 * H, startingCapital: 100 });
  near(result.value, sharpe([.1, -5 / 110, 10 / 105, -5 / 115]));
  assert.equal(result.samples, 4); assert.equal(result.annualized, false);
  assert.equal(realizedSharpe(rows, { start: T, end: T + H, startingCapital: 100 }).value, null);
});
test('currencies cannot be combined into a fictitious return', () => {
  assert.throws(() => summarizeTrades([fixtureTrade(1), { ...fixtureTrade(2, 1), currency: 'USD' }]), /currencies/);
});
test('signal joins never look forward, and reject stale or absent evidence', () => {
  const byMint = new Map([['m', [{ ts: T, dominantSignal: 'old' }, { ts: T + 10_000, dominantSignal: 'future' }]]]);
  assert.equal(signalAtEntry({ mint: 'm', openedAt: T + 5000 }, byMint).signalSource, 'old');
  assert.equal(signalAtEntry({ mint: 'm', openedAt: T - 1 }, byMint).signalSource, 'UNKNOWN');
  assert.equal(signalAtEntry({ mint: 'm', openedAt: T + 50_001 }, byMint).signalSource, 'UNKNOWN');
});
test('single-source attribution conserves P&L separately in each currency', () => {
  const rows = [{ ...fixtureTrade(3), signalSource: 'a' }, { ...fixtureTrade(-2, 1), signalSource: 'b' },
    { ...fixtureTrade(4, 2), currency: 'USD' }];
  const a = attributeSignals(rows);
  near(a.totalsByCurrency.SOL, 1); near(a.totalsByCurrency.USD, 4);
  assert.equal(a.unknownTradeCount, 1);
});
import { normalizeTrade, deduplicateTrades, epochReports, parseArgs } from '../src/analytics/journalReport.js';

test('normalization refuses live, missing-PnL and unclosed rows', () => {
  const raw = { id: 'x', openedAt: T, closedAt: T + H, pnlSol: 0, sizeSol: 1 };
  assert.equal(normalizeTrade(raw).pnl, 0);
  assert.equal(normalizeTrade({ ...raw, pnlSol: null }), null);
  assert.equal(normalizeTrade({ ...raw, mode: 'LIVE' }), null);
  assert.equal(normalizeTrade({ ...raw, mode: 'PAPER', pnlMode: 'LIVE' }), null);
  assert.equal(normalizeTrade({ ...raw, signature: 'live-signature' }), null);
  assert.equal(normalizeTrade({ ...raw, closedAt: null }), null);
  assert.equal(normalizeTrade({ ...raw, status: 'CANCELLED' }), null);
});
test('duplicates and conflicts are counted rather than selecting the winning record', () => {
  const row = { ...fixtureTrade(-2), venue: 'pumpfun' }, q = {};
  const rows = deduplicateTrades([row, { ...row }, { ...row, pnl: 100 }], q);
  assert.equal(rows.length, 1); assert.equal(rows[0].pnl, -2);
  assert.equal(q.duplicateTrade, 1); assert.equal(q.conflictingDuplicate, 1);
});
test('resets preserve losses and keep drawdowns in separate eras', () => {
  const journal = { resets: [{ ts: T + 2 * H, amountSol: 100 }], trades: [-10, 5, -8, 3].map(fixtureTrade) };
  const eras = epochReports(journal, T, T + 4 * H);
  assert.equal(eras.length, 2); near(eras[0].metrics[0].totalPnl, -5); near(eras[1].metrics[0].totalPnl, -5);
  near(eras[0].metrics[0].maxDrawdown, 10); near(eras[1].metrics[0].maxDrawdown, 8);
});
test('CLI rejects unknown flags, invalid windows and invalid capital', () => {
  assert.throws(() => parseArgs(['journal', '--live', 'true']), /Unknown/);
  assert.throws(() => parseArgs(['journal', '--from', 'not-a-date']), /Invalid timestamp/);
  assert.throws(() => parseArgs(['replay', '--start-sol', '-1']), /positive/);
});
test('recorded net P&L is not charged modeled fees twice', () => {
  const row = normalizeTrade({ id: 'net', openedAt: T, closedAt: T + H, sizeSol: .2, pnlSol: '-0.1', feesSol: 10 });
  near(summarizeTrades([row]).expectancy, -.1);
  near(summarizeTrades([{ ...fixtureTrade(1), pnl: '2' }]).totalPnl, 2);
});
