import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { lateGameEstimate, comboCapacity, TURNOVER_TARGET_MINUTES } from './sportsTiming.js';
import { renameSyncWithRetry, writeFileSynced } from './atomicRename.js';
import { MarketAdapter, OrderSimulator, frictionConfigFor } from './core/paperTrading.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||path.join(ROOT,'data'));
const STATE_FILE=path.join(DATA_DIR,'polymarket-paper.json');
const GAMMA=process.env.POLYMARKET_GAMMA_URL||'https://gamma-api.polymarket.com';
const CLOB=process.env.POLYMARKET_CLOB_URL||'https://clob.polymarket.com';
const SPORTS_WS=process.env.POLYMARKET_SPORTS_WS||'wss://sports-api.polymarket.com/ws';
const AUTOSTART=String(process.env.POLYMARKET_AUTOSTART??'true').toLowerCase()!=='false';
let cache={at:0,markets:[],error:null,lastSuccessAt:0,failures:0,lastAttemptAt:0,sources:{events:0,games:0,pages:0}};
let feedBusy=null;
let settlementBusy=null;
let settlementCache={at:0,result:null,busy:null};
const sportsLive=new Map();
const endedGames=new Map();
const bookCache=new Map();
let bookFeed={at:0,error:null,batch:true,tokens:0};
let booksBusy=null,lastTokens=[];
let candidateDiagnostics={at:0,total:0,accepted:0,rejections:{}};
let autopilotBusy=null,autopilotTimer=null,bookTimer=null;
let sportsSocket=null,sportsReconnect=null,sportsFeed={connected:false,lastMessageAt:0,error:null};
const FEED_TTL_MS=Math.max(3000,Number(process.env.POLYMARKET_FEED_TTL_MS||10000));
const STALE_OK_MS=Math.max(FEED_TTL_MS,Number(process.env.POLYMARKET_STALE_OK_MS||120000));
const FETCH_TIMEOUT_MS=Math.max(1500,Number(process.env.POLYMARKET_FETCH_TIMEOUT_MS||6000));
const BOOK_TTL_MS=Math.max(500,Number(process.env.POLYMARKET_BOOK_TTL_MS||2500));
const BOOK_FRESH_MS=15000;
const BOOK_TOKEN_CAP=60;
const LIVE_PAGES=Math.max(1,Math.min(20,Number(process.env.POLYMARKET_LIVE_PAGES||5)));
const LIVE_PAGE_LIMIT=100;
const SPORTS_PRUNE_MS=6*3600*1000;
const AUTOPILOT_TICK_MS=5000;
const AUTOPILOT_COOLDOWN_MS=3*60*1000;
const AUTOPILOT_MAX_FRESHNESS_SEC=90;
const SETTLEMENT_THROTTLE_MS=30000;
const RESOLVE_WIN_PX=1;
const RESOLVE_LOSE_PX=0;
const MARK_LOSE_BID=0.02;
const MARK_LOSE_ENDED_BID=0.05;
const OVERDUE_GRACE_MS=2*3600*1000;
const FAST_COMBO_OVERDUE_GRACE_MS=30*60*1000;
const FAST_SINGLE_OVERDUE_GRACE_MS=60*60*1000;
const MIN_EV_SAMPLES=12;
const STALE_TIMEOUT_MS=6*3600*1000;
const MISSING_VOID_MS=48*3600*1000; // diagnostic threshold only; missing data never refunds a stake
const FEE_MODEL='docs:C*rate*p*(1-p) sports_fees_v3';
const DEFAULT_FEE_RATE=0.05;
const DEFAULT_FEE_EXPONENT=1;
const BUCKET_EDGES=[[.78,.85],[.85,.90],[.90,.95],[.95,.99]];
const AUTOPILOT_MODES=['both','singles','combos'];

const DEFAULT_PAPER_BANKROLL_USD=25;
const PAPER_DEFAULTS_VERSION=2;
let clockNow=null;
const nowMs=()=>clockNow?clockNow():Date.now();
const num=v=>Number.isFinite(Number(v))?Number(v):0;
const arr=v=>{try{return Array.isArray(v)?v:JSON.parse(v||'[]')}catch{return []}};
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const round2=v=>Math.round((num(v)+Number.EPSILON)*100)/100;
const round5=v=>Math.round((num(v)+Number.EPSILON)*1e5)/1e5;
const envNum=(key,fallback)=>{const v=Number(process.env[key]);return Number.isFinite(v)?v:fallback};

function defaultAutopilot(){
 const mode=String(process.env.POLYMARKET_AUTOPILOT_MODE||'both').toLowerCase();
 return {enabled:String(process.env.POLYMARKET_AUTOPILOT||'').toLowerCase()!=='false',mode:AUTOPILOT_MODES.includes(mode)?mode:'both',
  stakeSingleUsd:clamp(envNum('POLYMARKET_STAKE_SINGLE_USD',1),.01,1000),stakeComboUsd:clamp(envNum('POLYMARKET_STAKE_COMBO_USD',2.5),.01,1000),
  maxOpenPct:clamp(envNum('POLYMARKET_MAX_OPEN_PCT',65),1,100),lastRunAt:0,lastAction:null,placedCount:0,skipped:[]};
}
function autopilotSettings(s={}){
 const d=defaultAutopilot(),a=s.autopilot&&typeof s.autopilot==='object'?s.autopilot:{};
 const mode=String(a.mode||d.mode).toLowerCase();
 return {enabled:a.enabled===undefined?d.enabled:!!a.enabled,mode:AUTOPILOT_MODES.includes(mode)?mode:'both',
  stakeSingleUsd:clamp(num(a.stakeSingleUsd)||d.stakeSingleUsd,.01,1000),stakeComboUsd:clamp(num(a.stakeComboUsd)||d.stakeComboUsd,.01,1000),
  maxOpenPct:clamp(num(a.maxOpenPct)||d.maxOpenPct,1,100),lastRunAt:num(a.lastRunAt),lastAction:a.lastAction||null,
  placedCount:num(a.placedCount),skipped:Array.isArray(a.skipped)?a.skipped.slice(0,20):[]};
}
function defaultState(){return {mode:'PAPER',pnlMode:'PAPER',cashUsd:DEFAULT_PAPER_BANKROLL_USD,startUsd:DEFAULT_PAPER_BANKROLL_USD,positions:[],history:[],autopilot:defaultAutopilot(),bankrollDefaultsVersion:PAPER_DEFAULTS_VERSION,createdAt:nowMs()}}
function normalizePaper(s){
 s.mode='PAPER';s.pnlMode='PAPER';
 s.positions=(s.positions||[]).map(p=>p&&typeof p==='object'?{...p,mode:'PAPER',pnlMode:'PAPER',kind:p.kind||'combo'}:p).filter(Boolean);
 s.history=(s.history||[]).map(h=>h&&typeof h==='object'?{...h,mode:'PAPER',pnlMode:'PAPER',kind:h.kind||'combo'}:h).filter(Boolean);
 s.autopilot=autopilotSettings(s);
 return s;
}
function loadPaper(){
 try{
  const raw=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
  const s={...defaultState(),...raw};
  if(Number(raw.bankrollDefaultsVersion||0)<PAPER_DEFAULTS_VERSION){
   s.bankrollDefaultsVersion=PAPER_DEFAULTS_VERSION;
   if(!(s.positions||[]).length&&!(s.history||[]).length&&Number(s.cashUsd)===1000&&Number(s.startUsd)===1000){s.cashUsd=DEFAULT_PAPER_BANKROLL_USD;s.startUsd=DEFAULT_PAPER_BANKROLL_USD}
   savePaper(normalizePaper(s));
  }
  return normalizePaper(s);
 }catch(e){
  if(e?.code==='ENOENT')return normalizePaper(defaultState());
  return normalizePaper({...defaultState(),cashUsd:0,startUsd:0,recoveryRequired:true,recoveryError:`STATE RECOVERY REQUIRED: ${e?.message||e}`,autopilot:{...defaultAutopilot(),enabled:false}});
 }
}
function savePaper(s){
 const dir=path.dirname(STATE_FILE);fs.mkdirSync(dir,{recursive:true});
 const tmp=path.join(dir,`.polymarket-paper.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}.tmp`);
 try{writeFileSynced(tmp,JSON.stringify(s,null,2));renameSyncWithRetry(tmp,STATE_FILE)}
 catch(e){try{fs.rmSync(tmp,{force:true})}catch{}throw e}
 return s;
}
function ensurePaperBankroll(s=loadPaper()){if(s.recoveryRequired)return s;if(Number(s.cashUsd||0)<0.25&&!(s.positions||[]).length){s.cashUsd=DEFAULT_PAPER_BANKROLL_USD;s.startUsd=DEFAULT_PAPER_BANKROLL_USD;s.autoResets=Number(s.autoResets||0)+1;s.lastAutoResetAt=nowMs();s.lastAutoResetReason='paper bankroll depleted';savePaper(s)}return s}

// ---------------------------------------------------------------- live state
function pruneSportsLive(now=Date.now()){
 for(const [id,g] of sportsLive){
  if(g.ended===true){endedGames.set(id,now);sportsLive.delete(id);continue}
  if(now-Number(g.receivedAt||0)>SPORTS_PRUNE_MS)sportsLive.delete(id);
 }
 for(const [id,at] of endedGames)if(now-at>SPORTS_PRUNE_MS)endedGames.delete(id);
 if(endedGames.size>500){const keys=[...endedGames.keys()].slice(0,endedGames.size-500);for(const k of keys)endedGames.delete(k)}
}
function absorbLiveState(next){
 if(!next||next.gameId==null)return;
 const id=String(next.gameId),now=Date.now();
 const incoming={};for(const [k,v] of Object.entries(next))if(v!==undefined)incoming[k]=v;
 incoming.gameId=id;incoming.lastUpdate=Number(next.lastUpdate)||now;incoming.receivedAt=now;
 const prev=sportsLive.get(id);
 if(!prev){sportsLive.set(id,incoming);pruneSportsLive(now);return}
 const older=Number(prev.lastUpdate||0)>incoming.lastUpdate;
 const merged=older?{...incoming,...stripEmpty(prev),receivedAt:now}:{...prev,...incoming};
 sportsLive.set(id,merged);pruneSportsLive(now);
}
function stripEmpty(o){const out={};for(const [k,v] of Object.entries(o||{}))if(v!==undefined&&v!==null&&v!=='')out[k]=v;return out}
function liveUsable(g,now=Date.now()){
 if(!g)return false;
 if(g.ended===true)return false;
 if(String(g.period||'').toUpperCase()==='SUS')return false;
 if(g.startTime){const t=Date.parse(g.startTime);if(Number.isFinite(t)&&t>now)return false}
 return g.live===true;
}
function gameEnded(gameId){const id=String(gameId||'');if(!id)return false;const g=sportsLive.get(id);if(g)return g.ended===true;return endedGames.has(id)}

