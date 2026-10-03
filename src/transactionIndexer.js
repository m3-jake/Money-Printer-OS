import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { cfg } from './config.js';
import { connection } from './rpc.js';
import { withTimeout, sleep } from './utils.js';
import { createMarketRequester } from './marketRequests.js';
import { configureApiSpendPolicy } from './apiUnitEconomics.js';
import { upsertTxEvent, alphaDb, alphaTransaction } from './alphaDb.js';
import { scoreWallets, MIN_GRADED_ROUND_TRIPS } from './walletScorecard.js';

configureApiSpendPolicy({dailySpendCapUsd:cfg.apiDailySpendCapUsd,roiValueUsd:cfg.apiResearchValueUsd,roiMinRoi:cfg.apiRoiGuardMinRoi});

// The Helius limiter used to default to 0 (= unlimited). A missing or 0 setting now means 10/min.
const heliusRequests=createMarketRequester({timeoutMs:7000,requestsPerMinute:cfg.heliusRequestsPerMinute>0?cfg.heliusRequestsPerMinute:10});
export function transactionIndexerHealth(){return {helius:heliusRequests.health(),credits:creditLedger().health()}}

export const WSOL_MINT='So11111111111111111111111111111111111111112';
const PROGRAMS={
 '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P':'pump','pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':'pumpswap',
 '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':'raydium-amm','CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C':'raydium-cpmm',
 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj':'raydium-launchlab','LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo':'meteora-dlmm',
};
const keyStr=k=>typeof k==='string'?k:(k?.pubkey?.toBase58?.()||(typeof k?.pubkey==='string'?k.pubkey:'')||k?.toBase58?.()||'');
const uiAmt=u=>{if(u?.amount!=null&&u?.decimals!=null)return Number(u.amount)/10**Number(u.decimals);return Number(u?.uiAmountString??u?.uiAmount??0)};
function programTag(tx){
 const ids=new Set();for(const ix of tx?.transaction?.message?.instructions||[])ids.add(keyStr(ix.programId));
 for(const g of tx?.meta?.innerInstructions||[])for(const ix of g.instructions||[])ids.add(keyStr(ix.programId));
 const venues=[...ids].map(id=>PROGRAMS[id]).filter(Boolean);const router=[...ids].some(id=>id.startsWith('JUP'))?'jupiter':null;
 return {program:venues[0]||router||'other',router};
}

// One event per SIGNER whose balance of `mint` changed. Pool, bonding-curve and authority accounts are PDAs and
// cannot sign, so they never become wallets. SOL per swap = the wallet's lamport change plus the lamport change of
// every token account it owns. That counts wrapped SOL (a WSOL account's lamports move with its balance) and nets
// out ATA rent (the rent leaves the wallet and lands in its own new token account). The fee is added back and kept
// separately in raw.feeSol, so solDelta is the swap amount and the scorecard charges the fee explicitly.
export function parseSwapEvents(tx,mint,{signature='',source='indexer-rpc'}={}){
 if(!tx||tx.meta?.err)return[];
 const keys=(tx.transaction?.message?.accountKeys||[]).map(k=>({key:keyStr(k),signer:!!k?.signer}));
 const pre=tx.meta?.preBalances||[],post=tx.meta?.postBalances||[],lam=i=>Number(post[i]||0)-Number(pre[i]||0);
 const feePayer=keys[0]?.key||'',feeLamports=Number(tx.meta?.fee||0);
 const accts=new Map();
 for(const [rows,side] of [[tx.meta?.preTokenBalances||[],'pre'],[tx.meta?.postTokenBalances||[],'post']])for(const r of rows){
  const a=accts.get(r.accountIndex)||{owner:'',mint:r.mint,pre:0,post:0};a[side]=uiAmt(r.uiTokenAmount);a.owner||=r.owner||'';accts.set(r.accountIndex,a);
 }
 const byOwner=new Map();
 for(const [i,a] of accts){if(!a.owner)continue;const o=byOwner.get(a.owner)||{token:0,wsol:0,acctLamports:0,rentLamports:0,mintAccounts:[]};
  if(a.mint===mint){o.token+=a.post-a.pre;if(keys[i]?.key)o.mintAccounts.push(keys[i].key)}if(a.mint===WSOL_MINT)o.wsol+=a.post-a.pre;else o.rentLamports+=lam(i);o.acctLamports+=lam(i);byOwner.set(a.owner,o)}
 const ts=Number(tx.blockTime||0)*1000,slot=Number(tx.slot||0),sig=signature||tx.transaction?.signatures?.[0]||'';
 const {program,router}=programTag(tx),mi=keys.findIndex(k=>k.key===mint),createTx=mi>=0&&Number(pre[mi]||0)===0&&Number(post[mi]||0)>0;
 const out=[];let idx=0;
 for(const [owner,o] of byOwner){
  if(Math.abs(o.token)<=1e-12)continue;const ki=keys.findIndex(k=>k.key===owner);if(ki<0||!keys[ki].signer)continue;
  const payer=owner===feePayer,feeSol=payer?feeLamports/1e9:0;
  out.push({signature:sig,eventIndex:idx++,ts,slot,mint,wallet:owner,side:o.token>0?'BUY':'SELL',tokenDelta:o.token,
   solDelta:(lam(ki)+o.acctLamports+(payer?feeLamports:0))/1e9,source,
   // tokenAccount: the signer's own account for this mint (exactly one), used for cheap wallet follow-up reads.
   raw:{signer:true,feePayer:payer,program,router,lamportDelta:lam(ki)/1e9,wsolDelta:o.wsol,rentSol:o.rentLamports/1e9,feeSol,createTx,tokenAccount:o.mintAccounts.length===1?o.mintAccounts[0]:null}});
 }
 return out;
}

