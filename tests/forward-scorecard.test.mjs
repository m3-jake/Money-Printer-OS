// Run A8: does a Lab verdict predict forward paper results? Prediction at admission vs realized forward per-bet return.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardScorecard } from '../src/core/forwardScorecard.js';
import { labVariants } from '../src/botFarm.js';
import { paperBotRows } from '../src/scoreboard.js';

const bets = pnls => pnls.map((pnlUsd, i) => ({ pnlUsd, settledAt: 1000 + i }));

test('realized / predicted per-bet return, with n and CI for each; observed bets never count', () => {
  const c = forwardScorecard({ n: 40, meanPerBet: 0.2, ciLo: 0.05, ciHi: 0.35, ciUnit: 'USD per bet', capturedAt: 5 }, [...bets([0.1, 0.1, 0.1, 0.1]), { pnlUsd: 9, observed: true }]);
  assert.equal(c.forward.n, 4); assert.equal(c.forward.meanPerBet, 0.1);
  assert.ok(Math.abs(c.shrinkage - 0.5) < 1e-12, 'forward earned half of what the Lab predicted');
  assert.equal(c.predicted.n, 40); assert.equal(c.predicted.ciUnit, 'USD per bet'); assert.equal(c.predicted.capturedAt, 5);
  assert.equal(c.qualificationEffect, 'NONE');
});

test('gaps stay unknown, never zero', () => {
  const none = forwardScorecard(null, []);
  assert.equal(none.predicted.meanPerBet, null); assert.equal(none.predicted.n, null); assert.equal(none.forward.meanPerBet, null); assert.equal(none.shrinkage, null);
  assert.equal(forwardScorecard({ meanPerBet: 0 }, bets([1])).shrinkage, null, 'no ratio against a zero prediction');
  assert.equal(forwardScorecard({ meanPerBet: 0.1 }, bets([1])).forward.ciLo, null, 'one bet has no CI');
});

test('a Lab farm proposal carries its held-out prediction, stamped when it is admitted', () => {
  const now = Date.UTC(2026, 9, 3, 12);
  const doc = { schema: 'mpo.lab-farm-proposals.v1', at: now - 60e3, variants: [{ id: 'lab-btc-v11', kind: 'btc', label: 'Lab BTC', over: { volMultiple: 1.1 }, at: now - 60e3, paperPromotionAllowed: true,
    evidence: { executionVerified: true, availabilityVerified: true, holdoutConsumedOnce: true, holdout: { n: 40, meanPerBet: 0.12, ciLo: 0.02, ciHi: 0.2 } } }] };
  const [v] = labVariants(doc, now);
  assert.equal(v.prediction.meanPerBet, 0.12); assert.equal(v.prediction.n, 40); assert.equal(v.prediction.capturedAt, now); assert.equal(v.prediction.unit, 'USD');
});

test('the scoreboard row of a Lab variant shows its scorecard; a fixed variant has an unknown prediction', () => {
  const rows = paperBotRows({ farm: { minSettled: 30, lastRun: {}, variants: [
    { id: 'lab-btc-v11', kind: 'btc', label: 'Lab BTC', lab: true, prediction: { n: 40, meanPerBet: 0.12, unit: 'USD' }, history: bets([0.06, 0.06]) },
    { id: 'btc-v100', kind: 'btc', label: 'BTC v100', history: bets([0.3]) }] } }, { now: 2000 });
  const lab = rows.find(r => r.id === 'kalshi-farm-lab-btc-v11'), fixed = rows.find(r => r.id === 'kalshi-farm-btc-v100');
  assert.ok(Math.abs(lab.forwardScorecard.shrinkage - 0.5) < 1e-9);
  assert.equal(fixed.forwardScorecard.predicted.meanPerBet, null); assert.equal(fixed.forwardScorecard.shrinkage, null);
});