function absorbSportsMessage(msg){
 if(!msg||typeof msg!=='object'||msg.gameId==null)return;
 const state=msg.eventState&&typeof msg.eventState==='object'?msg.eventState:{};
 const lastUpdate=Date.parse(state.updatedAt||msg.last_update||msg.lastUpdate||'')||Date.now();
 absorbLiveState({gameId:msg.gameId,leagueAbbreviation:msg.leagueAbbreviation||null,homeTeam:msg.homeTeam||null,awayTeam:msg.awayTeam||null,status:msg.status||null,
  live:(msg.live??state.live)===true,ended:(msg.ended??state.ended)===true,score:msg.score??state.score??null,period:msg.period??state.period??null,
  elapsed:msg.elapsed??state.elapsed??null,lastUpdate,source:'ws'});
 sportsFeed.lastMessageAt=Date.now();
}
function scheduleSportsReconnect(error){
 sportsFeed.connected=false;if(error)sportsFeed.error=String(error.message||error);
 clearTimeout(sportsReconnect);sportsReconnect=setTimeout(startSportsFeed,3000);sportsReconnect.unref?.();
}
function startSportsFeed(){
 if(sportsSocket&&(sportsSocket.readyState===WebSocket.OPEN||sportsSocket.readyState===WebSocket.CONNECTING))return;
 clearTimeout(sportsReconnect);const ws=new WebSocket(SPORTS_WS);sportsSocket=ws;
 ws.on('open',()=>{sportsFeed={connected:true,lastMessageAt:sportsFeed.lastMessageAt,error:null}});
 ws.on('message',raw=>{const text=raw.toString();if(text.toLowerCase()==='ping'){if(ws.readyState===WebSocket.OPEN)ws.send('pong');return}try{const msg=JSON.parse(text);if(msg?.type==='ping'){if(ws.readyState===WebSocket.OPEN)ws.send('pong');return}if(Array.isArray(msg))msg.forEach(absorbSportsMessage);else absorbSportsMessage(msg)}catch{}});
 ws.on('close',()=>{if(sportsSocket===ws)sportsSocket=null;scheduleSportsReconnect()});
 ws.on('error',e=>{sportsFeed.error=String(e.message||e)});
}

// ------------------------------------------------------------------ fee model
export function takerFeePerShare(price,market){
 const p=num(price);if(!(p>0&&p<1))return 0;
 if(market&&market.feesEnabled===false)return 0;
 const sched=market&&typeof market.feeSchedule==='object'?market.feeSchedule:null;
 const schedRate=sched?Number(sched.rate):NaN;
 const base=Number(market?.takerBaseFee);
 const rate=Number.isFinite(schedRate)&&schedRate>=0?schedRate:(Number.isFinite(base)&&base>0?base/10000:DEFAULT_FEE_RATE);
 const schedExp=sched?Number(sched.exponent):NaN;
 const exp=Number.isFinite(schedExp)&&schedExp>0?schedExp:DEFAULT_FEE_EXPONENT;
 return Math.max(0,rate*Math.pow(p,exp)*Math.pow(1-p,exp));
}
const legFillPrice=l=>num(l&&l.fillPrice!=null?l.fillPrice:l&&l.price);
export function applyFees(legs,stakeUsd){
 const stake=Math.max(0,num(stakeUsd));
 const detail=(legs||[]).map(l=>{
  const price=legFillPrice(l),feePerShare=takerFeePerShare(price,l);
  return {marketId:l&&l.marketId!=null?String(l.marketId):null,price,feePerShare,effectivePrice:clamp(price+feePerShare,0,1)};
 }).filter(x=>x.price>0&&x.price<1);
 const grossProbability=detail.reduce((a,x)=>a*x.price,1);
 const effectiveProduct=detail.reduce((a,x)=>a*x.effectivePrice,1);
 const shares=effectiveProduct>0?stake/effectiveProduct:0;
 const feePerShareTotal=detail.reduce((a,x)=>a+x.feePerShare,0);
 return {legs:detail,grossProbability,effectiveProduct,shares,feePerShareTotal,feeUsd:round5(shares*feePerShareTotal),model:FEE_MODEL};
}
export function comboQuote(legs,stakeUsd){
 const stake=Math.max(0,num(stakeUsd)),f=applyFees(legs,stake);
 const probability=f.grossProbability,grossOdds=probability>0?1/probability:0;
 const decimalOdds=f.effectiveProduct>0?1/f.effectiveProduct:0;
 const payout=stake*decimalOdds,grossPayout=stake*grossOdds;
 return {legs:f.legs.length,probability,decimalOdds,payout,profit:payout-stake,stakeUsd:stake,feeUsd:f.feeUsd,
  gross:{decimalOdds:grossOdds,payout:grossPayout,profit:grossPayout-stake}};
}

// ---------------------------------------------------------------- normalizing
function normalizeMarket(event,m){
 const prices=arr(m.outcomePrices).map(num),outcomes=arr(m.outcomes),tokens=arr(m.clobTokenIds);
 if(!prices.length)return null;
 let pickIndex=0;for(let i=1;i<prices.length;i++)if(prices[i]>prices[pickIndex])pickIndex=i;
 const bb=m.bestBid==null?NaN:Number(m.bestBid),ba=m.bestAsk==null?NaN:Number(m.bestAsk);
 const twoWay=outcomes.length===2&&prices.length===2&&pickIndex<2;
 const hasBook=twoWay&&Number.isFinite(bb)&&Number.isFinite(ba)&&ba>0&&ba<=1&&bb>=0;
 let ask=prices[pickIndex],bid=0,priceSource='mid',spread=null;
 if(hasBook){
  if(pickIndex===0){ask=ba;bid=bb}else{ask=clamp(1-bb,0,1);bid=clamp(1-ba,0,1)}
  priceSource='gamma';spread=Math.max(0,ask-bid);
 }
 const tickSize=num(m.orderPriceMinTickSize)||0.01;
 return {eventId:event.id,event:event.title,slug:event.slug,gameId:event.gameId!=null?String(event.gameId):(m.gameId!=null?String(m.gameId):null),marketId:m.id,question:m.question,
  live:event.live===true,period:event.period??null,score:event.score??null,elapsed:event.elapsed??null,sport:event.sport?.name||event.sport?.sport||null,
  endDate:m.endDate||event.endDate,gameStartTime:m.gameStartTime||event.gameStartTime||null,type:m.sportsMarketType||null,comboStatus:m.comboStatus||'unknown',acceptingOrders:!!m.acceptingOrders,
  price:ask,bid,ask,spread,priceSource,tickSize,makerQuote:bid>0?clamp(bid+tickSize,0,1):null,
  liquidity:num(m.liquidity),volume24h:num(m.volume24hr),tokenId:tokens[pickIndex]||null,tokenIds:tokens.map(t=>t==null?null:String(t)),outcomes:outcomes.map(x=>String(x)),
  feesEnabled:m.feesEnabled!==false,feeSchedule:m.feeSchedule&&typeof m.feeSchedule==='object'?{rate:num(m.feeSchedule.rate),exponent:num(m.feeSchedule.exponent)||DEFAULT_FEE_EXPONENT,takerOnly:m.feeSchedule.takerOnly!==false}:null,
  takerBaseFee:num(m.takerBaseFee),
  outcome:String(outcomes[pickIndex]??pickIndex),outcomeIndex:pickIndex,closed:!!m.closed,resolved:m.closed?prices[pickIndex]===1:null};
}

// --------------------------------------------------------------- gamma feed
function teamsFromEvent(e){
 const teams=Array.isArray(e?.teams)?e.teams:[];
 const home=teams.find(t=>String(t?.ordering||'').toLowerCase()==='home')||teams[0]||null;
 const away=teams.find(t=>String(t?.ordering||'').toLowerCase()==='away')||teams[1]||null;
 if(home?.name||away?.name)return {homeTeam:home?.name||null,awayTeam:away?.name||null,league:home?.league||away?.league||null};
 const parts=String(e?.title||'').split(/\s+vs\.?\s+/i);
 return {homeTeam:parts[0]?.trim()||null,awayTeam:parts[1]?.trim()||null,league:null};
}
function seedLiveFromEvents(events){
 const now=Date.now();
 for(const e of events||[]){
  if(e?.gameId==null)continue;
  const t=teamsFromEvent(e);
  absorbLiveState({gameId:e.gameId,leagueAbbreviation:e.sport?.sport||t.league||e.sport?.name||null,homeTeam:t.homeTeam,awayTeam:t.awayTeam,
   live:e.live===true,ended:e.ended===true,score:e.score??null,period:e.period??null,elapsed:e.elapsed??null,startTime:e.startTime||null,
   sport:e.sport?.name||null,status:e.period||null,lastUpdate:now,source:'gamma'});
 }
}
async function fetchLiveEvents(){
 const events=[];let pages=0;
 for(let p=0;p<LIVE_PAGES;p++){
  const url=`${GAMMA}/events?active=true&closed=false&live=true&limit=${LIVE_PAGE_LIMIT}&offset=${p*LIVE_PAGE_LIMIT}`;
  const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
  if(!r.ok)throw new Error(`Gamma ${r.status}`);
  const j=await r.json(),page=Array.isArray(j)?j:[];
  pages++;events.push(...page);
  if(page.length<LIVE_PAGE_LIMIT)break;
 }
 return {events,pages};
}
export async function polymarketMarkets(force=false){
 if(feedBusy)return feedBusy;
 feedBusy=refreshMarkets(force);
 try{return await feedBusy}finally{feedBusy=null}
}
async function refreshMarkets(force=false){
 const now=Date.now();
 if(!force&&cache.lastSuccessAt&&now-cache.at<FEED_TTL_MS)return cache;
 cache.lastAttemptAt=now;let lastError=null;
 for(let attempt=0;attempt<3;attempt++){
  try{
   const {events,pages}=await fetchLiveEvents();
   seedLiveFromEvents(events);
   const byMarket=new Map();
   for(const e of events)for(const m of (e.markets||[])){const x=normalizeMarket(e,m);if(x&&x.acceptingOrders&&x.price>0&&x.price<1)byMarket.set(String(x.marketId),x)}
   const markets=[...byMarket.values()];
   markets.sort((a,b)=>(b.price-a.price)||(b.liquidity-a.liquidity));
   const games=new Set(events.map(e=>e?.gameId!=null?String(e.gameId):null).filter(Boolean)).size;
   cache={at:Date.now(),markets,error:null,lastSuccessAt:Date.now(),failures:0,lastAttemptAt:now,sources:{events:events.length,games,pages}};
   return cache;
  }catch(e){lastError=e;if(attempt<2)await new Promise(r=>{const t=setTimeout(r,250*(2**attempt));t.unref?.()})}
 }
 const failures=Number(cache.failures||0)+1;
 cache={...cache,at:Date.now(),error:String(lastError?.message||lastError||'feed unavailable'),failures,lastAttemptAt:now};
 return cache;
}

// ---------------------------------------------------------------- clob books
function normalizeBook(b){
 const levels=side=>(Array.isArray(b?.[side])?b[side]:[]).map(l=>({price:num(l?.price),size:num(l?.size)})).filter(l=>l.price>0&&l.price<=1&&l.size>0);
 const asks=levels('asks').sort((x,y)=>x.price-y.price),bids=levels('bids').sort((x,y)=>y.price-x.price);
 return {asks:asks.slice(0,40),bids:bids.slice(0,40),ask:asks.length?asks[0].price:null,bid:bids.length?bids[0].price:null,
  tickSize:num(b?.tick_size)||null,at:nowMs()};
}
export function fillQuote(asks,stakeUsd){
 const levels=(Array.isArray(asks)?asks:[]).filter(l=>num(l?.price)>0&&num(l?.size)>0).map(l=>({price:num(l.price),size:num(l.size)})).sort((a,b)=>a.price-b.price);
 const askDepthUsd=levels.reduce((a,l)=>a+l.price*l.size,0),best=levels.length?levels[0].price:null,stake=Math.max(0,num(stakeUsd));
 if(!best||!stake)return {fillPrice:best,askDepthUsd,sharesFilled:0};
 let got=0,cost=0;
 for(const l of levels){const take=Math.min(l.size,(stake-cost)/l.price);if(take<=0)break;got+=take;cost+=take*l.price;if(cost>=stake-1e-9)break}
 if(cost<stake-1e-9)return {fillPrice:null,askDepthUsd,sharesFilled:got};
 return {fillPrice:cost/got,askDepthUsd,sharesFilled:got};
}

