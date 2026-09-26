import { PublicKey } from '@solana/web3.js';
import { cfg } from './config.js';
import { connection } from './rpc.js';
import { withTimeout } from './utils.js';
import { createMarketRequester } from './marketRequests.js';
import { configureApiSpendPolicy } from './apiUnitEconomics.js';

configureApiSpendPolicy({dailySpendCapUsd:cfg.apiDailySpendCapUsd,roiValueUsd:cfg.apiResearchValueUsd,roiMinRoi:cfg.apiRoiGuardMinRoi});

const heliusRequests=createMarketRequester({timeoutMs:7000,requestsPerMinute:cfg.heliusRequestsPerMinute});
// Enhanced-transaction calls cost ~100 Helius credits each and share the plan with HOLDER_RPC_URL, so they
// also have a per-UTC-day cap (HELIUS_DAILY_CALLS, default 100; 0 = no cap). Over the cap, mint indexing
// falls back to the public RPC and funding lookups return nothing.
const heliusDay={day:'',calls:0,skips:0};
function heliusBudget(){const d=new Date().toISOString().slice(0,10);if(heliusDay.day!==d){heliusDay.day=d;heliusDay.calls=0;heliusDay.skips=0}if(cfg.heliusDailyCalls>0&&heliusDay.calls>=cfg.heliusDailyCalls){heliusDay.skips++;return false}return true}
// Counts only requests that actually went out (the per-minute limiter may refuse one first).
async function heliusGet(url,label){const before=Number(heliusRequests.health().requests||0);try{return await heliusRequests.get(url,label,{ttlMs:0,costPerRequestUsd:cfg.heliusCostPerRequestUsd,purpose:'index'})}finally{heliusDay.calls+=Math.max(0,Number(heliusRequests.health().requests||0)-before)}}
export function transactionIndexerHealth(){return {helius:{...heliusRequests.health(),day:heliusDay.day||null,callsToday:heliusDay.calls,dailyCap:cfg.heliusDailyCalls,dailySkips:heliusDay.skips}}}
export const __testing={resetHeliusDay(){heliusDay.day='';heliusDay.calls=0;heliusDay.skips=0}};

function tokenDeltasFromParsed(tx,mint){
 const pre=tx?.meta?.preTokenBalances||[],post=tx?.meta?.postTokenBalances||[];const m=new Map();
 for(const r of pre.filter(x=>x.mint===mint)){const k=r.owner||String(r.accountIndex);m.set(k,{wallet:r.owner||'',pre:Number(r.uiTokenAmount?.uiAmountString||0),post:0})}
 for(const r of post.filter(x=>x.mint===mint)){const k=r.owner||String(r.accountIndex);const x=m.get(k)||{wallet:r.owner||'',pre:0,post:0};x.post=Number(r.uiTokenAmount?.uiAmountString||0);m.set(k,x)}
 return [...m.values()].map(x=>({...x,delta:x.post-x.pre})).filter(x=>x.wallet&&Math.abs(x.delta)>1e-12);
}
// Most swaps move SOL as wrapped SOL (a token account), not lamports, so the wallet's SOL change is its
// native change plus its WSOL token change. Without the WSOL part half the events recorded 0 SOL.
export const WSOL_MINT='So11111111111111111111111111111111111111112';
function wsolTokenDelta(tx,wallet){let d=0;for(const [rows,sign] of [[tx?.meta?.preTokenBalances||[],-1],[tx?.meta?.postTokenBalances||[],1]])for(const r of rows)if(r.mint===WSOL_MINT&&r.owner===wallet)d+=sign*Number(r.uiTokenAmount?.uiAmountString||0);return d}
export function rpcSolDelta(tx,wallet){return nativeDelta(tx,wallet)+wsolTokenDelta(tx,wallet)}
// Helius enhanced transactions: accountData carries each account's native change and token changes.
export function heliusSolDelta(tx,wallet){
 let d=0,seen=false;
 for(const a of tx?.accountData||[]){
  if(a.account===wallet&&Number.isFinite(Number(a.nativeBalanceChange))){d+=Number(a.nativeBalanceChange)/1e9;seen=true}
  for(const t of a.tokenBalanceChanges||[])if(t.mint===WSOL_MINT&&t.userAccount===wallet){const raw=t.rawTokenAmount||{};d+=Number(raw.tokenAmount||0)/10**Number(raw.decimals??9);seen=true}
 }
 if(!seen)for(const nt of tx?.nativeTransfers||[]){if(nt.toUserAccount===wallet)d+=Number(nt.amount||0)/1e9;if(nt.fromUserAccount===wallet)d-=Number(nt.amount||0)/1e9}
 return Math.round(d*1e9)/1e9;
}
function nativeDelta(tx,wallet){const keys=tx?.transaction?.message?.accountKeys||[];const i=keys.findIndex(k=>(k.pubkey?.toBase58?.()||String(k.pubkey||k))===wallet);if(i<0)return 0;return (Number(tx.meta?.postBalances?.[i]||0)-Number(tx.meta?.preBalances?.[i]||0))/1e9}


