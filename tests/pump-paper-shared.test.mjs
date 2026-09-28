import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatePumpPaperExecution } from '../src/executionSim.js';
import { simulatePaperExit } from '../src/positionExecution.js';

const candidate=(now,patch={})=>({mint:'Mint111111',symbol:'TEST',priceUsd:.002,priceObservedAt:now,liq:250000,executionScore:100,micro:{},priceAccel:0,...patch});

test('Pump PAPER entry uses shared depth/friction engine and never idealized mid',()=>{
 const now=1000000,c=candidate(now),r=simulatePumpPaperExecution(c,.02,200,80,25,{now,seed:'pump-entry-test'});
 assert.equal(r.mode,'PAPER');assert.equal(r.status,'FILLED');assert.equal(r.executionModel,'shared-paper-core-v3-budget');
 assert.ok(r.fillPriceUsd>c.priceUsd);assert.ok(r.gross>0);assert.ok(r.feeSol>0);assert.ok(r.latencyMs>=100);
});

test('Pump PAPER rejects stale quotes and uneconomical tiny buys',()=>{
 const now=1000000;
 assert.equal(simulatePumpPaperExecution(candidate(now,{priceObservedAt:now-31000}),.02,200,80,25,{now,seed:'stale'}).reason,'stale-market');
 assert.equal(simulatePumpPaperExecution(candidate(now),.004,200,80,25,{now,seed:'tiny'}).reason,'below-min-notional');
});

test('Pump PAPER partial fills are tunable and deterministic',()=>{
 const keys=['MPO_PAPER_PUMPFUN_PARTIAL_PROBABILITY','MPO_PAPER_PUMPFUN_PARTIAL_MIN_FRACTION','MPO_PAPER_PUMPFUN_PARTIAL_MAX_FRACTION','MPO_PAPER_PUMPFUN_REJECT_PROBABILITY'];
 const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  process.env.MPO_PAPER_PUMPFUN_PARTIAL_PROBABILITY='1';process.env.MPO_PAPER_PUMPFUN_PARTIAL_MIN_FRACTION='.5';
  process.env.MPO_PAPER_PUMPFUN_PARTIAL_MAX_FRACTION='.5';process.env.MPO_PAPER_PUMPFUN_REJECT_PROBABILITY='0';
  const now=1000000,a=simulatePumpPaperExecution(candidate(now),.02,200,80,25,{now,seed:'half'}),b=simulatePumpPaperExecution(candidate(now),.02,200,80,25,{now,seed:'half'});
  assert.deepEqual(a,b);assert.equal(a.status,'PARTIAL');assert.ok(Math.abs(a.fillRatio-.5)<1e-9);
 }finally{for(const k of keys)before[k]===undefined?delete process.env[k]:process.env[k]=before[k]}
});

test('Pump PAPER exit maps partial execution back to cost basis',()=>{
 const now=1000000,p={id:'p1',mint:'Mint111111',symbol:'TEST',sizeSol:.02,remainingSol:.02,entryPrice:.0015,lastPrice:.002,lastLiquidityUsd:250000,executionScore:100,lastMicro:{},lastPriceAccel:0};
 const r=simulatePaperExit(p,{priceUsd:.002,priceObservedAt:now,liquidity:{usd:250000}},200,80,25,.5,{now,seed:'exit'});
 assert.equal(r.mode,'PAPER');assert.ok(['FILLED','PARTIAL'].includes(r.status));assert.ok(r.filledBasisSol>0&&r.filledBasisSol<=.01+1e-12);
});
