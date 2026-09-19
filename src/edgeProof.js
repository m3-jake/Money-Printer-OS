import fs from 'node:fs';
import path from 'node:path';
import { alphaDb } from './alphaDb.js';
import { summarizeLatencyRows } from './latencyStats.js';

const PROOF_PATH=path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data', 'edge-proof.json');
const HORIZONS=[5,30,120];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,Number(x)||0));
export const IMPOSSIBLE_RAW_HI=1900;
export const IMPOSSIBLE_RAW_LO=-100;
export function clampAdjustedReturn(v){return clamp(v,-100,500)}
export function isImpossibleOutcome(r){const raw=Number(r?.raw_return);return Number.isFinite(raw)&&(raw>IMPOSSIBLE_RAW_HI||raw<IMPOSSIBLE_RAW_LO)}
const mean=xs=>xs.length?xs.reduce((s,x)=>s+Number(x||0),0)/xs.length:0;
const q=(xs,p)=>{if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor((a.length-1)*p))]};
function hash(s=''){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
function rng(seed=1){let x=seed>>>0||1;return()=>{x=(Math.imul(1664525,x)+1013904223)>>>0;return x/4294967296}}
function rowReturn(r){const v=Number(r?.adjusted_return);if(Number.isFinite(v))return v;const x=Number(r?.value);return Number.isFinite(x)?x:0}
function clusterKey(r){return r.proof_cluster||r.cluster_id||r.cluster||r.mint}

export function median(xs){if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y);const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}

// Symmetric 10% tail winsorization of cluster summaries. k>=1 once n>=5 so a
// single pathological jump cannot remain the 90th-percentile cap.
function winsorBounds(xs,p=0.10){
  const s=[...xs].sort((a,b)=>a-b);
  if(s.length<5)return{lo:s[0]??0,hi:s[s.length-1]??0,k:0};
  const k=Math.max(1,Math.floor(s.length*p));
  return{lo:s[k],hi:s[s.length-1-k],k};
}
function winsorize(xs,p=0.10){
  if(!xs.length)return[];
  const{lo,hi}=winsorBounds(xs,p);
  return xs.map(v=>Math.max(lo,Math.min(hi,v)));
}
export function robustMean(xs){return xs.length?mean(winsorize(xs)):0}

export function summarizeValues(xs){
  const n=xs.length;
  if(!n)return{n:0,mean:0,median:0,robustMean:0,positiveRate:0,outlierN:0,contaminated:false,winsorLo:0,winsorHi:0};
  const mu=mean(xs),med=median(xs),{lo,hi,k}=winsorBounds(xs),clipped=xs.map(v=>Math.max(lo,Math.min(hi,v))),rm=mean(clipped);
  const outlierN=xs.filter(v=>v<lo||v>hi).length;
  const positiveRate=xs.filter(v=>v>0).length/n;
  const contaminated=(mu>0&&med<=0)||(mu>0&&positiveRate<0.35);
  return{n,mean:mu,median:med,robustMean:rm,positiveRate,outlierN,contaminated,winsorLo:lo,winsorHi:hi,winsorK:k};
}

export function clusterValues(rows,valueOf=rowReturn){
  const m=new Map();
  for(const r of rows||[]){const k=clusterKey(r),a=m.get(k)||[];a.push(Number(valueOf(r)||0));m.set(k,a)}
  return[...m.values()].map(median);
}
export function summarizeClusterReturns(rows,valueOf=rowReturn){return summarizeValues(clusterValues(rows,valueOf))}

function bootstrapRobustDelta(hiC,loC,seed=1,iterations=700){
  if(hiC.length<3||loC.length<3)return{low:null,high:null,pPositive:null};
  const random=rng(seed),ds=[];let pos=0;
  for(let n=0;n<iterations;n++){
    const aS=[],bS=[];
    for(let i=0;i<hiC.length;i++)aS.push(hiC[Math.floor(random()*hiC.length)]);
    for(let i=0;i<loC.length;i++)bS.push(loC[Math.floor(random()*loC.length)]);
    const d=robustMean(aS)-robustMean(bS);ds.push(d);if(d>0)pos++;
  }
  ds.sort((a,b)=>a-b);
  return{low:q(ds,.025),high:q(ds,.975),pPositive:pos/iterations};
}

export function bootstrapRobustMean(rows,seed='x',iterations=500){
  const xs=clusterValues(rows);
  if(xs.length<5)return{low:null,high:null};
  const random=rng(hash(seed)),out=[];
  for(let n=0;n<iterations;n++){let s=[];for(let i=0;i<xs.length;i++)s.push(xs[Math.floor(random()*xs.length)]);out.push(robustMean(s))}
  out.sort((a,b)=>a-b);
  return{low:q(out,.025),high:q(out,.975)};
}

