import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadEvents,ReplayClock,makeConfigs,replay,metrics,isMainModule,resolveReplayDataDir,assignRegimes,CHALLENGER_PRESETS,gateReplayRow} from '../tools/replayLab.js';
import {deterministicFillAllowed,estimatePaperExecution} from '../src/executionSim.js';

function row(ts,mint,price,extra={}){return {type:'scan-candidate',ts,a:{mint,symbol:mint,priceUsd:price,liq:50000,score:80,executionScore:80,eligible:true,...extra}}}
async function fixture(rows){const d=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-replay-'));fs.writeFileSync(path.join(d,'market.ndjson'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return d}

test('quarantine blocks impossible 100x jump and duplicate',async()=>{const d=await fixture([row(1000,'A',1),row(2000,'A',100),row(3000,'A',1.1),row(3000,'A',1.1)]);const x=await loadEvents({dataDir:d});assert.equal(x.events.length,2);assert.equal(x.quarantine.jump,1);assert.equal(x.quarantine.duplicate,1);fs.rmSync(d,{recursive:true,force:true})});

test('stale resume is marked but remains observable',async()=>{const d=await fixture([row(1000,'A',1),row(1000+31*60000,'A',1.1)]);const x=await loadEvents({dataDir:d});assert.equal(x.events.length,2);assert.equal(x.events[1].staleResume,true);fs.rmSync(d,{recursive:true,force:true})});

test('replay clock rejects look-ahead',()=>{const c=new ReplayClock();c.set(100);assert.throws(()=>c.assert(101),/look-ahead/);c.assert(100)});

test('same event stream is deterministic',()=>{const ev=[];for(let i=0;i<20;i++)ev.push({ts:1000+i*60000,mint:'A',symbol:'A',price:1+i*.01,liq:50000,score:90,executionScore:90,eligible:true,warnings:0,staleResume:false});const cfg=makeConfigs(['SPRINT']);const a=replay(ev,cfg,{startSol:1}),b=replay(ev,cfg,{startSol:1});assert.deepEqual(a,b)});

test('profitable synthetic trend produces finite metrics',()=>{const ev=[];for(let i=0;i<10;i++)ev.push({ts:1000+i*60000,mint:'A',symbol:'A',price:1+i*.02,liq:100000,score:95,executionScore:95,eligible:true,warnings:0,staleResume:false});const r=replay(ev,makeConfigs(['SPRINT']),{startSol:1})[0];for(const v of Object.values(r.metrics))if(typeof v==='number')assert.ok(Number.isFinite(v));assert.ok(r.metrics.n>=1)});

test('static import fence keeps replay lab away from live/authenticated modules',()=>{const s=fs.readFileSync(new URL('../tools/replayLab.js',import.meta.url),'utf8').toLowerCase();for(const bad of ['polymarket','jupiter','@solana','./rpc','from \'ws\'','fetch('])assert.equal(s.includes(bad),false,`forbidden ${bad}`)});

test('metric helper handles hand computed pnl',()=>{const m=metrics({trades:[{pnl:.1,returnPct:10},{pnl:-.05,returnPct:-5}],finalEquity:1.05,fees:.01,slippage:.02,turnover:2,censored:0,curve:[{ts:1,equity:1},{ts:2,equity:.95},{ts:3,equity:1.05}]},1);assert.equal(m.realizedPnl,.05);assert.equal(m.profitFactor,2);assert.equal(m.maxDrawdownPct,5)});

// fileURLToPath, not .pathname: on Windows a file: URL's pathname is '/C:/...', which is not a
// platform path, so isMainModule's path.resolve comparison never matched and this failed on Windows only.
test('main-module detection accepts platform path of this module only',()=>{assert.equal(isMainModule(fileURLToPath(new URL('../tools/replayLab.js',import.meta.url))),true);assert.equal(isMainModule('/definitely/not/replayLab.js'),false)});


test('out-of-order extra sources cannot use a future price as quarantine baseline',async()=>{
 const d=await fixture([row(3000,'A',100)]);
 try{
  const extra=path.join(d,'earlier.ndjson');
  fs.writeFileSync(extra,[row(2000,'A',1.1),row(1000,'A',1)].map(x=>JSON.stringify(x)).join('\n'));
  const ds=await loadEvents({dataDir:d,extra:[extra]});
  assert.deepEqual(ds.events.map(e=>[e.ts,e.price]),[[1000,1],[2000,1.1]]);
  assert.equal(ds.quarantine.jump,1);
  assert.equal(ds.inventory[0].accepted,0);
  assert.equal(ds.inventory[1].accepted,2);
  assert.equal(ds.inventory[1].firstTs,1000);
  assert.equal(ds.inventory[1].lastTs,2000);
  const limited=await loadEvents({dataDir:d,extra:[extra],limitEvents:1});
  assert.deepEqual(limited.events.map(e=>e.ts),[1000]);
 }finally{fs.rmSync(d,{recursive:true,force:true})}
});

test('stale-resume detection follows chronology across source boundaries',async()=>{
 const later=1000+31*60000,d=await fixture([row(later,'A',1.1)]);
 try{
  const extra=path.join(d,'earlier.ndjson');fs.writeFileSync(extra,JSON.stringify(row(1000,'A',1)));
  const ds=await loadEvents({dataDir:d,extra:[extra]});
  assert.deepEqual(ds.events.map(e=>e.staleResume),[false,true]);
  assert.equal(ds.quarantine.stale_resume,1);
 }finally{fs.rmSync(d,{recursive:true,force:true})}
});

test('CLI reports are byte-identical for repeated runs with the same dataset and options',async()=>{
 const d=await fixture(Array.from({length:20},(_,i)=>row(1000+i*60000,'A',1+i*.01)));
 try{
  for(const workers of [1,2]){
   const outputs=[];
   for(const iteration of [1,2]){
    const out=path.join(d,`report-${workers}-${iteration}`);
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/replayLab.js',import.meta.url)),'--data',d,'--configs','FAST,SPRINT','--max-workers',String(workers),'--out',out],{encoding:'utf8',timeout:10000});
    assert.equal(child.status,0,child.stderr);
    outputs.push({json:fs.readFileSync(out+'.json','utf8'),md:fs.readFileSync(out+'.md','utf8')});
   }
   assert.deepEqual(outputs[0],outputs[1]);
   const report=JSON.parse(outputs[0].json);
   assert.equal(report.dataset.asOfTs,1000+19*60000);
   assert.equal(Object.hasOwn(report,'generatedAt'),false);
  }
 }finally{fs.rmSync(d,{recursive:true,force:true})}
});


test('data discovery prefers installed app history and explicit paths never silently fall back',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-replay-home-'));
 try{
  const installed=path.join(root,'Library','Application Support','Money Printer OS','data');fs.mkdirSync(installed,{recursive:true});fs.writeFileSync(path.join(installed,'market.ndjson'),JSON.stringify(row(1000,'A',1))+'\n');
  const cwd=path.join(root,'repo');fs.mkdirSync(path.join(cwd,'data'),{recursive:true});fs.writeFileSync(path.join(cwd,'data','market.ndjson'),JSON.stringify(row(2000,'B',1))+'\n');
  const found=resolveReplayDataDir(null,{env:{},home:root,platform:'darwin',cwd});assert.equal(found.source,'installed-app');assert.equal(found.dataDir,installed);assert.equal(found.found,true);
  const explicit=path.join(root,'empty-explicit');fs.mkdirSync(explicit);const chosen=resolveReplayDataDir(explicit,{env:{},home:root,platform:'darwin',cwd});assert.equal(chosen.source,'explicit');assert.equal(chosen.dataDir,explicit);assert.equal(chosen.found,false);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('held-position equity is sampled so an unrealized peak-to-trough drawdown is visible',()=>{
 const cfg={...makeConfigs(['FAST'])[0],id:'HOLD',tp:999,stop:999,trail:999,maxHold:999};
 const ev=[
  {ts:-10000,mint:'DUMMY',symbol:'D',price:1,liq:1,score:0,executionScore:0,staleResume:false},
  {ts:3000,mint:'A',symbol:'A',price:1,liq:100000,score:99,executionScore:99,staleResume:false},
  {ts:6000,mint:'A',symbol:'A',price:1.5,liq:100000,score:99,executionScore:99,staleResume:false},
  {ts:9000,mint:'A',symbol:'A',price:1.1,liq:100000,score:99,executionScore:99,staleResume:false},
  {ts:10000,mint:'DUMMY2',symbol:'D2',price:1,liq:1,score:0,executionScore:0,staleResume:false},
 ];
 const r=replay(ev,[cfg],{startSol:1})[0].metrics;
 assert.equal(r.n,0);assert.equal(r.censored,1);assert.ok(r.maxDrawdownPct>0,`expected held drawdown, got ${r.maxDrawdownPct}`);
});

test('stale and split-end marks stay censored and do not become realized wins',()=>{
 const cfg={...makeConfigs(['FAST'])[0],id:'HOLD',tp:999,stop:999,trail:999,maxHold:999};
 const ev=[
  {ts:-10000,mint:'DUMMY',symbol:'D',price:1,liq:1,score:0,executionScore:0,staleResume:false},
  {ts:3000,mint:'A',symbol:'A',price:1,liq:100000,score:99,executionScore:99,staleResume:false},
  {ts:6000,mint:'A',symbol:'A',price:2,liq:100000,score:99,executionScore:99,staleResume:true},
  {ts:10000,mint:'DUMMY2',symbol:'D2',price:1,liq:1,score:0,executionScore:0,staleResume:false},
 ];
 const r=replay(ev,[cfg],{startSol:1})[0].metrics;
 assert.equal(r.n,0);assert.equal(r.censored,1);assert.ok(r.censoredMarkPnl<=0.0001,'stale resume must use the prior observable mark, not the resumed price');assert.ok(r.realizedPnl<=0,'only paid entry friction may be realized');
});

test('thin-liquidity exit failure remains open and is censored instead of inventing a fill',()=>{
 const entryTs=3000,exitTs=9000,low={liq:1,executionScore:0};
 const exitFailurePct=estimatePaperExecution(low,.025,200,80,25).failurePct;assert.ok(exitFailurePct>0);
 let mint='';
 for(let i=0;i<10000;i++){const m=`THIN${i}`;if(deterministicFillAllowed(m,entryTs,0)&&!deterministicFillAllowed(m,exitTs,exitFailurePct)){mint=m;break}}
 assert.ok(mint,'fixture must find deterministic failed exit mint');
 const cfg={...makeConfigs(['FAST'])[0],id:'THIN',tp:999,stop:5,trail:999,maxHold:999};
 const ev=[
  {ts:-10000,mint:'DUMMY',symbol:'D',price:1,liq:1,score:0,executionScore:0,staleResume:false},
  {ts:entryTs,mint,symbol:mint,price:1,liq:100000,score:99,executionScore:99,staleResume:false},
  {ts:exitTs,mint,symbol:mint,price:.8,liq:1,score:99,executionScore:0,staleResume:false},
  {ts:10000,mint:'DUMMY2',symbol:'D2',price:1,liq:1,score:0,executionScore:0,staleResume:false},
 ];
 const r=replay(ev,[cfg],{startSol:1})[0].metrics;
 assert.equal(r.n,0);assert.equal(r.exitFailures,1);assert.equal(r.censored,1);assert.ok(r.censoredMarkPnl<0);assert.ok(r.realizedPnl<=0);
});

test('metric helper excludes censored marks from headline realized pnl',()=>{
 const m=metrics({trades:[{pnl:.2,returnPct:20,censored:true},{pnl:.05,returnPct:5,censored:false}],realizedPnl:.05,finalEquity:1.25,fees:0,slippage:0,turnover:1,censored:1,censoredMarks:[{markPnl:.2}],exitFailures:0,curve:[{ts:1,equity:1},{ts:2,equity:1.25}]},1);
 assert.equal(m.n,1);assert.equal(m.realizedPnl,.05);assert.equal(m.censoredMarkPnl,.2);assert.equal(m.expectancy,.05);
});

function cand(ts,mint,price,extra={}){return {ts,mint,symbol:mint,price,liq:extra.liq??100000,score:extra.score??99,executionScore:extra.executionScore??99,eligible:true,warnings:0,staleResume:false,regime:extra.regime||'UNKNOWN'}}

test('causal regime tagging never looks ahead of the event timestamp',()=>{
 const ev=[{ts:1000,mint:'A'},{ts:2000,mint:'A'},{ts:4000,mint:'A'}];
 assignRegimes(ev,[{ts:2000,regime:'COLD'},{ts:5000,regime:'HOT'}]);
 assert.deepEqual(ev.map(e=>e.regime),['UNKNOWN','COLD','COLD']);
});

test('scan-summary rows tag events without changing the dataset hash',async()=>{
 const rows=[row(1000,'A',1),row(2000,'A',1.01),row(3000,'A',1.02)];
 const d=await fixture(rows);
 try{
  const extra=path.join(d,'summaries.ndjson');
  fs.writeFileSync(extra,[
   JSON.stringify({type:'scan-summary',ts:1500,regime:'COLD'}),
   JSON.stringify({type:'scan-summary',ts:5000,regime:'HOT'}),
  ].join('\n'));
  const base=await loadEvents({dataDir:d});
  const tagged=await loadEvents({dataDir:d,extra:[extra]});
  assert.equal(base.hash,tagged.hash);
  assert.equal(tagged.summaries,2);
  assert.equal(tagged.events[0].regime,'UNKNOWN');
  assert.equal(tagged.events[1].regime,'COLD');
  assert.equal(tagged.events[2].regime,'COLD');
 }finally{fs.rmSync(d,{recursive:true,force:true})}
});

test('COLD_ONLY challenger ignores non-COLD test events',()=>{
 const ev=[];
 for(let i=0;i<30;i++)ev.push(cand(i*60_000,'HOT'+i,1,{regime:'NORMAL'}));
 for(let i=0;i<16;i++){
  const ts=(40+i)*60_000;
  ev.push(cand(ts,'CLD'+i,1,{regime:'COLD'}));
  ev.push(cand(ts+30_000,'CLD'+i,0.90,{regime:'COLD'}));
 }
 const cfg=makeConfigs(['COLD_ONLY']);
 assert.equal(cfg[0].promotable,false);
 const r=replay(ev,cfg,{startSol:1})[0];
 assert.ok(r.metrics.n>=1);
 assert.equal(r.gate.live,false);
 assert.equal(r.gate.reason,'not-promotable');
});

test('train-derived liquidity quartile cut is applied only on the test window',()=>{
 const ev=[];
 for(let i=0;i<30;i++)ev.push(cand(i*60_000,'T'+i,1,{liq:i%3===0?80_000:10_000,regime:'NORMAL'}));
 for(let i=0;i<16;i++){
  const ts=(40+i)*60_000,liq=i%3===0?80_000:10_000;
  ev.push(cand(ts,'X'+i,1,{liq,regime:'NORMAL'}));
  ev.push(cand(ts+30_000,'X'+i,0.90,{liq,regime:'NORMAL'}));
 }
 const top=replay(ev,makeConfigs(['LIQ_TOPQ']),{startSol:1})[0];
 const rest=replay(ev,makeConfigs(['LIQ_REST']),{startSol:1})[0];
 assert.equal(top.params.promotable,false);
 assert.equal(rest.params.promotable,false);
 assert.equal(top.gate.live,false);
 assert.ok(top.splits[0].cuts.q75>0);
 assert.ok(top.metrics.n>=1);
 assert.ok(rest.metrics.n>=1);
});

test('SPRINT_HOLD60 keeps a flat name past the 25-minute SPRINT purge',()=>{
 const ev=[cand(0,'D',1,{liq:1,score:0,executionScore:0})];
 for(let i=1;i<40;i++)ev.push(cand(i*60_000,'PAD'+i,1,{liq:1,score:0,executionScore:0}));
 const mint='HOLDME';
 for(let i=0;i<80;i++)ev.push(cand((140+i)*60_000,mint,1.001,{liq:100000}));
 ev.push(cand(230*60_000,'Z',1,{liq:1,score:0,executionScore:0}));
 const sprint=replay(ev,makeConfigs(['SPRINT']),{startSol:1})[0];
 const hold=replay(ev,makeConfigs(['SPRINT_HOLD60']),{startSol:1})[0];
 assert.ok((sprint.metrics.exitReasons['max-hold']||0)>=1);
 assert.equal(hold.params.maxHold,60);
 assert.equal(hold.gate.reason,'not-promotable');
 assert.equal(hold.gate.live,false);
});

test('challenger configs cannot self-promote even with a winning metric sheet',()=>{
 const cfg=makeConfigs(['COLD_TOPQ'])[0];
 const decision=gateReplayRow({config:cfg.id,params:cfg,metrics:{n:200,realizedPnl:1,expectancy:.01,profitFactor:2,maxDrawdownPct:1,positiveSplits:3,totalSplits:3,top3PnlConcentrationPct:10}});
 assert.equal(decision.live,false);
 assert.equal(decision.eligible,false);
 assert.equal(decision.reason,'not-promotable');
});

test('static import fence keeps challenger presets off live modules',()=>{
 assert.ok(Object.keys(CHALLENGER_PRESETS).length>=7);
 for(const cfg of Object.values(CHALLENGER_PRESETS))assert.equal(cfg.promotable,false);
});


test('replay quartiles exclude sentinel and sub-economic liquidity',async()=>{
 const {trainCuts}=await import('../tools/replayLab.js');
 const events=[1,1,1,20,900,8000,10000,20000,80000].map((liq,i)=>({ts:i+1,liq,regime:'COLD'}));
 const cuts=trainCuts(events,{trainStart:0,trainEnd:100});
 assert.equal(cuts.n,4);assert.equal(cuts.coldN,4);assert.equal(cuts.q75,20000);
});
