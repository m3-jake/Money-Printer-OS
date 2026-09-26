import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-combos-'));
process.env.MONEY_PRINTER_DATA_DIR=DIR;
process.env.POLYMARKET_AUTOSTART='false';
process.env.POLYMARKET_KEY_ID='pmus-test-key-id';
process.env.POLYMARKET_SECRET_KEY=Buffer.alloc(64,7).toString('base64');
process.env.POLYMARKET_US_REAL_ENABLED='true';
process.env.POLYMARKET_US_COMBO_MAX_STAKE_USD='25';
process.env.POLYMARKET_US_COMBO_PRICE_TOLERANCE='0.02';
process.env.POLYMARKET_US_COMBO_FEE_MODE='standard';
process.env.POLYMARKET_US_COMBO_BBO='false';

const us=await import('../src/polymarketUS.js');
const combos=await import('../src/polymarketUSCombos.js');
const savedFetch=globalThis.fetch;

// ---------------------------------------------------------------- fixtures
function market(over={}){
 return {slug:'atc-x-1',question:'Will X win?',sportsMarketType:'soccer_team_full_time_winner',
  sportsMarketTypeV2:'SPORTS_MARKET_TYPE_DRAWABLE_OUTCOME',comboEnabled:true,status:'MARKET_STATUS_OPEN',
  minimumTradeQty:0.01,orderPriceMinTickSize:0.01,feeCoefficient:0.06,
  bestAskQuote:{value:'0.9000',currency:'USD'},bestBidQuote:{value:'0.8900',currency:'USD'},
  outcomes:'["Yes","No"]',
  marketSides:[{identifier:'atc-x-1',description:'Yes',long:true,price:'0.8900',tradable:true,team:{abbreviation:'xxx'}},
   {identifier:'atc-x-1',description:'No',long:false,price:'0.9000',tradable:true,team:{abbreviation:'xxx'}}],...over};
}
function soccerEvent(slug,minute,over={}){
 return {slug,title:`${slug} game`,live:true,closed:false,ended:false,period:`${minute}'`,score:'2-0',
  tags:[{slug:'sports'},{slug:'soccer'}],markets:[market({slug:`atc-${slug}-home`})],__fetchedAt:Date.now(),...over};
}
const liveEvents=()=>[soccerEvent('sa-aaa-bbb-2026-09-14',88),soccerEvent('sb-ccc-ddd-2026-09-14',89),soccerEvent('sc-eee-fff-2026-09-14',7)];

function eventsResponse(events){return {events}}
function jsonRes(obj,status=200){
 return {ok:status>=200&&status<300,status,text:async()=>JSON.stringify(obj)};
}
function textRes(body,status){return {ok:status>=200&&status<300,status,text:async()=>body}}

function installFetch(handler,log){
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url);
  log?.push({method:init.method||'GET',path:u.pathname,search:u.search,headers:init.headers||{},body:init.body?JSON.parse(init.body):null});
  const r=await handler(u,init);
  if(r)return r;
  throw new Error('Unexpected request '+init.method+' '+u.pathname);
 };
}
function reset(){combos.__testing.resetJournal();try{fs.rmSync(combos.__testing.stateFile,{force:true})}catch{}us.armPolymarketUS(false)}

test.after(()=>{globalThis.fetch=savedFetch;combos.stopUSComboLoops();fs.rmSync(DIR,{recursive:true,force:true})});

// ------------------------------------------------------------------ item 2
test('US period/score adapter maps into lateGameEstimate input shapes',()=>{
 const n=combos.normalizeUSLiveState;
 const soccer=s=>n({slug:'bra-bah-cre-2026-09-14',period:s,score:'2-1',tags:[{slug:'soccer'}]});
 assert.deepEqual([soccer("72'").period,soccer("72'").elapsed],['2H','72']);
 assert.deepEqual([soccer("90+7'").period,soccer("90+7'").elapsed],['2H','90+7']);
 assert.deepEqual([soccer("45'").period,soccer("45'").elapsed],['1H','45']);
 assert.deepEqual([soccer("7'").period,soccer("7'").elapsed],['1H','7']);
 assert.equal(soccer('HT').period,'HT');
 const nfl=n({slug:'nfl-den-kc-2026-09-14',period:'Q4',elapsed:'02:30',score:'7-7',tags:[{slug:'nfl'},{slug:'football'}]});
 assert.deepEqual([nfl.period,nfl.elapsed,nfl.leagueAbbreviation],['Q4','02:30','nfl football']);
 const mlb=n({slug:'mlb-nyy-min-2026-09-14',period:'Bot 9th',score:'1-0',tags:[{slug:'mlb'},{slug:'baseball'}]});
 assert.equal(mlb.period,'Bot 9th');
 assert.equal(n({slug:'mlb-a-b',period:'Mid 9th',tags:[{slug:'mlb'}]}).period,'Mid 9th');
 const tennis=n({slug:'wta-a-b',period:'S3',score:'6-1, 5-4:40-30',tags:[{slug:'tennis'},{slug:'wta'}]});
 assert.equal(tennis.period,'SET 3');
 assert.equal(tennis.score,'6-1, 5-4');
 assert.match(tennis.leagueAbbreviation,/tennis wta BO3/);
 const tt=n({slug:'setkameua-a-b',period:'S5',score:'11-9, 11-7, 10-12, 8-11, 9-7',tags:[{slug:'table-tennis'},{slug:'setka'}]});
 assert.equal(tt.period,'SET 5');
 assert.match(tt.leagueAbbreviation,/table tennis .*BO5/);
});

test('adapter output drives lateGameEstimate to the expected verdicts',async()=>{
 const {lateGameEstimate}=await import('../src/sportsTiming.js');
 const n=combos.normalizeUSLiveState;
 const late=(ev,m={})=>lateGameEstimate({event:ev.title||ev.slug,slug:ev.slug,type:m.type||''},n(ev));
 assert.ok(late({slug:'bra-a-b',period:"88'",score:'2-1',tags:[{slug:'soccer'}]}).nearEndScore>=65);
 assert.equal(late({slug:'bra-a-b',period:"61'",score:'2-1',tags:[{slug:'soccer'}]}).nearEndScore,0);
 assert.equal(late({slug:'bra-a-b',period:'HT',score:'0-0',tags:[{slug:'soccer'}]}).nearEndScore,0);
 assert.ok(late({slug:'nfl-a-b',period:'Q4',elapsed:'02:30',tags:[{slug:'nfl'}]}).nearEndScore>=65);
 assert.ok(late({slug:'mlb-a-b',period:'Bot 9th',tags:[{slug:'mlb'}]}).nearEndScore>=65);
 assert.equal(late({slug:'mlb-a-b',period:'Mid 9th',tags:[{slug:'mlb'}]}).nearEndScore,0,'Mid innings must not count as finishing');
 assert.ok(late({slug:'setka-a-b',period:'S5',score:'9-7',tags:[{slug:'table-tennis'},{slug:'setka'}]}).nearEndScore>=65);
});

