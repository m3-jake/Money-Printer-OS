import test from 'node:test';
import assert from 'node:assert/strict';
import { tapeRecords, ReplaySession, runReplay, walkForward, REPLAY_EVALUATOR_VERSION } from '../src/core/replay.js';
import { CoreDatabase } from '../src/core/database.js';
import { StrategyRegistry, promotionCheck, strategyEvidenceIdentity } from '../src/core/strategies.js';

const quote = (t, price) => ({ t, bid: price, ask: price, src: 'robinhood' });
const session = (rows, end) => new ReplaySession(tapeRecords(rows, 'X'), { start: 0, end });

test('candle OHLC path is never executable after close', () => {
  const rows = [
    ...[100, 80, 120, 100].map((price, i) => ({ t: i * 15000, bid: price, ask: price, src: 'coinbase-candles' })),
    ...[80, 70, 130, 100].map((price, i) => ({ t: 60000 + i * 15000, bid: price, ask: price, src: 'coinbase-candles' })),
    ...[100, 100, 100, 100].map((price, i) => ({ t: 120000 + i * 15000, bid: price, ask: price, src: 'coinbase-candles' })),
  ];
  const records = tapeRecords(rows, 'X');
  assert.deepEqual(records.map(r => [r.availableAt, r.bid]), [[60000, 100], [120000, 100], [180000, 100]]);
  const result = runReplay(new ReplaySession(records, { start: 0, end: 180000 }), { key: 'X' });
  assert.equal(result.trades[0].price, 100);
  assert.equal(result.lookAheadViolations, 0);
  assert.equal(result.syntheticShare, 1);
});

test('closed trade return includes entry and exit fees and matches cash', () => {
  const rows = [quote(0, 100), quote(15000, 101), quote(30000, 100), quote(45000, 100), quote(60000, 100)];
  const result = runReplay(session(rows, 60000), { key: 'X', strategy: 'momentum', params: { lookback: 1, thresholdBps: 50 }, feeBps: 100 });
  assert.deepEqual(result.trades.map(t => t.side), ['BUY', 'SELL']);
  const sell = result.trades[1];
  assert.ok(Math.abs(sell.pnl - (result.finalEquity - result.startCash)) < 1e-8);
  assert.ok(Math.abs(sell.ret * 100 - result.returnPct) < 1e-8);
  assert.ok(Math.abs(result.returnPct + 1.9801980198) < 1e-6);
});

test('terminal mark is in drawdown and pending order does not fill at boundary', () => {
  const result = runReplay(session([quote(0, 100), quote(15000, 100), quote(30000, 1)], 30000), { key: 'X' });
  assert.equal(result.trades.length, 1);
  assert.equal(result.openPosition.qty > 0, true);
  assert.ok(Math.abs(result.returnPct + 99) < 1e-9);
  assert.ok(Math.abs(result.maxDrawdownPct - 99) < 1e-9);
  assert.equal(result.curve.at(-1).t, 30000);
});

test('walk-forward predeclares boundary exit and charges terminal fee and slippage', () => {
  const rows = [0, 15000, 30000, 45000, 60000].map(t => quote(t, 100));
  const direct = runReplay(session(rows.slice(0, 3), 30000), { key: 'X', feeBps: 100, slippageBps: 100, liquidateAtEnd: true });
  assert.deepEqual(direct.trades.map(t => t.side), ['BUY', 'SELL']);
  assert.equal(direct.trades[1].decidedAt, 15000);
  assert.equal(direct.trades[1].at, 30000);
  assert.equal(direct.trades[1].boundaryLiquidation, true);
  assert.equal(direct.openPosition, null);
  assert.ok(direct.returnPct < -3);
  const wf = walkForward(tapeRecords(rows, 'X'), { key: 'X', strategy: 'buy-hold', folds: 2, start: 0, end: 60000, feeBps: 100, slippageBps: 100 });
  assert.equal(wf.folds[0].test.boundaryLiquidations, 1);
  assert.equal(wf.evidence.incompleteFolds, 0);
  assert.ok(wf.evidence.outOfSampleNetPct < -3);
});

test('walk-forward counts closed outcomes, not order legs, and keeps boundary positions open', () => {
  const records = tapeRecords(Array.from({ length: 200 }, (_, i) => quote(i * 15000, 100 + Math.sin(i / 2) * 2)), 'X');
  const result = walkForward(records, { key: 'X', strategy: 'momentum', grid: { lookback: [1], thresholdBps: [20] }, start: 0, end: 199 * 15000, folds: 4, feeBps: 10 });
  assert.equal(result.evidence.evaluatorVersion, REPLAY_EVALUATOR_VERSION);
  assert.equal(result.evidence.sampleSize, result.folds.reduce((n, f) => n + f.test.closedTrades, 0));
  assert.ok(result.evidence.sampleSize < result.folds.reduce((n, f) => n + f.test.trades, 0));
  assert.ok(result.evidence.effectiveSampleSize <= result.evidence.sampleSize);
});

