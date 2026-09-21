import { PublicKey } from '@solana/web3.js';
import { cfg } from './config.js';
import { connection } from './rpc.js';
import { withTimeout } from './utils.js';
import { createMarketRequester } from './marketRequests.js';

const heliusRequests=createMarketRequester({timeoutMs:7000,requestsPerMinute:cfg.heliusRequestsPerMinute});
export function transactionIndexerHealth(){return {helius:heliusRequests.health()}}

function tokenDeltasFromParsed(tx,mint){
 const pre=tx?.meta?.preTokenBalances||[],post=tx?.meta?.postTokenBalances||[];const m=new Map();
 for(const r of pre.filter(x=>x.mint===mint)){const k=r.owner||String(r.accountIndex);m.set(k,{wallet:r.owner||'',pre:Number(r.uiTokenAmount?.uiAmountString||0),post:0})}
 for(const r of post.filter(x=>x.mint===mint)){const k=r.owner||String(r.accountIndex);const x=m.get(k)||{wallet:r.owner||'',pre:0,post:0};x.post=Number(r.uiTokenAmount?.uiAmountString||0);m.set(k,x)}
 return [...m.values()].map(x=>({...x,delta:x.post-x.pre})).filter(x=>x.wallet&&Math.abs(x.delta)>1e-12);
}
function nativeDelta(tx,wallet){const keys=tx?.transaction?.message?.accountKeys||[];const i=keys.findIndex(k=>(k.pubkey?.toBase58?.()||String(k.pubkey||k))===wallet);if(i<0)return 0;return (Number(tx.meta?.postBalances?.[i]||0)-Number(tx.meta?.preBalances?.[i]||0))/1e9}


async function customFeed(mint,limit){if(!cfg.txFeedUrl)return null;const u=new URL(cfg.txFeedUrl);u.searchParams.set('mint',mint);u.searchParams.set('limit',String(limit));const h=cfg.txFeedToken?{authorization:`Bearer ${cfg.txFeedToken}`}:{},r=await withTimeout(fetch(u,{headers:h}),7000,'custom transaction feed');if(!r.ok)throw new Error(`TX feed ${r.status}`);const j=await r.json(),rows=Array.isArray(j)?j:(j.events||[]),counts=new Map();return rows.map((e,i)=>{const sig=String(e.signature||`custom-${e.ts||Date.now()}-${i}`),n=counts.get(sig)||0;counts.set(sig,n+1);return{...e,signature:sig,eventIndex:Number.isInteger(e.eventIndex)?e.eventIndex:n,mint:e.mint||mint,source:e.source||'custom-feed'}})}

async function helius(mint,limit){
 if(!cfg.heliusApiKey)return null;
 const u=`https://api.helius.xyz/v0/addresses/${encodeURIComponent(mint)}/transactions?api-key=${encodeURIComponent(cfg.heliusApiKey)}&limit=${Math.min(100,limit)}`;
 const {data:rows}=await heliusRequests.get(u,'Helius enhanced transactions',{ttlMs:0,costPerRequestUsd:cfg.heliusCostPerRequestUsd});const events=[];
 for(const tx of rows){let idx=0;for(const tr of tx.tokenTransfers||[]){if(tr.mint!==mint)continue;const amount=Number(tr.tokenAmount||0);if(tr.toUserAccount)events.push({signature:tx.signature,eventIndex:idx++,ts:Number(tx.timestamp||0)*1000,slot:tx.slot||0,mint,wallet:tr.toUserAccount,side:'BUY',tokenDelta:amount,solDelta:0,source:'helius',raw:{type:tx.type}});if(tr.fromUserAccount)events.push({signature:tx.signature,eventIndex:idx++,ts:Number(tx.timestamp||0)*1000,slot:tx.slot||0,mint,wallet:tr.fromUserAccount,side:'SELL',tokenDelta:-amount,solDelta:0,source:'helius',raw:{type:tx.type}})}
  for(const nt of tx.nativeTransfers||[]){if(nt.fromUserAccount&&nt.toUserAccount)events.push({funding:true,funder:nt.fromUserAccount,wallet:nt.toUserAccount,ts:Number(tx.timestamp||0)*1000,sol:Number(nt.amount||0)/1e9,signature:tx.signature})}
 }
 return events;
}
async function publicRpc(mint,limit){
 const c=connection();const sigs=await withTimeout(c.getSignaturesForAddress(new PublicKey(mint),{limit:Math.min(40,limit)},'confirmed'),7000,'signature history');const txs=await Promise.all(sigs.map(x=>withTimeout(c.getParsedTransaction(x.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0}),7000,'parsed transaction').catch(()=>null)));const out=[];
 for(let i=0;i<txs.length;i++){const tx=txs[i];if(!tx)continue;let idx=0;for(const d of tokenDeltasFromParsed(tx,mint)){const sol=nativeDelta(tx,d.wallet);out.push({signature:sigs[i].signature,eventIndex:idx++,ts:Number(tx.blockTime||sigs[i].blockTime||0)*1000,slot:tx.slot||sigs[i].slot||0,mint,wallet:d.wallet,side:d.delta>0?'BUY':'SELL',tokenDelta:d.delta,solDelta:sol,source:'public-rpc',raw:{coverage:'mint-address-only'}})}}return out;
}
export async function indexMintTransactions(mint,limit=50){try{return await customFeed(mint,limit) || await helius(mint,limit) || await publicRpc(mint,limit)}catch(e){return {error:e.message,events:[]}}}

export async function indexWalletFunding(wallet,beforeTs=Date.now(),limit=30){
 if(!cfg.heliusApiKey||!wallet)return[];
 try{const u=`https://api.helius.xyz/v0/addresses/${encodeURIComponent(wallet)}/transactions?api-key=${encodeURIComponent(cfg.heliusApiKey)}&limit=${Math.min(100,limit)}`;const {data:rows}=await heliusRequests.get(u,'Helius wallet funding',{ttlMs:0,costPerRequestUsd:cfg.heliusCostPerRequestUsd}),out=[];for(const tx of rows){const ts=Number(tx.timestamp||0)*1000;if(ts>beforeTs)continue;for(const nt of tx.nativeTransfers||[]){if(nt.toUserAccount===wallet&&nt.fromUserAccount&&nt.fromUserAccount!==wallet)out.push({funder:nt.fromUserAccount,wallet,ts,sol:Number(nt.amount||0)/1e9,signature:tx.signature})}}return out}catch{return[]}
}
