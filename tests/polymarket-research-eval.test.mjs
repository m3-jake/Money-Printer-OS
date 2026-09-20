import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SCHEMA,
  FEE_MODEL,
  AsOfClock,
  takerFeePerShare,
  walkAsksForStake,
  validateTape,
  evaluateTape,
  promotionDecision,
  eventGroupedBootstrap,
  isMainModule,
  markdownReport,
} from '../src/polymarketResearchEval.js';

const SRC = fs.readFileSync(new URL('../src/polymarketResearchEval.js', import.meta.url), 'utf8');

function tape(partial = {}) {
  return {
    schema: SCHEMA,
    testOnly: true,
    source: 'synthetic-test',
    bankrollUsd: 100,
    maxRelatedEventExposureUsd: 50,
    maxOpenPositions: 8,
    incumbent: { preset: 'take-none' },
    candidate: { preset: 'take-all' },
    observations: [],
    opportunities: [],
    ...partial,
  };
}

function quote({ ts, eventId, marketId, tokenId, bid, ask, bidSize = 1000, askSize = 1000 }) {
  return {
    type: 'quote', asOfTs: ts, eventId, marketId, tokenId, bid, ask,
    bids: [{ price: bid, size: bidSize }],
    asks: [{ price: ask, size: askSize }],
  };
}
function fee({ ts, marketId, rate = 0.05, exponent = 1, feesEnabled = true }) {
  return { type: 'fee', asOfTs: ts, marketId, feesEnabled, feeSchedule: { rate, exponent, takerOnly: true } };
}
function sports({ ts, eventId, lastUpdate = ts, period = 'Q4', elapsed = '1:00' }) {
  return { type: 'sports', asOfTs: ts, eventId, period, elapsed, lastUpdate, score: '1-0' };
}
function outcome({ ts, marketId, eventId, resolvedPrice }) {
  return { type: 'outcome', asOfTs: ts, marketId, eventId, resolved: true, resolvedPrice };
}
function opp({ id, ts, eventId, marketId, tokenId, stake = 10, signalTs = ts, extra = {} }) {
  return {
    id, decisionTs: ts, eventId, marketId, tokenId, outcome: 'Yes', requestedStakeUsd: stake,
    signal: { asOfTs: signalTs, score: 80 },
    ...extra,
  };
}

function favoriteWorld({ n = 10, losses = 1, ask = 0.94, bid = 0.86, feeRate = 0.25, stake = 10 } = {}) {
  const observations = [];
  const opportunities = [];
  for (let i = 0; i < n; i++) {
    const ts = 1_000 + i * 1_000;
    const eventId = `E${i}`;
    const marketId = `M${i}`;
    const tokenId = `T${i}`;
    observations.push(
      quote({ ts, eventId, marketId, tokenId, bid, ask }),
      fee({ ts, marketId, rate: feeRate }),
      sports({ ts, eventId }),
      outcome({ ts: ts + 10, marketId, eventId, resolvedPrice: i < n - losses ? 1 : 0 }),
    );
    opportunities.push(opp({ id: `o${i}`, ts, eventId, marketId, tokenId, stake }));
  }
  return tape({
    observations, opportunities,
    candidate: { preset: 'mid-price-favorites' },
    incumbent: { preset: 'take-none' },
    maxRelatedEventExposureUsd: 100,
  });
}

test('as-of clock rejects lookahead and backward jumps', () => {
  const c = new AsOfClock();
  c.set(100);
  assert.throws(() => c.assert(101), /lookahead/);
  c.assert(100);
  assert.throws(() => c.set(99), /backward/);
});

test('synthetic tapes without testOnly are rejected so depth/fees cannot be invented', () => {
  assert.throws(() => validateTape({
    schema: SCHEMA, source: 'synthetic', observations: [{ type: 'quote', asOfTs: 1, marketId: 'm', ask: 0.5 }],
    opportunities: [{ id: 'o', decisionTs: 1, eventId: 'e', marketId: 'm' }],
  }), /testOnly/);
});

