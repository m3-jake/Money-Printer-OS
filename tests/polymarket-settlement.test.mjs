import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-settle-'));
process.env.MONEY_PRINTER_DATA_DIR=dir;
process.env.POLYMARKET_AUTOSTART='false';

const savedFetch=globalThis.fetch;
const poly=await import('../src/polymarket.js');
const file=path.join(dir,'polymarket-paper.json');

let now=1_800_000_000_000;
const clock={now:()=>now,set:t=>now=t,add:ms=>now+=ms};
poly.__testing.setClock(()=>now);

const gammaCalls=[];
let marketById=new Map();
let closedMarketById=new Map();
let directMarketById=new Map();
let bookByToken=new Map();
let fetchFailIds=new Set();

function jsonRes(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})}
globalThis.fetch=async(url,options={})=>{
 const u=new URL(url);
 if(u.pathname.startsWith('/markets/')&&u.pathname!=='/markets/'){
  const id=decodeURIComponent(u.pathname.slice('/markets/'.length));
  gammaCalls.push({ids:[id],closed:null,path:u.pathname});
  if(fetchFailIds.has(String(id)))return new Response('nope',{status:503});
  const m=marketById.get(String(id))||closedMarketById.get(String(id))||directMarketById.get(String(id));
  if(!m)return new Response('gone',{status:404});
  return jsonRes(m);
 }
 if(u.pathname==='/markets'){
  const ids=u.searchParams.getAll('id');
  const closedOnly=u.searchParams.get('closed')==='true';
  gammaCalls.push({ids:ids.slice(),closed:closedOnly,path:u.pathname});
  if(ids.some(id=>fetchFailIds.has(String(id))))return new Response('nope',{status:503});
  const src=closedOnly?closedMarketById:marketById;
  return jsonRes(ids.map(id=>src.get(String(id))).filter(Boolean));
 }
 if(u.pathname==='/books'){
  const body=JSON.parse(options.body||'[]');
  return jsonRes(body.map(x=>{
   const b=bookByToken.get(String(x.token_id));
   if(!b)return null;
   return {asset_id:String(x.token_id),bids:b.bids||[],asks:b.asks||[],tick_size:'0.01'};
  }).filter(Boolean));
 }
 throw new Error('Unexpected test request '+url);
};

function writePaper(patch){
 const s={cashUsd:25,startUsd:25,positions:[],history:[],autopilot:{enabled:false,mode:'both',stakeSingleUsd:1,stakeComboUsd:2.5,maxOpenPct:65},createdAt:now,...patch};
 fs.writeFileSync(file,JSON.stringify(s));
 return s;
}
function read(){return JSON.parse(fs.readFileSync(file,'utf8'))}
function single({id='p1',marketId='m1',tokenId='t1',createdAt=now,stakeUsd=1,fillPrice=.9,etaMinutes=12,kind='single',legs}={}){
 const leg={marketId,tokenId,outcome:'Yes',outcomeIndex:0,price:fillPrice,fillPrice,feesEnabled:false,timing:{etaMinutes,reason:'test'}};
 return {id,createdAt,status:'OPEN',kind,stakeUsd,shares:stakeUsd/fillPrice,fillPrice,feeUsd:0,decimalOdds:1/fillPrice,
  potentialPayoutUsd:kind==='single'?stakeUsd/fillPrice:null,placedBy:'test',legs:legs||[leg]};
}

test.beforeEach(()=>{
 now=1_800_000_000_000;gammaCalls.length=0;marketById=new Map();closedMarketById=new Map();directMarketById=new Map();
 bookByToken=new Map();fetchFailIds=new Set();
 poly.__testing.resetSettlement();poly.__testing.setClock(()=>now);writePaper({});
});
test.after(()=>{poly.__testing.setClock(null);poly.stopPolymarketLoops();globalThis.fetch=savedFetch;fs.rmSync(dir,{recursive:true,force:true})});

