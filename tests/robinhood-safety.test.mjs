// Safety suite (docs/ROBINHOOD-AUTO-TRADER.md §8, §14 D): every real-money gate refuses in order, nothing signed
// leaves the process while a gate fails, phrases are compared strictly, the journal row exists before the request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRobinhoodKeyPair } from '../src/robinhoodSigner.js';
import { createRobinhoodMock } from './helpers/robinhoodMock.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-safety-'));
process.env.MONEY_PRINTER_DATA_DIR=path.join(root,'data');
process.env.ROBINHOOD_AUTOSTART='false';process.env.POLYMARKET_AUTOSTART='false';process.env.ROBINHOOD_API='https://rh.test';
const KEYS={apiKey:'rh-api-11111111-2222-3333-4444-555555555555',seed:generateRobinhoodKeyPair().privateKeyBase64};
process.env.ROBINHOOD_API_KEY=KEYS.apiKey;process.env.ROBINHOOD_PRIVATE_KEY=KEYS.seed;process.env.ROBINHOOD_REAL_ENABLED='true';
const nativeFetch=globalThis.fetch;
let importFetches=0;globalThis.fetch=async()=>{importFetches++;throw new Error('fetch must not run at import')};
const RH=await import('../src/robinhoodAutoTrader.js'),J=await import('../src/robinhoodJournal.js'),TX=await import('../src/robinhoodTransport.js'),S=await import('../src/robinhoodStrategy.js');
const mock=createRobinhoodMock({journalFile:J.JOURNAL_FILE});globalThis.fetch=mock.fetch;
const PHRASE='PLACE REAL CRYPTO ORDER';
function reset(){RH.__testing.reset();RH.__testing.unlockRealExecutionForTests(true);fs.rmSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true,force:true});fs.mkdirSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true});TX.__testing.resetTransport();TX.__testing.setClock(()=>mock.state.time);RH.__testing.setClock(()=>mock.state.time);mock.calls.length=0;mock.state.orders.clear();mock.state.placeMode='filled';mock.state.network='up';mock.state.bid=100;mock.state.ask=100.1;
 Object.assign(process.env,{ROBINHOOD_API_KEY:KEYS.apiKey,ROBINHOOD_PRIVATE_KEY:KEYS.seed,ROBINHOOD_REAL_ENABLED:'true'});for(const k of ['ROBINHOOD_MAX_ORDER_USD','ROBINHOOD_MAX_OPEN','ROBINHOOD_DAILY_LOSS_CAP_USD'])delete process.env[k]}
const nothingSigned=()=>{assert.equal(TX.__testing.requestLog.length,0,'no signed request may leave while a gate fails');assert.equal(mock.signed().length,0)};
const seedOpen=(patch={})=>{const j=J.loadJournal();const e=J.makeRealEntry({symbol:'BTC-USD',requestedQty:0.0001,requestedUsd:10,refAsk:100.1,refBid:100});Object.assign(e,{at:mock.state.time},patch);j.open.push(e);J.saveJournal(j);return e};
const qualify=()=>{const p=J.loadPaper();p.params=S.normalizeParams({sampleMs:RH.__testing.TICK_MS});p.paramsHash=S.paramsHash(p.params);p.history=Array.from({length:25},(_,i)=>({id:'rp'+i,symbol:'BTC-USD',status:'CLOSED',placedBy:'paper-autopilot',closedBy:'strategy',paramsHash:p.paramsHash,pnlUsd:1+i*0.01,feeUsd:0.1,exit:{feeUsd:0.1,reason:'take'},costUsd:10,costPct:0.0185,stopPct:0.0185,takePct:0.074,closedAt:mock.state.time-i*60000}));J.savePaper(p,{force:true});assert.equal(RH.robinhoodReadiness().qualified,true)};
test.after(()=>{RH.stopRobinhoodLoops();globalThis.fetch=nativeFetch;fs.rmSync(root,{recursive:true,force:true})});

