#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { estimatePaperExecution, deterministicFillAllowed } from './executionSim.js';
import { createExperiment, addChallenger, recordResult, promotionDecision, assertNoLiveChallengers } from './experimentLane.js';

export const PRESETS={
 FAST:{aggression:72,tp:7,stop:7,trail:5,maxHold:25,cooldown:12},
 DEGEN:{aggression:86,tp:15,stop:10,trail:9,maxHold:120,cooldown:8},
 MAX:{aggression:96,tp:25,stop:18,trail:15,maxHold:360,cooldown:5},
 SPRINT:{aggression:100,tp:4,stop:5,trail:5,maxHold:25,cooldown:2},
 RESEARCH:{aggression:100,tp:15,stop:10,trail:9,maxHold:120,cooldown:2},
};
const FAST_EXITS={aggression:72,tp:7,stop:7,trail:5,maxHold:25,cooldown:12};
const SPRINT_EXITS={aggression:100,tp:4,stop:5,trail:5,maxHold:25,cooldown:2};
export const CHALLENGER_PRESETS={
 LIQ_TOPQ:{...FAST_EXITS,filter:'liq-topq',entry:'FAST',exit:'FAST',promotable:false},
 LIQ_REST:{...FAST_EXITS,filter:'liq-rest',entry:'FAST',exit:'FAST',promotable:false},
 COLD_ONLY:{...FAST_EXITS,filter:'cold',entry:'FAST',exit:'FAST',promotable:false},
 COLD_TOPQ:{...FAST_EXITS,filter:'cold-topq',entry:'FAST',exit:'FAST',promotable:false},
 LIQ_MID:{...FAST_EXITS,filter:'liq-mid',entry:'FAST',exit:'FAST',promotable:false},
 SPRINT_FAST_EXITS:{...FAST_EXITS,aggression:100,entry:'SPRINT',exit:'FAST',promotable:false},
 SPRINT_HOLD60:{...SPRINT_EXITS,maxHold:60,entry:'SPRINT',exit:'SPRINT',promotable:false},
};
const r4=x=>Math.round((Number(x)||0)*1e4)/1e4;
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2};
const safeNum=x=>Number.isFinite(Number(x))?Number(x):null;
const cfgMinScore=a=>Math.round(70-Math.max(0,Math.min(100,a))*.38);

export function resolveReplayDataDir(explicit=null,{env=process.env,home=os.homedir(),platform=process.platform,cwd=process.cwd()}={}){
 const selected=explicit||env.MONEY_PRINTER_DATA_DIR;
 if(selected)return {dataDir:path.resolve(selected),source:explicit?'explicit':'env',found:discoverFiles(path.resolve(selected)).length>0};
 const candidates=[];
 if(platform==='darwin')candidates.push(path.join(home,'Library','Application Support','Money Printer OS','data'));
 else if(platform==='win32'){
  if(env.APPDATA)candidates.push(path.join(env.APPDATA,'Money Printer OS','data'));
  if(env.LOCALAPPDATA)candidates.push(path.join(env.LOCALAPPDATA,'Money Printer OS','data'));
 }else candidates.push(path.join(home,'.config','Money Printer OS','data'));
 const local=path.resolve(cwd,'data');
 candidates.push(local);
 for(const dataDir of candidates)if(discoverFiles(dataDir).length)return {dataDir,source:dataDir===local?'cwd':'installed-app',found:true};
 return {dataDir:candidates[0]||local,source:'not-found',found:false};
}

export function discoverFiles(dataDir, extra=[]){
 const base=path.join(dataDir,'market.ndjson');
 const files=[`${base}.2`,`${base}.1`,base,...extra].filter((x,i,a)=>a.indexOf(x)===i&&fs.existsSync(x));
 return files;
}
export function assignRegimes(events=[],summaries=[]){
 const sm=[...summaries].filter(s=>Number(s.ts)>0).sort((a,b)=>a.ts-b.ts||String(a.regime).localeCompare(String(b.regime)));
 let i=0,current='UNKNOWN';
 for(const ev of events){
  while(i<sm.length&&sm[i].ts<=ev.ts){current=String(sm[i].regime||'UNKNOWN');i++}
  ev.regime=current;
 }
 return events;
}