export function sellQuote(bids,shares,market){
 const levels=(Array.isArray(bids)?bids:[]).map(l=>({price:num(l.price),size:num(l.size)}))
  .filter(l=>l.price>0&&l.price<=1&&l.size>0).sort((a,b)=>b.price-a.price);
 if(!(shares>0))return null;
 let sold=0,gross=0,fees=0;
 for(const l of levels){const take=Math.min(l.size,shares-sold);if(take<=0)break;sold+=take;gross+=take*l.price;fees+=take*takerFeePerShare(l.price,market);}
 if(sold<shares-1e-9)return null;
 return {price:gross/sold,payout:Math.max(0,gross-fees),fees,shares:sold};
}
function capBookCache(keep){
 const keepSet=new Set((keep||[]).map(String));
 for(const id of [...bookCache.keys()])if(keepSet.size&&!keepSet.has(id))bookCache.delete(id);
 if(bookCache.size>BOOK_TOKEN_CAP){
  const oldest=[...bookCache.entries()].sort((a,b)=>Number(a[1].at)-Number(b[1].at)).slice(0,bookCache.size-BOOK_TOKEN_CAP);
  for(const [id] of oldest)bookCache.delete(id);
 }
}
async function fetchBooks(tokenIds){
 const ids=[...new Set((tokenIds||[]).filter(Boolean).map(String))].slice(0,BOOK_TOKEN_CAP);
 if(!ids.length)return {books:0,error:null};
 try{
  const r=await fetch(`${CLOB}/books`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},
   body:JSON.stringify(ids.map(token_id=>({token_id}))),signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
  if(!r.ok)throw new Error(`CLOB ${r.status}`);
  const j=await r.json(),list=Array.isArray(j)?j:(j&&typeof j==='object'?[j]:[]);
  let n=0;
  for(const b of list){const id=b?.asset_id!=null?String(b.asset_id):'';if(!id)continue;bookCache.set(id,normalizeBook(b));n++}
  capBookCache(ids);
  bookFeed={at:nowMs(),error:null,batch:true,tokens:bookCache.size};
  return {books:n,error:null};
 }catch(e){
  const error=String(e?.message||e);
  bookFeed={...bookFeed,error,tokens:bookCache.size};
  return {books:0,error};
 }
}
async function refreshBooksIfStale(force=false){
 const ids=lastTokens.slice(0,BOOK_TOKEN_CAP);
 if(!ids.length)return {books:0,error:null,skipped:true};
 if(!force&&Date.now()-Number(bookFeed.at||0)<BOOK_TTL_MS)return {books:0,error:null,skipped:true};
 if(booksBusy)return booksBusy;
 booksBusy=fetchBooks(ids).finally(()=>{booksBusy=null});
 return booksBusy;
}

export async function polymarketEvidenceSnapshot({marketLimit=30}={}){
 const feed=await polymarketMarkets(true), at=nowMs();
 const markets=[...(feed.markets||[])].filter(m=>Array.isArray(m.tokenIds)&&m.tokenIds.some(Boolean))
  .sort((a,b)=>(num(b.liquidity)-num(a.liquidity))||(num(b.volume24h)-num(a.volume24h))).slice(0,Math.max(1,Math.min(30,Number(marketLimit)||30)));
 const tokenIds=markets.flatMap(m=>m.tokenIds||[]).filter(Boolean).slice(0,BOOK_TOKEN_CAP);
 await fetchBooks(tokenIds);
 const records=[];
 for(const m of markets){
  for(let i=0;i<(m.tokenIds||[]).length;i++){
   const tokenId=String(m.tokenIds[i]||''); if(!tokenId)continue;
   const book=bookCache.get(tokenId); if(!book)continue;
   records.push({
    ts:Number(book.at||at),marketId:String(m.marketId),eventId:String(m.eventId||''),gameId:m.gameId||null,event:m.event||null,question:m.question||null,
    tokenId,outcome:String(m.outcomes?.[i]??i),outcomeIndex:i,endDate:m.endDate||null,gameStartTime:m.gameStartTime||null,type:m.type||null,
    live:m.live===true,period:m.period??null,score:m.score??null,elapsed:m.elapsed??null,sport:m.sport||null,
    bids:book.bids,asks:book.asks,bestBid:book.bid,bestAsk:book.ask,tickSize:book.tickSize,
    liquidity:num(m.liquidity),volume24h:num(m.volume24h),
    feeMeta:{feesEnabled:m.feesEnabled!==false,feeSchedule:m.feeSchedule||null,takerBaseFee:Number.isFinite(Number(m.takerBaseFee))?Number(m.takerBaseFee):null,source:'gamma-observed'},
    provenance:'observed-public-clob',selectionUse:false,
   });
  }
 }
 return {schema:'mpo.polymarket-depth-tape.v1',at,feedAt:Number(feed.lastSuccessAt||feed.at||0),records,
  coverage:{books:records.length,markets:markets.length,feesObserved:records.filter(r=>r.feeMeta?.feeSchedule||Number(r.feeMeta?.takerBaseFee)>0||r.feeMeta?.feesEnabled===false).length}};
}

// ------------------------------------------------------------ live heuristics
export function elapsedMinutes(v){
 const s=String(v??'').trim();if(!s)return null;
 const clock=s.match(/^(\d{1,3}):(\d{2})$/);if(clock)return round2(Number(clock[1])+Number(clock[2])/60);
 const stoppage=s.match(/^(\d{1,3})\s*\+\s*(\d{1,3})/);if(stoppage)return Number(stoppage[1])+Number(stoppage[2]);
 const n=Number(s.replace(/[^0-9.]/g,''));
 return Number.isFinite(n)&&s.replace(/[^0-9.]/g,'')!==''?round2(n):null;
}
// ---------------------------------------------------------------- candidates
function bucketFor(buckets,price){
 const p=round5(num(price));
 return (buckets||[]).find(b=>p>=b.lo&&(p<b.hi||(b.hi>=.99&&p<=b.hi)))||null;
}
function overlayBook(m,now,stakeUsd){
 const book=m.tokenId?bookCache.get(String(m.tokenId)):null;
 const fresh=book&&now-Number(book.at||0)<BOOK_FRESH_MS&&num(book.ask)>0&&num(book.ask)<1;
 if(!fresh)return {...m,fillPrice:null,askDepthUsd:0};
 const ask=num(book.ask),bid=num(book.bid);
 const fill=fillQuote(book.asks,stakeUsd);
 return {...m,ask,bid,price:ask,spread:Math.max(0,ask-bid),priceSource:'clob',
  tickSize:num(book.tickSize)||m.tickSize,makerQuote:bid>0?clamp(bid+(num(book.tickSize)||m.tickSize),0,1):null,
  fillPrice:fill.fillPrice,askDepthUsd:fill.askDepthUsd,bookAt:book.at};
}
function rejectCandidate(ctx,reason){ctx.rejections[reason]=Number(ctx.rejections[reason]||0)+1;return null}
function enrichCandidate(raw,now,ctx){
 const base=overlayBook(raw,now,ctx.stakeSingleUsd);
 const live=sportsLive.get(String(base.gameId||''));
 if(!liveUsable(live,now))return rejectCandidate(ctx,'not-live');
 const freshnessSec=Math.max(0,(now-Number(live.lastUpdate||live.receivedAt||now))/1000);if(freshnessSec>120)return rejectCandidate(ctx,'stale-live');
 const marketType=String(base.type||'').toLowerCase();
 const allowedType=!marketType||['moneyline','child_moneyline','match_winner','winner','spreads','spread','totals','total','first_half_totals','first_half_spread','first_half_spreads','soccer_halftime_result'].includes(marketType);
 if(!allowedType)return rejectCandidate(ctx,'market-type');
 const late=lateGameEstimate(base,live),spread=base.spread==null?null:Number(base.spread);
 if(late.nearEndScore<65)return rejectCandidate(ctx,late.reason||'not-near-settlement');
 if(late.etaMinutes==null||late.etaMinutes>TURNOVER_TARGET_MINUTES)return rejectCandidate(ctx,'turnover-window');
 if(base.price<.80||base.price>.985)return rejectCandidate(ctx,'price-band');
 if(base.liquidity<1000)return rejectCandidate(ctx,'liquidity');
 const spreadLimit=base.liquidity>=10000?.12:base.liquidity>=3000?.08:.05;
 if(spread!=null&&spread>spreadLimit+1e-9)return rejectCandidate(ctx,'spread');
 if(String(base.comboStatus).toLowerCase()==='disabled')return rejectCandidate(ctx,'combo-disabled');
 const eta=late.etaMinutes??35,priceFit=100-Math.abs(base.price-.90)*260,liq=Math.min(35,Math.log10(Math.max(1,base.liquidity))*8);
 const rank=late.nearEndScore*4+priceFit+liq-eta*8+(late.priorityBonus||0)-(spread??.02)*500;
 const basis=base.fillPrice!=null?base.fillPrice:base.ask;
 const perShare=takerFeePerShare(basis,base);
 const fee={enabled:base.feesEnabled!==false,rate:base.feeSchedule&&Number.isFinite(Number(base.feeSchedule.rate))?Number(base.feeSchedule.rate):(base.takerBaseFee>0?base.takerBaseFee/10000:DEFAULT_FEE_RATE),
  exponent:base.feeSchedule&&Number(base.feeSchedule.exponent)>0?Number(base.feeSchedule.exponent):DEFAULT_FEE_EXPONENT,
  perShare,pct:basis>0?perShare/basis:0,model:FEE_MODEL};
 const netPrice=basis>0?clamp(basis+perShare,0,1):null;
 const bucketRaw=bucketFor(ctx.buckets,basis);
 const bucket=bucketRaw?{lo:bucketRaw.lo,hi:bucketRaw.hi,n:bucketRaw.n,hitRate:bucketRaw.hitRate}:null;
 // Calibration is deliberately shrunk toward the executable quote until we have enough samples.
 // This prevents a tiny lucky bucket from inventing a huge edge while still letting the paper lab learn.
 const calibrationSamples=num(bucket?.n),observedHit=Number.isFinite(Number(bucket?.hitRate))?Number(bucket.hitRate):basis;
 const fairProbability=clamp((basis*30+observedHit*calibrationSamples)/(30+calibrationSamples),0.001,0.999);
 const edgeAfterFriction=netPrice==null?null:fairProbability-netPrice;
 const expectedRoi=netPrice&&netPrice>0?fairProbability/netPrice-1:null;
 const tick=num(base.tickSize)||.01,makerPrice=base.makerQuote!=null?num(base.makerQuote):null;
 const executionMode=eta>=3&&makerPrice>0&&base.ask>makerPrice&&spread>=tick*2?'MAKER_FIRST':'TAKER_NOW';
 const candidate={...base,liveState:{gameId:live.gameId,league:live.leagueAbbreviation||null,homeTeam:live.homeTeam||null,awayTeam:live.awayTeam||null,
   score:live.score??null,period:live.period??null,elapsed:live.elapsed??null,startTime:live.startTime||null,source:live.source||'ws',lastUpdate:live.lastUpdate},
  freshnessSec,nearEndScore:late.nearEndScore,etaMinutes:eta,lateReason:late.reason,spreadLimit,rank,fee,netPrice,bucket,
  fairProbability,edgeAfterFriction,expectedRoi,calibrationSamples,executionMode,makerPrice};
 candidate.suggestedStakeUsd=suggestStake(candidate,ctx.paper,ctx.research).stakeUsd;
 return candidate;
}
function buildCandidates(markets,paper,research,now){
 const ap=autopilotSettings(paper);
 const ctx={paper,research,buckets:research.buckets,stakeSingleUsd:ap.stakeSingleUsd,rejections:{}};
 const all=(markets||[]).map(m=>enrichCandidate(m,now,ctx)).filter(Boolean).sort((a,b)=>b.rank-a.rank);
 candidateDiagnostics={at:Date.now(),total:(markets||[]).length,accepted:all.length,rejections:ctx.rejections};
 const candidates=all.slice(0,40);
 lastTokens=candidates.map(c=>c.tokenId).filter(Boolean).slice(0,BOOK_TOKEN_CAP);
 return candidates;
}
export function candidateEvGate(c,{combo=false}={}){
 const samples=num(c?.calibrationSamples),edge=Number(c?.edgeAfterFriction),roi=Number(c?.expectedRoi);
 const minEdge=(samples>=50?.003:samples>=25?.006:.012)+(combo?.003:0);
 if(samples<MIN_EV_SAMPLES)return {ok:false,reason:'ev-uncalibrated',samples,minEdge,edge,roi};
 if(!Number.isFinite(edge)||!Number.isFinite(roi))return {ok:false,reason:'ev-unknown',samples,minEdge,edge,roi};
 if(edge<minEdge||roi<=0)return {ok:false,reason:'negative-or-thin-ev',samples,minEdge,edge,roi};
 return {ok:true,reason:'positive-ev',samples,minEdge,edge,roi};
}
export function comboExpectedValue(legs=[]){
 const xs=(legs||[]).filter(Boolean);if(xs.length<2)return {ok:false,fairProbability:0,effectiveProbability:0,expectedRoi:-1};
 const fair=xs.reduce((a,c)=>a*clamp(num(c.fairProbability),0.001,.999),1);
 const effective=xs.reduce((a,c)=>a*clamp(num(c.netPrice)||num(c.fillPrice)||num(c.price),0.001,.999),1);
 const roi=effective>0?fair/effective-1:-1;
 return {ok:xs.every(c=>candidateEvGate(c,{combo:true}).ok)&&roi>=.025,fairProbability:fair,effectiveProbability:effective,expectedRoi:roi};
}
function chooseCombo(candidates,maxLegs=6){const out=[],events=new Set();const ranked=[...candidates].filter(c=>candidateEvGate(c,{combo:true}).ok).sort((a,b)=>(num(b.expectedRoi)-num(a.expectedRoi))||b.rank-a.rank);for(const c of ranked){const key=String(c.gameId||c.eventId||c.slug||c.event);if(events.has(key))continue;events.add(key);out.push(c);if(out.length>=maxLegs)break}return out}