// ------------------------------------------------------------------ item 3
test('candidate filter keeps only tradable late-game combo legs, one per event',()=>{
 const now=Date.now();
 const events=[
  soccerEvent('sa-aaa-bbb-2026-09-14',88,{markets:[
   market({slug:'atc-sa-home'}),
   market({slug:'atc-sa-prop',sportsMarketType:'soccer_player_goals'}),
   market({slug:'atc-sa-nocombo',comboEnabled:false}),
   market({slug:'atc-sa-closed',status:'MARKET_STATUS_SUSPENDED'}),
   market({slug:'atc-sa-cheap',bestAskQuote:{value:'0.4000'},bestBidQuote:{value:'0.3900'}}),
   market({slug:'atc-sa-wide',bestAskQuote:{value:'0.9500'},bestBidQuote:{value:'0.8000'}}),
  ]}),
  soccerEvent('sb-ccc-ddd-2026-09-14',89),
  soccerEvent('sc-eee-fff-2026-09-14',7),
 ];
 const {candidates,rejections}=combos.usCandidatesFromEvents(events,now);
 assert.equal(candidates.length,2,'one leg per live near-settlement event');
 assert.deepEqual(candidates.map(c=>c.eventSlug).sort(),['sa-aaa-bbb-2026-09-14','sb-ccc-ddd-2026-09-14']);
 assert.equal(candidates[0].side,'SIDE_BUY');
 assert.equal(candidates[0].price,0.9);
 assert.equal(candidates[0].key,candidates[0].symbol+'|SIDE_BUY');
 assert.ok(rejections['market-type']>=1&&rejections['combo-disabled']>=1&&rejections['price-band']>=1&&rejections['spread']>=1);
 assert.ok(rejections['turnover-window']>=1||Object.keys(rejections).some(k=>/window|short remaining/.test(k)));
 assert.equal(combos.usCandidatesFromEvents([soccerEvent('sd-x-y',88,{__fetchedAt:now-200000})],now).candidates.length,0);
});

// ------------------------------------------------------------------ item 4
test('combo math: product price, tick rounding, quantity floor, fee and payout',()=>{
 const pool=combos.usCandidatesFromEvents(liveEvents(),Date.now()).candidates;
 const keys=pool.map(c=>c.key);
 const c=combos.buildUSCombo({legKeys:keys,stakeUsd:5,candidates:pool});
 assert.equal(c.price,0.81);                       // 0.90 * 0.90 = 0.81 on the 0.001 tick
 assert.equal(c.quantity,6.09);                    // reserve the rounded fee inside $5
 assert.equal(c.payoutUsd,6.09);
 assert.equal(c.decimalOdds,1.235);
 assert.equal(c.feeUsd,Math.round(6.09*0.06*0.81*0.19*100)/100);
 assert.equal(c.profitUsd,Math.round((c.payoutUsd-c.costUsd)*100)/100);
 assert.throws(()=>combos.buildUSCombo({legKeys:[keys[0]],stakeUsd:5,candidates:pool}),/at least 2 legs/);
 assert.throws(()=>combos.buildUSCombo({legKeys:[keys[0],keys[0]],stakeUsd:5,candidates:pool}),/Duplicate leg symbol/);
 const stale=pool.map(x=>({...x,freshnessSec:200}));
 assert.throws(()=>combos.buildUSCombo({legKeys:keys,stakeUsd:5,candidates:stale}),/old \(limit 90s\)/);
 const sameEvent=[pool[0],{...pool[1],eventSlug:pool[0].eventSlug}];
 assert.throws(()=>combos.buildUSCombo({legKeys:sameEvent.map(x=>x.key),stakeUsd:5,candidates:sameEvent}),/same event/);
});

test('combo fee switches to the published combo curve at the effective date',()=>{
 const before=Date.parse('2026-09-16T12:00:00Z'),after=Date.parse('2026-09-18T12:00:00Z');
 const saved=process.env.POLYMARKET_US_COMBO_FEE_MODE;
 process.env.POLYMARKET_US_COMBO_FEE_MODE='auto';
 assert.equal(Math.round(combos.comboFeePerContract(0.8,before)*1e6),Math.round(0.06*0.8*0.2*1e6));
 assert.equal(Math.round(combos.comboFeePerContract(0.8,after)*1e6),Math.round(0.8*(0.0695*0.2+0.04*Math.pow(0.2,4))*1e6));
 process.env.POLYMARKET_US_COMBO_FEE_MODE=saved;
});

test('fee-inclusive quantity fits every configured budget including the fee change',()=>{
 const saved=process.env.POLYMARKET_US_COMBO_FEE_MODE;
 process.env.POLYMARKET_US_COMBO_FEE_MODE='auto';
 try{
  for(const at of [Date.parse('2026-09-15'),Date.parse('2026-09-18')])
   for(const stake of [1,5,25])for(const price of [.64,.81,.97]){
    const b=combos.comboBudget(price,stake,at);
    assert.ok(b.quantity*price+b.feeUsd<=stake+1e-9);
    assert.ok(b.quantity>0&&b.notionalUsd<stake);
   }
 }finally{process.env.POLYMARKET_US_COMBO_FEE_MODE=saved;}
 assert.throws(()=>combos.comboBudget(NaN,5),/finite price/);
});

test('BBO enrichment runs at bounded concurrency and does not reuse failed quotes',async()=>{
 reset();const prior=process.env.POLYMARKET_US_COMBO_BBO;
 process.env.POLYMARKET_US_COMBO_BBO='true';
 let active=0,peak=0;
 installFetch(async u=>{
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(Array.from({length:6},(_,i)=>soccerEvent('parallel-'+i,89))));
  if(u.pathname.endsWith('/bbo')){
   active++;peak=Math.max(peak,active);
   await new Promise(r=>setTimeout(r,10));active--;
   if(u.pathname.includes('parallel-0'))return textRes('unavailable',503);
   return jsonRes({marketData:{bestAsk:{value:.90},bestBid:{value:.89},openInterest:20000}});
  }
 });
 try{
  const snapshot=await combos.usComboSnapshot({force:true});
  assert.equal(peak,4);assert.equal(snapshot.candidates.length,5);
  assert.ok(snapshot.candidates.every(c=>c.priceSource==='bbo'&&c.liquidityKnown));
 }finally{process.env.POLYMARKET_US_COMBO_BBO=prior;}
});

test('missing remaining quantity never fabricates a verified full fill',async()=>{
 reset();
 fs.writeFileSync(combos.__testing.stateFile,JSON.stringify({open:[{id:'unknown-fill',orderId:'ord-missing',quantity:5,fillPrice:.81,fillVerified:false,status:'SUBMITTED',legs:[]}]}));
 installFetch(u=>u.pathname==='/v1/order/ord-missing'?jsonRes({order:{state:'ORDER_STATE_FILLED',quantity:5}}):null);
 const result=await combos.reconcileUSOrders();
 assert.equal(result.changed,0);
 assert.equal(JSON.parse(fs.readFileSync(combos.__testing.stateFile)).open[0].fillVerified,false);
});

test('cached candidates expire even when the stored freshness counter is zero',()=>{
 const now=Date.now(),pool=combos.usCandidatesFromEvents(liveEvents(),now).candidates;
 assert.throws(()=>combos.buildUSCombo({legKeys:pool.map(c=>c.key),stakeUsd:5,candidates:pool,at:now+91000}),e=>e.code==='staleLeg');
});

