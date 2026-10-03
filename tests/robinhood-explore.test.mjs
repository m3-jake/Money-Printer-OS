// Batch B (§23): always-on quotes, warm start + candle backfill, the exploration book and the gauges.
// Offline: only mocked, unauthenticated Coinbase public GETs; no credentials, never a broker call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-explore-'));
process.env.MONEY_PRINTER_DATA_DIR=path.join(root,'data');
process.env.ROBINHOOD_AUTOSTART='false';process.env.POLYMARKET_AUTOSTART='false';process.env.ROBINHOOD_REAL_ENABLED='false';
process.env.ROBINHOOD_SYMBOLS='BTC-USD';
for(const k of ['ROBINHOOD_API_KEY','ROBINHOOD_PRIVATE_KEY','ROBINHOOD_COLLECT_QUOTES','ROBINHOOD_EXPLORE_ENABLED'])delete process.env[k];
const nativeFetch=globalThis.fetch,calls=[];
let time=1700000000000,bid=100,ask=100.02,candles=[];
globalThis.fetch=async(url,init={})=>{
 const u=new URL(url);calls.push({path:u.pathname,search:u.search,method:init.method,headers:init.headers||{}});
 assert.equal(u.origin,'https://api.exchange.coinbase.com');assert.equal(init.method,'GET');
 let value;
 if(/\/book$/.test(u.pathname))value={bids:[[String(bid),'1',1]],asks:[[String(ask),'1',1]],time:new Date(time).toISOString()};
 else if(/\/candles$/.test(u.pathname))value=candles;
 else if(/^\/products\/[A-Z]+-USD$/.test(u.pathname))value={status:'online',trading_disabled:false,base_increment:'0.00000001',quote_increment:'0.01'};
 else throw Error('unexpected public read '+u.pathname);
 return {ok:true,status:200,json:async()=>value};
};
const RH=await import('../src/robinhoodAutoTrader.js'),J=await import('../src/robinhoodJournal.js'),T=await import('../src/robinhoodTape.js');
const S=await import('../src/robinhoodStrategy.js'),W=await import('../src/robinhoodWarmStart.js'),F=await import('../src/robinhoodPaperFeed.js');
const TICK=RH.__testing.TICK_MS;
function reset(){RH.__testing.reset();fs.rmSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true,force:true});fs.mkdirSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true});J.__testing.resetPaper();RH.__testing.setClock(()=>time);time=1700000000000;bid=100;ask=100.02;candles=[];calls.length=0}
test.after(()=>{RH.stopRobinhoodLoops();globalThis.fetch=nativeFetch;fs.rmSync(root,{recursive:true,force:true})});
// Rising tape with noise, ending just under its high; the next quote then breaks out.
function risingRows(n,end,{drift=0.004,noise=0.02,seed=7}={}){let s=seed,mid=100;const out=[];for(let i=0;i<n;i++){s=(Math.imul(s,1664525)+1013904223)>>>0;mid*=1+drift+(s/4294967296-0.5)*noise;out.push({t:end-(n-1-i)*TICK,bid:mid*0.9999,ask:mid*1.0001})}return out}
const candle=(t,o,h,l,c)=>[t/1000,l,h,o,c,1];

test('candle expansion and merge: tagged, on the sample grid, real rows win, seams stay under the gap threshold',()=>{
 const rows=W.candlesToSamples([{t:60000,open:10,high:12,low:9,close:11},{t:120000,open:11,high:11.5,low:10,close:10.5}],15000);
 assert.equal(rows.length,8);assert.ok(rows.every(r=>r.src==='coinbase-candles'&&r.bid===r.ask));
 assert.deepEqual(rows.slice(0,4).map(r=>r.bid),[10,9,12,11],'up bar: open, low, high, close');
 assert.deepEqual(rows.slice(4).map(r=>r.bid),[11,11.5,10,10.5],'down bar: open, high, low, close');
 const real=[{t:0,bid:1,ask:1},{t:15000,bid:1,ask:1},{t:200000,bid:1,ask:1}];
 assert.deepEqual(W.findGaps(real,{from:0,to:210000,sampleMs:15000}),[[15000,200000]]);
 const m=W.mergeWarm(real,W.candlesToSamples([{t:30000,open:1,high:1,low:1,close:1},{t:90000,open:1,high:1,low:1,close:1},{t:150000,open:1,high:1,low:1,close:1}],15000),{from:0,to:210000,sampleMs:15000});
 assert.ok(!m.added.some(r=>Math.abs(r.t-200000)<11250),'no candle row next to a real row');
 for(let i=1;i<m.rows.length;i++)assert.ok(m.rows[i].t-m.rows[i-1].t<=30000,'seam '+m.rows[i-1].t+'->'+m.rows[i].t);
});

