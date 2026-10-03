import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as practice from '../src/robinhoodPractice.js';
import * as daily from '../src/robinhoodDailyBook.js';
import { normalizePolymarket } from '../src/core/predictionProviders.js';

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
