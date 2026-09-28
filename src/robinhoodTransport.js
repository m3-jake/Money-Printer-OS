// Robinhood Auto Trader — signed transport (docs/ROBINHOOD-AUTO-TRADER.md §4, §20).
// Env creds read on every call, KeyObject memoised on sha256(seed), no network at import.
// Rules: token bucket 60/min (refill 1/s) + 429 backoff enforced locally; every response's
// `date` header feeds rhClock(); a first 401 with >=5 s skew is retried exactly once with the
// identical body bytes; any error raised after dispatch carries `sent:true` (timeouts -> 'uncertain').
import crypto from 'node:crypto';
import { assertLiveDispatchAllowed } from './core/executionBoundary.js';
import { RobinhoodError, RH_CODES, fail } from './robinhoodErrors.js';
import { RH_BASE_URL, loadRobinhoodPrivateKey, signRequest, buildPath } from './robinhoodSigner.js';
export { RobinhoodError, RH_CODES, fail } from './robinhoodErrors.js';

const APP_VERSION='0.5.0-alpha.72';
export const ROBINHOOD_LIVE_TRADING_ENABLED=false;
export const ROBINHOOD_LIVE_CREDENTIAL_ENV=Object.freeze({apiKey:'ROBINHOOD_LIVE_API_KEY',privateKey:'ROBINHOOD_LIVE_PRIVATE_KEY'});
const UA=()=>`MoneyPrinterOS/${APP_VERSION}`;
const BASE=()=>String(process.env.ROBINHOOD_API||RH_BASE_URL).replace(/\/+$/,'');
const isTestDestination=()=>{try{const h=new URL(BASE()).hostname.toLowerCase();return h==='localhost'||h==='127.0.0.1'||h.endsWith('.test')}catch{return false}};
const ORDER_API=()=>String(process.env.ROBINHOOD_ORDER_API||'v2').trim().toLowerCase()==='v1'?'v1':'v2';
const TIME_IN_FORCE=['gtc','gfd','gfw','gfm'];
const num=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null};

// ------------------------------------------------------------------ state
let clockFn=null;
const now=()=>clockFn?Number(clockFn()):Date.now();
let lastAuth={error:null,code:null,at:0};
let clock={skewSec:0,syncedAt:0,lastDateHeaderSec:null};
let rate={tokens:60,capacity:60,refillPerSec:1,backoffUntil:0,consecutive429:0,lastRefillAt:0};
let keyCache={hash:'',key:null};
const requestLog=[];
// Outbound audit (per process): every signed call is counted by method before it is sent. POST is only
// ever allowed to the order endpoints; the paper books must never produce one.
let callStats={get:0,post:0,postRefused:0,other:0,lastPostAt:0,lastPostPath:null};
export const RH_POST_ALLOWED=/^\/api\/v[12]\/crypto\/trading\/orders\/(?:[A-Za-z0-9%_-]+\/cancel\/)?(?:\?.*)?$/;
export function rhCallStats(){return {...callStats}}