test('fetchPublicCandles is a plain unauthenticated GET, capped at 300 bars and sorted oldest first',async()=>{
 calls.length=0;candles=[candle(120000,2,3,1,2.5),candle(60000,1,2,0.5,1.5)];
 const out=await F.fetchPublicCandles('BTC-USD',{startMs:0,endMs:10*3600e3});
 assert.deepEqual(out.map(c=>c.t),[60000,120000]);assert.equal(out[0].open,1);assert.equal(out[0].low,0.5);
 const c=calls[0];assert.match(c.path,/\/products\/BTC-USD\/candles$/);assert.match(c.search,/granularity=60/);
 assert.equal(Object.keys(c.headers).some(k=>/auth|cb-access|x-api-key/i.test(k)),false);
 const start=new Date(decodeURIComponent(/start=([^&]+)/.exec(c.search)[1])).getTime();assert.equal(10*3600e3-start,300*60000,'window clamped to 300 bars');
});

test('warm start from the durable tape needs no network and makes the strategy warm immediately',async()=>{
 reset();for(const r of risingRows(200,time-5000))T.bufferTape('BTC-USD',{...r,src:'coinbase-public-paper'});T.flushTape({force:true,now:time});
 assert.equal(S.computeFeatures(J.tapeFor(J.loadPaper(),'BTC-USD'),J.loadPaper().params,time).reason,'warmup');
 calls.length=0;const w=await RH.warmStartRobinhood({fetchCandles:async()=>{throw Error('must not fetch')}});
 assert.equal(w.ran,true);assert.equal(w.bySymbol['BTC-USD'].disk,200);assert.equal(w.bySymbol['BTC-USD'].candles,0);
 const p=J.loadPaper(),f=S.computeFeatures(J.tapeFor(p,'BTC-USD'),S.normalizeParams({...p.params,sampleMs:TICK}),time);
 assert.notEqual(f.reason,'warmup');assert.equal(f.ok,true,JSON.stringify(f.reason));
});

test('a short tape and a restart gap are backfilled from candles tagged coinbase-candles, and the tape stays gap-free',async()=>{
 reset();const before=risingRows(40,time-3600e3),after=risingRows(8,time-5000,{seed:3});
 for(const r of [...before,...after])T.bufferTape('BTC-USD',{...r,src:'coinbase-public-paper'});T.flushTape({force:true,now:time});
 const bars=[];for(let t=Math.floor((time-3*3600e3)/60000)*60000;t<time-60000;t+=60000)bars.push(candle(t,100,100.2,99.9,100.1));candles=bars.reverse();
 let asked=null;const w=await RH.warmStartRobinhood({fetchCandles:async(sym,o)=>{asked=o;return F.fetchPublicCandles(sym,o)}});
 const row=w.bySymbol['BTC-USD'];assert.ok(row.gaps>=1);assert.ok(row.candles>100,JSON.stringify(row));assert.ok(asked.endMs===time&&asked.startMs<time);
 const disk=T.loadTape('BTC-USD',0),tagged=disk.filter(r=>r.src==='coinbase-candles');assert.equal(tagged.length,row.candles,'backfill reached the durable tape, tagged');
 assert.equal(disk.filter(r=>r.src==='coinbase-public-paper').length,48,'live rows untouched');
 const tape=J.tapeFor(J.loadPaper(),'BTC-USD');for(let i=1;i<tape.length;i++)assert.ok(tape[i].t-tape[i-1].t<=2*TICK,'gap at '+i);
 assert.ok(tape.length<=720&&tape.length>=680,String(tape.length));
 const f=S.computeFeatures(tape,S.normalizeParams({sampleMs:TICK}),time);assert.ok(!['warmup','gaps'].includes(f.reason),String(f.reason));
});

test('always-on: the tick samples quotes with both autopilots of the strict book off',async()=>{
 reset();process.env.ROBINHOOD_EXPLORE_ENABLED='false';try{
  const t=await RH.__testing.tick();assert.equal(t.ran,true);assert.equal(t.paper.ran,true);
  assert.equal(J.tapeFor(J.loadPaper(),'BTC-USD').length,1);assert.equal(T.loadTape('BTC-USD')[0].src,'coinbase-public-paper');
  time+=5000;assert.equal((await RH.__testing.tick()).reason,'cadence','15 s cadence kept');
 }finally{delete process.env.ROBINHOOD_EXPLORE_ENABLED}
});

