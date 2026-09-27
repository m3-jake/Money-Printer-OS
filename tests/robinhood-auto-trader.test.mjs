// Lifecycle suite (docs/ROBINHOOD-AUTO-TRADER.md §8-§10, §14 D, §21) against the offline mock: place -> reconcile -> close,
// limit TTL cancel, never-received rule, cancel without arm, real autopilot round trip, Bitcoin-primary weighting, signal enum.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRobinhoodKeyPair } from '../src/robinhoodSigner.js';
import { createRobinhoodMock } from './helpers/robinhoodMock.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-auto-trader-'));
process.env.MONEY_PRINTER_DATA_DIR=path.join(root,'data');
process.env.ROBINHOOD_AUTOSTART='false';process.env.POLYMARKET_AUTOSTART='false';process.env.ROBINHOOD_API='https://rh.test';
const KEYS={apiKey:'rh-api-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',seed:generateRobinhoodKeyPair().privateKeyBase64};
process.env.ROBINHOOD_API_KEY=KEYS.apiKey;process.env.ROBINHOOD_PRIVATE_KEY=KEYS.seed;process.env.ROBINHOOD_REAL_ENABLED='true';
const nativeFetch=globalThis.fetch;
const RH=await import('../src/robinhoodAutoTrader.js'),J=await import('../src/robinhoodJournal.js'),TX=await import('../src/robinhoodTransport.js'),S=await import('../src/robinhoodStrategy.js');
const mock=createRobinhoodMock({journalFile:J.JOURNAL_FILE});globalThis.fetch=mock.fetch;
const PHRASE='PLACE REAL CRYPTO ORDER',AP_PHRASE='ENABLE REAL CRYPTO AUTOPILOT';
const SIGNALS=['WARMUP','STALE','WAIT','SPREAD','NO-TREND','BREAKOUT','LONG'];
function reset(){RH.__testing.reset();RH.__testing.unlockRealExecutionForTests(true);fs.rmSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true,force:true});fs.mkdirSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true});TX.__testing.resetTransport();TX.__testing.setClock(()=>mock.state.time);RH.__testing.setClock(()=>mock.state.time);mock.calls.length=0;mock.state.orders.clear();mock.state.placeMode='filled';mock.state.cancelMode='immediate';mock.state.network='up';mock.state.bid=100;mock.state.ask=100.1;mock.state.time=1700000000000;
 Object.assign(process.env,{ROBINHOOD_API_KEY:KEYS.apiKey,ROBINHOOD_PRIVATE_KEY:KEYS.seed,ROBINHOOD_REAL_ENABLED:'true'});for(const k of ['ROBINHOOD_MAX_ORDER_USD','ROBINHOOD_PRIMARY_ORDER_MULT','ROBINHOOD_PRIMARY_SYMBOL','ROBINHOOD_PRIMARY_WEIGHT','ROBINHOOD_SYMBOLS'])delete process.env[k]}
const count=(j=J.loadJournal())=>j.open.length+j.history.length;
const qualify=()=>{const p=J.loadPaper();p.params=S.normalizeParams({sampleMs:RH.__testing.TICK_MS});p.paramsHash=S.paramsHash(p.params);p.history=Array.from({length:25},(_,i)=>({id:'rp'+i,symbol:'BTC-USD',status:'CLOSED',placedBy:'paper-autopilot',closedBy:'strategy',paramsHash:p.paramsHash,pnlUsd:1,feeUsd:0.1,exit:{feeUsd:0.1,reason:'take'},costUsd:10,costPct:0.0185,stopPct:0.0185,takePct:0.074,closedAt:mock.state.time-i*60000}));J.savePaper(p,{force:true})};
function breakoutTape(symbol='BTC-USD'){
 let seed=7,mid=100;const samples=[];
 for(let i=0;i<200;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;mid*=1+0.004+(seed/4294967296-0.5)*0.02;samples.push([mock.state.time-(199-i)*15000,mid*0.9995,mid*1.0005])}
 const highest=Math.max(...samples.slice(-91,-1).map(s=>(s[1]+s[2])/2));const bid=highest*1.01*0.9995,ask=highest*1.01*1.0005;samples[199]=[mock.state.time,bid,ask];
 const p=J.loadPaper();p.tape={...p.tape,[symbol]:{samples,intervalMs:15000,quoteSource:'v2'}};J.savePaper(p,{force:true});mock.state.bid=bid;mock.state.ask=ask;return {bid,ask};
}
test.after(()=>{RH.stopRobinhoodLoops();globalThis.fetch=nativeFetch;fs.rmSync(root,{recursive:true,force:true})});

