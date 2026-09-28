import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchMarkets, detectDislocation, proposePairedArbitrage, normalizeKalshiBook, scanArbitrageBooks, settlePairedArbitrage } from '../src/arbitrage.js';

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

test('uses executable asks and bids and normalizes Kalshi cents into contract prices',()=>{
 const a={venue:'polymarket',id:'p',event:'Final',outcome:'Yes',ask:.4,bid:.38},b={venue:'kalshi',id:'k',event:'Final',outcome:'Yes',yes_ask:45,yes_bid:43};
 const rows=scanArbitrageBooks({polymarket:[a],kalshi:[b],feesBps:100});
 assert.equal(rows[0].legs[0].venue,'polymarket');assert.equal(rows[0].legs[1].price,.43);
 assert.ok(Math.abs(rows[0].grossEdgeBps-750)<1e-8);assert.equal(normalizeKalshiBook(b).ask,.45);
 assert.equal(detectDislocation({...a,ask:.44},{...b,yes_bid:43}).ok,false);
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

test('paired paper settlement fills both legs together or cancels both', () => {
  const [a,b]=pair(), opportunity=detectDislocation(a,b), proposal={kind:'ARBITRAGE_PAIR',status:'PENDING',legs:opportunity.legs.map(x=>({...x,status:'PENDING'}))};
  const filled=settlePairedArbitrage(proposal,[{ok:true,price:.42,fee:.001},{ok:true,price:.47,fee:.001}],1234);
  assert.equal(filled.ok,true);assert.equal(filled.proposal.status,'FILLED');assert.deepEqual(filled.proposal.legs.map(x=>x.status),['FILLED','FILLED']);
  const cancelled=settlePairedArbitrage({...proposal,legs:proposal.legs.map(x=>({...x}))},[{ok:true,price:.42},{ok:false}],2345);
  assert.equal(cancelled.ok,false);assert.equal(cancelled.proposal.status,'CANCELLED');assert.deepEqual(cancelled.proposal.legs.map(x=>x.status),['CANCELLED','CANCELLED']);
});
