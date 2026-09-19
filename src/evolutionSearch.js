import crypto from 'node:crypto';
import { FEATURES, metrics } from './evolutionScoring.js';

const PRIMES=[2,3,5,7,11,13,17,19,23,29,31,37,41];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const BOUNDS=Object.freeze({threshold:[30,92],stopPct:[1.5,24],takePct:[3,100],maxHoldMin:[2,240]});

export function halton(index, base){
  let i=Math.max(1,Math.floor(Number(index)||1)), f=1, r=0;
  while(i>0){f/=base;r+=f*(i%base);i=Math.floor(i/base)}
  return r;
}

function normalizeWeights(raw){
  let total=0; const out={};
  for(const k of FEATURES){out[k]=Math.max(.005,Number(raw[k])||.005);total+=out[k]}
  for(const k of FEATURES)out[k]/=total||1;
  return out;
}

export function globalVariant({generation=1,index=0,parentId='BASE'}={}){
  // generation offsets the deterministic low-discrepancy stream without depending on prior scores.
  const n=Math.max(1,(Math.max(1,generation)-1)*100003+index+1);
  const u=PRIMES.map(b=>halton(n,b));
  const raw={};
  // Wide log-ish weight range before normalization so distant simplex regions are visited.
  for(let k=0;k<FEATURES.length;k++)raw[FEATURES[k]]=Math.exp(Math.log(.005)+u[k]*(Math.log(.75)-Math.log(.005)));
  return {
    id:`GLOBAL-G${generation}-${index}`,
    weights:normalizeWeights(raw),
    threshold:BOUNDS.threshold[0]+u[9]*(BOUNDS.threshold[1]-BOUNDS.threshold[0]),
    stopPct:BOUNDS.stopPct[0]+u[10]*(BOUNDS.stopPct[1]-BOUNDS.stopPct[0]),
    takePct:BOUNDS.takePct[0]+u[11]*(BOUNDS.takePct[1]-BOUNDS.takePct[0]),
    maxHoldMin:Math.round(BOUNDS.maxHoldMin[0]+u[12]*(BOUNDS.maxHoldMin[1]-BOUNDS.maxHoldMin[0])),
    parentId,testLane:'GLOBAL_HALTON',searchOrigin:'GLOBAL_HALTON',searchIndex:n,
  };
}

export function crossoverVariant(parent, other, {generation=1,index=0,rng=Math.random}={}){
  const b=other?.variant||other||parent, w={};
  for(const k of FEATURES){
    const mix=.25+rng()*.5;
    w[k]=Math.max(.005,Number(parent?.weights?.[k]||0)*mix+Number(b?.weights?.[k]||0)*(1-mix));
  }
  const blend=(key,lo,hi)=>clamp(Number(parent?.[key]||0)*(.4+rng()*.2)+Number(b?.[key]||parent?.[key]||0)*(.6-rng()*.2),lo,hi);
  return {id:`CROSS-G${generation}-${index}`,weights:normalizeWeights(w),threshold:blend('threshold',...BOUNDS.threshold),stopPct:blend('stopPct',...BOUNDS.stopPct),takePct:blend('takePct',...BOUNDS.takePct),maxHoldMin:Math.round(blend('maxHoldMin',...BOUNDS.maxHoldMin)),parentId:parent?.id||'BASE',testLane:'CROSSOVER',searchOrigin:'CROSSOVER'};
}

export function buildResearchVariants({parent,batchSize,generation,priorChallengers=[],lanes=[],mutate,rng=Math.random,globalShare=.30,crossoverShare=.10}={}){
  const n=Math.max(1,Math.floor(Number(batchSize)||1));
  const variants=[parent];
  const globals=Math.min(n,Math.max(1,Math.floor(n*clamp(globalShare,0,.8))));
  const crosses=priorChallengers.length?Math.min(n-globals,Math.floor(n*clamp(crossoverShare,0,.5))):0;
  for(let i=0;i<globals;i++)variants.push(globalVariant({generation,index:i,parentId:parent?.id||'BASE'}));
  for(let i=0;i<crosses;i++)variants.push(crossoverVariant(parent,priorChallengers[i%priorChallengers.length],{generation,index:i,rng}));
  for(let i=globals+crosses;i<n;i++)variants.push(mutate(parent,lanes.length?lanes[i%lanes.length]:'BASELINE_CONTROL',rng));
  return variants;
}