test('exploration book trades on its own bank and never touches the strict book or qualification',async()=>{
 reset();const rows=risingRows(200,time-TICK);const p=J.loadPaper();
 p.tape={'BTC-USD':{intervalMs:TICK,quoteSource:'v2',samples:rows.map(r=>[r.t,r.bid,r.ask])}};J.savePaper(p,{force:true});
 const high=Math.max(...rows.slice(-41).map(r=>(r.bid+r.ask)/2));bid=high*1.02;ask=bid*1.0002;
 const t1=await RH.__testing.tick();assert.equal(t1.paper.explore.ran,true,JSON.stringify(t1.paper.explore));
 let e=J.loadExplore();assert.equal(e.positions.length,1,JSON.stringify(e.autopilot.skipped));
 const pos=e.positions[0];assert.equal(pos.placedBy,'explore-autopilot');assert.ok(e.cashUsd<1000);
 assert.equal(e.params.costMultiple,0.5);assert.equal(e.params.lookbackSamples,40);assert.equal(e.params.maxHoldMin,120);
 let strict=J.loadPaper();assert.equal(strict.positions.length,0);assert.equal(strict.cashUsd,25);assert.equal(strict.autopilot.enabled,false);
 assert.notEqual(e.paramsHash,strict.paramsHash);assert.ok(fs.existsSync(RH.__testing.exploreFile));
 time+=TICK;bid=pos.fillPrice*(1-pos.stopPct)*0.99;ask=bid*1.0002;await RH.__testing.tick();
 e=J.loadExplore();assert.equal(e.positions.length,0);assert.equal(e.history.length,1);assert.equal(e.history[0].exit.reason,'stop');assert.ok(e.history[0].pnlUsd<0);
 strict=J.loadPaper();assert.equal(strict.history.length,0,'strict book unchanged');
 const q=J.evaluateQualification(strict,time);assert.equal(q.closes,0);
 // Even handed the exploration closes under the strict hash, qualification refuses them: placedBy is explore-autopilot.
 const forged=J.evaluateQualification({...strict,history:e.history.map(h=>({...h,paramsHash:strict.paramsHash}))},time);assert.equal(forged.closes,0);
 const snap=await RH.robinhoodSnapshot();
 assert.equal(snap.explore.label,'EXPLORATION (NOT A STRATEGY)');assert.equal(snap.explore.countsTowardQualification,false);assert.equal(snap.explore.qualification.qualified,false);
 assert.equal(snap.explore.stats.closes,1);assert.equal(snap.paper.stats.closes,0);assert.equal(snap.paper.qualification.closes,0);assert.equal(snap.readiness.qualified,false);
});

test('gauge fields per symbol for both books in the snapshot',async()=>{
 reset();const rows=risingRows(200,time-TICK);const p=J.loadPaper();
 p.tape={'BTC-USD':{intervalMs:TICK,quoteSource:'v2',samples:rows.map(r=>[r.t,r.bid,r.ask])}};J.savePaper(p,{force:true});
 const snap=await RH.robinhoodSnapshot({force:true});
 for(const book of ['strict','explore']){
  const g=snap.gauges[book]['BTC-USD'];assert.ok(g,book);
  assert.deepEqual(Object.keys(g),['warmup','spread','move','breakout','trend','cooldownUntil','blocking','blockingText','ready']);
  assert.deepEqual(Object.keys(g.warmup),['n','need','pct']);assert.equal(g.warmup.pct,1);
  assert.ok(Number.isFinite(g.spread.bps)&&g.spread.capBps===40);
  assert.ok(Number.isFinite(g.move.expectedPct)&&Number.isFinite(g.move.requiredPct)&&Number.isFinite(g.move.ratio));
  assert.ok(Number.isFinite(g.breakout.distancePct));assert.equal(typeof g.trend.ok,'boolean');assert.equal(typeof g.blockingText,'string');
 }
 assert.ok(snap.gauges.explore['BTC-USD'].move.requiredPct<snap.gauges.strict['BTC-USD'].move.requiredPct,'exploration requires a smaller move (costMultiple 0.5)');
 assert.notEqual(snap.gauges.strict['BTC-USD'].blocking,null,'the strict autopilot is off by default, so something always blocks it');assert.equal(snap.gauges.strict['BTC-USD'].ready,false);
 reset();const cold=await RH.robinhoodSnapshot({force:true}),g=cold.gauges.strict['BTC-USD'];
 assert.equal(g.blocking,'warmup');assert.ok(g.warmup.pct<1);assert.equal(cold.loop.alwaysOn,true);
});

test('collection follows ROBINHOOD_AUTOSTART only: POLYMARKET_AUTOSTART=false no longer silences the Robinhood loop',()=>{
 reset();const saved=process.env.ROBINHOOD_AUTOSTART;delete process.env.ROBINHOOD_AUTOSTART;process.env.ROBINHOOD_WARM_START='false';
 try{assert.equal(process.env.POLYMARKET_AUTOSTART,'false');const t=RH.startRobinhoodLoops();assert.ok(t,'loop runs');RH.stopRobinhoodLoops();
  process.env.ROBINHOOD_AUTOSTART='false';assert.equal(RH.startRobinhoodLoops(),null)}
 finally{RH.stopRobinhoodLoops();process.env.ROBINHOOD_AUTOSTART=saved??'false';delete process.env.ROBINHOOD_WARM_START}
});
