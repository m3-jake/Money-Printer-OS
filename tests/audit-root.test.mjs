import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as practice from '../src/robinhoodPractice.js';
import * as daily from '../src/robinhoodDailyBook.js';
import { normalizePolymarket } from '../src/core/predictionProviders.js';
import { labVariants } from '../src/botFarm.js';

test('practice accumulates observed moves and refuses churn below its full cost wall', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-practice-cost-'));
  let price = 100000;
  const feed = async (symbols, { now }) => ({ source: 'observed-fixture', quotes: symbols.map(symbol => ({ symbol, bid: price * .9995, ask: price * 1.0005, at: now })) });
  const start = Date.UTC(2026, 9, 3);
  try {
    practice.configurePractice({ dataDir: dir, now: start, patch: { autopilot: true, symbols: ['BTC-USD'] } });
    await practice.runPracticeCycle({ dataDir: dir, now: start, fetchMarket: feed });
    price = 101000;
    let s = await practice.runPracticeCycle({ dataDir: dir, now: start + 15000, fetchMarket: feed });
    assert.equal(s.positions.length, 0);
    assert.equal(s.telemetry.rejectionReasons['below-cost-wall'], 1);
    for (let i = 2; i <= 10; i++) {
      price = 100000 * (1 + .005 * i);
      s = await practice.runPracticeCycle({ dataDir: dir, now: start + 15000 * i, fetchMarket: feed });
    }
    assert.equal(s.positions.length, 1, 'the cumulative move clears costs, although each individual tick is small');
    assert.equal(s.countsTowardQualification, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('daily allocations conserve a $25 bankroll across eight or three sleeves', () => {
  for (const symbols of [daily.DAILY_DEFAULTS.symbols, ['BTC-USD', 'ETH-USD', 'SOL-USD']]) {
    const b = daily.newDailyBook({ startUsd: 25, symbols });
    assert.equal(Object.values(b.sleeves).reduce((n, s) => n + Math.round(s.cashUsd * 100), 0), 2500);
  }
});

test('daily candle-derived wins cannot qualify as prospective execution evidence', () => {
  const b = daily.newDailyBook(), hash = 'h'; b.source = { paramsHash: hash };
  b.equityDaily = Array.from({ length: 200 }, (_, i) => ({ d: new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10), equityUsd: 25 + i / 10, benchUsd: 25 + i / 20, paramsHash: hash }));
  b.history = Array.from({ length: 12 }, (_, i) => ({ exitDay: b.equityDaily[10 + i * 15].d, pnlUsd: 1, paramsHash: hash, priceSource: { entry: 'coinbase-open', exit: 'coinbase-open' }, late: { entry: false, exit: false } }));
  const q = daily.dailyQualification(b);
  assert.equal(q.qualified, false); assert.equal(q.gates.observedExecution, false);
  assert.match(q.reasons.join(), /candle-open or late fills are diagnostic only/);
});

test('sports provider retains Polymarket execution identity separately from titles', () => {
  const c = normalizePolymarket({ id: 'market', question: 'A vs. B', conditionId: 'condition', slug: 'a-b-2026-10-03', outcomes: ['A', 'B'], clobTokenIds: ['token-a', 'token-b'], active: true });
  assert.equal(c.data.conditionId, 'condition'); assert.equal(c.data.slug, 'a-b-2026-10-03');
  assert.deepEqual(c.data.tokenIds, ['token-a', 'token-b']);
});

test('daily orders wait for a post-decision observed quote while the open window remains', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-daily-quote-'));
  let now = Date.UTC(2026, 9, 3, 0, 5);
  const day = 864e5, closed = Date.UTC(2026, 9, 2);
  const bars = Array.from({ length: 200 }, (_, i) => {
    const t = closed - (199 - i) * day;
    return { t, d: new Date(t).toISOString().slice(0, 10), o: 100, h: 110, l: 99, c: i === 199 ? 110 : 100 };
  });
  try {
    fs.mkdirSync(path.dirname(daily.barsFile(dir)), { recursive: true });
    fs.writeFileSync(daily.barsFile(dir), JSON.stringify({ version: 1, bars: { 'BTC-USD': bars }, today: { 'BTC-USD': { d: '2026-10-03', o: 110 } } }));
    let at = now - 10_000;
    const run = () => daily.runDailyOnce({ dataDir: dir, now, env: { ROBINHOOD_DAILY_SYMBOLS: 'BTC-USD' }, labDaily: null,
      fetchFn: () => { throw new Error('unexpected fetch'); }, quoteFn: () => ({ bid: 110, ask: 111, at }) });
    let r = await run();
    assert.equal(r.book.pending.length, 1); assert.equal(r.book.fills.length, 0);
    now += 15_000; at = now;
    r = await run();
    assert.equal(r.book.pending.length, 0); assert.equal(r.book.fills.length, 1);
    assert.equal(r.book.fills[0].priceSource, 'robinhood-quote');
    assert.equal(r.book.lastDecision.at, now - 15_000, 'a new quote fills the persisted decision without deciding twice');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('farm proposal admission rejects legacy, stale, and diagnostic evidence', () => {
  const now = Date.UTC(2026, 9, 3);
  const v = { id: 'lab-btc-good', kind: 'btc', over: { volMultiple: 1.6 }, at: now, paperPromotionAllowed: true,
    evidence: { executionVerified: true, availabilityVerified: true, holdoutConsumedOnce: true, holdout: { n: 40, meanPerBet: .1, ciLo: .02, ciHi: .18 } } };
  const doc = { schema: 'mpo.lab-farm-proposals.v1', at: now, variants: [v] };
  assert.equal(labVariants(doc, now).length, 1);
  assert.deepEqual(labVariants({ variants: [v] }, now), []);
  assert.deepEqual(labVariants({ ...doc, at: now - 49 * 3600e3 }, now), []);
  for (const flag of ['executionVerified', 'availabilityVerified', 'holdoutConsumedOnce']) {
    assert.deepEqual(labVariants({ ...doc, variants: [{ ...v, evidence: { ...v.evidence, [flag]: false } }] }, now), []);
  }
  assert.deepEqual(labVariants({ ...doc, variants: [{ ...v, at: now + 1 }] }, now), []);
  assert.deepEqual(labVariants({ ...doc, variants: [{ ...v, evidence: { ...v.evidence, holdout: { n: 40, meanPerBet: .1, ciLo: -.02, ciHi: .18 } } }] }, now), []);
});