export function compareClusterGroups(hiRows,loRows,seed=1,iterations=700){
  const hiC=clusterValues(hiRows),loC=clusterValues(loRows);
  const hi=summarizeValues(hiC),lo=summarizeValues(loC);
  const delta=hi.robustMean-lo.robustMean,rawDelta=hi.mean-lo.mean,medianDelta=hi.median-lo.median;
  const contaminated=hi.contaminated||(rawDelta>0&&hi.median<=0);
  const boot=iterations>0?bootstrapRobustDelta(hiC,loC,seed,iterations):{low:null,high:null,pPositive:null};
  return{delta,rawDelta,medianDelta,contaminated,hi,lo,ci:{lo:boot.low,high:boot.high,p:boot.pPositive}};
}

export function hypothesisStatus(scored){
  const lo=scored?.ci?.lo,high=scored?.ci?.high,delta=Number(scored?.delta||0),med=Number(scored?.hi?.median||0);
  if(scored?.contaminated)return high<0&&delta<-1?'NEGATIVE EVIDENCE':'WEAK';
  if(lo>0&&delta>1&&med>0)return'POSITIVE EVIDENCE';
  if(high<0&&delta<-1)return'NEGATIVE EVIDENCE';
  return'WEAK';
}

function bootstrapDelta(hi,lo,seed=1,iterations=700){
  const boot=bootstrapRobustDelta(clusterValues(hi),clusterValues(lo),seed,iterations);
  return{low:boot.low,high:boot.high,pPositive:boot.pPositive};
}
function effect(rows,cut){
  const hi=rows.filter(r=>Number(r.edge)>=cut),lo=rows.filter(r=>Number(r.edge)<cut);
  const scored=compareClusterGroups(hi,lo,1,0);
  return{
    hi,lo,delta:scored.delta,topAvg:scored.hi.robustMean,restAvg:scored.lo.robustMean,
    topMedian:scored.hi.median,restMedian:scored.lo.median,
    topPositiveRate:scored.hi.positiveRate,restPositiveRate:scored.lo.positiveRate,
    rawDelta:scored.rawDelta,rawTopAvg:scored.hi.mean,rawRestAvg:scored.lo.mean,
    outlierClusters:scored.hi.outlierN,contaminated:scored.contaminated
  };
}
function recentStability(rows,cut){if(rows.length<30)return null;const s=[...rows].sort((a,b)=>a.entry_ts-b.entry_ts),mid=Math.floor(s.length/2),a=effect(s.slice(0,mid),cut),b=effect(s.slice(mid),cut);if(a.hi.length<3||a.lo.length<5||b.hi.length<3||b.lo.length<5)return null;return{earlyDelta:a.delta,recentDelta:b.delta,stable:a.delta>0&&b.delta>0&&a.topMedian>0&&b.topMedian>0}}
function regimeCoverage(rows,cut){const out=[];for(const regime of [...new Set(rows.map(r=>r.regime||'UNKNOWN'))]){const xs=rows.filter(r=>(r.regime||'UNKNOWN')===regime);if(xs.length<12)continue;const e=effect(xs,cut);if(e.hi.length<3||e.lo.length<6)continue;out.push({regime,samples:xs.length,delta:e.delta,medianDelta:e.topMedian-e.restMedian,contaminated:e.contaminated,positive:e.delta>0&&e.topAvg>0&&e.topMedian>0&&!e.contaminated});}return out.sort((a,b)=>b.samples-a.samples)}

