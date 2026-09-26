// Robinhood stocks & ETFs paper lane: daily-bar data adapter (docs/ROBINHOOD-AUTO-TRADER.md §25).
// Provider interface: { id, label, keyless, termsNote, configured(env), fetchDailyBars(symbols,{start,end,fetchImpl,env}) }
//   -> { [SYM]: [{d,o,h,l,c,v}] } sorted by d (America/New_York session date), fully adjusted (splits + dividends).
// Only sources whose terms allow automated access are registered. Rejected on purpose: Stooq (JavaScript bot
// check), Cboe delayed quotes (automated download prohibited), Yahoo chart (unofficial, terms bar automated use).
// No keyless source qualified, so without a key the lane reports NO_DATA and never trades.
// NEVER calls any Robinhood endpoint. No network at import.
import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from './atomicRename.js';
import { etDate, isSession, lastCompletedSession, CALENDAR_START } from './robinhoodEquitiesCalendar.js';

export const SYMBOL_RE=/^[A-Z]{1,5}(?:[.-][A-Z]{1,2})?$/;
export function validSymbol(s){return typeof s==='string'&&SYMBOL_RE.test(s)}

function alpacaKeys(env=process.env){
 const id=env.ALPACA_KEY_ID||env.APCA_API_KEY_ID||'';const secret=env.ALPACA_SECRET_KEY||env.APCA_API_SECRET_KEY||'';
 return id&&secret?{id,secret}:null;
}
export const PROVIDERS={
 alpaca:{
  id:'alpaca',label:'Alpaca Market Data (free Basic plan, IEX feed)',keyless:false,
  termsNote:'Official documented API; free key required (ALPACA_KEY_ID + ALPACA_SECRET_KEY). IEX-only volume; closes are IEX prints, not consolidated tape.',
  docs:'https://docs.alpaca.markets/us/docs/historical-stock-data-1',
  configured:env=>!!alpacaKeys(env),
  async fetchDailyBars(symbols,{start,end,fetchImpl=globalThis.fetch,env=process.env}={}){
   const k=alpacaKeys(env);if(!k)throw Object.assign(new Error('Alpaca key not configured'),{code:'NO_KEY'});
   const out={};for(const s of symbols)out[s]=[];
   let token=null,pages=0;
   do{
    const u=new URL('https://data.alpaca.markets/v2/stocks/bars');
    u.searchParams.set('symbols',symbols.join(','));u.searchParams.set('timeframe','1Day');
    u.searchParams.set('start',start);if(end)u.searchParams.set('end',end);
    u.searchParams.set('adjustment','all');u.searchParams.set('feed','iex');u.searchParams.set('limit','10000');
    if(token)u.searchParams.set('page_token',token);
    const r=await fetchImpl(u.toString(),{method:'GET',headers:{'APCA-API-KEY-ID':k.id,'APCA-API-SECRET-KEY':k.secret,accept:'application/json'},signal:AbortSignal.timeout?.(20000)});
    if(!r.ok)throw Object.assign(new Error('Alpaca HTTP '+r.status),{code:r.status===401||r.status===403?'AUTH':'HTTP_'+r.status});
    const j=await r.json();
    for(const [sym,rows] of Object.entries(j?.bars||{})){if(!out[sym])continue;for(const b of rows||[]){const t=Date.parse(b.t);if(!Number.isFinite(t))continue;out[sym].push({d:etDate(t),o:+b.o,h:+b.h,l:+b.l,c:+b.c,v:+b.v||0})}}
    token=j?.next_page_token||null;pages++;
   }while(token&&pages<20);
   return out;
  },
 },
};
export const DEFAULT_PROVIDER='alpaca';
export function providerFor(env=process.env){
 const id=String(env.ROBINHOOD_EQUITIES_DATA||DEFAULT_PROVIDER).toLowerCase();
 if(id==='none')return null;
 return PROVIDERS[id]||null;
}

