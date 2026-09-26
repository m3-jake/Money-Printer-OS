import {Connection,PublicKey,LAMPORTS_PER_SOL} from '@solana/web3.js'; import {cfg} from './config.js'; import {withTimeout,sleep} from './utils.js';
let cursor=0; const urls=[cfg.rpcUrl,...cfg.backupRpcUrls].filter(Boolean); const riskCache=new Map(); const RISK_CACHE_MS=120_000; let nextRpcAt=0; let holderCircuitUntil=0; export const rpcUrls=()=>[...urls];
// Holder lookups (getTokenLargestAccounts + owner resolve) may use their own RPC, HOLDER_RPC_URL: the free public RPC
// answers 429 to getTokenLargestAccounts, which left Wallet Intel and the holder-concentration checks blind. Outcomes are
// counted per UTC day, capped by HOLDER_RPC_DAILY_CALLS (0 = no cap) and logged when the status changes.
const holderUrl=cfg.holderRpcUrl||'',holderHost=(()=>{try{return new URL(holderUrl||cfg.rpcUrl).host}catch{return 'unknown'}})();let holderConn=null,holderLogged='';
const holderStats={day:'',calls:0,ok:0,rateLimited:0,timeouts:0,errors:0,budgetSkips:0,status:'UNKNOWN',lastOkAt:0,lastError:null,lastErrorAt:0,latencyMs:null};
function holderDay(){const d=new Date().toISOString().slice(0,10);if(holderStats.day!==d)Object.assign(holderStats,{day:d,calls:0,ok:0,rateLimited:0,timeouts:0,errors:0,budgetSkips:0})}
function holderNote(status,err){holderStats.status=status;if(err){holderStats.lastError=String(err.message||err).replace(/api-key=[^&\s"']+/gi,'api-key=<redacted>').slice(0,200);holderStats.lastErrorAt=Date.now()}if(holderLogged!==status){holderLogged=status;console.log(`[holder-rpc] ${status} via ${holderHost}${err?`: ${holderStats.lastError}`:''}`)}}
function holderFail(e){const m=String(e?.message||e);if(/\b429\b|too many requests/i.test(m)){holderStats.rateLimited++;holderNote('RATE_LIMITED',e)}else if(/timed out/i.test(m)){holderStats.timeouts++;holderNote('TIMEOUT',e)}else{holderStats.errors++;holderNote('ERROR',e)}}
function holderConnection(c){return holderUrl?(holderConn||=new Connection(holderUrl,{commitment:'confirmed',disableRetryOnRateLimit:true})):c}
export function holderRpcHealth(){holderDay();return{...holderStats,provider:holderHost,dedicated:!!holderUrl,dailyBudget:cfg.holderRpcDailyCalls,circuitOpenUntil:holderCircuitUntil>Date.now()?holderCircuitUntil:0}}
async function paceRpc(gapMs=225){const now=Date.now(),wait=Math.max(0,nextRpcAt-now);nextRpcAt=Math.max(now,nextRpcAt)+gapMs;if(wait)await sleep(wait)}
export function connection(index=cursor){return new Connection(urls[index%urls.length],{commitment:'confirmed',disableRetryOnRateLimit:true})}
async function withFallback(fn,timeoutMs=5500){let last;for(let i=0;i<urls.length;i++){const idx=(cursor+i)%urls.length;try{await paceRpc();const v=await withTimeout(fn(connection(idx)),timeoutMs,'Solana RPC');cursor=idx;return v}catch(e){last=e}}throw last}
export async function benchmarkRpcs(){const out=[];for(let i=0;i<urls.length;i++){const url=urls[i],t=Date.now();try{const c=connection(i);await paceRpc();const slot=await withTimeout(c.getSlot('processed'),4500,'RPC benchmark');out.push({url,ok:true,latencyMs:Date.now()-t,slot})}catch(e){out.push({url,ok:false,latencyMs:Date.now()-t,error:e.message})}}out.sort((a,b)=>(a.ok?0:1)-(b.ok?0:1)||(a.latencyMs-b.latencyMs));const best=out.find(x=>x.ok);if(best)cursor=urls.indexOf(best.url);return out}
export async function solBalance(owner){return withFallback(async c=>(await c.getBalance(new PublicKey(owner)))/LAMPORTS_PER_SOL)}
export async function tokenBalanceRaw(owner,mint){return withFallback(async c=>{const rs=await c.getParsedTokenAccountsByOwner(new PublicKey(owner),{mint:new PublicKey(mint)});let raw=0n,decimals=0;for(const a of rs.value){const x=a.account.data.parsed.info.tokenAmount;raw+=BigInt(x.amount);decimals=x.decimals}return{raw,decimals}})}
export async function mintRisk(mint){const hit=riskCache.get(mint);if(hit&&Date.now()-hit.at<RISK_CACHE_MS)return hit.value;const value=await withFallback(async c=>{
 const pk=new PublicKey(mint);
 await paceRpc();const info=await c.getParsedAccountInfo(pk);
 let largest={value:[]},holderDataUnavailable=false;
 const hc=holderConnection(c);holderDay();
 if(Date.now()<holderCircuitUntil){holderDataUnavailable=true}else if(cfg.holderRpcDailyCalls>0&&holderStats.calls+2>cfg.holderRpcDailyCalls){holderDataUnavailable=true;holderStats.budgetSkips++;holderNote('BUDGET')}else{try{await paceRpc();holderStats.calls++;const t=Date.now();largest=await withTimeout(hc.getTokenLargestAccounts(pk),1100,'holder RPC');holderStats.ok++;holderStats.lastOkAt=Date.now();holderStats.latencyMs=Date.now()-t;holderNote('OK')}catch(e){holderDataUnavailable=true;holderCircuitUntil=Date.now()+60_000;holderFail(e)}}
 await paceRpc();const supply=await c.getTokenSupply(pk);
 const parsed=info.value?.data?.parsed?.info||{},total=BigInt(supply.value.amount||0),accounts=(largest.value||[]).slice(0,10),vals=accounts.map(x=>BigInt(x.amount||0));
 const pct=(xs)=>{if(total<=0n)return 100;const sum=xs.reduce((a,b)=>a+b,0n);return Number((sum*10000n)/total)/100};
 const accountTop1=pct(vals.slice(0,1)),accountTop5=pct(vals.slice(0,5)),accountTop10=pct(vals.slice(0,10));
 let ownerRows=[];
 if(accounts.length&&typeof hc.getMultipleParsedAccounts==='function'){
   try{await paceRpc();holderStats.calls++;const rs=await hc.getMultipleParsedAccounts(accounts.map(x=>x.address));ownerRows=(rs.value||[]).map((v,i)=>({owner:v?.data?.parsed?.info?.owner||null,amount:vals[i]||0n,address:accounts[i]?.address?.toBase58?.()||String(accounts[i]?.address||'')}));}catch(e){holderFail(e)}
 }
 const grouped=new Map();for(const r of ownerRows){const key=r.owner||r.address;grouped.set(key,(grouped.get(key)||0n)+r.amount)}
 const ownerVals=[...grouped.values()].sort((a,b)=>a===b?0:a>b?-1:1),ownerTop1=pct(ownerVals.slice(0,1)),ownerTop5=pct(ownerVals.slice(0,5)),ownerTop10=pct(ownerVals.slice(0,10));
 const top1=Math.max(accountTop1,ownerTop1||0),top5=Math.max(accountTop5,ownerTop5||0),top10=Math.max(accountTop10,ownerTop10||0);
 let score=100;const flags=[];if(holderDataUnavailable){score-=18;flags.push('holder-data-unavailable')}
 if(parsed.freezeAuthority){score-=35;flags.push('freeze-authority')}if(parsed.mintAuthority){score-=15;flags.push('mint-authority')}if(top1>cfg.maxTop1HolderPct){score-=20;flags.push('top1-concentrated')}if(top10>cfg.maxTop10HolderPct){score-=20;flags.push('top10-concentrated')}if(top5>45){score-=8;flags.push('top5-concentrated')}
 const ownersByAddress=new Map(ownerRows.map(x=>[x.address,x.owner]));
 return{score:Math.max(0,score),flags,holderDataUnavailable,top1Pct:top1,top5Pct:top5,top10Pct:top10,accountTop10Pct:accountTop10,ownerTop10Pct:ownerTop10,mintAuthority:parsed.mintAuthority||null,freezeAuthority:parsed.freezeAuthority||null,decimals:supply.value.decimals,totalSupply:supply.value.uiAmountString,largest:accounts.map(x=>{const address=x.address?.toBase58?.()||String(x.address);return{address,owner:ownersByAddress.get(address)||null,amount:x.uiAmountString||x.amount}})}},2600);riskCache.set(mint,{at:Date.now(),value});if(riskCache.size>500){const cutoff=Date.now()-RISK_CACHE_MS;for(const [k,v] of riskCache)if(v.at<cutoff)riskCache.delete(k)}return value}