// ------------------------------------------------------------------- research
function summarizeGroup(closed,open){
 const pnl=closed.reduce((a,x)=>a+num(x.pnlUsd),0),risked=closed.reduce((a,x)=>a+num(x.stakeUsd),0);
 const wins=closed.filter(x=>x.status?x.status==='WON':num(x.pnlUsd)>0).length;
 const losses=closed.filter(x=>x.status?x.status==='LOST':num(x.pnlUsd)<=0).length;
 const decided=wins+losses;
 return {closed:closed.length,wins,losses,hitRate:decided?wins/decided:null,pnlUsd:pnl,roi:risked?pnl/risked:null,open};
}
function ticketEntryProbability(h){
 const stake=num(h?.stakeUsd),payout=num(h?.potentialPayoutUsd);
 if(stake>0&&payout>0)return clamp(stake/payout,.001,.999);
 const legs=h?.legs||[];if(!legs.length)return null;
 return clamp(legs.reduce((a,l)=>a*(num(l?.netPrice)||legFillPrice(l)||1),1),.001,.999);
}
function replayStats(rows=[]){
 const risk=rows.reduce((a,x)=>a+num(x.stakeUsd),0),pnl=rows.reduce((a,x)=>a+num(x.pnlUsd),0);
 const wins=rows.filter(x=>x.status==='WON').length,losses=rows.filter(x=>x.status==='LOST').length;
 const avgWin=wins?rows.filter(x=>x.status==='WON').reduce((a,x)=>a+num(x.pnlUsd),0)/wins:0;
 const avgLoss=losses?rows.filter(x=>x.status==='LOST').reduce((a,x)=>a+num(x.pnlUsd),0)/losses:0;
 let eq=0,peak=0,maxDrawdown=0;for(const x of rows){eq+=num(x.pnlUsd);peak=Math.max(peak,eq);maxDrawdown=Math.max(maxDrawdown,peak-eq)}
 return {n:rows.length,wins,losses,hitRate:wins+losses?wins/(wins+losses):null,pnlUsd:round5(pnl),roi:risk?pnl/risk:null,avgWin:round5(avgWin),avgLoss:round5(avgLoss),maxDrawdownUsd:round5(maxDrawdown)};
}
export function polymarketPolicyReplay(paper=loadPaper()){
 const rows=[...(paper.history||[])].filter(h=>['WON','LOST'].includes(String(h.status))&&Number.isFinite(Number(h.pnlUsd))&&Number.isFinite(Number(h.stakeUsd)))
  .sort((a,b)=>num(a.settledAt||a.createdAt)-num(b.settledAt||b.createdAt));
 const cut=Math.max(1,Math.floor(rows.length*.7)),trainRows=rows.slice(0,cut),testRows=rows.slice(cut);
 const caps=[.88,.90,.92,.94,.96,.98],modes=['singles','all'],policies=[];
 for(const mode of modes)for(const maxEntryProbability of caps){
  const keep=x=>(mode==='all'||x.kind==='single')&&num(ticketEntryProbability(x))<=maxEntryProbability;
  const train=replayStats(trainRows.filter(keep)),holdout=replayStats(testRows.filter(keep));
  if(train.n<10||holdout.n<4)continue;
  const robustRoi=Math.min(num(train.roi),num(holdout.roi));
  policies.push({mode,maxEntryProbability,train,holdout,robustRoi});
 }
 policies.sort((a,b)=>b.robustRoi-a.robustRoi||num(b.holdout.roi)-num(a.holdout.roi)||b.holdout.n-a.holdout.n);
 return {scope:'observed-ticket-policy-replay',samples:rows.length,trainSamples:trainRows.length,holdoutSamples:testRows.length,
  note:'Replays filters over tickets actually taken; useful for policy pruning, not a full opportunity-set backtest.',leaders:policies.slice(0,8)};
}
function calibrationEligible(h){
 if(!h||h.censored)return false;
 return String(h.settlementSource||'').toLowerCase().startsWith('gamma');
}
export function paperBuckets(history){
 const buckets=BUCKET_EDGES.map(([lo,hi])=>({lo,hi,mid:round2((lo+hi)/2),n:0,hits:0,hitRate:null,avgQuoted:null,pnlUsd:0,roi:null,_sum:0,_risk:0}));
 for(const h of history||[]){
  if(!calibrationEligible(h))continue;
  const legs=(h.legs||[]).filter(l=>l&&l.result);
  if(!legs.length)continue;
  const stakeShare=num(h.stakeUsd)/legs.length,pnlShare=num(h.pnlUsd)/legs.length;
  for(const l of legs){
   const price=legFillPrice(l),b=bucketFor(buckets,price);
   if(!b)continue;
   b.pnlUsd+=pnlShare;b._risk+=stakeShare;
   if(l.result==='void'||l.result==='pending')continue;
   b.n++;b._sum+=price;if(l.result==='won')b.hits++;
  }
 }
 return buckets.map(b=>({lo:b.lo,hi:b.hi,mid:b.mid,n:b.n,hits:b.hits,hitRate:b.n?b.hits/b.n:null,avgQuoted:b.n?b._sum/b.n:null,
  pnlUsd:round5(b.pnlUsd),roi:b._risk?b.pnlUsd/b._risk:null}));
}
export function positionAge(pos,now=nowMs()){
 const ageMs=Math.max(0,now-num(pos?.createdAt));
 const etaMinutes=Math.max(TURNOVER_TARGET_MINUTES,...((pos?.legs||[]).map(l=>num(l?.timing?.etaMinutes)||0)),0);
 const overdueGraceMs=pos?.kind==='combo'?FAST_COMBO_OVERDUE_GRACE_MS:FAST_SINGLE_OVERDUE_GRACE_MS;
 const overdue=ageMs>etaMinutes*60000+overdueGraceMs;
 return {id:pos?.id||null,kind:pos?.kind||null,stakeUsd:num(pos?.stakeUsd),ageMs,ageMinutes:round2(ageMs/60000),
  etaMinutes,overdueGraceMinutes:overdueGraceMs/60000,overdue,stale:ageMs>=STALE_TIMEOUT_MS,missingSince:pos?.missingSince||null,
  missingAgeMs:pos?.missingSince?Math.max(0,now-num(pos.missingSince)):null};
}
function percentile(sorted,q){if(!sorted.length)return null;return sorted[Math.min(sorted.length-1,Math.max(0,Math.round(q*(sorted.length-1))))]}
export function paperSettlementAudit(paper=loadPaper(),now=nowMs()){
 const history=(paper.history||[]).filter(x=>Number.isFinite(Number(x.stakeUsd)));
 const positions=paper.positions||[];
 const realizedPnlUsd=round5(history.reduce((a,x)=>a+num(x.pnlUsd),0));
 const realizedStakeUsd=round5(history.reduce((a,x)=>a+num(x.stakeUsd),0));
 const openStakeUsd=round5(positions.reduce((a,x)=>a+num(x.stakeUsd),0));
 const sources={};
 for(const h of history){const k=String(h.settlementSource||h.status||'unknown');sources[k]=Number(sources[k]||0)+1}
 const earlyExits=history.filter(h=>h.settlementSource==='early-exit').length;
 const gammaResolved=history.filter(h=>calibrationEligible(h)&&(h.status==='WON'||h.status==='LOST')).length;
 const tts=history.filter(h=>num(h.settledAt)&&num(h.createdAt)).map(h=>(num(h.settledAt)-num(h.createdAt))/60000).sort((a,b)=>a-b);
 const openAges=positions.map(p=>positionAge(p,now));
 const overdue=openAges.filter(x=>x.overdue);
 const overdueUsd=round5(overdue.reduce((a,x)=>a+num(x.stakeUsd),0));
 const censoredHaircut=round5(history.filter(h=>h.censored&&String(h.status).toUpperCase()!=='LOST').reduce((a,x)=>a+num(x.stakeUsd),0));
 const conservativePnlUsd=round5(realizedPnlUsd-openStakeUsd-censoredHaircut);
 const conservativeStakeUsd=round5(realizedStakeUsd+openStakeUsd);
 const realizedRoi=realizedStakeUsd?realizedPnlUsd/realizedStakeUsd:null;
 const conservativeRoi=conservativeStakeUsd?conservativePnlUsd/conservativeStakeUsd:null;
 const realizedWins=history.filter(h=>h.status==='WON').length;
 const realizedLosses=history.filter(h=>h.status==='LOST').length;
 const conservativeLosses=realizedLosses+positions.length+history.filter(h=>h.censored&&h.status!=='LOST').length;
 const conservativeHits=realizedWins;
 const conservativeDecided=conservativeHits+conservativeLosses;
 const quoted=[]
 for(const h of history)for(const l of h.legs||[]){const p=legFillPrice(l);if(p>0&&p<1)quoted.push(p)}
 for(const p of positions)for(const l of p.legs||[]){const px=legFillPrice(l);if(px>0&&px<1)quoted.push(px)}
 const quotedMean=quoted.length?quoted.reduce((a,x)=>a+x,0)/quoted.length:null;
 const totalTried=history.length+positions.length;
 const censoredFraction=totalTried?positions.length/totalTried:0;
 const exposureAdjustedEquityUsd=round5(num(paper.cashUsd)+openAges.reduce((a,x)=>a+(x.overdue?0:num(x.stakeUsd)),0));
 const equityAtCostUsd=round5(num(paper.cashUsd)+openStakeUsd);
 const hitRateLow=totalTried?realizedWins/totalTried:null;
 const hitRateHigh=totalTried?(realizedWins+positions.length)/totalTried:null;
 let verdict='COLLECTING',keep=false;
 const allEarly=history.length>=10&&earlyExits===history.length&&gammaResolved===0;
 if(overdue.length||allEarly)verdict=conservativePnlUsd<0?'DROP':'UNPROVEN_CENSORING';
 else if(gammaResolved>=20&&conservativeRoi>0&&!overdue.length){verdict='KEEP';keep=true}
 else if(history.length>=10&&conservativePnlUsd<0&&gammaResolved>=5)verdict='DROP';
 const pauseAutopilot=overdue.length>0||verdict==='DROP';
 return {realizedPnlUsd,realizedStakeUsd,realizedRoi,realizedHitRate:realizedWins+realizedLosses?realizedWins/(realizedWins+realizedLosses):null,
  conservativePnlUsd,conservativeStakeUsd,conservativeRoi,conservativeHitRate:conservativeDecided?conservativeHits/conservativeDecided:null,
  openStakeUsd,overdueUsd,overdueCount:overdue.length,censoredFraction,censoredHaircutUsd:censoredHaircut,
  earlyExits,gammaResolved,sources,quotedMean,hitRateBounds:{low:hitRateLow,high:hitRateHigh},
  timeToSettlement:{n:tts.length,min:tts.length?tts[0]:null,median:percentile(tts,.5),p90:percentile(tts,.9),max:tts.length?tts[tts.length-1]:null,
   mean:tts.length?tts.reduce((a,x)=>a+x,0)/tts.length:null},
  openAges,overdue,exposureAdjustedEquityUsd,equityAtCostUsd,verdict,keep,pauseAutopilot};
}
export function paperResearchMetrics(paper=loadPaper(),now=nowMs()){
 const history=(paper.history||[]).filter(x=>Number.isFinite(Number(x.stakeUsd)));
 const positions=paper.positions||[];
 const singlesClosed=history.filter(x=>x.kind==='single'),combosClosed=history.filter(x=>x.kind!=='single');
 const singlesOpen=positions.filter(x=>x.kind==='single').length,combosOpen=positions.length-singlesOpen;
 const totals=summarizeGroup(history,positions.length);
 const audit=paperSettlementAudit(paper,now);
 const feesPaidUsd=round5(history.reduce((a,x)=>a+num(x.feeUsd),0)+positions.reduce((a,x)=>a+num(x.feeUsd),0));
 return {...totals,equityUsd:audit.equityAtCostUsd,exposureAdjustedEquityUsd:audit.exposureAdjustedEquityUsd,
  drawdownFromStart:paper.startUsd?Math.max(0,(num(paper.startUsd)-audit.exposureAdjustedEquityUsd)/num(paper.startUsd)):0,
  singles:summarizeGroup(singlesClosed,singlesOpen),combos:summarizeGroup(combosClosed,combosOpen),
  buckets:paperBuckets(history),feesPaidUsd,realizedRoi:audit.realizedRoi,realizedHitRate:audit.realizedHitRate,
  conservativeRoi:audit.conservativeRoi,conservativeHitRate:audit.conservativeHitRate,verdict:audit.verdict,keep:audit.keep,
  policyReplay:polymarketPolicyReplay(paper),settlement:audit};
}
export function suggestStake(candidate,paper=loadPaper(),research=null){
 const ap=autopilotSettings(paper),base=clamp(num(ap.stakeSingleUsd)||1,.01,1000);
 const metrics=research||paperResearchMetrics(paper);
 const equity=Math.max(0,num(metrics.equityUsd)||num(paper.cashUsd));
 const quoted=candidate&&candidate.fillPrice!=null?num(candidate.fillPrice):num(candidate?.price);
 const perShare=candidate?.fee?.perShare!=null?num(candidate.fee.perShare):takerFeePerShare(quoted,candidate);
 const effective=candidate?.netPrice!=null?num(candidate.netPrice):clamp(quoted+perShare,0,1);
 const bucket=candidate?.bucket||bucketFor(metrics.buckets,quoted);
 const n=num(bucket?.n),hitRate=bucket&&Number.isFinite(Number(bucket.hitRate))?Number(bucket.hitRate):null;
 if(!bucket||n<50||hitRate==null||!(effective>0&&effective<1)||equity<=0)
  return {stakeUsd:round2(base),rationale:`flat $${base.toFixed(2)} · calibration n=${n||0} (<50)`};
 const edge=Math.max(0,hitRate-effective),f=edge/(1-effective);
 const raw=0.25*f*equity,stakeUsd=round2(clamp(raw,0.25,0.05*equity));
 return {stakeUsd,rationale:`quarter-Kelly · bucket ${bucket.lo}-${bucket.hi} n=${n} hit=${(hitRate*100).toFixed(1)}% edge=${(edge*100).toFixed(1)}pp`};
}

