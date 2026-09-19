import fs from 'node:fs';
import path from 'node:path';
import {
  evidenceHash, appendTrialOnce, makeFreezeManifest, writeFreezeManifest,
  trialLedgerInfo, assembleEvidence, upsertEvidenceMonitor,
} from './researchEvidenceStore.js';
import { recordEvidenceControlPlane } from './researchControlPlane.js';

const coverageNone=()=>({asOfSignals:false,costs:false,depth:false,latency:false,sharedCapital:false,eventGrouping:false});

export function recordEvolutionEvidence({dataDir,generation,variants,rows,winner,incumbent,improves,codeVersion='unknown'}={}){
  const root=path.join(path.resolve(dataDir||'data'),'research-evidence','solana');
  const ledgerFile=path.join(root,'trials.ndjson');
  const monitorFile=path.join(path.resolve(dataDir||'data'),'research-evidence-monitor.json');
  const rankingWindowEnd=Number(rows?.at?.(-1)?.ts||rows?.[rows.length-1]?.ts||0);
  const datasetHash=evidenceHash((rows||[]).map(r=>({ts:r.ts,returnPct:r.returnPct,features:r.features})));
  const candidateSetHash=evidenceHash((variants||[]).map(v=>({id:v.id,parentId:v.parentId,testLane:v.testLane,weights:v.weights,threshold:v.threshold,stopPct:v.stopPct,takePct:v.takePct,maxHoldMin:v.maxHoldMin})));
  const trialId=`solana-g${Number(generation)}-${candidateSetHash.slice(0,12)}`;
  const ledger=appendTrialOnce(ledgerFile,{id:trialId,module:'solana',generation:Number(generation),trialsRepresented:Math.max(1,(variants||[]).length),rankingWindowEnd,datasetHash,candidateSetHash,winnerId:winner?.variant?.id||null,incumbentId:incumbent?.variant?.id||null,improved:improves===true});
  if(!improves||!winner?.variant||!incumbent?.variant)return {ledger,manifest:null,monitor:null};
  const manifest=makeFreezeManifest({module:'solana',candidate:{id:winner.variant.id,params:winner.variant},incumbent:{id:incumbent.variant.id,params:incumbent.variant},rankingWindowEnd,codeVersion,frozenAt:Date.now()});
  const freezeDir=path.join(root,'freezes'); fs.mkdirSync(freezeDir,{recursive:true});
  const freezeFile=path.join(freezeDir,`${String(winner.variant.id).replace(/[^A-Za-z0-9._-]/g,'_')}.json`);
  const freeze=writeFreezeManifest(freezeFile,manifest);
  const bundle=assembleEvidence({module:'solana',manifest,ledger:trialLedgerInfo(ledgerFile),provenance:'observed',evaluator:null,coverage:coverageNone(),sealed:null,forward:null});
  const monitor=upsertEvidenceMonitor(monitorFile,bundle);
  let controlPlane=null;
  try{controlPlane=recordEvidenceControlPlane({dataDir,bundle,source:'solana-evolution-evidence'}); }
  catch(e){controlPlane={schema:'mpo.research-control-plane.v1',error:String(e?.message||e),automaticLivePromotionAllowed:false};}
  return {ledger,manifest,freeze,freezeFile,monitor,gate:bundle.gate,controlPlane};
}
