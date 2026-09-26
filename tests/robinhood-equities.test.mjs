// Robinhood stocks & ETFs paper lane (docs/ROBINHOOD-AUTO-TRADER.md §25). Mocked fetch only: any real network call fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,...rest)=>{const u=new URL(url);if(u.hostname==='127.0.0.1')return nativeFetch(url,...rest);throw new Error('network disabled in tests: '+u.hostname)};
const Cal=await import('../src/robinhoodEquitiesCalendar.js');
const Data=await import('../src/robinhoodEquitiesData.js');
const Strat=await import('../src/robinhoodEquitiesStrategy.js');
const Book=await import('../src/robinhoodEquitiesBook.js');
const Eq=await import('../src/robinhoodEquities.js');

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rheq-'));
const ET=(date,h,m=0)=>Cal.etToUtcMs(date,h,m);
function sessions(from,to){const out=[];let d=Cal.isSession(from)?from:Cal.nextSession(from);while(d&&d<=to){out.push(d);d=Cal.nextSession(d)}return out}
const UNIVERSE=['SPY','QQQ','IWM','EFA','EEM','VNQ','GLD','DBC','IEF','BIL'];
const DRIFT={SPY:0.0006,QQQ:0.0008,IWM:0.0002,EFA:0.0003,EEM:-0.0001,VNQ:0.0001,GLD:0.0005,DBC:-0.0002,IEF:0.00005,BIL:0.00015};
function synthBars(to,{crashFrom=null}={}){
 const ds=sessions('2024-01-02',to);const out={};
 for(const s of UNIVERSE){let p=100;out[s]=ds.map((d,i)=>{const drift=crashFrom&&d>=crashFrom&&s!=='BIL'&&s!=='IEF'?-0.01:DRIFT[s];const o=p*(1+Math.sin(i*1.3+s.length)*0.001);p=p*(1+drift+Math.sin(i*0.7+s.charCodeAt(0))*0.004);return {d,o:+o.toFixed(4),h:+(Math.max(o,p)*1.002).toFixed(4),l:+(Math.min(o,p)*0.998).toFixed(4),c:+p.toFixed(4),v:1000}})}
 return out;
}
// Alpaca-shaped mock: t = midnight New York as RFC3339 UTC.
function alpacaFetch(bars,calls){return async(url,init)=>{
 const u=new URL(url);calls.push({url:u,init});
 assert.equal(u.hostname,'data.alpaca.markets');assert.equal(init.method,'GET');
 assert.ok(!/robinhood/i.test(url),'never a Robinhood endpoint');
 const syms=u.searchParams.get('symbols').split(',');const out={};
 for(const s of syms)out[s]=(bars[s]||[]).map(b=>({t:new Date(ET(b.d,0)).toISOString(),o:b.o,h:b.h,l:b.l,c:b.c,v:b.v}));
 return {ok:true,status:200,json:async()=>({bars:out,next_page_token:null})};
}}
const KEYS={ALPACA_KEY_ID:'test-id',ALPACA_SECRET_KEY:'test-secret',ROBINHOOD_EQUITIES_DATA:'alpaca'};

test('calendar: holidays, early closes, DST and completed-session rules',()=>{
 assert.equal(Cal.isSession('2026-07-03'),false,'Independence Day observed');
 assert.equal(Cal.isSession('2026-09-26'),false,'Saturday');
 assert.equal(Cal.lastCompletedSession(Date.parse('2026-09-26T15:00:00Z')),'2026-09-25');
 assert.equal(new Date(Cal.sessionFor('2026-11-27').closeMs).toISOString(),'2026-11-27T18:00:00.000Z');
 assert.equal(new Date(Cal.sessionFor('2026-03-06').openMs).toISOString(),'2026-03-06T14:30:00.000Z');
 assert.equal(new Date(Cal.sessionFor('2026-03-09').openMs).toISOString(),'2026-03-09T13:30:00.000Z');
 assert.equal(new Date(Cal.sessionFor('2026-11-02').openMs).toISOString(),'2026-11-02T14:30:00.000Z');
 assert.equal(Cal.lastCompletedSession(ET('2026-09-24',16,10)),'2026-09-23','close not settled yet');
 assert.equal(Cal.lastCompletedSession(ET('2026-09-24',16,31)),'2026-09-24');
 assert.equal(Cal.nextSession('2026-07-02'),'2026-07-06');
 assert.equal(Cal.isSession('2028-01-03'),false,'fails closed past the table');
 assert.equal(Cal.lastCompletedSession(Date.parse('2028-02-01T20:00:00Z')),null);
 assert.equal(Cal.nextOpenAfter(ET('2026-09-25',16,45)),'2026-09-28');
 assert.equal(Cal.nextOpenAfter(ET('2026-09-28',9,0)),'2026-09-28');
});

