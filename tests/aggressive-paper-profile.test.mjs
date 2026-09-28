import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { aggressionParams, isAggressivePaper, openLimitFor, operatingProfiles } from '../src/runtime.js';
import { estimateAggressivePaperExecution, estimateRoutedPaperExecution } from '../src/executionSimAggressive.js';
import { learnerThresholds } from '../src/learner.js';

test('profile constants and all risk overrides only activate in paper', () => {
  const p = operatingProfiles.AGGRESSIVE_PAPER;
  assert.equal(p.aggression, 98); assert.equal(p.entryFrequency, 'max'); assert.equal(p.maxOpenPositions, 25);
  assert.deepEqual(p.paperOverrides, { tradeSizeSol: 1, maxPositionSol: 3, maxTotalExposureSol: 10, dailyLossLimitSol: 5 });
  assert.equal(isAggressivePaper({ profile: 'AGGRESSIVE_PAPER' }, 'paper'), true);
  assert.equal(isAggressivePaper({ profile: 'AGGRESSIVE_PAPER' }, 'live'), false);
  assert.equal(openLimitFor({ profile: 'AGGRESSIVE_PAPER' }, 'paper'), 25);
  assert.equal(openLimitFor({ profile: 'AGGRESSIVE_PAPER' }, 'live') <= 3, true);
  assert.deepEqual(aggressionParams(98).maxOpenPositions, 8);
});

test('aggressive estimator is not routed unless explicit aggressive paper mode is active', () => {
  const c = { liq: 100_000, executionScore: 90 }, fallback = () => ({ slippageBps: 80, feeBps: 25 });
  assert.equal(estimateAggressivePaperExecution(c, 1, 200).slippageBps, 31);
  assert.equal(estimateAggressivePaperExecution(c, 1, 200).failurePct, 0);
  const live = estimateRoutedPaperExecution(c, 1, 200, { profile: 'AGGRESSIVE_PAPER' }, 'live', fallback);
  assert.equal(live.selected.slippageBps, 80); assert.equal(live.aggressive, null);
  const paper = estimateRoutedPaperExecution(c, 1, 200, { profile: 'AGGRESSIVE_PAPER' }, 'paper', fallback);
  assert.equal(paper.selected.executionModel, 'AGGRESSIVE_PAPER'); assert.equal(paper.deltaBps, -49);
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /isAggressivePaper/); assert.match(source, /estimateRoutedPaperExecution/);
});

test('strict learner thresholds are byte-identical by default and relaxed only by opt-in', () => {
  assert.deepEqual(learnerThresholds(), { heldOutN: 12, samples: 40, activityPct: 8, monteCarloPassPct: 70, consistencyPct: 50 });
  assert.deepEqual(learnerThresholds({ paperAggressive: true }), { heldOutN: 6, samples: 15, activityPct: 3, monteCarloPassPct: 45, consistencyPct: 30 });
});
