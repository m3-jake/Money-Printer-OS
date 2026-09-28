import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Keypair } from '@solana/web3.js';
import { finite, tradeRows } from '../src/analytics/shared.js';
import { qualificationMetrics, qualifiesForLivePromotion } from '../src/paperQualification.js';
import { simulateAggressivePaperExecution } from '../src/executionSimAggressive.js';
import { startTrackedWalletStream } from '../src/walletTracker.js';
const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('baseline fills retain configured friction and stream logs have one bounded owner', () => {
  assert.match(source,/simulatePumpPaperExecution\(pick,initialSize,Number\(s.market\?\.solUsd\|\|0\),cfg.simulatedSlippageBps,cfg.simulatedFeeBps/);
  assert.doesNotMatch(source,/simulatePumpPaperExecution\(pick,initialSize[^;]+execModel.slippageBps/);
  assert.doesNotMatch(source,/startProgramStream\(event => \{\s*appendJournal\(event\)/);
  assert.match(source,/if\(!flowSnapshot.cached\)/);
  assert.match(source,/p.paperExecution\?\.model==='AGGRESSIVE_PAPER_V1'\?simulateAggressivePaperExecution\(candidate,clipSize/);
});

test('aggressive fills expose the USD price used by position accounting', () => {
  const sim=simulateAggressivePaperExecution({mint:'test',priceUsd:2,priceObservedAt:1000,liq:1000000,executionScore:99},.1,150,{now:1000,seed:'price'});
  assert.notEqual(sim.status,'REJECTED'); assert.ok(sim.fillPriceUsd>2);
  assert.ok(Math.abs(sim.fillPriceUsd-sim.fillPrice*150)<1e-10);
});

test('missing numbers never turn into fabricated zero profit', () => {
  for(const x of [null,undefined,'',false]) assert.equal(finite(x),null);
  assert.equal(tradeRows([{pnl:null,closedAt:1000}]).length,0);
  assert.equal(finite(0),0);
});
test('qualification rejects future trades, missing evidence and cancellation of signed gaps', () => {
  const rows=[{strategy:'A',closedAt:1000,pnlSol:.1,returnPct:10,replayPnl:null,shadowDivergenceBps:null},{strategy:'A',closedAt:2000,pnlSol:.2,returnPct:20}];
  const m=qualificationMetrics('A',rows,{now:1500}); assert.equal(m.sampleCount,1); assert.equal(m.replayExpectancy,null);
  const q=qualifiesForLivePromotion('A',rows,{now:3000,minSamples:1,minDays:0,minSharpe:0});
  assert.equal(q.ok,false); for(const reason of ['marked-equity-evidence-missing','replay-evidence-missing','shadow-evidence-missing'])assert.ok(q.reasons.includes(reason));
  assert.equal(qualificationMetrics('A',rows.map((r,i)=>({...r,shadowDivergenceBps:i?-500:500})),{now:3000}).shadowGapBps,500);
});

test('wallet subscriptions map request IDs correctly after reconnect and an RPC read', async () => {
  const sockets=[],wallet=Keypair.generate().publicKey.toBase58(); let reads=0;
  class Socket extends EventEmitter { constructor(){super();this.sent=[];sockets.push(this);} send(x){this.sent.push(JSON.parse(x));} close(){} }
  const stream=startTrackedWalletStream(()=>{}, {wallets:[wallet],url:'http://local.invalid',WebSocketImpl:Socket,reconnectMs:1,fetcher:async()=>{reads++;return {ok:true,json:async()=>({result:null})};}});
  const notify=(socket,subscription,signature)=>socket.emit('message',JSON.stringify({method:'logsNotification',params:{subscription,result:{value:{signature,logs:[]}}}}));
  try {
    sockets[0].emit('open'); sockets[0].emit('message',JSON.stringify({id:sockets[0].sent[0].id,result:10})); notify(sockets[0],10,'first');
    await new Promise(r=>setTimeout(r,5)); assert.equal(reads,1); sockets[0].emit('close');
    for(let i=0;i<50&&sockets.length<2;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(sockets.length,2); sockets[1].emit('open'); assert.ok(sockets[1].sent[0].id>1);
    sockets[1].emit('message',JSON.stringify({id:sockets[1].sent[0].id,result:20})); notify(sockets[1],20,'second');
    await new Promise(r=>setTimeout(r,5)); assert.equal(reads,2);
  } finally { stream.close(); }
});

test('slow shadow quotes do not block trading or start overlapping collectors', async () => {
  const {scheduleShadowTick}=await import('../src/shadowCollector.js');
  let finish, calls=0; const platform={}, runner=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  assert.equal(scheduleShadowTick(platform,{},'live',runner).enabled,false); assert.equal(calls,0);
  assert.equal(scheduleShadowTick(platform,{},'paper',runner).collecting,true);
  await Promise.resolve(); assert.equal(calls,1);
  assert.equal(scheduleShadowTick(platform,{},'paper',runner).collecting,true); assert.equal(calls,1);
  finish({observations:3,ordersSubmitted:0}); await new Promise(r=>setImmediate(r));
  const view=scheduleShadowTick(platform,{},'paper',()=>Promise.resolve({cached:true})); assert.equal(view.observations,3);
  assert.doesNotMatch(source,/await runShadowTick/);
});