test('data: NO_DATA without a key, no fetch; invalid symbols rejected; partial bars dropped; Alpaca shape parsed',async()=>{
 const dir=tmp();const calls=[];const now=ET('2026-09-25',17,0);
 const r=await Data.refreshBars(dir,['SPY'],{now,env:{},fetchImpl:alpacaFetch({},calls)});
 assert.equal(r.reason,'NO_DATA');assert.equal(calls.length,0);
 assert.equal(Data.dataStatus(r.store,['SPY'],now,{}).status,'NO_DATA');
 assert.match(Data.dataStatus(r.store,['SPY'],now,{}).reason,/ALPACA_KEY_ID/);
 assert.equal(Data.validSymbol('SPY'),true);assert.equal(Data.validSymbol('BTC-USD'),false);assert.equal(Data.validSymbol('spy'),false);
 const bars=synthBars('2026-09-28');
 const r2=await Data.refreshBars(dir,['SPY','QQQ'],{now,env:KEYS,fetchImpl:alpacaFetch(bars,calls)});
 assert.equal(r2.fetched,true);assert.equal(calls.length,1);
 assert.equal(calls[0].init.headers['APCA-API-KEY-ID'],'test-id');assert.equal(calls[0].url.searchParams.get('adjustment'),'all');
 assert.equal(r2.store.bars.SPY.at(-1).d,'2026-09-25','bars after the last completed session are dropped');
 assert.equal(Data.dataStatus(r2.store,['SPY','QQQ'],now,KEYS).status,'FRESH');
 const r3=await Data.refreshBars(dir,['SPY','QQQ'],{now,env:KEYS,fetchImpl:alpacaFetch(bars,calls)});
 assert.equal(r3.reason,'FRESH');assert.equal(calls.length,1,'no refetch when fresh');
 assert.equal(Data.dataStatus(r3.store,['SPY','QQQ'],ET('2026-09-29',17,0),KEYS).status,'STALE');
 const bad=async()=>({ok:false,status:500,json:async()=>({})});
 const r4=await Data.refreshBars(dir,['SPY','QQQ'],{now:ET('2026-09-29',17,0),env:KEYS,fetchImpl:bad});
 assert.equal(r4.reason,'ERROR');assert.equal(r4.store.bars.SPY.at(-1).d,'2026-09-25','old bars kept on error');
 const r5=await Data.refreshBars(dir,['SPY','QQQ'],{now:ET('2026-09-29',17,5),env:KEYS,fetchImpl:bad});
 assert.equal(r5.reason,'BUDGET');
});

test('strategy: no lookahead, deterministic hash, trend exits in a crash, month-end rotation',()=>{
 const bars=synthBars('2026-09-25');
 const a=Strat.targetWeights('tactical-a',{},bars,'2026-06-15');
 assert.equal(a.ready,true,a.reasons.join());
 assert.ok(Math.abs(Object.values(a.weights).reduce((x,y)=>x+y,0)-1)<1e-9);
 const future=structuredClone(bars);for(const s of UNIVERSE)for(const r of future[s])if(r.d>'2026-06-15'){r.c*=3;r.o*=3}
 assert.deepEqual(Strat.targetWeights('tactical-a',{},future,'2026-06-15'),a,'bars after asOf never change the decision');
 assert.equal(a.detail.rotationAsOf,'2026-05-29');
 assert.equal(Strat.paramsHash('tactical-a',Strat.normalizeParams('tactical-a',{})),Strat.paramsHash('tactical-a',Strat.normalizeParams('tactical-a',{})));
 assert.equal(Strat.normalizeParams('tactical-a',{smaDays:5}).smaDays,100,'bounds clamp');
 const crash=synthBars('2026-09-25',{crashFrom:'2026-08-01'});
 const c=Strat.targetWeights('tactical-a',{},crash,'2026-09-25');
 assert.equal(c.detail.trend,'OUT');assert.ok(c.weights.BIL>=0.5-1e-9,'trend sleeve in T-bills');
 assert.equal(Strat.targetWeights('tactical-a',{},synthBars('2024-06-01'),'2024-05-31').ready,false,'not enough history');
});