export function creds(){return {apiKey:String(process.env.ROBINHOOD_API_KEY||'').trim(),privateKeyBase64:String(process.env.ROBINHOOD_PRIVATE_KEY||'').trim()}}
export function liveCreds(){return {apiKey:String(process.env.ROBINHOOD_LIVE_API_KEY||'').trim(),privateKeyBase64:String(process.env.ROBINHOOD_LIVE_PRIVATE_KEY||'').trim()}}
function keyFor(credentials){
 const {privateKeyBase64}=credentials||{};
 if(!privateKeyBase64)return null;
 const hash=crypto.createHash('sha256').update(privateKeyBase64).digest('hex');
 if(keyCache.key&&keyCache.hash===hash)return keyCache.key;
 try{const key=loadRobinhoodPrivateKey(privateKeyBase64);keyCache={hash,key};return key}
 catch(e){keyCache={hash:'',key:null};noteRobinhoodAuth({code:'badKey',message:e?.message||'bad key'});return null}
}
export function keyObject(){return keyFor(creds())}
export function liveKeyObject(){return keyFor(liveCreds())}
export function rhLastAuth(){return {...lastAuth}}
export function noteRobinhoodAuth({code=null,message=null,status=0}={}){
 const resolved=code||(status?classifyRobinhoodError(status,null,message):(message?'unknown':'ok'));
 if(resolved==='ok'){lastAuth={error:null,code:'ok',at:now()};return}
 lastAuth={error:message?String(message).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,240):resolved,code:resolved,at:now()};
}
export function rhClock(){return {skewSec:clock.skewSec,syncedAt:clock.syncedAt,lastDateHeaderSec:clock.lastDateHeaderSec,timestamp:()=>Math.floor(now()/1000)+clock.skewSec}}
function refill(){
 const t=now();
 if(rate.lastRefillAt){rate.tokens=Math.min(rate.capacity,rate.tokens+((t-rate.lastRefillAt)/1000)*rate.refillPerSec)}
 rate.lastRefillAt=t;
}
export function rhRateLimit(){refill();return {tokens:rate.tokens,capacity:rate.capacity,refillPerSec:rate.refillPerSec,backoffUntil:rate.backoffUntil,consecutive429:rate.consecutive429}}

// ------------------------------------------------------------ classification
export function classifyRobinhoodError(status,payload,message=''){
 const s=Number(status)||0;
 if(s===400)return payload&&typeof payload==='object'&&payload.type==='validation_error'?'validation':'http';
 if(s===401)return 'keyNotFound';
 if(s===403)return 'notPermitted';
 if(s===429)return 'rateLimited';
 if(s===404)return 'http';
 if(s>=500)return 'http';
 if(s===0){const t=String(message||'');if(/timeout|abort/i.test(t))return 'uncertain';if(t)return 'network'}
 return 'http';
}
function errorMessage(status,payload,text){
 if(payload&&typeof payload==='object'){
  const type=payload.type||`HTTP ${status}`;
  const details=Array.isArray(payload.errors)?payload.errors.map(e=>e?.detail?`${e.detail}${e.attr?` (${e.attr})`:''}`:'').filter(Boolean).join('; '):(payload.detail||payload.message||payload.error||'');
  return `${type}${details?`: ${details}`:''}`.slice(0,240);
 }
 return `HTTP ${status}`.slice(0,240);
}
const dateHeaderSec=res=>{
 try{const d=res?.headers?.get?.('date');if(!d)return null;const ms=Date.parse(d);return Number.isFinite(ms)?Math.floor(ms/1000):null}catch{return null}
};

