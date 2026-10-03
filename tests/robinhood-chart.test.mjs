// Batch C (§24): the read-only chart payload, its downsampling and caps, the tape tail reader and the HUD SVG contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-chart-'));
process.env.MONEY_PRINTER_DATA_DIR=path.join(root,'data');
process.env.ROBINHOOD_AUTOSTART='false';process.env.POLYMARKET_AUTOSTART='false';
const C=await import('../src/robinhoodChart.js'),S=await import('../src/robinhoodStrategy.js'),T=await import('../src/robinhoodTape.js');
const RH=await import('../src/robinhoodAutoTrader.js'),J=await import('../src/robinhoodJournal.js');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const panel=fs.readFileSync(path.join(repo,'public/js/mpo-robinhood-panel.js'),'utf8'),html=fs.readFileSync(path.join(repo,'public/dashboard.html'),'utf8');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const STEP=15000,END=1_800_000_000_000;
function walk(n,{end=END,seed=11}={}){let s=seed,mid=60000;return Array.from({length:n},(_,i)=>{s=(Math.imul(s,1664525)+1013904223)>>>0;mid*=1+(s/4294967296-0.5)*0.004;return {t:end-(n-1-i)*STEP,bid:mid*0.9995,ask:mid*1.0005,mid,src:'robinhood'}})}

test('downsample: at most maxPoints, keeps the last sample and the bid/ask envelope of every bucket',()=>{
 const rows=walk(10000);rows[4321]={...rows[4321],bid:1,ask:1e6};
 const out=C.downsample(rows,800);assert.equal(out.length,800);assert.equal(out.at(-1).t,rows.at(-1).t);
 assert.equal(Math.min(...out.map(r=>r.bid)),1);assert.equal(Math.max(...out.map(r=>r.ask)),1e6,'a one-sample spike survives');
 for(let i=1;i<out.length;i++)assert.ok(out[i].t>out[i-1].t);
 assert.equal(C.downsample(rows.slice(0,500),800).length,500,'short series pass through');
 assert.equal(C.downsample(rows,1).length,1);
});

test('indicators match what the strategy sees at the last sample',()=>{
 const rows=walk(400),params=S.normalizeParams({});const ind=C.withIndicators(rows,params).at(-1);
 const f=S.computeFeatures(rows,{...params,sampleMs:STEP},rows.at(-1).t);assert.equal(f.ok,true,f.reason);
 assert.ok(Math.abs(ind.dh-f.donchianHigh)<1e-9&&Math.abs(ind.dl-f.donchianLow)<1e-9,'Donchian excludes the current sample');
 assert.ok(Math.abs(ind.ef-f.emaFast)<1e-6&&Math.abs(ind.es-f.emaSlow)<1e-6);
});