// Helius enhanced transactions name only the fee payer, so that is the only wallet we trust there. SOL comes from
// accountData (native change of the payer plus its token accounts, fee added back), never a hard-coded 0.
export function parseEnhancedSwapEvents(tx,mint){
 const payer=tx?.feePayer||'',ad=tx?.accountData;if(!payer||tx.transactionError||!Array.isArray(ad))return[];
 let token=0,wsol=0,own=0;const owned=new Set();
 for(const a of ad)for(const b of a.tokenBalanceChanges||[]){if(b.userAccount!==payer)continue;owned.add(b.tokenAccount);const amt=Number(b.rawTokenAmount?.tokenAmount||0)/10**Number(b.rawTokenAmount?.decimals||0);if(b.mint===mint)token+=amt;if(b.mint===WSOL_MINT)wsol+=amt}
 if(Math.abs(token)<=1e-12)return[];
 for(const a of ad)if(a.account===payer||owned.has(a.account))own+=Number(a.nativeBalanceChange||0);
 const fee=Number(tx.fee||0);
 return[{signature:tx.signature,eventIndex:0,ts:Number(tx.timestamp||0)*1000,slot:tx.slot||0,mint,wallet:payer,side:token>0?'BUY':'SELL',tokenDelta:token,solDelta:(own+fee)/1e9,source:'helius',
  raw:{signer:true,feePayer:true,program:String(tx.source||'other').toLowerCase(),type:tx.type,wsolDelta:wsol,feeSol:fee/1e9}}];
}