// ------------------------------------------------------------------ request
function normalizePath(path){
 const p=String(path||'');
 if(/^https?:\/\//i.test(p)){const u=new URL(p);return u.pathname+u.search}
 return p.startsWith('/')?p:`/${p}`;
}
function takeToken(){
 const t=now();
 if(t<rate.backoffUntil)fail('rateLimited',`Robinhood backoff active for ${Math.ceil((rate.backoffUntil-t)/1000)} s (local)`,0,{local:true,backoffUntil:rate.backoffUntil});
 refill();
 if(rate.tokens<1)fail('rateLimited','Robinhood client rate limit reached (local token bucket)',0,{local:true});
 rate.tokens-=1;
}
export async function rhRequest({method,path,json,timeoutMs=15000,retryOn401=true}){
 const verb=String(method||'GET').toUpperCase(),mutation=verb==='POST';
 if(mutation&&!isTestDestination()){
  if(!ROBINHOOD_LIVE_TRADING_ENABLED)throw Object.assign(new Error('Robinhood PAPER-ONLY build: outbound order mutations are disabled in code'),{code:'ROBINHOOD_PAPER_ONLY_BUILD'});
  assertLiveDispatchAllowed();
 }
 if(verb==='POST'&&!RH_POST_ALLOWED.test(String(path||''))){callStats.postRefused++;fail('validation','Robinhood POST refused: only the order endpoints may be posted to')}
 if(verb==='GET')callStats.get++;else if(verb==='POST'){callStats.post++;callStats.lastPostAt=now();callStats.lastPostPath=String(path).split('?')[0]}else callStats.other++;
 const m=String(method||'GET').toUpperCase();
 const requestCreds=mutation&&!isTestDestination()?liveCreds():creds();
 const {apiKey,privateKeyBase64}=requestCreds;
 if(!apiKey||!privateKeyBase64){const msg=mutation?'Separate Robinhood LIVE credentials are not configured':'Robinhood API credentials are not configured';noteRobinhoodAuth({code:'noCredentials',message:msg});fail('noCredentials',msg)}
 const privateKey=keyFor(requestCreds);
 if(!privateKey)fail('badKey',lastAuth.code==='badKey'&&lastAuth.error?lastAuth.error:'Robinhood private key is invalid');
 const p=normalizePath(path);
 const body=(json===undefined||json===null)?'':JSON.stringify(json);   // serialised exactly once; signed bytes === sent bytes
 takeToken();
 const url=BASE()+p;
 let retried=false;
 for(;;){
  const ts=rhClock().timestamp();
  const headers={'content-type':'application/json','accept':'application/json','user-agent':UA(),...signRequest({apiKey,privateKey,method:m,path:p,body,timestamp:ts})};
  const init={method:m,headers,signal:AbortSignal.timeout(timeoutMs)};
  if(body)init.body=body;
  requestLog.push({method:m,url,headers,body});
  let res;
  try{res=await globalThis.fetch(url,init)}
  catch(e){
   const msg=String(e?.message||e);
   const timeout=/timeout|abort/i.test(String(e?.name||''))||/timeout|abort/i.test(msg);
   const code=timeout?'uncertain':'network';
   noteRobinhoodAuth({code,message:msg});
   const err=new RobinhoodError(code,`Robinhood request ${timeout?'timed out':'failed'}: ${msg}`.slice(0,240),0,{method:m,path:p});
   err.sent=true;throw err;
  }
  const status=Number(res?.status||0);
  const serverSec=dateHeaderSec(res);
  const localSec=Math.floor(now()/1000);
  if(serverSec!==null){clock.lastDateHeaderSec=serverSec;clock.syncedAt=now()}
  let text='';
  try{text=typeof res?.text==='function'?await res.text():''}catch(e){const err=new RobinhoodError('uncertain',`Robinhood response unreadable: ${String(e?.message||e)}`.slice(0,240),status);err.sent=true;noteRobinhoodAuth({code:'uncertain',message:err.message});throw err}
  let payload=null;
  if(text){try{payload=JSON.parse(text)}catch{payload=null}}
  const ok=res?.ok??(status>=200&&status<300);
  if(ok){
   rate.consecutive429=0;
   noteRobinhoodAuth({code:'ok'});
   return payload===null?(text?{raw:text}:{}):payload;
  }
  if(status===401&&retryOn401&&!retried&&serverSec!==null){
   const observed=serverSec-localSec;
   if(Math.abs(observed-clock.skewSec)>=5){clock.skewSec=observed;clock.syncedAt=now();retried=true;continue}
  }
  if(status===429){rate.consecutive429+=1;rate.backoffUntil=now()+Math.min(60000,2000*2**rate.consecutive429)}
  const code=classifyRobinhoodError(status,payload,text);
  let message=errorMessage(status,payload,text);
  if(code==='keyNotFound'&&serverSec===null)message=`${message} (no date header; check system time)`.slice(0,240);
  if(code==='keyNotFound'&&retried)message=`${message} (retried after clock correction)`.slice(0,240);
  noteRobinhoodAuth({code,message,status});
  const err=new RobinhoodError(code,message,status,payload);
  err.sent=true;throw err;
 }
}
export async function rhGet(path,query){return rhRequest({method:'GET',path:buildPath(path,query)})}
export async function rhPost(path,json,query){return rhRequest({method:'POST',path:buildPath(path,query),json})}
export async function rhPaginate(path,query,{maxPages=5}={}){
 const out=[];
 let next=buildPath(path,query);
 for(let i=0;i<maxPages&&next;i++){
  const page=await rhRequest({method:'GET',path:normalizePath(next)});
  const rows=Array.isArray(page?.results)?page.results:(Array.isArray(page)?page:[]);
  out.push(...rows);
  next=page?.next?normalizePath(page.next):null;
 }
 return out;
}
const isFallback=e=>e?.code==='notPermitted'||(e?.code==='http'&&e?.status===404);

// ----------------------------------------------------------------- wrappers
export async function fetchAccount(){
 let res,apiVersion='v2';
 try{res=await rhGet('/api/v2/crypto/trading/accounts/')}
 catch(e){if(!isFallback(e))throw e;apiVersion='v1';res=await rhGet('/api/v1/crypto/trading/accounts/')}
 const rows=Array.isArray(res?.results)?res.results:(res&&typeof res==='object'&&(res.account_number||res.buying_power)?[res]:[]);
 const a=rows.find(r=>r?.is_api_tradable)||rows[0];
 if(!a)fail('notFound','Robinhood returned no crypto trading account',0);
 return {accountNumber:String(a.account_number||''),status:String(a.status||''),buyingPowerUsd:num(a.buying_power)??0,feeRatio:apiVersion==='v2'?num(a.fee_tier_status?.fee_ratio??a.fee_ratio??a.maker_fee_ratio??a.taker_fee_ratio):null,apiVersion,at:now()};
}
export async function fetchTradingPairs(symbols){
 const syms=(symbols||[]).map(s=>String(s).toUpperCase());
 let res;
 try{res=await rhGet('/api/v2/crypto/trading/trading_pairs/',{symbol:syms})}
 catch(e){if(!isFallback(e))throw e;res=await rhGet('/api/v1/crypto/trading/trading_pairs/',{symbol:syms})}
 const map=new Map();
 for(const r of Array.isArray(res?.results)?res.results:[]){
  const symbol=String(r?.symbol||'').toUpperCase();if(!symbol)continue;
  map.set(symbol,{symbol,assetCode:String(r.asset_code||symbol.split('-')[0]),assetIncrement:String(r.asset_increment??r.min_order_size??'0.00000001'),quoteIncrement:String(r.quote_increment??'0.01'),maxOrderSize:num(r.max_order_size),minOrderAmountUsd:num(r.min_order_amount??r.min_order_amount_usd),status:String(r.status||''),isApiTradable:r.is_api_tradable===undefined?String(r.status||'').toLowerCase()==='tradable':!!r.is_api_tradable});
 }
 return map;
}
export async function fetchHoldings(accountNumber,assetCodes){
 const res=await rhGet('/api/v2/crypto/trading/holdings/',{account_number:accountNumber,asset_code:assetCodes&&assetCodes.length?assetCodes:undefined});
 return (Array.isArray(res?.results)?res.results:[]).map(h=>({assetCode:String(h.asset_code||''),totalQty:num(h.total_quantity)??0,availableQty:num(h.quantity_available_for_trading??h.available_quantity??h.total_quantity)??0}));
}
// The v2 book is an aggregated near-mid quote; Robinhood's cost is the account fee_ratio, not the spread.
// Observed live 2026-09-26: bid and ask cross by up to ~2 bps, and timestamps run ~1.1 s ahead of this PC.
// A cross within QUOTE_CROSS_TOLERANCE_BPS is uncrossed conservatively (buy at the higher, sell at the lower);
// a timestamp up to QUOTE_FUTURE_TOLERANCE_MS ahead is clock skew and takes the receipt time. Anything
// wider is left as is, so the caller's freshness check still rejects it.
export const QUOTE_CROSS_TOLERANCE_BPS=5,QUOTE_FUTURE_TOLERANCE_MS=5000;
export async function fetchBestBidAsk(symbols){
 const syms=(symbols||[]).map(s=>String(s).toUpperCase());
 let res,source='v2';
 try{res=await rhGet('/api/v2/crypto/marketdata/best_bid_ask/',{symbol:syms})}
 catch(e){if(!isFallback(e))throw e;source='v1';res=await rhGet('/api/v1/crypto/marketdata/best_bid_ask/',{symbol:syms})}
 const at=now();
 return (Array.isArray(res?.results)?res.results:[]).map(r=>{
  let bid=source==='v1'?num(r.bid_inclusive_of_sell_spread??r.bid_price):num(r.bid??r.bid_price??r.bid_inclusive_of_sell_spread);
  let ask=source==='v1'?num(r.ask_inclusive_of_buy_spread??r.ask_price):num(r.ask??r.ask_price??r.ask_inclusive_of_buy_spread);
  if(bid>0&&ask>0&&bid>ask&&(bid-ask)/((bid+ask)/2)*1e4<=QUOTE_CROSS_TOLERANCE_BPS)[bid,ask]=[ask,bid];
  const t=r.timestamp?Date.parse(r.timestamp):NaN;
  const stamped=!Number.isFinite(t)?at:t>at&&t-at<=QUOTE_FUTURE_TOLERANCE_MS?at:t;
  return {symbol:String(r.symbol||'').toUpperCase(),bid:bid??0,ask:ask??0,at:stamped,source};
 }).filter(q=>q.symbol);
}
export async function fetchEstimatedPrice(symbol,side,quantities){
 const qs=(quantities||[]).map(String).slice(0,10);
 const res=await rhGet('/api/v2/crypto/trading/estimated_price/',{symbol:String(symbol).toUpperCase(),side,quantity:qs.join(',')});
 const at=now();
 return (Array.isArray(res?.results)?res.results:[]).map(r=>{
  const price=num(r.price);
  const s=String(r.side||side);
  return {symbol:String(r.symbol||symbol).toUpperCase(),side:s,quantity:num(r.quantity)??0,bid:num(r.bid??r.bid_price??(s==='bid'?price:null)),ask:num(r.ask??r.ask_price??(s==='ask'?price:null)),feeRatio:num(r.fee_ratio),estFee:num(r.est_fee??r.estimated_fee??r.fee),estTotalCost:num(r.est_total_cost??r.estimated_total_cost??r.total_cost),estTotalCredit:num(r.est_total_credit??r.estimated_total_credit??r.total_credit),at:r.timestamp?Date.parse(r.timestamp):at};
 });
}
export async function listOrders(accountNumber,filters={}){
 const q={account_number:accountNumber};
 for(const k of ['state','symbol','created_at_start','side'])if(filters?.[k]!==undefined&&filters?.[k]!==null)q[k]=filters[k];
 const rows=await rhPaginate('/api/v2/crypto/trading/orders/',q);
 return rows.map(normalizeOrder);
}
export async function getOrder(accountNumber,orderId){
 try{const raw=await rhGet(`/api/v2/crypto/trading/orders/${encodeURIComponent(orderId)}/`,{account_number:accountNumber});return raw&&raw.id?normalizeOrder(raw):null}
 catch(e){
  if(e?.code==='http'&&(e.status===404||e.status===405)){
   const rows=await listOrders(accountNumber,{});
   return rows.find(o=>o.id===String(orderId))||null;
  }
  throw e;
 }
}
export async function placeOrder(accountNumber,body){
 const raw=ORDER_API()==='v1'?await rhPost('/api/v1/crypto/trading/orders/',body):await rhPost('/api/v2/crypto/trading/orders/',body,{account_number:accountNumber});
 return normalizeOrder(raw);
}
export async function cancelOrder(accountNumber,orderId){
 const raw=await rhPost(`/api/v2/crypto/trading/orders/${encodeURIComponent(orderId)}/cancel/`,undefined,{account_number:accountNumber});
 return {submitted:true,order:raw&&raw.id?normalizeOrder(raw):null};
}

// ---------------------------------------------------------- normalisation
const STATE_MAP={open:'open',pending:'pending',partially_filled:'partially_filled',filled:'filled',canceled:'canceled',cancelled:'canceled',failed:'failed',rejected:'failed',expired:'canceled'};
export function normalizeOrder(raw){
 const r=raw&&typeof raw==='object'?raw:{};
 const type=String(r.type||(r.limit_order_config?'limit':'market')).toLowerCase();
 const stateKey=String(r.state||r.status||'').toLowerCase();
 const executions=(Array.isArray(r.executions)?r.executions:[]).map(x=>({price:num(x?.effective_price??x?.price)??0,qty:num(x?.quantity??x?.asset_quantity)??0,at:x?.timestamp?Date.parse(x.timestamp)||0:0}));
 const filledQty=num(r.filled_asset_quantity)??executions.reduce((s,x)=>s+x.qty,0);
 let averagePrice=num(r.average_price);
 if(averagePrice===null&&filledQty>0&&executions.length){const notional=executions.reduce((s,x)=>s+x.price*x.qty,0);averagePrice=notional/filledQty}
 return {id:String(r.id||''),clientOrderId:String(r.client_order_id||''),symbol:String(r.symbol||'').toUpperCase(),side:String(r.side||'').toLowerCase(),type,state:STATE_MAP[stateKey]||'pending',averagePrice,filledQty,feeCharged:num(r.fee_charged??r.fee??r.total_fee),executions,createdAt:r.created_at?Date.parse(r.created_at)||0:0,updatedAt:r.updated_at?Date.parse(r.updated_at)||0:0};
}
export function orderBody({clientOrderId,symbol,side,type,qtyStr,limitPriceStr,timeInForce='gtc'}){
 const t=String(type||'market').toLowerCase();
 if(!['market','limit'].includes(t))fail('validation',`Unsupported order type ${t}`);
 if(!['buy','sell'].includes(String(side)))fail('validation',`Unsupported side ${String(side)}`);
 if(typeof qtyStr!=='string'||!/^\d+(\.\d+)?$/.test(qtyStr))fail('validation','qtyStr must be a decimal string');
 const config={asset_quantity:qtyStr};
 if(t==='limit'){if(typeof limitPriceStr!=='string'||!/^\d+(\.\d+)?$/.test(limitPriceStr))fail('validation','limitPriceStr must be a decimal string');config.limit_price=limitPriceStr}
 if(ORDER_API()!=='v1'){
  const tif=String(timeInForce||'gtc').toLowerCase();
  if(!TIME_IN_FORCE.includes(tif))fail('validation',`time_in_force must be one of ${TIME_IN_FORCE.join('|')}`);
  config.time_in_force=tif;
 }
 return {client_order_id:String(clientOrderId),side:String(side),type:t,symbol:String(symbol).toUpperCase(),[`${t}_order_config`]:config};
}

// ------------------------------------------------------------------ testing
export const __testing={
 resetTransport(){lastAuth={error:null,code:null,at:0};clock={skewSec:0,syncedAt:0,lastDateHeaderSec:null};rate={tokens:rate.capacity,capacity:rate.capacity,refillPerSec:rate.refillPerSec,backoffUntil:0,consecutive429:0,lastRefillAt:0};keyCache={hash:'',key:null};requestLog.length=0;callStats={get:0,post:0,postRefused:0,other:0,lastPostAt:0,lastPostPath:null}},
 setClock(fn){clockFn=typeof fn==='function'?fn:null},
 setRateLimit(cap,refillPerSec){rate.capacity=Number(cap)||60;rate.refillPerSec=Number.isFinite(Number(refillPerSec))?Number(refillPerSec):1;rate.tokens=rate.capacity;rate.lastRefillAt=0},
 requestLog,
};