export async function loadEvents({dataDir,extra=[],limitEvents=0}={}){
 const files=discoverFiles(dataDir,extra), normalized=[],events=[],inventory=[],seen=new Set(),prev=new Map(),quarantine={},summaries=[];
 // Read and normalize all sources before chronological, stateful validation.
 // Source order only breaks ties for duplicate timestamps of the same mint.
 for(const file of files){
  const item={file,bytes:fs.statSync(file).size,rows:0,accepted:0,summaries:0,firstTs:null,lastTs:null};
  inventory.push(item);
  const rl=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
  for await(const line of rl){
   item.rows++;let row;try{row=JSON.parse(line)}catch{quarantine.json=(quarantine.json||0)+1;continue}
   const ts=safeNum(row.ts);
   if(row?.type==='scan-summary'){if(!ts){quarantine.invalid=(quarantine.invalid||0)+1;continue}summaries.push({ts,regime:String(row.regime||'UNKNOWN')});item.summaries++;continue}
   if(!['scan','scan-candidate'].includes(row?.type))continue;
   const a=row.a||{},mint=String(a.mint||''),price=safeNum(a.priceUsd),liq=safeNum(a.liq??a.liquidity?.usd),score=safeNum(a.fastEdgeScore??a.edgeScore??a.score),exec=safeNum(a.executionScore);
   if(!ts||!mint||!price||price<=0){quarantine.invalid=(quarantine.invalid||0)+1;continue}
   normalized.push({item,event:{ts,mint,symbol:String(a.symbol||mint.slice(0,6)),price,liq:Math.max(0,liq||0),score:score||0,executionScore:exec??50,eligible:Boolean(a.eligible),warnings:Array.isArray(a.warnings)?a.warnings.length:0,staleResume:false,regime:'UNKNOWN'}});
  }
 }
 normalized.sort((a,b)=>a.event.ts-b.event.ts||a.event.mint.localeCompare(b.event.mint));
 for(const {item,event:ev} of normalized){
  const key=`${ev.ts}:${ev.mint}`;
  if(seen.has(key)){quarantine.duplicate=(quarantine.duplicate||0)+1;continue}seen.add(key);
  const old=prev.get(ev.mint);
  if(old){const ratio=ev.price/old.price;if(ratio>20||ratio<.05){quarantine.jump=(quarantine.jump||0)+1;continue}ev.staleResume=ev.ts-old.ts>30*60_000;if(ev.staleResume)quarantine.stale_resume=(quarantine.stale_resume||0)+1}
  prev.set(ev.mint,{ts:ev.ts,price:ev.price});events.push(ev);
  item.accepted++;item.firstTs=item.firstTs??ev.ts;item.lastTs=ev.ts;
  if(limitEvents&&events.length>=limitEvents)break;
 }
 assignRegimes(events,summaries);
 const regimeCounts={};
 for(const ev of events)regimeCounts[ev.regime]=(regimeCounts[ev.regime]||0)+1;
 return {events,inventory,summaries:summaries.length,regimes:regimeCounts,quarantine,hash:createHash('sha256').update(events.map(e=>`${e.ts}:${e.mint}:${e.price}`).join('|')).digest('hex')};
}

