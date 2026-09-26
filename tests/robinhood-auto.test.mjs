// Offline paper-lab integration tests: only mocked Robinhood GET responses, never real funds or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRobinhoodKeyPair } from '../src/robinhoodSigner.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-paper-'));
process.env.MONEY_PRINTER_DATA_DIR=path.join(root,'data');
process.env.ROBINHOOD_AUTOSTART='false';process.env.POLYMARKET_AUTOSTART='false';
process.env.ROBINHOOD_API='https://rh.test';process.env.ROBINHOOD_REAL_ENABLED='false';
process.env.ROBINHOOD_API_KEY='test-only-read-key';process.env.ROBINHOOD_PRIVATE_KEY=generateRobinhoodKeyPair().privateKeyBase64;
const nativeFetch=globalThis.fetch,calls=[];
let time=1700000000000,bid=100,ask=100.1,quoteTime=null,publicUp=false;
globalThis.fetch=async(url,init={})=>{
 const u=new URL(url);calls.push({origin:u.origin,path:u.pathname,method:init.method});
 if(u.origin==='https://api.exchange.coinbase.com'){ // public paper fallback; down unless a test opts in
  assert.equal(init.method,'GET');if(!publicUp)throw Error('public paper feed down in this test');
  const value=/\/book$/.test(u.pathname)?{bids:[['200','1',1]],asks:[['200.1','1',1]],time:new Date(time).toISOString()}:{status:'online',trading_disabled:false,base_increment:'0.00000001',quote_increment:'0.01'};
  return {ok:true,status:200,json:async()=>value};
 }
 assert.equal(u.origin,'https://rh.test');assert.equal(init.method,'GET','No broker writes in paper tests');
 let value;
 if(u.pathname.endsWith('/accounts/'))value={results:[{account_number:'PAPER-TEST-1234',status:'active',buying_power:'500',is_api_tradable:true,fee_tier_status:{fee_ratio:0.0085}}]};
 else if(u.pathname.endsWith('/trading_pairs/'))value={results:u.searchParams.getAll('symbol').map(symbol=>({symbol,asset_code:symbol.split('-')[0],asset_increment:'0.000001',quote_increment:'0.01',max_order_size:'100',min_order_amount:'1',status:'tradable',is_api_tradable:true}))};
 else if(u.pathname.endsWith('/best_bid_ask/'))value={results:u.searchParams.getAll('symbol').map(symbol=>({symbol,bid,ask,...(quoteTime===null?{}:{timestamp:new Date(quoteTime).toISOString()})}))};
 else throw Error('Unexpected mocked read: '+u.pathname);
 return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(value)};
};
const RH=await import('../src/robinhoodAutoTrader.js'),J=await import('../src/robinhoodJournal.js'),TX=await import('../src/robinhoodTransport.js');
const S=await import('../src/robinhoodStrategy.js'),T=await import('../src/robinhoodTape.js');
function reset(){RH.__testing.reset();fs.rmSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true,force:true});fs.mkdirSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true});J.__testing.resetPaper();J.__testing.resetJournal();TX.__testing.resetTransport();TX.__testing.setClock(()=>time);RH.__testing.setClock(()=>time);bid=100;ask=100.1;quoteTime=null;publicUp=false;calls.length=0;process.env.ROBINHOOD_REAL_ENABLED='false'}
test.after(()=>{RH.stopRobinhoodLoops();globalThis.fetch=nativeFetch;fs.rmSync(root,{recursive:true,force:true})});
test('import makes no venue requests; the idle tick is quiet only when always-on collection is off',async()=>{assert.equal(calls.length,0);reset();process.env.ROBINHOOD_COLLECT_QUOTES='false';try{assert.equal((await RH.__testing.tick()).reason,'idle');assert.equal(calls.length,0)}finally{delete process.env.ROBINHOOD_COLLECT_QUOTES}
 reset();const t=await RH.__testing.tick();assert.equal(t.ran,true,'always-on: the tick collects quotes with autopilot off');assert.ok(calls.every(c=>c.method==='GET'));assert.equal(J.loadPaper().autopilot.enabled,false);assert.ok(J.tapeFor(J.loadPaper(),'BTC-USD').length>=1)});