// ------------------------------------------------------------------- placing
function cleanLeg(x){
 const price=num(x.price),fillPrice=x.fillPrice!=null&&num(x.fillPrice)>0?num(x.fillPrice):price;
 return {marketId:String(x.marketId),eventId:x.eventId??null,gameId:x.gameId??null,event:x.event??null,slug:x.slug??null,question:x.question??null,
  timing:x.liveState?{etaMinutes:x.etaMinutes??null,reason:x.lateReason||null,period:x.liveState.period,score:x.liveState.score}:null,
  price,fillPrice,outcome:x.outcome||'Yes',outcomeIndex:Number.isFinite(Number(x.outcomeIndex))?Number(x.outcomeIndex):0,
  tokenId:x.tokenId?String(x.tokenId):null,priceSource:x.priceSource||'mid',tickSize:num(x.tickSize)||0.01,
  feesEnabled:x.feesEnabled!==false,feeSchedule:x.feeSchedule||null,takerBaseFee:num(x.takerBaseFee),
  fairProbability:x.fairProbability!=null&&Number.isFinite(Number(x.fairProbability))?Number(x.fairProbability):null,
  netPrice:x.netPrice!=null&&Number.isFinite(Number(x.netPrice))?Number(x.netPrice):null,edgeAfterFriction:x.edgeAfterFriction!=null&&Number.isFinite(Number(x.edgeAfterFriction))?Number(x.edgeAfterFriction):null,
  expectedRoi:x.expectedRoi!=null&&Number.isFinite(Number(x.expectedRoi))?Number(x.expectedRoi):null,calibrationSamples:num(x.calibrationSamples),
  askDepthUsd:num(x.askDepthUsd),bookAt:num(x.bookAt),freshnessSec:num(x.freshnessSec)};
}
function newPositionId(){return `poly_${Date.now()}_${Math.random().toString(36).slice(2,7)}`}
function simulatePaperLeg(leg,budgetUsd,seed){
 const price=num(leg.fillPrice),feePerShare=takerFeePerShare(price,leg),unit=Math.max(1e-9,price+feePerShare),qty=Math.max(0,num(budgetUsd)/unit),now=nowMs();
 const depthUsd=Math.max(0,num(leg.askDepthUsd)),depthQty=depthUsd>0?depthUsd/Math.max(price,1e-9):qty,cached=leg.tokenId?bookCache.get(String(leg.tokenId)):null;
 const cachedFresh=cached&&now-num(cached.at)<=BOOK_FRESH_MS&&Array.isArray(cached.asks)&&cached.asks.length;
 const asks=cachedFresh?cached.asks.map(x=>({price:num(x.price),quantity:num(x.size??x.quantity)})):[{price,quantity:depthQty}],at=cachedFresh?num(cached.at):(num(leg.bookAt)||now);
 const adapter=new MarketAdapter({venue:'polymarket',staleMs:BOOK_FRESH_MS});
 const market=adapter.normalize({symbol:String(leg.tokenId||leg.marketId),asks,bids:[],timestamp:at,source:cachedFresh?'clob-depth':'clob-derived'},{now});
 const friction=frictionConfigFor('polymarket',{overrides:{fee:{kind:'custom',compute:({quantity:q,price:p})=>q*takerFeePerShare(p,leg)},
  slippage:{kind:'depth'},maxStaleMs:BOOK_FRESH_MS,allowDepthPartial:true}});
 return new OrderSimulator().simulate({order:{side:'BUY',quantity:qty},market,friction,seed,now,mode:'PAPER'});
}
export function placePaperSingle({leg,stakeUsd,placedBy}={}){
 const stake=Number(stakeUsd);
 if(!leg||typeof leg!=='object'||leg.marketId==null||!String(leg.marketId).trim())throw new Error('Invalid market');
 if(!Number.isFinite(stake)||stake<.01)throw new Error('Enter a positive paper stake');
 const clean=cleanLeg(leg);
 if(!(clean.fillPrice>0&&clean.fillPrice<1))throw new Error('Invalid leg price');
 const s=loadPaper();
 if(stake>num(s.cashUsd))throw new Error('Insufficient paper cash');
 const sim=simulatePaperLeg(clean,stake,`poly-single:${clean.marketId}:${nowMs()}`);if(sim.status==='REJECTED')throw new Error(`Paper fill rejected: ${sim.reason}`);
 clean.fillPrice=sim.fillPrice;const cashDebit=round5(sim.gross+sim.feeUsd),shares=sim.filledQuantity,quote=comboQuote([clean],cashDebit);
 if(!(cashDebit>0&&shares>0))throw new Error('Paper fill produced no executable quantity');
 const pos={id:newPositionId(),createdAt:nowMs(),status:'OPEN',kind:'single',mode:'PAPER',stakeUsd:cashDebit,requestedStakeUsd:stake,shares,
  fillPrice:sim.fillPrice,feeUsd:round5(sim.feeUsd),decimalOdds:quote.decimalOdds,potentialPayoutUsd:shares,
  execution:{mode:'PAPER',status:sim.status,latencyMs:sim.latencyMs,fillRatio:sim.fillRatio,slippageBps:sim.slippageBps,fillAt:sim.fillAt},
  placedBy:placedBy||'manual',research:{expectedRoi:clean.expectedRoi,expectedValueUsd:Number.isFinite(clean.expectedRoi)?round5(cashDebit*clean.expectedRoi):null,edgeAfterFriction:clean.edgeAfterFriction,calibrationSamples:clean.calibrationSamples},legs:[clean]};
 s.cashUsd=round5(num(s.cashUsd)-cashDebit);s.positions.unshift(pos);savePaper(s);
 return {ok:true,position:pos,paper:s};
}
export function placePaperCombo({legs,stakeUsd,placedBy}={}){
 const stake=Number(stakeUsd);
 if(!Number.isFinite(stake)||stake<.01)throw new Error('Enter a positive paper stake');
 if(!Array.isArray(legs)||legs.length<2||legs.length>12)throw new Error('Combo requires 2-12 legs');
 if(legs.some(x=>!x||x.marketId==null||!String(x.marketId).trim()))throw new Error('Invalid market');
 if(new Set(legs.map(x=>String(x.marketId))).size!==legs.length)throw new Error('Choose different markets for each leg');
 if(legs.some(x=>!x.liveState||num(x.nearEndScore)<65))throw new Error('Combo legs must still be live near-settlement candidates');
 if(new Set(legs.map(x=>String(x.gameId||x.eventId||x.slug||x.event))).size!==legs.length)throw new Error('Auto-turnover combos use at most one leg per game');
 const clean=legs.map(cleanLeg);
 if(clean.some(x=>!(x.fillPrice>0&&x.fillPrice<1)))throw new Error('Invalid leg price');
 const s=loadPaper();
 if(stake>num(s.cashUsd))throw new Error('Insufficient paper cash');
 const sims=clean.map((leg,i)=>simulatePaperLeg(leg,stake,`poly-combo:${leg.marketId}:${i}:${nowMs()}`));
 if(sims.some(x=>x.status==='REJECTED'))throw new Error(`Paper combo fill rejected: ${sims.find(x=>x.status==='REJECTED').reason}`);
 const ratio=Math.min(1,...sims.map(x=>Math.max(0,num(x.fillRatio)))),effectiveStake=round5(stake*ratio);
 if(effectiveStake<.01)throw new Error('Paper combo partial fill is below the economical minimum');
 sims.forEach((sim,i)=>{clean[i].fillPrice=sim.fillPrice;clean[i].paperExecution={mode:'PAPER',status:sim.status,latencyMs:sim.latencyMs,fillRatio:sim.fillRatio,slippageBps:sim.slippageBps,fillAt:sim.fillAt}});
 const quote=comboQuote(clean,effectiveStake),priced=applyFees(clean,effectiveStake),ev=comboExpectedValue(clean),feeUsd=round5(priced.feeUsd);
 const pos={id:newPositionId(),createdAt:nowMs(),status:'OPEN',kind:'combo',mode:'PAPER',stakeUsd:effectiveStake,requestedStakeUsd:stake,shares:priced.shares,
  fillPrice:null,feeUsd,decimalOdds:quote.decimalOdds,potentialPayoutUsd:quote.payout,
  execution:{mode:'PAPER',status:ratio<.999999?'PARTIAL':'FILLED',fillRatio:ratio,latencyMs:Math.max(...sims.map(x=>x.latencyMs||0))},
  placedBy:placedBy||'manual',research:{expectedRoi:ev.expectedRoi,expectedValueUsd:round5(effectiveStake*ev.expectedRoi),fairProbability:ev.fairProbability,effectiveProbability:ev.effectiveProbability},legs:clean};
 s.cashUsd=round5(num(s.cashUsd)-effectiveStake);s.positions.unshift(pos);savePaper(s);
 return {ok:true,position:pos,paper:s};
}
export function setAutopilot(patch={}){
 const s=loadPaper(),ap=autopilotSettings(s);
 if(patch&&typeof patch==='object'){
  if(patch.enabled!==undefined)ap.enabled=!!patch.enabled;
  if(patch.mode!==undefined){const m=String(patch.mode).toLowerCase();if(!AUTOPILOT_MODES.includes(m))throw new Error('mode must be both, singles or combos');ap.mode=m}
  if(patch.stakeSingleUsd!==undefined){const v=Number(patch.stakeSingleUsd);if(!Number.isFinite(v)||v<.01||v>1000)throw new Error('stakeSingleUsd must be between 0.01 and 1000');ap.stakeSingleUsd=round2(v)}
  if(patch.stakeComboUsd!==undefined){const v=Number(patch.stakeComboUsd);if(!Number.isFinite(v)||v<.01||v>1000)throw new Error('stakeComboUsd must be between 0.01 and 1000');ap.stakeComboUsd=round2(v)}
  if(patch.maxOpenPct!==undefined){const v=Number(patch.maxOpenPct);if(!Number.isFinite(v)||v<1||v>100)throw new Error('maxOpenPct must be between 1 and 100');ap.maxOpenPct=v}
 }
 s.autopilot=ap;savePaper(s);return ap;
}