export class ReplayClock{constructor(){this.t=0} set(ts){if(ts<this.t)throw new Error('replay clock moved backward');this.t=ts} now(){return this.t} assert(ts){if(ts>this.t)throw new Error(`look-ahead: ${ts}>${this.t}`)}}
export function makeConfigs(names=['FAST','DEGEN','MAX','SPRINT','RESEARCH'],sweep=false){
 const out=[];
 const expand=n=>n==='CHALLENGERS'?Object.keys(CHALLENGER_PRESETS):[n];
 for(const raw of names){
  for(const n of expand(raw)){
   const b=PRESETS[n]||CHALLENGER_PRESETS[n];if(!b)continue;
   out.push({id:n,...b});
   if(sweep&&PRESETS[n]){for(const d of [-8,-4,4,8])out.push({id:`${n}_A${b.aggression+d}`, ...b, aggression:Math.max(1,Math.min(100,b.aggression+d))});}
  }
 }
 return out;
}
function isSprintEntry(cfg){return cfg.entry==='SPRINT'||(cfg.entry==null&&String(cfg.id).startsWith('SPRINT'))}
function isSprintExit(cfg){return cfg.exit==='SPRINT'||(cfg.exit==null&&String(cfg.id).startsWith('SPRINT'))}
export function trainCuts(events,range){
 const train=(events||[]).filter(e=>e.ts>=range.trainStart&&e.ts<range.trainEnd);
 const all=train.map(e=>e.liq).filter(x=>Number.isFinite(x)&&x>=1500).sort((a,b)=>a-b);
 const cold=train.filter(e=>e.regime==='COLD').map(e=>e.liq).filter(x=>Number.isFinite(x)&&x>=1500).sort((a,b)=>a-b);
 const pct=(xs,p)=>xs.length?xs[Math.min(xs.length-1,Math.floor((xs.length-1)*p))]:null;
 return {q25:pct(all,.25),q75:pct(all,.75),coldQ75:pct(cold,.75),n:all.length,coldN:cold.length};
}
function splitRanges(events,mode='chronological'){
 if(!events.length)return[];const lo=events[0].ts,hi=events.at(-1).ts,span=Math.max(1,hi-lo);
 if(mode==='walk'){
  const out=[];let start=lo,idx=0;const train=Math.max(60*60_000,span*.5),test=Math.max(30*60_000,span*.2),step=Math.max(30*60_000,span*.15);
  while(start+train+test<=hi+1){out.push({id:`wf${++idx}`,trainStart:start,trainEnd:start+train,testStart:start+train,testEnd:start+train+test});start+=step}return out;
 }
 return [{id:'chron',trainStart:lo,trainEnd:lo+span*.6,testStart:lo+span*.6,testEnd:hi+1}];
}
function shouldEnter(ev,cfg,cuts={}){
 if(ev.score<cfgMinScore(cfg.aggression))return false;
 if(ev.executionScore<Math.max(20,45-(cfg.aggression-70)*.5))return false;
 if(ev.liq<1500)return false;
 if(isSprintEntry(cfg)&&(ev.liq<15000||ev.executionScore<40))return false;
 const f=cfg.filter;
 if(f==='liq-topq'&&(cuts.q75==null||ev.liq<cuts.q75))return false;
 if(f==='liq-rest'&&(cuts.q75==null||ev.liq>=cuts.q75))return false;
 if(f==='liq-mid'&&(cuts.q25==null||cuts.q75==null||ev.liq<cuts.q25||ev.liq>=cuts.q75))return false;
 if(f==='cold'&&ev.regime!=='COLD')return false;
 if(f==='cold-topq'&&(ev.regime!=='COLD'||(cuts.coldQ75??cuts.q75)==null||ev.liq<(cuts.coldQ75??cuts.q75)))return false;
 return true;
}
function maxOpen(cfg){return Math.max(1,Math.round(1+cfg.aggression/15))}
function closePosition(state,p,ev,reason){
 const sim=estimatePaperExecution({liq:ev.liq,executionScore:ev.executionScore},p.remainingBasis,state.solUsd,80,25);
 if(!deterministicFillAllowed(p.mint,ev.ts,sim.failurePct)){state.exitFailures++;return false}
 const exitPx=ev.price*(1-sim.slippageBps/10000),gross=p.remainingBasis*(exitPx/p.entryPrice),fee=gross*sim.feeBps/10000,net=gross-fee,delta=net-p.remainingBasis;
 state.cash+=net;state.realizedPnl+=delta;const pnl=delta+p.realizedPnl;state.fees+=fee;state.slippage+=p.remainingBasis*sim.slippageBps/10000;state.turnover+=p.remainingBasis;
 state.exitReasons[reason]=(state.exitReasons[reason]||0)+1;
 state.trades.push({mint:p.mint,symbol:p.symbol,openedAt:p.openedAt,closedAt:ev.ts,reason,censored:false,entryPrice:p.entryPrice,exitPrice:exitPx,basis:p.initialBasis,pnl,returnPct:p.initialBasis?pnl/p.initialBasis*100:0});
 state.positions.delete(p.mint);state.cooldown.set(p.mint,ev.ts+state.cfg.cooldown*60_000);return true;
}
function partialExit(state,p,ev,fraction,reason){
 const basis=p.remainingBasis*Math.max(0,Math.min(1,fraction));if(basis<=0)return false;
 const sim=estimatePaperExecution({liq:ev.liq,executionScore:ev.executionScore},basis,state.solUsd,80,25);if(!deterministicFillAllowed(p.mint,ev.ts,sim.failurePct)){state.exitFailures++;return false}
 const exitPx=ev.price*(1-sim.slippageBps/10000),gross=basis*(exitPx/p.entryPrice),fee=gross*sim.feeBps/10000,net=gross-fee,delta=net-basis;
 state.cash+=net;p.remainingBasis-=basis;p.realizedPnl+=delta;state.realizedPnl+=delta;state.fees+=fee;state.slippage+=basis*sim.slippageBps/10000;state.turnover+=basis;if(reason==='tp1')p.tp1=true;if(reason==='tp2')p.tp2=true;return true;
}
function censorPosition(state,p,ts,reason,markPrice=p.lastPrice){
 const value=p.remainingBasis*(Math.max(0,Number(markPrice)||0)/p.entryPrice),markPnl=value-p.remainingBasis;
 state.censoredValue+=value;state.censored++;state.censoredMints.add(p.mint);state.censoredMarks.push({mint:p.mint,symbol:p.symbol,openedAt:p.openedAt,markedAt:ts,reason,entryPrice:p.entryPrice,markPrice,basis:p.initialBasis,markValue:value,markPnl,returnPct:p.initialBasis?markPnl/p.initialBasis*100:0});
 state.positions.delete(p.mint);
}
function markEquity(state,ts){let eq=state.cash+state.censoredValue;for(const p of state.positions.values())eq+=p.remainingBasis*(p.lastPrice/p.entryPrice);state.curve.push({ts,equity:eq});return eq}
function runRange(events,cfg,range,{startSol=1,solUsd=200}={}){
 const state={cfg,solUsd,cash:startSol,positions:new Map(),cooldown:new Map(),censoredMints:new Set(),trades:[],censoredMarks:[],curve:[],fees:0,slippage:0,turnover:0,censored:0,censoredValue:0,realizedPnl:0,exitFailures:0,exitReasons:{}};const clock=new ReplayClock();
 const cuts=trainCuts(events,range);
 const xs=events.filter(e=>e.ts>=range.testStart&&e.ts<range.testEnd);const lastByMint=new Map();
 for(const ev of xs){clock.set(ev.ts);lastByMint.set(ev.mint,ev);const p=state.positions.get(ev.mint);
  if(p){clock.assert(ev.ts);const priorPrice=p.lastPrice;
   if(ev.staleResume)censorPosition(state,p,ev.ts,'stale-resume',priorPrice);
   else{p.lastPrice=ev.price;p.high=Math.max(p.high,ev.price);const ret=(ev.price/p.entryPrice-1)*100,draw=(ev.price/p.high-1)*100,held=(ev.ts-p.openedAt)/60000;
    if(ret<=-cfg.stop)closePosition(state,p,ev,'stop');
    else if(draw<=-cfg.trail&&ret>0)closePosition(state,p,ev,'trailing');
    else if(held>=cfg.maxHold)closePosition(state,p,ev,'max-hold');
    else if(ret>=cfg.tp&&!p.tp1){if(isSprintExit(cfg))closePosition(state,p,ev,'tp1');else partialExit(state,p,ev,.35,'tp1')}
   }
   markEquity(state,ev.ts);continue;
  }
  if(state.censoredMints.has(ev.mint)||(state.cooldown.get(ev.mint)||0)>ev.ts||state.positions.size>=maxOpen(cfg)||!shouldEnter(ev,cfg,cuts)){markEquity(state,ev.ts);continue}
  const eq=markEquity(state,ev.ts),sprint=isSprintEntry(cfg),target=sprint?eq*.06:eq*.025,cap=sprint?eq*.15:eq*.08,size=Math.min(target,cap,state.cash*.9);if(size<.002)continue;
  const sim=estimatePaperExecution({liq:ev.liq,executionScore:ev.executionScore},size,solUsd,80,25);if(sprint&&(sim.slippageBps>250||sim.failurePct>40))continue;if(!deterministicFillAllowed(ev.mint,ev.ts,sim.failurePct))continue;
  const fee=size*sim.feeBps/10000;if(state.cash<size+fee)continue;state.cash-=size+fee;state.realizedPnl-=fee;state.fees+=fee;state.slippage+=size*sim.slippageBps/10000;state.turnover+=size;const entryPrice=ev.price*(1+sim.slippageBps/10000);
  state.positions.set(ev.mint,{mint:ev.mint,symbol:ev.symbol,openedAt:ev.ts,entryPrice,high:ev.price,lastPrice:ev.price,initialBasis:size,remainingBasis:size,realizedPnl:-fee,tp1:false,tp2:false});markEquity(state,ev.ts);
 }
 for(const p of [...state.positions.values()]){const ev=lastByMint.get(p.mint);censorPosition(state,p,range.testEnd,'split-end',ev?.price??p.lastPrice)}
 const final=markEquity(state,range.testEnd);return {trades:state.trades,censoredMarks:state.censoredMarks,finalEquity:final,realizedPnl:state.realizedPnl,fees:state.fees,slippage:state.slippage,turnover:state.turnover,censored:state.censored,exitFailures:state.exitFailures,exitReasons:state.exitReasons,cuts,curve:state.curve};
}
export function metrics(result,startSol=1){const t=(result.trades||[]).filter(x=>!x.censored),pnls=t.map(x=>x.pnl),rets=t.map(x=>x.returnPct),wins=pnls.filter(x=>x>0).reduce((a,b)=>a+b,0),loss=Math.abs(pnls.filter(x=>x<0).reduce((a,b)=>a+b,0));let peak=startSol,dd=0;for(const x of result.curve||[]){peak=Math.max(peak,x.equity);dd=Math.max(dd,peak?1-x.equity/peak:0)}const sorted=[...pnls].sort((a,b)=>Math.abs(b)-Math.abs(a));const top3=sorted.slice(0,3).reduce((a,b)=>a+b,0),closedTotal=pnls.reduce((a,b)=>a+b,0),realized=Number.isFinite(Number(result.realizedPnl))?Number(result.realizedPnl):closedTotal;return{n:t.length,realizedPnl:r4(realized),finalEquity:r4(result.finalEquity),medianReturnPct:r4(median(rets)),expectancy:r4(t.length?closedTotal/t.length:0),profitFactor:loss? r4(wins/loss):(wins?999:0),maxDrawdownPct:r4(dd*100),turnover:r4(result.turnover),fees:r4(result.fees),slippageCost:r4(result.slippage),censored:result.censored||0,censoredMarkPnl:r4((result.censoredMarks||[]).reduce((a,x)=>a+Number(x.markPnl||0),0)),exitFailures:result.exitFailures||0,exitReasons:result.exitReasons||{},winRatePct:r4(t.length?t.filter(x=>x.pnl>0).length/t.length*100:0),top3PnlConcentrationPct:r4(closedTotal?top3/closedTotal*100:0)} }
function mergeReasons(into,src){for(const [k,v] of Object.entries(src||{}))into[k]=(into[k]||0)+v;return into}
export function replay(events,configs,{split='chronological',startSol=1,solUsd=200}={}){
 const ranges=splitRanges(events,split),rows=[];
 for(const cfg of configs){
  const per=[];
  const agg={trades:[],censoredMarks:[],curve:[],realizedPnl:0,fees:0,slippage:0,turnover:0,censored:0,exitFailures:0,exitReasons:{},finalEquity:startSol};
  for(const r of ranges){
   const x=runRange(events,cfg,r,{startSol,solUsd});
   per.push({split:r.id,cuts:x.cuts,...metrics(x,startSol)});
   agg.trades=agg.trades.concat(x.trades);
   agg.censoredMarks=agg.censoredMarks.concat(x.censoredMarks);
   agg.curve=agg.curve.concat(x.curve);
   agg.realizedPnl+=x.realizedPnl;agg.fees+=x.fees;agg.slippage+=x.slippage;agg.turnover+=x.turnover;agg.censored+=x.censored;agg.exitFailures+=x.exitFailures;
   mergeReasons(agg.exitReasons,x.exitReasons);agg.finalEquity=x.finalEquity;
  }
  const m=metrics(agg,startSol);
  const robustness={positiveSplits:per.filter(x=>x.realizedPnl>0).length,totalSplits:per.length};
  const metricsOut={...m,...robustness};
  rows.push({config:cfg.id,params:cfg,promotable:cfg.promotable===false?false:null,metrics:metricsOut,splits:per,robustness,gate:gateReplayRow({config:cfg.id,params:cfg,metrics:metricsOut})});
 }
 return rows.sort((a,b)=>a.config.localeCompare(b.config));
}
export function gateReplayRow(row){
 const cfg=row?.params||{};
 const exp=createExperiment({stableConfig:{profile:'FAST'},datasetHash:'replay',versionHash:'replay',createdAt:1});
 const c=addChallenger(exp,{config:{id:row.config,...cfg},mode:'backtest'});
 recordResult(exp,c.id,row.metrics||{});
 const decision=promotionDecision(exp,c.id);
 assertNoLiveChallengers(exp);
 return {eligible:decision.eligible===true,reason:decision.reason,nextMode:decision.nextMode||null,live:false};
}
function mdReport(report){const L=['# Money Printer OS Strategy Replay Lab','',`Dataset events: ${report.dataset.events}`,`Dataset hash: ${report.dataset.hash}`,`Summaries: ${report.dataset.summaries||0}`,'', '| Config | Trades | P/L SOL | Median % | Expectancy | PF | Max DD % | Win % | Top3 % | Gate |','|---|---:|---:|---:|---:|---:|---:|---:|---:|---|'];for(const r of report.results)L.push(`| ${r.config} | ${r.metrics.n} | ${r.metrics.realizedPnl} | ${r.metrics.medianReturnPct} | ${r.metrics.expectancy} | ${r.metrics.profitFactor} | ${r.metrics.maxDrawdownPct} | ${r.metrics.winRatePct} | ${r.metrics.top3PnlConcentrationPct} | ${r.gate?.reason||''} |`);L.push('','## Quarantine','', '```json',JSON.stringify(report.dataset.quarantine,null,2),'```','','## Limitations','','This replays captured candidate ticks and profile/execution behavior. It cannot reconstruct raw upstream features that were never journaled, and disappearing candidates are censored rather than treated as wins. Challengers are not promotable to live.');return L.join('\n')}
function parseArgs(argv){const a={extra:[],configs:'FAST,DEGEN,MAX,SPRINT,RESEARCH',split:'chronological',maxWorkers:Math.max(1,(os.cpus()?.length||4)-4),sweep:false,startSol:1,solUsd:200,limitEvents:0,child:false,childConfig:null,monitor:null};for(let i=0;i<argv.length;i++){const k=argv[i],v=argv[i+1];if(k==='--data'){a.data=v;i++}else if(k==='--extra'){a.extra.push(v);i++}else if(k==='--configs'){a.configs=v;i++}else if(k==='--split'){a.split=v;i++}else if(k==='--max-workers'){a.maxWorkers=Number(v);i++}else if(k==='--sweep')a.sweep=true;else if(k==='--start-sol'){a.startSol=Number(v);i++}else if(k==='--sol-usd'){a.solUsd=Number(v);i++}else if(k==='--limit-events'){a.limitEvents=Number(v);i++}else if(k==='--out'){a.out=v;i++}else if(k==='--monitor'){a.monitor=v;i++}else if(k==='--child')a.child=true;else if(k==='--child-config'){a.childConfig=JSON.parse(Buffer.from(v,'base64url').toString('utf8'));i++}}return a}
function datasetMeta(ds){return{files:ds.inventory,events:ds.events.length,hash:ds.hash,quarantine:ds.quarantine,summaries:ds.summaries||0,regimes:ds.regimes||{}}}
async function childRun(a,dataDir){const ds=await loadEvents({dataDir,extra:a.extra,limitEvents:a.limitEvents});const cfg=a.childConfig||makeConfigs(a.configs.split(',').map(x=>x.trim()),a.sweep)[0];const result=replay(ds.events,[cfg],{split:a.split,startSol:a.startSol,solUsd:a.solUsd})[0];if(process.send)process.send({result,dataset:datasetMeta(ds)});else console.log(JSON.stringify({result,dataset:datasetMeta(ds)}));}

