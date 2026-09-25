#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const r4=x=>Math.round((Number(x)||0)*1e4)/1e4;
export function median(a){if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2}
const sum=a=>a.reduce((s,x)=>s+Number(x||0),0);
const mean=a=>a.length?sum(a)/a.length:0;
function holdMin(t){const o=Number(t.openedAt||0),c=Number(t.closedAt||t.ts||0);return o&&c?(c-o)/60000:null}
function grossReturnPct(t){
  const entry=Number(t.entryPrice||0),mark=Number(t.lastPrice||0);
  return entry>0&&mark>0?(mark/entry-1)*100:Number(t.returnPct||0);
}

export function cohortStats(trades=[]){
  const t=trades||[],pnls=t.map(x=>Number(x.pnlSol||0)),rets=t.map(x=>Number(x.returnPct||0)),gross=t.map(grossReturnPct);
  const wins=pnls.filter(x=>x>0),losses=pnls.filter(x=>x<0);
  const winSum=sum(wins),lossAbs=Math.abs(sum(losses));
  const mfe=t.map(x=>Number(x.maxFavorablePct||0)),mae=t.map(x=>Number(x.maxAdversePct||0));
  const holds=t.map(holdMin).filter(x=>x!=null);
  const fees=t.map(x=>Number(x.feesSol||0)),entrySlip=t.map(x=>Number(x.entrySlippageBps||0)),exitSlip=t.map(x=>Number(x.exitSlippageBps||0));
  const liqs=t.map(x=>Number(x.lastLiquidityUsd||0)).filter(x=>x>0);
  const sortedAbs=[...pnls].sort((a,b)=>Math.abs(b)-Math.abs(a));
  const top3=sum(sortedAbs.slice(0,3)),closedTotal=sum(pnls);
  return {
    n:t.length,
    sumPnlSol:r4(closedTotal),
    meanPnlSol:r4(mean(pnls)),
    medianPnlSol:r4(median(pnls)),
    medianReturnPct:r4(median(rets)),
    medianGrossReturnPct:r4(median(gross)),
    expectancy:r4(t.length?closedTotal/t.length:0),
    profitFactor:lossAbs?r4(winSum/lossAbs):(winSum?999:0),
    winRatePct:r4(t.length?wins.length/t.length*100:0),
    medianMfePct:r4(median(mfe)),
    medianMaePct:r4(median(mae)),
    medianHoldMin:r4(median(holds)),
    feesSol:r4(sum(fees)),
    medianEntrySlippageBps:r4(median(entrySlip)),
    meanEntrySlippageBps:r4(mean(entrySlip)),
    medianExitSlippageBps:r4(median(exitSlip)),
    meanExitSlippageBps:r4(mean(exitSlip)),
    medianLiquidityUsd:r4(median(liqs)),
    top3PnlConcentrationPct:r4(closedTotal?top3/closedTotal*100:0),
    mfeAtLeast4:t.filter(x=>Number(x.maxFavorablePct||0)>=4).length,
    mfeAtLeast2:t.filter(x=>Number(x.maxFavorablePct||0)>=2).length,
    maeAtMostNeg4:t.filter(x=>Number(x.maxAdversePct||0)<=-4).length,
  };
}

export function reasonMix(history=[]){
  const groups={};
  for(const t of history||[]){const r=String(t.reason||'unknown');(groups[r]||=[]).push(t)}
  return Object.fromEntries(Object.entries(groups).map(([k,xs])=>[k,cohortStats(xs)]));
}

export function liquidityQuartiles(history=[]){
  const liqs=(history||[]).map(t=>Number(t.lastLiquidityUsd||0)).filter(x=>x>0).sort((a,b)=>a-b);
  if(!liqs.length)return {cuts:[],buckets:{}};
  const cut=p=>liqs[Math.min(liqs.length-1,Math.floor((liqs.length-1)*p))];
  const cuts=[cut(.25),cut(.5),cut(.75)];
  const buckets={Q1:[],Q2:[],Q3:[],Q4:[]};
  for(const t of history){
    const v=Number(t.lastLiquidityUsd||0);
    if(v<=cuts[0])buckets.Q1.push(t);
    else if(v<=cuts[1])buckets.Q2.push(t);
    else if(v<=cuts[2])buckets.Q3.push(t);
    else buckets.Q4.push(t);
  }
  return {cuts,buckets:Object.fromEntries(Object.entries(buckets).map(([k,xs])=>[k,{...cohortStats(xs),staleSharePct:r4(xs.length?xs.filter(t=>t.reason==='stale-purge').length/xs.length*100:0)}]))};
}

export function chronologicalHalves(history=[]){
  const xs=[...(history||[])].sort((a,b)=>Number(a.closedAt||0)-Number(b.closedAt||0));
  const mid=Math.floor(xs.length/2);
  return {first:cohortStats(xs.slice(0,mid)),second:cohortStats(xs.slice(mid))};
}

export function hourlyBuckets(history=[]){
  const hours={};
  for(const t of history||[]){
    const ts=Number(t.closedAt||0);if(!ts)continue;
    const key=new Date(ts).toISOString().slice(0,13)+'Z';
    (hours[key]||=[]).push(t);
  }
  return Object.entries(hours).map(([hour,xs])=>({hour,...cohortStats(xs)})).sort((a,b)=>a.sumPnlSol-b.sumPnlSol);
}