test('import performs no fetch; boots disarmed; realEnabled mirrors env and defaults false',()=>{
 reset();assert.equal(importFetches,0);const r=RH.robinhoodReadiness();
 assert.equal(r.sessionArmed,false);assert.equal(r.realEnabled,true);assert.equal(r.execution,'manual-confirm-only');assert.equal(r.credentialsReady,true);
 assert.equal(JSON.stringify(r).includes(KEYS.seed),false);assert.ok(r.publicKey&&r.publicKey.length>40);assert.deepEqual(r.primary,{symbol:'BTC-USD',weight:1.5});
 delete process.env.ROBINHOOD_REAL_ENABLED;assert.equal(RH.robinhoodReadiness().realEnabled,false);assert.throws(()=>RH.armRobinhood(true),e=>e.code==='realDisabled');
 process.env.ROBINHOOD_REAL_ENABLED='TRUE ';assert.equal(RH.robinhoodReadiness().realEnabled,false);
});
test('sessionArmed is never persisted and is false again after reset/configure',()=>{
 reset();RH.armRobinhood(true);assert.equal(RH.robinhoodReadiness().sessionArmed,true);J.saveJournal(J.loadJournal());J.savePaper(J.loadPaper(),{force:true});
 assert.doesNotMatch(fs.readFileSync(J.JOURNAL_FILE,'utf8'),/sessionArmed/);assert.doesNotMatch(fs.readFileSync(J.PAPER_FILE,'utf8'),/sessionArmed/);
 RH.configureRobinhood({apiKey:KEYS.apiKey,privateKey:KEYS.seed,realEnabled:true});assert.equal(RH.robinhoodReadiness().sessionArmed,false);
 assert.equal(fs.readFileSync(RH.__testing.envFile,'utf8').includes('ROBINHOOD_REAL_ENABLED=true'),true);
});
test('gate chain refuses in order and never signs a request while failing',async()=>{
 reset();const order={symbol:'BTC-USD',usd:10,confirmation:PHRASE};
 fs.writeFileSync(J.JOURNAL_FILE,'{not json');J.__testing.resetJournal();
 await assert.rejects(RH.placeRobinhoodOrder(order),e=>e.code==='stateRecovery');assert.throws(()=>RH.armRobinhood(true),e=>e.code==='stateRecovery');nothingSigned();
 reset();process.env.ROBINHOOD_API_KEY='';await assert.rejects(RH.placeRobinhoodOrder(order),e=>e.code==='noCredentials');nothingSigned();
 reset();process.env.ROBINHOOD_REAL_ENABLED='false';await assert.rejects(RH.placeRobinhoodOrder(order),e=>e.code==='realDisabled');nothingSigned();
 reset();await assert.rejects(RH.placeRobinhoodOrder(order),e=>e.code==='notArmed');nothingSigned();
 RH.armRobinhood(true);
 for(const bad of ['place real crypto order',PHRASE+' ',' '+PHRASE,'',undefined,null,PHRASE.slice(0,-1)])await assert.rejects(RH.placeRobinhoodOrder({...order,confirmation:bad}),e=>e.code==='confirmation');nothingSigned();
 process.env.ROBINHOOD_MAX_ORDER_USD='10';await assert.rejects(RH.placeRobinhoodOrder({...order,usd:10.5}),e=>e.code==='orderCap');nothingSigned();
 delete process.env.ROBINHOOD_MAX_ORDER_USD;process.env.ROBINHOOD_MAX_OPEN='1';seedOpen({symbol:'ETH-USD'});await assert.rejects(RH.placeRobinhoodOrder(order),e=>e.code==='openCap');nothingSigned();
 reset();RH.armRobinhood(true);{const j=J.loadJournal();j.history.push({id:'x',status:'CLOSED',fillVerified:true,exit:{filledQty:1},pnlUsd:-100,closedAt:mock.state.time});J.saveJournal(j)}
 await assert.rejects(RH.placeRobinhoodOrder(order),e=>e.code==='dailyLossCap');nothingSigned();
 reset();RH.armRobinhood(true);J.setCooldown(J.loadJournal(),'BTC-USD',mock.state.time+600000);J.saveJournal(J.loadJournal());
 await assert.rejects(RH.placeRobinhoodOrder(order),e=>e.code==='cooldown');nothingSigned();
 reset();RH.armRobinhood(true);seedOpen({symbol:'BTC-USD'});await assert.rejects(RH.placeRobinhoodOrder(order),e=>e.code==='duplicate');nothingSigned();
 reset();RH.armRobinhood(true);await assert.rejects(RH.placeRobinhoodOrder({...order,placedBy:'autopilot'}),e=>e.code==='notQualified');nothingSigned();
});
test('limits are exactly four keys and are re-read from env on every call',()=>{
 reset();assert.deepEqual(Object.keys(RH.robinhoodLimits()),['maxOrderUsd','maxOpen','dailyLossCapUsd','priceTolerance']);assert.equal(RH.robinhoodLimits().maxOrderUsd,25);
 process.env.ROBINHOOD_MAX_ORDER_USD='7';assert.equal(RH.robinhoodLimits().maxOrderUsd,7);process.env.ROBINHOOD_MAX_ORDER_USD='-3';assert.equal(RH.robinhoodLimits().maxOrderUsd,25);
});
test('journal row with clientOrderId exists before the signed request; fill becomes OPEN',{skip:'needs real-money Robinhood dispatch; this paper-only build refuses it by design (PAPER_ONLY_BUILD). Re-enable for the live phase.'},async()=>{
 reset();RH.armRobinhood(true);let seen=null;mock.state.onPlace=b=>{seen={clientOrderId:b.client_order_id,row:JSON.parse(fs.readFileSync(J.JOURNAL_FILE,'utf8')).open[0]}};
 const r=await RH.placeRobinhoodOrder({symbol:'BTC-USD',usd:10,confirmation:PHRASE});mock.state.onPlace=null;
 assert.equal(seen.row.status,'PENDING_SUBMIT');assert.equal(seen.row.clientOrderId,seen.clientOrderId);assert.equal(seen.row.placedBy,'manual');
 assert.equal(r.entry.status,'OPEN');assert.equal(r.entry.fillVerified,true);assert.ok(r.entry.costUsd>0&&r.entry.costUsd<=10.01);assert.equal(mock.signed().filter(c=>c.method==='POST').length,1);
 const post=mock.writes()[0];assert.equal(post.headers['x-api-key'],KEYS.apiKey);assert.equal(post.body.side,'buy');assert.equal(post.body.market_order_config.time_in_force,'gtc');
});
test('a sent-but-unanswered request becomes SUBMITTED_UNCERTAIN and is never resent',{skip:'needs real-money Robinhood dispatch; this paper-only build refuses it by design (PAPER_ONLY_BUILD). Re-enable for the live phase.'},async()=>{
 reset();RH.armRobinhood(true);mock.state.placeMode='network';
 await assert.rejects(RH.placeRobinhoodOrder({symbol:'BTC-USD',usd:10,confirmation:PHRASE}),e=>e.code==='uncertain'&&e.sent===true);
 const j=J.loadJournal();assert.equal(j.open.length,1);assert.equal(j.open[0].status,'SUBMITTED_UNCERTAIN');assert.equal(j.stats.unverified,1);const cid=j.open[0].clientOrderId;
 mock.state.placeMode='timeout';await assert.rejects(RH.placeRobinhoodOrder({symbol:'ETH-USD',usd:10,confirmation:PHRASE}),e=>e.code==='uncertain');assert.equal(J.loadJournal().open[1].status,'SUBMITTED_UNCERTAIN');
 const posts=mock.writes().length;mock.state.placeMode='filled';
 mock.state.orders.set('ord-late',{id:'ord-late',client_order_id:cid,symbol:'BTC-USD',side:'buy',type:'market',state:'filled',filled_asset_quantity:'0.0001',average_price:'100.1'});
 const rec=await RH.reconcileRobinhood({force:true});assert.equal(rec.ran,true);assert.equal(mock.writes().length,posts,'reconcile never re-posts');
 const after=J.loadJournal();assert.equal(after.open.find(e=>e.clientOrderId===cid).status,'OPEN');assert.equal(after.open.find(e=>e.clientOrderId===cid).orderId,'ord-late');assert.equal(after.open.length+after.history.length,2);
});
test('any 4xx on place lands in history as REJECTED; 401 disables real autopilot',{skip:'needs real-money Robinhood dispatch; this paper-only build refuses it by design (PAPER_ONLY_BUILD). Re-enable for the live phase.'},async()=>{
 reset();RH.armRobinhood(true);mock.state.placeMode='reject400';
 await assert.rejects(RH.placeRobinhoodOrder({symbol:'BTC-USD',usd:10,confirmation:PHRASE}),e=>e.code==='validation');
 let j=J.loadJournal();assert.equal(j.open.length,0);assert.equal(j.history[0].status,'REJECTED');
 qualify();RH.setRobinhoodAutopilot({enabled:true,confirmation:'ENABLE REAL CRYPTO AUTOPILOT'});assert.equal(RH.robinhoodAutopilot().enabled,true);
 mock.state.placeMode='reject401';await assert.rejects(RH.placeRobinhoodOrder({symbol:'ETH-USD',usd:10,confirmation:PHRASE}),e=>e.code==='keyNotFound');
 j=J.loadJournal();assert.equal(j.autopilot.enabled,false);assert.equal(j.autopilot.disabledReason,'keyNotFound');assert.equal(j.history[0].status,'REJECTED');assert.equal(j.open.length,0);
});
test('real autopilot needs the phrase, real enabled, arm and qualification; disables on paramsChanged, qualificationLost and dailyLossCap',async()=>{
 reset();const on={enabled:true,confirmation:'ENABLE REAL CRYPTO AUTOPILOT'};
 assert.throws(()=>RH.setRobinhoodAutopilot({enabled:true}),e=>e.code==='confirmation');assert.throws(()=>RH.setRobinhoodAutopilot({enabled:true,confirmation:'enable real crypto autopilot'}),e=>e.code==='confirmation');
 process.env.ROBINHOOD_REAL_ENABLED='false';assert.throws(()=>RH.setRobinhoodAutopilot(on),e=>e.code==='realDisabled');process.env.ROBINHOOD_REAL_ENABLED='true';
 assert.throws(()=>RH.setRobinhoodAutopilot(on),e=>e.code==='notArmed');RH.armRobinhood(true);
 assert.throws(()=>RH.setRobinhoodAutopilot(on),e=>e.code==='notQualified');assert.equal(RH.robinhoodAutopilot().enabled,false);nothingSigned();
 qualify();const ap=RH.setRobinhoodAutopilot({...on,orderUsd:999,maxOpen:99,dailyLossCapUsd:9999,symbols:'ETH-USD,BTC-USD'});
 assert.equal(ap.enabled,true);assert.equal(ap.orderUsd,25);assert.equal(ap.maxOpen,5);assert.equal(ap.dailyLossCapUsd,50);assert.deepEqual(ap.symbols,['BTC-USD','ETH-USD']);assert.equal(ap.paramsHash,J.loadPaper().paramsHash);
 assert.doesNotMatch(fs.readFileSync(J.JOURNAL_FILE,'utf8'),/sessionArmed/);
 RH.setRobinhoodPaperAutopilot({params:{takeMult:5}});assert.equal(RH.robinhoodAutopilot().enabled,false,'a new paper paramsHash disables real autopilot at once');assert.equal(RH.robinhoodAutopilot().disabledReason,'paramsChanged');assert.equal((await RH.runRobinhoodAutopilotOnce()).reason,'disabled');nothingSigned();
 RH.setRobinhoodPaperAutopilot({params:{takeMult:4}});qualify();RH.setRobinhoodAutopilot(on);{const p=J.loadPaper();p.history=[];J.savePaper(p,{force:true})}
 const run=await RH.runRobinhoodAutopilotOnce();assert.equal(run.reason,'qualificationLost');assert.equal(RH.robinhoodAutopilot().enabled,false);assert.equal(RH.robinhoodAutopilot().disabledReason,'qualificationLost');nothingSigned();
 // Daily loss cap: qualified again, enabled, but today's realized loss already exceeds the cap.
 RH.setRobinhoodPaperAutopilot({params:{takeMult:4}});qualify();RH.setRobinhoodAutopilot(on);
 {const j=J.loadJournal();j.history.unshift({id:'loss',status:'CLOSED',fillVerified:true,exit:{filledQty:1},pnlUsd:-60,closedAt:mock.state.time});J.saveJournal(j)}
 const r2=await RH.runRobinhoodAutopilotOnce();assert.equal(r2.reason,'dailyLossCap');assert.equal(r2.disabled,true);assert.equal(RH.robinhoodAutopilot().enabled,false);assert.equal(RH.robinhoodAutopilot().disabledReason,'dailyLossCap');
 assert.equal(mock.writes().length,0,'no order was posted');
 RH.armRobinhood(false);assert.equal((await RH.runRobinhoodAutopilotOnce()).reason,'disabled');
});
test('cancel, cancel-all and forget require their exact phrases; forget never touches the network',async()=>{
 reset();const e=seedOpen({status:'OPEN',fillVerified:true,filledQty:0.0001,avgPrice:100.1,costUsd:10.02});
 await assert.rejects(RH.cancelRobinhoodOrder({entryId:e.id,confirmation:'CANCEL REAL CRYPTO ORDERS'}),x=>x.code==='confirmation');
 await assert.rejects(RH.cancelAllRobinhood({confirmation:'CANCEL REAL CRYPTO ORDER'}),x=>x.code==='confirmation');
 assert.throws(()=>RH.forgetRobinhoodEntry({entryId:e.id,confirmation:'forget'}),x=>x.code==='confirmation');
 assert.throws(()=>RH.forgetRobinhoodEntry({entryId:e.id,confirmation:'FORGET'}),x=>x.code==='holding');
 const f=RH.forgetRobinhoodEntry({entryId:e.id,confirmation:'FORGET',acknowledgeHolding:true});assert.equal(f.entry.status,'FORGOTTEN');assert.equal(f.entry.pnlUsd,null);
 assert.equal(J.loadJournal().open.length,0);assert.equal(J.loadJournal().cooldowns['BTC-USD'],undefined);assert.equal(mock.calls.length,0);nothingSigned();
 assert.match(fs.readFileSync(new URL('../src/robinhoodAutoTrader.js',import.meta.url),'utf8'),/confirmation!=='FORGET'/);
});