function monitorPath(a,dataDir){return path.resolve(a.monitor||process.env.MONEY_PRINTER_RESEARCH_MONITOR_FILE||path.join(dataDir,'research-monitor.json'))}
function writeMonitor(file,payload){
 try{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(payload,null,2));fs.renameSync(tmp,file);return true}catch{return false}
}
function monitorParams(cfg={}){const keys=['aggression','tp','stop','trail','maxHold','cooldown','filter','entry','exit'];return Object.fromEntries(keys.filter(k=>cfg[k]!=null).map(k=>[k,cfg[k]]))}
function monitorResult(row={}){const m=row.metrics||{};return{config:row.config,params:monitorParams(row.params||{}),metrics:{n:m.n||0,realizedPnl:m.realizedPnl||0,expectancy:m.expectancy||0,profitFactor:m.profitFactor||0,maxDrawdownPct:m.maxDrawdownPct||0,winRatePct:m.winRatePct||0,positiveSplits:m.positiveSplits||0,totalSplits:m.totalSplits||0,top3PnlConcentrationPct:m.top3PnlConcentrationPct||0},gate:{eligible:row.gate?.eligible===true,reason:row.gate?.reason||'unknown',nextMode:row.gate?.nextMode||null}}}
function monitorLeaderboard(rows=[]){return [...rows].sort((a,b)=>Number(b.gate?.eligible)-Number(a.gate?.eligible)||Number(b.metrics?.realizedPnl||0)-Number(a.metrics?.realizedPnl||0)||Number(a.metrics?.maxDrawdownPct||0)-Number(b.metrics?.maxDrawdownPct||0)).slice(0,5).map(monitorResult)}
function rejectionCounts(rows=[]){const out={};for(const r of rows){const reason=r.gate?.reason||'unknown';if(r.gate?.eligible===true)continue;out[reason]=(out[reason]||0)+1}return out}

