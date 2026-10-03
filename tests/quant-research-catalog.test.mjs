import test from 'node:test';
import assert from 'node:assert/strict';
import { queryQuantResearch, quantResearchSummary, QUANT_SHORTLIST } from '../src/quantResearchCatalog.js';
import { getResearchLane } from '../tools/researchLaneRegistry.js';

test('pinned inventory covers both entire source catalogs', () => {
  const s = quantResearchSummary();
  assert.equal(s.total, 5907);
  assert.deepEqual(s.bySource, { specs: 101, vault: 5806 });
  for (const source of s.sources) assert.match(source.commit, /^[a-f0-9]{40}$/);
  const ids = new Set();
  for (let offset = 0; offset < s.total; offset += 100) {
    for (const row of queryQuantResearch({ offset, limit: 100 }).entries) {
      assert.ok(!ids.has(row.id)); ids.add(row.id);
      assert.match(row.sha256, /^[a-f0-9]{64}$/);
      assert.equal(row.executionAllowed, false);
      assert.equal(row.status, 'UNVALIDATED');
    }
  }
  assert.equal(ids.size, s.total);
});

test('search filters compose and pagination is bounded', () => {
  const result = queryQuantResearch({ query: 'momentum', source: 'specs', family: 'momentum', limit: 9999, offset: -10 });
  assert.ok(result.total > 0);
  assert.equal(result.limit, 100);
  assert.equal(result.offset, 0);
  assert.ok(result.entries.every(x => x.source === 'specs' && x.families.includes('momentum')));
  assert.equal(queryQuantResearch({ source: 'nonexistent' }).total, 0);
  assert.equal(queryQuantResearch({ offset: Infinity, limit: 'bad' }).limit, 50);
});

test('shortlist points to known lanes and actual source files without granting admission', () => {
  for (const pick of QUANT_SHORTLIST) {
    assert.ok(getResearchLane(pick.lane));
    assert.ok(queryQuantResearch({ query: pick.id }).entries.some(x => x.id === pick.id));
    assert.equal(pick.paperEligible, false);
    assert.equal(pick.liveActivationAllowed, false);
  }
  const result = queryQuantResearch();
  result.entries[0].executionAllowed = true;
  result.shortlist[0].paperEligible = true;
  assert.equal(queryQuantResearch().entries[0].executionAllowed, false);
  assert.equal(queryQuantResearch().shortlist[0].paperEligible, false);
  assert.equal(result.protocol.automaticLivePromotionAllowed, false);
});
