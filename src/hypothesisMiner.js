import { compareClusterGroups, hypothesisStatus, clampAdjustedReturn, isImpossibleOutcome } from './edgeProof.js';

export const HYPOTHESIS_MAX_AGE_MS=6*3600_000;
export const FEATURES=['edge','explosion','execution','liquidity','momentum5','velocity','flow_accel','crowding','holder_quality'];
export const REGIMES=['ALL','HOT','MANIA','CHAOS','NORMAL','COLD'];
export const SENTINEL_LIQUIDITY_USD=1;
export const MIN_RESEARCH_LIQUIDITY_USD=1500;
export const OUTCOME_FEATURE_SQL=`o.*, x.edge AS obs_edge, x.explosion, x.execution AS obs_execution, x.liquidity AS obs_liquidity, x.momentum5, x.velocity, x.flow_accel, x.crowding, x.holder_quality, x.cluster_id AS obs_cluster_id`;

function hash(s=''){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
function pctile(a,p){if(!a.length)return 0;const x=[...a].sort((a,b)=>a-b);return x[Math.floor((x.length-1)*p)]}
export function observationClusterOf(r){
  for(const v of [r?.obs_cluster_id,r?.cluster_id,r?.cluster,r?.mint]){
    if(v!=null&&v!=='')return String(v);
  }
  return '';
}
function clusterCount(rows){return new Set(rows.map(observationClusterOf)).size}
function payloadExtras(scored){return{rawDelta:scored.rawDelta,medianDelta:scored.medianDelta,topMedian:scored.hi.median,topPositivePct:scored.hi.positiveRate*100,topOutliers:scored.hi.outlierN,contaminated:scored.contaminated,label:'execution-adjusted'}}

export function featureValueOf(r,f){
  if(!f||String(f).includes('+'))return NaN;
  const key=String(f);
  const read=k=>{const v=r?.[k];if(v==null||v==='')return NaN;const n=Number(v);return Number.isFinite(n)?n:NaN};
  if(key==='liquidity'){
    const v=read('liquidity');
    const x=Number.isFinite(v)?v:read('obs_liquidity');
    if(!Number.isFinite(x)||x<=SENTINEL_LIQUIDITY_USD)return NaN;
    return x;
  }
  const v=read(key);return Number.isFinite(v)?v:read(`obs_${key}`);
}

export function economicLiquidityOf(r,{min=MIN_RESEARCH_LIQUIDITY_USD}={}){
  const v=featureValueOf(r,'liquidity');
  return Number.isFinite(v)&&v>=min?v:NaN;
}

function scoredRows(xs){
  return xs.map(r=>{
    const cluster=observationClusterOf(r);
    return {...r,adjusted_return:clampAdjustedReturn(r.adjusted_return),cluster,cluster_id:cluster};
  });
}
function scoreSplit(hi,lo,seed){return compareClusterGroups(scoredRows(hi),scoredRows(lo),hash(seed),300)}

export function prepareOutcomeRows(rows){
  const src=Array.isArray(rows)?rows:[];
  const quarantined=src.filter(isImpossibleOutcome).length;
  const kept=src.filter(r=>!isImpossibleOutcome(r)).map(r=>{
    const cluster=observationClusterOf(r);
    return {...r,adjusted_return:clampAdjustedReturn(r.adjusted_return),cluster,cluster_id:cluster};
  });
  return {rows:kept,quarantined,total:src.length};
}

function writeRow(insert,id,title,feature,regime,samples,clusters,scored,status,payload){
  insert.run(id,Date.now(),title,feature,regime,samples,clusters,scored?.delta??0,scored?.ci?.lo??null,scored?.ci?.high??null,scored?.ci?.p??null,status,JSON.stringify(payload||{}));
}

export function mineHypotheses(d){
  if(!d)throw new Error('mineHypotheses requires a database');
  const insert=d.prepare(`INSERT OR REPLACE INTO hypothesis_results(id,updated_ts,title,feature,regime,samples,clusters,delta,ci_low,ci_high,p_positive,status,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let quarantined=0,refreshed=0;
  for(const regime of REGIMES){
    const where=regime==='ALL'?`o.horizon_min=30`:`o.horizon_min=30 AND o.regime=?`;
    const raw=d.prepare(`SELECT ${OUTCOME_FEATURE_SQL} FROM outcomes o JOIN (SELECT mint,MIN(entry_ts) ets FROM outcomes WHERE horizon_min=30 GROUP BY mint) eo ON eo.mint=o.mint AND eo.ets=o.entry_ts JOIN (SELECT t.* FROM token_observations t JOIN (SELECT mint,MIN(ts) mts FROM token_observations GROUP BY mint) f ON f.mint=t.mint AND f.mts=t.ts) x ON x.mint=o.mint WHERE ${where}`).all(...(regime==='ALL'?[]:[regime]));
    const prepared=prepareOutcomeRows(raw);quarantined+=prepared.quarantined;
    const holdout=prepared.rows.filter(r=>hash(observationClusterOf(r))%5===0);
    for(const f of FEATURES){
      const id=`${regime}:${f}`,title=`${f} top quartile vs rest`;
      const usable=holdout.filter(r=>Number.isFinite(featureValueOf(r,f)));
      if(usable.length<20){
        writeRow(insert,id,title,f,regime,usable.length,clusterCount(usable),null,'INSUFFICIENT',{reason:'insufficient-samples',horizonMin:30});
        refreshed++;continue;
      }
      const cut=pctile(usable.map(r=>featureValueOf(r,f)),.75);
      const hi=usable.filter(r=>featureValueOf(r,f)>=cut),lo=usable.filter(r=>featureValueOf(r,f)<cut);
      if(hi.length<5||lo.length<10){
        writeRow(insert,id,title,f,regime,usable.length,clusterCount(usable),null,'DEGENERATE',{cut,highN:hi.length,lowN:lo.length,reason:'split-too-small',horizonMin:30});
        refreshed++;continue;
      }
      const scored=scoreSplit(hi,lo,`${regime}:${f}`);
      writeRow(insert,id,title,f,regime,usable.length,clusterCount(usable),scored,hypothesisStatus(scored),{cut,highN:hi.length,lowN:lo.length,horizonMin:30,...payloadExtras(scored)});
      refreshed++;
    }
  }
  const rawPairs=d.prepare(`SELECT ${OUTCOME_FEATURE_SQL} FROM outcomes o JOIN (SELECT mint,MIN(entry_ts) ets FROM outcomes WHERE horizon_min=30 GROUP BY mint) eo ON eo.mint=o.mint AND eo.ets=o.entry_ts JOIN (SELECT t.* FROM token_observations t JOIN (SELECT mint,MIN(ts) mts FROM token_observations GROUP BY mint) f ON f.mint=t.mint AND f.mts=t.ts) x ON x.mint=o.mint WHERE o.horizon_min=30`).all();
  const preparedPairs=prepareOutcomeRows(rawPairs);quarantined+=preparedPairs.quarantined;
  const rows=preparedPairs.rows.filter(r=>hash(observationClusterOf(r))%5===0);
  for(const [a,b] of [['edge','execution'],['velocity','execution']]){
    const id=`PAIR:${a}+${b}`,title=`${a} + ${b}`;
    const u=rows.filter(r=>Number.isFinite(featureValueOf(r,a))&&Number.isFinite(featureValueOf(r,b)));
    if(u.length<30){
      writeRow(insert,id,title,`${a}+${b}`,'ALL',u.length,clusterCount(u),null,'INSUFFICIENT',{reason:'insufficient-samples'});
      refreshed++;continue;
    }
    const ca=pctile(u.map(r=>featureValueOf(r,a)),.65),cb=pctile(u.map(r=>featureValueOf(r,b)),.65);
    const hi=u.filter(r=>featureValueOf(r,a)>=ca&&featureValueOf(r,b)>=cb),lo=u.filter(r=>!(featureValueOf(r,a)>=ca&&featureValueOf(r,b)>=cb));
    if(hi.length<5||lo.length<10){
      writeRow(insert,id,title,`${a}+${b}`,'ALL',u.length,clusterCount(u),null,'DEGENERATE',{cutA:ca,cutB:cb,highN:hi.length,lowN:lo.length,reason:'split-too-small'});
      refreshed++;continue;
    }
    const scored=scoreSplit(hi,lo,`PAIR:${a}+${b}`);
    writeRow(insert,id,title,`${a}+${b}`,'ALL',u.length,clusterCount(u),scored,hypothesisStatus(scored),{cutA:ca,cutB:cb,highN:hi.length,...payloadExtras(scored)});
    refreshed++;
  }
  return {quarantined,refreshed};
}

export function recentPositiveHypotheses(d,now=Date.now()){
  return d.prepare(`SELECT * FROM hypothesis_results WHERE status='POSITIVE EVIDENCE' AND updated_ts>? ORDER BY ci_low DESC,clusters DESC`).all(now-HYPOTHESIS_MAX_AGE_MS);
}