async function parallelRun(a,dataDir,configs,onProgress=()=>{}){
 const limit=Math.max(1,Math.min(Number(a.maxWorkers)||1,configs.length));let next=0,active=0;const results=[],meta=[];
 return await new Promise((resolve,reject)=>{const launch=()=>{while(active<limit&&next<configs.length){
  const cfg=configs[next++],args=['--child','--child-config',Buffer.from(JSON.stringify(cfg)).toString('base64url'),'--data',dataDir,'--split',a.split,'--start-sol',String(a.startSol),'--sol-usd',String(a.solUsd),'--limit-events',String(a.limitEvents),'--max-workers','1'];for(const e of a.extra)args.push('--extra',e);
  active++;onProgress({type:'start',config:cfg,active,queued:configs.length-next});
  const ch=spawn(process.execPath,[fileURLToPath(import.meta.url),...args],{stdio:['ignore','ignore','inherit','ipc']});let message=null;
  ch.on('message',m=>{message=m;results.push(m.result);meta.push(m.dataset)});
  ch.on('error',e=>{onProgress({type:'error',config:cfg,error:String(e.message||e)});reject(e)});
  ch.on('exit',code=>{active--;if(code!==0||!message){const e=new Error(`replay shard ${cfg.id} failed (${code})`);onProgress({type:'error',config:cfg,error:e.message,active});return reject(e)}onProgress({type:'complete',config:cfg,result:message.result,dataset:message.dataset,active,queued:configs.length-next});if(results.length===configs.length)return resolve({results:results.sort((x,y)=>x.config.localeCompare(y.config)),dataset:meta[0]});launch()});
 }};launch()})
}