test('buildChart: markers per book and kind, stop/take lines, equity with fee drag, trades gross = net + fees, caps',()=>{
 const rows=walk(24*240);const at=i=>rows[rows.length-1-i].t;
 const closed=(id,book,o,c,pnl,fees)=>({id,symbol:'BTC-USD',status:'CLOSED',placedBy:book==='explore'?'explore-autopilot':'paper-autopilot',closedBy:'strategy',openedAt:at(o),at:at(o),fillPrice:60000,feeUsd:fees/2,exit:{reason:pnl>0?'take':'stop',fillPrice:pnl>0?61000:59000,feeUsd:fees/2,at:at(c)},closedAt:at(c),pnlUsd:pnl});
 const strict={startUsd:1000,createdAt:at(5000),positions:[{id:'o1',symbol:'BTC-USD',status:'OPEN',openedAt:at(10),fillPrice:60000,stopPct:0.02,takePct:0.08,trailStop:59900}],history:[closed('s1','strict',200,150,2.5,0.5),closed('s2','strict',100,60,-1.5,0.5),closed('e0','strict',50,40,1,0.2)].map(x=>({...x,symbol:x.id==='e0'?'ETH-USD':'BTC-USD'}))};
 const explore={startUsd:1000,createdAt:at(5000),positions:[],history:[closed('x1','explore',90,80,-0.7,0.4)]};
 const d=C.buildChart({symbol:'BTC-USD',range:'6h',rows,params:S.normalizeParams({}),books:{strict,explore},now:rows.at(-1).t});
 assert.deepEqual(Object.keys(d),['symbol','range','from','to','rawCount','sources','indicators','points','markers','lines','equity','trades','caps']);
 assert.ok(d.points.length<=800&&d.rawCount===1441,String(d.rawCount));assert.deepEqual(d.sources,{robinhood:1441});
 const kinds=new Set(d.markers.map(m=>m.book+':'+m.kind));for(const k of ['strict:entry','strict:exit','explore:entry','explore:exit'])assert.ok(kinds.has(k),k);
 assert.ok(d.markers.every(m=>m.t>=d.from&&m.t<=d.to));assert.ok(!d.markers.some(m=>m.id==='e0'),'other symbols are not marked');
 assert.equal(d.lines.length,1);const L=d.lines[0];assert.deepEqual([L.book,L.id,L.entry,L.trail],['strict','o1',60000,59900]);assert.ok(Math.abs(L.stop-58800)<1e-6&&Math.abs(L.take-64800)<1e-6);
 const eq=d.equity.strict;assert.equal(eq.closes,3);assert.equal(eq.netUsd,2);assert.equal(eq.feesUsd,1.2);assert.ok(Math.abs(eq.grossUsd-3.2)<1e-12);
 assert.ok(eq.points.every(p=>p.gross>=p.net),'gross never below net');assert.equal(eq.points[0].net,1000);assert.equal(eq.points.at(-1).t,d.to);
 const tr=d.trades.find(r=>r.id==='s1');assert.equal(tr.netUsd,2.5);assert.equal(tr.feesUsd,0.5);assert.equal(tr.grossUsd,3);assert.equal(tr.holdMs,50*STEP);assert.equal(tr.reason,'take');assert.equal(tr.entry,60000);assert.equal(tr.exit,61000);
 assert.equal(d.trades.filter(r=>r.book==='explore').length,1);
 assert.throws(()=>C.buildChart({symbol:'BTC-USD',range:'2d',rows,books:{},now:END}),/range/);
 const many={startUsd:1000,history:Array.from({length:2000},(_,i)=>({status:'CLOSED',closedAt:END-i*1000,pnlUsd:0.1,feeUsd:0.01}))};
 const big=C.equityCurve(many,{now:END,maxPoints:800});assert.equal(big.points.length,800);assert.equal(big.points.at(-1).t,END);
 assert.deepEqual(d.caps,{maxPoints:800,maxMarkers:400,maxTrades:100});
});

test('loadTapeSince reads only the file tail and returns the same rows as a full load',()=>{
 const rows=walk(20000,{end:END});for(const r of rows)T.bufferTape('ETH-USD',{t:r.t,bid:r.bid,ask:r.ask,src:'robinhood'});T.flushTape({force:true,now:END});
 const since=END-3600e3,full=T.loadTape('ETH-USD',since),tail=T.loadTapeSince('ETH-USD',since,{chunk:4096});
 assert.equal(tail.length,241);assert.deepEqual(tail,full);assert.deepEqual(T.loadTapeSince('ETH-USD',0,{chunk:4096}).length,20000);
 assert.deepEqual(T.loadTapeSince('NOPE-USD',0),[]);
});

test('robinhoodChart: validates input, reads durable + in-memory tape, caps a 24 h range at 800 points, writes nothing',()=>{
 RH.__testing.setClock(()=>END);
 const before=fs.readdirSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true}).sort();
 const d=RH.robinhoodChart({symbol:'ETH-USD',range:'24h'});assert.equal(d.symbol,'ETH-USD');assert.equal(d.rawCount,5761);assert.equal(d.points.length,800);
 assert.ok(d.equity.strict&&d.equity.explore,'both books');
 assert.deepEqual(fs.readdirSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true}).sort(),before,'read-only');
 assert.throws(()=>RH.robinhoodChart({symbol:'ETH-USD',range:'7d'}),e=>e.code==='validation');
 assert.throws(()=>RH.robinhoodChart({symbol:'../etc',range:'1h'}),e=>e.code==='validation');
 const p=J.loadPaper();p.tape={'SOL-USD':{intervalMs:STEP,quoteSource:'v2',samples:walk(30).map(r=>[r.t,r.bid,r.ask])}};J.savePaper(p,{force:true});
 assert.equal(RH.robinhoodChart({symbol:'SOL-USD',range:'1h'}).rawCount,30,'in-memory tape counts when the file has none');
});

