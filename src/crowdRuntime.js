// OS collector-owned persistence. Uses existing RPC/market/quote collectors, never new providers.
import fs from 'node:fs';import path from 'node:path';
import { cfg } from './config.js';
import { assertGlobalTradingNotHalted } from './core/executionBoundary.js';
import { writeFileAtomicSync } from './atomicRename.js';
import { effectivePumpPolicy,baselineConfig } from './pumpProfitRuntime.js';
import { CROWD_SCHEMA,CROWD_LIMITS,CROWD_CAPABILITIES,emptyCrowdCapture,appendCrowdCapture,crowdHash,sealCrowdRecord,validCrowdRecord,crowdControl } from './crowdContract.js';
import { createCrowdStudy,advanceCrowdStudy,crowdStudyRequests,crowdStudyView } from './crowdStudy.js';
const root=()=>path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
export function readCrowdJson(file,fallback=null,maxBytes=CROWD_LIMITS.bytes){
 try{const st=fs.statSync(file);if(st.size>maxBytes)throw new Error('Crowd file exceeds bounded size: '+path.basename(file));return JSON.parse(fs.readFileSync(file,'utf8'));}
 catch(e){if(e.code==='ENOENT')return fallback;throw e;}
}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});writeFileAtomicSync(file,JSON.stringify(value));}
const captureCache=new Map();
export function loadCrowdCapture(dir=root(),now=Date.now()){
 const file=path.join(dir,'wallet-crowd-capture.json'),tape=path.join(dir,'wallet-crowd-events.ndjson');
 const stamp=fs.existsSync(file)?fs.statSync(file).mtimeMs:0,prior=captureCache.get(dir);if(prior?.stamp===stamp)return prior.value;
 let state=readCrowdJson(file,null);if(state&&!validCrowdRecord(state))throw new Error('Crowd capture checksum mismatch');
 // Recover journaled receipts after a crash between append and atomic checkpoint. Never reset evidence.
 if(fs.existsSync(tape)){
  if(fs.statSync(tape).size>CROWD_LIMITS.bytes)throw new Error('Crowd journal size cap');
  const lines=fs.readFileSync(tape,'utf8').split('\n').filter(Boolean);let previous=null,sequence=0;
  for(const line of lines){const frame=JSON.parse(line);if(!validCrowdRecord(frame)||frame.previousHash!==previous||frame.sequence!==++sequence)throw new Error('Crowd journal integrity failure');
   if(!state)state=emptyCrowdCapture(frame.createdAt);
   if(frame.sequence>(state.frameSequence||0)){state=appendCrowdCapture(state,frame.rawEvents,frame.window,{now:frame.at});state.frameSequence=frame.sequence;state.frameHash=frame.hash;}
   previous=frame.hash;
  }
  if(state.frameHash!==previous||state.frameSequence!==sequence)throw new Error('Crowd checkpoint is ahead of its evidence journal');
 }
 state||=emptyCrowdCapture(now);state=sealCrowdRecord(state);write(file,state);captureCache.set(dir,{stamp:fs.statSync(file).mtimeMs,value:state});return state;
}
export function captureCrowdEvents(rawEvents=[],window=null,{dir=root(),now=Date.now()}={}){
 const old=loadCrowdCapture(dir,now),next=structuredClone(old),tape=path.join(dir,'wallet-crowd-events.ndjson');
 if((fs.existsSync(tape)?fs.statSync(tape).size:0)>CROWD_LIMITS.bytes-2*1024*1024){next.status='STORAGE_BUDGET_SPENT';const stopped=sealCrowdRecord(next);write(path.join(dir,'wallet-crowd-capture.json'),stopped);captureCache.delete(dir);return {status:stopped.status,sequence:old.sequence};}
 appendCrowdCapture(next,rawEvents,window,{now});
 const frame=sealCrowdRecord({schema:CROWD_SCHEMA,sequence:(old.frameSequence||0)+1,previousHash:old.frameHash||null,createdAt:old.createdAt,at:now,rawEvents,window});
 const text=JSON.stringify(frame)+'\n';if(Buffer.byteLength(text)>1024*1024)throw new Error('Crowd batch exceeds backpressure bound');
 fs.mkdirSync(dir,{recursive:true});const fd=fs.openSync(tape,'a');try{fs.writeSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 next.frameSequence=frame.sequence;next.frameHash=frame.hash;const state=sealCrowdRecord(next);write(path.join(dir,'wallet-crowd-capture.json'),state);
 captureCache.set(dir,{stamp:fs.statSync(path.join(dir,'wallet-crowd-capture.json')).mtimeMs,value:state});return {status:state.status,events:state.events.length,sequence:state.sequence};
}
export function getCrowdControl(dir=root()){const x=readCrowdJson(path.join(dir,'wallet-crowd-control.json'),null);if(!x)return crowdControl();if(x.schema!==CROWD_SCHEMA||x.liveExecutionAllowed!==false)throw new Error('Invalid crowd control contract');return {...crowdControl({},x),updatedAt:x.updatedAt};}
export function setCrowdControl(input,{dir=root(),now=Date.now()}={}){
 const old=getCrowdControl(dir),next=crowdControl(input,old,now),baseline=readCrowdJson(path.join(dir,'wallet-crowd-baseline.json'));
 if(baseline&&next.budgetSol!==baseline.capitalSol)throw new Error('This study capital is frozen. Existing research books cannot be reset or resized.');
 write(path.join(dir,'wallet-crowd-control.json'),next);return next;
}
let lastBaselineFeed=0;
export function writeCrowdBaselineFeed(s,config,ranked=[],now=Date.now()){
 if(config.mode!=='paper'||now-lastBaselineFeed<5000)return;lastBaselineFeed=now;
 const policy=effectivePumpPolicy(s,config),solUsd=Number(s.market?.solUsd);
 const markets=ranked.slice(0,80).map(x=>{const at=Number(x.priceObservedAt||x.priceTs||x.at||0);return {mint:x.mint,pairAddress:x.pairAddress,priceUsd:Number(x.priceUsd||x.lastPrice||0),liquidityUsd:Number(x.liquidityUsd??x.liq??x.liquidity?.usd??0),liq:Number(x.liquidityUsd??x.liq??x.liquidity?.usd??0),
  solUsd,at,decimals:Number.isInteger(x.decimals??x.risk?.decimals??x.riskDetails?.decimals)?(x.decimals??x.risk?.decimals??x.riskDetails?.decimals):null,eligible:x.eligible===true,integrityPassed:x.priceIntegrity?.quarantined!==true&&x.quarantined!==true&&at>0&&at<=now&&now-at<=30000,executionScore:x.executionScore,score:x.score,pc5:x.pc5,micro:x.micro,priceAccel:x.priceAccel};});
 write(path.join(root(),'wallet-crowd-baseline-feed.json'),{schema:CROWD_SCHEMA,at:now,policyHash:policy.hash,policy,config:baselineConfig(s,config),markets});
}
export function crowdRuntimeTick({dir=root(),now=Date.now()}={}){
 if(cfg.mode!=='paper')return {state:'PAPER_ONLY_REFUSAL',liveExecutionAllowed:false};
 const control=getCrowdControl(dir),capture=loadCrowdCapture(dir,now),feed=readCrowdJson(path.join(dir,'wallet-crowd-baseline-feed.json'));
 const file=path.join(dir,'wallet-crowd-study.json');let study=readCrowdJson(file);
 if(!study){
  if(!feed?.policy?.hash||now-feed.at>30000)return {state:'AWAITING_CURRENT_BASELINE_FEED',liveExecutionAllowed:false};
  if(fs.existsSync(path.join(dir,'wallet-crowd-baseline.json'))||fs.existsSync(path.join(dir,'wallet-crowd-protocol.json')))throw new Error('Crowd study missing with existing immutable baseline; refusing reset');
  const s=readCrowdJson(path.join(dir,'state.json'),{});
  study=createCrowdStudy({policy:feed.policy,config:feed.config,capitalSol:control.budgetSol,now,sourceStateHash:crowdHash(s)});
  fs.writeFileSync(path.join(dir,'wallet-crowd-baseline.json'),JSON.stringify(study.baseline),{flag:'wx'});
  fs.writeFileSync(path.join(dir,'wallet-crowd-protocol.json'),JSON.stringify(study.protocol),{flag:'wx'});
 }
 const base=readCrowdJson(path.join(dir,'wallet-crowd-baseline.json')),protocol=readCrowdJson(path.join(dir,'wallet-crowd-protocol.json'));
 if(base?.hash!==study.baseline.hash||protocol?.hash!==study.protocol.hash)throw new Error('Crowd baseline/protocol sidecar mismatch');
 study.integrityBlocked=['INTEGRITY_BLOCKED','STORAGE_BUDGET_SPENT'].includes(capture.status)||!!study.replayBlocker;
 const state=readCrowdJson(path.join(dir,'state.json'),{}),quoteCache=readCrowdJson(path.join(dir,'pump-profit-quotes.json'),{}),quotes=quoteCache?.quotes||[];
 let model=readCrowdJson(path.join(dir,'lab-link','wallet-crowd-model.json'));
 if(model&&!validCrowdRecord(model))model=null;
 const extra=readCrowdJson(path.join(dir,'pump-profit-markets.json'),{})?.ticks||[];
 const markets=[...(feed?.markets||[]),...extra].filter(m=>m.at<=now&&now-m.at<=30000);
 // Decimals come from this transaction's token-balance metadata, never a guessed six/nine.
 for(const m of markets)if(!Number.isInteger(m.decimals)){const e=[...capture.events].reverse().find(e=>e.asset===m.mint&&Number.isInteger(e.decimals));if(e)m.decimals=e.decimals;}
 let entryAllowed=true;try{assertGlobalTradingNotHalted({dataDir:dir});}catch(e){entryAllowed=false;study.riskBlocker=e.code||'GLOBAL_RISK_UNAVAILABLE';}
 if(state.runtime?.killSwitch||state.runtime?.paused||state.paused||state.killSwitch){entryAllowed=false;study.riskBlocker='INCUMBENT_PAUSED_OR_KILLED';}
 advanceCrowdStudy(study,{entryAllowed,events:capture.events,windows:capture.windows,markets,quotes,model,control,incumbentPolicyHash:feed&&now-feed.at<=30000?feed.policyHash:null,incumbentPositions:[...(state.positions||[]),...(state.proposals||[]).filter(p=>p.status==='PENDING')],now});
 const inputDir=path.join(dir,'wallet-crowd-inputs'),inputFile=path.join(inputDir,'frames.ndjson');
 fs.mkdirSync(inputDir,{recursive:true});
 const bytes=fs.existsSync(inputFile)?fs.statSync(inputFile).size:0;
 if(bytes+(study.modelArchiveBytes||0)<CROWD_LIMITS.bytes-1024*1024){
  const frame=sealCrowdRecord({schema:CROWD_SCHEMA,sequence:(study.inputSequence||0)+1,previousHash:study.inputHash||null,at:now,protocolHash:study.protocol.hash,captureHash:capture.hash,modelHash:model?.hash||null,
   control,entryAllowed,incumbentPolicyHash:feed?.policyHash||null,incumbentMints:(state.positions||[]).map(p=>p.mint),markets,quotes:quotes.filter(q=>q.receivedAt<=now&&now-q.receivedAt<45000)});
  const fd=fs.openSync(inputFile,'a');try{fs.writeSync(fd,JSON.stringify(frame)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  study.inputSequence=frame.sequence;study.inputHash=frame.hash;
  if(model&&study.decisions.some(d=>d.modelHash===model.hash||(d.transitions||[]).some(a=>a.modelHash===model.hash))&&!fs.existsSync(path.join(inputDir,model.hash+'.json'))){const text=JSON.stringify(model);if(bytes+(study.modelArchiveBytes||0)+Buffer.byteLength(text)<CROWD_LIMITS.bytes-1024*1024){fs.writeFileSync(path.join(inputDir,model.hash+'.json'),text,{flag:'wx'});study.modelArchiveBytes=(study.modelArchiveBytes||0)+Buffer.byteLength(text);}else{study.replayBlocker='MODEL_ARCHIVE_BUDGET_SPENT';study.integrityBlocked=true;}}
 }else{study.integrityBlocked=true;study.replayBlocker='REPLAY_STORAGE_BUDGET_SPENT';}
 write(file,study);write(path.join(dir,'wallet-crowd-requests.json'),crowdStudyRequests(study,now));
 const evaluation=readCrowdJson(path.join(dir,'lab-link','wallet-crowd-evaluation.json'));
 const recent=capture.events.at(-1),indexer=readCrowdJson(path.join(dir,'wallet-indexer-state.json'),{})?.health||{};
 const view={schema:CROWD_SCHEMA,at:now,mode:control.mode,budgetSol:control.budgetSol,liveExecutionAllowed:false,paidCalls:0,
  coverage:{state:capture.status,scope:'SELECTED_MINT_REFERENCE_INTERVALS_NOT_THE_WHOLE_MARKET',events:capture.events.length,duplicates:capture.duplicates,rejected:capture.rejected,conflicts:capture.conflicts,windows:capture.windows.length,completeWindows:capture.windows.filter(w=>w.complete).length,
   latestObservedAt:recent?.firstObservedAt??null,latestSourceAt:recent?.sourceAt??null,detectionLagMs:recent?recent.firstObservedAt-recent.sourceAt:null,indexerState:indexer.status||'UNKNOWN',indexerError:indexer.lastError||null,backlog:indexer.coverage?.backlog??null},
  quoteCoverage:{retainedQuotes:quotes.length,lastReceivedAt:quotes.at(-1)?.receivedAt??null,totalCalls:quoteCache.calls??0,sharedCallCap:4096,backoffUntil:quoteCache.backoffUntil??null,errors:(quoteCache.errors||[]).slice(-3),provider:'EXISTING_KEYLESS_JUPITER_METIS_V1',support:'CURRENT_DOCS_SUPERSEDE_METIS_V1_NO_NEW_CREDENTIAL_OR_PROVIDER_ADDED'},
  study:crowdStudyView(study,now),evaluation:evaluation||{state:'AWAITING_LAB',qualified:false,blockers:['NO_LAB_EVALUATION']},
  leaderResults:readCrowdJson(path.join(dir,'wallet-scorecard.json'),{})?.summary||null,leaderResultLabel:'OBSERVED_WALLET_HISTORY_NOT_COPY_PROFIT',
  model:model?{hash:model.hash,asOf:model.asOf,coverage:model.coverage,candidates:model.candidates.map(({remainingSamples,...c})=>c).slice(0,8),caveat:model.caveat}:null,capabilities:CROWD_CAPABILITIES};
 write(path.join(dir,'wallet-crowd-view.json'),view);return {state:control.mode,events:capture.events.length,decisions:study.decisions.length,liveExecutionAllowed:false};
}
export function crowdRuntimeView(dir=root(),now=Date.now()){
 try{const view=readCrowdJson(path.join(dir,'wallet-crowd-view.json'),{schema:CROWD_SCHEMA,state:'AWAITING_COLLECTOR',liveExecutionAllowed:false});return {...view,control:getCrowdControl(dir),collectorAgeMs:view.at?now-view.at:null,collectorFresh:!!view.at&&now-view.at<=60000};}
 catch(e){return {schema:CROWD_SCHEMA,state:'INTEGRITY_BLOCKED',error:e.message,liveExecutionAllowed:false};}
}