test('gamma loser books LOST and does not return stake',async()=>{
 writePaper({cashUsd:24,positions:[single()]});
 marketById.set('m1',{id:'m1',closed:true,outcomes:['Yes','No'],outcomePrices:[0,1]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.settled,1);assert.equal(r.results[0].status,'LOST');assert.equal(r.results[0].pnlUsd,-1);
 assert.equal(read().cashUsd,24);assert.equal(read().positions.length,0);assert.equal(read().history[0].settlementSource,'gamma-market');
});

test('near-binary prices are not confirmed settlement outcomes',async()=>{
 writePaper({cashUsd:23,positions:[single({id:'win',marketId:'mw',tokenId:'tw',fillPrice:.95}),single({id:'lose',marketId:'ml',tokenId:'tl',fillPrice:.9})]});
 marketById.set('mw',{id:'mw',closed:true,outcomes:['Yes','No'],outcomePrices:[.995,.005]});
 marketById.set('ml',{id:'ml',closed:true,outcomes:['Yes','No'],outcomePrices:[.004,.996]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.settled,0);assert.equal(read().positions.length,2);assert.equal(read().cashUsd,23);
});

test('only explicitly cancelled markets void and return stake',async()=>{
 writePaper({cashUsd:23,positions:[
  single({id:'cxl',marketId:'mc'}),
  single({id:'mid',marketId:'mm',tokenId:'tm'})
 ]});
 marketById.set('mc',{id:'mc',closed:true,cancelled:true,outcomes:['Yes','No'],outcomePrices:[.5,.5]});
 marketById.set('mm',{id:'mm',closed:true,outcomes:['Yes','No'],outcomePrices:[.5,.5]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.settled,1,'non-binary closed stays pending until stale; cancelled voids now');
 assert.equal(r.results[0].id,'cxl');assert.equal(r.results[0].status,'VOID');assert.equal(r.results[0].settlementSource,'gamma-cancel');
 assert.equal(read().cashUsd,24);
 now+=poly.__testing.STALE_TIMEOUT_MS;
 poly.__testing.resetSettlement();
 const stale=await poly.settlePaperPositions();
 assert.equal(stale.settled,0);assert.equal(read().positions[0].id,'mid');assert.equal(read().cashUsd,24);
});

test('stale still-open games retain exposure without refunds',async()=>{
 writePaper({cashUsd:24,positions:[single({createdAt:now})]});
 marketById.set('m1',{id:'m1',closed:false,outcomes:['Yes','No'],outcomePrices:[.9,.1]});
 assert.equal((await poly.settlePaperPositions()).settled,0);
 now+=poly.__testing.STALE_TIMEOUT_MS-1;
 poly.__testing.resetSettlement();
 assert.equal((await poly.settlePaperPositions()).settled,0);
 now+=2;
 poly.__testing.resetSettlement();
 const r=await poly.settlePaperPositions();
 assert.equal(r.settled,0);assert.equal(read().cashUsd,24);assert.equal(read().positions.length,1);
 assert.equal(poly.paperSettlementAudit(read(),now).overdueCount,1);
});

test('missing markets and failed lookups never refund unresolved exposure',async()=>{
 writePaper({cashUsd:24,positions:[single({id:'miss',marketId:'gone'})]});
 const first=await poly.settlePaperPositions();
 assert.equal(first.settled,0);assert.ok(read().positions[0].missingSince);
 now+=poly.__testing.MISSING_VOID_MS+1;
 poly.__testing.resetSettlement();
 const second=await poly.settlePaperPositions();
 assert.equal(second.settled,0);assert.equal(read().cashUsd,24);assert.equal(read().positions.length,1);
 const hist=read().history.length;
 poly.__testing.resetSettlement();
 const third=await poly.settlePaperPositions();
 assert.equal(third.settled,0);assert.equal(read().history.length,hist);

 writePaper({cashUsd:24,positions:[single({id:'fail',marketId:'boom'})]});
 fetchFailIds.add('boom');
 poly.__testing.resetSettlement();
 assert.equal((await poly.settlePaperPositions()).settled,0);
 now+=poly.__testing.STALE_TIMEOUT_MS+1;
 poly.__testing.resetSettlement();
 const failed=await poly.settlePaperPositions();
 assert.equal(failed.settled,0);assert.equal(read().cashUsd,24);assert.equal(read().positions.length,1);
});

test('empty bid book does not invent a crushed loss',async()=>{
 writePaper({cashUsd:24,positions:[single({tokenId:'tempty'})]});
 marketById.set('m1',{id:'m1',closed:false,outcomes:['Yes','No'],outcomePrices:[.9,.1]});
 bookByToken.set('tempty',{bids:[],asks:[{price:.9,size:'100'}]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.settled,0);assert.equal(read().positions.length,1);
});

test('mark-to-bid records crushed losers instead of leaving them OPEN',async()=>{
 writePaper({cashUsd:24,positions:[single({fillPrice:.92,tokenId:'tlose'})]});
 marketById.set('m1',{id:'m1',closed:false,outcomes:['Yes','No'],outcomePrices:[.02,.98]});
 bookByToken.set('tlose',{bids:[{price:.01,size:'100'}],asks:[{price:.02,size:'100'}]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.settled,1);assert.equal(r.results[0].status,'LOST');assert.equal(r.results[0].settlementSource,'mark-to-bid');
 assert.ok(r.results[0].pnlUsd<0);assert.equal(read().positions.length,0);
});

test('profitable early-exit still books WON from executable bids',async()=>{
 writePaper({cashUsd:24,positions:[single({fillPrice:.9,tokenId:'twin'})]});
 marketById.set('m1',{id:'m1',closed:false,outcomes:['Yes','No'],outcomePrices:[.99,.01]});
 bookByToken.set('twin',{bids:[{price:.99,size:'100'}],asks:[{price:.995,size:'100'}]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.results[0].status,'WON');assert.equal(r.results[0].settlementSource,'early-exit');
 assert.ok(r.results[0].pnlUsd>0);assert.ok(read().cashUsd>24);
});

test('throttled refresh dedupes in-flight and within the fake-clock window',async()=>{
 writePaper({cashUsd:24,positions:[single()]});
 marketById.set('m1',{id:'m1',closed:false,outcomes:['Yes','No'],outcomePrices:[.9,.1]});
 const [a,b]=await Promise.all([poly.settlePaperPositionsThrottled(),poly.settlePaperPositionsThrottled()]);
 assert.equal(a,b);
 const first=gammaCalls.length;
 const again=await poly.settlePaperPositionsThrottled();
 assert.equal(again,a);
 assert.equal(gammaCalls.length,first,'cached throttle must not refetch');
 now+=poly.__testing.SETTLEMENT_THROTTLE_MS+1;
 const later=await poly.settlePaperPositionsThrottled();
 assert.notEqual(later,a);
 assert.ok(gammaCalls.length>first);
});

test('combo with one lost leg is LOST even if the other is still pending or missing',async()=>{
 const legs=[
  {marketId:'a',tokenId:'ta',outcome:'Yes',outcomeIndex:0,price:.91,fillPrice:.91,feesEnabled:false,timing:{etaMinutes:14}},
  {marketId:'b',tokenId:'tb',outcome:'Yes',outcomeIndex:0,price:.96,fillPrice:.96,feesEnabled:false,timing:{etaMinutes:11}}
 ];
 writePaper({cashUsd:22.5,positions:[single({id:'combo-pending',kind:'combo',stakeUsd:2.5,fillPrice:null,legs})]});
 marketById.set('a',{id:'a',closed:true,outcomes:['Yes','No'],outcomePrices:[0,1]});
 marketById.set('b',{id:'b',closed:false,outcomes:['Yes','No'],outcomePrices:[.96,.04]});
 let r=await poly.settlePaperPositions();
 assert.equal(r.results[0].status,'LOST');assert.equal(r.results[0].pnlUsd,-2.5);assert.equal(read().cashUsd,22.5);

 writePaper({cashUsd:22.5,positions:[single({id:'combo-miss',kind:'combo',stakeUsd:2.5,fillPrice:null,legs})]});
 marketById=new Map([['a',{id:'a',closed:true,outcomes:['Yes','No'],outcomePrices:[0,1]}]]);
 poly.__testing.resetSettlement();
 r=await poly.settlePaperPositions();
 assert.equal(r.results[0].id,'combo-miss');assert.equal(r.results[0].status,'LOST');assert.equal(read().positions.length,0);
});

test('combo with one lost leg is LOST even if the other would win',async()=>{
 const legs=[
  {marketId:'a',tokenId:'ta',outcome:'Yes',outcomeIndex:0,price:.91,fillPrice:.91,feesEnabled:false,timing:{etaMinutes:14}},
  {marketId:'b',tokenId:'tb',outcome:'Yes',outcomeIndex:0,price:.96,fillPrice:.96,feesEnabled:false,timing:{etaMinutes:11}}
 ];
 writePaper({cashUsd:22.5,positions:[single({id:'combo',kind:'combo',stakeUsd:2.5,fillPrice:null,legs})]});
 marketById.set('a',{id:'a',closed:true,outcomes:['Yes','No'],outcomePrices:[0,1]});
 marketById.set('b',{id:'b',closed:true,outcomes:['Yes','No'],outcomePrices:[1,0]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.results[0].status,'LOST');assert.equal(r.results[0].pnlUsd,-2.5);assert.equal(read().cashUsd,22.5);
});

test('censoring-aware metrics drop a 42-0 early-exit book with stale opens',()=>{
 const T0=now-40*3600*1000;
 const history=Array.from({length:42},(_,i)=>({id:'h'+i,kind:'single',status:'WON',stakeUsd:1,pnlUsd:0.056,createdAt:T0+i*60000,settledAt:T0+i*60000+7*60000,
  settlementSource:'early-exit',fillPrice:.93,legs:[{result:'won',fillPrice:.93,price:.93}]}));
 const positions=[
  single({id:'s1',createdAt:now-23*3600*1000,fillPrice:.95}),
  single({id:'s2',createdAt:now-26*3600*1000,fillPrice:.91,marketId:'m2'}),
  single({id:'s3',createdAt:now-27*3600*1000,fillPrice:.86,marketId:'m3'}),
  single({id:'s4',createdAt:now-33*3600*1000,fillPrice:.84,marketId:'m4'}),
  single({id:'c1',kind:'combo',stakeUsd:2.5,createdAt:now-38*3600*1000,fillPrice:null,legs:[
   {marketId:'ca',fillPrice:.91,price:.91,timing:{etaMinutes:14}},{marketId:'cb',fillPrice:.964,price:.964,timing:{etaMinutes:11}}
  ]})
 ];
 const paper={cashUsd:21.28486,startUsd:25.22568,history,positions,createdAt:T0};
 const m=poly.paperResearchMetrics(paper,now);
 assert.equal(m.closed,42);assert.equal(m.wins,42);assert.equal(m.hitRate,1);
 assert.ok(Math.abs(m.realizedRoi-0.056)<1e-9);
 assert.equal(m.settlement.overdueCount,5);
 assert.ok(m.conservativeRoi<0);
 assert.equal(m.verdict,'DROP');assert.equal(m.keep,false);
 assert.ok(m.exposureAdjustedEquityUsd<m.equityUsd);
 assert.equal(m.buckets.every(b=>b.n===0),true,'early-exit must not calibrate hit rate');
 assert.equal(m.settlement.pauseAutopilot,true);
 assert.equal(m.settlement.earlyExits,42);assert.equal(m.settlement.gammaResolved,0);
 assert.ok(m.settlement.timeToSettlement.median>0);
});

test('closed Gamma list recovers resolved markets the live list hides',async()=>{
 writePaper({cashUsd:24,positions:[single({id:'hid',marketId:'mh',tokenId:'th',fillPrice:.9})]});
 closedMarketById.set('mh',{id:'mh',closed:true,outcomes:['Yes','No'],outcomePrices:[0,1]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.settled,1);assert.equal(r.results[0].status,'LOST');assert.equal(r.results[0].settlementSource,'gamma-market');
 assert.ok(gammaCalls.some(c=>c.closed===false));assert.ok(gammaCalls.some(c=>c.closed===true));
 assert.equal(read().cashUsd,24);assert.equal(read().history[0].status,'LOST');
});

test('GET /markets/{id} recovers a closed market both list queries hide',async()=>{
 writePaper({cashUsd:24,positions:[single({id:'direct',marketId:'md',tokenId:'td'})]});
 directMarketById.set('md',{id:'md',closed:true,outcomes:['Yes','No'],outcomePrices:[0,1]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.results[0].status,'LOST');assert.equal(r.results[0].settlementSource,'gamma-market');
 assert.ok(gammaCalls.some(c=>String(c.path||'').startsWith('/markets/')));
});

test('2026-09-16 paper journal is 42 early-exit wins; closed Gamma books four lost singles and the combo win',async()=>{
 const paper=JSON.parse(fs.readFileSync(new URL('./fixtures/polymarket-paper-20260916.json',import.meta.url),'utf8'));
 const auditNow=1_789_568_307_987;
 const before=poly.paperResearchMetrics(paper,auditNow);
 assert.equal(before.closed,42);assert.equal(before.wins,42);assert.equal(before.keep,false);assert.equal(before.verdict,'DROP');
 assert.equal(before.settlement.earlyExits,42);assert.equal(before.settlement.gammaResolved,0);assert.equal(before.settlement.overdueCount,5);
 assert.ok(before.realizedRoi>0);assert.ok(before.conservativeRoi<0);
 assert.equal(before.buckets.every(b=>b.n===0),true);

 writePaper(paper);
 for(const [id,m] of [
  ['4542172',{id:'4542172',closed:true,outcomes:['Weronika Falkowska','Kristina Novak'],outcomePrices:[1,0]}],
  ['4528120',{id:'4528120',closed:true,outcomes:['Jennifer Ruggeri','Eva Vedder'],outcomePrices:[1,0]}],
  ['4528112',{id:'4528112',closed:true,outcomes:['Alicia Herrero Linana','Lucia Cortez Llorca'],outcomePrices:[1,0]}],
  ['4363835',{id:'4363835',closed:true,outcomes:['Miami Marlins','Arizona Diamondbacks'],outcomePrices:[0,1]}],
  ['4063862',{id:'4063862',closed:true,outcomes:['Yes','No'],outcomePrices:[0,1]}],
  ['4118850',{id:'4118850',closed:true,outcomes:['CA Lanús','CD Riestra'],outcomePrices:[1,0]}]
 ])closedMarketById.set(id,m);

 const r=await poly.settlePaperPositions();
 assert.equal(r.settled,5);
 const byId=Object.fromEntries(r.results.map(x=>[x.id,x]));
 assert.equal(byId.poly_1789484610316_oahyi.status,'LOST');
 assert.equal(byId.poly_1789472275587_9ch8q.status,'LOST');
 assert.equal(byId.poly_1789470773700_5k8sw.status,'LOST');
 assert.equal(byId.poly_1789446029801_ys93x.status,'LOST');
 assert.equal(byId.poly_1789429556342_oa6l9.status,'WON');
 assert.ok(byId.poly_1789429556342_oa6l9.pnlUsd>0);
 assert.equal(read().positions.length,0);
 const after=poly.paperResearchMetrics(read(),auditNow);
 assert.equal(after.keep,false);assert.equal(after.verdict,'DROP');
 assert.equal(after.settlement.gammaResolved,5);assert.equal(after.settlement.overdueCount,0);
 assert.ok(after.realizedRoi<0);assert.equal(after.wins,43);assert.equal(after.losses,4);
});

test('real-money gate stays locked and settlement never uses API-key auth',()=>{
 const r=poly.realPolymarketReadiness();
 assert.equal(r.enabled,false);
 const src=fs.readFileSync(new URL('../src/polymarket.js',import.meta.url),'utf8');
 assert.doesNotMatch(src,/XAI_API_KEY/);
 assert.match(src,/Real execution is intentionally locked/);
 assert.match(src,/closed=true/);
});


test('malformed resolution data never manufactures a loss',async()=>{
 for(const prices of [undefined,[],[null,1],['',1],['bad',1],[-1,2]]){
  writePaper({cashUsd:24,positions:[single()]});
  marketById.set('m1',{id:'m1',closed:true,outcomes:['Yes','No'],outcomePrices:prices});
  const r=await poly.settlePaperPositions();
  assert.equal(r.settled,0);assert.equal(read().cashUsd,24);
 }
 const r=poly.__testing.legResolution({closed:true,outcomes:['Home','Away'],outcomePrices:[0,1]},{outcome:'Unknown',outcomeIndex:0});
 assert.equal(r.result,'pending');assert.equal(r.resolvedPrice,null);
});

test('thin bid liquidity cannot fabricate a total realized loss',async()=>{
 writePaper({cashUsd:24,positions:[single({fillPrice:.92,tokenId:'thin'})]});
 marketById.set('m1',{id:'m1',closed:false,outcomes:['Yes','No'],outcomePrices:[.02,.98]});
 bookByToken.set('thin',{bids:[{price:.01,size:'.001'}],asks:[{price:.02,size:'100'}]});
 const r=await poly.settlePaperPositions();
 assert.equal(r.settled,0);assert.equal(read().cashUsd,24);assert.equal(read().positions.length,1);
});