// ------------------------------------------------------------------ autopilot
function openKeysOf(paper){
 const keys=new Set();
 for(const pos of paper.positions||[])for(const l of pos.legs||[]){if(l.marketId!=null)keys.add(`m:${l.marketId}`);if(l.gameId!=null)keys.add(`g:${l.gameId}`)}
 return keys;
}
function cooldownKeys(paper,now){
 const keys=new Set();
 for(const h of paper.history||[]){
  const at=num(h.settledAt||h.closedAt);
  if(!at||now-at>AUTOPILOT_COOLDOWN_MS)continue;
  for(const l of h.legs||[]){if(l.marketId!=null)keys.add(`m:${l.marketId}`);if(l.gameId!=null)keys.add(`g:${l.gameId}`)}
 }
 return keys;
}
function openComboKeys(paper){
 const keys=new Set();
 for(const pos of paper.positions||[]){if(pos.kind!=='combo')continue;for(const l of pos.legs||[]){if(l.marketId!=null)keys.add(`m:${l.marketId}`);if(l.gameId!=null)keys.add(`g:${l.gameId}`)}}
 return keys;
}
export async function runAutopilotOnce(){
 if(autopilotBusy)return autopilotBusy;
 autopilotBusy=(async()=>{
  await settlePaperPositionsThrottled().catch(()=>null);
  const started=nowMs();
  let paper=ensurePaperBankroll(loadPaper());
  const ap=autopilotSettings(paper);
  const feed=await polymarketMarkets().catch(()=>cache);
  const research=paperResearchMetrics(paper,started);
  buildCandidates(feed.markets,paper,research,started);
  await refreshBooksIfStale().catch(()=>{});
  paper=ensurePaperBankroll(loadPaper());
  const metrics=paperResearchMetrics(paper,nowMs());
  const candidates=buildCandidates(feed.markets,paper,metrics,nowMs());
  const skipped=[];let placed=0,lastAction=ap.lastAction;
  const degraded=!!feed.error;
  const audit=metrics.settlement||paperSettlementAudit(paper,started);
  if(ap.enabled&&audit.pauseAutopilot){
   skipped.push({marketId:null,reason:audit.verdict==='DROP'?'settlement-bias-drop':'settlement-overdue'});
   lastAction='paused: '+skipped[0].reason;
  }
  if(ap.enabled&&!audit.pauseAutopilot){
   const openKeys=openKeysOf(paper),cooldown=cooldownKeys(paper,started);
   const capUsd=Math.max(0,num(metrics.equityUsd)*ap.maxOpenPct/100);
   let exposure=(paper.positions||[]).reduce((a,x)=>a+num(x.stakeUsd),0);
   const qualified=[];
   for(const c of candidates){
    const id=String(c.marketId),reason=r=>skipped.push({marketId:id,reason:r});
    if(degraded){reason('feed-degraded');continue}
    if(openKeys.has(`m:${c.marketId}`)||(c.gameId!=null&&openKeys.has(`g:${c.gameId}`))){reason('open-position');continue}
    if(cooldown.has(`m:${c.marketId}`)||(c.gameId!=null&&cooldown.has(`g:${c.gameId}`))){reason('cooldown');continue}
    if(c.priceSource==='mid'){reason('price-source-mid');continue}
    if(c.fillPrice==null){reason('no-fill-price');continue}
    if(c.freshnessSec>AUTOPILOT_MAX_FRESHNESS_SEC){reason('stale');continue}
    const evGate=candidateEvGate(c);if(!evGate.ok){reason(evGate.reason);continue}
    qualified.push(c);
   }
   if(!qualified.length)skipped.push({marketId:null,reason:candidates.length?'no-fillable-candidates':'no-live-candidates'});
   if(ap.mode==='both'||ap.mode==='combos'){
    const capacity=comboCapacity(paper);
    if(capacity.openCombos>=capacity.comboLimit)skipped.push({marketId:null,reason:'combo-growth-limit'});
    for(let slot=capacity.openCombos;slot<capacity.comboLimit;slot++){
     const stake=round2(ap.stakeComboUsd);
     const legs=chooseCombo(qualified.filter(c=>!openKeys.has('m:'+c.marketId)&&!(c.gameId!=null&&openKeys.has('g:'+c.gameId))&&num(c.askDepthUsd)>=2*stake),2);
     if(legs.length<2){skipped.push({marketId:null,reason:'combo-needs-2-positive-ev-games'});break}
     const comboEv=comboExpectedValue(legs);if(!comboEv.ok){skipped.push({marketId:null,reason:'combo-joint-ev-too-thin'});break}
     if(exposure+stake>capUsd+1e-9){skipped.push({marketId:null,reason:'combo-exposure-cap'});break}
     if(stake>num(paper.cashUsd)){skipped.push({marketId:null,reason:'combo-insufficient-cash'});break}
     try{
      const r=placePaperCombo({legs,stakeUsd:stake,placedBy:'autopilot'});
      paper=r.paper;exposure+=stake;placed++;
      for(const c of legs){openKeys.add('m:'+c.marketId);if(c.gameId!=null)openKeys.add('g:'+c.gameId)}
      lastAction='combo '+legs.length+' legs @ '+r.position.decimalOdds.toFixed(2)+'x $'+stake.toFixed(2);
     }catch(e){skipped.push({marketId:null,reason:String(e?.message||e).slice(0,60)});break}
    }
   }
   if(ap.mode==='both'||ap.mode==='singles'){
    for(const c of qualified){
     if(openKeys.has(`m:${c.marketId}`)||(c.gameId!=null&&openKeys.has(`g:${c.gameId}`))){skipped.push({marketId:String(c.marketId),reason:'covered-by-open-bet'});continue}
     const stake=round2(clamp(suggestStake(c,paper,metrics).stakeUsd,.01,1000));
     if(num(c.askDepthUsd)<2*stake){skipped.push({marketId:String(c.marketId),reason:'thin-depth'});continue}
     if(exposure+stake>capUsd+1e-9){skipped.push({marketId:String(c.marketId),reason:'exposure-cap'});continue}
     if(stake>num(paper.cashUsd)){skipped.push({marketId:String(c.marketId),reason:'insufficient-cash'});continue}
     try{
      const r=placePaperSingle({leg:c,stakeUsd:stake,placedBy:'autopilot'});
      paper=r.paper;exposure+=stake;placed++;
      openKeys.add(`m:${c.marketId}`);if(c.gameId!=null)openKeys.add(`g:${c.gameId}`);
      lastAction=`single ${c.outcome} · ${c.event||c.question||c.marketId} @ ${(num(c.fillPrice)*100).toFixed(1)}¢ $${stake.toFixed(2)}`;
     }catch(e){skipped.push({marketId:String(c.marketId),reason:String(e?.message||e).slice(0,60)})}
    }
   }
  }else if(!ap.enabled)skipped.push({marketId:null,reason:'autopilot-off'});
  const s=loadPaper();
  s.autopilot={...autopilotSettings(s),lastRunAt:nowMs(),lastAction,placedCount:num(s.autopilot?.placedCount)+placed,skipped:skipped.slice(0,20)};
  savePaper(s);
  return {placed,skipped:s.autopilot.skipped,autopilot:s.autopilot};
 })().finally(()=>{autopilotBusy=null});
 return autopilotBusy;
}

