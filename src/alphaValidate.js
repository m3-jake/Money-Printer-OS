#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { compareClusterGroups, median } from './edgeProof.js';
import { economicLiquidityOf, MIN_RESEARCH_LIQUIDITY_USD, OUTCOME_FEATURE_SQL, prepareOutcomeRows, SENTINEL_LIQUIDITY_USD } from './hypothesisMiner.js';

const r4=x=>Math.round((Number(x)||0)*1e4)/1e4;
function pctile(a,p){if(!a.length)return null;const x=[...a].sort((a,b)=>a-b);return x[Math.min(x.length-1,Math.floor((x.length-1)*p))]}
function hash(s=''){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}

function sortOutcomes(rows){
  return [...rows].sort((a,b)=>Number(a.entry_ts||0)-Number(b.entry_ts||0)||String(a.mint||'').localeCompare(String(b.mint||'')));
}
function rangeFromIdx(xs,id,trainStartIdx,trainEndIdx,testStartIdx,testEndIdx){
  const n=xs.length,ts=i=>Number(xs[Math.max(0,Math.min(n-1,i))].entry_ts||0);
  return {
    id,trainStartIdx,trainEndIdx,testStartIdx,testEndIdx,
    trainStart:ts(trainStartIdx),trainEnd:trainEndIdx>=n?ts(n-1)+1:ts(trainEndIdx),
    testStart:ts(testStartIdx),testEnd:testEndIdx>=n?ts(n-1)+1:ts(testEndIdx),
  };
}
export function splitRanges(rows,mode='chronological'){
  const xs=sortOutcomes(rows);
  const n=xs.length;
  if(!n)return[];
  if(mode==='walk'){
    const specs=[{id:'wf1',trainEnd:.50,testEnd:.70},{id:'wf2',trainEnd:.65,testEnd:.85},{id:'wf3',trainEnd:.80,testEnd:1}];
    const out=[];
    for(const s of specs){
      const trainEndIdx=Math.max(1,Math.floor(n*s.trainEnd));
      const testEndIdx=Math.min(n,s.testEnd>=1?n:Math.floor(n*s.testEnd));
      const testStartIdx=trainEndIdx;
      if(trainEndIdx<40||testEndIdx-testStartIdx<30)continue;
      out.push(rangeFromIdx(xs,s.id,0,trainEndIdx,testStartIdx,testEndIdx));
    }
    return out;
  }
  const cut=Math.max(1,Math.floor(n*.6));
  return [rangeFromIdx(xs,'chron',0,cut,cut,n)];
}

function expectancy(rows){const xs=rows.map(r=>Number(r.adjusted_return||0));return xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:0}
function profitFactor(rows){
  const xs=rows.map(r=>Number(r.adjusted_return||0));
  const wins=xs.filter(x=>x>0).reduce((s,x)=>s+x,0),loss=Math.abs(xs.filter(x=>x<0).reduce((s,x)=>s+x,0));
  return loss?wins/loss:(wins?999:0);
}
function drawdownPct(rows){
  const xs=[...rows].sort((a,b)=>Number(a.entry_ts||0)-Number(b.entry_ts||0));
  let eq=0,peak=0,dd=0;
  for(const r of xs){eq+=Number(r.adjusted_return||0);peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq)}
  return peak?dd:dd;
}
function topClusterConcentrationPct(rows){
  const m=new Map();
  for(const r of rows){const k=r.cluster_id||r.cluster||r.mint;m.set(k,(m.get(k)||0)+Number(r.adjusted_return||0))}
  const totals=[...m.values()].sort((a,b)=>Math.abs(b)-Math.abs(a));
  const all=totals.reduce((s,x)=>s+x,0),top3=totals.slice(0,3).reduce((s,x)=>s+x,0);
  return all?top3/all*100:0;
}
function frictionDrag(rows){
  const raw=rows.map(r=>Number(r.raw_return||0)),adj=rows.map(r=>Number(r.adjusted_return||0));
  return {rawMedian:median(raw),adjustedMedian:median(adj),dragPct:median(raw)-median(adj)};
}