test('paper-only build hard-locks real execution even if the environment requests live mode',async()=>{
 reset();let r=RH.robinhoodReadiness();assert.equal(r.paperOnlyBuild,true);assert.equal(r.execution,'paper-only');assert.equal(r.realEnabled,false);assert.equal(r.sessionArmed,false);
 assert.throws(()=>RH.armRobinhood(true),e=>e.code==='paperOnly');
 process.env.ROBINHOOD_REAL_ENABLED='true';r=RH.robinhoodReadiness();assert.equal(r.realEnabled,false);
 await assert.rejects(RH.placeRobinhoodOrder({symbol:'BTC-USD',usd:10,confirmation:'PLACE REAL CRYPTO ORDER'}),e=>e.code==='paperOnly');
 assert.equal(calls.length,0);
});
test('current official v2 fields map correctly; snapshot masks account and excludes private credentials',async()=>{
 reset();const s=await RH.robinhoodSnapshot();assert.equal(s.account.feeRatio,0.0085);assert.equal(s.account.accountNumber,'****1234');assert.equal(s.quotes[0].bid,100);assert.equal(s.quotes[0].ask,100.1);
 const text=JSON.stringify(s);assert.ok(!text.includes(process.env.ROBINHOOD_API_KEY));assert.ok(!text.includes(process.env.ROBINHOOD_PRIVATE_KEY));assert.equal(s.paper.equityUsd,1000);
});
test('manual paper lifecycle includes both fees, refuses duplicates, and cannot forge qualification provenance',async()=>{
 reset();const {position}=await RH.placeRobinhoodPaperOrder({symbol:'BTC-USD',usd:10,placedBy:'paper-autopilot'});
 assert.equal(position.placedBy,'manual');assert.ok(position.feeUsd>0);assert.ok(position.stopPct>0);assert.ok(position.costUsd<=10);assert.ok(J.loadPaper().cashUsd<1000);
 await assert.rejects(RH.placeRobinhoodPaperOrder({symbol:'BTC-USD',usd:10}),e=>e.code==='duplicate');
 const result=await RH.closeRobinhoodPaperPosition({id:position.id,reason:'take',closedBy:'strategy'});assert.equal(result.position.closedBy,'manual');assert.ok(result.position.pnlUsd<0);assert.equal(J.loadPaper().positions.length,0);assert.equal(J.loadPaper().qualification.closes,0);
 assert.ok(Math.abs(J.loadPaper().cashUsd-(1000+result.position.pnlUsd))<1e-8);assert.ok(calls.every(r=>r.method==='GET'));assert.equal(fs.existsSync(J.JOURNAL_FILE),false);
});
test('simultaneous paper buys serialize; reset is refused while a buy is pending',async()=>{
 reset();const first=RH.placeRobinhoodPaperOrder({symbol:'BTC-USD',usd:10});assert.throws(()=>RH.resetRobinhoodPaper(),e=>e.code==='busy');await assert.rejects(RH.placeRobinhoodPaperOrder({symbol:'ETH-USD',usd:10}),e=>e.code==='busy');await first;assert.equal(J.loadPaper().positions.length,1);
});
test('malformed, crossed and future quotes cannot create paper positions',async()=>{
 // "future" is a minute ahead: a few seconds ahead is clock skew and is accepted (see the next test).
 for(const kind of ['crossed','future','zero']){reset();if(kind==='crossed')ask=99;if(kind==='future')quoteTime=time+60000;if(kind==='zero')bid=0;await assert.rejects(RH.placeRobinhoodPaperOrder({symbol:'BTC-USD',usd:10}));assert.equal(J.loadPaper().positions.length,0)}
});
test('live v2 quirks (a ~1 bp cross, timestamps ~1.1 s ahead) are accepted and taped as robinhood',async()=>{
 // Shape observed from Robinhood on 2026-09-26: bid a hair above ask, server clock ahead of the PC.
 reset();time+=3600000;bid=84024.63;ask=84012.24;quoteTime=time+1100;
 const t=await RH.__testing.tick();assert.equal(t.ran,true,JSON.stringify(t));
 const r=RH.robinhoodReadiness();assert.equal(r.paperQuoteSource,'robinhood');assert.equal(r.paperFallbackReason,null);
 const s=await RH.robinhoodSnapshot();const q=s.quotes.find(x=>x.symbol==='BTC-USD');
 assert.equal(q.bid,84012.24);assert.equal(q.ask,84024.63,'uncrossed: buys pay the higher side');assert.equal(s.lastError,null);
 T.flushTape({force:true,now:time});assert.deepEqual(Object.keys(T.tapeCoverage('BTC-USD',time).sources),['robinhood']);
 assert.ok(calls.every(c=>c.origin==='https://rh.test'),'no public fallback needed');
});
test('Robinhood quotes that fail validation fall back to the public paper book instead of halting',async()=>{
 reset();time+=3600000;ask=99;publicUp=true;
 const t=await RH.__testing.tick();assert.equal(t.ran,true,JSON.stringify(t));
 const r=RH.robinhoodReadiness();assert.equal(r.paperQuoteSource,'coinbase-public-paper');assert.equal(r.paperFallbackReason.code,'badQuotes');
 const {position}=await RH.placeRobinhoodPaperOrder({symbol:'BTC-USD',usd:10});assert.equal(position.quoteSource,'coinbase-public-paper');
 T.flushTape({force:true,now:time});assert.deepEqual(Object.keys(T.tapeCoverage('BTC-USD',time).sources),['coinbase-public-paper']);
});
test('invalid size and non-crypto symbols are rejected',async()=>{reset();for(const usd of [0,-1,NaN,Infinity,100000])await assert.rejects(RH.placeRobinhoodPaperOrder({symbol:'BTC-USD',usd}));await assert.rejects(RH.placeRobinhoodPaperOrder({symbol:'AAPL',usd:10}));assert.equal(J.loadPaper().positions.length,0)});
test('a deterministic breakout enters automatically and a take-profit produces eligible paper evidence',async()=>{
 reset();let seed=7,mid=100;const samples=[];
 for(let i=0;i<200;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;mid*=1+0.004+(seed/4294967296-0.5)*0.02;samples.push([time-(199-i)*15000,mid*0.9995,mid*1.0005])}
 const highest=Math.max(...samples.slice(-91,-1).map(s=>(s[1]+s[2])/2));bid=highest*1.01*0.9995;ask=highest*1.01*1.0005;
 const p=J.defaultPaper();p.params=S.normalizeParams();p.paramsHash=S.paramsHash(p.params);p.autopilot={...p.autopilot,enabled:true,symbols:['BTC-USD'],orderUsd:10};p.tape={'BTC-USD':{samples:samples.slice(0,-1),intervalMs:15000,quoteSource:'v2'}};J.savePaper(p,{force:true});
 const first=await RH.__testing.tick();assert.equal(first.ran,true,JSON.stringify(first));assert.equal(J.loadPaper().positions.length,1);const position=J.loadPaper().positions[0];assert.equal(position.placedBy,'paper-autopilot');
 bid=position.fillPrice*(1+position.takePct+0.01);ask=bid*1.001;time+=15000;const next=await RH.__testing.tick();assert.equal(next.ran,true,JSON.stringify(next));assert.equal(J.loadPaper().positions.length,0);
 const close=J.loadPaper().history[0];assert.equal(close.closedBy,'strategy');assert.equal(close.exit.reason,'take');assert.ok(close.pnlUsd>0);assert.equal(J.loadPaper().qualification.closes,1);assert.equal(J.loadPaper().qualification.qualified,false);
});
test('parameter changes alter the evidence hash without rewriting the history',()=>{reset();const before=RH.__testing.paperFile;const old=J.loadPaper().history;RH.setRobinhoodPaperAutopilot({params:{takeMult:5}});assert.equal(J.loadPaper().paramsHash,S.paramsHash({takeMult:5}));assert.deepEqual(J.loadPaper().history,old);assert.equal(RH.__testing.paperFile,before)});
test('malformed but valid JSON fails closed and reset preserves the real journal',async()=>{
 reset();const j=J.defaultJournal();J.saveJournal(j);const real=fs.readFileSync(J.JOURNAL_FILE,'utf8');fs.writeFileSync(J.PAPER_FILE,JSON.stringify({cashUsd:'bad',positions:[]}));J.__testing.resetPaper();
 assert.equal(J.loadPaper().recoveryRequired,true);await assert.rejects(RH.placeRobinhoodPaperOrder({symbol:'BTC-USD',usd:10}),e=>e.code==='paperRecovery');RH.resetRobinhoodPaper({amountUsd:500});assert.equal(J.loadPaper().cashUsd,500);assert.equal(J.loadPaper().autopilot.enabled,false);assert.equal(fs.readFileSync(J.JOURNAL_FILE,'utf8'),real);
});
test('disk write failure cannot acknowledge a paper fill or leave an optimistic cached balance',async()=>{
 reset();RH.resetRobinhoodPaper();const original=fs.renameSync;try{fs.renameSync=()=>{throw Error('test disk failure')};await assert.rejects(RH.placeRobinhoodPaperOrder({symbol:'BTC-USD',usd:10}))}finally{fs.renameSync=original}
 assert.equal(J.loadPaper().cashUsd,1000);assert.equal(J.loadPaper().positions.length,0);
});
test('future-dated closes do not qualify a strategy',()=>{reset();const p=J.defaultPaper();p.paramsHash='test-hash';p.history=Array.from({length:25},()=>({status:'CLOSED',placedBy:'paper-autopilot',closedBy:'strategy',paramsHash:'test-hash',pnlUsd:1,closedAt:time+10000,feeUsd:0.1,exit:{feeUsd:0.1},costPct:0.01,stopPct:0.01,takePct:0.04}));assert.equal(J.evaluateQualification(p,time).closes,0)});
