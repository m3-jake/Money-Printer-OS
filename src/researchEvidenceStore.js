import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { evaluateResearchEvidence, EVIDENCE_SCHEMA } from './researchEvidenceGate.js';

export const STORE_SCHEMA='mpo.research-evidence-store.v1';
export const MONITOR_SCHEMA='mpo.research-evidence-monitor.v1';

export function canonicalize(value){
  if(Array.isArray(value))return value.map(canonicalize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonicalize(value[k])]));
  if(typeof value==='number'&&!Number.isFinite(value))throw new TypeError('non-finite number in canonical evidence');
  return value;
}
export const canonicalJson=value=>JSON.stringify(canonicalize(value));
export const evidenceHash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const ensureParent=file=>fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
function atomicJson(file,value){
  ensureParent(file); const tmp=`${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2)); fs.renameSync(tmp,file);
}

export function makeFreezeManifest({module,candidate,incumbent,rankingWindowEnd,codeVersion='unknown',frozenAt=Date.now()}={}){
  if(!['solana','polymarket'].includes(module))throw new Error('module must be solana or polymarket');
  if(!candidate||!incumbent)throw new Error('candidate and incumbent required');
  const cp={module,params:candidate.params??candidate,codeVersion}, ip={module,params:incumbent.params??incumbent,codeVersion};
  const ch=evidenceHash(cp), ih=evidenceHash(ip);
  return Object.freeze({schema:STORE_SCHEMA,kind:'freeze-manifest',module,frozenAt:Number(frozenAt),rankingWindowEnd:Number(rankingWindowEnd),codeVersion,
    candidate:Object.freeze({id:String(candidate.id||ch.slice(0,12)),hash:ch,payload:cp}),incumbent:Object.freeze({id:String(incumbent.id||ih.slice(0,12)),hash:ih,payload:ip})});
}
export function writeFreezeManifest(file,manifest){
  ensureParent(file);
  try{
    const fd=fs.openSync(file,'wx');
    try{fs.writeFileSync(fd,JSON.stringify(manifest,null,2))}finally{fs.closeSync(fd)}
    return {created:true,manifestHash:evidenceHash(manifest)};
  }catch(e){
    if(e.code!=='EEXIST')throw e;
    const prior=JSON.parse(fs.readFileSync(file,'utf8'));
    if(evidenceHash(prior)!==evidenceHash(manifest))throw new Error('FREEZE_MANIFEST_IMMUTABLE');
    return {created:false,manifestHash:evidenceHash(prior)};
  }
}

export function readTrialLedger(file){
  if(!fs.existsSync(file))return[];
  return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map((x,i)=>{
    try{return JSON.parse(x)}catch{throw new Error(`CORRUPT_TRIAL_LEDGER_LINE_${i+1}`)}
  });
}
export function trialLedgerInfo(file){
  const rows=readTrialLedger(file),raw=fs.existsSync(file)?fs.readFileSync(file):Buffer.alloc(0);
  const trials=rows.reduce((q,row)=>q+Math.max(1,Math.floor(Number(row?.trialsRepresented)||1)),0);
  return {trials,records:rows.length,ledgerHash:crypto.createHash('sha256').update(raw).digest('hex'),rows};
}
export function appendTrial(file,trial){
  if(!trial?.id)throw new Error('trial id required'); ensureParent(file);
  const fd=fs.openSync(file,'a'); try{fs.writeSync(fd,canonicalJson({...trial,recordedAt:Number(trial.recordedAt||Date.now())})+'\n')}finally{fs.closeSync(fd)}
  return trialLedgerInfo(file);
}
export function appendTrialOnce(file,trial){
  if(!trial?.id)throw new Error('trial id required');
  const prior=readTrialLedger(file);
  if(prior.some(row=>String(row?.id)===String(trial.id)))return {...trialLedgerInfo(file),appended:false};
  return {...appendTrial(file,trial),appended:true};
}
const registryKey=x=>evidenceHash({module:x.module,datasetHash:x.datasetHash,startAt:Number(x.startAt),endAt:Number(x.endAt)});
export function consumeSealedWindow(file,record,{lockTimeoutMs=2500}={}){
  if(!record?.module||!record?.datasetHash||!Number.isFinite(Number(record.startAt))||!Number.isFinite(Number(record.endAt)))throw new Error('invalid sealed-window record');
  ensureParent(file); const lock=file+'.lock',started=Date.now();
  while(true){
    try{fs.mkdirSync(lock);break}catch(e){
      if(e.code!=='EEXIST')throw e;
      if(Date.now()-started>lockTimeoutMs)throw new Error('SEALED_REGISTRY_BUSY');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
    }
  }
  try{
    let reg={schema:STORE_SCHEMA,kind:'sealed-window-registry',windows:{}};
    if(fs.existsSync(file))reg=JSON.parse(fs.readFileSync(file,'utf8'));
    const key=registryKey(record),prior=reg.windows?.[key];
    if(prior)return {consumedNow:false,key,auditCount:1,record:prior,registryHash:evidenceHash(reg)};
    const saved={...record,key,consumed:true,auditCount:1,consumedAt:Number(record.consumedAt||Date.now())};
    reg.windows={...(reg.windows||{}),[key]:saved}; atomicJson(file,reg);
    return {consumedNow:true,key,auditCount:1,record:saved,registryHash:evidenceHash(reg)};
  }finally{try{fs.rmdirSync(lock)}catch{}}
}

function invNorm(p){
  if(!(p>0&&p<1))return p===0?-Infinity:p===1?Infinity:NaN;
  const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924];
  const b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857];
  const c=[-.00778489400243029,-.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878];
  const d=[.00778469570904146,.32246712907004,2.445134137143,3.75440866190742],pl=.02425,ph=1-pl; let q,r;
  if(p<pl){q=Math.sqrt(-2*Math.log(p));return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
  if(p>ph){q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
  q=p-.5;r=q*q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

export function groupedImprovementInterval(groups,{trials=1,confidence=.95}={}){
  const by=new Map();
  for(const g of groups||[]){
    const id=String(g?.id||''),c=Number(g?.candidateReturnPct),i=Number(g?.incumbentReturnPct);
    if(!id||!Number.isFinite(c)||!Number.isFinite(i))continue;
    const a=by.get(id)||[];a.push(c-i);by.set(id,a);
  }
  const diffs=[...by.values()].map(a=>a.reduce((q,x)=>q+x,0)/a.length),n=diffs.length;
  if(n<2)return null;
  const mean=diffs.reduce((q,x)=>q+x,0)/n;
  const variance=diffs.reduce((q,x)=>q+(x-mean)**2,0)/(n-1),se=Math.sqrt(variance/n);
  const alpha=1-Math.max(.5,Math.min(.999999,Number(confidence)||.95));
  const m=Math.max(1,Math.floor(Number(trials)||1)),adjustedAlpha=alpha/m,z=invNorm(1-adjustedAlpha/2),margin=z*se;
  return {lowerPct:mean-margin,upperPct:mean+margin,level:1-adjustedAlpha,method:'paired-independent-group-normal-bonferroni',grouped:true,
    independentGroups:n,adjustedForTrials:m,assumption:'groups independent; dependence within group retained by aggregation',meanImprovementPct:mean,standardErrorPct:se};
}

export function buildPairedStage({manifest,datasetHash,opportunitySetHash,startAt,endAt,summary={},groups=[],stressModel={},usedForSelection=false,mode}={}){
  const interval=groupedImprovementInterval(groups,{trials:summary.trials||1,confidence:summary.confidence||.95});
  const unique=new Set((groups||[]).map(g=>String(g?.id||'')).filter(Boolean));
  return {candidateHash:manifest?.candidate?.hash,incumbentHash:manifest?.incumbent?.hash,datasetHash,opportunitySetHash,
    sameOpportunities:summary.sameOpportunities===true,sameStartingCapital:summary.sameStartingCapital===true,
    startAt:Number(startAt),endAt:Number(endAt),usedForSelection:usedForSelection===true,independentGroups:unique.size,
    netReturnPct:Number(summary.netReturnPct),incumbentNetReturnPct:Number(summary.incumbentNetReturnPct),maxDrawdownPct:Number(summary.maxDrawdownPct),
    stressNetReturnPct:Number(summary.stressNetReturnPct),stressModelHash:evidenceHash(stressModel),improvementInterval:interval,mode};
}

export function assembleEvidence({module,manifest,ledger,provenance='observed',evaluator,coverage,sealed,forward,auditReceipt}={}){
  const e={schema:EVIDENCE_SCHEMA,module,candidate:{id:manifest?.candidate?.id,hash:manifest?.candidate?.hash,frozenAt:manifest?.frozenAt},incumbentHash:manifest?.incumbent?.hash,
    search:{trials:Number(ledger?.trials||0),ledgerHash:ledger?.ledgerHash,rankingWindowEnd:manifest?.rankingWindowEnd},
    provenance,evaluator,coverage,sealed:{...sealed,auditCount:auditReceipt?.auditCount,consumed:auditReceipt?.record?.consumed===true},forward};
  return {evidence:e,gate:evaluateResearchEvidence(e)};
}

export function evidenceMonitorEntry(bundle={}){
  const e=bundle.evidence||{},g=bundle.gate||evaluateResearchEvidence(e),stage=e.forward||e.sealed||{};
  return {module:e.module||g.module,stage:g.stage,incumbentHash:e.incumbentHash||null,candidateId:e.candidate?.id||null,candidateHash:e.candidate?.hash||null,
    netImprovementPct:g.improvementPct??(Number.isFinite(stage.netReturnPct)&&Number.isFinite(stage.incumbentNetReturnPct)?stage.netReturnPct-stage.incumbentNetReturnPct:null),
    maxDrawdownPct:Number.isFinite(stage.maxDrawdownPct)?stage.maxDrawdownPct:null,improvementInterval:stage.improvementInterval||null,
    independentGroups:Number(stage.independentGroups||0),coverage:e.coverage||{},trials:Number(e.search?.trials||0),reasons:g.reasons||[],
    paperEligible:!!g.paperEligible,reviewReady:!!g.reviewReady,livePromotionAllowed:false};
}

export function writeEvidenceMonitor(file,bundles=[]){
  const out={schema:MONITOR_SCHEMA,updatedAt:Date.now(),modules:(bundles||[]).map(evidenceMonitorEntry),livePromotionAllowed:false};
  atomicJson(file,out); return out;
}
export function upsertEvidenceMonitor(file,bundle){
  const prior=readEvidenceMonitor(file),entry=evidenceMonitorEntry(bundle);
  const modules=[...(prior.modules||[]).filter(x=>x?.module!==entry.module),entry];
  const out={schema:MONITOR_SCHEMA,updatedAt:Date.now(),modules,livePromotionAllowed:false};
  atomicJson(file,out); return out;
}
export function readEvidenceMonitor(file){
  try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return {schema:MONITOR_SCHEMA,updatedAt:null,modules:[],livePromotionAllowed:false}}
}