export function scoreLiquiditySplit(rows,cut,{minLiquidity=MIN_RESEARCH_LIQUIDITY_USD}={}){
  const hi=rows.filter(r=>economicLiquidityOf(r,{min:minLiquidity})>=cut);
  const lo=rows.filter(r=>{const v=economicLiquidityOf(r,{min:minLiquidity});return Number.isFinite(v)&&v<cut});
  const scored=compareClusterGroups(hi,lo,hash(`cold-liq:${cut}`),400);
  return {
    cut,nHi:hi.length,nLo:lo.length,
    delta:scored.delta,medianDelta:scored.medianDelta,rawDelta:scored.rawDelta,contaminated:scored.contaminated,
    topMedian:scored.hi.median,restMedian:scored.lo.median,topRobust:scored.hi.robustMean,restRobust:scored.lo.robustMean,
    ciLow:scored.ci.lo,ciHigh:scored.ci.high,pPositive:scored.ci.p,
    topExpectancy:expectancy(hi),restExpectancy:expectancy(lo),
    topProfitFactor:profitFactor(hi),restProfitFactor:profitFactor(lo),
    topDrawdown:drawdownPct(hi),restDrawdown:drawdownPct(lo),
    top3ConcentrationPct:topClusterConcentrationPct(hi),
    friction:frictionDrag(hi),
    restFriction:frictionDrag(lo),
  };
}

export function trainLiquidityCut(trainRows,{minLiquidity=MIN_RESEARCH_LIQUIDITY_USD}={}){
  const xs=trainRows.map(r=>economicLiquidityOf(r,{min:minLiquidity})).filter(Number.isFinite).sort((a,b)=>a-b);
  return pctile(xs,.75);
}

function sliceRange(ordered,range){
  if(range&&Number.isInteger(range.trainStartIdx)&&Number.isInteger(range.testStartIdx)){
    return {
      train:ordered.slice(range.trainStartIdx,range.trainEndIdx),
      test:ordered.slice(range.testStartIdx,range.testEndIdx),
    };
  }
  const train=(ordered||[]).filter(r=>Number(r.entry_ts)>=range.trainStart&&Number(r.entry_ts)<range.trainEnd);
  const test=(ordered||[]).filter(r=>Number(r.entry_ts)>=range.testStart&&Number(r.entry_ts)<range.testEnd);
  return {train,test};
}

function rawLiquidity(r){
  const v=Number(r?.liquidity);if(Number.isFinite(v))return v;
  const o=Number(r?.obs_liquidity);return Number.isFinite(o)?o:NaN;
}

export function validateColdLiquidity(rows,{split='chronological',minLiquidity=MIN_RESEARCH_LIQUIDITY_USD}={}){
  const prepared=prepareOutcomeRows((rows||[]).filter(r=>(r.regime||'UNKNOWN')==='COLD'&&Number(r.horizon_min||r.horizonMin||30)===30));
  const sentinel=prepared.rows.filter(r=>{const v=rawLiquidity(r);return Number.isFinite(v)&&v<=SENTINEL_LIQUIDITY_USD}).length;
  const subEconomic=prepared.rows.filter(r=>{const v=rawLiquidity(r);return Number.isFinite(v)&&v>SENTINEL_LIQUIDITY_USD&&v<minLiquidity}).length;
  const ordered=sortOutcomes(prepared.rows.filter(r=>Number.isFinite(economicLiquidityOf(r,{min:minLiquidity}))));
  const ranges=splitRanges(ordered,split);
  const splits=[];
  for(const range of ranges){
    const {train,test}=sliceRange(ordered,range);
    const cut=trainLiquidityCut(train,{minLiquidity});
    if(cut==null||!test.length){splits.push({id:range.id,cut,nTrain:train.length,nTest:test.length,ok:false,reason:'insufficient-split'});continue}
    const scored=scoreLiquiditySplit(test,cut,{minLiquidity});
    if(scored.nHi<5||scored.nLo<10){splits.push({id:range.id,cut,nTrain:train.length,nTest:test.length,...scored,ok:false,reason:'degenerate-cut'});continue}
    splits.push({id:range.id,nTrain:train.length,nTest:test.length,...scored,ok:true,positive:scored.delta>0&&scored.medianDelta>0&&scored.topMedian>0&&!scored.contaminated});
  }
  const chronRange=splitRanges(ordered,'chronological')[0];
  const overallSlices=chronRange?sliceRange(ordered,chronRange):{train:ordered.slice(0,Math.floor(ordered.length*.6)),test:ordered.slice(Math.floor(ordered.length*.6))};
  const overallCut=trainLiquidityCut(overallSlices.train,{minLiquidity})??trainLiquidityCut(ordered,{minLiquidity});
  const overall=overallCut==null||!overallSlices.test.length?null:scoreLiquiditySplit(overallSlices.test,overallCut,{minLiquidity});
  const measured=splits.filter(x=>x.ok);
  const positiveSplits=measured.filter(x=>x.positive).length;
  const fail=[];
  if(!overall||overall.nHi<20||overall.nLo<40)fail.push('sample-too-small');
  if(overall?.contaminated)fail.push('contaminated');
  if(!(overall?.delta>0)||!(overall?.medianDelta>0))fail.push('no-positive-delta');
  if(!(overall?.ciLow>0))fail.push('ci-not-positive');
  if(!(overall?.topMedian>0))fail.push('top-median-not-positive');
  if(!measured.length)fail.push('no-valid-splits');
  else if(positiveSplits/measured.length<.66)fail.push('split-inconsistent');
  if(Math.abs(Number(overall?.top3ConcentrationPct||0))>80)fail.push('top-cluster-concentration');
  return {
    quarantined:prepared.quarantined,
    sentinelLiquidity:sentinel,
    subEconomicLiquidity:subEconomic,
    rawN:prepared.rows.length,
    n:ordered.length,
    minLiquidity,
    overall,
    splits,
    positiveSplits,
    measuredSplits:measured.length,
    totalSplits:splits.length,
    pass:fail.length===0,
    fail,
    criteria:{
      minTop:20,minRest:40,requirePositiveDelta:true,requirePositiveMedianDelta:true,
      requirePositiveTopMedian:true,requirePositiveCiLow:true,minPositiveSplitShare:.66,maxTop3ConcentrationPct:80,
      notContaminated:true,trainDerivedCut:true,impossibleOutcomesQuarantined:true,
      sentinelLiquidityExcluded:true,minResearchLiquidityUsd:minLiquidity,countBasedSplits:true,
    },
  };
}