// Compare against the maxHold actually in force, not a hardcoded 25. An evolution champion
// overrides maxHold (index.js:312 takes it from evolutionChampionPolicy, whose only bound is
// Math.max(1, ...)), so a champion running a 2-minute hold made this report "hold time does not
// match SPRINT maxHold 25" forever. researchReport.js gates on that string, and a gate that
// always fires is a gate nobody reads.
export function diagnoseStalePurge(history=[],{maxHoldMin=25,maxHoldSource='default'}={}){
  const stale=(history||[]).filter(t=>t.reason==='stale-purge');
  const stats=cohortStats(stale);
  const hold=stats.medianHoldMin;
  const matches=Math.abs(hold-maxHoldMin)<=2;
  const cause=matches
    ? `maxHold ${maxHoldMin}-min timer (${maxHoldSource})`
    : `hold time ${r4(hold)} min does not match maxHold ${maxHoldMin} (${maxHoldSource})`;
  return {
    n:stale.length,
    cause,
    matchesMaxHold:matches,
    maxHoldMin,
    maxHoldSource,
    ...stats,
    sharePct:r4(history.length?stale.length/history.length*100:0),
  };
}

// What index.js:312 would actually use: the applied champion's maxHoldMin, else the exit preset,
// else the MAX_HOLD_MIN default.
const EXIT_PRESET_MAX_HOLD={ultraScalp:10,sprint:25,scalper:25,runner:120,moonbag:240,yolo:360};
export function effectiveMaxHold(state={}){
  const champ=state?.evolutionLoop?.champion;
  const applied=state?.runtime?.activeEvolutionChampionId;
  const fromChamp=Number(champ?.variant?.maxHoldMin);
  if(applied&&champ?.id===applied&&Number.isFinite(fromChamp)&&fromChamp>0)
    return {maxHoldMin:Math.max(1,fromChamp),maxHoldSource:`champion ${champ.id}`};
  const preset=String(state?.runtime?.exitPreset||'');
  if(EXIT_PRESET_MAX_HOLD[preset])return {maxHoldMin:EXIT_PRESET_MAX_HOLD[preset],maxHoldSource:`preset ${preset}`};
  return {maxHoldMin:25,maxHoldSource:'default'};
}

export function diagnoseCloses(history=[],meta={}){
  const xs=Array.isArray(history)?history:[];
  const overall=cohortStats(xs);
  const reasons=reasonMix(xs);
  const liq=liquidityQuartiles(xs);
  const halves=chronologicalHalves(xs);
  const hourly=hourlyBuckets(xs);
  const stale=diagnoseStalePurge(xs,{maxHoldMin:meta.maxHoldMin??25,maxHoldSource:meta.maxHoldSource??'default'});
  const negativeMedian=overall.medianReturnPct<0;
  return {
    n:xs.length,
    profile:meta.profile||null,
    strategy:meta.strategy||(xs[0]?.strategy||null),
    firstClosedAt:xs[0]?Number(xs[0].closedAt||0):null,
    lastClosedAt:xs.length?Number(xs.at(-1).closedAt||0):null,
    overall,
    negativeMedian,
    reasons,
    liquidityQuartiles:liq,
    chronologicalHalves:halves,
    worstHours:hourly.slice(0,5),
    stalePurge:stale,
    verdict:{
      negativeMedian,
      frictionFlip:overall.medianGrossReturnPct>=0&&overall.medianReturnPct<0,
      stalePurgeCause:stale.cause,
      stalePurgeN:stale.n,
      dominantLossReason:Object.entries(reasons).sort((a,b)=>a[1].sumPnlSol-b[1].sumPnlSol)[0]?.[0]||null,
    },
  };
}

export function loadHistoryFile(file){
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  const history=Array.isArray(raw)?raw:(raw.history||[]);
  const profile=raw.runtime?.profile||null;
  const {maxHoldMin,maxHoldSource}=effectiveMaxHold(Array.isArray(raw)?{}:raw);
  return {history,profile,strategy:history[0]?.strategy||null,maxHoldMin,maxHoldSource,source:path.resolve(file)};
}

function parseArgs(argv){
  const a={out:null,state:null};
  for(let i=0;i<argv.length;i++){
    const k=argv[i],v=argv[i+1];
    if(k==='--state'){a.state=v;i++}
    else if(k==='--out'){a.out=v;i++}
  }
  return a;
}

function resolveStatePath(explicit){
  if(explicit)return path.resolve(explicit);
  if(process.env.MONEY_PRINTER_DATA_DIR)return path.join(path.resolve(process.env.MONEY_PRINTER_DATA_DIR),'state.json');
  if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','Money Printer OS','data','state.json');
  return path.resolve('data','state.json');
}

export function isMainModule(argv1=process.argv[1]){
  if(!argv1)return false;
  try{return path.resolve(fileURLToPath(import.meta.url))===path.resolve(argv1)}catch{return false}
}

function main(){
  const a=parseArgs(process.argv.slice(2));
  const statePath=resolveStatePath(a.state);
  const loaded=loadHistoryFile(statePath);
  const report=diagnoseCloses(loaded.history,{profile:loaded.profile,strategy:loaded.strategy,maxHoldMin:loaded.maxHoldMin,maxHoldSource:loaded.maxHoldSource});
  report.source=loaded.source;
  const out=a.out||path.resolve('reports','research','forensics-closes.json');
  const dest=path.resolve(out);
  const appData=path.resolve(os.homedir(),'Library','Application Support','Money Printer OS');
  if(dest.startsWith(appData))throw new Error('refusing to write into the app data directory');
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:true,out:dest,n:report.n,medianReturnPct:report.overall.medianReturnPct,stalePurge:report.stalePurge.n,cause:report.stalePurge.cause},null,2));
}

if(isMainModule())main();