export function splitResearchRows(rows,{sealedFraction=.15,minRanking=75,minSealed=30}={}){
  const sorted=[...(rows||[])].sort((a,b)=>Number(a.ts)-Number(b.ts));
  if(sorted.length<minRanking+minSealed)return {rankingRows:sorted,sealedRows:[],meta:{available:false,total:sorted.length,ranking:sorted.length,sealed:0,reason:'INSUFFICIENT_ROWS'}};
  let sealed=Math.max(minSealed,Math.floor(sorted.length*clamp(sealedFraction,.05,.30)));
  sealed=Math.min(sealed,sorted.length-minRanking);
  const cut=sorted.length-sealed;
  return {rankingRows:sorted.slice(0,cut),sealedRows:sorted.slice(cut),meta:{available:true,total:sorted.length,ranking:cut,sealed,cutTs:Number(sorted[cut]?.ts||0),selectionUse:false}};
}

const q=(x,steps=16)=>Math.max(0,Math.min(steps-1,Math.floor(Number(x)*steps)));
export function variantVector(v){return [...FEATURES.map(k=>Number(v?.weights?.[k]||0)),Number(v?.threshold||0),Number(v?.stopPct||0),Number(v?.takePct||0),Number(v?.maxHoldMin||0)]}
function unitVector(v){
  const x=variantVector(v); return [...x.slice(0,9).map(z=>clamp(z/.75,0,1)),clamp((x[9]-30)/62,0,1),clamp((x[10]-1.5)/22.5,0,1),clamp((x[11]-3)/97,0,1),clamp((x[12]-2)/238,0,1)];
}
export function searchCoverage(variants,{steps=16,priorTrials=0}={}){
  const seen=new Set(), exact=new Set(); let duplicates=0;
  for(const v of variants||[]){
    const u=unitVector(v); seen.add(u.map(x=>q(x,steps)).join(':'));
    const key=variantVector(v).map(x=>Number(x).toFixed(6)).join('|'); if(exact.has(key))duplicates++; exact.add(key);
  }
  const tested=(variants||[]).length, trials=Math.max(1,Number(priorTrials||0)+tested);
  return {dimensions:13,cells:seen.size,uniqueExact:exact.size,duplicates,duplicateRate:tested?duplicates/tested:0,trials,selectionPressure:{familyWiseAlpha:.05,bonferroniAlpha:.05/trials,log10Trials:Math.log10(trials)}};
}

export function sealedAudit(v, rows){
  if(!v||!rows?.length)return null;
  const base=metrics(v,rows,.2), stress=metrics(v,rows,.85);
  const digest=crypto.createHash('sha256').update(JSON.stringify(rows.map(r=>[Number(r.ts),Number(r.returnPct),r.features||{}]))).digest('hex');
  return {datasetHash:digest,rows:rows.length,selected:base.n,activityPct:base.activityPct,avgPct:base.avg,geometricMeanPct:base.geometricMeanPct,maxDrawdownPct:base.maxDrawdownPct,stressAvgPct:stress.avg,worstPct:base.worstPct,selectionUse:false};
}

export function effectiveBatchSize(profile={},normal=512){
  const requested=profile.enabled?Number(profile.batchSize||4096):Number(normal||512);
  if(!profile.enabled)return Math.max(128,requested);
  const verified=Math.max(128,Number(profile.throughputVerifiedBatchSize||4096));
  return Math.max(128,Math.min(requested,verified,50000));
}