export function loadColdOutcomes(dbPath){
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const rows=db.prepare(`SELECT ${OUTCOME_FEATURE_SQL} FROM outcomes o JOIN (SELECT mint,MIN(entry_ts) ets FROM outcomes WHERE horizon_min=30 GROUP BY mint) eo ON eo.mint=o.mint AND eo.ets=o.entry_ts LEFT JOIN (SELECT t.* FROM token_observations t JOIN (SELECT mint,MIN(ts) mts FROM token_observations GROUP BY mint) f ON f.mint=t.mint AND f.mts=t.ts) x ON x.mint=o.mint WHERE o.horizon_min=30 AND o.regime='COLD'`).all();
    return rows;
  }finally{try{db.close()}catch{}}
}

function parseArgs(argv){
  const a={db:null,out:null,split:'chronological'};
  for(let i=0;i<argv.length;i++){
    const k=argv[i],v=argv[i+1];
    if(k==='--db'){a.db=v;i++}else if(k==='--out'){a.out=v;i++}else if(k==='--split'){a.split=v;i++}
  }
  return a;
}
function resolveDb(explicit){
  if(explicit)return path.resolve(explicit);
  if(process.env.MONEY_PRINTER_DATA_DIR)return path.join(path.resolve(process.env.MONEY_PRINTER_DATA_DIR),'alpha-lab.sqlite');
  if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','Money Printer OS','data','alpha-lab.sqlite');
  return path.resolve('data','alpha-lab.sqlite');
}
export function isMainModule(argv1=process.argv[1]){
  if(!argv1)return false;
  try{return path.resolve(fileURLToPath(import.meta.url))===path.resolve(argv1)}catch{return false}
}
function main(){
  const a=parseArgs(process.argv.slice(2));
  const dbPath=resolveDb(a.db);
  const rows=loadColdOutcomes(dbPath);
  const chron=validateColdLiquidity(rows,{split:'chronological'});
  const walk=validateColdLiquidity(rows,{split:'walk'});
  const report={db:dbPath,chronological:chron,walkForward:walk,pass:chron.pass&&walk.pass};
  const out=a.out||path.resolve('reports','research','cold-liquidity-validate.json');
  const dest=path.resolve(out);
  const appData=path.resolve(os.homedir(),'Library','Application Support','Money Printer OS');
  if(dest.startsWith(appData))throw new Error('refusing to write into the app data directory');
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:true,out:dest,pass:report.pass,chronFail:chron.fail,walkFail:walk.fail,n:chron.n,quarantined:chron.quarantined},null,2));
}
if(isMainModule())main();