// ----------------------------------------------------------------- settlement
async function gammaGet(url){
 return fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
}
function ingestGammaMarkets(payload,out){
 const list=Array.isArray(payload)?payload:(payload&&typeof payload==='object'&&payload.id!=null?[payload]:[]);
 for(const m of list)if(m&&m.id!=null)out.set(String(m.id),m);
}
async function fetchMarketsByIds(ids){
 const unique=[...new Set((ids||[]).map(String).filter(Boolean))];
 const out=new Map(),errors=[],netFail=new Set();
 async function pullList(list,extra=''){
  const need=list.filter(id=>!out.has(id));
  if(!need.length)return;
  const chunks=[];
  for(let i=0;i<need.length;i+=20)chunks.push(need.slice(i,i+20));
  for(let i=0;i<chunks.length;i+=4){
   await Promise.all(chunks.slice(i,i+4).map(async chunk=>{
    try{
     const qs=chunk.map(id=>`id=${encodeURIComponent(id)}`).join('&')+extra;
     const r=await gammaGet(`${GAMMA}/markets?${qs}`);
     if(!r.ok)throw new Error(`Gamma ${r.status}`);
     ingestGammaMarkets(await r.json(),out);
     for(const id of chunk)netFail.delete(id);
    }catch(e){
     errors.push({marketIds:chunk,error:String(e?.message||e)});
     for(const id of chunk)if(!out.has(id))netFail.add(id);
    }
   }));
  }
 }
 await pullList(unique);
 // Gamma's live list omits resolved markets; losers then look "missing" and never book.
 await pullList(unique.filter(id=>!out.has(id)),'&closed=true');
 const still=unique.filter(id=>!out.has(id));
 for(let i=0;i<still.length;i+=4){
  await Promise.all(still.slice(i,i+4).map(async id=>{
   try{
    const r=await gammaGet(`${GAMMA}/markets/${encodeURIComponent(id)}`);
    if(r.status===404){netFail.delete(id);return}
    if(!r.ok)throw new Error(`Gamma ${r.status}`);
    ingestGammaMarkets(await r.json(),out);
    netFail.delete(id);
   }catch(e){
    errors.push({marketIds:[id],error:String(e?.message||e)});
    netFail.add(id);
   }
  }));
 }
 return {markets:out,errors,failed:new Set(unique.filter(id=>!out.has(id)&&netFail.has(id)))};
}
function marketCancelled(market){
 if(!market||typeof market!=='object')return false;
 if(market.cancelled===true||market.canceled===true)return true;
 const status=String(market.umaResolutionStatus||market.resolutionStatus||market.status||'').toLowerCase();
 return /cancel|void|invalid/.test(status);
}
function binaryResult(px){
 if(px>=RESOLVE_WIN_PX)return 'won';
 if(px<=RESOLVE_LOSE_PX)return 'lost';
 return 'pending';
}
function legResolution(market,leg){
 const outcomes=arr(market.outcomes),prices=arr(market.outcomePrices);
 const tokens=arr(market.clobTokenIds);
 let idx=leg.tokenId?tokens.findIndex(t=>String(t)===String(leg.tokenId)):-1;
 if(idx<0&&leg.outcome!=null)idx=outcomes.findIndex(o=>String(o).toLowerCase()===String(leg.outcome).toLowerCase());
 // Unknown labels must not silently select the first outcome.
 if(idx<0&&leg.outcome==null&&leg.outcomeIndex!=null&&Number.isInteger(Number(leg.outcomeIndex)))idx=Number(leg.outcomeIndex);
 const raw=idx>=0?prices[idx]:null;
 const valid=raw!==null&&raw!==undefined&&String(raw).trim()!==''&&Number.isFinite(Number(raw))&&Number(raw)>=0&&Number(raw)<=1;
 const resolvedPrice=valid?Number(raw):null;
 const cancelled=marketCancelled(market);
 let result='pending';
 if(cancelled)result='void';
 else if(market.closed&&valid)result=binaryResult(resolvedPrice);
 return {closed:!!market.closed||cancelled,index:idx,resolvedPrice,result,cancelled};
}
function closeOut(pos,{status,payout,source,legs,exit,censored}){
 const stake=num(pos.stakeUsd);
 const extra={};
 if(censored)extra.censored=true;
 if(pos.missingSince)extra.missingSince=pos.missingSince;
 return {...pos,...extra,legs:legs||pos.legs,status,settledAt:nowMs(),payoutUsd:round5(payout),pnlUsd:round5(payout-stake),settlementSource:source,...(exit?{exit}:{})};
}
export async function settlePaperPositionsThrottled(){
 const now=nowMs();
 if(settlementCache.result&&now-settlementCache.at<SETTLEMENT_THROTTLE_MS)return settlementCache.result;
 if(settlementCache.busy)return settlementCache.busy;
 settlementCache.busy=settlePaperPositions().then(r=>{settlementCache={at:nowMs(),result:r,busy:null};return r}).catch(e=>{settlementCache.busy=null;throw e});
 return settlementCache.busy;
}
export async function settlePaperPositions(){
 if(settlementBusy)return settlementBusy;
 settlementBusy=refreshSettlements();
 try{return await settlementBusy}finally{settlementBusy=null}
}
async function refreshSettlements(){
 let s=loadPaper();
 if(!s.positions?.length)return {settled:0,exited:0,paper:s,errors:[]};
 const marketIds=[...new Set(s.positions.flatMap(p=>p.legs||[]).map(l=>String(l.marketId)).filter(Boolean))];
 const exitTokens=[...new Set(s.positions.filter(p=>p.kind==='single').flatMap(p=>(p.legs||[]).map(l=>l.tokenId)).filter(Boolean).map(String))].slice(0,BOOK_TOKEN_CAP);
 const [lookup,exitBooks]=await Promise.all([fetchMarketsByIds(marketIds),fetchExitBooks(exitTokens)]);
 const {markets:resolvedById,errors,failed}=lookup;
 // Preserve trades and resets made while market requests were in flight.
 s=loadPaper();
 const now=nowMs(),remaining=[],closed=[];let dirty=false;
 for(const pos of s.positions){
  const legs=pos.legs||[];
  const stake=num(pos.stakeUsd);
  const states=legs.map(l=>resolvedById.get(String(l.marketId))||null);
  const missing=legs.filter((l,i)=>!states[i]&&!failed.has(String(l.marketId)));
  const resolutions=legs.map((l,i)=>states[i]?legResolution(states[i],l):null);
  const settledLegs=legs.map((l,i)=>resolutions[i]?{...l,result:resolutions[i].result,resolvedPrice:resolutions[i].resolvedPrice}:{...l,result:'pending',resolvedPrice:null});
  // A known lost leg settles the whole ticket now, even if other legs are pending or missing.
  if(resolutions.some(r=>r&&r.result==='lost')){
   closed.push(closeOut(pos,{status:'LOST',payout:0,source:'gamma-market',legs:settledLegs}));continue;
  }
  const allKnown=states.length>0&&states.every(Boolean);
  const pending=!allKnown||resolutions.some(r=>!r||r.result==='pending');
  if(allKnown&&!pending){
   const kept=settledLegs.filter(l=>l.result!=='void');
   if(!kept.length){
    closed.push(closeOut(pos,{status:'VOID',payout:stake,source:resolutions.some(r=>r.cancelled)?'gamma-cancel':'gamma-void',legs:settledLegs}));
    s.cashUsd=round5(num(s.cashUsd)+stake);continue;
   }
   const payout=pos.kind==='single'?num(pos.potentialPayoutUsd)||applyFees(kept,stake).shares:comboQuote(kept,stake).payout;
   const voided=kept.length!==settledLegs.length;
   closed.push(closeOut(pos,{status:'WON',payout,source:voided?'gamma-market-void-leg':'gamma-market',legs:settledLegs}));
   s.cashUsd=round5(num(s.cashUsd)+payout);continue;
  }
  if(missing.length){
   const missingSince=num(pos.missingSince)||now;
   if(num(pos.missingSince)!==missingSince)dirty=true;
   remaining.push({...pos,missingSince});continue;
  }
  if(pos.missingSince){dirty=true;delete pos.missingSince}
  const exit=allKnown?tryEarlyExit(pos,exitBooks,states):null;
  if(exit){closed.push(exit.entry);s.cashUsd=round5(num(s.cashUsd)+exit.payout);continue}
  remaining.push(pos);
 }
 const exited=closed.filter(x=>x.settlementSource==='early-exit'||x.settlementSource==='mark-to-bid').length;
 if(closed.length||dirty){s.positions=remaining;s.history=[...closed,...(s.history||[])].slice(0,5000);savePaper(s)}
 return {settled:closed.length,exited,results:closed,paper:s,errors};
}
async function fetchExitBooks(tokenIds){
 if(!tokenIds.length)return new Map();
 const before=new Map(bookCache);
 const r=await fetchBooks(tokenIds).catch(()=>({books:0}));
 const out=new Map();
 for(const id of tokenIds){const b=bookCache.get(String(id))||before.get(String(id));if(b)out.set(String(id),b)}
 if(!r||!r.books)for(const [id,b] of before)if(!out.has(id))out.set(id,b);
 return out;
}
function tryEarlyExit(pos,books,states){
 if(pos.kind!=='single')return null;
 const leg=(pos.legs||[])[0];if(!leg||!leg.tokenId)return null;
 const book=books.get(String(leg.tokenId));if(!book)return null;
 if(nowMs()-Number(book.at||0)>BOOK_FRESH_MS)return null;
 if(book.bid==null||!(num(book.bid)>=0&&num(book.bid)<=1))return null;
 const bid=num(book.bid);
 const ended=gameEnded(leg.gameId)||(states||[]).some(m=>m&&(m.closed||marketCancelled(m)));
 const entryPrice=num(pos.fillPrice)||num(leg.fillPrice)||num(leg.price);
 const heldMin=Math.max(0,(nowMs()-num(pos.createdAt))/60000);
 const eta=num(leg.timing?.etaMinutes)||TURNOVER_TARGET_MINUTES;
 const overdue=heldMin>=eta+30;
 const shares=num(pos.shares)||applyFees([leg],num(pos.stakeUsd)).shares;
 const quote=sellQuote(book.bids,shares,leg);
 const crushed=bid<=MARK_LOSE_BID||((ended||overdue)&&bid<=MARK_LOSE_ENDED_BID);
 if(crushed){
  if(!quote)return null; // No full executable bid means no realized cash-out.
  const payout=round5(quote.payout);
  const status=payout+1e-9>=num(pos.stakeUsd)?'VOID':'LOST';
  const entry=closeOut(pos,{status,payout,source:'mark-to-bid',
   exit:{price:quote?quote.price:bid,feeUsd:quote?round5(quote.fees):0,at:nowMs()},
   legs:(pos.legs||[]).map(l=>({...l,result:status==='VOID'?'void':'lost',resolvedPrice:quote?quote.price:bid}))});
  return {entry,payout};
 }
 const grossGain=entryPrice>0?bid/entryPrice-1:0;
 // Capital velocity: cash out a strong near-certain single before formal resolution when the
 // remaining upside is tiny relative to the profit already captured. This stays paper-only.
 const recycle=bid>=.975&&grossGain>=.015&&(heldMin>=4||(1-bid)<=.015);
 if(!(bid>=0.99||(ended&&bid>=0.985)||recycle))return null;
 if(!quote||quote.payout<=num(pos.stakeUsd))return null;
 const payout=quote.payout;
 const entry=closeOut(pos,{status:'WON',payout,source:'early-exit',exit:{price:quote.price,feeUsd:round5(quote.fees),at:nowMs()},
  legs:(pos.legs||[]).map(l=>({...l,result:'won',resolvedPrice:quote.price}))});
 return {entry,payout:round5(payout)};
}

