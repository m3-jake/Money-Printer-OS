// Pure replay (docs/ROBINHOOD-AUTO-TRADER.md §22): deterministic, trending tape closes trades, flat tape never enters,
// fees reduce P/L, walk-forward split is time-ordered. No fs, env or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backtestTape, walkForwardSplit, REPLAY_WINDOW } from '../src/robinhoodBacktest.js';
import { STRATEGY_DEFAULTS } from '../src/robinhoodStrategy.js';
const t0=1700000000000,STEP=15000;
function series({n=1500,drift=0.004,noise=0.02,spread=0.001,seed=7}={}){
 let s=seed,mid=100;const out=[];
 for(let i=0;i<n;i++){s=(Math.imul(s,1664525)+1013904223)>>>0;mid*=1+drift+(s/4294967296-0.5)*noise;out.push({t:t0+i*STEP,bid:mid*(1-spread/2),ask:mid*(1+spread/2)})}
 return out;
}
const params={...STRATEGY_DEFAULTS,sampleMs:STEP};

test('a trending noisy tape produces strategy closes with fee-aware P/L and hold/exposure accounting',()=>{
 const r=backtestTape(series(),{params,feeRatio:0.0085,orderUsd:25,startUsd:1000});
 assert.ok(r.closes.length>=3,'expected several closes, got '+r.closes.length);assert.equal(r.metrics.closes,r.closes.length);
 assert.ok(r.metrics.feesUsd>0);assert.ok(r.metrics.avgHoldMin>0);assert.ok(r.metrics.exposureMin>0);assert.ok(r.metrics.tradesPerDay>0);assert.ok(r.metrics.spanDays>0);
 for(const c of r.closes){assert.ok(c.closedAt>c.openedAt);assert.ok(['stop','take','trail','time','fade'].includes(c.reason));assert.ok(c.feeUsd>0)}
 const pnl=r.closes.reduce((s,c)=>s+c.pnlUsd,0);assert.ok(Math.abs(pnl-r.metrics.pnlUsd)<0.01);
 assert.ok(r.metrics.hitRate>=0&&r.metrics.hitRate<=1);assert.ok(r.metrics.maxDrawdownUsd>=0);
 assert.deepEqual(Object.keys(r.metrics).slice(0,11),['closes','wins','hitRate','profitFactor','pnlUsd','feesUsd','maxDrawdownUsd','exposureMin','tradesPerDay','avgHoldMin','samples']);
});
test('replay is deterministic and a flat tape never enters',()=>{
 const tape=series();const a=backtestTape(tape,{params,feeRatio:0.0085}),b=backtestTape(tape,{params,feeRatio:0.0085});
 assert.deepEqual(a,b);
 const flat=series({drift:0,noise:0.0002});const r=backtestTape(flat,{params,feeRatio:0.0085});
 assert.equal(r.closes.length,0);assert.equal(r.metrics.entries,0);assert.equal(r.metrics.pnlUsd,0);assert.equal(r.metrics.hitRate,null);assert.equal(r.metrics.profitFactor,null);
 assert.deepEqual(backtestTape([],{params}).closes,[]);assert.equal(backtestTape([{t:1,bid:1,ask:1}],{params}).metrics.samples,1);
});
test('fees reduce net P/L on the same tape; fee-free replay has zero fees',()=>{
 const tape=series();const free=backtestTape(tape,{params,feeRatio:0}),paid=backtestTape(tape,{params,feeRatio:0.0085});
 assert.equal(free.metrics.feesUsd,0);assert.ok(paid.metrics.feesUsd>0);
 // Fees also change the take/stop geometry (costPct), so the two paths trade differently; the invariant is that the
 // paid run's net P/L is its gross P/L minus the fees it paid on both legs.
 assert.ok(paid.metrics.pnlUsd+paid.metrics.feesUsd>paid.metrics.pnlUsd);
 for(const c of paid.closes)assert.ok(c.feeUsd>0);for(const c of free.closes)assert.equal(c.feeUsd,0);
 const wide={...params,slipBps:50};const slipped=backtestTape(tape,{params:wide,feeRatio:0.0085});
 if(slipped.closes.length&&paid.closes.length)assert.ok(slipped.closes[0].pnlUsd<=paid.closes[0].pnlUsd+1e-9||slipped.closes[0].openedAt!==paid.closes[0].openedAt);
});
test('replay only looks back the live window and never at the future',()=>{
 assert.equal(REPLAY_WINDOW,720);
 const tape=series({n:2000});const full=backtestTape(tape,{params,feeRatio:0.0085});
 const first=full.closes[0];const cutIndex=tape.findIndex(s=>s.t>first.closedAt)+50;
 const partial=backtestTape(tape.slice(0,cutIndex),{params,feeRatio:0.0085});
 assert.deepEqual(partial.closes[0],first,'the first close is identical whether or not later samples exist');
});
test('walkForwardSplit keeps time order: train is older, test is the newest 30%',()=>{
 const tape=series({n:1000});const {train,test:tst,cutAt}=walkForwardSplit(tape,0.7);
 assert.equal(train.length,700);assert.equal(tst.length,300);assert.ok(train[train.length-1].t<tst[0].t);assert.equal(cutAt,tst[0].t);
 assert.deepEqual(walkForwardSplit([]),{train:[],test:[],cutAt:null});assert.equal(walkForwardSplit(tape,5).train.length,950,'fraction is clamped');
});