async function main(){
 const a=parseArgs(process.argv.slice(2));const resolved=resolveReplayDataDir(a.data);const dataDir=resolved.dataDir;if(a.child)return childRun(a,dataDir);
 const configs=makeConfigs(a.configs.split(',').map(x=>x.trim()),a.sweep),monitorFile=monitorPath(a,dataDir),startedAt=Date.now(),running=new Map(),completedRows=[],recent=[];
 let latestDataset=null;
 const publish=(patch={})=>writeMonitor(monitorFile,{schema:1,source:'replay-lab',campaignId:`replay-${startedAt}`,status:'running',phase:a.split==='walk'?'walk-forward':'replay',startedAt,updatedAt:Date.now(),machine:process.env.COMPUTERNAME||process.env.HOSTNAME||os.hostname(),workers:Math.max(1,Math.min(Number(a.maxWorkers)||1,configs.length)),total:configs.length,completed:completedRows.length,queueRemaining:Math.max(0,configs.length-completedRows.length-running.size),running:[...running.values()].map(c=>({config:c.id,params:monitorParams(c)})),recent:recent.slice(0,8),leaderboard:monitorLeaderboard(completedRows),rejections:rejectionCounts(completedRows),dataset:latestDataset?{events:latestDataset.events,hash:latestDataset.hash,regimes:latestDataset.regimes}:null,safety:{challengersLive:false},...patch});
 publish({note:'Replay Lab campaign starting.'});
 try{
  let results,meta;
  if(a.maxWorkers>1&&configs.length>1){
   const p=await parallelRun(a,dataDir,configs,ev=>{
    if(ev.type==='start'){running.set(ev.config.id,ev.config);publish({current:`Testing ${ev.config.id}`})}
    else if(ev.type==='complete'){running.delete(ev.config.id);completedRows.push(ev.result);latestDataset=ev.dataset||latestDataset;recent.unshift({ts:Date.now(),config:ev.config.id,pnl:ev.result?.metrics?.realizedPnl||0,gate:ev.result?.gate?.reason||'unknown'});publish({current:running.size?`Testing ${[...running.keys()].join(', ')}`:'Finalizing results'})}
    else if(ev.type==='error'){running.delete(ev.config.id);publish({status:'error',error:ev.error,current:`Failed ${ev.config.id}`})}
   });results=p.results;meta=p.dataset;
  }else{
   configs.forEach(c=>running.set(c.id,c));publish({current:`Testing ${configs.map(c=>c.id).join(', ')}`});
   const ds=await loadEvents({dataDir,extra:a.extra,limitEvents:a.limitEvents});meta=datasetMeta(ds);latestDataset=meta;results=replay(ds.events,configs,{split:a.split,startSol:a.startSol,solUsd:a.solUsd});running.clear();completedRows.push(...results);for(const r of [...results].reverse())recent.unshift({ts:Date.now(),config:r.config,pnl:r.metrics?.realizedPnl||0,gate:r.gate?.reason||'unknown'});
  }
  const report={dataset:{dir:dataDir,source:resolved.source,found:resolved.found,...meta,asOfTs:Math.max(0,...meta.files.map(f=>f.lastTs||0))||null},runner:{requestedWorkers:a.maxWorkers,logicalCpus:os.cpus()?.length||0,mode:a.maxWorkers>1?'multi-process-config-shards':'single-process'},results};
  const base=a.out||path.resolve('reports',`replay-${Date.now()}`);fs.mkdirSync(path.dirname(base),{recursive:true});fs.writeFileSync(base+'.json',JSON.stringify(report,null,2));fs.writeFileSync(base+'.md',mdReport(report));
  publish({status:'complete',phase:'complete',completed:results.length,queueRemaining:0,running:[],current:'Campaign complete',leaderboard:monitorLeaderboard(results),rejections:rejectionCounts(results),dataset:{events:meta.events,hash:meta.hash,regimes:meta.regimes},report:base+'.json',finishedAt:Date.now(),note:'Backtest/replay results only. No challenger can enter live trading.'});
  console.log(JSON.stringify({ok:true,json:base+'.json',markdown:base+'.md',monitor:monitorFile,events:meta.events,configs:results.length,workers:Math.min(a.maxWorkers,configs.length),top:[...results].sort((x,y)=>y.metrics.realizedPnl-x.metrics.realizedPnl).slice(0,5).map(x=>({config:x.config,pnl:x.metrics.realizedPnl,dd:x.metrics.maxDrawdownPct,n:x.metrics.n}))},null,2));
 }catch(e){publish({status:'error',phase:'error',error:String(e.message||e),finishedAt:Date.now(),note:'Replay Lab stopped with an error; no live state was changed.'});throw e}
}
export function isMainModule(argv1=process.argv[1]){if(!argv1)return false;try{return path.resolve(fileURLToPath(import.meta.url))===path.resolve(argv1)}catch{return false}}
if(isMainModule())main().catch(e=>{console.error(e?.stack||e);process.exit(1)});