test('baseline replay: strategy vs buy-and-hold SPY vs cash on the same window',()=>{
 const bars=synthBars('2026-09-25',{crashFrom:'2026-08-01'});
 const from=bars.SPY.find(r=>Strat.targetWeights('tactical-a',{},bars,r.d).ready).d;
 const s=Strat.replay('tactical-a',{},bars,{from});const b=Strat.replay('buy-hold',{},bars,{from});
 assert.equal(s.stats.from,b.stats.from);assert.ok(s.trades>0);
 assert.ok(s.stats.maxDrawdownPct<b.stats.maxDrawdownPct,'trend filter cuts the crash drawdown');
});

test('book: fees, fractional flooring, $1 minimum, T+1 settled cash',()=>{
 assert.deepEqual(Book.sellFees(500,10),{sec:0,taf:0});
 assert.deepEqual(Book.sellFees(10000,100),{sec:0.21,taf:0.02});
 assert.equal(Book.sellFees(1e7,1e6).taf,9.79);
 const b=Book.newBook({startUsd:1000,slippageBps:10});
 b.pending={decidedAt:'x',decidedForSession:'2026-09-24',executeAtOpenOf:'2026-09-25',targets:{SPY:0.6,QQQ:0.4}};
 const f=Book.fillPending(b,{session:'2026-09-25',openOf:s=>({SPY:700,QQQ:300})[s],settlesOn:'2026-09-28'});
 assert.equal(f.length,2);assert.equal(b.pending,null);
 assert.ok(Math.abs(b.positions.SPY.qty*700.7-600)<0.01);assert.equal(Math.round(b.positions.SPY.qty*1e6),Math.round(b.positions.SPY.qty*1e6*1e3)/1e3);
 assert.ok(b.settledCashUsd>=0);
 b.pending={decidedAt:'x',targets:{GLD:1}};
 const f2=Book.fillPending(b,{session:'2026-09-28',openOf:s=>({SPY:700,QQQ:300,GLD:200})[s],settlesOn:'2026-09-29'});
 assert.deepEqual(f2.map(x=>x.side),['sell','sell']);
 assert.ok(!b.positions.GLD,'proceeds unsettled on trade date: no buy');
 assert.ok(b.unsettled.length===2&&b.unsettled.every(u=>u.settlesOn==='2026-09-29'));
 Book.settle(b,'2026-09-29');assert.equal(b.unsettled.length,0);assert.ok(b.settledCashUsd>990);
});

test('book: corrupt file forces recovery and is never overwritten',()=>{
 const dir=tmp();fs.writeFileSync(Book.bookFile(dir),'{not json');
 const b=Book.loadBook(dir);assert.equal(b.recoveryRequired,true);
 assert.equal(Book.saveBook(dir,b),false);assert.equal(fs.readFileSync(Book.bookFile(dir),'utf8'),'{not json');
});

