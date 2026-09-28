// Versioned OS/Lab contract. Public observations only; addresses are NOT people.
import { createHash } from 'node:crypto';
export const CROWD_SCHEMA='mpo.wallet-crowd.v1';
export const CROWD_MODES=Object.freeze(['OBSERVE_ONLY','SHADOW_COMPARISON','PAPER_EXPERIMENT']);
export const CROWD_ACTIONS=Object.freeze(['DIRECT_COPY','EARLY_FOLLOW','WAIT','AVOID','EXIT_ADJUSTMENT','CONFIRMED_REVERSAL','NO_TRADE']);
export const CROWD_LIMITS=Object.freeze({events:20000,windows:2048,episodes:512,leaders:32,relationships:256,decisions:512,bytes:64*1024*1024,modelTrials:1});
export const CROWD_HORIZON_MS=120000;
export const numberOrNull=x=>x===null||x===undefined||x===''?null:(Number.isFinite(Number(x))?Number(x):null);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,canonical(x[k])])):x;
export const crowdHash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
export function sealCrowdRecord(x){const {hash,...body}=x;return {...body,hash:crowdHash(body)};}
export function validCrowdRecord(x){if(!x||typeof x!=='object')return false;const {hash,...body}=x;return typeof hash==='string'&&hash===crowdHash(body);}
export function assertCrowdPaper(x){if(x?.schema!==CROWD_SCHEMA||x?.mode!=='PAPER'||x?.liveExecutionAllowed!==false)throw new Error('Wallet & Crowd has no live execution authority');}
export function normalizeCrowdEvent(raw,{now=Date.now()}={}){
 const r=raw?.raw||{},sourceAt=numberOrNull(raw?.ts),observedAt=numberOrNull(r.firstObservedAt),ingestedAt=numberOrNull(r.ingestedAt);
 const fail=reason=>({ok:false,reason});
 if(!raw?.signature||!raw.mint||!raw.wallet||r.signer!==true)return fail('missing-signer-or-identity');
 if(![sourceAt,observedAt,ingestedAt].every(x=>x>0)||sourceAt>observedAt||observedAt>ingestedAt||ingestedAt>now)return fail('missing-or-invalid-observation-clock');
 if(raw.failed||raw.reverted||!['confirmed','finalized'].includes(r.confirmation))return fail('failed-reverted-or-unconfirmed');
 const qty=numberOrNull(raw.tokenDelta),sol=numberOrNull(raw.solDelta);
 if(!qty||!sol||qty*sol>=0||r.createTx||!['pump','pumpswap','raydium-amm','raydium-cpmm','raydium-launchlab','meteora-dlmm'].includes(r.program))return fail('not-an-attributable-swap');
 if(!Array.isArray(r.changedAssets)||r.changedAssets.length!==1||r.changedAssets[0]!==raw.mint)return fail('ambiguous-multi-asset-cost-basis');
 const event={schema:CROWD_SCHEMA,venue:'solana',asset:String(raw.mint),wallet:String(raw.wallet),side:qty>0?'BUY':'SELL',quantity:Math.abs(qty),notional:Math.abs(sol),quoteCurrency:'SOL',price:Math.abs(sol/qty),
  transactionId:String(raw.signature),eventIndex:Number(raw.eventIndex||0),slot:numberOrNull(raw.slot),transactionOrder:null,sourceAt,firstObservedAt:observedAt,ingestedAt,confirmation:r.confirmation,
  provenance:{provider:String(raw.source||'indexer-rpc'),program:r.program,transactionVersion:r.transactionVersion??'unknown',accounting:'NET_SIGNER_BALANCE_DELTA_NOT_VERIFIED_FILL',allCostsKnown:false},
  decimals:Number.isInteger(r.tokenDecimals)?r.tokenDecimals:null,sourceFeeSol:numberOrNull(r.feeSol),relatedGroup:r.relatedGroup||null,commonSignalId:r.commonSignalId||null};
 event.id=crowdHash([event.venue,event.transactionId,event.asset,event.wallet,event.eventIndex]);
 return {ok:true,event};
}
export function emptyCrowdCapture(now=Date.now()){
 return {schema:CROWD_SCHEMA,mode:'PAPER',liveExecutionAllowed:false,createdAt:now,updatedAt:now,sequence:0,events:[],windows:[],rejected:{},duplicates:0,conflicts:0,invalidatedIds:[],status:'OBSERVING',previousHash:null};
}
export function appendCrowdCapture(state,rawEvents=[],window=null,{now=Date.now()}={}){
 assertCrowdPaper(state);if(now<state.updatedAt)throw new Error('Crowd observation clock moved backwards');
 const ids=new Map(state.events.map(e=>[e.id,e]));
 for(const raw of rawEvents){
  if(state.events.length>=CROWD_LIMITS.events){state.status='EVENT_BUDGET_SPENT';break;}
  const n=normalizeCrowdEvent(raw,{now});if(!n.ok){state.rejected[n.reason]=(state.rejected[n.reason]||0)+1;continue;}
  const e=n.event,prior=ids.get(e.id);
  if(prior){
   // A reconnect may change receipt time, not identity, source time or economics.
   const economic=x=>crowdHash([x.asset,x.wallet,x.side,x.quantity,x.notional,x.sourceAt,x.slot]);
   if(economic(prior)!==economic(e)){state.conflicts++;if(!state.invalidatedIds.includes(e.id))state.invalidatedIds.push(e.id);state.status='INTEGRITY_BLOCKED';}
   else state.duplicates++;
   continue;
  }
  state.events.push(e);ids.set(e.id,e);state.sequence++;
 }
 if(window){
  const w={asset:window.mint,fromTs:numberOrNull(window.fromTs),toTs:numberOrNull(window.toTs),observedAt:window.finishedAt||now,scope:window.scope||'UNKNOWN',complete:window.complete===true,
   commitment:window.commitment||'unknown',gaps:window.gaps||[],backlog:window.backlog??null};
  if(state.windows.length<CROWD_LIMITS.windows)state.windows.push(w);else state.windowBudgetSpent=true;
 }
 state.updatedAt=now;return state;
}
export function episodeCoverage(windows,asset,fromTs,toTs,asOf){
 const rows=windows.filter(w=>w.asset===asset&&w.scope==='ASSET_MINT_REFERENCES'&&w.complete&&w.commitment==='finalized'&&w.observedAt<=asOf&&w.gaps?.length===0&&w.fromTs<=toTs&&w.toTs>=fromTs).sort((a,b)=>a.fromTs-b.fromTs);
 let end=fromTs;for(const w of rows){if(w.fromTs>end)break;if(w.toTs>=end)end=w.toTs;if(end>=toTs)return {ok:true,scope:'SELECTED_MINT_REFERENCE_INTERVAL',watcherCount:null};}
 return {ok:false,reason:'INSUFFICIENT_COVERAGE',scope:'BOUNDED_MINT_REFERENCES',watcherCount:null};
}
export function crowdPhase(protocol,at){
 if(at<protocol.train.end)return 'TRAIN';if(at<protocol.validation.start)return 'EMBARGO';if(at<protocol.validation.end)return 'VALIDATION';
 if(at<protocol.holdout.start)return 'EMBARGO';return at<protocol.holdout.end?'HOLDOUT':'SEALED';
}
export function crowdControl(input={},prior={mode:'SHADOW_COMPARISON',budgetSol:.15},now=Date.now()){
 const mode=input.mode??prior.mode;if(!CROWD_MODES.includes(mode))throw new Error('Unknown crowd mode');
 const budget=numberOrNull(input.budgetSol??prior.budgetSol);if(!(budget>=.001&&budget<=1))throw new Error('Experimental capital must be 0.001 to 1 paper SOL');
 if(mode==='PAPER_EXPERIMENT'&&prior.mode!==mode&&input.confirmation!=='START ISOLATED PAPER EXPERIMENT')throw new Error('Explicit isolated-paper confirmation required');
 return {schema:CROWD_SCHEMA,mode,budgetSol:budget,updatedAt:now,liveExecutionAllowed:false};
}
export const CROWD_CAPABILITIES=Object.freeze([
 {venue:'Solana / Pump.fun',publicIdentity:'SIGNING_WALLETS',aggregate:'MINT_REFERENCE_TRANSACTIONS',configured:'BOUNDED_FINALIZED_RPC',coverage:'PER_INTERVAL_ONLY',reversal:'NO_SPOT_SHORT',status:'FIRST_SLICE'},
 {venue:'PumpPortal',publicIdentity:'ACCOUNT_TRADE_STREAM',aggregate:'TOKEN_TRADE_STREAM',configured:'NOT_ADDED',coverage:'METERED_STREAM_NOT_AUTHORIZED',status:'NO_NEW_PAID_SUBSCRIPTIONS'},
 {venue:'Polymarket international',publicIdentity:'DATA_API_PROXY_WALLET',aggregate:'PUBLIC_TRADES_AND_BOOK',configured:'EXISTING_ANONYMOUS_BOOK_CAPTURE_ONLY',coverage:'NO_CROWD_ADAPTER',status:'NOT_IMPLEMENTED'},
 {venue:'Polymarket US',publicIdentity:'NOT_VERIFIED',aggregate:'PUBLIC_MARKET_DATA',configured:'EXISTING_US_EVIDENCE',coverage:'NO_IDENTIFIABLE_FOLLOWER_FEED_VERIFIED',status:'UNSUPPORTED_FOR_WALLET_INFERENCE'},
 {venue:'Kalshi',publicIdentity:'NOT_IN_PUBLIC_TRADE_RESPONSE',aggregate:'PUBLIC_TRADES_AND_BOOK',configured:'EXISTING_PAPER_MODULE',coverage:'ANONYMOUS_PUBLIC_OR_OWN_ACCOUNT_ONLY',status:'UNSUPPORTED_FOR_WALLET_INFERENCE'},
 {venue:'Robinhood',publicIdentity:'NOT_VERIFIED',aggregate:'EXISTING_QUOTES',configured:'EXISTING_PAPER_MODULE',coverage:'NO_PUBLIC_OTHER_ACCOUNT_IDENTITY_VERIFIED',status:'UNSUPPORTED_FOR_WALLET_INFERENCE'}
]);