test('HUD contract: chart section, range toggle, SVG layers, marker shapes per book, fee drag and trade columns',()=>{
 for(const s of ["'/api/robinhood/chart?symbol='",'data-rh-chart-range','data-rh-chart-symbol',"['1h','6h','24h']",'id="rhCharts"','${rhChartSection(rhState)}'])assert.ok(panel.includes(s),s);
 assert.ok(html.includes('<script src="/js/mpo-robinhood-panel.js"></script>'),'the dashboard loads the panel file (run D2)');
 assert.doesNotMatch(panel,/<canvas|<script|cdn\.|jsdelivr|cdnjs/,'inline SVG only, no library');
 const ctx=vm.createContext({window:{innerWidth:1280},document:{getElementById:()=>null},polyEscape:s=>String(s??''),money:n=>'$'+Number(n).toFixed(2),fmt:(n,dd)=>Number(n).toFixed(dd)});vm.runInContext(panel,ctx);
 const rows=walk(1440),at=i=>rows[rows.length-1-i].t;
 ctx.d={symbol:'BTC-USD',range:'6h',from:rows[0].t,to:rows.at(-1).t,rawCount:1440,sources:{robinhood:1440},indicators:{emaFast:12,emaSlow:48,lookbackSamples:90},points:C.withIndicators(rows,{}),
  markers:[{book:'strict',kind:'entry',t:at(300),price:60000},{book:'strict',kind:'exit',t:at(200),price:60100,reason:'take'},{book:'explore',kind:'entry',t:at(100),price:60000},{book:'explore',kind:'exit',t:at(50),price:59900,reason:'stop'}],
  lines:[{book:'strict',entry:60000,stop:59000,take:61000,trail:59800}],
  equity:{strict:{startUsd:1000,closes:2,netUsd:-1,feesUsd:0.8,grossUsd:-0.2,points:[{t:at(900),net:1000,gross:1000},{t:at(500),net:1001,gross:1001.4},{t:at(10),net:999,gross:999.8}]},explore:{startUsd:1000,closes:0,points:[]}},
  trades:[{book:'explore',symbol:'BTC-USD',entry:60000,exit:59900,reason:'stop',holdMs:1500000,grossUsd:-0.1,feesUsd:0.4,netUsd:-0.5}]};
 const svg=vm.runInContext('rhPriceSvg(d)',ctx);
 for(const cls of ['rh-band','rh-mid','rh-don-high','rh-don-low','rh-ema-fast','rh-ema-slow','rh-mk-strict-entry','rh-mk-strict-exit','rh-mk-explore-entry','rh-mk-explore-exit','rh-line-stop','rh-line-take','rh-line-trail'])assert.match(svg,new RegExp('class="(?:[^"]* )?'+cls+'"'),cls);
 assert.match(svg,/<path class="rh-mk-strict-entry|<path class="rh-mk rh-mk-strict-entry/);assert.match(svg,/<circle class="rh-mk rh-mk-explore-entry/);assert.match(svg,/<rect class="rh-mk rh-mk-explore-exit/);
 assert.doesNotMatch(svg,/NaN|undefined/);
 const eq=vm.runInContext("rhEquitySvg(d.equity.strict,'STRICT BOOK','rhEquityStrict')+rhEquitySvg(d.equity.explore,'EXPLORATION (NOT A STRATEGY)','rhEquityExplore')",ctx);
 assert.match(eq,/class="rh-fee-drag"/);assert.match(eq,/class="rh-eq-net"/);assert.match(eq,/class="rh-eq-gross"/);assert.match(eq,/EXPLORATION \(NOT A STRATEGY\)/);assert.doesNotMatch(eq,/NaN/);
 const table=vm.runInContext('rhTradeTable(d.trades)',ctx);
 for(const h of ['Entry','Exit','Reason','Hold','Gross','Fees','Net'])assert.ok(table.includes('<th>'+h+'</th>'),h);assert.match(table,/EXPLORE/);assert.match(table,/25m/);
 ctx.window.innerWidth=375;assert.match(vm.runInContext('rhPriceSvg(d)',ctx),/viewBox="0 0 420 /,'narrow screens get a narrower viewBox so text stays legible');
 assert.match(vm.runInContext("rhPriceSvg({symbol:'BTC-USD',range:'1h',points:[]})",ctx),/No tape for BTC-USD/);
});