test('fee formula matches sports_fees_v3 and refuses to invent a schedule', () => {
  const meta = { feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1 } };
  const fee = (p, rate = 0.05, exp = 1) => rate * Math.pow(p, exp) * Math.pow(1 - p, exp);
  assert.equal(takerFeePerShare(0.9, meta), fee(0.9));
  assert.equal(takerFeePerShare(0.5, meta), fee(0.5));
  assert.equal(takerFeePerShare(0.9, { feesEnabled: false }), 0);
  assert.equal(takerFeePerShare(0.9, { feesEnabled: true }), null);
  assert.equal(FEE_MODEL, 'docs:C*rate*p*(1-p) sports_fees_v3');
});

test('profitable-looking favorite strategy fails after executable costs and does not promote on win rate', () => {
  const world = favoriteWorld({ n: 10, losses: 1, ask: 0.94, bid: 0.86, feeRate: 0.25 });
  const a = evaluateTape(world);
  const b = evaluateTape(world);
  assert.deepEqual(a.candidate.netPnlUsd, b.candidate.netPnlUsd);
  assert.equal(a.dataset.hash, b.dataset.hash);
  assert.equal(Object.hasOwn(a, 'generatedAt'), false);
  assert.ok(a.candidate.winRatePct >= 80, `win rate ${a.candidate.winRatePct}`);
  assert.ok(a.candidate.netPnlUsd < 0, `net pnl ${a.candidate.netPnlUsd} should be negative after spread+fees`);
  assert.equal(a.incumbent.netPnlUsd, 0);
  assert.equal(a.comparison.sameOpportunities, true);
  assert.equal(a.promotion.live, false);
  assert.equal(a.promotion.eligible, false);
  assert.ok(a.promotion.fail.includes('no-positive-net-pnl'));
  assert.ok(a.promotion.fail.includes('win-rate-is-not-profit'));
  assert.equal(a.criteria.pricesAloneAreNotEdge, true);
  assert.equal(a.criteria.winRateIsNotProfitability, true);
});

test('correlated legs on one event count as one independent observation', () => {
  const ts = 1000;
  const eventId = 'GAME1';
  const t = tape({
    maxRelatedEventExposureUsd: 40,
    observations: [
      quote({ ts, eventId, marketId: 'ML', tokenId: 'TML', bid: 0.5, ask: 0.51 }),
      quote({ ts, eventId, marketId: 'SP', tokenId: 'TSP', bid: 0.5, ask: 0.51 }),
      fee({ ts, marketId: 'ML', rate: 0.02 }),
      fee({ ts, marketId: 'SP', rate: 0.02 }),
      sports({ ts, eventId }),
      outcome({ ts: 2000, marketId: 'ML', eventId, resolvedPrice: 1 }),
      outcome({ ts: 2000, marketId: 'SP', eventId, resolvedPrice: 1 }),
    ],
    opportunities: [
      opp({ id: 'ml', ts, eventId, marketId: 'ML', tokenId: 'TML', stake: 10 }),
      opp({ id: 'sp', ts, eventId, marketId: 'SP', tokenId: 'TSP', stake: 10 }),
    ],
  });
  const r = evaluateTape(t, { thresholds: { minIndependentEvents: 20 } });
  assert.equal(r.candidate.trades, 2);
  assert.equal(r.candidate.independentEventCount, 1);
  assert.equal(r.candidate.wins, 2);
  assert.equal(r.candidate.bootstrap.n, 1);
  assert.equal(r.candidate.bootstrap.ciLow, null);
  assert.ok(r.promotion.fail.includes('insufficient-independent-events'));
  assert.ok(r.promotion.fail.includes('bootstrap-unavailable-event-grouped'));
  const boot = eventGroupedBootstrap(r.candidate.eventPnls, { iterations: 50, seed: 1 });
  assert.equal(boot.groupedBy, 'event');
});