test('controller: decide once per session, fill at next open exactly once, late fill after PC off, snapshot shape',async()=>{
 const dir=tmp();const bars=synthBars('2026-10-02');const calls=[];const fetchImpl=alpacaFetch(bars,calls);const env={...KEYS};
 // Friday 2026-09-25 after close: decide, queue for Monday.
 let r=await Eq.runEquitiesOnce({now:ET('2026-09-25',17,0),env,fetchImpl,dataDir:dir});
 assert.ok(r.events.some(e=>e.startsWith('QUEUED for 2026-09-28')),r.events.join());
 assert.equal(r.book.lastDecidedSession,'2026-09-25');
 r=await Eq.runEquitiesOnce({now:ET('2026-09-25',18,0),env,fetchImpl,dataDir:dir});
 assert.deepEqual(r.events,[],'no second decision, no fill before the fill bar exists');
 // PC off Monday; back Tuesday evening: fill at Monday open (the first open after the decision), not late.
 r=await Eq.runEquitiesOnce({now:ET('2026-09-29',17,0),env,fetchImpl,dataDir:dir});
 assert.ok(r.events.some(e=>e.startsWith('FILLED 2026-09-28')),r.events.join());
 assert.ok(r.book.history.length>0);
 for(const h of r.book.history){assert.equal(h.session,'2026-09-28');assert.equal(h.late,false);assert.ok(h.fillPrice>=bars[h.symbol].find(x=>x.d==='2026-09-28').o)}
 assert.equal(r.book.missedSessions,1,'Monday was missed, never decided after the fact');
 assert.equal(r.book.lastDecidedSession,'2026-09-29');
 const n=r.book.history.length;
 r=await Eq.runEquitiesOnce({now:ET('2026-09-29',17,30),env,fetchImpl,dataDir:dir});
 assert.equal(r.book.history.length,n,'restart never double-executes');
 // A decision saved after an open fills at the following open with late=true.
 const b=Book.loadBook(dir);b.pending={decidedAt:new Date(ET('2026-09-30',10,0)).toISOString(),decidedForSession:'2026-09-29',executeAtOpenOf:'2026-09-30',targets:{SPY:0.5,BIL:0.5},strategyId:'tactical-a'};fs.writeFileSync(Book.bookFile(dir),JSON.stringify(b));
 r=await Eq.runEquitiesOnce({now:ET('2026-10-01',17,0),env,fetchImpl,dataDir:dir});
 const last=r.book.history.at(-1);assert.equal(last.session,'2026-10-01');assert.equal(last.late,true);
 const snap=Eq.robinhoodEquitiesSnapshot({now:ET('2026-10-01',17,5),env,dataDir:dir});
 assert.deepEqual(Object.keys(snap),['at','readiness','market','data','book','strategy','benchmark','loop','lastError']);
 assert.equal(snap.readiness.execution,'paper-only');assert.equal(snap.readiness.realRoute.wired,false);
 assert.match(snap.readiness.text,/Agentic Trading MCP/);assert.match(snap.readiness.text,/stocks, options and crypto/);assert.match(snap.readiness.text,/NOT wired/);
 assert.equal(snap.book.costs.commissionUsd,0);assert.ok(snap.benchmark.live.buyHoldSpyUsd>0);assert.equal(snap.benchmark.live.cashReturnPct,0);
 assert.ok(snap.benchmark.replay?.strategy&&snap.benchmark.replay?.buyHoldSpy&&snap.benchmark.replay?.cash);
 assert.ok(calls.every(c=>c.url.hostname==='data.alpaca.markets'));
});

test('controller: without a key it reports NO_DATA, writes nothing, fetches nothing',async()=>{
 const dir=tmp();let hit=0;
 const r=await Eq.runEquitiesOnce({now:ET('2026-09-25',17,0),env:{},fetchImpl:()=>{hit++;throw new Error('no')},dataDir:dir});
 assert.deepEqual(r.events,['NO_DATA']);assert.equal(hit,0);assert.equal(fs.existsSync(Book.bookFile(dir)),false);
 const snap=Eq.robinhoodEquitiesSnapshot({env:{},dataDir:dir});assert.equal(snap.data.status,'NO_DATA');assert.equal(snap.benchmark.replay,null);
});

test('HTTP: read-only GET route with the local guard',async()=>{
 const root=tmp();
 Object.assign(process.env,{MONEY_PRINTER_DATA_DIR:path.join(root,'data'),DASHBOARD_PORT:'0',DASHBOARD_HOST:'127.0.0.1',MODE:'paper',POLYMARKET_AUTOSTART:'false',POLYMARKET_AUTOPILOT:'false',ROBINHOOD_AUTOSTART:'false',ROBINHOOD_API_KEY:'',ROBINHOOD_PRIVATE_KEY:'',ROBINHOOD_REAL_ENABLED:'false',ALPACA_KEY_ID:'',ALPACA_SECRET_KEY:''});
 const {once}=await import('node:events');
 const {startDashboard}=await import('../src/dashboard.js');const {productEconomics}=await import('../src/productEconomics.js');
 const server=startDashboard();if(!server.listening)await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const r=await fetch(base+'/api/robinhood-equities');assert.equal(r.status,200);const j=await r.json();
  assert.equal(j.data.status,'NO_DATA');assert.equal(j.readiness.realOrders,false);
  assert.equal((await fetch(base+'/api/robinhood-equities',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,405);
  assert.equal((await fetch(base+'/api/robinhood-equities',{headers:{origin:'http://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/api/robinhood-equities/nope')).status,404);
 }finally{await new Promise(res=>server.close(res));productEconomics().close();globalThis.fetch=nativeFetch}
});