// Phase 0 additive diagnostics entry point. The historical runRange policy and the
// pessimistic execution functions above are deliberately unchanged. This is NOT
// runtime-policy parity: captured ticks omit raw features and historic Lab policies.
export function replayFixedWindow(events, config, { from, to, startSol = 1, solUsd = 200 } = {}) {
  if (!Array.isArray(events)) throw new Error('Replay events must be an array');
  if (![from, to, startSol, solUsd].every(Number.isFinite) || !(to > from) || !(startSol > 0) || !(solUsd > 0))
    throw new Error('Explicit valid window and positive starting capital/SOL price required');
  if (!config || !PRESETS[config.id] || config.filter) throw new Error('Only existing unfiltered reference presets supported');
  for (const event of events) {
    if (!Number.isFinite(event.ts) || !Number.isFinite(event.price) || !(event.price > 0))
      throw new Error('Invalid replay event');
  }
  if (Object.entries(PRESETS[config.id]).some(([key, value]) => config[key] !== value)) throw new Error('Reference preset parameters are immutable');
  const ordered = [...events].sort((a, b) => a.ts - b.ts || String(a.mint).localeCompare(String(b.mint)));
  const range = { id: 'fixed-phase0', trainStart: from, trainEnd: from, testStart: from, testEnd: to };
  return runRange(ordered, config, range, { startSol, solUsd });
}