test('delayed resolution locks settlement capital so a later stake cannot reuse it', () => {
  const t = tape({
    bankrollUsd: 10,
    maxRelatedEventExposureUsd: 10,
    observations: [
      quote({ ts: 1000, eventId: 'A', marketId: 'MA', tokenId: 'TA', bid: 0.4, ask: 0.5 }),
      quote({ ts: 2000, eventId: 'B', marketId: 'MB', tokenId: 'TB', bid: 0.4, ask: 0.5 }),
      fee({ ts: 1000, marketId: 'MA', rate: 0.01 }),
      fee({ ts: 2000, marketId: 'MB', rate: 0.01 }),
      sports({ ts: 1000, eventId: 'A' }),
      sports({ ts: 2000, eventId: 'B' }),
      outcome({ ts: 9000, marketId: 'MA', eventId: 'A', resolvedPrice: 1 }),
      outcome({ ts: 9000, marketId: 'MB', eventId: 'B', resolvedPrice: 1 }),
    ],
    opportunities: [
      opp({ id: 'first', ts: 1000, eventId: 'A', marketId: 'MA', tokenId: 'TA', stake: 10 }),
      opp({ id: 'second', ts: 2000, eventId: 'B', marketId: 'MB', tokenId: 'TB', stake: 10 }),
    ],
  });
  const r = evaluateTape(t);
  assert.equal(r.candidate.trades, 1);
  assert.equal(r.candidate.rejections.some(x => x.opportunityId === 'second' && x.reasons.includes('bankroll')), true);
  const lockPoint = r.candidate.curve.find(p => p.ts === 2000);
  assert.ok(lockPoint.lockedUsd > 0, 'capital must remain locked through the delayed outcome');
  assert.ok(lockPoint.cash < 1);
});

test('stale executable quote is rejected and not filled from a later book', () => {
  const t = tape({
    quoteStaleMs: 15_000,
    observations: [
      quote({ ts: 1000, eventId: 'E', marketId: 'M', tokenId: 'T', bid: 0.4, ask: 0.5 }),
      fee({ ts: 1000, marketId: 'M' }),
      sports({ ts: 1000, eventId: 'E' }),
      outcome({ ts: 40_000, marketId: 'M', eventId: 'E', resolvedPrice: 1 }),
    ],
    opportunities: [opp({ id: 'late', ts: 1000 + 20_000, eventId: 'E', marketId: 'M', tokenId: 'T' })],
  });
  const r = evaluateTape(t);
  assert.equal(r.candidate.trades, 0);
  assert.ok(r.dataset.qualityRejections[0].reasons.includes('stale-quote'));
  assert.ok(r.promotion.fail.includes('missing-required-observations') || r.candidate.coverage < 1);
});

test('missing captured fees fail closed and never invent the live 5% default', () => {
  const t = tape({
    observations: [
      quote({ ts: 1000, eventId: 'E', marketId: 'M', tokenId: 'T', bid: 0.4, ask: 0.5 }),
      sports({ ts: 1000, eventId: 'E' }),
      outcome({ ts: 2000, marketId: 'M', eventId: 'E', resolvedPrice: 1 }),
    ],
    opportunities: [opp({ id: 'nofee', ts: 1000, eventId: 'E', marketId: 'M', tokenId: 'T' })],
  });
  const r = evaluateTape(t);
  assert.equal(r.candidate.trades, 0);
  assert.ok(r.dataset.qualityRejections[0].reasons.includes('missing-fees'));
  assert.ok(r.dataset.missingRequiredKinds.includes('fee'));
  assert.equal(r.promotion.eligible, false);
  assert.ok(r.promotion.fail.includes('missing-required-observations'));
});

test('future signal is lookahead and cannot be used at decision time', () => {
  const t = tape({
    observations: [
      quote({ ts: 1000, eventId: 'E', marketId: 'M', tokenId: 'T', bid: 0.4, ask: 0.5 }),
      fee({ ts: 1000, marketId: 'M' }),
      sports({ ts: 1000, eventId: 'E', lastUpdate: 1000 }),
      outcome({ ts: 3000, marketId: 'M', eventId: 'E', resolvedPrice: 1 }),
    ],
    opportunities: [opp({ id: 'future', ts: 1000, eventId: 'E', marketId: 'M', tokenId: 'T', signalTs: 2500 })],
  });
  const r = evaluateTape(t);
  assert.equal(r.candidate.trades, 0);
  assert.ok(r.dataset.qualityRejections[0].reasons.includes('future-signal'));
});