test('place -> reconcile (mark) -> sell -> CLOSED books fee-aware P/L, cooldown and keeps open+history count',async()=>{
 reset();RH.armRobinhood(true);
 const preview=await RH.previewRobinhoodOrder({symbol:'BTC-USD',usd:10});
 assert.deepEqual(Object.keys(preview.gates),['stateRecovery','credentials','realEnabled','armed','orderCap','openCap','dailyLossCap','cooldown','duplicate','qualified']);
 assert.equal(preview.wouldPass,true);assert.equal(preview.gates.qualified,false);assert.equal(preview.primary,true);assert.equal(RH.__testing.lastPreview.symbol,'BTC-USD');assert.equal(mock.writes().length,0);
 const placed=await RH.placeRobinhoodOrder({symbol:'BTC-USD',usd:10,confirmation:PHRASE});
 assert.equal(placed.entry.status,'OPEN');assert.equal(placed.entry.avgPrice,100.1);assert.ok(placed.entry.feeUsd>0);assert.equal(placed.journal.unverified,0);assert.equal(count(),1);
 mock.state.bid=110;mock.state.ask=110.1;mock.state.time+=20000;
 const rec=await RH.reconcileRobinhood({force:true});assert.equal(rec.ran,true);assert.equal(rec.checked,1);
 const marked=J.loadJournal().open[0];assert.equal(marked.markBid,110);assert.ok(marked.unrealizedUsd>0);
 const sold=await RH.placeRobinhoodOrder({entryId:placed.entry.id,side:'sell',confirmation:PHRASE});
 assert.equal(sold.entry.status,'CLOSED');assert.equal(sold.entry.exit.reason,'manual');assert.ok(sold.entry.exit.filledQty>0);assert.ok(sold.entry.fillVerified);
 const expected=sold.entry.exit.proceedsUsd-placed.entry.costUsd;assert.ok(Math.abs(sold.entry.pnlUsd-expected)<1e-9);assert.ok(sold.entry.pnlUsd>0);
 const j=J.loadJournal();assert.equal(j.open.length,0);assert.equal(j.history.length,1);assert.equal(count(j),1);assert.equal(j.stats.closed,1);assert.equal(j.stats.won,1);assert.ok(j.cooldowns['BTC-USD']>mock.state.time);
 assert.ok(J.realizedTodayUsd(j,mock.state.time)>0);const sellPost=mock.writes().at(-1);assert.equal(sellPost.body.side,'sell');assert.equal(sellPost.body.client_order_id,sold.entry.exit.clientOrderId);
});
test('limit buy rests as SUBMITTED, is cancelled by reconcile after ENTRY_TTL and moves to CANCELLED only once verified',async()=>{
 reset();RH.armRobinhood(true);mock.state.placeMode='open';mock.state.cancelMode='deferred';
 const r=await RH.placeRobinhoodOrder({symbol:'ETH-USD',usd:10,orderType:'limit',confirmation:PHRASE});
 assert.equal(r.entry.status,'SUBMITTED');assert.ok(r.entry.orderId);assert.ok(r.entry.limitPrice>=100.1);assert.equal(mock.writes()[0].body.limit_order_config.limit_price,String(r.entry.limitPrice));
 mock.state.time+=RH.__testing.ENTRY_TTL_MS-1000;await RH.reconcileRobinhood({force:true});assert.equal(J.loadJournal().open[0].status,'SUBMITTED');assert.equal(mock.writes().filter(c=>c.path.endsWith('/cancel/')).length,0);
 mock.state.time+=2000;await RH.reconcileRobinhood({force:true});assert.equal(mock.writes().filter(c=>c.path.endsWith('/cancel/')).length,1);assert.equal(J.loadJournal().open[0].status,'SUBMITTED','status changes only when the cancel is verified');
 mock.state.orders.get(r.entry.orderId).state='canceled';mock.state.time+=5000;await RH.reconcileRobinhood({force:true});
 const j=J.loadJournal();assert.equal(j.open.length,0);assert.equal(j.history[0].status,'CANCELLED');assert.equal(j.history[0].pnlUsd,null);assert.equal(count(j),1);
});
test('never-received rows survive lagging listings and fail only after 3 successful listings over 10 minutes; auth errors never transition',async()=>{
 reset();RH.armRobinhood(true);mock.state.placeMode='network';
 await assert.rejects(RH.placeRobinhoodOrder({symbol:'BTC-USD',usd:10,confirmation:PHRASE}),e=>e.code==='uncertain');
 const id=J.loadJournal().open[0].id;
 for(let i=0;i<3;i++){mock.state.time+=60000;await RH.reconcileRobinhood({force:true});assert.equal(J.loadJournal().open[0].status,'SUBMITTED_UNCERTAIN');assert.equal(J.loadJournal().open[0].reconcile.successfulListings,i+1)}
 mock.state.placeMode='reject401';process.env.ROBINHOOD_API_KEY='rh-api-wrong-key-0000-0000-000000000000';
 const origFetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{if(String(url).includes('/orders/'))return {ok:false,status:401,headers:{get:()=>null},text:async()=>'{"detail":"API key not found"}'};return origFetch(url,init)};
 mock.state.time+=60000;const bad=await RH.reconcileRobinhood({force:true});globalThis.fetch=origFetch;process.env.ROBINHOOD_API_KEY=KEYS.apiKey;
 assert.equal(bad.errors.some(e=>e.code==='keyNotFound'),true);assert.equal(J.loadJournal().open[0].status,'SUBMITTED_UNCERTAIN');assert.equal(J.loadJournal().open[0].reconcile.successfulListings,3);
 mock.state.time+=8*60000;await RH.reconcileRobinhood({force:true});
 const j=J.loadJournal();assert.equal(j.open.length,0);assert.equal(j.history[0].id,id);assert.equal(j.history[0].status,'FAILED');assert.equal(count(j),1);
});
test('cancel works without arm and changes status only via reconcile; cancel-all reports per entry',async()=>{
 reset();RH.armRobinhood(true);mock.state.placeMode='open';
 const a=await RH.placeRobinhoodOrder({symbol:'BTC-USD',usd:10,confirmation:PHRASE});const b=await RH.placeRobinhoodOrder({symbol:'ETH-USD',usd:10,confirmation:PHRASE});
 RH.armRobinhood(false);assert.equal(RH.robinhoodReadiness().sessionArmed,false);
 const c=await RH.cancelRobinhoodOrder({entryId:a.entry.id,confirmation:'CANCEL REAL CRYPTO ORDER'});assert.equal(c.entry.status,'SUBMITTED');assert.ok(c.entry.cancelRequestedAt);
 const all=await RH.cancelAllRobinhood({confirmation:'CANCEL REAL CRYPTO ORDERS'});assert.deepEqual(all.cancelled.sort(),[a.entry.id,b.entry.id].sort());assert.deepEqual(all.errors,[]);
 await RH.reconcileRobinhood({force:true});const j=J.loadJournal();assert.equal(j.open.length,0);assert.equal(j.history.filter(e=>e.status==='CANCELLED').length,2);assert.equal(count(j),2);
 await assert.rejects(RH.cancelRobinhoodOrder({entryId:a.entry.id,confirmation:'CANCEL REAL CRYPTO ORDER'}),e=>e.code==='notFound');
});
test('cancelled or failed sell returns the entry to OPEN with no P/L',async()=>{
 reset();RH.armRobinhood(true);const a=await RH.placeRobinhoodOrder({symbol:'BTC-USD',usd:10,confirmation:PHRASE});
 mock.state.placeMode='open';const s=await RH.placeRobinhoodOrder({entryId:a.entry.id,side:'sell',confirmation:PHRASE});assert.equal(s.entry.status,'CLOSING');
 mock.state.orders.get(s.entry.exit.orderId).state='canceled';await RH.reconcileRobinhood({force:true});
 const row=J.loadJournal().open[0];assert.equal(row.status,'OPEN');assert.equal(row.exit,null);assert.equal(row.pnlUsd,null);assert.equal(J.loadJournal().history.length,0);
 mock.state.placeMode='reject400';await assert.rejects(RH.placeRobinhoodOrder({entryId:a.entry.id,side:'sell',confirmation:PHRASE}),e=>e.code==='validation');assert.equal(J.loadJournal().open[0].status,'OPEN');
});
test('real autopilot round trip: breakout entry placedBy autopilot, take-profit exit, cooldown; snapshot signal is LONG while open',async()=>{
 reset();qualify();breakoutTape('BTC-USD');RH.armRobinhood(true);
 const ap=RH.setRobinhoodAutopilot({enabled:true,confirmation:AP_PHRASE,symbols:['BTC-USD','ETH-USD'],orderUsd:10,maxOpen:2});assert.equal(ap.enabled,true);
 const run=await RH.runRobinhoodAutopilotOnce();assert.equal(run.ran,true,JSON.stringify(run));assert.equal(run.placed.length,1);assert.equal(run.skipped.find(s=>s.symbol==='ETH-USD').reason,'warmup');
 let j=J.loadJournal();const e=j.open[0];assert.equal(e.placedBy,'autopilot');assert.equal(e.status,'OPEN');assert.equal(e.symbol,'BTC-USD');assert.ok(e.takePct>0);assert.equal(mock.writes()[0].body.symbol,'BTC-USD');
 const snap=await RH.robinhoodSnapshot({force:true});assert.equal(snap.tape['BTC-USD'].signal,'LONG');assert.equal(snap.tape['BTC-USD'].primary,true);assert.equal(snap.journal.open[0].placedBy,'autopilot');assert.deepEqual(snap.strategy.primary,{symbol:'BTC-USD',weight:1.5,orderMult:1});
 assert.equal((await RH.runRobinhoodAutopilotOnce()).placed.length,0,'duplicate symbol is not re-entered');
 mock.state.bid=e.avgPrice*(1+e.takePct+0.01);mock.state.ask=mock.state.bid*1.001;mock.state.time+=15000;
 const run2=await RH.runRobinhoodAutopilotOnce();assert.equal(run2.ran,true,JSON.stringify(run2));assert.deepEqual(run2.closed,[e.id]);
 j=J.loadJournal();assert.equal(j.open.length,0);assert.equal(j.history[0].status,'CLOSED');assert.equal(j.history[0].exit.reason,'take');assert.ok(j.history[0].pnlUsd>0);assert.ok(j.cooldowns['BTC-USD']>mock.state.time);assert.equal(j.autopilot.lastAction.action,'close');
 assert.equal(count(j),1);assert.equal(j.autopilot.enabled,true);
 RH.armRobinhood(false);assert.equal((await RH.runRobinhoodAutopilotOnce()).reason,'notArmed');assert.equal(RH.robinhoodAutopilot().enabled,true,'disarm does not clear the setting');
});
test('primary symbol weighting in pickCandidates is backwards compatible and ranks BTC first on equal raw scores',()=>{
 const f={ok:true,expectedMovePct:0.04};const rows={'ETH-USD':{features:f,costPct:0.02},'BTC-USD':{features:f,costPct:0.02},'SOL-USD':{features:{ok:true,expectedMovePct:0.05},costPct:0.02}};
 assert.deepEqual(S.pickCandidates(rows,[],{},3,0),['SOL-USD','BTC-USD','ETH-USD']);
 assert.deepEqual(S.pickCandidates(rows,[],{},3,0,{'BTC-USD':1.5}),['BTC-USD','SOL-USD','ETH-USD']);
 assert.deepEqual(S.pickCandidates(rows,['BTC-USD'],{},2,0,{'BTC-USD':1.5}),['SOL-USD']);
 assert.deepEqual(S.pickCandidates(rows,[],{},1,0,{'BTC-USD':'nope'}),['SOL-USD'],'invalid weights are ignored');
});
test('primary order multiplier is capped by maxOrderUsd and by 2.0; default universe is BTC,ETH,SOL with BTC first',()=>{
 reset();assert.deepEqual(RH.robinhoodSymbols(),['BTC-USD','ETH-USD','SOL-USD']);process.env.ROBINHOOD_SYMBOLS='SOL-USD,BTC-USD';assert.deepEqual(RH.robinhoodSymbols(),['BTC-USD','SOL-USD']);
 assert.equal(RH.primaryOrderUsd('BTC-USD',20),20);assert.equal(RH.primaryOrderUsd('ETH-USD',20),20);
 process.env.ROBINHOOD_PRIMARY_ORDER_MULT='2';assert.equal(RH.primaryOrderUsd('BTC-USD',10),20);assert.equal(RH.primaryOrderUsd('BTC-USD',20),25,'never above maxOrderUsd');assert.equal(RH.primaryOrderUsd('ETH-USD',20),20);
 process.env.ROBINHOOD_PRIMARY_ORDER_MULT='9';assert.equal(RH.robinhoodPrimary().orderMult,2);process.env.ROBINHOOD_PRIMARY_SYMBOL='eth-usd';process.env.ROBINHOOD_PRIMARY_WEIGHT='2.5';
 assert.deepEqual(RH.robinhoodPrimary(),{symbol:'ETH-USD',weight:2.5,orderMult:2});assert.equal(RH.primaryOrderUsd('ETH-USD',10),20);assert.equal(RH.primaryOrderUsd('BTC-USD',10),10);
 assert.deepEqual(RH.robinhoodReadiness().primary,{symbol:'ETH-USD',weight:2.5});
});
test('snapshot: pinned key list, signal enum values, never throws on a dead feed, masks the account',async()=>{
 reset();const s=await RH.robinhoodSnapshot({force:true});
 assert.deepEqual(Object.keys(s),['at','readiness','outbound','account','pairs','quotes','tape','paper','practice','daily','journal','limits','qualificationThresholds','strategy','loop','equities','evolve','explore','gauges','lastError']);
 for(const [sym,t] of Object.entries(s.tape)){assert.ok(SIGNALS.includes(t.signal),sym+' '+t.signal);assert.equal(t.primary,sym==='BTC-USD')}
 assert.equal(s.tape['BTC-USD'].signal,'WARMUP');assert.match(s.tape['BTC-USD'].reason,/warming up 0\/120/);assert.equal(Object.keys(s.tape)[0],'BTC-USD','primary is listed first');
 assert.equal(s.account.accountNumber,'****9876');assert.equal(s.readiness.execution,'manual-confirm-only');assert.equal(s.loop.needsQuotes,false);
 breakoutTape('BTC-USD');const s2=await RH.robinhoodSnapshot({force:true});assert.equal(s2.tape['BTC-USD'].signal,'BREAKOUT');
 mock.state.time+=600000;const s3=await RH.robinhoodSnapshot({force:true});assert.equal(s3.tape['BTC-USD'].signal,'STALE');
 mock.state.network='down';const s4=await RH.robinhoodSnapshot({force:true});assert.ok(s4.lastError);assert.equal(s4.lastError.stage,'snapshot');assert.equal(JSON.stringify(s4).includes(KEYS.seed),false);
});
test('paper loop records source, cost and rejection across restart when there is no trade',async()=>{
 reset();RH.setRobinhoodPaperAutopilot({enabled:true,symbols:['BTC-USD','ETH-USD']});
 const run=await RH.runRobinhoodPaperOnce();assert.equal(run.ran,true,JSON.stringify(run));
 assert.equal(J.loadPaper().positions.length,0);
 const seen=J.loadPaper().paperEvaluations;
 assert.ok(seen?.bySymbol['BTC-USD']);
 assert.equal(seen.bySymbol['BTC-USD'].action,'REJECTED');
 assert.ok(seen.bySymbol['BTC-USD'].reason);
 assert.ok(Number.isFinite(seen.bySymbol['BTC-USD'].costPct));
 assert.equal(mock.writes().length,0);
 J.__testing.resetPaper();
 const recovered=J.loadPaper().paperEvaluations;
 assert.deepEqual(recovered,seen);
 assert.equal((await RH.robinhoodSnapshot()).paper.evaluations.bySymbol['BTC-USD'].reason,seen.bySymbol['BTC-USD'].reason);
});
test('configure validates the key, writes USER_ROOT/.env with mode 0600 and disarms',()=>{
 reset();RH.armRobinhood(true);
 assert.throws(()=>RH.configureRobinhood({apiKey:'short',privateKey:KEYS.seed}),e=>e.code==='validation');
 assert.throws(()=>RH.configureRobinhood({apiKey:KEYS.apiKey,privateKey:Buffer.alloc(64,1).toString('base64')}),e=>e.code==='badKey'&&/seed\|\|publicKey/.test(e.message));
 assert.equal(RH.robinhoodReadiness().sessionArmed,true,'a failed configure changes nothing');
 const fresh=generateRobinhoodKeyPair();const r=RH.configureRobinhood({apiKey:'rh-api-99999999-8888-7777-6666-555555555555',privateKey:fresh.privateKeyBase64,realEnabled:false});
 assert.equal(r.sessionArmed,false);assert.equal(r.realEnabled,false);assert.equal(r.publicKey,fresh.publicKeyBase64);
 const env=fs.readFileSync(RH.__testing.envFile,'utf8');assert.match(env,/^ROBINHOOD_API_KEY=rh-api-99999999/m);assert.match(env,/^ROBINHOOD_PRIVATE_KEY=/m);assert.match(env,/^ROBINHOOD_REAL_ENABLED=false$/m);
 assert.equal(path.dirname(RH.__testing.envFile),path.dirname(process.env.MONEY_PRINTER_DATA_DIR));
 if(process.platform!=='win32')assert.equal(fs.statSync(RH.__testing.envFile).mode&0o777,0o600);
 RH.configureRobinhood({apiKey:KEYS.apiKey,privateKey:KEYS.seed,realEnabled:true});assert.equal((fs.readFileSync(RH.__testing.envFile,'utf8').match(/^ROBINHOOD_API_KEY=/gm)||[]).length,1,'rewriteEnv replaces in place');
});
test('startRobinhoodLoops returns the unref timer when autostart is on and null when off; paper practice never writes a real order',async()=>{
 reset();assert.equal(RH.startRobinhoodLoops(),null);process.env.ROBINHOOD_AUTOSTART='true';process.env.ROBINHOOD_WARM_START='false';const t=RH.startRobinhoodLoops();assert.ok(t);assert.equal(RH.startRobinhoodLoops(),t);RH.stopRobinhoodLoops();process.env.ROBINHOOD_AUTOSTART='false';delete process.env.ROBINHOOD_WARM_START;
 process.env.ROBINHOOD_COLLECT_QUOTES='false';try{mock.calls.length=0;await RH.__testing.tick();assert.equal(mock.writes().length,0)}finally{delete process.env.ROBINHOOD_COLLECT_QUOTES}
});