// -------------------------------------------------------------------- outputs
function recentEvents(paper){
 const out=[];
 for(const h of (paper.history||[]).slice(0,40)){
  const type=h.settlementSource==='early-exit'?'early-exit':h.settlementSource==='mark-to-bid'?'mark-to-bid':(h.status==='VOID'?'void':'settled');
  out.push({at:num(h.settledAt||h.createdAt),type,kind:h.kind||'combo',detail:describePosition(h),pnlUsd:round5(h.pnlUsd)});
 }
 for(const p of (paper.positions||[]).slice(0,40))out.push({at:num(p.createdAt),type:'placed',kind:p.kind||'combo',detail:describePosition(p)});
 return out.sort((a,b)=>b.at-a.at).slice(0,20);
}
function describePosition(p){
 const legs=p.legs||[];
 if((p.kind||'combo')==='single'){const l=legs[0]||{};return `${l.outcome||'?'} · ${l.event||l.question||l.marketId||''}`.trim()}
 return `${legs.length} legs · ${legs.slice(0,2).map(l=>l.outcome||'?').join(', ')}${legs.length>2?'…':''}`;
}
export async function polymarketSnapshot(){
 await settlePaperPositionsThrottled().catch(()=>null);
 const feed=await polymarketMarkets();
 let paper=ensurePaperBankroll(loadPaper());
 let now=nowMs();
 let research=paperResearchMetrics(paper,now);
 let candidates=buildCandidates(feed.markets,paper,research,now);
 if(lastTokens.length&&(!bookCache.size||now-Number(bookFeed.at||0)>BOOK_FRESH_MS)){
  await refreshBooksIfStale(true).catch(()=>{});
  now=nowMs();candidates=buildCandidates(feed.markets,paper,research,now);
 }else refreshBooksIfStale().catch(()=>{});
 const replay=paperReplaySeries(paper);
 const confidenceCandidates=feed.markets.filter(x=>x.price>=.78&&x.price<=.985&&x.liquidity>=1000).slice(0,60);
 const suggested=chooseCombo(candidates,2);
 const ap=autopilotSettings(paper);
 const quote=comboQuote(suggested,ap.stakeComboUsd);
 const feedAge=feed.lastSuccessAt?now-feed.lastSuccessAt:null;
 const usable=!!feed.lastSuccessAt&&(feedAge==null||feedAge<=STALE_OK_MS);
 const openExposureUsd=round5((paper.positions||[]).reduce((a,x)=>a+num(x.stakeUsd),0));
 const exposureCapUsd=round5(num(research.equityUsd)*ap.maxOpenPct/100);
 const audit=research.settlement||paperSettlementAudit(paper,now);
 const ageById=new Map((audit.openAges||[]).map(a=>[a.id,a]));
 const paperView={...paper,mode:'PAPER',pnlMode:'PAPER',positions:(paper.positions||[]).map(p=>{const a=ageById.get(p.id);return a?{...p,ageMs:a.ageMs,ageMinutes:a.ageMinutes,overdue:a.overdue,stale:a.stale}:p})};
 const keep=!!audit.keep;
 return {mode:'PAPER',pnlMode:'PAPER',research,replay,paper:paperView,candidates,confidenceCandidates:confidenceCandidates.slice(0,30),suggested,quote,
  feed:{ok:usable,error:usable?null:feed.error,degraded:!!feed.error&&usable,lastError:feed.error,updatedAt:feed.at,lastSuccessAt:feed.lastSuccessAt,ageMs:feedAge,failures:feed.failures||0,count:feed.markets.length,
   sources:{gammaLive:{events:num(feed.sources?.events),games:num(feed.sources?.games),ageMs:feedAge,pages:num(feed.sources?.pages)},
    sportsWs:{connected:!!sportsFeed.connected,lastMessageAt:sportsFeed.lastMessageAt||0,error:sportsFeed.error||null},
    clob:{tokens:bookCache.size,ageMs:bookFeed.at?now-bookFeed.at:null,error:bookFeed.error||null,batch:!!bookFeed.batch}}},
  autopilot:{...ap,openExposureUsd,exposureCapUsd,...comboCapacity(paper),pausedForSettlement:!!audit.pauseAutopilot},
  strategy:{name:'LIVE NEAR-SETTLEMENT',keep,verdict:audit.verdict||'COLLECTING',liveSportsFeed:sportsFeed,nearEndCount:candidates.length,
   rule:'Live only · estimated playing time ≤15m · closing tennis/table-tennis preferred · baseball ninth inning+ · two-leg auto combos · positive fee-adjusted EV gate · fresh score stream · 80–98.5% · $1k+ liquidity · dynamic 5–12¢ spread by liquidity · one leg per game · CLOB fillable prices, taker fees applied. Closed Gamma markets are fetched; a lost combo leg books immediately. Paper-only until gamma-resolved losers exist and conservative ROI stays positive.',
   candidateDiagnostics,settlement:audit},
  recentEvents:recentEvents(paper),
  simulations:[4,5,6].map(legs=>simulateComboSamples({legProbability:.9,legs,trials:5000,stakeUsd:2.5,seed:1337+legs})),
  real:{enabled:false,configured:!!process.env.POLYMARKET_PRIVATE_KEY,platform:process.env.POLYMARKET_PLATFORM||'global',
   note:'Real execution is intentionally locked until explicitly enabled.'}};
}

export function resetPolymarketPaper(amountUsd=25){
 const amount=Math.max(1,Math.min(1_000_000,num(amountUsd)||25));
 const prev=loadPaper(),s=defaultState();
 s.cashUsd=amount;s.startUsd=amount;s.autopilot={...autopilotSettings(prev),lastRunAt:0,lastAction:null,placedCount:0,skipped:[]};
 savePaper(s);return s;
}

export function simulateComboSamples({legProbability=.9,legs=6,trials=1000,stakeUsd=2.5,seed=1337}={}){
 const nLegs=Math.max(2,Math.min(12,Math.floor(num(legs)||6))),nTrials=Math.max(10,Math.min(100000,Math.floor(num(trials)||1000)));
 const p=Math.max(.01,Math.min(.99,num(legProbability)||.9)),stake=Math.max(.01,num(stakeUsd)||2.5);
 let x=(Math.floor(num(seed)||1337)>>>0)||1,wins=0,bankroll=25,peak=25,maxDrawdown=0;
 const rand=()=>{x=(1664525*x+1013904223)>>>0;return x/4294967296};
 const joint=Math.pow(p,nLegs),odds=joint?1/joint:0;
 for(let i=0;i<nTrials;i++){let ok=true;for(let j=0;j<nLegs;j++){if(rand()>p){ok=false;break}}bankroll-=stake;if(ok){wins++;bankroll+=stake*odds}peak=Math.max(peak,bankroll);maxDrawdown=Math.max(maxDrawdown,peak-bankroll)}
 return {legProbability:p,legs:nLegs,trials:nTrials,stakeUsd:stake,jointProbability:joint,decimalOdds:odds,wins,losses:nTrials-wins,hitRate:wins/nTrials,endingBankroll:bankroll,pnl:bankroll-25,maxDrawdown};
}

export function paperReplaySeries(paper=loadPaper()){
 const hist=[...(paper.history||[])].filter(x=>Number.isFinite(Number(x.pnlUsd))).sort((a,b)=>Number(a.settledAt||a.createdAt)-Number(b.settledAt||b.createdAt));
 let equity=Number(paper.startUsd||25),peak=equity,maxDrawdown=0;
 const points=hist.map((x,i)=>{equity+=Number(x.pnlUsd||0);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak?((peak-equity)/peak):0);return {i:i+1,ts:Number(x.settledAt||x.createdAt||0),equityUsd:equity,pnlUsd:Number(x.pnlUsd||0),status:x.status||null,kind:x.kind||'combo',legs:x.legs?.length||0,decimalOdds:Number(x.decimalOdds||0)}});
 return {points:points.slice(-1000),maxDrawdown,endingEquityUsd:equity,samples:hist.length};
}

export function realPolymarketReadiness(){
 return {enabled:String(process.env.POLYMARKET_REAL_ENABLED||'false').toLowerCase()==='true',
  platform:process.env.POLYMARKET_PLATFORM||'global',hasPrivateKey:!!process.env.POLYMARKET_PRIVATE_KEY,
  hasApiKey:!!process.env.POLYMARKET_API_KEY,hasApiSecret:!!process.env.POLYMARKET_API_SECRET,
  hasPassphrase:!!process.env.POLYMARKET_API_PASSPHRASE,hasFunder:!!process.env.POLYMARKET_FUNDER_ADDRESS};
}

export function stopPolymarketLoops(){
 clearInterval(autopilotTimer);clearInterval(bookTimer);clearTimeout(sportsReconnect);
 autopilotTimer=null;bookTimer=null;
 try{sportsSocket?.close()}catch{}
 sportsSocket=null;
}
export const __testing={
 setClock(fn){clockNow=typeof fn==='function'?fn:null},
 resetSettlement(){settlementBusy=null;settlementCache={at:0,result:null,busy:null}},
 now:nowMs,
 legResolution,
 marketCancelled,
 binaryResult,
 SETTLEMENT_THROTTLE_MS,STALE_TIMEOUT_MS,MISSING_VOID_MS,OVERDUE_GRACE_MS,FAST_COMBO_OVERDUE_GRACE_MS,FAST_SINGLE_OVERDUE_GRACE_MS,RESOLVE_WIN_PX,RESOLVE_LOSE_PX,
 STATE_FILE
};
function startPolymarketLoops(){
 console.info('[MPOS][MODE] Polymarket(global)=PAPER | P&L=PAPER | real execution locked');
 startSportsFeed();
 bookTimer=setInterval(()=>{refreshBooksIfStale().catch(()=>{})},BOOK_TTL_MS);bookTimer.unref?.();
 autopilotTimer=setInterval(()=>{runAutopilotOnce().catch(()=>{})},AUTOPILOT_TICK_MS);autopilotTimer.unref?.();
}
if(AUTOSTART)startPolymarketLoops();