export function proveRows(allRows,horizon){
  const rows=(allRows||[]).filter(r=>Number(r.horizon_min)===Number(horizon)&&Number.isFinite(Number(r.adjusted_return))&&Number.isFinite(Number(r.edge))).map(r=>({...r,adjusted_return:clamp(r.adjusted_return,-100,500),edge:clamp(r.edge,0,100)}));
  const development=rows.filter(r=>hash(r.proof_cluster||r.cluster_id||r.mint)%5!==0),holdout=rows.filter(r=>hash(r.proof_cluster||r.cluster_id||r.mint)%5===0);
  const cut=development.length?q(development.map(r=>Number(r.edge)),.75):85;
  const e=effect(holdout,cut),ci=bootstrapDelta(e.hi,e.lo,hash(`proof:${horizon}`)),stability=recentStability(holdout,cut),regimes=regimeCoverage(holdout,cut);
  const hit=(xs,t)=>xs.length?xs.filter(r=>Number(r.adjusted_return)>=t).length/xs.length*100:0;
  const holdoutClusters=new Set(holdout.map(r=>r.proof_cluster||r.cluster_id||r.mint)).size;
  const topClusters=new Set(e.hi.map(r=>r.proof_cluster||r.cluster_id||r.mint)).size;
  const evidence=holdout.length>=40&&topClusters>=8&&ci.low!=null&&ci.low>0&&e.delta>1&&e.topAvg>0&&e.topMedian>0&&!e.contaminated;
  return {horizonMin:horizon,total:rows.length,development:development.length,holdout:holdout.length,holdoutClusters,cutoff:cut,topN:e.hi.length,topClusters,topAvgAdjustedPct:e.topAvg,restAvgAdjustedPct:e.restAvg,deltaPct:e.delta,ciLow:ci.low,ciHigh:ci.high,pPositive:ci.pPositive,topHit25Pct:hit(e.hi,25),topHit100Pct:hit(e.hi,100),restHit25Pct:hit(e.lo,25),topMedianAdjustedPct:e.topMedian,restMedianAdjustedPct:e.restMedian,topPositivePct:e.topPositiveRate*100,restPositivePct:e.restPositiveRate*100,deltaRawPct:e.rawDelta,topRawAvgAdjustedPct:e.rawTopAvg,restRawAvgAdjustedPct:e.rawRestAvg,outlierClusters:e.outlierClusters,contaminated:e.contaminated,stability,regimes,positiveRegimes:regimes.filter(x=>x.positive).length,evidence};
}

function queryIndependentRows(){
  const d=alphaDb();
  return d.prepare(`
    SELECT o.*, COALESCE(
      (SELECT t.cluster_id FROM token_observations t WHERE t.mint=o.mint AND t.cluster_id IS NOT NULL ORDER BY t.ts ASC LIMIT 1),
      o.cluster_id,o.mint
    ) AS proof_cluster
    FROM outcomes o
    JOIN (SELECT mint,horizon_min,MIN(entry_ts) entry_ts FROM outcomes GROUP BY mint,horizon_min) x
      ON x.mint=o.mint AND x.horizon_min=o.horizon_min AND x.entry_ts=o.entry_ts
    WHERE o.horizon_min IN (5,30,120)
  `).all();
}

const HYPOTHESIS_MAX_AGE_MS=6*3600_000;
function bestAlpha(d,now=Date.now()){
  const rows=d.prepare(`SELECT title,feature,regime,samples,clusters,delta,ci_low,ci_high,p_positive,status FROM hypothesis_results WHERE status='POSITIVE EVIDENCE' AND updated_ts>? ORDER BY ci_low DESC,clusters DESC LIMIT 12`).all(now-HYPOTHESIS_MAX_AGE_MS);
  return rows.map(r=>({...r,qualityScore:Math.max(0,Number(r.ci_low||0))*Math.log2(Number(r.clusters||1)+1)}));
}
export function latencyDiagnosis(d,now=Date.now()){
  const rows=d.prepare(`SELECT discovery_ms,analysis_ms,ready_ms,proposal_ms,wait_ms,source_event_ts,discovered_ts,ready_ts,proposal_ts FROM latency_events WHERE ts>?`).all(now-24*3600_000);
  return summarizeLatencyRows(rows);
}

