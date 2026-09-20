import fs from 'node:fs';
import path from 'node:path';
import { alphaDb } from './alphaDb.js';
import { estimateRoundTripFrictionPct } from './executionSim.js';
import { compareClusterGroups, summarizeClusterReturns, bootstrapRobustMean, clampAdjustedReturn, isImpossibleOutcome } from './edgeProof.js';
import { featureValueOf, HYPOTHESIS_MAX_AGE_MS, OUTCOME_FEATURE_SQL } from './hypothesisMiner.js';

const OUT=path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data', 'alpha-insights.json');
function hash(s=''){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
function baseRows(d){return d.prepare(`
 SELECT ${OUTCOME_FEATURE_SQL}, COALESCE(x.cluster_id,o.cluster_id,o.mint) cluster, x.retention60
 FROM outcomes o
 JOIN (SELECT mint,MIN(entry_ts) ets FROM outcomes WHERE horizon_min=30 GROUP BY mint) eo ON eo.mint=o.mint AND eo.ets=o.entry_ts
 LEFT JOIN (SELECT t.* FROM token_observations t JOIN (SELECT mint,MIN(ts) mts FROM token_observations GROUP BY mint) z ON z.mint=t.mint AND z.mts=t.ts) x ON x.mint=o.mint
 WHERE o.horizon_min=30
 `).all().filter(r=>!isImpossibleOutcome(r)).map(r=>({...r,adjusted_return:clampAdjustedReturn(r.adjusted_return)})).filter(r=>hash(r.cluster||r.mint)%5===0)}
function featureValue(r,f){return featureValueOf(r,f)}
function robustSplitDelta(hi,lo,seed){if(!hi.length||!lo.length)return null;return compareClusterGroups(hi,lo,hash(seed),0).delta}
export function evaluateSignal(rows,h){let payload={};try{payload=JSON.parse(h.payload_json||'{}')}catch{}const applicable=rows.filter(r=>h.regime==='ALL'||(r.regime||'UNKNOWN')===h.regime);let hi=[],lo=[];if(String(h.feature).includes('+')){const [a,b]=String(h.feature).split('+'),ca=Number(payload.cutA),cb=Number(payload.cutB);for(const r of applicable){const av=featureValue(r,a),bv=featureValue(r,b);if(!Number.isFinite(av)||!Number.isFinite(bv))continue;(av>=ca&&bv>=cb?hi:lo).push(r)}}else{const cut=Number(payload.cut),f=h.feature;for(const r of applicable){const v=featureValue(r,f);if(!Number.isFinite(v))continue;(v>=cut?hi:lo).push(r)}}if(hi.length<5||lo.length<10)return null;const ordered=[...applicable].sort((a,b)=>a.entry_ts-b.entry_ts),mid=ordered[Math.floor(ordered.length/2)]?.entry_ts||0;const scored=compareClusterGroups(hi,lo,hash(String(h.id||h.feature||'signal')),500);const calc=xs=>{const hh=hi.filter(r=>xs.has(r.mint)),ll=lo.filter(r=>xs.has(r.mint));return robustSplitDelta(hh,ll,`${h.id}:split`)};const oldSet=new Set(ordered.filter(r=>r.entry_ts<=mid).map(r=>r.mint)),recentSet=new Set(ordered.filter(r=>r.entry_ts>mid).map(r=>r.mint));const oldDelta=calc(oldSet),recentDelta=calc(recentSet),lower=scored.ci.lo!=null?scored.ci.lo:Number(h.ci_low);const clusters=new Set([...hi,...lo].map(r=>r.cluster||r.mint)).size;let decay='UNKNOWN';if(oldDelta!=null&&recentDelta!=null){decay=recentDelta<=0&&oldDelta>0?'DECAYING':recentDelta>0&&oldDelta>0&&recentDelta>=oldDelta*.5?'STABLE':recentDelta>oldDelta?'IMPROVING':'WEAKENING'}const recencyFactor=decay==='STABLE'||decay==='IMPROVING'?1:decay==='DECAYING'?.25:.65;const quality=(scored.contaminated||scored.hi.median<=0)?0:Math.max(0,Number(lower||0))*Math.log2(clusters+1)*recencyFactor;return{id:h.id,title:h.title,feature:h.feature,regime:h.regime,samples:applicable.length,clusters,deltaPct:scored.delta,rawDeltaPct:scored.rawDelta,medianDeltaPct:scored.medianDelta,lowerCiPct:lower,oldDeltaPct:oldDelta,recentDeltaPct:recentDelta,topMedianPct:scored.hi.median,topPositivePct:scored.hi.positiveRate*100,outlierClusters:scored.hi.outlierN,contaminated:scored.contaminated,decay,qualityScore:quality,status:h.status}}

export function summarizeDelayedEntry(rows){
  const result=[];
  for(const sec of [0,10,30,60]){
    const xs=rows.filter(r=>Number.isFinite(Number(r[sec])));
    const level=summarizeClusterReturns(xs.map(r=>({mint:r.mint,cluster:r.cluster,value:Number(r[sec])})));
    const diffs=sec===0?[]:xs.filter(r=>Number.isFinite(Number(r[0]))).map(r=>({mint:r.mint,cluster:r.cluster,value:Number(r[sec])-Number(r[0])}));
    const imp=sec===0?null:summarizeClusterReturns(diffs);
    const ci=sec===0?{low:null,high:null}:bootstrapRobustMean(diffs,`delay:${sec}`);
    result.push({
      delaySec:sec,samples:xs.length,clusters:new Set(xs.map(r=>r.cluster||r.mint)).size,
      avgAdjustedPct:level.robustMean,medianAdjustedPct:level.median,positivePct:level.positiveRate*100,
      rawAvgAdjustedPct:level.mean,outlierClusters:level.outlierN,contaminated:level.contaminated,
      improvementVsNowPct:sec===0?0:imp.robustMean,improvementRawPct:sec===0?0:imp.mean,
      improvementMedianPct:sec===0?0:imp.median,improvementCiLow:ci.low,improvementCiHigh:ci.high
    });
  }
  const measured=result.filter(x=>x.samples>=30);
  const eligible=measured.filter(x=>!x.contaminated);
  const best=eligible.length?[...eligible].sort((a,b)=>b.avgAdjustedPct-a.avgAdjustedPct)[0]:null;
  return{rows:result,bestDelaySec:best?.delaySec??null,status:measured.length>=2?'MEASURED':'COLLECTING'};
}
function delayedEntryStudy(d){const outcomes=d.prepare(`SELECT o.*,COALESCE((SELECT cluster_id FROM token_observations t WHERE t.mint=o.mint ORDER BY ts ASC LIMIT 1),o.cluster_id,o.mint) cluster FROM outcomes o JOIN (SELECT mint,MIN(entry_ts) ets FROM outcomes WHERE horizon_min=30 GROUP BY mint) x ON x.mint=o.mint AND x.ets=o.entry_ts WHERE o.horizon_min=30 ORDER BY o.entry_ts DESC LIMIT 2500`).all().filter(o=>!isImpossibleOutcome(o));const nearest=d.prepare(`SELECT ts,price,liquidity,execution FROM token_observations WHERE mint=? AND ts BETWEEN ? AND ? ORDER BY ABS(ts-?) ASC LIMIT 1`);const rows=[];for(const o of outcomes){const base=nearest.get(o.mint,o.entry_ts-5000,o.entry_ts+15000,o.entry_ts);if(!base||!(Number(base.price)>0)||!Number.isFinite(Number(o.raw_return)))continue;const endpoint=Number(base.price)*(1+Number(o.raw_return)/100);const per={mint:o.mint,cluster:o.cluster,regime:o.regime};for(const sec of [0,10,30,60]){const target=Number(o.entry_ts)+sec*1000,x=nearest.get(o.mint,target-4000,target+15000,target);if(!x||!(Number(x.price)>0))continue;const raw=(endpoint/Number(x.price)-1)*100;const friction=estimateRoundTripFrictionPct({liquidity:Number(x.liquidity||o.liquidity),executionScore:Number(x.execution||o.execution),rawReturnPct:raw});per[sec]=raw-friction}rows.push(per)}return summarizeDelayedEntry(rows)}

function calibrationSnapshot(d){let r;try{r=d.prepare(`SELECT COUNT(*) n,AVG(observed_slippage_bps-predicted_slippage_bps) bias,AVG(ABS(observed_slippage_bps-predicted_slippage_bps)) mae,AVG(CASE WHEN observed_failed=1 THEN 1.0 ELSE 0 END)*100 failObserved,AVG(predicted_failure_pct) failPred FROM execution_calibration WHERE ts>?`).get(Date.now()-30*24*3600_000)}catch{return{status:'UNCALIBRATED',samples:0}}const n=Number(r?.n||0),bias=Number(r?.bias||0),mae=Number(r?.mae||0);return{status:n<20?'UNCALIBRATED':Math.abs(bias)<=50?'CALIBRATED':bias>50?'PAPER TOO OPTIMISTIC':'PAPER TOO PESSIMISTIC',samples:n,slippageBiasBps:bias,slippageMaeBps:mae,observedFailurePct:Number(r?.failObserved||0),predictedFailurePct:Number(r?.failPred||0)}}

export function computeAlphaInsights(){const d=alphaDb(),hyp=d.prepare(`SELECT * FROM hypothesis_results WHERE status='POSITIVE EVIDENCE' AND updated_ts>? ORDER BY ci_low DESC`).all(Date.now()-HYPOTHESIS_MAX_AGE_MS),rows=baseRows(d);const leaderboard=hyp.map(h=>evaluateSignal(rows,h)).filter(Boolean).sort((a,b)=>b.qualityScore-a.qualityScore);return{version:1,updatedAt:Date.now(),leaderboard:leaderboard.slice(0,20),delayedEntry:delayedEntryStudy(d),calibration:calibrationSnapshot(d)}}
export function writeAlphaInsights(){const x=computeAlphaInsights();fs.mkdirSync(path.dirname(OUT),{recursive:true});const tmp=OUT+'.tmp';fs.writeFileSync(tmp,JSON.stringify(x,null,2));fs.renameSync(tmp,OUT);return x}
export function alphaInsightsSnapshot(){try{if(fs.existsSync(OUT)){const st=fs.statSync(OUT);if(Date.now()-st.mtimeMs<10*60_000)return JSON.parse(fs.readFileSync(OUT,'utf8'))}return computeAlphaInsights()}catch(e){return{version:1,updatedAt:Date.now(),leaderboard:[],delayedEntry:{status:'UNAVAILABLE',rows:[]},calibration:{status:'UNAVAILABLE',samples:0},error:e.message}}}