// ---------- Daily credit ledger ----------
// One ledger file on disk, shared by every index path and process (lean indexer, alpha worker, enhanced API),
// so the cap survives restarts (unlike the in-memory holder counter in rpc.js).
export const HELIUS_FREE_MONTHLY_CREDITS=1_000_000;
// The default fits the Helius free plan next to the holder lookups: a 31-day month of free credits minus the whole
// holder daily cap (HOLDER_RPC_DAILY_CALLS, 25,000 by default) = 32,258 - 25,000 = 7,258 credits a day.
export function defaultIndexerDailyCredits(holderDailyCalls=cfg.holderRpcDailyCalls){const holder=Number(holderDailyCalls)>0?Number(holderDailyCalls):25000;return Math.max(0,Math.floor(HELIUS_FREE_MONTHLY_CREDITS/31)-holder)}
const dataDir=()=>path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
const envNum=(env,k,d)=>{const v=env[k];if(v===undefined||String(v).trim()==='')return d;const n=Number(v);return Number.isFinite(n)&&n>=0?n:d};
export function indexerConfig(env=process.env){
 const url=String(env.INDEXER_RPC_URL||env.HOLDER_RPC_URL||cfg.holderRpcUrl||cfg.rpcUrl||'').trim();
 return {enabled:!/^(0|false|off|no)$/i.test(String(env.WALLET_INDEXER_ENABLED??'true').trim()),url,
  provider:(()=>{try{return new URL(url).host}catch{return 'unknown'}})(),dedicated:!!String(env.INDEXER_RPC_URL||'').trim(),
  dailyCredits:Math.floor(envNum(env,'INDEXER_DAILY_CREDITS',defaultIndexerDailyCredits())),creditsPerCall:Math.max(1,envNum(env,'INDEXER_CREDITS_PER_CALL',1)),
  enhancedCredits:Math.max(1,envNum(env,'HELIUS_ENHANCED_CREDITS',100)),requestsPerMinute:Math.max(1,envNum(env,'INDEXER_REQUESTS_PER_MINUTE',20)),
  minEdge:envNum(env,'INDEXER_MIN_EDGE',cfg.alphaTxMinEdge??45),maxMints:Math.max(1,envNum(env,'INDEXER_MAX_MINTS',12)),trackMs:envNum(env,'INDEXER_TRACK_HOURS',6)*3600_000,
  repullMs:envNum(env,'INDEXER_REPULL_MIN',5)*60_000,txPerPull:Math.max(1,envNum(env,'INDEXER_TX_PER_PULL',25)),sigPages:Math.max(1,envNum(env,'INDEXER_SIG_PAGES',3)),
  scoreMs:envNum(env,'INDEXER_SCORE_MIN',10)*60_000,scoreWindowMs:envNum(env,'INDEXER_SCORE_DAYS',30)*86400_000,
  // Allocation inside the same paced daily credit cap (none of these raise spend): durable per-mint signature
  // backlog, adaptive re-listing backoff, and wallet token-account follow-ups that look for the exits of captured buys.
  backlogCap:Math.max(25,envNum(env,'INDEXER_BACKLOG_CAP',256)),followupQueue:Math.max(0,envNum(env,'INDEXER_FOLLOWUP_QUEUE',128)),
  followupTxPerTick:Math.max(1,envNum(env,'INDEXER_FOLLOWUP_TX',5)),followupRepullMs:envNum(env,'INDEXER_FOLLOWUP_REPULL_MIN',10)*60_000,
  followupMinAgeMs:envNum(env,'INDEXER_FOLLOWUP_MIN_AGE_SEC',120)*1000,followupMaxAttempts:Math.max(1,envNum(env,'INDEXER_FOLLOWUP_ATTEMPTS',6)),
  followupMaxAgeMs:envNum(env,'INDEXER_FOLLOWUP_MAX_HOURS',24)*3600_000};
}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
function writeJson(file,obj){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(obj));try{fs.renameSync(tmp,file)}catch{try{fs.copyFileSync(tmp,file);fs.unlinkSync(tmp)}catch{}}}
const redact=m=>String(m?.message||m).replace(/api-key=[^&\s"']+/gi,'api-key=<redacted>').replace(/(https?:\/\/[^/\s]+)\/[^\s"']*/g,'$1/...').slice(0,200);
export function creditLedger({file=path.join(dataDir(),'wallet-indexer-budget.json'),env=process.env,now=Date.now}={}){
 const c=indexerConfig(env);
 const load=()=>{const d=new Date(now()).toISOString().slice(0,10),s=readJson(file,{});return s.day===d?s:{day:d,credits:0,calls:0,byPath:{},budgetSkips:0,paceSkips:0}};
 return {
  // pace=true also spreads spend over the UTC day: never more than cap x (hours elapsed + 1) / 24.
  // detail is cost attribution only (e.g. mint:getTransaction, followup:getSignaturesForAddress); the cap is shared.
  charge(credits,{purpose='index',pace=false,detail=null}={}){
   const s=load(),t=now(),cap=c.dailyCredits;
   if(s.credits+credits>cap){s.budgetSkips++;writeJson(file,s);return {ok:false,reason:'BUDGET'}}
   const dayMs=t-Date.parse(`${s.day}T00:00:00Z`);
   if(pace&&s.credits+credits>cap*Math.min(1,(dayMs+3600_000)/86400_000)){s.paceSkips++;writeJson(file,s);return {ok:false,reason:'PACING'}}
   s.credits+=credits;s.calls++;s.byPath[purpose]=(s.byPath[purpose]||0)+credits;if(detail){s.byDetail||={};s.byDetail[detail]=(s.byDetail[detail]||0)+credits}writeJson(file,s);return {ok:true};
  },
  health(){const s=load();return {day:s.day,credits:s.credits,calls:s.calls,dailyCredits:c.dailyCredits,remaining:Math.max(0,c.dailyCredits-s.credits),byPath:s.byPath,byDetail:s.byDetail||{},budgetSkips:s.budgetSkips,paceSkips:s.paceSkips,creditsPerCall:c.creditsPerCall}},
 };
}

// ---------- Legacy index paths (alpha worker only; it is off by default) ----------
async function customFeed(mint,limit){if(!cfg.txFeedUrl)return null;const u=new URL(cfg.txFeedUrl);u.searchParams.set('mint',mint);u.searchParams.set('limit',String(limit));const h=cfg.txFeedToken?{authorization:`Bearer ${cfg.txFeedToken}`}:{},r=await withTimeout(fetch(u,{headers:h}),7000,'custom transaction feed');if(!r.ok)throw new Error(`TX feed ${r.status}`);const j=await r.json(),rows=Array.isArray(j)?j:(j.events||[]),counts=new Map();return rows.map((e,i)=>{const sig=String(e.signature||`custom-${e.ts||Date.now()}-${i}`),n=counts.get(sig)||0;counts.set(sig,n+1);return{...e,signature:sig,eventIndex:Number.isInteger(e.eventIndex)?e.eventIndex:n,mint:e.mint||mint,source:e.source||'custom-feed'}})}

// The enhanced endpoint costs 100 credits a call, so every call is charged to the daily ledger first.
function chargeEnhanced(purpose){const c=indexerConfig();if(!creditLedger().charge(c.enhancedCredits,{purpose}).ok)throw new Error('Helius daily credit cap reached')}
async function helius(mint,limit){
 if(!cfg.heliusApiKey)return null;
 chargeEnhanced('enhanced-mint');
 const u=`https://api.helius.xyz/v0/addresses/${encodeURIComponent(mint)}/transactions?api-key=${encodeURIComponent(cfg.heliusApiKey)}&limit=${Math.min(100,limit)}`;
 const {data:rows}=await heliusRequests.get(u,'Helius enhanced transactions',{ttlMs:0,costPerRequestUsd:cfg.heliusCostPerRequestUsd,purpose:'index'});const events=[];
 for(const tx of rows||[]){
  events.push(...parseEnhancedSwapEvents(tx,mint));
  for(const nt of tx.nativeTransfers||[]){if(nt.fromUserAccount&&nt.toUserAccount)events.push({funding:true,funder:nt.fromUserAccount,wallet:nt.toUserAccount,ts:Number(tx.timestamp||0)*1000,sol:Number(nt.amount||0)/1e9,signature:tx.signature})}
 }
 return events;
}
async function publicRpc(mint,limit){
 const c=connection(),led=creditLedger(),per=indexerConfig().creditsPerCall;
 if(!led.charge(per,{purpose:'public-rpc'}).ok)throw new Error('indexer daily credit cap reached');
 const sigs=await withTimeout(c.getSignaturesForAddress(new PublicKey(mint),{limit:Math.min(100,limit)},'confirmed'),7000,'signature history');
 const txs=await Promise.all(sigs.map(x=>led.charge(per,{purpose:'public-rpc'}).ok?withTimeout(c.getParsedTransaction(x.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0}),7000,'parsed transaction').catch(()=>null):null));
 const out=[];for(let i=0;i<txs.length;i++){if(!txs[i])continue;for(const e of parseSwapEvents(txs[i],mint,{signature:sigs[i].signature,source:'public-rpc'}))out.push({...e,ts:e.ts||Number(sigs[i].blockTime||0)*1000,slot:e.slot||sigs[i].slot||0})}
 return out;
}
export async function indexMintTransactions(mint,limit=50){try{return await customFeed(mint,limit) || await helius(mint,limit) || await publicRpc(mint,limit)}catch(e){return {error:redact(e),events:[]}}}

export async function indexWalletFunding(wallet,beforeTs=Date.now(),limit=30){
 if(!cfg.heliusApiKey||!wallet)return[];
 try{chargeEnhanced('enhanced-funding');const u=`https://api.helius.xyz/v0/addresses/${encodeURIComponent(wallet)}/transactions?api-key=${encodeURIComponent(cfg.heliusApiKey)}&limit=${Math.min(100,limit)}`;const {data:rows}=await heliusRequests.get(u,'Helius wallet funding',{ttlMs:0,costPerRequestUsd:cfg.heliusCostPerRequestUsd,purpose:'index'}),out=[];for(const tx of rows){const ts=Number(tx.timestamp||0)*1000;if(ts>beforeTs)continue;for(const nt of tx.nativeTransfers||[]){if(nt.toUserAccount===wallet&&nt.fromUserAccount&&nt.fromUserAccount!==wallet)out.push({funder:nt.fromUserAccount,wallet,ts,sol:Number(nt.amount||0)/1e9,signature:tx.signature})}}return out}catch{return[]}
}

// ---------- Lean wallet indexer (runs in the research collector; WALLET_INDEXER_ENABLED=false kills it) ----------
// Standard JSON-RPC only (getSignaturesForAddress + getTransaction, 1 credit each on Helius), never the enhanced
// endpoint and never HELIUS_API_KEY. It walks each tracked mint's history oldest-first from a saved cursor, so early
// buyers are not lost to a newest-40 window, and every call is charged to the daily ledger before it is sent.
class BudgetStop extends Error{}
// detail tags each charged call for cost attribution (mint scan vs wallet follow-up, per RPC method).
function rpcCaller(c,{ledger,fetcher=(...a)=>globalThis.fetch(...a),wait=sleep,now=Date.now,detail='mint'}){
 let id=0,nextAt=0;const gap=60000/c.requestsPerMinute;
 return async(method,params)=>{
  const r=ledger.charge(c.creditsPerCall,{purpose:'lean-indexer',pace:true,detail:`${detail}:${method}`});if(!r.ok)throw new BudgetStop(r.reason);
  const t=now(),delay=Math.max(0,nextAt-t);nextAt=Math.max(t,nextAt)+gap;if(delay)await wait(delay);
  const res=await withTimeout(fetcher(c.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})}),9000,`indexer ${method}`);
  if(!res.ok)throw new Error(`indexer ${method} HTTP ${res.status}`);
  const j=await res.json();if(j.error)throw new Error(`indexer ${method}: ${j.error.message||j.error.code}`);return j.result;
 };
}
const forwardRaw=(e,tx,mint,observedAt,provenance)=>({...e.raw,firstObservedAt:observedAt,ingestedAt:observedAt,confirmation:'finalized',transactionVersion:tx.version??'legacy',observationProvenance:provenance,
 tokenDecimals:[...(tx.meta?.postTokenBalances||[]),...(tx.meta?.preTokenBalances||[])].find(b=>b.mint===mint)?.uiTokenAmount?.decimals??null,changedAssets:[...new Set([...(tx.meta?.preTokenBalances||[]),...(tx.meta?.postTokenBalances||[])].filter(b=>b.owner===e.wallet&&b.mint!==WSOL_MINT).map(b=>b.mint))]});
