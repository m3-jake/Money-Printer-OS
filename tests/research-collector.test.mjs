import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSolanaTicks, filterPolymarketRecords } from '../src/researchCollector.js';

test('Solana evidence collector appends only unseen observed ticks',()=>{
  const state={tickHistory:{MINT:[{ts:100,price:1,liq:1000,v5:10,flow:1.2,score:70,buys:4,sells:2},{ts:200,price:1.1,liq:1100,v5:12,flow:1.4,score:75,buys:5,sells:2}]}};
  const a=collectSolanaTicks(state,{});
  assert.equal(a.rows.length,2);assert.equal(a.cursor.MINT,200);
  assert.equal(a.rows[0].coverage.depth,false);assert.equal(a.rows[0].provenance,'observed-state-tick');
  const b=collectSolanaTicks(state,a.cursor);assert.equal(b.rows.length,0);
});

test('Polymarket collector records observed depth, explicit fee coverage and heartbeat dedupe',()=>{
  const snap={records:[{tokenId:'T1',marketId:'M1',eventId:'E1',gameId:'G1',ts:1000,
    bids:Array.from({length:15},(_,i)=>({price:.5-i*.001,size:10+i})),asks:Array.from({length:15},(_,i)=>({price:.51+i*.001,size:11+i})),
    feeMeta:{feesEnabled:true,feeSchedule:{rate:.05,exponent:1},takerBaseFee:null}}]};
  const a=filterPolymarketRecords(snap,{},10_000);
  assert.equal(a.rows.length,1);assert.equal(a.rows[0].bids.length,10);assert.equal(a.rows[0].asks.length,10);
  assert.equal(a.rows[0].coverage.depth,true);assert.equal(a.rows[0].coverage.costs,true);
  const b=filterPolymarketRecords(snap,{books:a.books},20_000);assert.equal(b.rows.length,0);
  const c=filterPolymarketRecords(snap,{books:a.books},50_001);assert.equal(c.rows.length,1);
});

test('Polymarket collector never invents fee coverage',()=>{
  const snap={records:[{tokenId:'T2',marketId:'M2',eventId:'E2',ts:1000,bids:[{price:.4,size:5}],asks:[{price:.6,size:5}],feeMeta:{feesEnabled:true,feeSchedule:null,takerBaseFee:null}}]};
  const a=filterPolymarketRecords(snap,{},10_000);
  assert.equal(a.rows[0].coverage.costs,false);
});