async function customFeed(mint,limit){if(!cfg.txFeedUrl)return null;const u=new URL(cfg.txFeedUrl);u.searchParams.set('mint',mint);u.searchParams.set('limit',String(limit));const h=cfg.txFeedToken?{authorization:`Bearer ${cfg.txFeedToken}`}:{},r=await withTimeout(fetch(u,{headers:h}),7000,'custom transaction feed');if(!r.ok)throw new Error(`TX feed ${r.status}`);const j=await r.json(),rows=Array.isArray(j)?j:(j.events||[]),counts=new Map();return rows.map((e,i)=>{const sig=String(e.signature||`custom-${e.ts||Date.now()}-${i}`),n=counts.get(sig)||0;counts.set(sig,n+1);return{...e,signature:sig,eventIndex:Number.isInteger(e.eventIndex)?e.eventIndex:n,mint:e.mint||mint,source:e.source||'custom-feed'}})}

async function helius(mint,limit){
 if(!cfg.heliusApiKey||!heliusBudget())return null;
 const u=`https://api.helius.xyz/v0/addresses/${encodeURIComponent(mint)}/transactions?api-key=${encodeURIComponent(cfg.heliusApiKey)}&limit=${Math.min(100,limit)}`;
 const {data:rows}=await heliusGet(u,'Helius enhanced transactions');const events=[];
 for(const tx of rows){let idx=0;for(const tr of tx.tokenTransfers||[]){if(tr.mint!==mint)continue;const amount=Number(tr.tokenAmount||0);if(tr.toUserAccount)events.push({signature:tx.signature,eventIndex:idx++,ts:Number(tx.timestamp||0)*1000,slot:tx.slot||0,mint,wallet:tr.toUserAccount,side:'BUY',tokenDelta:amount,solDelta:heliusSolDelta(tx,tr.toUserAccount),source:'helius',raw:{type:tx.type}});if(tr.fromUserAccount)events.push({signature:tx.signature,eventIndex:idx++,ts:Number(tx.timestamp||0)*1000,slot:tx.slot||0,mint,wallet:tr.fromUserAccount,side:'SELL',tokenDelta:-amount,solDelta:heliusSolDelta(tx,tr.fromUserAccount),source:'helius',raw:{type:tx.type}})}
  for(const nt of tx.nativeTransfers||[]){if(nt.fromUserAccount&&nt.toUserAccount)events.push({funding:true,funder:nt.fromUserAccount,wallet:nt.toUserAccount,ts:Number(tx.timestamp||0)*1000,sol:Number(nt.amount||0)/1e9,signature:tx.signature})}
 }
 return events;
}
async function publicRpc(mint,limit){
 const c=connection();const sigs=await withTimeout(c.getSignaturesForAddress(new PublicKey(mint),{limit:Math.min(40,limit)},'confirmed'),7000,'signature history');const txs=await Promise.all(sigs.map(x=>withTimeout(c.getParsedTransaction(x.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0}),7000,'parsed transaction').catch(()=>null)));const out=[];
 for(let i=0;i<txs.length;i++){const tx=txs[i];if(!tx)continue;let idx=0;for(const d of tokenDeltasFromParsed(tx,mint)){const sol=rpcSolDelta(tx,d.wallet);out.push({signature:sigs[i].signature,eventIndex:idx++,ts:Number(tx.blockTime||sigs[i].blockTime||0)*1000,slot:tx.slot||sigs[i].slot||0,mint,wallet:d.wallet,side:d.delta>0?'BUY':'SELL',tokenDelta:d.delta,solDelta:sol,source:'public-rpc',raw:{coverage:'mint-address-only'}})}}return out;
}
export async function indexMintTransactions(mint,limit=50){try{return await customFeed(mint,limit) || await helius(mint,limit) || await publicRpc(mint,limit)}catch(e){return {error:e.message,events:[]}}}

export async function indexWalletFunding(wallet,beforeTs=Date.now(),limit=30){
 if(!cfg.heliusApiKey||!wallet||!heliusBudget())return[];
 try{const u=`https://api.helius.xyz/v0/addresses/${encodeURIComponent(wallet)}/transactions?api-key=${encodeURIComponent(cfg.heliusApiKey)}&limit=${Math.min(100,limit)}`;const {data:rows}=await heliusGet(u,'Helius wallet funding'),out=[];for(const tx of rows){const ts=Number(tx.timestamp||0)*1000;if(ts>beforeTs)continue;for(const nt of tx.nativeTransfers||[]){if(nt.toUserAccount===wallet&&nt.fromUserAccount&&nt.fromUserAccount!==wallet)out.push({funder:nt.fromUserAccount,wallet,ts,sol:Number(nt.amount||0)/1e9,signature:tx.signature})}}return out}catch{return[]}
}
