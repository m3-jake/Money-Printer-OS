import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketPlatform } from '../src/core/platform.js';
import { newPracticeBook } from '../src/robinhoodPractice.js';
import { practiceMirrorMarks } from '../src/core/legacyMarks.js';
import { fetchPublicPaperQuote } from '../src/robinhoodPaperFeed.js';
const now=Date.UTC(2026,8,28,8,40);
const quote={symbol:'ETH-USD',bid:1980,ask:1981,bidSize:10,askSize:20,at:now-1000,venueAt:now-1000,receivedAt:now,timeQuality:'VENUE_TIME',depthQuality:'OBSERVED_L1',auctionMode:false,source:'coinbase-public-paper'};
function fixture(){
  const p=new MarketPlatform(),book=newPracticeBook({now:now-10000});
  book.positions=[{id:'eth-position',symbol:'ETH-USD',status:'OPEN',qty:.05,costUsd:100,entryPrice:2000,openedAt:now-5000,placedBy:'practice-autopilot'}];
  book.cashUsd=400;book.telemetry.lastQuotes={'ETH-USD':{...quote}};
  p.setLegacyReaders({robinhoodPracticeBook:()=>book});p.syncLegacyLedger();
  return {p,book};
}

test('fresh observed practice depth supplies conservative after-cost marks without changing ledger or calling a provider',()=>{
  const {p,book}=fixture();
  try{
    const ledger=p.ledger.entries(),before=JSON.stringify(book),r=p.risk.state(now);
    assert.equal(r.state,'GREEN');assert.equal(r.metrics.complete,true);assert.ok(r.metrics.equityUsd<400+.05*1980);assert.ok(r.metrics.equityUsd>490);
    assert.equal(p.practiceMarkSync.additionalProviderCalls,0);assert.equal(p.practiceMarkSync.marks,1);
    assert.deepEqual(p.ledger.entries(),ledger);assert.equal(JSON.stringify(book),before);
    const changes=p.store.db.prepare('SELECT total_changes() n').get().n;p.risk.state(now);
    assert.equal(p.store.db.prepare('SELECT total_changes() n').get().n,changes,'identical marks do not write repeatedly');
  }finally{p.close();}
});
test('missing, stale, future, indicative and shallow practice books remain fail-closed; only affected marks clear',()=>{
  for(const patch of [{bidSize:null},{at:now-16000},{at:now+1000},{auctionMode:true},{timeQuality:'UNKNOWN'},{source:'synthetic'},{bidSize:.001}]){
    const {p,book}=fixture();try{
      assert.equal(p.risk.state(now).state,'GREEN');Object.assign(book.telemetry.lastQuotes['ETH-USD'],patch);
      const r=p.risk.state(now);assert.equal(r.state,'RED');assert.ok(r.stateReasons.includes('UNKNOWN_LOSS_STATE'));assert.equal(r.metrics.equityUsd,null);assert.ok(p.practiceMarkSync.issues.length);
    }finally{p.close();}
  }
});

test('changed practice positions or recovery state cannot lend an old mark to an unreconciled book',()=>{
  for(const mutate of [b=>b.cashUsd+=1,b=>b.positions[0].qty*=2,b=>b.positions[0].id='other',b=>b.recoveryRequired=true]){
    const {p,book}=fixture();try{p.risk.state(now);mutate(book);assert.equal(p.risk.state(now).state,'RED');assert.equal(p.practiceMarkSync.marks,0);}finally{p.close();}
  }
});

test('L1 liquidity is shared across instruments for the same asset instead of duplicated',()=>{
  const {p,book}=fixture();try{
    book.positions.push({...book.positions[0],id:'second-position'});book.cashUsd-=100;p.syncLegacyLedger();
    book.telemetry.lastQuotes['ETH-USD'].bidSize=.075;
    const row=p.store.db.prepare('SELECT * FROM legacy_sync WHERE source=?').get('robinhood-practice');
    const result=practiceMirrorMarks(book,p.ledger.portfolio(),row,{now});assert.equal(result.marks.length,2);
    assert.ok(Math.abs(result.marks.reduce((s,m)=>s+m.quantity,0)-.075)<1e-10);assert.equal(p.risk.state(now).state,'RED');
  }finally{p.close();}
});
test('public-book adapter preserves size and future timestamps rather than manufacturing freshness',async()=>{
  const q=await fetchPublicPaperQuote('ETH-USD',{now:()=>now,fetchFn:async(url,init)=>{assert.equal(init.method,'GET');assert.match(url,/book\?level=1/);return {ok:true,json:async()=>({bids:[['1980','0.5',12]],asks:[['1981','1',8]],time:new Date(now+5000).toISOString()})};}});
  assert.equal(q.bidSize,.5);assert.equal(q.askSize,1);assert.equal(q.at,now+5000);assert.equal(q.receivedAt,now);assert.equal(q.timeQuality,'FUTURE_VENUE_TIME');assert.equal(q.depthQuality,'OBSERVED_L1');
});

test('a reader exception invalidates the practice mark without taking down the whole dashboard',()=>{
  const {p}=fixture();try{
    p.risk.state(now);p.setLegacyReaders({robinhoodPracticeBook:()=>{throw Error('fixture read failure');}});
    const r=p.risk.state(now);assert.equal(r.state,'RED');assert.equal(p.practiceMarkSync.status,'UNAVAILABLE');assert.equal(p.practiceMarkSync.marks,0);
  }finally{p.close();}
});

test('a slightly future venue clock remains blocked until reached, then can be used without rewriting either timestamp',()=>{
  const {p,book}=fixture();try{
    const q=book.telemetry.lastQuotes['ETH-USD'];q.at=now+500;q.venueAt=q.at;q.receivedAt=now;q.timeQuality='FUTURE_VENUE_TIME';
    assert.equal(p.risk.state(now).state,'RED');assert.equal(p.risk.state(now+1000).state,'GREEN');
    assert.equal(q.at,now+500);assert.equal(q.receivedAt,now);assert.equal(q.timeQuality,'FUTURE_VENUE_TIME');
    assert.equal(p.risk.state(now+16000).state,'RED','receipt expiry still blocks use even after the venue clock catches up');
  }finally{p.close();}
});

test('old receipt times and mismatched quote symbols cannot masquerade as a fresh position mark',()=>{
  for(const patch of [{receivedAt:now-30000},{receivedAt:now+1000},{symbol:'BTC-USD'},{venueAt:now-2000}]){
    const {p,book}=fixture();try{Object.assign(book.telemetry.lastQuotes['ETH-USD'],patch);assert.equal(p.risk.state(now).state,'RED');assert.equal(p.practiceMarkSync.marks,0);}finally{p.close();}
  }
});
