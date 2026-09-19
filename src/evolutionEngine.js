import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { loadState, appendJournal, enqueueAction } from './store.js';
import { ensureResearch } from './research.js';
import { ensureLearner } from './learner.js';
import { clusterEnabled, distributedScore, getClusterStatus } from './clusterClient.js';
import { resourceSnapshot, TEST_LANES } from './resourcePolicy.js';
import { EvolutionPool } from './evolutionPool.js';
import {
  FEATURES, BASE, MC_ROUNDS_MAIN, MC_ROUNDS_WORKER,
  scoreVariant, scoreVariantPacked, packDataset,
} from './evolutionScoring.js';
import { buildResearchVariants, splitResearchRows, searchCoverage, sealedAudit, effectiveBatchSize } from './evolutionSearch.js';
import { recordEvolutionEvidence } from './evolutionEvidence.js';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const rnd=(lo,hi,rng=Math.random)=>lo+rng()*(hi-lo);
const id=()=>`MPO-G${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
const FURNACE_FILE=path.join(DATA_DIR,'research-furnace.json');
export const BEAST_FILE=path.join(DATA_DIR,'research-beast.json');
export const LOOP_FILE=path.join(DATA_DIR,'evolution-loop.json');
export const PROGRESS_PUBLISH_MS=750;

export const PROMOTION_GATES=Object.freeze({
  robustScoreMargin:1.0,
  minHeldOutAvgPct:0,
  minHeldOutN:12,
  minSamples:40,
  minActivityPct:8,
  minStressAvgPct:-2,
  minMonteCarloPassPct:70,
  minConsistencyPct:50,
});

export function envFlag(name){
  if(process.env[name]==null)return null;
  return ['1','true','yes','on'].includes(String(process.env[name]).toLowerCase());
}

export function scorerMode(){return process.env.EVOLUTION_SCORER==='legacy'?'legacy':'fast'}

export function furnaceProfile(){
  const hw=Math.max(1,os.cpus().length-4);
  let p={enabled:false,batchSize:4096,intervalMs:3000,workers:Math.min(24,hw),globalShare:.30,crossoverShare:.10,sealedFraction:.15,sealedAuditEvery:25,throughputVerifiedBatchSize:4096};
  try{p={...p,...JSON.parse(fs.readFileSync(FURNACE_FILE,'utf8'))}}catch{}
  const furnaceEnv=envFlag('MPO_RESEARCH_FURNACE'), beastEnv=envFlag('MPO_RESEARCH_BEAST');
  if(furnaceEnv!=null)p.enabled=furnaceEnv;
  if(beastEnv)p.enabled=true;
  if(process.env.EVOLUTION_VARIANTS)p.batchSize=Number(process.env.EVOLUTION_VARIANTS);
  if(process.env.EVOLUTION_INTERVAL_MS)p.intervalMs=Number(process.env.EVOLUTION_INTERVAL_MS);
  if(process.env.EVOLUTION_WORKERS)p.workers=Number(process.env.EVOLUTION_WORKERS);
  p.batchSize=Math.max(128,Math.min(50000,Number(p.batchSize)||4096));
  p.intervalMs=Math.max(1000,Math.min(120000,Number(p.intervalMs)||3000));
  p.workers=Math.max(1,Math.min(hw,Number(p.workers)||Math.min(24,hw)));
  p.globalShare=Math.max(0,Math.min(.8,Number(p.globalShare)||.30));
  p.crossoverShare=Math.max(0,Math.min(.5,Number(p.crossoverShare)||.10));
  p.sealedFraction=Math.max(.05,Math.min(.30,Number(p.sealedFraction)||.15));
  p.sealedAuditEvery=Math.max(5,Math.min(250,Math.floor(Number(p.sealedAuditEvery)||25)));
  p.throughputVerifiedBatchSize=Math.max(128,Math.min(50000,Math.floor(Number(p.throughputVerifiedBatchSize)||4096)));
  return p;
}

export function beastProfile(furnace=furnaceProfile()){
  const res=resourceSnapshot();
  const hw=Math.max(1,os.cpus().length-1);
  let p={
    enabled:false,gpu:false,gpuDevice:'auto',gpuDtype:'float64',gpuVramMb:2048,gpuFinalists:12,gpuCpuShare:.30,
    gpuTimeoutMs:120000,gpuParitySample:8,restMs:50,ramTargetGB:res.memoryGB,cpuPercent:res.cpuPercent,
    workers:furnace.workers,batchSize:furnace.batchSize,cpuFallback:true,
  };
  try{p={...p,...JSON.parse(fs.readFileSync(BEAST_FILE,'utf8'))}}catch{}
  const be=envFlag('MPO_RESEARCH_BEAST'); if(be!=null)p.enabled=be;
  const ge=envFlag('MPO_RESEARCH_GPU'); if(ge!=null)p.gpu=ge;
  if(process.env.MPO_BEAST_VRAM_MB)p.gpuVramMb=Number(process.env.MPO_BEAST_VRAM_MB);
  if(process.env.MPO_BEAST_RAM_GB)p.ramTargetGB=Number(process.env.MPO_BEAST_RAM_GB);
  if(process.env.MPO_BEAST_REST_MS)p.restMs=Number(process.env.MPO_BEAST_REST_MS);
  if(process.env.MPO_BEAST_GPU_CPU_SHARE)p.gpuCpuShare=Number(process.env.MPO_BEAST_GPU_CPU_SHARE);
  p.enabled=!!p.enabled;
  p.gpu=!!p.gpu && p.enabled;
  p.cpuFallback=true;
  p.ramTargetGB=clamp(p.ramTargetGB,.25,os.totalmem()/1073741824*.8);
  p.cpuPercent=clamp(p.cpuPercent,10,95);
  p.gpuVramMb=Math.max(256,Math.min(16384,Math.floor(Number(p.gpuVramMb)||2048)));
  p.gpuFinalists=Math.max(4,Math.min(64,Math.floor(Number(p.gpuFinalists)||12)));
  p.gpuTimeoutMs=Math.max(5000,Math.min(300000,Math.floor(Number(p.gpuTimeoutMs)||120000)));
  p.gpuParitySample=Math.max(2,Math.min(64,Math.floor(Number(p.gpuParitySample)||8)));
  p.gpuCpuShare=Math.max(0,Math.min(.75,Number(p.gpuCpuShare)||0));
  p.restMs=Math.max(10,Math.min(5000,Math.floor(Number(p.restMs)||50)));
  const ramSlots=Math.max(1,Math.floor(p.ramTargetGB/.4));
  const cpuSlots=Math.max(1,Math.floor(hw*p.cpuPercent/100));
  // 6-thread laptops measured faster with 1 packed worker than with 4; keep a
  // small cap so BEAST cannot oversubscribe by default. Bigger hosts still
  // scale up to the RAM/CPU slots (max 32 on larger workhorses).
  const hostCap=hw<=6?1:Math.min(hw,32);
  p.workers=Math.max(1,Math.min(Number(p.workers)||furnace.workers,ramSlots,cpuSlots,hw,hostCap));
  p.batchSize=effectiveBatchSize({enabled:true,batchSize:p.batchSize||furnace.batchSize,throughputVerifiedBatchSize:furnace.throughputVerifiedBatchSize},furnace.batchSize);
  return p;
}

function normalize(w){let t=0;const o={};for(const k of FEATURES){o[k]=Math.max(.005,Number(w[k]||0));t+=o[k]}for(const k of FEATURES)o[k]/=t||1;return o}

export function mutate(parent={},lane='BASELINE_CONTROL',rng=Math.random){
  const pw=parent.weights||BASE,w={};
  const amp=lane==='BASELINE_CONTROL'?.16:lane==='RISK_STRESS'?.24:.34;
  for(const k of FEATURES){let mult=1+rnd(-amp,amp,rng);if(lane==='EARLY_MOMENTUM'&&['momentum','explosion','flow','priceAccel'].includes(k))mult*=rnd(1.05,1.28,rng);if(lane==='LIQUIDITY_FILTER'&&['liquidity','execution'].includes(k))mult*=rnd(1.08,1.32,rng);w[k]=Math.max(.005,Number(pw[k]||BASE[k])*mult)}
  let threshold=clamp(Number(parent.threshold??60)+rnd(-8,8,rng),35,88),stopPct=clamp(Number(parent.stopPct??8)+rnd(-3,3,rng),2,20),takePct=clamp(Number(parent.takePct??16)+rnd(-6,10,rng),4,80),maxHoldMin=Math.round(clamp(Number(parent.maxHoldMin??30)+rnd(-12,20,rng),3,180));
  if(lane==='LAUNCH_SNIPE'){threshold=clamp(threshold-rnd(3,10,rng),30,80);maxHoldMin=Math.round(clamp(maxHoldMin-rnd(5,18,rng),2,90))}
  if(lane==='EXIT_TIMING'){stopPct=clamp(Number(parent.stopPct??8)+rnd(-5,6,rng),1.5,24);takePct=clamp(Number(parent.takePct??16)+rnd(-10,22,rng),3,100);maxHoldMin=Math.round(clamp(Number(parent.maxHoldMin??30)+rnd(-22,45,rng),2,240))}
  if(lane==='RISK_STRESS'){threshold=clamp(threshold+rnd(2,10,rng),40,92);stopPct=clamp(stopPct-rnd(0,3,rng),1.5,14)}
  return {id:id(),weights:normalize(w),threshold,stopPct,takePct,maxHoldMin,parentId:parent.id||'BASE',testLane:lane};
}

export function localWorkerCount(profile=furnaceProfile()){
  const cap=resourceSnapshot().maxWorkerSlots,hw=Math.max(1,os.cpus().length-1);
  const beast=beastProfile(profile);
  if(beast.enabled) return Math.max(1,Math.min(beast.workers,hw));
  return profile.enabled?Math.max(1,Math.min(profile.workers,hw)):Math.max(1,Math.min(Number(process.env.EVOLUTION_WORKERS||cap),cap,hw));
}

// ---------------------------------------------------------------------------
// Persistent worker pool (no spawn/terminate per generation)
// ---------------------------------------------------------------------------
let pool=null;
export function getPool(){
  if(!pool||pool.closed) pool=new EvolutionPool({size:localWorkerCount()});
  return pool;
}
export async function closePool(){
  const p=pool; pool=null;
  if(p) await p.close();
  try{const {closeGpuSidecar}=await import('./evolutionGpu.js');await closeGpuSidecar()}catch{}
}

export async function scoreInWorkers(variants,rows,onProgress=()=>{},{pool:injected=null,dataset=null,beast:beastOpt=null,gpuSidecar=null,gpuSeed=1,gpuCpuSeed=null,parentId=null}={}){
  if(clusterEnabled()) return distributedScore(variants,rows,{batchSize:64,timeoutMs:180000});
  const beast=beastOpt||beastProfile();
  if(beast.enabled && beast.gpu){
    const {scoreBeastGpu}=await import('./evolutionGpu.js');
    const cpuPool=injected||getPool();
    const workers=beast.workers||localWorkerCount(furnaceProfile());
    cpuPool.resize(workers);
    const share=Math.max(0,Math.min(.75,Number(beast.gpuCpuShare)||0));
    if(share>0&&scorerMode()!=='legacy'&&variants.length>=512){
      const ds=dataset||packDataset(rows);
      const cpuN=Math.max(1,Math.min(variants.length-1,Math.floor(variants.length*share))),gpuN=variants.length-cpuN;
      const gpuVariants=variants.slice(0,gpuN),cpuVariants=variants.slice(gpuN);let cpuDone=0,gpuDone=0;
      const report=extra=>onProgress({completed:cpuDone+gpuDone,total:variants.length,workers,gpu:true,hybrid:true,...extra});
      const gpuPromise=scoreBeastGpu(gpuVariants,rows,{onProgress:x=>{gpuDone=Number(x.completed||0);report({device:x.device})},dataset:ds,beast,sidecar:gpuSidecar||undefined,seed:gpuSeed,cpuSeed:gpuCpuSeed,parentId});
      const cpuPromise=cpuPool.score(cpuVariants,ds,{rounds:workers<=1?MC_ROUNDS_MAIN:MC_ROUNDS_WORKER,onProgress:x=>{cpuDone=Number(x.completed||0);report()}});
      const [gpu,cpuScored]=await Promise.all([gpuPromise,cpuPromise]);
      if(gpu.ok){gpuDone=gpuVariants.length;cpuDone=cpuVariants.length;report({device:gpu.device});return [...gpu.scored,...cpuScored]}
      report({gpuFallback:gpu.reason||'cpu'});
      const gpuCpu=await cpuPool.score(gpuVariants,ds,{rounds:workers<=1?MC_ROUNDS_MAIN:MC_ROUNDS_WORKER,onProgress:x=>{gpuDone=Number(x.completed||0);report({gpuFallback:gpu.reason||'cpu'})}});
      return [...gpuCpu,...cpuScored];
    }
    const gpu=await scoreBeastGpu(variants,rows,{onProgress,dataset,beast,sidecar:gpuSidecar||undefined,seed:gpuSeed,cpuSeed:gpuCpuSeed,parentId,
      cpuRescore:async(finalists,ds,opts)=>cpuPool.score(finalists,ds,{rounds:opts.rounds,seed:opts.seed})});
    if(gpu.ok) return gpu.scored;
    onProgress({completed:0,total:variants.length,workers,gpuFallback:gpu.reason||'cpu'});
  }
  if(scorerMode()==='legacy') return scoreInWorkersLegacy(variants,rows,onProgress);
  const ds=dataset||packDataset(rows);
  const workers=localWorkerCount();
  const p=injected||getPool();
  p.resize(workers);
  // Pool size 1 keeps the old in-process bootstrap depth; multi-worker keeps the old worker depth.
  return p.score(variants,ds,{rounds:workers<=1?MC_ROUNDS_MAIN:MC_ROUNDS_WORKER,onProgress});
}

// Verbatim pre-fast-path implementation, kept for EVOLUTION_SCORER=legacy and the benchmark.
export function scoreInWorkersLegacy(variants,rows,onProgress=()=>{}){
  const WORKERS=localWorkerCount();
  if(clusterEnabled()) return distributedScore(variants,rows,{batchSize:64,timeoutMs:180000});
  if(WORKERS<=1){const out=variants.map(variant=>({variant,metrics:scoreVariant(variant,rows)}));onProgress({completed:variants.length,total:variants.length,workers:1});return Promise.resolve(out)}
  const batches=Array.from({length:WORKERS},()=>[]);
  variants.forEach((v,i)=>batches[i%WORKERS].push(v));
  let completed=0;
  return Promise.all(batches.filter(x=>x.length).map(batch=>new Promise((resolve,reject)=>{
    const w=new Worker(new URL('./evolutionWorker.js',import.meta.url));
    w.once('message',x=>{completed+=batch.length;onProgress({completed,total:variants.length,workers:WORKERS});resolve(x);w.terminate()}); w.once('error',reject);
    w.postMessage({variants:batch,rows});
  }))).then(parts=>parts.flat());
}

// ---------------------------------------------------------------------------
// Loop-state authority (generation race fix)
// ---------------------------------------------------------------------------
// index.js drains evolution-sync actions and only then saves state.json, so loadState() can
// still report a stale generation. The evolution service therefore keeps its own in-memory
// authority plus an atomic local file and always advances from the newest of the three.
let memoryLoop=null;
let loopWriteErrors=0;

export function resetLoopMemory(){memoryLoop=null;loopWriteErrors=0}
export function loopWriteFailures(){return loopWriteErrors}

export function loadLocalLoop(){
  try{
    const v=JSON.parse(fs.readFileSync(LOOP_FILE,'utf8'));
    return v&&typeof v==='object'&&!Array.isArray(v)?v:null;
  }catch{return null}
}

export function saveLocalLoop(loop){
  if(!loop||typeof loop!=='object')return false;
  const tmp=`${LOOP_FILE}.${process.pid}.tmp`;
  try{
    fs.mkdirSync(DATA_DIR,{recursive:true});
    fs.writeFileSync(tmp,JSON.stringify(loop));
    fs.renameSync(tmp,LOOP_FILE);
    return true;
  }catch{
    loopWriteErrors++;
    try{fs.rmSync(tmp,{force:true})}catch{}
    return false;
  }
}

const generationOf=x=>{const n=Number(x?.generation);return Number.isFinite(n)?n:0};
const updatedAtOf=x=>{const n=Number(x?.updatedAt);return Number.isFinite(n)?n:0};

export function resolveLoopState({disk=null,local=null,memory=null}={}){
  const candidates=[memory,local,disk].filter(x=>x&&typeof x==='object'&&!Array.isArray(x));
  if(!candidates.length)return null;
  let best=candidates[0];
  for(const c of candidates.slice(1)){
    const g=generationOf(c),bg=generationOf(best);
    if(g>bg||(g===bg&&updatedAtOf(c)>updatedAtOf(best)))best=c;
  }
  try{return structuredClone(best)}
  catch{try{return JSON.parse(JSON.stringify(best))}catch{return best}}
}

// ---------------------------------------------------------------------------
// Generation engine
// ---------------------------------------------------------------------------
export function championTrusted(c){
  const m=c?.metrics||{}, g=PROMOTION_GATES;
  return !!c?.variant && Number(m.heldOutN||0)>=g.minHeldOutN && Number(m.samples||0)>=g.minSamples && Number(m.activityPct||0)>=g.minActivityPct && Number(m.monteCarloPassPct||0)>=g.minMonteCarloPassPct;
}
export function promotionImproves(winner,incumbent,parentId){
  const w=winner?.metrics, i=incumbent?.metrics, g=PROMOTION_GATES;
  return !!(winner && incumbent && w && i && winner.variant?.id!==parentId &&
    w.robustScore > i.robustScore+g.robustScoreMargin &&
    w.heldOutAvgPct>g.minHeldOutAvgPct && w.heldOutN>=g.minHeldOutN && w.samples>=g.minSamples &&
    w.activityPct>=g.minActivityPct && w.stressAvgPct>g.minStressAvgPct &&
    w.monteCarloPassPct>=g.minMonteCarloPassPct && w.consistencyPct>=g.minConsistencyPct);
}
export function baseChampion(s){
  const c=s.evolutionLoop?.champion;
  return championTrusted(c) ? c.variant : {id:'BASE',weights:BASE,threshold:60,stopPct:8,takePct:16,maxHoldMin:30};
}
export function snapshot(s, patch={}) {
  const prev=s.evolutionLoop||{};
  s.evolutionLoop={...prev,enabled:true,status:'RUNNING',generation:Number(prev.generation||0),variantsTested:Number(prev.variantsTested||0),
    champion:prev.champion||null,challengers:prev.challengers||[],history:prev.history||[],events:prev.events||[],updatedAt:Date.now(),...patch};
  s.evolution={...(s.evolution||{}), loop:s.evolutionLoop};
  memoryLoop=s.evolutionLoop;
}
export function event(s,message,type='INFO'){
  s.evolutionLoop.events.unshift({ts:Date.now(),type,message});
  s.evolutionLoop.events=s.evolutionLoop.events.slice(0,160);
  appendJournal({type:'evolution',level:type,message});
}
export function publishEvolution(s){
  enqueueAction({type:'evolution-sync',evolutionLoop:s.evolutionLoop,evolution:s.evolution});
  saveLocalLoop(s.evolutionLoop);
}

// Reads state and re-bases it on the newest known loop state (memory > local file > disk).
function loadResolvedState(){
  const s=loadState(); ensureResearch(s); ensureLearner(s);
  const resolved=resolveLoopState({disk:s.evolutionLoop,local:loadLocalLoop(),memory:memoryLoop});
  if(resolved)s.evolutionLoop=resolved;
  return s;
}

export function publishError(message){
  const s=loadResolvedState();
  snapshot(s,{status:'ERROR',lastError:String(message)});
  event(s,String(message),'ERROR');
  publishEvolution(s);
}

export async function runGeneration(){
  const startedAt=Date.now();
  const s=loadState(); ensureResearch(s); const l=ensureLearner(s);
  const resolved=resolveLoopState({disk:s.evolutionLoop,local:loadLocalLoop(),memory:memoryLoop});
  if(resolved)s.evolutionLoop=resolved;
  const allRows=(l.outcomes||[]).filter(o=>o.horizonMin===5 && Number.isFinite(Number(o.returnPct)) && o.features)
    .sort((a,b)=>Number(a.ts)-Number(b.ts));
  snapshot(s);
  if(allRows.length<60){
    snapshot(s,{status:'COLLECTING',datasetSamples:allRows.length});
    event(s,`Waiting for robust labeled dataset: ${allRows.length}/60 5m outcomes.`);
    publishEvolution(s); return;
  }

  const profile=furnaceProfile();
  const beast=beastProfile(profile);
  if(beast.enabled) profile.enabled=true;
  const split=splitResearchRows(allRows,{sealedFraction:profile.sealedFraction});
  const rows=split.rankingRows, sealedRows=split.sealedRows;
  if(rows.length<60){
    snapshot(s,{status:'COLLECTING',datasetSamples:rows.length,sealedSamples:sealedRows.length,sealedSplit:split.meta});
    event(s,`Waiting for ranking dataset after sealed split: ${rows.length}/60 5m outcomes.`);
    publishEvolution(s); return;
  }
  const parent=baseChampion(s), generation=s.evolutionLoop.generation+1;
  const researchMode=beast.enabled?'BEAST':profile.enabled?'FURNACE':'NORMAL';
  event(s,`Generation ${generation}: mixed local/global batch started${researchMode==='NORMAL'?'':` [${researchMode}]`}.`);
  const requested=beast.enabled?beast.batchSize:profile.enabled?profile.batchSize:Math.max(128,Number(process.env.EVOLUTION_VARIANTS||512));
  const batchSize=beast.enabled?beast.batchSize:effectiveBatchSize(profile,requested);
  const variants=buildResearchVariants({parent,batchSize,generation,priorChallengers:s.evolutionLoop?.challengers||[],lanes:TEST_LANES,mutate,globalShare:profile.globalShare,crossoverShare:profile.crossoverShare});
  const coverage=searchCoverage(variants,{priorTrials:s.evolutionLoop?.variantsTested||0});
  // The final chronological sealed window is never packed or passed to candidate ranking.
  const fast=scorerMode()!=='legacy'&&!clusterEnabled();
  const ds=fast?packDataset(rows):null;
  snapshot(s,{activeGeneration:generation,currentBatchSize:variants.length,currentBatchCompleted:0,currentBatchStatus:'SCORING',nextGenerationProgress:0,workerCount:localWorkerCount(profile),datasetSamples:rows.length,sealedSamples:sealedRows.length,sealedSplit:split.meta,searchCoverage:coverage,researchMode,researchProfile:{...profile,effectiveBatchSize:batchSize},beastProfile:beast});
  publishEvolution(s);
  let lastPublish=Date.now();
  const scored=await scoreInWorkers(variants,rows,progress=>{
    const pct=progress.total?Math.min(99,progress.completed/progress.total*100):0;
    snapshot(s,{activeGeneration:generation,currentBatchSize:progress.total,currentBatchCompleted:progress.completed,currentBatchStatus:'SCORING',nextGenerationProgress:pct,workerCount:progress.workers,gpuFallback:progress.gpuFallback||null});
    // Throttled: the snapshot (and in-memory authority) updates every callback, the action
    // queue only every PROGRESS_PUBLISH_MS, plus an always-published batch completion.
    const now=Date.now();
    if(now-lastPublish>=PROGRESS_PUBLISH_MS||progress.completed>=progress.total){lastPublish=now;publishEvolution(s)}
  },{dataset:ds,beast,parentId:parent.id});
  const ranked=scored.filter(x=>x.metrics).sort((a,b)=>b.metrics.robustScore-a.metrics.robustScore);
  const winner=ranked[0], incumbent=ranked.find(x=>x.variant.id===parent.id) || {variant:parent,metrics:ds?scoreVariantPacked(parent,ds,{rounds:MC_ROUNDS_MAIN}):scoreVariant(parent,rows)};
  const improves=promotionImproves(winner,incumbent,parent.id);

  const challengers=ranked.slice(0,12).map(x=>({id:x.variant.id,parentId:x.variant.parentId,stage:'RESEARCH',
    ...x.metrics,variant:x.variant}));
  const legacyChampion=s.evolutionLoop.champion;
  let champion=championTrusted(legacyChampion)?legacyChampion:null;
  if(!champion){
    champion={id:parent.id,stage:'SHADOW',variant:parent,metrics:incumbent?.metrics||null,promotedAt:Date.now(),retiredLegacyId:legacyChampion?.id||null};
    if(legacyChampion?.id) event(s,`Retired legacy champion ${legacyChampion.id}: it does not meet current sample/activity evidence gates.`,'INFO');
  }
  if(improves){
    champion={id:winner.variant.id,stage:'SHADOW',variant:winner.variant,metrics:winner.metrics,promotedAt:Date.now(),previousId:champion?.id||parent.id};
    event(s,`New shadow champion ${winner.variant.id}: held-out ${winner.metrics.heldOutAvgPct.toFixed(2)}%, stress ${winner.metrics.stressAvgPct.toFixed(2)}%, MC ${winner.metrics.monteCarloPassPct.toFixed(1)}%.`,'PROMOTE');
  } else event(s,`Champion retained after ${variants.length} variants. Best challenger did not clear promotion gates.`);

  // Sealed results are observational only: they are calculated after ranking/promotion and
  // are never fed back into winner selection. Cadence reduces repeated peeking pressure.
  const auditDue=split.meta.available && generation%profile.sealedAuditEvery===0;
  let sealedValidation=s.evolutionLoop?.sealedValidation||{status:split.meta.available?'PENDING_CADENCE':'UNAVAILABLE'};
  if(auditDue && winner && incumbent){
    const proposed=sealedAudit(winner.variant,sealedRows), baseline=sealedAudit(incumbent.variant,sealedRows);
    sealedValidation={status:'AUDITED_OBSERVATIONAL',generation,ts:Date.now(),cadence:profile.sealedAuditEvery,selectionUse:false,proposedId:winner.variant.id,incumbentId:incumbent.variant.id,proposed,incumbent:baseline,avgLiftPct:Number(proposed?.avgPct||0)-Number(baseline?.avgPct||0),nextAuditGeneration:generation+profile.sealedAuditEvery};
    event(s,`Sealed observational audit G${generation}: proposed lift ${sealedValidation.avgLiftPct.toFixed(2)}pp. Result is not used for ranking or promotion.`,'INFO');
  } else if(split.meta.available){
    sealedValidation={...sealedValidation,status:sealedValidation.status==='AUDITED_OBSERVATIONAL'?'AUDITED_OBSERVATIONAL':'PENDING_CADENCE',selectionUse:false,nextAuditGeneration:Math.ceil(generation/profile.sealedAuditEvery)*profile.sealedAuditEvery||profile.sealedAuditEvery,sealedRows:sealedRows.length};
  }

  let evidenceRecording={status:'NOT_RECORDED'};
  try{
    const recorded=recordEvolutionEvidence({dataDir:DATA_DIR,generation,variants,rows,winner,incumbent,improves,codeVersion:process.env.MONEY_PRINTER_VERSION||'unknown'});
    evidenceRecording={status:'RECORDED',trials:recorded.ledger?.trials||0,records:recorded.ledger?.records||0,frozen:!!recorded.manifest,candidateId:recorded.manifest?.candidate?.id||null,stage:recorded.gate?.stage||null};
    if(recorded.manifest)event(s,`Evidence freeze ${recorded.manifest.candidate.id}: ${recorded.gate?.stage||'RESEARCH_ONLY'}; executable evidence collection required.`,'INFO');
  }catch(e){
    evidenceRecording={status:'ERROR',error:String(e?.message||e)};
    event(s,`Evidence recorder failed closed: ${evidenceRecording.error}`,'WARN');
  }

  const cluster=await getClusterStatus();
  const clusterWorkers=cluster.enabled?(cluster.workers||[]).filter(w=>w.online).reduce((q,w)=>q+Number(w.slots||1),0):0;
  const hist={generation,ts:Date.now(),datasetSamples:rows.length,sealedSamples:sealedRows.length,variants:variants.length,championId:champion.id,
    best:winner?.metrics||null,promoted:!!improves,distributed:!!cluster.enabled,searchCoverage:coverage,evidence:evidenceRecording,sealedAudit:auditDue?{status:sealedValidation.status,avgLiftPct:sealedValidation.avgLiftPct,selectionUse:false}:null};
  const history=[hist,...(s.evolutionLoop.history||[])].slice(0,250);
  snapshot(s,{generation,variantsTested:s.evolutionLoop.variantsTested+variants.length,datasetSamples:rows.length,sealedSamples:sealedRows.length,sealedSplit:split.meta,searchCoverage:coverage,sealedValidation,
    survivors:challengers.filter(x=>x.heldOutAvgPct>0).length,champion,challengers,history,status:'RUNNING',cluster,
    activeGeneration:null,currentBatchSize:variants.length,currentBatchCompleted:variants.length,currentBatchStatus:'COMPLETE',
    nextGenerationProgress:100,workerCount:clusterWorkers||localWorkerCount(profile),lastGenerationMs:Date.now()-startedAt,lastGenerationCompletedAt:Date.now(),
    researchMode,researchProfile:{...profile,effectiveBatchSize:batchSize},beastProfile:beast,evidenceRecording});
  publishEvolution(s);
}