test('thin books partial-fill captured depth and do not invent size', () => {
  const fill = walkAsksForStake([{ price: 0.5, size: 2 }], 10, { feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1 } });
  assert.equal(fill.ok, true);
  assert.equal(fill.partial, true);
  assert.ok(fill.shares <= 2 + 1e-9);
  assert.ok(fill.unfilledUsd > 0);
  const empty = walkAsksForStake([], 10, { feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1 } });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'missing-executable-quote');
});

test('related-event exposure cap blocks a second correlated stake', () => {
  const t = tape({
    maxRelatedEventExposureUsd: 6,
    observations: [
      quote({ ts: 1000, eventId: 'G', marketId: 'M1', tokenId: 'T1', bid: 0.4, ask: 0.5 }),
      quote({ ts: 1000, eventId: 'G', marketId: 'M2', tokenId: 'T2', bid: 0.4, ask: 0.5 }),
      fee({ ts: 1000, marketId: 'M1', rate: 0.01 }),
      fee({ ts: 1000, marketId: 'M2', rate: 0.01 }),
      sports({ ts: 1000, eventId: 'G' }),
      outcome({ ts: 2000, marketId: 'M1', eventId: 'G', resolvedPrice: 1 }),
      outcome({ ts: 2000, marketId: 'M2', eventId: 'G', resolvedPrice: 1 }),
    ],
    opportunities: [
      opp({ id: 'a', ts: 1000, eventId: 'G', marketId: 'M1', tokenId: 'T1', stake: 5 }),
      opp({ id: 'b', ts: 1000, eventId: 'G', marketId: 'M2', tokenId: 'T2', stake: 5 }),
    ],
  });
  const r = evaluateTape(t);
  assert.equal(r.candidate.trades, 1);
  assert.ok(r.candidate.rejections.some(x => x.reasons.includes('related-event-cap')));
});

test('static import fence keeps the evaluator away from live execution and wallets', () => {
  const s = SRC.toLowerCase();
  for (const bad of ["from './polymarket.js'", "from './polymarketus", "from './jupiter", "from './rpc", "from 'ws'", 'fetch(']) {
    assert.equal(s.includes(bad), false, `forbidden ${bad}`);
  }
});

test('promotion stays fail-closed even when the comparison looks clean', () => {
  const gate = promotionDecision({
    dataset: { missingRequiredKinds: ['fee'] },
    candidate: { netPnlUsd: 12, coverage: 1, independentEventCount: 50, unresolved: 0, maxDrawdownUsd: 1, winRatePct: 70, bootstrap: { ciLow: 0.2 } },
    incumbent: { netPnlUsd: 0 },
  });
  assert.equal(gate.eligible, false);
  assert.equal(gate.live, false);
  assert.ok(gate.fail.includes('missing-required-observations'));
});

test('CLI reports are byte-identical for the same test-only tape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-poly-eval-'));
  try {
    const world = favoriteWorld({ n: 4, losses: 1 });
    const tapePath = path.join(dir, 'tape.json');
    fs.writeFileSync(tapePath, JSON.stringify(world));
    const outputs = [];
    for (const iteration of [1, 2]) {
      const out = path.join(dir, `report-${iteration}`);
      const child = spawnSync(process.execPath, [
        fileURLToPath(new URL('../src/polymarketResearchEval.js', import.meta.url)),
        '--tape', tapePath, '--out', out, '--min-events', '20',
      ], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 0, child.stderr);
      outputs.push({ json: fs.readFileSync(out + '.json', 'utf8'), md: fs.readFileSync(out + '.md', 'utf8') });
    }
    assert.deepEqual(outputs[0], outputs[1]);
    const report = JSON.parse(outputs[0].json);
    assert.equal(report.live, false);
    assert.equal(report.researchOnly, true);
    assert.ok(markdownReport(report).includes('Win rate'));
    assert.equal(isMainModule(fileURLToPath(new URL('../src/polymarketResearchEval.js', import.meta.url))), true);
    assert.equal(isMainModule('/not/this/module.js'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
