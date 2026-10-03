// Attribution-preserving external features. These are not public Robinhood customer trades.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {initializePaperBook,readPaperBook,paperBookStatus,mutatePaperBook} from './paperBookStore.js';
import {observedDailyQuote} from './robinhoodDailyBook.js';
const programs=new Set(['pump','pumpswap','raydium-amm','raydium-cpmm','raydium-launchlab','meteora-dlmm','jupiter']);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function nativeSolFlowFeatures(rows=[],{now=Date.now(),windowMs=3600000,supportedSymbols=[],maxRows=2000}={}){
 const supported=new Set(supportedSymbols),unique=new Map(),ambiguous=new Set(),rejections={};
 const reject=reason=>{rejections[reason]=(rejections[reason]||0)+1};
 for(const r of rows.slice(0,maxRows)){
  let raw=r.raw;try{raw||=JSON.parse(r.raw_json||'{}')}catch{reject('INVALID_PROVENANCE');continue}
  const t=Number(r.ts),sol=Number(r.solDelta??r.sol_delta),token=Number(r.tokenDelta??r.token_delta);
  if(!r.signature||!r.wallet||!r.source||raw.signer!==true||!programs.has(raw.program)){reject('ATTRIBUTABLE_SWAP_REQUIRED');continue}
  if(!Number.isFinite(t)||t>now||t<now-windowMs){reject('STALE_OR_FUTURE_EVENT');continue}
  if(!Number.isFinite(sol)||!Number.isFinite(token)||sol===0||token===0||sol*token>=0){reject('TRANSFER_OR_NON_SWAP_BALANCE_CHANGE');continue}
  if(!supported.has('SOL-USD')){reject('UNSUPPORTED_ROBINHOOD_INSTRUMENT');continue}
  const key=`${r.signature}:${r.wallet}`,old=unique.get(key);
  // Several indexed mints can refer to the same wallet's native leg. Count it once.
  if(ambiguous.has(key))continue;
  if(old&&old.nativeDeltaSol!==sol){unique.delete(key);ambiguous.add(key);reject('AMBIGUOUS_NATIVE_LEG');continue}
  if(old)continue;
  unique.set(key,{id:key,sourceTradeId:r.signature,sourceWallet:r.wallet,source:r.source,sourceInstrument:r.mint,underlying:'SOL-USD',
   eventAt:t,firstObservedAt:now,availableAt:now,nativeDeltaSol:sol,quantity:Math.abs(sol),nativeSide:sol>0?'BUY':'SELL',
   mapping:'NATIVE_SOL_SWAP_BALANCE_LEG',signalKind:'EXTERNAL_AGGREGATE_FLOW',classification:'SIGNER_SWAP_BALANCE_PATTERN',walletCluster:raw.walletCluster||null});
 }
 const receipts=[...unique.values()].sort((a,b)=>a.eventAt-b.eventAt||a.id.localeCompare(b.id)),net=receipts.reduce((sum,r)=>sum+r.nativeDeltaSol,0);
 const payload={schema:'mpo.robinhood-external-features.v1',at:now,source:'indexed-solana-swap-native-leg',supportedSymbols:[...supported].sort(),
  signals:receipts.length?[{symbol:'SOL-USD',kind:'EXTERNAL_AGGREGATE_FLOW',netFlowSol:net,grossFlowSol:receipts.reduce((sum,r)=>sum+Math.abs(r.nativeDeltaSol),0),
   direction:net>0?'BULLISH':net<0?'BEARISH':'NEUTRAL',events:receipts.length,uniqueWallets:new Set(receipts.map(r=>r.sourceWallet)).size,
   independentClusters:receipts.every(r=>r.walletCluster)?new Set(receipts.map(r=>r.walletCluster)).size:null,availableAt:now,receiptIds:receipts.map(r=>r.id)}]:[],
  receipts,rejections,qualified:false,qualificationEffect:'NONE',executionVenue:'robinhood-local-paper',
  ablations:['MOMENTUM_ONLY','EXTERNAL_NATIVE_FLOW_ONLY','MOMENTUM_PLUS_EXTERNAL_NATIVE_FLOW'],
  waits:receipts.length?[]:['ATTRIBUTABLE_SUPPORTED_NATIVE_SWAP_RECEIPTS_REQUIRED'],limitations:['Native SOL leg of observed swaps is aggregate flow, not named-leader copying', 'Transfers and memecoin ticker mappings are excluded', 'Different wallets are not assumed independent', 'No follower fill is inferred from source transactions']};
 return {...payload,featureHash:hash({receipts:receipts.map(({firstObservedAt,availableAt,...r})=>r),windowMs,supportedSymbols:payload.supportedSymbols})};
}
export function readNativeSolFlowFeatures({db,now=Date.now(),windowMs=3600000,supportedSymbols=[],maxRows=2000}={}){
 if(!db?.prepare)return nativeSolFlowFeatures([],{now,windowMs,supportedSymbols,maxRows});
 const limit=Math.max(1,Math.min(2000,Math.floor(maxRows))),rows=db.prepare('SELECT signature,event_index,ts,mint,wallet,side,token_delta,sol_delta,source,raw_json FROM tx_events WHERE ts>=? AND ts<=? ORDER BY ts DESC LIMIT ?').all(now-windowMs,now,limit);
 return nativeSolFlowFeatures(rows,{now,windowMs,supportedSymbols,maxRows:limit});
}
export function externalNativeFlowDecision(features,{symbol,asOf,policy='EXTERNAL_NATIVE_FLOW_ONLY',momentumEnter=false,minEvents=3,minNetFlowSol=1}={}){
 const signal=features?.signals?.find(s=>s.symbol===symbol&&s.kind==='EXTERNAL_AGGREGATE_FLOW');
 if(policy==='MOMENTUM_ONLY')return {enter:!!momentumEnter,policy,signalKind:'ORDINARY_MOMENTUM',countsTowardQualification:false};
 if(!['EXTERNAL_NATIVE_FLOW_ONLY','MOMENTUM_PLUS_EXTERNAL_NATIVE_FLOW'].includes(policy)||!signal||signal.availableAt>asOf||asOf-signal.availableAt>60000)return {enter:false,policy,reason:'FRESH_POINT_IN_TIME_EXTERNAL_FEATURE_REQUIRED'};
 const enter=signal.events>=minEvents&&signal.netFlowSol>=minNetFlowSol&&(policy!=='MOMENTUM_PLUS_EXTERNAL_NATIVE_FLOW'||momentumEnter);
 return {enter,policy,signalKind:'EXTERNAL_AGGREGATE_FLOW',featureHash:features.featureHash,availableAt:signal.availableAt,receiptIds:signal.receiptIds,
  countsTowardQualification:false,reason:enter?'observed native SOL flow ablation':'external flow threshold or momentum confirmation not met'};
}
export const RH_EXTERNAL_POLICIES=Object.freeze(['MOMENTUM_ONLY','EXTERNAL_NATIVE_FLOW_ONLY','MOMENTUM_PLUS_EXTERNAL_NATIVE_FLOW']);
export const RH_EXTERNAL_DEFAULTS=Object.freeze({startUsd:25,stakeUsd:5,maxOpen:1,holdMs:3600000,processingMs:250,entryMaxAgeMs:60000,feeFloor:.0095,slipBps:5,minEvents:3,minNetFlowSol:1});
const fileFor=(dataDir,policy)=>path.resolve(dataDir,'experiments',`rh-${policy.toLowerCase()}`,'paper.json');
const rounded=n=>Math.round(n*1e6)/1e6;
export function robinhoodExternalBookViews({dataDir=process.env.MONEY_PRINTER_DATA_DIR||'data'}={}){
 return RH_EXTERNAL_POLICIES.map(policy=>({policy,file:fileFor(dataDir,policy),...paperBookStatus(fileFor(dataDir,policy))}));
}
// Three independent $25 portfolios. The caller supplies only read-only RH execution observations
// and the existing strategy's momentum decision. No broker transport/order path is imported.
export async function tickRobinhoodExternalBooks({dataDir=process.env.MONEY_PRINTER_DATA_DIR||'data',features=null,momentum=false,quoteFn=null,supportedSymbols=[],now,clock=Date.now,enabled=true}={}){
 const realtime=now===undefined;now??=clock();const result=[];
 for(const policy of RH_EXTERNAL_POLICIES){
  try {
  const file=fileFor(dataDir,policy);
  if(!fs.existsSync(file)&&!fs.existsSync(file+'.verified.json'))initializePaperBook(file,{schema:'mpo.robinhood-external-paper.v1',mode:'PAPER',startUsd:25,cashUsd:25,open:[],history:[],funding:[{at:now,amountUsd:25,kind:'INITIAL_CAPITAL'}],createdAt:now,
   policy,settings:{...RH_EXTERNAL_DEFAULTS},experiment:{id:`rh-${policy.toLowerCase()}-v1`,policy,startedAt:now,policyHash:hash({policy,...RH_EXTERNAL_DEFAULTS}),qualificationEffect:'NONE'},qualification:'UNQUALIFIED_EXPLORATION',decisions:[],status:'COLLECTING'});
  let book=readPaperBook(file),entries=0,exits=0;const settings=book.settings;
  const record=(reason,action='WAIT')=>mutatePaperBook(file,b=>{b.lastRunAt=now;b.status=reason;b.decisions=[{at:now,reason,action},...(b.decisions||[])].slice(0,100)});
  if(typeof quoteFn!=='function'){record('SUPPORTED_ROBINHOOD_QUOTE_REQUIRED');result.push({policy,entries,exits,status:'SUPPORTED_ROBINHOOD_QUOTE_REQUIRED'});continue}
  for(const p of book.open){
   let q;try{q=await quoteFn(p.symbol,{side:'sell',quantity:p.quantity,eligibleAt:p.openedAt,decidedAt:p.openedAt})}catch(e){record(e.code||'EXIT_QUOTE_UNAVAILABLE');continue}
   if(realtime)now=clock();
   const valid=observedDailyQuote(q,p.symbol,{now,eligibleAt:p.openedAt,side:'sell',quantity:p.quantity});
   if(!valid.ok){record(valid.reason,'WAIT_EXIT');continue}
   mutatePaperBook(file,b=>{const live=b.open.find(x=>x.id===p.id);if(!live)return;
    const fee=Math.max(settings.feeFloor,Number(q.feeRatio)||0),proceeds=rounded(live.quantity*q.bid*(1-settings.slipBps/1e4)*(1-fee));
    live.markValueUsd=proceeds;live.markAt=q.at;
    if(now-live.openedAt<settings.holdMs)return;
    const gross=live.quantity*q.bid*(1-settings.slipBps/1e4);b.cashUsd=rounded(b.cashUsd+proceeds);b.history.unshift({...live,status:'SOLD',closedAt:now,payoutUsd:proceeds,exitFeeUsd:rounded(gross*fee),pnlUsd:rounded(proceeds-live.costUsd),exitQuoteAt:q.at,exitSource:q.source});b.open=b.open.filter(x=>x.id!==live.id);exits++});
  }
  book=readPaperBook(file);
  if(!enabled){record('PAUSED_NEW_ENTRIES');result.push({policy,entries,exits,status:'PAUSED_NEW_ENTRIES'});continue}
  if(!supportedSymbols.includes('SOL-USD')){record('SUPPORTED_SOL_USD_PAIR_REQUIRED');result.push({policy,entries,exits,status:'SUPPORTED_SOL_USD_PAIR_REQUIRED'});continue}
  const momentumValue=typeof momentum==='function'?await momentum('SOL-USD',features):momentum;
  const momentumEnter=typeof momentumValue==='object'?momentumValue?.enter===true:momentumValue===true;
  const pick=externalNativeFlowDecision(features,{symbol:'SOL-USD',asOf:now,policy,momentumEnter,minEvents:settings.minEvents,minNetFlowSol:settings.minNetFlowSol});
  if(!book.pending&&pick.enter&&book.open.length<settings.maxOpen&&book.cashUsd>=1){
   const identity=policy==='MOMENTUM_ONLY'?`momentum:${Math.floor(now/1800000)}`:pick.featureHash;
   if(!(book.receipts||[]).some(r=>r.id===identity))mutatePaperBook(file,b=>{b.pending={id:identity,symbol:'SOL-USD',firstObservedAt:now,eligibleAt:now+settings.processingMs,decisionAt:now,featureHash:pick.featureHash||null,receiptIds:pick.receiptIds||[],signalKind:pick.signalKind,policy,experimentId:b.experiment.id}});
  }
  book=readPaperBook(file);const intent=book.pending;
  if(intent&&book.open.length<settings.maxOpen){
   if(now-intent.firstObservedAt>settings.entryMaxAgeMs){mutatePaperBook(file,b=>{b.pending=null});record('STALE_EXTERNAL_ENTRY_INTENT','CANCELLED')}
   else{
    let q;try{q=await quoteFn(intent.symbol,{side:'buy',quantity:null,budgetUsd:Math.min(settings.stakeUsd,book.cashUsd),eligibleAt:intent.eligibleAt,decidedAt:intent.decisionAt})}catch(e){record(e.code||'ENTRY_QUOTE_UNAVAILABLE')}
    if(realtime)now=clock();
    const fee=Math.max(settings.feeFloor,Number(q?.feeRatio)||0),step=Number(q?.quantityStep)||.000001,budget=Math.min(settings.stakeUsd,book.cashUsd),quantity=q?.ask>0?Math.floor(budget*(1-fee)/(q.ask*(1+settings.slipBps/1e4))/step)*step:0;
    const valid=observedDailyQuote(q,intent.symbol,{now,eligibleAt:intent.eligibleAt,side:'buy',quantity});
    if(!valid.ok||!(quantity>0))record(valid.ok?'SMALL_BANK_OR_LOT_UNAVAILABLE':valid.reason,'WAIT_ENTRY');
    else{
     mutatePaperBook(file,b=>{if(!b.pending||b.pending.id!==intent.id||b.open.length>=settings.maxOpen)throw new Error('External intent changed; retry');
      const cost=rounded(quantity*q.ask*(1+settings.slipBps/1e4)/(1-fee));if(cost>b.cashUsd)throw new Error('External paper budget changed');
      b.cashUsd=rounded(b.cashUsd-cost);b.open.push({...intent,id:`${policy}:${intent.id}`,quantity,costUsd:cost,feeUsd:rounded(cost*fee),entryAsk:q.ask,entryQuoteAt:q.at,provider:q.source,openedAt:now,status:'OPEN',countsTowardQualification:false});b.pending=null;entries++;
     },{receiptId:intent.id});
    }
   }
  }
  book=readPaperBook(file);const status=book.pending?book.status:book.open.length?'EXPLORING':book.cashUsd<1?'EXHAUSTED':pick.enter?'COLLECTING':pick.reason||'WAITING_FOR_SIGNAL';record(status);result.push({policy,entries,exits,status});
  } catch(error) {result.push({policy,entries:0,exits:0,status:error.code||'RECOVERY_REQUIRED',reason:String(error.message).slice(0,200)});}
 }
 return {ran:true,books:result,ordersSubmitted:0};
}
