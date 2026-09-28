import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchMarkets, detectDislocation, proposePairedArbitrage } from '../src/arbitrage.js';

const pair = () => [{ venue: 'polymarket', id: 'p1', event: 'Will ACME win the 2026 final?', outcome: 'Yes', ask: 0.42 }, { venue: 'kalshi', id: 'k1', event: 'Will ACME win the 2026 final?', outcome: 'Yes', ask: 0.48 }];

test('matcher requires the same event and outcome across venues', () => {
  const [a, b] = pair(); assert.equal(matchMarkets(a, b).ok, true);
  assert.equal(matchMarkets(a, { ...b, event: 'Other' }).reason, 'event-mismatch');
  assert.equal(matchMarkets(a, { ...b, outcome: 'No' }).reason, 'outcome-mismatch');
});

test('dislocation signal clears fee and slippage hurdle and orders cheap buy before rich sell', () => {
  const [a, b] = pair(), result = detectDislocation(a, b, { feesBps: 50, slippageBps: 40, bufferBps: 10 });
  assert.equal(result.ok, true); assert.equal(result.legs[0].action, 'BUY'); assert.equal(result.legs[0].venue, 'polymarket'); assert.equal(result.legs[1].action, 'SELL');
  assert.equal(detectDislocation(a, { ...b, ask: 0.421 }, { feesBps: 50 }).reason, 'edge-below-costs');
});

test('every opportunity is logged and paper paired proposals keep both legs together', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-arb-'));
  try {
    const [a, b] = pair(), opportunity = detectDislocation(a, b), state = { proposals: [] };
    const out = proposePairedArbitrage(state, opportunity, { file: path.join(dir, 'arb.ndjson') });
    assert.equal(out.proposal.kind, 'ARBITRAGE_PAIR'); assert.equal(out.proposal.legs.length, 2); assert.equal(out.recorded.type, 'arbitrage-opportunity');
    const blocked = proposePairedArbitrage({ proposals: [] }, opportunity, { mode: 'live', file: path.join(dir, 'arb.ndjson') });
    assert.equal(blocked.proposal, null); assert.equal(fs.readFileSync(path.join(dir, 'arb.ndjson'), 'utf8').trim().split('\n').length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