test('combo selection moves past open games and cooldowns to use available capacity',()=>{
 const now=Date.now();
 const pool=Array.from({length:6},(_,i)=>({key:'k'+i,eventSlug:'e'+i,symbol:'m'+i,rank:100-i}));
 const journal={open:[{legs:[pool[0],pool[1]]}],cooldowns:{e2:now-1000}};
 assert.deepEqual(combos.chooseUSCombo(pool,2,journal,now).map(c=>c.key),['k3','k4']);
});

test('RFQ whose notional fits but fees exceed the budget is never accepted',async()=>{
 reset();us.armPolymarketUS(true);const log=[];
 installFetch((u,init)=>{
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-fees',legs:JSON.parse(init.body).legs}});
  if(u.pathname==='/v1/rfqs/quotes')return jsonRes({quotes:[{id:'q1',symbol:'caoc-fees',status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.81',buyQtyDecimal:'6.17'}]});
  if(init.method==='PUT')throw Error('Oversized quote must not execute');
 },log);
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 await assert.rejects(combos.placeUSCombo({legKeys:keys,stakeUsd:5,rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'}),e=>e.code==='stakeCap');
 assert.equal(log.filter(x=>x.method==='PUT').length,0);
 us.armPolymarketUS(false);
});

// --------------------------------------------------------------- items 6/7
test('safety gates reject before any network call is made',async()=>{
 reset();
 const log=[];
 installFetch(u=>u.pathname==='/v1/events'?jsonRes(eventsResponse(liveEvents())):null,log);
 const pool=await (async()=>{const s=await combos.usComboSnapshot({force:true});return s.candidates})();
 const keys=pool.map(c=>c.key).slice(0,2);
 const base={legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'rfq-1',quoteId:'q-1'};
 await assert.rejects(combos.placeUSCombo({...base,confirmation:'PLACE REAL COMBO'}),e=>e.code==='notArmed'&&/not armed/i.test(e.message));
 us.armPolymarketUS(true);
 await assert.rejects(combos.placeUSCombo({...base,confirmation:'yes please'}),e=>e.code==='confirmation');
 await assert.rejects(combos.placeUSCombo({...base,stakeUsd:999,confirmation:'PLACE REAL COMBO'}),e=>e.code==='stakeCap');
 const signed=log.filter(x=>x.headers['X-PM-Access-Key']);
 assert.equal(signed.length,0,'no signed request may be sent while a gate is failing');
 us.armPolymarketUS(false);
});

test('RFQ flow creates the combo, polls quotes, accepts and confirms',async()=>{
 reset();
 us.armPolymarketUS(true);
 const log=[];
 let polls=0;
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-test-1',legs:JSON.parse(init.body).legs,state:'INSTRUMENT_STATE_OPEN',tickSize:0.001}});
  if(m==='POST'&&u.pathname==='/v1/rfqs')return jsonRes({rfqId:'rfq-77'});
  if(m==='GET'&&u.pathname==='/v1/rfqs/quotes'){
   polls++;
   if(polls===1)return jsonRes({quotes:[]});
   return jsonRes({quotes:[
    {id:'q-hi',rfqId:'rfq-77',symbol:'caoc-test-1',status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.825',buyQtyDecimal:'6.06',confirmationDeadline:new Date(Date.now()+9000).toISOString()},
    {id:'q-best',rfqId:'rfq-77',symbol:'caoc-test-1',status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.815',buyQtyDecimal:'6.00',confirmationDeadline:new Date(Date.now()+9000).toISOString(),rfqCreatorOrderId:'ord-9'},
    {id:'q-dead',rfqId:'rfq-77',symbol:'caoc-test-1',status:'QUOTE_STATUS_DELETED',buyPrice:'0.700'}]});
  }
  if(m==='PUT'&&/\/accept$/.test(u.pathname))return jsonRes({});
  if(m==='PUT'&&/\/confirm$/.test(u.pathname))return jsonRes({});
  return null;
 },log);
 const snap=await combos.usComboSnapshot({force:true});
 const keys=snap.suggested.legs;
 const quote=await combos.quoteUSCombo({legKeys:keys,stakeUsd:5,waitMs:3000});
 assert.equal(quote.symbol,'caoc-test-1');
 assert.equal(quote.rfqId,'rfq-77');
 assert.equal(quote.quoteId,'q-best','lowest active buyPrice wins');
 assert.equal(quote.buyPrice,0.815);
 assert.ok(polls>=2,'quotes are polled until one is active');

 const comboReq=log.find(x=>x.method==='POST'&&x.path==='/v1/combos');
 assert.ok(comboReq.headers['X-PM-Access-Key']&&comboReq.headers['X-PM-Timestamp']&&comboReq.headers['X-PM-Signature']);
 assert.equal(comboReq.body.legs.length,2);
 assert.deepEqual(Object.keys(comboReq.body.legs[0]).sort(),['side','symbol']);
 const rfqReq=log.find(x=>x.method==='POST'&&x.path==='/v1/rfqs');
 assert.deepEqual(rfqReq.body,{symbol:'caoc-test-1',cashOrderQty:'4.93',restRemainder:false});
 assert.ok(!('account' in rfqReq.body),'retail RFQs must not send account');

 const placed=await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'rfq-77',quoteId:'q-best',confirmation:'PLACE REAL COMBO'});
 assert.equal(placed.ok,true);
 assert.equal(placed.entry.status,'SUBMITTED');
 assert.equal(placed.entry.fillPrice,0.815);
 assert.equal(placed.entry.legs.length,2);
 assert.equal(placed.entry.placedBy,'manual');
 const accept=log.find(x=>x.method==='PUT'&&/accept$/.test(x.path));
 assert.equal(accept.path,'/v1/rfqs/rfq-77/quotes/q-best/accept');
 assert.deepEqual(accept.body,{acceptedSide:'SIDE_BUY'});
 const confirm=log.find(x=>x.method==='PUT'&&/confirm$/.test(x.path));
 assert.equal(confirm.path,'/v1/rfqs/rfq-77/quotes/q-best/confirm');
 assert.deepEqual(confirm.body,{});
 assert.ok(log.findIndex(x=>/accept$/.test(x.path))<log.findIndex(x=>/confirm$/.test(x.path)),'accept precedes confirm');

 const saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(saved.open.length,1);
 assert.equal(saved.stats.placed,1);
 assert.ok(saved.combos['caoc-test-1']);
 us.armPolymarketUS(false);
});

test('a quote above est. price + tolerance is refused and never accepted',async()=>{
 reset();
 us.armPolymarketUS(true);
 const log=[];
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='GET'&&u.pathname==='/v1/rfqs/quotes')return jsonRes({quotes:[{id:'q-bad',rfqId:'rfq-9',symbol:'caoc-x',status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.900'}]});
  return null;
 },log);
 await combos.usComboSnapshot({force:true});
 const keys=(await combos.usComboSnapshot()).suggested.legs;
 await assert.rejects(
  combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'rfq-9',quoteId:'q-bad',confirmation:'PLACE REAL COMBO'}),
  e=>e.code==='priceTolerance'&&/0\.9.*0\.81/.test(e.message));
 assert.equal(log.filter(x=>/accept|confirm/.test(x.path)).length,0);
 us.armPolymarketUS(false);
});

test('open cap and duplicate-event gates hold before any order is sent',async()=>{
 reset();
 us.armPolymarketUS(true);
 process.env.POLYMARKET_US_COMBO_MAX_OPEN='1';
 const log=[];
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-cap',legs:[]}});
  if(m==='GET'&&u.pathname==='/v1/rfqs/quotes')return jsonRes({quotes:[{id:'q1',rfqId:'r1',symbol:'caoc-cap',status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.810',buyQtyDecimal:'6.00'}]});
  if(m==='PUT')return jsonRes({});
  return null;
 },log);
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'});
 await assert.rejects(combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'}),e=>e.code==='openCap');
 process.env.POLYMARKET_US_COMBO_MAX_OPEN='5';
 await assert.rejects(combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'}),e=>e.code==='duplicate');
 us.armPolymarketUS(false);
});

// ---------------------------------------------------------------- items 5/15
test('auth failures are classified and surfaced in readiness',async()=>{
 reset();
 us.armPolymarketUS(true);
 installFetch((u,init)=>{
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(u.pathname==='/v1/combos')return textRes(JSON.stringify({message:'API key not found'}),401);
  return null;
 });
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 await assert.rejects(combos.quoteUSCombo({legKeys:keys,stakeUsd:5}),e=>e.code==='keyNotFound'&&e.status===401);
 assert.equal(us.usReadiness().authCode,'keyNotFound');
 assert.match(us.usReadiness().lastAuthError,/API key not found/);

 installFetch((u,init)=>{
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(u.pathname==='/v1/combos')return textRes('combos are limited to explicitly enabled Retail API users',403);
  return null;
 });
 await assert.rejects(combos.quoteUSCombo({legKeys:keys,stakeUsd:5}),e=>e.code==='betaNotEnabled'&&e.status===403);
 assert.equal((await combos.usComboSnapshot({force:true})).betaAccess,'denied');
 assert.equal(us.classifyUSAuthError('rate limit exceeded',429),'rateLimited');
 us.armPolymarketUS(false);
});

// ------------------------------------------------------------------ item 9 (removed)
test('autopilot is deleted: no exports, no snapshot key, the loop only settles, old journals still load',async()=>{
 for(const k of ['usComboAutopilot','setUSComboAutopilot','runUSComboAutopilotOnce'])assert.equal(k in combos,false,k);
 assert.equal('CONFIRM_AUTOPILOT' in combos.__testing,false);
 const src=fs.readFileSync(new URL('../src/polymarketUSCombos.js',import.meta.url),'utf8');
 assert.doesNotMatch(src,/ENABLE REAL AUTOPILOT|MANUAL_ORDER_INDICATOR_AUTOMATIC/);
 const loop=src.slice(src.indexOf('export function startUSComboLoops'),src.indexOf('export function stopUSComboLoops'));
 assert.match(loop,/settleUSCombos()/);assert.doesNotMatch(loop,/place|quote|Autopilot/i);
 reset();
 // A journal written by an older build, autopilot left ON, loads with the key dropped and nothing lost.
 const entry={id:'uc-old',symbol:'caoc-old',legs:[],status:'OPEN',fillVerified:true,stakeUsd:5,at:Date.now()};
 fs.writeFileSync(combos.__testing.stateFile,JSON.stringify({version:1,combos:{},open:[entry],history:[],stats:{placed:1,won:0,lost:0,pnlUsd:0,hitRate:null},
  autopilot:{enabled:true,stakeUsd:25,maxLegs:3,maxOpen:5,skipped:'garbage'},cooldowns:{}}));
 combos.__testing.resetJournal();
 installFetch(u=>u.pathname==='/v1/events'?jsonRes(eventsResponse([])):null);
 const snap=await combos.usComboSnapshot({force:true});
 assert.equal('autopilot' in snap,false);
 assert.equal(snap.journal.open.length,1);assert.equal(snap.journal.open[0].id,'uc-old');
 combos.setUSComboSettings({maxLegs:2});
 assert.equal('autopilot' in JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8')),false,'the next save drops the stale key');
});

// ------------------------------------------------------------------ item 8
test('settlement marks WON/LOST and records the post-settlement cooldown',async()=>{
 reset();
 us.armPolymarketUS(true);
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-settle',legs:[]}});
  if(m==='GET'&&u.pathname==='/v1/rfqs/quotes')return jsonRes({quotes:[{id:'q1',rfqId:'r1',symbol:'caoc-settle',status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.810',buyQtyDecimal:'6.00',rfqCreatorOrderId:'ord-s1'}]});
  if(m==='PUT')return jsonRes({});
  if(m==='GET'&&/^\/v1\/order\//.test(u.pathname))return jsonRes({order:{state:'ORDER_STATE_FILLED',quantity:6.17,leavesQuantity:0}});
  if(m==='GET'&&/\/settlement$/.test(u.pathname))return jsonRes({marketSlug:'x',settlementPrice:{value:'1.0000'},settledAt:'2026-09-14T22:00:00Z'});
  return null;
 });
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'});
 const out=await combos.settleUSCombos({force:true});
 assert.equal(out.settled,1);
 const saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(saved.open.length,0);
 assert.equal(saved.history[0].status,'WON');
 assert.ok(saved.history[0].pnlUsd>0);
 assert.equal(saved.stats.hitRate,1);
 assert.ok(Object.keys(saved.cooldowns).length>=2);
 await assert.rejects(combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'}),e=>e.code==='cooldown');
 us.armPolymarketUS(false);
});

// ----------------------------------------------------------------- item 10
test('snapshot matches the UI contract and never throws on a dead feed',async()=>{
 reset();
 installFetch(u=>u.pathname==='/v1/events'?jsonRes(eventsResponse(liveEvents())):null);
 const s=await combos.usComboSnapshot({force:true});
 for(const k of ['at','readiness','feed','candidates','suggested','quote','journal','limits','betaAccess','lastError'])assert.ok(k in s,'missing '+k);
 for(const k of ['credentialsReady','sessionArmed','lastAuthError','authCode'])assert.ok(k in s.readiness,'missing readiness.'+k);
 for(const k of ['ok','error','ageMs','eventsInPlay','eventsLive','candidates','rejections'])assert.ok(k in s.feed,'missing feed.'+k);
 assert.deepEqual(Object.keys(s.limits).sort(),['dailyLossCapUsd','maxOpen','maxStakeUsd','priceTolerance']);
 assert.equal(s.feed.eventsLive,3);
 assert.ok(Number.isFinite(s.feed.ageMs)&&s.feed.ageMs>=0,'healthy feed age is never negative');
 assert.equal(s.suggested.legs.length,2);
 assert.equal(s.journal.stats.placed,0);
 assert.equal('autopilot' in s,false);
 const c=s.candidates[0];
 for(const k of ['key','symbol','side','eventSlug','event','league','marketType','question','outcome','price','bid','ask','spread','liveState','etaMinutes','nearEndScore','lateReason','feeCoefficient','feePerContract','netPrice','rank','comboEnabled','minimumTradeQty','freshnessSec'])assert.ok(k in c,'missing candidate.'+k);
 // A failing feed is reported as an error while the last-known events are retained;
 // their freshnessSec keeps counting up, so the place gate expires them at 90s.
 installFetch(()=>textRes('boom',500));
 const dead=await combos.usComboSnapshot({force:true});
 assert.equal(dead.feed.ok,false);
 assert.match(dead.feed.error,/boom|500/);
 assert.equal(dead.feed.ageMs>=0,true);
 // With no prior successful fetch there is nothing to show at all.
 reset();
 installFetch(()=>textRes('boom',500));
 const cold=await combos.usComboSnapshot({force:true});
 assert.equal(cold.feed.ok,false);
 assert.deepEqual(cold.candidates,[]);
 assert.equal(cold.suggested,null);
});

// ------------------------------------------------------- verifier blockers B1-B3, M2
test('quoting needs an armed session and enforces the stake cap before any signed call',async()=>{
 reset();
 const log=[];
 installFetch(u=>u.pathname==='/v1/events'?jsonRes(eventsResponse(liveEvents())):null,log);
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 await assert.rejects(combos.quoteUSCombo({legKeys:keys,stakeUsd:5}),e=>e.code==='notArmed');
 us.armPolymarketUS(true);
 await assert.rejects(combos.quoteUSCombo({legKeys:keys,stakeUsd:5000}),e=>e.code==='stakeCap');
 assert.equal(log.filter(x=>x.headers['X-PM-Access-Key']).length,0,'no signed request while a gate fails');
 us.armPolymarketUS(false);
});

test('an accepted quote is bound to the selected legs and to the requested stake',async()=>{
 reset();
 us.armPolymarketUS(true);
 const log=[];
 let quoteSymbol='caoc-other',qty='6.00';
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-mine',legs:JSON.parse(init.body).legs}});
  if(m==='GET'&&u.pathname==='/v1/rfqs/quotes')return jsonRes({quotes:[{id:'q1',rfqId:'r1',symbol:quoteSymbol,status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.810',buyQtyDecimal:qty}]});
  if(m==='PUT')return jsonRes({});
  return null;
 },log);
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 const req={legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'};
 await assert.rejects(combos.placeUSCombo(req),e=>e.code==='quoteMismatch');
 quoteSymbol='caoc-mine';qty='6172.83';
 await assert.rejects(combos.placeUSCombo(req),e=>e.code==='stakeCap'&&/notional/.test(e.message));
 assert.equal(log.filter(x=>/accept$|confirm$/.test(x.path)).length,0,'nothing may be accepted');
 qty='6.00';
 const placed=await combos.placeUSCombo(req);
 assert.equal(placed.entry.symbol,'caoc-mine');
 assert.equal(placed.entry.quantity,6);
 assert.equal(log.filter(x=>/accept$/.test(x.path)).length,1);
 us.armPolymarketUS(false);
});

test('concurrent placements are serialized so count-based gates cannot be raced',async()=>{
 reset();
 us.armPolymarketUS(true);
 process.env.POLYMARKET_US_COMBO_MAX_OPEN='1';
 const log=[];
 installFetch(async(u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-race',legs:[]}});
  if(m==='GET'&&u.pathname==='/v1/rfqs/quotes')return jsonRes({quotes:[{id:'q1',rfqId:'r1',symbol:'caoc-race',status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.810',buyQtyDecimal:'6.00'}]});
  if(m==='PUT'){await new Promise(r=>setTimeout(r,40));return jsonRes({})}
  return null;
 },log);
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 const req={legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'};
 const results=await Promise.allSettled([combos.placeUSCombo(req),combos.placeUSCombo(req),combos.placeUSCombo(req)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'exactly one placement may succeed');
 assert.ok(results.filter(r=>r.status==='rejected').every(r=>['busy','openCap','duplicate'].includes(r.reason.code)));
 assert.equal(log.filter(x=>/accept$/.test(x.path)).length,1,'exactly one accept round-trip');
 process.env.POLYMARKET_US_COMBO_MAX_OPEN='5';
 us.armPolymarketUS(false);
});

test('reconciliation cancels unfilled orders and verifies filled quantity before settlement',async()=>{
 reset();
 us.armPolymarketUS(true);
 let orderState={state:'ORDER_STATE_CANCELED',quantity:6.17,leavesQuantity:6.17},orderSeq=0;
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-fill',legs:[]}});
  if(m==='POST'&&u.pathname==='/v1/order/preview')return jsonRes({order:{}});
  if(m==='POST'&&u.pathname==='/v1/orders')return jsonRes({id:'ord-'+(++orderSeq)});
  if(m==='GET'&&/^\/v1\/order\//.test(u.pathname))return jsonRes({order:{id:u.pathname.split('/').pop(),...orderState}});
  if(m==='GET'&&/\/settlement$/.test(u.pathname))return jsonRes({settlementPrice:{value:'1.0000'},settledAt:'2026-09-14T22:00:00Z'});
  return null;
 });
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 const first=await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'limit',confirmation:'PLACE REAL COMBO'});
 assert.equal(first.entry.orderId,'ord-1');
 assert.equal(first.entry.fillVerified,false);
 let out=await combos.settleUSCombos({force:true});
 let saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(out.settled,0,'a cancelled order must not be settled as a win');
 assert.equal(saved.open.length,0);
 assert.equal(saved.history[0].status,'CANCELLED');
 assert.equal(saved.history[0].pnlUsd,0);
 assert.equal(Object.keys(saved.cooldowns).length,0,'cancellations do not start cooldowns');
 orderState={state:'ORDER_STATE_FILLED',quantity:6.17,leavesQuantity:0.17};
 await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'limit',confirmation:'PLACE REAL COMBO'});
 out=await combos.settleUSCombos({force:true});
 saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(out.settled,1);
 assert.equal(saved.history[0].status,'WON');
 assert.equal(saved.history[0].fillVerified,true);
 assert.equal(saved.history[0].quantity,6,'P/L uses the verified filled quantity');
 assert.equal(saved.history[0].payoutUsd,6);
 us.armPolymarketUS(false);
});

// ------------------------------------------------------- verifier cycle-2 blockers N1/N2
test('an auth error mid-reconcile never drops journal entries',async()=>{
 reset();
 us.armPolymarketUS(true);
 process.env.POLYMARKET_US_COMBO_MAX_OPEN='5';
 let seq=0;
 const pools=[liveEvents(),[soccerEvent('sd-ggg-hhh-2026-09-14',88),soccerEvent('se-iii-jjj-2026-09-14',89)],[soccerEvent('sf-kkk-lll-2026-09-14',88),soccerEvent('sg-mmm-nnn-2026-09-14',89)]];
 let poolIdx=0;
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(pools[poolIdx]));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-n1-'+poolIdx,legs:[]}});
  if(m==='POST'&&u.pathname==='/v1/order/preview')return jsonRes({order:{}});
  if(m==='POST'&&u.pathname==='/v1/orders')return jsonRes({id:'ord-'+(++seq)});
  if(m==='GET'&&/^\/v1\/order\//.test(u.pathname)){
   if(u.pathname.endsWith('ord-2'))return textRes(JSON.stringify({message:'API key not found'}),401);
   return jsonRes({order:{state:'ORDER_STATE_NEW',quantity:6.17,leavesQuantity:6.17}});
  }
  return null;
 });
 for(poolIdx=0;poolIdx<3;poolIdx++){
  const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
  await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'limit',confirmation:'PLACE REAL COMBO'});
 }
 let saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(saved.open.length,3);
 const r=await combos.reconcileUSOrders();
 assert.equal(r.aborted,'keyNotFound');
 saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(saved.open.length,3,'every funded entry must survive an auth failure mid-loop');
 assert.deepEqual(saved.open.map(x=>x.orderId),['ord-1','ord-2','ord-3']);
 us.armPolymarketUS(false);
});

test('settlement refuses to book P/L for orders whose fill was never verified',async()=>{
 reset();
 us.armPolymarketUS(true);
 let orderResponse=()=>jsonRes({order:{state:'ORDER_STATE_NEW',quantity:6.17,leavesQuantity:6.17}});
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-n2',legs:[]}});
  if(m==='POST'&&u.pathname==='/v1/order/preview')return jsonRes({order:{}});
  if(m==='POST'&&u.pathname==='/v1/orders')return jsonRes({id:'ord-n2'});
  if(m==='GET'&&/^\/v1\/order\//.test(u.pathname))return orderResponse();
  if(m==='GET'&&/\/settlement$/.test(u.pathname))return jsonRes({settlementPrice:{value:'1.0000'},settledAt:'2026-09-14T22:00:00Z'});
  return null;
 });
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'limit',confirmation:'PLACE REAL COMBO'});
 let out=await combos.settleUSCombos({force:true});
 let saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(out.settled,0,'a working, unfilled order is not a win');
 assert.equal(saved.open.length,1);
 assert.equal(saved.open[0].fillVerified,false);
 assert.equal(saved.stats.pnlUsd,0);
 orderResponse=()=>textRes('upstream exploded',500);
 out=await combos.settleUSCombos({force:true});
 saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(out.settled,0,'an unreachable order endpoint is not a win either');
 assert.equal(saved.open.length,1);
 assert.equal((await combos.usComboSnapshot({force:true})).journal.stats.unverified,1);
 orderResponse=()=>jsonRes({order:{state:'ORDER_STATE_FILLED',quantity:6.17,leavesQuantity:0}});
 out=await combos.settleUSCombos({force:true});
 saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(out.settled,1,'once the fill is verified the combo settles');
 assert.equal(saved.history[0].status,'WON');
 assert.equal(saved.history[0].quantity,6.17);
 us.armPolymarketUS(false);
});

// ------------------------------------------------------- cycle-3 majors: forget + accepted-deleted quotes
test('forget drops a stuck entry from the local book without P/L, cooldown or exchange calls',async()=>{
 reset();
 us.armPolymarketUS(true);
 const log=[];
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-forget',legs:[]}});
  if(m==='POST'&&u.pathname==='/v1/order/preview')return jsonRes({order:{}});
  if(m==='POST'&&u.pathname==='/v1/orders')return jsonRes({id:'ord-f1'});
  return null;
 },log);
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 const placed=await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'limit',confirmation:'PLACE REAL COMBO'});
 assert.throws(()=>combos.forgetUSCombo({id:placed.entry.id,confirmation:'yes'}),e=>e.code==='confirmation');
 assert.throws(()=>combos.forgetUSCombo({id:'nope',confirmation:'FORGET'}),e=>e.code==='notFound');
 const before=log.length;
 const r=combos.forgetUSCombo({id:placed.entry.id,confirmation:'FORGET'});
 assert.equal(r.entry.status,'FORGOTTEN');
 assert.equal(log.length,before,'forget never talks to the exchange');
 const saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(saved.open.length,0);
 assert.equal(saved.history[0].status,'FORGOTTEN');
 assert.equal(saved.stats.pnlUsd,0);
 assert.equal(saved.stats.won+saved.stats.lost,0);
 assert.equal(Object.keys(saved.cooldowns).length,0);
 // the slot and the legs are free again
 const again=await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'limit',confirmation:'PLACE REAL COMBO'});
 assert.equal(again.ok,true);
 us.armPolymarketUS(false);
});

test('an accepted quote that later disappears is kept open and unverified, never written off',async()=>{
 reset();
 us.armPolymarketUS(true);
 let quoteView={id:'q1',rfqId:'r1',symbol:'caoc-gone',status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.810',buyQtyDecimal:'6.00'};
 installFetch((u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-gone',legs:[]}});
  if(m==='GET'&&u.pathname==='/v1/rfqs/quotes')return jsonRes({quotes:[quoteView]});
  if(m==='PUT')return jsonRes({});
  return null;
 });
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 await combos.placeUSCombo({legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'});
 quoteView={...quoteView,status:'QUOTE_STATUS_DELETED',acceptedTime:'2026-09-14T22:00:00Z'};
 await combos.reconcileUSOrders();
 let saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(saved.open.length,1,'accepted-then-deleted stays on the open book');
 assert.equal(saved.open[0].fillVerified,false);
 quoteView={...quoteView,acceptedTime:undefined};
 await combos.reconcileUSOrders();
 saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.equal(saved.open.length,0,'a never-accepted deleted quote is a clean cancellation');
 assert.equal(saved.history[0].status,'CANCELLED');
 us.armPolymarketUS(false);
});

// ------------------------------------------------ settlement responsiveness (alpha42 port)
function settlementEntry({at,etaMinutes=10,legs=3,id='settle-fast'}={}){
 const xs=Array.from({length:legs},(_,i)=>({symbol:`settle-leg-${i+1}`,side:'SIDE_BUY',eventSlug:`settle-event-${i+1}`,etaMinutes}));
 return {id,at,symbol:`combo-${id}`,legs:xs,status:'OPEN',fillVerified:true,quantity:10,costUsd:8,payoutUsd:null,pnlUsd:null,settledAt:null};
}
function writeSettlementOpen(entries){
 fs.mkdirSync(path.dirname(combos.__testing.stateFile),{recursive:true});
 fs.writeFileSync(combos.__testing.stateFile,JSON.stringify({version:1,combos:{},open:entries,history:[],stats:{placed:entries.length,won:0,lost:0,pnlUsd:0,hitRate:null},autopilot:{enabled:false,stakeUsd:5,maxLegs:2,maxOpen:3,dailyLossCapUsd:50,lastRunAt:0,lastAction:null,skipped:[]},cooldowns:{}},null,2));
}
function fakeSettlementClock(t0=1_800_000_000_000){let t=t0;combos.__testing.setClock(()=>t);return {now:()=>t,set:n=>(t=n),add:n=>(t+=n),t0}}
const settlementCalls=log=>log.filter(x=>/\/settlement$/.test(x.path));

test('settlement cadence stays baseline before the slowest leg ETA, then tightens after ETA',async()=>{
 reset();
 const T0=1_800_000_000_000,clock=fakeSettlementClock(T0),log=[];
 writeSettlementOpen([settlementEntry({at:T0,etaMinutes:10,legs:2})]);combos.__testing.resetJournal();combos.__testing.setClock(()=>clock.now());
 installFetch((u,init)=>/\/settlement$/.test(u.pathname)?jsonRes({settlementPrice:{value:'0'},settledAt:null}):null,log);
 assert.equal(combos.comboDue(settlementEntry({at:T0,etaMinutes:10}),T0+10*60000-1),false);
 assert.equal(combos.comboDue(settlementEntry({at:T0,etaMinutes:10}),T0+10*60000),true);
 assert.equal((await combos.settleUSCombos()).ran,true);
 clock.add(combos.SETTLE_FAST.throttleMs);
 assert.equal((await combos.settleUSCombos()).reason,'throttled','15s is still too soon before ETA');
 clock.add(combos.__testing.SETTLE_THROTTLE_MS-combos.SETTLE_FAST.throttleMs);
 assert.equal((await combos.settleUSCombos()).ran,true,'30s baseline elapsed');
 clock.set(T0+10*60000);
 assert.equal((await combos.settleUSCombos()).ran,true,'ETA crossing may use the fast lane immediately');
 clock.add(combos.SETTLE_FAST.throttleMs-1);
 assert.equal((await combos.settleUSCombos()).reason,'throttled');
 clock.add(1);
 assert.equal((await combos.settleUSCombos()).ran,true,'post-ETA cadence is 15s');
});

test('pending settlement cache is 60s before ETA and 15s after ETA',async()=>{
 const T0=1_800_000_000_000;
 reset();let clock=fakeSettlementClock(T0),log=[];
 writeSettlementOpen([settlementEntry({at:T0,etaMinutes:10,legs:2})]);combos.__testing.resetJournal();combos.__testing.setClock(()=>clock.now());
 installFetch(u=>/\/settlement$/.test(u.pathname)?jsonRes({settlementPrice:{value:'0'},settledAt:null}):null,log);
 await combos.settleUSCombos({force:true});assert.equal(settlementCalls(log).length,2);
 clock.add(combos.SETTLE_FAST.pendingMs);await combos.settleUSCombos({force:true});assert.equal(settlementCalls(log).length,2,'pre-ETA cache remains 60s');
 clock.add(combos.__testing.SETTLE_CACHE_PENDING_MS-combos.SETTLE_FAST.pendingMs);await combos.settleUSCombos({force:true});assert.equal(settlementCalls(log).length,4);
 reset();clock=fakeSettlementClock(T0+10*60000);log=[];
 writeSettlementOpen([settlementEntry({at:T0,etaMinutes:10,legs:2})]);combos.__testing.resetJournal();combos.__testing.setClock(()=>clock.now());
 installFetch(u=>/\/settlement$/.test(u.pathname)?jsonRes({settlementPrice:{value:'0'},settledAt:null}):null,log);
 await combos.settleUSCombos({force:true});assert.equal(settlementCalls(log).length,2);
 clock.add(combos.SETTLE_FAST.pendingMs-1);await combos.settleUSCombos({force:true});assert.equal(settlementCalls(log).length,2);
 clock.add(1);await combos.settleUSCombos({force:true});assert.equal(settlementCalls(log).length,4,'post-ETA pending cache refreshes at 15s');
});

test('settlement reads are bounded-parallel and a three-leg combo can close in one pass',async()=>{
 reset();const T0=1_800_000_000_000,clock=fakeSettlementClock(T0+10*60000),log=[];
 writeSettlementOpen([settlementEntry({at:T0,etaMinutes:10,legs:3})]);combos.__testing.resetJournal();combos.__testing.setClock(()=>clock.now());
 let inFlight=0,peak=0,release;const gate=new Promise(r=>{release=r});
 installFetch(async u=>{
  if(!/\/settlement$/.test(u.pathname))return null;
  inFlight++;peak=Math.max(peak,inFlight);await gate;inFlight--;
  return jsonRes({settlementPrice:{value:'1.0000'},settledAt:'2026-09-16T04:00:00Z'});
 },log);
 const p=combos.settleUSCombos({force:true});
 for(let i=0;i<20&&inFlight<3;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(inFlight,3,'all three leg settlement reads are in flight together');assert.equal(peak,3);
 release();const out=await p;assert.equal(out.settled,1);assert.equal(settlementCalls(log).length,3);
 const saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));assert.equal(saved.open.length,0);assert.equal(saved.history[0].status,'WON');
});

test('settlement responsiveness leaves the real-money safety limits and confirmations unchanged',()=>{
 reset();
 assert.equal(combos.__testing.SETTLE_THROTTLE_MS,30000);
 assert.equal(combos.__testing.SETTLE_CACHE_PENDING_MS,60000);
 assert.equal(combos.__testing.SETTLE_CACHE_RESOLVED_MS,600000);
 assert.equal(combos.__testing.SETTLE_FETCH_CONCURRENCY,3);
 assert.deepEqual(combos.usComboLimits(),{maxStakeUsd:25,maxOpen:5,dailyLossCapUsd:50,priceTolerance:0.02});
 assert.equal(combos.__testing.CONFIRM_PLACE,'PLACE REAL COMBO');
});

// ------------------------------------------------------ owner settings (renovation step 3)
function pricedGame(slug,ask){
 const bid=(Number(ask)-0.01).toFixed(4);
 return soccerEvent(slug,88,{markets:[market({slug:`atc-${slug}-home`,bestAskQuote:{value:String(ask)},bestBidQuote:{value:bid}})]});
}

test('settings default to floor 0.80, 15 minutes, 3 legs and persist in journal.settings',async()=>{
 reset();
 assert.deepEqual(combos.usComboSettings(),{priceMin:0.8,maxMinutesLeft:15,maxLegs:3});
 assert.deepEqual(combos.setUSComboSettings({priceMin:0.6}),{priceMin:0.6,maxMinutesLeft:15,maxLegs:3});
 const saved=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));
 assert.deepEqual(saved.settings,{priceMin:0.6,maxMinutesLeft:15,maxLegs:3});
 installFetch(u=>u.pathname==='/v1/events'?jsonRes(eventsResponse([])):null);
 const snap=await combos.usComboSnapshot({force:true});
 assert.equal(snap.settings.priceMin,0.6);assert.equal(snap.settingsBounds.priceMin.min,0.6);
 assert.ok('suggested' in snap);
});

test('settings reject anything outside the fixed bounds and never widen them',()=>{
 reset();
 for(const bad of [{priceMin:0.59},{priceMin:0.99},{priceMin:'x'},{maxLegs:4},{maxLegs:1},{maxMinutesLeft:0},{maxMinutesLeft:31}]){
  assert.throws(()=>combos.setUSComboSettings(bad),e=>e.code==='settingsInvalid',JSON.stringify(bad));
 }
 assert.deepEqual(combos.usComboSettings(),{priceMin:0.8,maxMinutesLeft:15,maxLegs:3});
 // A hand-edited journal with out-of-range values falls back to the defaults, not the stored value.
 fs.writeFileSync(combos.__testing.stateFile,JSON.stringify({open:[],history:[],settings:{priceMin:0.1,maxLegs:9,maxMinutesLeft:15}}));
 combos.__testing.resetJournal();
 assert.deepEqual(combos.usComboSettings(),{priceMin:0.8,maxMinutesLeft:15,maxLegs:3});
});

test('a 0.65 leg passes at floor 0.60 and fails at 0.80, in the feed filter and in build',()=>{
 reset();
 const events=[pricedGame('sa-aaa-bbb-2026-09-25',0.65),pricedGame('sb-ccc-ddd-2026-09-25',0.9)];
 const at80=combos.usCandidatesFromEvents(events,Date.now(),{priceMin:0.8,maxMinutesLeft:15,maxLegs:3});
 assert.equal(at80.candidates.length,1);assert.equal(at80.rejections['price-band'],1);
 const at60=combos.usCandidatesFromEvents(events,Date.now(),{priceMin:0.6,maxMinutesLeft:15,maxLegs:3});
 assert.equal(at60.candidates.length,2);
 const legKeys=at60.candidates.map(c=>c.key);
 combos.setUSComboSettings({priceMin:0.6});
 const built=combos.buildUSCombo({legKeys,stakeUsd:5,candidates:at60.candidates});
 assert.equal(built.legs.length,2);assert.ok(built.price<0.6);
 // Raising the floor back re-rejects the same pool at build time (quote and place go through build too).
 combos.setUSComboSettings({priceMin:0.8});
 assert.throws(()=>combos.buildUSCombo({legKeys,stakeUsd:5,candidates:at60.candidates}),e=>e.code==='priceBand');
});

test('the minutes-left setting gates the feed',()=>{
 reset();
 const events=[pricedGame('sa-aaa-bbb-2026-09-25',0.9)];
 const eta=combos.usCandidatesFromEvents(events,Date.now(),{priceMin:0.8,maxMinutesLeft:30,maxLegs:3}).candidates[0].etaMinutes;
 assert.ok(eta>=1,'fixture must be at least a minute from the end');
 const tight=combos.usCandidatesFromEvents(events,Date.now(),{priceMin:0.8,maxMinutesLeft:Math.floor(eta)-0.5,maxLegs:3});
 assert.equal(tight.candidates.length,0);assert.equal(tight.rejections['turnover-window'],1);
});

test('a fourth leg is rejected at maxLegs 3, and a third at maxLegs 2',()=>{
 reset();
 const events=['sa','sb','sc','sd'].map(p=>pricedGame(`${p}-aaa-bbb-2026-09-25`,0.95));
 const {candidates}=combos.usCandidatesFromEvents(events,Date.now(),combos.usComboSettings());
 assert.equal(candidates.length,4);
 const keys=candidates.map(c=>c.key);
 assert.equal(combos.buildUSCombo({legKeys:keys.slice(0,3),stakeUsd:5,candidates}).legs.length,3);
 assert.throws(()=>combos.buildUSCombo({legKeys:keys,stakeUsd:5,candidates}),e=>e.code==='invalidLegs'&&/at most 3/.test(e.message));
 combos.setUSComboSettings({maxLegs:2});
 assert.throws(()=>combos.buildUSCombo({legKeys:keys.slice(0,3),stakeUsd:5,candidates}),e=>e.code==='invalidLegs');
 assert.equal(combos.chooseUSCombo(candidates,combos.usComboSettings().maxLegs).length,2);
});

test('settings refuse to overwrite a corrupt journal',()=>{
 reset();
 fs.writeFileSync(combos.__testing.stateFile,'{not json');
 combos.__testing.resetJournal();
 assert.throws(()=>combos.setUSComboSettings({priceMin:0.6}),e=>e.code==='stateRecovery');
 assert.equal(fs.readFileSync(combos.__testing.stateFile,'utf8'),'{not json');
});

// ------------------------------------------- journal before accept (renovation step 4)
function acceptHarness({accept,confirm}){
 const log=[],seen={onDiskAtAccept:null};
 installFetch(async(u,init)=>{
  const m=init.method||'GET';
  if(u.pathname==='/v1/events')return jsonRes(eventsResponse(liveEvents()));
  if(m==='POST'&&u.pathname==='/v1/combos')return jsonRes({combo:{id:'caoc-jba',legs:JSON.parse(init.body).legs}});
  if(m==='GET'&&u.pathname==='/v1/rfqs/quotes')return jsonRes({quotes:[{id:'q1',rfqId:'r1',symbol:'caoc-jba',status:'QUOTE_STATUS_ACTIVE',buyPrice:'0.810',buyQtyDecimal:'6.00'}]});
  if(m==='PUT'&&/accept$/.test(u.pathname)){
   seen.onDiskAtAccept=JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8')).open;
   return accept();
  }
  if(m==='PUT'&&/confirm$/.test(u.pathname))return confirm();
  return null;
 },log);
 return {log,seen};
}
async function placeReq(){
 const keys=(await combos.usComboSnapshot({force:true})).suggested.legs;
 return {legKeys:keys,stakeUsd:5,mode:'rfq',rfqId:'r1',quoteId:'q1',confirmation:'PLACE REAL COMBO'};
}
const onDisk=()=>JSON.parse(fs.readFileSync(combos.__testing.stateFile,'utf8'));

test('the journal entry is on disk, SUBMITTED and unverified, before the accept call',async()=>{
 reset();us.armPolymarketUS(true);
 const {seen}=acceptHarness({accept:()=>jsonRes({}),confirm:()=>jsonRes({})});
 const placed=await combos.placeUSCombo(await placeReq());
 assert.equal(seen.onDiskAtAccept.length,1);
 assert.equal(seen.onDiskAtAccept[0].id,placed.entry.id);
 assert.equal(seen.onDiskAtAccept[0].status,'SUBMITTED');assert.equal(seen.onDiskAtAccept[0].fillVerified,false);
 const j=onDisk();assert.equal(j.open.length,1);assert.equal(j.stats.placed,1);
 us.armPolymarketUS(false);
});

test('a definite accept rejection (4xx) removes the pre-written entry and counts nothing',async()=>{
 reset();us.armPolymarketUS(true);
 const {log,seen}=acceptHarness({accept:()=>jsonRes({message:'quote no longer active'},400),confirm:()=>jsonRes({})});
 await assert.rejects(combos.placeUSCombo(await placeReq()),e=>e.status===400);
 assert.equal(seen.onDiskAtAccept.length,1,'entry existed while accept was in flight');
 const j=onDisk();assert.equal(j.open.length,0);assert.equal(j.stats.placed,0);
 assert.equal(log.filter(x=>/confirm$/.test(x.path)).length,0,'never confirms after a failed accept');
 us.armPolymarketUS(false);
});

test('an ambiguous accept failure (network or 5xx) keeps the entry for reconcile',async()=>{
 for(const accept of [()=>{throw new Error('socket hang up')},()=>textRes('upstream down',502)]){
  reset();us.armPolymarketUS(true);
  acceptHarness({accept,confirm:()=>jsonRes({})});
  await assert.rejects(combos.placeUSCombo(await placeReq()));
  const j=onDisk();
  assert.equal(j.open.length,1);assert.equal(j.open[0].acceptUncertain,true);
  assert.equal(j.open[0].status,'SUBMITTED');assert.equal(j.open[0].fillVerified,false);
  assert.equal(j.stats.placed,1);
  us.armPolymarketUS(false);
 }
});

test('a confirm failure after a good accept keeps the entry unverified',async()=>{
 reset();us.armPolymarketUS(true);
 acceptHarness({accept:()=>jsonRes({}),confirm:()=>textRes('confirm window closed',500)});
 let entryId=null;
 await assert.rejects(combos.placeUSCombo(await placeReq()),e=>{entryId=e.entryId;return e.status===500});
 const j=onDisk();
 assert.equal(j.open.length,1);assert.equal(j.open[0].id,entryId);
 assert.match(j.open[0].confirmError,/confirm window closed/);
 assert.equal(j.open[0].status,'SUBMITTED');assert.equal(j.open[0].fillVerified,false);assert.equal(j.open[0].pnlUsd,null);
 assert.equal(j.stats.placed,1);
 us.armPolymarketUS(false);
});