// Finalized JSON-parsed transactions support legacy, v0 and v1 without deserializing/signing.
// Emit each successful transaction before the next RPC: a later budget/error cannot lose it.
// Signatures are listed once into a durable, bounded backlog (m.backlog, oldest first, contiguous from m.cursorSig) and
// drained across later pulls. Re-listing the same pages on every pull used to spend most of the paced budget.
export async function pullMint(m,{call,c,now=Date.now,onEvents=()=>{}}){
 const startedAt=now(),cap=Math.max(1,c.backlogCap||256);m.backlog=Array.isArray(m.backlog)?m.backlog:[];
 const batch=m.lastBatch={mint:m.mint,startedAt,finishedAt:null,scope:'ASSET_MINT_REFERENCES',commitment:'finalized',complete:false,backlog:0,gaps:[],signatures:0,fetched:0,listed:false};
 try {
  if(!m.backlog.length){
   const sigs=[];let before=null,reached=false;const oldCursor=m.cursorSig;
   for(let p=0;p<c.sigPages;p++){
    const page=await call('getSignaturesForAddress',[m.mint,{limit:1000,commitment:'finalized',...(oldCursor?{until:oldCursor}:{}),...(before?{before}:{})}])||[];
    sigs.push(...page);if(page.length<1000){reached=true;break}before=page.at(-1).signature;
   }
   const ordered=[...new Map(sigs.map(x=>[x.signature,x])).values()].reverse(),oldest=ordered[0],gaps=[];
   if(!oldCursor&&oldest){m.firstTs=Number(oldest.blockTime||0)*1000;m.historyComplete=reached;}
   if(!reached){m.gaps=(m.gaps||0)+1;m.firstGapTs||=Number(oldest?.blockTime||0)*1000;gaps.push('pagination-window-incomplete');batch.gaps.push('pagination-window-incomplete');}
   // Trimming keeps the oldest contiguous part; the newer remainder is listed again (until=cursor) once drained.
   m.backlog=ordered.slice(0,cap).map(x=>[x.signature,Number(x.blockTime||0),x.err?1:0]);
   m.listing={listedAt:startedAt,reached,trimmed:ordered.length>cap,signatures:ordered.length,fromTs:Number(oldest?.blockTime||0)*1000,toTs:Number(ordered.at(-1)?.blockTime||0)*1000,gaps};
   m.lastListAt=startedAt;m.listings=(m.listings||0)+1;m.emptyListings=ordered.length?0:(m.emptyListings||0)+1;batch.listed=true;
  }
  const listing=m.listing||{reached:false,trimmed:false,signatures:m.backlog.length,gaps:[]};listing.gaps||=[];
  batch.signatures=listing.signatures;batch.fromTs=listing.fromTs;batch.toTs=listing.toTs;batch.backlog=m.backlog.length;
  const events=[];
  for(let i=0;i<c.txPerPull&&m.backlog.length;i++){
   const [sig,blockTime,failed]=m.backlog[0];
   if(failed){batch.failed=(batch.failed||0)+1;m.cursorSig=sig;m.backlog.shift();batch.backlog=m.backlog.length;continue;}
   const tx=await call('getTransaction',[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized'}]);
   if(!tx){batch.gaps.push('transaction-unavailable-retry');m.nullRetries=m.nullRetries?.signature===sig?{signature:sig,count:m.nullRetries.count+1}:{signature:sig,count:1};if(m.nullRetries.count>=3){m.gaps=(m.gaps||0)+1;m.firstGapTs||=Number(blockTime||0)*1000;batch.gaps.push('quarantined-after-three-unavailable-reads');listing.gaps.push('quarantined-after-three-unavailable-reads');m.cursorSig=sig;m.backlog.shift();batch.backlog=m.backlog.length;m.nullRetries=null;continue;}break;}
   if(!['legacy',0,1,undefined].includes(tx.version)){batch.gaps.push('unsupported-transaction-version');break;}
   const observedAt=now();
   const rows=parseSwapEvents(tx,m.mint,{signature:sig}).map(e=>({...e,ts:e.ts||Number(blockTime||0)*1000,raw:forwardRaw(e,tx,m.mint,observedAt,'lean-indexer-forward-receipt')}));
   onEvents(rows);events.push(...rows);m.cursorSig=sig;m.nullRetries=null;m.backlog.shift();batch.fetched++;batch.backlog=m.backlog.length;
   m.txFetched=(m.txFetched||0)+1;m.events=(m.events||0)+rows.length;
  }
  // Complete only when the whole listed interval was reached, kept, drained and gap-free.
  batch.complete=listing.reached&&!listing.trimmed&&m.backlog.length===0&&listing.gaps.length===0&&batch.gaps.length===0;
  // This is only a bounded mint-reference interval, NOT all holders, all pools or all followers.
  return events;
 } catch(error){batch.gaps.push(error instanceof BudgetStop?'budget-or-pacing-stop':'rpc-or-parser-error');throw error;}
 finally {batch.finishedAt=now();batch.elapsedMs=batch.finishedAt-startedAt;batch.cursor=m.cursorSig;batch.backlog=m.backlog.length;}
}
function trackMints(st,watch,c,t){
 for(const x of Object.values(st.mints))if(!x.retired&&t-x.addedAt>c.trackMs)x.retired=true;
 for(const x of Object.values(st.mints))if(x.retired&&x.backlog){x.retiredBacklog=x.backlog.length;delete x.backlog;}
 const old=Object.values(st.mints).filter(x=>x.retired).sort((a,b)=>a.addedAt-b.addedAt);for(const x of old.slice(0,Math.max(0,old.length-2000)))delete st.mints[x.mint];
 const active=Object.values(st.mints).filter(x=>!x.retired).length;
 const fresh=(Array.isArray(watch)?watch:[]).filter(a=>a?.mint&&!st.mints[a.mint]&&Number(a.fastEdgeScore??a.score??0)>=c.minEdge).sort((a,b)=>Number(b.fastEdgeScore??b.score??0)-Number(a.fastEdgeScore??a.score??0));
 for(const a of fresh.slice(0,Math.max(0,c.maxMints-active)))st.mints[a.mint]={mint:a.mint,symbol:a.symbol||'',addedAt:t,lastPullAt:0,pulls:0,txFetched:0,events:0,cursorSig:null,historyComplete:false,firstTs:null,firstGapTs:null,gaps:0};
}
// Adaptive mint sampling inside the paced budget: a mint needs work when its durable backlog is non-empty or a new
// listing is due. Listings that return nothing back off (5, 10, 20, 40, 80 min). Smaller backlogs drain first so
// intervals actually complete; any mint waiting four repull periods is served first so busy mints stay sampled.
export function listDueAt(m,c){return (m.lastListAt||m.lastPullAt||0)+c.repullMs*2**Math.min(4,m.emptyListings||0)}
export function chooseMint(mints,c,t){
 const work=Object.values(mints).filter(x=>!x.retired&&(x.backlog?.length>0||t>=listDueAt(x,c)));
 const starving=work.filter(x=>t-(x.lastPullAt||0)>=4*c.repullMs).sort((a,b)=>(a.lastPullAt||0)-(b.lastPullAt||0))[0];
 return starving||work.sort((a,b)=>(a.backlog?.length||0)-(b.backlog?.length||0)||(a.lastPullAt||0)-(b.lastPullAt||0))[0]||null;
}
// ---------- Wallet follow-up (exits of captured buys) ----------
// A captured BUY whose SELL was never captured becomes an unmatched or open position and cannot grade the wallet.
// The signer's own token account for that mint has a short, wallet-specific history, so one listing (1 credit) plus
// a few transactions finds its exits without walking thousands of mint references. Only the followed wallet's rows
// are kept; follow-up rows are NOT crowd-capture coverage windows and are never sent to the crowd study.
const followKey=(wallet,mint)=>`${wallet}:${mint}`;
export function noteFollowupEvents(st,events,c,{ranks=new Map(),now=Date.now()}={}){
 if(!c.followupQueue)return;st.followups||={};const fu=st.followups,stats=st.followupStats||={created:0,closed:0,expired:0,dropped:0,sellsFound:0};
 for(const e of events){
  const k=followKey(e.wallet,e.mint);let f=fu[k];const qty=Math.abs(Number(e.tokenDelta)||0);
  // A closed/expired collection slot must not suppress a later observed re-entry.
  // This rotates only the bounded collection task; historical events/books are retained.
  if(f&&f.status!=='OPEN'&&e.side==='BUY'&&e.raw?.tokenAccount&&Number(e.ts)>f.buyTs){delete fu[k];f=null;}
  if(f){if(e.side==='SELL'){f.soldQty+=qty;if(f.soldQty>=.99*f.boughtQty&&f.status==='OPEN'){f.status='CLOSED';f.closedAt=now;stats.closed++;}}else if(e.side==='BUY'&&f.status==='OPEN')f.boughtQty+=qty;continue;}
  if(e.side!=='BUY'||!e.raw?.tokenAccount||!(qty>0))continue;
  fu[k]={wallet:e.wallet,mint:e.mint,tokenAccount:e.raw.tokenAccount,untilSig:e.signature,buyTs:Number(e.ts)||now,boughtQty:qty,soldQty:0,
   priority:Number(ranks.get(e.wallet)||0),createdAt:now,lastAt:0,attempts:0,pending:[],gaps:0,sellsFound:0,status:'OPEN'};stats.created++;
 }
 // Bounded queue: closed/expired leave first, then the lowest-priority, newest open records.
 const rows=Object.entries(fu);
 for(const [k,f] of rows)if(f.status!=='OPEN'&&now-(f.closedAt||f.lastAt||f.createdAt)>3600_000)delete fu[k];
 const open=Object.entries(fu).filter(([,f])=>f.status==='OPEN').sort(([,a],[,b])=>b.priority-a.priority||a.buyTs-b.buyTs);
 for(const [k] of open.slice(c.followupQueue)){delete fu[k];stats.dropped++;}
}
export function chooseFollowup(st,c,t){
 const fu=st.followups||{},stats=st.followupStats||={created:0,closed:0,expired:0,dropped:0,sellsFound:0};
 for(const f of Object.values(fu))if(f.status==='OPEN'&&!f.pending.length&&(f.attempts>=c.followupMaxAttempts||t-f.buyTs>c.followupMaxAgeMs)){f.status='EXPIRED';f.closedAt=t;stats.expired++;}
 return Object.values(fu).filter(f=>f.status==='OPEN'&&(f.pending.length>0||t-f.buyTs>=c.followupMinAgeMs&&t-(f.lastAt||0)>=c.followupRepullMs))
  .sort((a,b)=>b.priority-a.priority||(b.pending.length>0)-(a.pending.length>0)||a.buyTs-b.buyTs)[0]||null;
}
export async function pullFollowup(f,{call,c,now=Date.now,known=()=>false,onEvents=()=>{}}){
 const t=now(),rows=[];
 if(!f.pending.length){
  // attempts/lastAt advance only after a listing was actually read (a budget stop costs nothing and retries).
  const sigs=await call('getSignaturesForAddress',[f.tokenAccount,{limit:100,commitment:'finalized',until:f.untilSig}])||[];
  f.attempts++;f.lastAt=t;
  if(sigs.length>=100)f.gaps++;
  f.pending=[...new Map(sigs.map(x=>[x.signature,x])).values()].reverse().map(x=>[x.signature,Number(x.blockTime||0),x.err?1:0]);
 }
 for(let fetched=0;f.pending.length&&fetched<c.followupTxPerTick;){
  const [sig,blockTime,failed]=f.pending[0];
  if(failed||known(sig)){f.pending.shift();f.untilSig=sig;continue;}
  const tx=await call('getTransaction',[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized'}]);fetched++;
  if(!tx){f.nullReads=(f.nullReads||0)+1;if(f.nullReads>=3){f.pending.shift();f.untilSig=sig;f.nullReads=0;f.gaps++;continue;}break;}
  if(!['legacy',0,1,undefined].includes(tx.version)){f.pending.shift();f.untilSig=sig;f.gaps++;continue;}
  const observedAt=now();
  const ev=parseSwapEvents(tx,f.mint,{signature:sig}).filter(e=>e.wallet===f.wallet).map(e=>({...e,ts:e.ts||blockTime*1000,raw:forwardRaw(e,tx,f.mint,observedAt,'lean-indexer-wallet-followup')}));
  for(const e of ev)if(e.side==='SELL')f.sellsFound++;
  // Deliver each transaction before advancing its cursor. A later budget/network stop must not discard it.
  onEvents(ev);rows.push(...ev);f.pending.shift();f.untilSig=sig;f.nullReads=0;f.txFetched=(f.txFetched||0)+1;
 }
 return rows;
}
export function scoreIndexedWallets({now=Date.now(),c=indexerConfig(),mints={}}={}){
 const rows=alphaDb().prepare(`SELECT signature,event_index eventIndex,ts,slot,mint,wallet,side,token_delta tokenDelta,sol_delta solDelta,source,raw_json FROM tx_events WHERE ts>=? AND raw_json LIKE '%"signer":true%'`).all(now-c.scoreWindowMs);
 const events=rows.map(r=>{let raw={};try{raw=JSON.parse(r.raw_json||'{}')}catch{}return{...r,raw_json:undefined,signer:raw.signer===true,feeSol:Number(raw.feeSol||0)}});
 const mintMeta={};for(const m of Object.values(mints))mintMeta[m.mint]={historyComplete:!!m.historyComplete,firstGapTs:m.firstGapTs||null};
 return scoreWallets(events,{asOf:now,mintMeta,minTrips:MIN_GRADED_ROUND_TRIPS});
}
const knownSignature=(sig,wallet,mint)=>{try{return !!alphaDb().prepare('SELECT 1 FROM tx_events WHERE signature=? AND wallet=? AND mint=? LIMIT 1').get(sig,wallet,mint)}catch{return false}};
export async function walletIndexerTick({dir=dataDir(),env=process.env,now=Date.now,fetcher,wait,onEvents=null}={}){
 const c=indexerConfig(env),stateFile=path.join(dir,'wallet-indexer-state.json'),ledger=creditLedger({file:path.join(dir,'wallet-indexer-budget.json'),env,now});
 const st=readJson(stateFile,{})||{};st.mints||={};st.health||={};const t=now();
 const base={updatedAt:t,provider:c.provider,dedicated:c.dedicated,enabled:c.enabled,requestsPerMinute:c.requestsPerMinute,trackedMints:0,...ledger.health()};
 if(!c.enabled){st.health={...st.health,...base,status:'OFF'};writeJson(stateFile,st);return st.health}
 trackMints(st,readJson(path.join(dir,'state.json'),{})?.watchlist,c,t);
 const ranks=new Map((readJson(path.join(dir,'wallet-scorecard.json'),{})?.wallets||[]).map(w=>[w.wallet,Number(w.roundTrips)||0]));
 const day=new Date(t).toISOString().slice(0,10);if(st.yieldToday?.day!==day)st.yieldToday={day,mintTx:0,mintEvents:0,followupTx:0,followupEvents:0,followupSells:0,listings:0};
 // Alternate ticks between mint scanning and due follow-ups so neither starves; an idle kind yields its tick.
 st.workSeq=(st.workSeq||0)+1;
 const followup=c.followupQueue&&st.workSeq%2===1?chooseFollowup(st,c,t):null;
 const due=followup?null:chooseMint(st.mints,c,t),fallback=!followup&&!due&&c.followupQueue?chooseFollowup(st,c,t):null,work=followup||fallback;
 let status=st.health.status==='OFF'?'IDLE':(st.health.status||'IDLE'),lastError=st.health.lastError||null,added=0;
 const fail=e=>{if(e instanceof BudgetStop)status=e.message;else{status=/\b429\b|too many/i.test(String(e?.message))?'RATE_LIMITED':'ERROR';lastError=redact(e);st.health.lastErrorAt=now()}};
 if(due){
  const events=[];
  try{due.lastPullAt=t;due.pulls++;await pullMint(due,{call:rpcCaller(c,{ledger,fetcher,wait,now,detail:'mint'}),c,now,onEvents:rows=>events.push(...rows)});status=due.lastBatch?.complete?'OK':'PARTIAL';lastError=null;st.health.lastOkAt=now()}
  catch(e){fail(e)}
  // Events parsed before a stop are kept; the cursor only moved past transactions that were fetched.
  const fresh=[];if(events.length){alphaTransaction(()=>{for(const e of events)if(upsertTxEvent(e))fresh.push(e)});added=fresh.length}
  st.yieldToday.mintTx+=due.lastBatch?.fetched||0;st.yieldToday.mintEvents+=events.length;if(due.lastBatch?.listed)st.yieldToday.listings++;
  noteFollowupEvents(st,fresh,c,{ranks,now:t});
  if(typeof onEvents==='function')try{await onEvents(events,due.lastBatch)}catch(e){st.health.crowdCaptureError=redact(e);st.health.crowdCaptureGapAt=now()}
 }else if(work){
  const rows=[],beforeTx=work.txFetched||0;
  try{await pullFollowup(work,{call:rpcCaller(c,{ledger,fetcher,wait,now,detail:'followup'}),c,now,known:sig=>knownSignature(sig,work.wallet,work.mint),onEvents:ev=>rows.push(...ev)});status='OK';lastError=null;st.health.lastOkAt=now()}
  catch(e){fail(e)}
  const fresh=[];if(rows.length){alphaTransaction(()=>{for(const e of rows)if(upsertTxEvent(e))fresh.push(e)});added=fresh.length}
  st.yieldToday.followupTx+=(work.txFetched||0)-beforeTx;st.yieldToday.followupEvents+=rows.length;st.yieldToday.followupSells+=rows.filter(e=>e.side==='SELL').length;st.followupStats.sellsFound+=rows.filter(e=>e.side==='SELL').length;
  noteFollowupEvents(st,fresh,c,{ranks,now:t});
 }else status='IDLE';
 const today=st.health.day===base.day?st.health:{},fu=Object.values(st.followups||{});
 st.health={...st.health,...base,...ledger.health(),status,lastError,trackedMints:Object.values(st.mints).filter(x=>!x.retired).length,
  coverage:due?.lastBatch||st.health.coverage||null,eventsToday:Number(today.eventsToday||0)+added,lastPullMint:due?.mint||st.health.lastPullMint||null,
  backlog:Object.values(st.mints).filter(x=>!x.retired).reduce((n,x)=>n+(x.backlog?.length||0),0),yieldToday:st.yieldToday,
  followups:{open:fu.filter(f=>f.status==='OPEN').length,pendingTx:fu.reduce((n,f)=>n+(f.pending?.length||0),0),...(st.followupStats||{})},lastWork:due?'mint':work?'followup':'idle'};
 if(t-Number(st.lastScoreAt||0)>=c.scoreMs){
  st.lastScoreAt=t;
   try{const card=scoreIndexedWallets({now:t,c,mints:st.mints});writeJson(path.join(dir,'wallet-scorecard.json'),{schema:'mpo.wallet-scorecard.v1',asOf:t,summary:card.summary,wallets:card.wallets});st.health.lastScoreAt=t}
  catch(e){st.health.scoreError=redact(e)}
 }
 writeJson(stateFile,st);
 return st.health;
}
