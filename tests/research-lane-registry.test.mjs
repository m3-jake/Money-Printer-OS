import test from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_LANES, getResearchLane, laneStatus, assertPaperOnlyLane } from '../src/researchLaneRegistry.js';

test('registry contains independent Polymarket and Robinhood lanes', () => {
  assert.ok(RESEARCH_LANES.length >= 20);
  assert.notEqual(getResearchLane('polymarket-single-binary'), getResearchLane('robinhood-crypto-spot'));
  assert.equal(getResearchLane('polymarket-combos').readiness, 'NOT_CONFIGURED');
});
test('lane status is explicit and cannot acquire live authority', () => {
  const s = laneStatus('robinhood-options-readonly', { readiness: 'UNAVAILABLE', reason: 'missing-prerequisites' });
  assert.equal(s.readiness, 'UNAVAILABLE');
  assert.equal(s.promotion.live, false);
  assert.throws(() => assertPaperOnlyLane({ promotion: { live: true } }));
});