// Keep only clean, completed-session rows: valid numbers, real NYSE session dates, no partial current-session bar.
export function cleanBars(rows,{completedThrough}={}){
 const byDate=new Map();
 for(const b of rows||[]){
  if(!b||typeof b.d!=='string'||!isSession(b.d))continue;
  if(completedThrough&&b.d>completedThrough)continue;
  if(![b.o,b.h,b.l,b.c].every(x=>Number.isFinite(x)&&x>0))continue;
  byDate.set(b.d,{d:b.d,o:b.o,h:b.h,l:b.l,c:b.c,v:Number.isFinite(b.v)?b.v:0});
 }
 return [...byDate.values()].sort((a,b)=>a.d<b.d?-1:1);
}

export function barsFile(dataDir){return path.join(dataDir,'robinhood-equities','bars.json')}
export function readBarStore(dataDir){
 try{const v=JSON.parse(fs.readFileSync(barsFile(dataDir),'utf8'));if(v&&v.version===1&&v.bars)return v}catch{}
 return {version:1,provider:null,fetchedAt:null,lastSession:null,bars:{},lastError:null,lastAttemptAt:null};
}
export function writeJsonAtomic(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value));renameSyncWithRetry(tmp,file);
}
// Freshness against the calendar: FRESH (every symbol has the last completed session), STALE, NO_DATA.
export function dataStatus(store,symbols,now=Date.now(),env=process.env){
 const p=providerFor(env);
 const last=lastCompletedSession(now);
 const have=symbols.map(s=>store.bars?.[s]?.at(-1)?.d||null);
 let status='FRESH';
 if(!p||!p.configured(env))status='NO_DATA';
 else if(have.some(d=>!d))status=store.lastError?'ERROR':'NO_DATA';
 else if(!last||have.some(d=>d<last))status=store.lastError?'ERROR':'STALE';
 return {status,provider:p?.id||'none',providerLabel:p?.label||'no provider configured',keyless:p?p.keyless:null,configured:!!(p&&p.configured(env)),termsNote:p?.termsNote||null,
  lastCompletedSession:last,latestBar:have.every(Boolean)?have.reduce((a,b)=>a<b?a:b):null,fetchedAt:store.fetchedAt,lastAttemptAt:store.lastAttemptAt,lastError:store.lastError,
  robinhoodQuotes:false,source:'public end-of-day bars, not Robinhood quotes',
  reason:status==='NO_DATA'&&(!p||!p.configured(env))?'No allowed data source configured. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY (free Alpaca Basic key) in .env and restart.':null};
}

// Full refetch each refresh: adjusted history is rewritten by every split/dividend, so it is never treated as append-only.
// Budget: at most one attempt per new completed session, retried no sooner than retryMs after an error.
export async function refreshBars(dataDir,symbols,{now=Date.now(),env=process.env,fetchImpl=globalThis.fetch,lookbackDays=800,retryMs=15*60000,force=false}={}){
 const store=readBarStore(dataDir);const p=providerFor(env);
 if(!p||!p.configured(env))return {store,fetched:false,reason:'NO_DATA'};
 const last=lastCompletedSession(now);if(!last)return {store,fetched:false,reason:'CALENDAR'};
 const upToDate=symbols.every(s=>store.bars?.[s]?.at(-1)?.d>=last)&&store.provider===p.id;
 if(!force&&upToDate)return {store,fetched:false,reason:'FRESH'};
 if(!force&&store.lastAttemptAt&&now-Date.parse(store.lastAttemptAt)<retryMs)return {store,fetched:false,reason:'BUDGET'};
 const startMs=Math.max(Date.parse(CALENDAR_START+'T00:00:00Z'),now-lookbackDays*86400000);
 store.lastAttemptAt=new Date(now).toISOString();
 try{
  const raw=await p.fetchDailyBars(symbols.filter(validSymbol),{start:new Date(startMs).toISOString().slice(0,10),fetchImpl,env});
  const bars={};for(const s of symbols)bars[s]=cleanBars(raw[s],{completedThrough:last});
  Object.assign(store,{provider:p.id,fetchedAt:new Date(now).toISOString(),lastSession:last,bars,lastError:null});
  writeJsonAtomic(barsFile(dataDir),store);
  return {store,fetched:true,reason:'OK'};
 }catch(e){
  store.lastError={at:new Date(now).toISOString(),code:e?.code||'FETCH',message:String(e?.message||e).slice(0,200)};
  try{writeJsonAtomic(barsFile(dataDir),store)}catch{}
  return {store,fetched:false,reason:'ERROR'};
 }
}