test('production Robinhood transport has a code-level real-host POST barrier',async()=>{
 reset();
 assert.equal(TX.ROBINHOOD_LIVE_TRADING_ENABLED,false,'production source constant is locked off');
 const oldApi=process.env.ROBINHOOD_API,oldLiveKey=process.env.ROBINHOOD_LIVE_API_KEY,oldLivePrivate=process.env.ROBINHOOD_LIVE_PRIVATE_KEY,priorFetch=globalThis.fetch;
 let fetches=0;
 try{
  process.env.ROBINHOOD_API='https://trading.robinhood.com';
  process.env.ROBINHOOD_REAL_ENABLED='true';
  process.env.ROBINHOOD_LIVE_API_KEY=KEYS.apiKey;process.env.ROBINHOOD_LIVE_PRIVATE_KEY=KEYS.seed;
  globalThis.fetch=async()=>{fetches++;throw new Error('real host fetch must be unreachable')};
  await assert.rejects(TX.rhRequest({method:'POST',path:'/api/v2/crypto/trading/orders/',json:{symbol:'BTC-USD'}}),e=>e?.code==='ROBINHOOD_PAPER_ONLY_BUILD');
  assert.equal(fetches,0,'source barrier fires before signing or network dispatch');
 }finally{
  process.env.ROBINHOOD_API=oldApi||'https://rh.test';process.env.ROBINHOOD_REAL_ENABLED='true';
  oldLiveKey===undefined?delete process.env.ROBINHOOD_LIVE_API_KEY:process.env.ROBINHOOD_LIVE_API_KEY=oldLiveKey;
  oldLivePrivate===undefined?delete process.env.ROBINHOOD_LIVE_PRIVATE_KEY:process.env.ROBINHOOD_LIVE_PRIVATE_KEY=oldLivePrivate;
  globalThis.fetch=priorFetch;
 }
});