test('editable metrics and stale evidence cannot pass promotion', () => {
  const good = { evaluatorVersion: REPLAY_EVALUATOR_VERSION, strategyIdentity: 'a'.repeat(64), sampleSize: 80, effectiveSampleSize: 70, outOfSampleNetPct: 4, costsModeled: true, maxDrawdownPct: 10, positiveFoldShare: .75, lookAheadViolations: 0, syntheticShare: 0, pendingOpenPositions: 0, incompleteFolds: 0, verifiedEvaluatorOutput: true };
  for (const patch of [{ lookAheadViolations: 1 }, { syntheticShare: 1 }, { pendingOpenPositions: 1 }, { evaluatorVersion: 'market-replay.v1' }, { effectiveSampleSize: 2 }, { verifiedEvaluatorOutput: false }])
    assert.equal(promotionCheck('PAPER', { ...good, ...patch }).allowed, false);
  const db = new CoreDatabase(':memory:');
  try {
    const registry = new StrategyRegistry(db);
    const policy = { replayStrategy: 'momentum', parameters: { lookback: 20, thresholdBps: 10 } };
    registry.register({ id: 'x', name: 'X', version: '1', params: policy });
    registry.transition('x', 'BACKTESTING', { reason: 'research' });
    const trusted = { ...good, strategyIdentity: strategyEvidenceIdentity(registry.get('x')) };
    assert.throws(() => registry.transition('x', 'PAPER', { reason: 'editable metrics', evidence: good }), /EVIDENCE_NOT_ATTACHED/);
    const forged = registry.attachEvidence('x', good, 'unverified metrics');
    assert.equal(forged.evidence.verifiedEvaluatorOutput, false);
    assert.equal(forged.checks.PAPER.allowed, false);
    db.db.exec('CREATE TABLE lab_runs(id TEXT PRIMARY KEY,at INTEGER,dataset_fp TEXT,strategy TEXT,params TEXT,result TEXT)');
    const runSummary = evidence => JSON.stringify({ evidence, strategyIdentity: evidence.strategyIdentity, folds: [{ train: { params: policy.parameters, candidates: 1 } }] });
    db.db.prepare('INSERT INTO lab_runs VALUES(?,?,?,?,?,?)').run('sweep',Date.now(),'sweep-fp','walkforward:momentum',JSON.stringify({grid:{lookback:[20,30],thresholdBps:[10]}}),runSummary(trusted));
    assert.equal(registry.attachEvidence('x', { ...trusted, labRunId: 'sweep', datasetFp: 'sweep-fp' }, 'adaptive sweep').checks.PAPER.allowed, false);
    db.db.prepare('INSERT INTO lab_runs VALUES(?,?,?,?,?,?)').run('run',Date.now(),'fp','walkforward:momentum',JSON.stringify({grid:{lookback:[20],thresholdBps:[10]}}),runSummary(trusted));
    const attached = registry.attachEvidence('x', { ...trusted, labRunId: 'run', datasetFp: 'fp' }, 'verified run');
    assert.equal(attached.checks.PAPER.allowed, true);
    registry.transition('x', 'PAPER', { reason: 'verified' });
    assert.throws(() => registry.revise('x', { version: '1', params: { ...policy, parameters: { ...policy.parameters, lookback: 21 } }, reason: 'params' }), /new strategy version/);
    const revised = registry.revise('x', { version: '2', params: policy, reason: 'params' });
    assert.equal(revised.state, 'BACKTESTING');
    assert.deepEqual(revised.evidence, {});
    assert.match(registry.history('x').at(-1).reason, /prior evidence invalidated/);
    assert.throws(() => registry.transition('x', 'PAPER', { reason: 'stale evidence' }), /blocked/);
    assert.equal(registry.attachEvidence('x', { ...trusted, labRunId: 'run', datasetFp: 'fp' }, 'old run after revision').evidence.verifiedEvaluatorOutput, false);
    assert.throws(() => registry.revise('x', { version: '2', feeModelHash: 'fee-v2', reason: 'new fees' }), /new strategy version/);
    const feeRevision = registry.revise('x', { version: '3', feeModelHash: 'fee-v2', dataLineage: 'feed-v2', codeHash: 'code-v2', reason: 'new evaluator assumptions' });
    assert.deepEqual(feeRevision.identity, { codeHash: 'code-v2', dataLineage: 'feed-v2', feeModelHash: 'fee-v2' });
    const freshAt = feeRevision.updatedAt + 1;
    const newer = { ...good, strategyIdentity: strategyEvidenceIdentity(feeRevision) };
    db.db.prepare('INSERT INTO lab_runs VALUES(?,?,?,?,?,?)').run('run-2',freshAt,'fp-2','walkforward:momentum',JSON.stringify({grid:{lookback:[20],thresholdBps:[10]}}),runSummary(newer));
    assert.equal(registry.attachEvidence('x', { ...newer, labRunId: 'run-2', datasetFp: 'fp-2' }, 'fresh run', freshAt + 1).checks.PAPER.allowed, true);
    registry.transition('x', 'PAPER', { reason: 'fresh evidence' }, freshAt + 2);
    assert.equal(registry.attachEvidence('x', good, 'degraded new evidence', freshAt + 3).state, 'BACKTESTING');
    registry.register({ id: 'y', name: 'Y', version: '3', params: policy });
    registry.transition('y', 'BACKTESTING', { reason: 'research' });
    assert.equal(registry.attachEvidence('y', { ...newer, labRunId: 'run-2', datasetFp: 'fp-2' }, 'cross-strategy replay').checks.PAPER.allowed, false);
    registry.register({ id: 'legacy', name: 'Legacy' });
    registry.transition('legacy', 'BACKTESTING', { reason: 'old research' });
    db.db.prepare("UPDATE strategies SET state='PAPER', evidence=? WHERE id='legacy'").run(JSON.stringify({ ...good, evaluatorVersion: 'market-replay.v1' }));
    const reopened = new StrategyRegistry(db);
    assert.equal(reopened.get('legacy').state, 'BACKTESTING');
    assert.deepEqual(reopened.get('legacy').evidence, {});
    assert.match(reopened.history('legacy').at(-1).reason, /Existing evidence invalidated/);
  } finally { db.close(); }
});