export function computeEdgeProof(){
  const d=alphaDb(),rows=queryIndependentRows(),horizons=Object.fromEntries(HORIZONS.map(h=>[h,proveRows(rows,h)]));
  const independentMints=new Set(rows.filter(r=>r.horizon_min===30).map(r=>r.mint)).size;
  const h30=horizons[30],h120=horizons[120];
  const enoughForReview=h30.holdout>=40&&h120.holdout>=25;
  const promising=h30.evidence&&h120.deltaPct>0&&h120.ciLow!=null&&h120.ciLow>-1&&h30.positiveRegimes>=2;
  const proven=independentMints>=1000&&h30.holdout>=150&&h120.holdout>=100&&h30.evidence&&h120.evidence&&h30.positiveRegimes>=2&&h120.positiveRegimes>=2&&h30.stability?.stable===true&&h120.stability?.stable===true;
  const disproven=enoughForReview&&((h30.ciHigh!=null&&h30.ciHigh<=0)||(h120.ciHigh!=null&&h120.ciHigh<0));
  const status=proven?'PROVEN':disproven?'NO EDGE':promising?'PROMISING':enoughForReview?'INCONCLUSIVE':'COLLECTING';
  const approvedHorizons=proven?HORIZONS.filter(h=>horizons[h].evidence):[];
  const sampleProgress=Math.min(1,independentMints/1000),holdoutProgress=Math.min(1,h30.holdout/150),evidenceProgress=(h30.evidence?0.5:0)+(h120.evidence?0.5:0),regimeProgress=Math.min(1,Math.min(h30.positiveRegimes,h120.positiveRegimes)/2),stabilityProgress=((h30.stability?.stable?1:0)+(h120.stability?.stable?1:0))/2;
  const proofScore=Math.round(100*(sampleProgress*.30+holdoutProgress*.15+evidenceProgress*.30+regimeProgress*.15+stabilityProgress*.10));
  const blockers=[];if(independentMints<1000)blockers.push(`${1000-independentMints} more independent 30m launches`);if(h30.holdout<150)blockers.push(`${150-h30.holdout} more 30m holdout launches`);if(h120.holdout<100)blockers.push(`${100-h120.holdout} more 2h holdout launches`);if(!h30.evidence)blockers.push('30m execution-adjusted edge not statistically positive');if(!h120.evidence)blockers.push('2h runner edge not statistically positive');if(h30.positiveRegimes<2||h120.positiveRegimes<2)blockers.push('edge not demonstrated in 2+ regimes');if(h30.stability?.stable!==true||h120.stability?.stable!==true)blockers.push('edge not stable across older vs recent holdout');
  const alpha=bestAlpha(d),latency=latencyDiagnosis(d);let nextAction='KEEP COLLECTING CLEAN OUTCOMES';if(proven)nextAction=alpha[0]?`SHADOW-TEST / PROTECT: ${alpha[0].title}`:'PROTECT THE PROVEN FAST EDGE';else if(independentMints<300)nextAction='COLLECT MORE INDEPENDENT LAUNCHES — DO NOT TUNE YET';else if(latency.samples>=10&&latency.bottleneck==='DISCOVERY'&&latency.discovery>1000)nextAction='DISCOVERY LATENCY IS THE BOTTLENECK — UPGRADE FEED BEFORE SCORING';else if(h30.ciHigh!=null&&h30.ciHigh<=0)nextAction='FAST EDGE IS NOT SEPARATING 30M OUTCOMES — RESEARCH A DIFFERENT SIGNAL';else if(alpha[0])nextAction=`SHADOW-TEST STRONGEST ALPHA: ${alpha[0].title}`;else if(h30.evidence&&!h120.evidence)nextAction='30M EDGE EXISTS; FOCUS RESEARCH ON 2H RUNNER SELECTION';return {version:1,updatedAt:Date.now(),status,proofScore,productionLearningUnlocked:proven,approvedHorizons,independentMints,horizons,bestAlpha:alpha,latency,blockers:proven?[]:blockers.slice(0,8),nextAction,criteria:{independentMints:1000,holdout30m:150,holdout2h:100,positiveRegimes:2,requiresPositive95CI:true,requiresRecentStability:true,label:'execution-adjusted holdout return'}};
}

export function writeEdgeProof(){const proof=computeEdgeProof();fs.mkdirSync(path.dirname(PROOF_PATH),{recursive:true});const tmp=`${PROOF_PATH}.tmp`;fs.writeFileSync(tmp,JSON.stringify(proof,null,2));fs.renameSync(tmp,PROOF_PATH);return proof;}
let cache={at:0,value:null};
export function edgeProofSnapshot(){
  if(Date.now()-cache.at<15_000&&cache.value)return cache.value;
  try{
    // The research worker writes this every two minutes. Prefer the precomputed proof
    // so frequent dashboard polling never competes with the scanner/worker for SQLite.
    if(fs.existsSync(PROOF_PATH)){
      const stat=fs.statSync(PROOF_PATH);
      if(Date.now()-stat.mtimeMs<5*60_000){
        const value=JSON.parse(fs.readFileSync(PROOF_PATH,'utf8'));
        cache={at:Date.now(),value};return value;
      }
    }
    cache={at:Date.now(),value:computeEdgeProof()};return cache.value;
  }catch(e){return{version:1,updatedAt:Date.now(),status:'UNAVAILABLE',proofScore:0,productionLearningUnlocked:false,approvedHorizons:[],independentMints:0,horizons:{},bestAlpha:[],blockers:[e.message],latency:{samples:0,bottleneck:'UNAVAILABLE'}}}
}
