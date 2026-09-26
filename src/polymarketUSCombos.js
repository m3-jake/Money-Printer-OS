// Fast combos on Polymarket US (REAL money).
// Every place/accept path re-checks credentials, session arm, typed confirmation,
// stake cap, open cap, daily loss cap, leg freshness, price tolerance and distinct
// events server-side. Nothing here can be bypassed from the browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed25519 from '@noble/ed25519';
import { appendNdjson } from './researchCollector.js';
import { lateGameEstimate, windowEstimate, STRATEGY_WINDOWS, WINDOW_RULES, TURNOVER_TARGET_MINUTES } from './sportsTiming.js';
import { usReadiness, noteUSAuthResult } from './polymarketUS.js';
import { mapLimit } from './utils.js';
import { renameSyncWithRetry } from './atomicRename.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||path.join(ROOT,'data'));
const STATE_FILE=path.join(DATA_DIR,'polymarket-us-combos.json');
const GATEWAY=process.env.POLYMARKET_US_GATEWAY||'https://gateway.polymarket.us';
const API=process.env.POLYMARKET_US_API||'https://api.polymarket.us';
const UA=()=>process.env.POLYMARKET_US_UA||'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MoneyPrinterOS/0.5';
const AUTOSTART=()=>String(process.env.POLYMARKET_AUTOSTART??'true').toLowerCase()!=='false';
const FETCH_TIMEOUT_MS=10000;
const FEED_TTL_MS=5000;          // snapshot / feed cache
const SNAPSHOT_TTL_MS=5000;
const SETTLE_THROTTLE_MS=30000;  // baseline settlement polling
const SETTLE_CACHE_PENDING_MS=60000;
const SETTLE_CACHE_RESOLVED_MS=600000;
const SETTLE_FETCH_CONCURRENCY=3;
export const SETTLE_FAST={throttleMs:15000,pendingMs:15000,windowMs:90*60000};
const QUOTE_POLL_MS=700;         // RFQ quote poll cadence
const BBO_TTL_MS=10000;
const FRESH_LIMIT_SEC=90;        // leg freshness gate
const COOLDOWN_MS=180000;        // 3 min per event after settlement
const TICK=0.001;                // combo tick size
const MIN_QTY=0.01;
const PRICE_MAX=0.985,NEAR_END_MIN=65;
// Owner-adjustable, stored in journal.settings. The bounds are fixed; nothing here can widen them.
export const SETTINGS_BOUNDS={priceMin:{min:0.60,max:PRICE_MAX,default:0.80},maxMinutesLeft:{min:1,max:30,default:TURNOVER_TARGET_MINUTES},maxLegs:{min:2,max:4,default:3}};
export {STRATEGY_WINDOWS,WINDOW_RULES};
// Rank = sum(weight * component). Components are named so the Lab can tune weights;
// default weights of 1 reproduce the original hand formula exactly.
export const RANK_COMPONENTS={
 nearEnd:c=>c.nearEndScore*4,
 priceFit:c=>100-Math.abs(c.price-.90)*260,
 liquidity:c=>c.liquidityKnown?Math.min(35,Math.log10(Math.max(1,c.liquidity))*8):20,
 eta:c=>-(c.etaMinutes??60)*8,
 priority:c=>c.priorityBonus||0,
 spread:c=>-(c.spread??.02)*500,
};
export const RANK_WEIGHT_BOUNDS={min:0,max:3};
export const DEFAULT_RANK_WEIGHTS=Object.fromEntries(Object.keys(RANK_COMPONENTS).map(k=>[k,1]));
export function rankBreakdown(c,weights=DEFAULT_RANK_WEIGHTS){
 const parts={};let total=0;
 for(const [k,f] of Object.entries(RANK_COMPONENTS)){const w=Number(weights?.[k]??1);const v=f(c);parts[k]=Math.round(v*100)/100;total+=w*v}
 return {rank:Math.round(total),parts};
}
function normalizeWeights(w={}){
 const out={...DEFAULT_RANK_WEIGHTS};
 for(const k of Object.keys(out)){const v=Number(w?.[k]);if(Number.isFinite(v)&&v>=RANK_WEIGHT_BOUNDS.min&&v<=RANK_WEIGHT_BOUNDS.max)out[k]=Math.round(v*1000)/1000}
 return out;
}
// 11:59 PM ET Wed Sep 16 2026 == 03:59 UTC Thu Sep 17 2026 (EDT, UTC-4).
const COMBO_CURVE_FROM=Date.parse('2026-09-17T03:59:00Z');
const CONFIRM_PLACE='PLACE REAL COMBO';
const SUGGEST_STAKE_USD=5;       // stake used only to price the snapshot's suggested combo

const num=v=>{const x=Number(v);return Number.isFinite(x)?x:0};
const val=x=>num(x?.value??x);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const r2=x=>Math.round(num(x)*100)/100;
const r3=x=>Math.round(num(x)*1000)/1000;
const r4=x=>Math.round(num(x)*10000)/10000;
const ceilTick=(x,tick=TICK)=>Math.ceil((num(x)-1e-9)/tick)*tick;
const envNum=(k,d)=>{const v=Number(process.env[k]);return Number.isFinite(v)&&v>0?v:d};
let settleClock=null;
const nowMs=()=>settleClock?settleClock():Date.now();
const creds=()=>({keyId:String(process.env.POLYMARKET_KEY_ID||'').trim(),secretKey:String(process.env.POLYMARKET_SECRET_KEY||'').trim()});

export function usComboLimits(){
 return {maxStakeUsd:envNum('POLYMARKET_US_COMBO_MAX_STAKE_USD',25),maxOpen:Math.round(envNum('POLYMARKET_US_COMBO_MAX_OPEN',5)),
  dailyLossCapUsd:envNum('POLYMARKET_US_COMBO_DAILY_LOSS_CAP_USD',50),priceTolerance:envNum('POLYMARKET_US_COMBO_PRICE_TOLERANCE',0.02)};
}

// --------------------------------------------------------------------- errors
export class ComboError extends Error{
 constructor(code,message,status=0){super(message);this.name='ComboError';this.code=code;this.status=status}
}
const fail=(code,message,status=0)=>{throw new ComboError(code,message,status)};
function classifyHttp(status,text=''){
 const t=String(text||'');
 if(status===401)return 'keyNotFound';
 if(status===403)return 'betaNotEnabled';
 if(status===429)return 'rateLimited';
 if(/not enabled|beta|permission|not authorized|forbidden/i.test(t))return 'betaNotEnabled';
 return 'http';
}

// ---------------------------------------------------------------- networking
async function authHeaders(method,pathname){
 const {keyId,secretKey}=creds();
 if(!keyId||!secretKey)fail('noCredentials','Polymarket US API credentials are not configured');
 let seed;
 try{const raw=Buffer.from(secretKey,'base64');seed=new Uint8Array(raw.subarray(0,32))}catch{seed=null}
 if(!seed||seed.length!==32)fail('keyNotFound','Polymarket US secret key is not a valid base64 ed25519 key');
 const timestamp=String(Date.now());
 const sig=await ed25519.signAsync(new TextEncoder().encode(`${timestamp}${method}${pathname}`),seed);
 return {'X-PM-Access-Key':keyId,'X-PM-Timestamp':timestamp,'X-PM-Signature':Buffer.from(sig).toString('base64')};
}

// Single signed-fetch helper for every authenticated Retail API call.
export async function signedFetch(method,pathname,{query=null,body=null,timeoutMs=FETCH_TIMEOUT_MS}={}){
 const url=new URL(pathname,API);
 if(query)for(const [k,v] of Object.entries(query)){if(v===undefined||v===null)continue;if(Array.isArray(v))for(const item of v)url.searchParams.append(k,String(item));else url.searchParams.set(k,String(v))}
 const headers={'content-type':'application/json','accept':'application/json','user-agent':UA(),...await authHeaders(method,url.pathname)};
 let res;
 try{
  res=await globalThis.fetch(url.toString(),{method,headers,body:body===null||body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
 }catch(e){
  const message=String(e?.message||e);
  noteUSAuthResult({code:'network',message});
  throw new ComboError('network',`Polymarket US request failed: ${message}`,0);
 }
 const status=Number(res?.status||0);
 const text=typeof res?.text==='function'?await res.text():'';
 if(!res?.ok){
  let message=text;
  try{const j=JSON.parse(text);message=j.message||j.error||text}catch{}
  const code=classifyHttp(status,message);
  noteUSAuthResult({code,message:String(message||`HTTP ${status}`)});
  if(code==='betaNotEnabled')betaAccess='denied';
  throw new ComboError(code,String(message||`HTTP ${status}`),status);
 }
 noteUSAuthResult({code:'ok',message:null});
 if(!text)return {};
 try{return JSON.parse(text)}catch{return {}}
}

async function publicFetch(pathname,query=null,timeoutMs=FETCH_TIMEOUT_MS){
 const url=new URL(pathname,GATEWAY);
 if(query)for(const [k,v] of Object.entries(query)){if(v===undefined||v===null)continue;if(Array.isArray(v))for(const item of v)url.searchParams.append(k,String(item));else url.searchParams.set(k,String(v))}
 let res;
 try{res=await globalThis.fetch(url.toString(),{method:'GET',headers:{'accept':'application/json','user-agent':UA()},signal:AbortSignal.timeout(timeoutMs)})}
 catch(e){throw new ComboError('network',`Polymarket US public request failed: ${String(e?.message||e)}`,0)}
 if(!res?.ok){
  const status=Number(res?.status||0);
  const text=typeof res?.text==='function'?await res.text():'';
  throw new ComboError(status===429?'rateLimited':'http',String(text||`HTTP ${status}`),status);
 }
 const text=typeof res?.text==='function'?await res.text():'';
 if(!text)return {};
 try{return JSON.parse(text)}catch{return {}}
}

// ------------------------------------------------------------- live US feed
let feed={at:0,fetchedAt:0,ok:false,error:null,events:[],inPlay:0,live:0,total:0,comboLive:0,pages:0,capped:false};
const EVENTS_PAGE=300,EVENTS_CAP=3000;
const comboLiveEvent=e=>(e.markets||[]).some(m=>m&&m.comboEnabled===true);
let feedBusy=null;
const bboCache=new Map();

// Item 1: in-play scanner. The stale events.list({live:true}) call returns closed
// games, so we always scan a date window and keep live===true && !closed.
export async function usLiveEvents({force=false}={}){
 const now=Date.now();
 if(!force&&feed.fetchedAt&&now-feed.fetchedAt<FEED_TTL_MS)return feed;
 if(feedBusy)return feedBusy;
 feedBusy=(async()=>{
  try{
   // Page with offset until a short page (the single 300-row call truncated ~900 events).
   const query={active:true,closed:false,categories:['sports'],
    startDateMin:new Date(now-36*3600e3).toISOString(),startDateMax:new Date(now+12*3600e3).toISOString(),limit:EVENTS_PAGE};
   const all=[],seen=new Set();let pages=0,capped=false;
   for(let offset=0;;offset+=EVENTS_PAGE){
    if(offset>=EVENTS_CAP){capped=true;break}
    const j=await publicFetch('/v1/events',{...query,offset});pages++;
    const page=Array.isArray(j?.events)?j.events:[];
    for(const e of page){const id=String(e?.id??e?.slug??'');if(id&&seen.has(id))continue;if(id)seen.add(id);all.push(e)}
    if(page.length<EVENTS_PAGE)break;
   }
   const at=Date.now();
   const live=all.filter(e=>e&&e.live===true&&!e.closed&&!e.ended).map(e=>({...e,__fetchedAt:at}));
   feed={at,fetchedAt:at,ok:true,error:null,events:live,inPlay:all.length,live:live.length,
    total:all.length,comboLive:live.filter(comboLiveEvent).length,pages,capped};
  }catch(e){
   feed={...feed,fetchedAt:Date.now(),ok:false,error:String(e?.message||e)};
  }
  return feed;
 })().finally(()=>{feedBusy=null});
 return feedBusy;
}

// -------------------------------------------------------- period/score adapter
const GRAND_SLAM=/ausopen|australian-open|roland|french-open|wimbledon|usopen|us-open/;
function tagSet(event={}){
 const tags=(event.tags||[]).map(t=>String(t?.slug||t?.label||t||'').toLowerCase());
 return new Set([...tags,String(event.seriesSlug||'').toLowerCase(),String(event.slug||'').toLowerCase()].filter(Boolean));
}
function sportOf(tags,slug=''){
 const has=x=>[...tags].some(t=>t.includes(x));
 if(has('table-tennis')||has('setka')||has('tt-cup')||has('ttcup')||/^(setka|tt)/.test(slug))return 'table-tennis';
 if(has('tennis')||has('atp')||has('wta')||has('itf'))return 'tennis';
 if(has('soccer'))return 'soccer';
 if(has('baseball')||has('mlb'))return 'baseball';
 if(has('football')||has('nfl')||has('ncaaf'))return 'football';
 if(has('basketball')||has('nba')||has('wnba')||has('ncaab'))return 'basketball';
 if(has('hockey')||has('nhl'))return 'hockey';
 if(ESPORT_TAGS.some(has))return 'esports';
 return 'other';
}
const ESPORT_TAGS=['esports','esport','cs2','csgo','counter-strike','league-of-legends','lol','dota','valorant','overwatch','rainbow-six','call-of-duty','rocket-league','starcraft'];
const LEAGUE_TAGS={
 baseball:['mlb','npb','kbo','cpbl','ncaa-baseball','college-baseball','lmb','mlb-spring-training'],
 basketball:['nba','wnba','ncaab','cbb','euroleague','nbl','acb','bsl','cba'],
 football:['nfl','ncaaf','cfb','cfl','ufl'],
 hockey:['nhl','khl','ahl','shl','liiga','del','ncaah'],
};
function leagueOf(tags,sport){
 for(const lg of LEAGUE_TAGS[sport]||[])if(tags.has(lg))return lg.replace(/^college-/,'ncaa-');
 return sport;
}
// Sports without a verified timing rule never auto-qualify; they are manual only.
export const TIMED_SPORTS=new Set(['soccer','baseball','tennis','table-tennis','football','basketball','hockey']);

// Item 2: map US strings into the exact shapes lateGameEstimate already parses.
export function normalizeUSLiveState(event={}){
 const tags=tagSet(event);
 const slug=String(event.slug||'').toLowerCase();
 const sport=sportOf(tags,slug);
 const rawPeriod=String(event.period??'').trim();
 const rawScore=String(event.score??'').trim();
 const up=rawPeriod.toUpperCase();
 let period=rawPeriod,elapsed=event.elapsed==null?null:String(event.elapsed),score=rawScore,league=sport;
 if(sport==='soccer'){
  league='soccer';
  const m=up.match(/^(\d{1,3})(?:\s*\+\s*(\d{1,2}))?['′]?$/);
  if(m){
   const base=Number(m[1]);
   elapsed=m[2]?`${base}+${Number(m[2])}`:String(base);
   period=base<=45?'1H':'2H';
  }else if(/^HT\b|HALF.?TIME/.test(up))period='HT';
  else if(/^FT\b|FULL.?TIME/.test(up))period='FT';
  else if(/^(1H|H1|FIRST HALF)/.test(up))period='1H';
  else if(/^(2H|H2|SECOND HALF)/.test(up))period='2H';
 }else if(sport==='baseball'){
  {const lg=leagueOf(tags,'baseball');league=lg==='baseball'?'baseball':lg+' baseball'}
  period=rawPeriod;           // Top/Bot/Mid/End Nth pass through untouched
  elapsed=null;
 }else if(sport==='tennis'||sport==='table-tennis'){
  const table=sport==='table-tennis';
  const tour=[...tags].find(t=>['atp','wta','itf','itfwo','itfmo'].includes(t))||'';
  const bestOf=table?5:(tour.startsWith('atp')&&[...tags].some(t=>GRAND_SLAM.test(t))?5:3);
  league=`${table?'table tennis':'tennis'} ${tour} BO${bestOf}`.trim();
  const set=up.match(/^S(?:ET)?\s*(\d+)$/);
  if(set)period=`SET ${Number(set[1])}`;
  else if(/^SET\s*\d+/.test(up))period=up;
  // "4-2:40-30" / "3-1:40-AD" carry live point scores; lateGameEstimate wants games only.
  score=rawScore.split(':')[0].trim();
  elapsed=null;
 }else if(sport==='football'||sport==='basketball'||sport==='hockey'){
  {const lg=leagueOf(tags,sport);league=lg===sport?sport:lg+' '+sport}
  period=rawPeriod;           // "Q4" + countdown clock "02:30" pass straight through
  elapsed=event.elapsed==null?null:String(event.elapsed);
 }
 return {period,elapsed,score,status:String(event.eventState||event.status||''),ended:!!event.ended,
  leagueAbbreviation:league,sport,rawPeriod,rawScore,rawElapsed:event.elapsed==null?null:String(event.elapsed)};
}

// -------------------------------------------------------------- candidates
const ALLOWED_TYPE=/^(?:[a-z]+_(?:team|game)_full_(?:game|time)_(?:winner|spread|total)|[a-z]+_(?:team|game)_(?:first|second)_half_(?:winner|spread|total)|[a-z]+_team_moneyline)$/;
const BANNED_TYPE=/player|inning|quarter|first_five|prop|future|award|mvp|margin|exact|anytime/;
function typeAllowed(market={}){
 const t=String(market.sportsMarketType||'').toLowerCase();
 if(!t)return String(market.sportsMarketTypeV2||'')==='SPORTS_MARKET_TYPE_MONEYLINE';
 if(BANNED_TYPE.test(t))return false;
 if(ALLOWED_TYPE.test(t))return true;
 return String(market.sportsMarketTypeV2||'')==='SPORTS_MARKET_TYPE_MONEYLINE';
}
const spreadLimitFor=liq=>liq>=10000?.12:liq>=3000?.08:.05;
function outcomeLabel(market,long){
 const side=(market.marketSides||[]).find(s=>!!s?.long===long);
 const team=side?.team?.abbreviation?String(side.team.abbreviation).toUpperCase():'';
 const desc=String(side?.description||'').trim();
 if(desc&&team&&!/^(yes|no)$/i.test(desc))return `${desc} (${team})`;
 if(desc&&team)return `${desc} (${team})`;
 if(desc)return desc;
 try{const outs=JSON.parse(market.outcomes||'[]');return String(outs[long?0:1]||(long?'Yes':'No'))}catch{return long?'Yes':'No'}
}

// Item 3: candidate filter + ranking at parity with the paper lab.
export function usCandidatesFromEvents(events=[],now=Date.now(),settings=usComboSettings()){
 const rejections={};
 const reject=r=>{rejections[r]=(rejections[r]||0)+1;return null};
 const rows=[],board=[],eventMeta=new Map();
 for(const event of events||[]){
  if(!event||event.live!==true||event.closed||event.ended){reject('not-live');continue}
  const live=normalizeUSLiveState(event);
  const freshnessSec=Math.max(0,(now-Number(event.__fetchedAt||now))/1000);
  if(freshnessSec>FRESH_LIMIT_SEC){reject('stale-live');continue}
  const eventSlug=String(event.slug||event.id||'');
  const title=String(event.title||eventSlug);
  const la=String(live.leagueAbbreviation||'');
  const lg=(live.sport==='tennis'||live.sport==='table-tennis'?la.replace(/^table tennis/,'table-tennis').replace(/\s*BO\d$/,'').replace(/\s+/g,' ').trim():la.split(' ')[0])||live.sport;
  const meta={eventSlug,event:title,sport:live.sport,league:lg,liveState:{period:live.rawPeriod,elapsed:live.rawElapsed,score:live.rawScore},comboEnabled:false,reason:null};
  eventMeta.set(eventSlug,meta);
  const skip=r=>{if(!meta.reason)meta.reason=r;return reject(r)};
  for(const market of event.markets||[]){
   if(!market)continue;
   if(market.comboEnabled===true)meta.comboEnabled=true;
   if(!typeAllowed(market)){skip('market-type');continue}
   if(market.comboEnabled!==true){reject('combo-disabled');continue}
   if(market.closed||(market.status&&market.status!=='MARKET_STATUS_OPEN')){skip('market-closed');continue}
   const ask=val(market.bestAskQuote??market.bestAsk),bid=val(market.bestBidQuote??market.bestBid);
   if(!(ask>0&&ask<1)){skip('no-quote');continue}
   const sides=market.marketSides||[];
   const longSide=sides.find(s=>s?.long===true),shortSide=sides.find(s=>s?.long===false);
   const longOk=!sides.length||longSide?.tradable!==false,shortOk=(!sides.length||shortSide?.tradable!==false)&&bid>0;
   const longAsk=ask,shortAsk=bid>0?r4(1-bid):null;
   let side=null,price=null;
   if(longOk&&(!shortOk||longAsk>=shortAsk)){side='SIDE_BUY';price=longAsk}
   else if(shortOk){side='SIDE_SELL';price=shortAsk}
   if(!side){skip('side-not-tradable');continue}
   const type=String(market.sportsMarketType||'').toLowerCase();
   // Window rejections keep the row on the board (manual add allowed, tagged
   // "outside strategy window"); price and spread rejections are not addable.
   const win=settings.window||'NEAR_END';
   const late=windowEstimate(win,{event:title,slug:String(market.slug||''),type},live,{maxMinutesLeft:settings.maxMinutesLeft,nearEndMin:NEAR_END_MIN});
   let reason=late.ok?null:(late.reason||'outside-window'),addable=true;
   const spread=bid>0?Math.max(0,r4(ask-bid)):null;
   const liquidity=num(market.__openInterest??market.openInterest);
   const liquidityKnown=liquidity>0;
   const spreadLimit=liquidityKnown?spreadLimitFor(liquidity):spreadLimitFor(10000); // unknown OI: lenient pre-filter, BBO pass tightens
   if(price<settings.priceMin||price>PRICE_MAX){reason='price-band';addable=false}
   else if(spread!=null&&spread>spreadLimit+1e-9){reason='spread';addable=false}
   const feeCoefficient=num(market.feeCoefficient)||0.06;
   const feePerContract=r4(standardFeePerContract(price,feeCoefficient));
   const eta=late.etaMinutes;
   const {rank,parts:rankParts}=rankBreakdown({nearEndScore:late.nearEndScore,price,liquidity,liquidityKnown,etaMinutes:eta,priorityBonus:late.priorityBonus,spread},settings.rankWeights);
   const row={key:`${market.slug}|${side}`,symbol:String(market.slug||''),side,
    eventSlug,event:title,league:lg,sport:live.sport,marketType:type,
    question:String(market.question||''),outcome:outcomeLabel(market,side==='SIDE_BUY'),
    price:r4(price),bid:r4(bid),ask:r4(ask),spread,spreadLimit,liquidity,liquidityKnown,
    liveState:{period:live.rawPeriod,elapsed:live.rawElapsed,score:live.rawScore},
    normalized:{period:live.period,elapsed:live.elapsed,score:live.score},
    etaMinutes:eta,nearEndScore:late.nearEndScore,lateReason:late.reason,window:win,rankParts,
    feeCoefficient,feePerContract,netPrice:r4(clamp(price+feePerContract,0,1)),rank,
    comboEnabled:true,minimumTradeQty:num(market.minimumTradeQty)||MIN_QTY,tickSize:num(market.orderPriceMinTickSize)||0.01,
    freshnessSec:Math.round(freshnessSec),at:now,
    eligible:!reason,reason,addable,outsideWindow:!!reason&&addable};
   if(reason){reject(reason);board.push(row)}else rows.push(row);
  }
 }
 // One leg per event (ledger item 3): keep the best-ranked market for each game.
 const best=new Map();
 for(const c of rows.sort((a,b)=>b.rank-a.rank))if(!best.has(c.eventSlug))best.set(c.eventSlug,c);
 const candidates=[...best.values()].sort((a,b)=>b.rank-a.rank);
 // Board: every live combo-enabled game, eligible first, else its best addable
 // row, else its best row, else a stub carrying the first structural reason.
 const boardBest=new Map(candidates.map(c=>[c.eventSlug,c]));
 const order=(a,b)=>(b.addable-a.addable)||(b.rank-a.rank);
 for(const c of board.sort(order))if(!boardBest.has(c.eventSlug))boardBest.set(c.eventSlug,c);
 for(const m of eventMeta.values())if(m.comboEnabled&&!boardBest.has(m.eventSlug))
  boardBest.set(m.eventSlug,{key:null,...m,eligible:false,addable:false,outsideWindow:false,reason:m.reason||'no-priceable-market'});
 return {candidates,board:[...boardBest.values()],rejections};
}

export function chooseUSCombo(candidates,maxLegs=2,journal={open:[],cooldowns:{}},now=Date.now()){
 const out=[],seen=new Set();
 const busyEvents=new Set((journal.open||[]).flatMap(x=>(x.legs||[]).map(l=>l.eventSlug)));
 const busySymbols=new Set((journal.open||[]).flatMap(x=>(x.legs||[]).map(l=>l.symbol)));
 for(const c of [...candidates].sort((a,b)=>b.rank-a.rank)){
  if(busyEvents.has(c.eventSlug)||busySymbols.has(c.symbol))continue;
  const cooldown=num(journal.cooldowns?.[c.eventSlug]);
  if(cooldown&&now-cooldown<COOLDOWN_MS)continue;
  if(seen.has(c.eventSlug))continue;
  seen.add(c.eventSlug);out.push(c);
  if(out.length>=maxLegs)break;
 }
 return out;
}

// -------------------------------------------------------------- combo math
export function standardFeePerContract(p,coefficient=0.06){const x=clamp(num(p),0,1);return coefficient*x*(1-x)}
export function comboCurveFeePerContract(p){const x=clamp(num(p),0,1);return x*(0.0695*(1-x)+0.04*Math.pow(1-x,4))}
// Item 4: per-contract combo taker fee. `auto` switches to the published combo
// curve at 11:59 PM ET 2026-09-16; before that the standard curve applies.
export function comboFeePerContract(p,at=Date.now(),coefficient=0.06){
 const mode=String(process.env.POLYMARKET_US_COMBO_FEE_MODE||'auto').toLowerCase();
 if(mode==='curve')return comboCurveFeePerContract(p);
 if(mode==='standard')return standardFeePerContract(p,coefficient);
 return at>=COMBO_CURVE_FROM?comboCurveFeePerContract(p):standardFeePerContract(p,coefficient);
}

// Stake is the complete cash budget, including rounded taker fees.
export function comboBudget(price,stakeUsd,at=Date.now(),coefficient=0.06){
 if(!Number.isFinite(price)||price<=0||price>=1||!Number.isFinite(Number(stakeUsd))||num(stakeUsd)<=0)fail('stakeInvalid','A finite price and positive total budget are required');
 const feePerContract=comboFeePerContract(price,at,coefficient);
 let quantity=r2(Math.floor((num(stakeUsd)/(price+feePerContract)+1e-9)/MIN_QTY)*MIN_QTY);
 const cashCost=q=>q*price+r2(q*feePerContract);
 while(quantity>0&&cashCost(quantity)>num(stakeUsd)+1e-9)quantity=r2(quantity-MIN_QTY);
 return {quantity,feePerContract,feeUsd:r2(quantity*feePerContract),costUsd:r2(cashCost(quantity)),
  notionalUsd:Math.floor((quantity*price+1e-9)*100)/100};
}

function resolveLegs(legKeys,candidates,now=Date.now(),settings=usComboSettings()){
 const keys=(Array.isArray(legKeys)?legKeys:[]).map(k=>String(k||'').trim()).filter(Boolean);
 if(keys.length<2)fail('invalidLegs','A combo needs at least 2 legs');
 if(keys.length>settings.maxLegs)fail('invalidLegs',`A combo accepts at most ${settings.maxLegs} legs (current setting)`);
 const index=new Map((candidates||[]).map(c=>[c.key,c]));
 const legs=[],symbols=new Set(),events=new Set();
 for(const key of keys){
  const c=index.get(key);
  if(!c)fail('invalidLegs',`Leg is no longer a live candidate: ${key}`);
  if(symbols.has(c.symbol))fail('invalidLegs',`Duplicate leg symbol: ${c.symbol}`);
  if(events.has(c.eventSlug))fail('duplicateEvent',`Two legs share the same event: ${c.eventSlug}`);
  const age=num(c.freshnessSec)+Math.max(0,(now-num(c.at||now))/1000);
  if(age>FRESH_LIMIT_SEC)fail('staleLeg',`Leg data is ${Math.round(age)}s old (limit ${FRESH_LIMIT_SEC}s): ${c.symbol}`);
  if(c.price<settings.priceMin||c.price>PRICE_MAX)fail('priceBand',`Leg price ${c.price} is outside the ${settings.priceMin}-${PRICE_MAX} band: ${c.symbol}`);
  symbols.add(c.symbol);events.add(c.eventSlug);
  legs.push({...c,freshnessSec:age});
 }
 return legs;
}

// Item 4: pure math, no network.
export function buildUSCombo({legKeys,stakeUsd,candidates=null,at=Date.now(),settings=usComboSettings()}={}){
 const pool=candidates||lastCandidates;
 const legs=resolveLegs(legKeys,pool,at,settings);
 const stake=num(stakeUsd);
 if(!(stake>0))fail('stakeInvalid','stakeUsd must be greater than 0');
 const rawPrice=legs.reduce((a,l)=>a*l.price,1);
 const price=Math.min(0.999,Math.max(TICK,r3(ceilTick(rawPrice))));
 const {quantity,feePerContract,feeUsd,costUsd,notionalUsd}=comboBudget(price,stake,at,legs.reduce((a,l)=>Math.max(a,num(l.feeCoefficient)),0.06));
 if(!(quantity>=MIN_QTY))fail('stakeInvalid',`Stake $${stake} is too small for a combo priced at ${price}`);
 const payoutUsd=r2(quantity);
 return {legs:legs.map(l=>({symbol:l.symbol,side:l.side,event:l.event,eventSlug:l.eventSlug,outcome:l.outcome,price:l.price,
   period:l.liveState.period,score:l.liveState.score,etaMinutes:l.etaMinutes,nearEndScore:l.nearEndScore,freshnessSec:l.freshnessSec,outsideWindow:!!l.outsideWindow,reason:l.reason??null})),
  outsideWindow:legs.some(l=>l.outsideWindow),window:settings.window||'NEAR_END',
  price,rawPrice:r4(rawPrice),decimalOdds:r3(1/price),quantity,feePerContract:r4(feePerContract),feeUsd,payoutUsd,costUsd,
  profitUsd:r2(payoutUsd-costUsd),stakeUsd:r2(stake),notionalUsd};
}

// ---------------------------------------------------------------- journal
function defaultSettings(){return {...Object.fromEntries(Object.entries(SETTINGS_BOUNDS).map(([k,b])=>[k,b.default])),window:'NEAR_END',rankWeights:{...DEFAULT_RANK_WEIGHTS}}}
// Out-of-range or garbage stored values fall back to the default, never to a wider band.
function normalizeSettings(s={}){
 const out=defaultSettings();
 for(const [k,b] of Object.entries(SETTINGS_BOUNDS)){const v=Number(s?.[k]);if(Number.isFinite(v)&&v>=b.min-1e-9&&v<=b.max+1e-9)out[k]=k==='priceMin'?r3(v):Math.round(v)}
 out.window=STRATEGY_WINDOWS.includes(s?.window)?s.window:'NEAR_END';
 out.rankWeights=normalizeWeights(s?.rankWeights);
 return out;
}
function defaultJournal(){return {version:1,combos:{},open:[],history:[],
 stats:{placed:0,won:0,lost:0,pnlUsd:0,hitRate:null},cooldowns:{},settings:defaultSettings()}}
function normalizeJournal(s={}){
 const out={...defaultJournal(),...s};
 out.combos=s.combos&&typeof s.combos==='object'?s.combos:{};
 out.open=Array.isArray(s.open)?s.open:[];
 out.history=Array.isArray(s.history)?s.history:[];
 out.cooldowns=s.cooldowns&&typeof s.cooldowns==='object'?s.cooldowns:{};
 out.settings=normalizeSettings(s.settings);
 delete out.autopilot; // autopilot was removed; old journals may still carry the key
 return out;
}
let journalCache=null;
function loadJournal(){
 if(journalCache)return journalCache;
 try{journalCache=normalizeJournal(JSON.parse(fs.readFileSync(STATE_FILE,'utf8')))}
 catch(e){
  if(e?.code==='ENOENT')journalCache=defaultJournal();
  else journalCache={...defaultJournal(),recoveryRequired:true,recoveryError:`STATE RECOVERY REQUIRED: ${e?.message||e}`};
 }
 return journalCache;
}
function saveJournal(s){
 journalCache=normalizeJournal(s);
 const dir=path.dirname(STATE_FILE);
 fs.mkdirSync(dir,{recursive:true});
 const tmp=path.join(dir,`.polymarket-us-combos.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}.tmp`);
 try{fs.writeFileSync(tmp,JSON.stringify(journalCache,null,2));renameSyncWithRetry(tmp,STATE_FILE)}
 catch(e){try{fs.rmSync(tmp,{force:true})}catch{}throw e}
 return journalCache;
}
function recomputeStats(j){
 const decided=j.history.filter(x=>x.status==='WON'||x.status==='LOST');
 const won=decided.filter(x=>x.status==='WON').length;
 j.stats={placed:num(j.stats?.placed),won,lost:decided.length-won,
  pnlUsd:r2(j.history.reduce((a,x)=>a+num(x.pnlUsd),0)),hitRate:decided.length?won/decided.length:null,
  byWindow:statsByWindow(j)};
 return j;
}
// Each strategy window keeps its own record. Legacy entries predate windows and ran NEAR_END rules;
// hand-built combos with an outside-window leg count under MANUAL.
export function entryWindow(x){return x?.outsideWindow?'MANUAL':(x?.window||'NEAR_END')}
function statsByWindow(j){
 const out={};
 const row=w=>out[w]||(out[w]={open:0,won:0,lost:0,pnlUsd:0,stakedUsd:0,hitRate:null,roi:null});
 for(const x of j.open)row(entryWindow(x)).open++;
 for(const x of j.history){
  if(x.status!=='WON'&&x.status!=='LOST')continue;
  const r=row(entryWindow(x));
  if(x.status==='WON')r.won++;else r.lost++;
  r.pnlUsd=r2(r.pnlUsd+num(x.pnlUsd));r.stakedUsd=r2(r.stakedUsd+num(x.stakeUsd));
 }
 for(const r of Object.values(out)){const n=r.won+r.lost;r.hitRate=n?r.won/n:null;r.roi=r.stakedUsd>0?r2(r.pnlUsd/r.stakedUsd):null}
 return out;
}
function startOfDay(now=Date.now()){const d=new Date(now);d.setHours(0,0,0,0);return d.getTime()}
function realizedTodayUsd(j=loadJournal(),now=Date.now()){
 const from=startOfDay(now);
 return r2(j.history.filter(x=>num(x.settledAt)>=from).reduce((a,x)=>a+num(x.pnlUsd),0));
}

// ---------------------------------------------------------------- settings
export function usComboSettings(){return {...loadJournal().settings}}
export function setUSComboSettings(patch={}){
 const j=loadJournal();
 if(j.recoveryRequired)fail('stateRecovery','Local combo journal is corrupt; refusing to overwrite it until recovered');
 const next={...j.settings};
 for(const [k,b] of Object.entries(SETTINGS_BOUNDS)){
  if(patch?.[k]===undefined)continue;
  const v=Number(patch[k]);
  if(!Number.isFinite(v)||v<b.min-1e-9||v>b.max+1e-9)fail('settingsInvalid',`${k} must be between ${b.min} and ${b.max}`);
  next[k]=k==='priceMin'?r3(v):Math.round(v);
 }
 if(patch?.window!==undefined){
  if(!STRATEGY_WINDOWS.includes(patch.window))fail('settingsInvalid',`window must be one of ${STRATEGY_WINDOWS.join(', ')}`);
  next.window=patch.window;
 }
 if(patch?.rankWeights!==undefined){
  const w=patch.rankWeights||{};
  for(const [k,v] of Object.entries(w)){
   if(!(k in RANK_COMPONENTS))fail('settingsInvalid',`unknown rank component: ${k}`);
   const n=Number(v);if(!Number.isFinite(n)||n<RANK_WEIGHT_BOUNDS.min||n>RANK_WEIGHT_BOUNDS.max)fail('settingsInvalid',`rank weight ${k} must be between ${RANK_WEIGHT_BOUNDS.min} and ${RANK_WEIGHT_BOUNDS.max}`);
  }
  next.rankWeights=normalizeWeights({...next.rankWeights,...w});
 }
 j.settings=next;
 saveJournal(j);
 snapCache={at:0,data:null};
 return {...next};
}

// ------------------------------------------------------------------- gates
function requireCredentials(){
 const r=usReadiness();
 if(!r.credentialsReady)fail('noCredentials','Polymarket US API credentials are not configured');
 return r;
}
function requireArmed(){
 const j=loadJournal();
 if(j.recoveryRequired)fail('stateRecovery','Local combo journal is corrupt; refusing signed actions until recovered')
 const r=requireCredentials();
 if(r.realEnabled===false||!r.sessionArmed)fail('notArmed','Real Polymarket US trading is not armed for this session');
 return r;
}

// --------------------------------------------------------------- RFQ / place
let betaAccess='unknown';
let lastQuote=null;
let lastCandidates=[];
let lastError=null;

async function createCombo(legs){
 const body={legs:legs.map(l=>({symbol:l.symbol,side:l.side}))};
 const j=await signedFetch('POST','/v1/combos',{body});
 const symbol=String(j?.combo?.id||j?.combo?.symbol||'');
 if(!symbol)fail('http','Polymarket US did not return a combo symbol');
 betaAccess='enabled';
 const s=loadJournal();
 s.combos[symbol]={symbol,legs:body.legs,detail:legs,at:Date.now()};
 saveJournal(s);
 return {symbol,combo:j.combo};
}

// Item 6: create combo -> RFQ -> poll quotes -> best ACTIVE buyPrice.
// Every RFQ attempt is evidence: the quote vs the ask-product estimate (markup), or no quote / error.
function logRfq(row){
 try{appendNdjson('polymarket-us-rfq',[{schema:'mpo.polymarket-us-rfq.v1',...row,markup:row.quoted!=null&&row.askProduct!=null?r4(row.quoted-row.askProduct):null}])}catch{}
}
export async function quoteUSCombo(opts={}){
 let combo=null;
 try{
  const q=await quoteUSComboInner(opts,c=>{combo=c});
  logRfq({at:Date.now(),legs:combo.legs.map(l=>l.symbol),legCount:combo.legs.length,askProduct:combo.rawPrice,estPrice:combo.price,quoted:q.buyPrice,outcome:'quote'});
  return q;
 }catch(e){
  if(combo)logRfq({at:Date.now(),legs:combo.legs.map(l=>l.symbol),legCount:combo.legs.length,askProduct:combo.rawPrice,estPrice:combo.price,quoted:null,
   outcome:e?.code==='noQuote'?'noQuote':/timeout|aborted/i.test(String(e?.message))?'timeout':'error',code:e?.code||null});
  throw e;
 }
}
async function quoteUSComboInner({legKeys,stakeUsd,waitMs=8000,candidates=null}={},onCombo=()=>{}){
 requireArmed();
 const limits=usComboLimits(),stakeReq=num(stakeUsd);
 if(!(stakeReq>0))fail('stakeInvalid','stakeUsd must be greater than 0');
 if(stakeReq>limits.maxStakeUsd+1e-9)fail('stakeCap',`Stake $${r2(stakeReq)} exceeds the $${limits.maxStakeUsd} per-combo cap`);
 const pool=candidates||await refreshCandidates();
 const combo=buildUSCombo({legKeys,stakeUsd,candidates:pool});
 onCombo(combo);
 const {symbol}=await createCombo(combo.legs);
 const rfq=await signedFetch('POST','/v1/rfqs',{body:{symbol,cashOrderQty:combo.notionalUsd.toFixed(2),restRemainder:false}});
 const rfqId=String(rfq?.rfqId||'');
 if(!rfqId)fail('http','Polymarket US did not return an rfqId');
 const deadline=Date.now()+Math.max(QUOTE_POLL_MS,num(waitMs)||8000);
 let best=null;
 while(Date.now()<deadline){
  const res=await signedFetch('GET','/v1/rfqs/quotes',{query:{rfqId}});
  const quotes=Array.isArray(res?.quotes)?res.quotes:[];
  const active=quotes.filter(q=>q?.status==='QUOTE_STATUS_ACTIVE'&&num(q.buyPrice)>0);
  if(active.length){best=active.sort((a,b)=>num(a.buyPrice)-num(b.buyPrice))[0];break}
  await new Promise(r=>setTimeout(r,QUOTE_POLL_MS));
 }
 if(!best){
  try{await cancelUSRfq({rfqId})}catch{}
  fail('noQuote',`No market maker quoted ${symbol} within ${Math.round(num(waitMs)||8000)/1000}s`);
 }
 lastQuote={symbol,rfqId,quoteId:String(best.id||''),buyPrice:r4(best.buyPrice),buyQtyDecimal:String(best.buyQtyDecimal||combo.quantity),
  expiresAt:Date.parse(best.confirmationDeadline||best.executionDeadline||'')||Date.now()+8000,
  status:String(best.status||''),legs:combo.legs,estPrice:combo.price,stakeUsd:combo.stakeUsd,at:Date.now()};
 return lastQuote;
}

export async function cancelUSRfq({rfqId}={}){
 requireCredentials();
 const id=String(rfqId||'').trim();
 if(!id)fail('invalidLegs','rfqId is required');
 await signedFetch('DELETE',`/v1/rfqs/${encodeURIComponent(id)}`);
 if(lastQuote?.rfqId===id)lastQuote=null;
 return {ok:true,rfqId:id};
}

// Item 7: every gate is enforced here, server-side. One placement at a time (B3).
let placeBusy=null;
export async function placeUSCombo(args={}){
 if(placeBusy)fail('busy','Another combo placement is already in flight');
 placeBusy=placeUSComboLocked(args).finally(()=>{placeBusy=null});
 return placeBusy;
}
async function placeUSComboLocked({legKeys,stakeUsd,mode='rfq',rfqId=null,quoteId=null,limitPrice=null,confirmation='',placedBy='manual'}={}){
 requireArmed();
 if(confirmation!==CONFIRM_PLACE)fail('confirmation',`Explicit ${CONFIRM_PLACE} confirmation required`);
 const limits=usComboLimits();
 const stake=num(stakeUsd);
 if(!(stake>0))fail('stakeInvalid','stakeUsd must be greater than 0');
 if(stake>limits.maxStakeUsd+1e-9)fail('stakeCap',`Stake $${r2(stake)} exceeds the $${limits.maxStakeUsd} per-combo cap`);
 const j=loadJournal();
 if(j.open.length>=limits.maxOpen)fail('openCap',`${j.open.length} combos already open (cap ${limits.maxOpen})`);
 const realized=realizedTodayUsd(j);
 if(realized<=-Math.abs(limits.dailyLossCapUsd))fail('dailyLossCap',`Daily realized loss $${r2(-realized)} has reached the $${limits.dailyLossCapUsd} cap`);
 const pool=await refreshCandidates();
 const combo=buildUSCombo({legKeys,stakeUsd:stake,candidates:pool});
 const now=Date.now();
 for(const leg of combo.legs){
  if(num(leg.freshnessSec)>FRESH_LIMIT_SEC)fail('staleLeg',`Leg ${leg.symbol} data is stale`);
  const cool=num(j.cooldowns[leg.eventSlug]);
  if(cool&&now-cool<COOLDOWN_MS)fail('cooldown',`Event ${leg.eventSlug} is in the ${COOLDOWN_MS/60000}-minute post-settlement cooldown`);
  for(const open of j.open){
   if((open.legs||[]).some(x=>x.symbol===leg.symbol))fail('duplicate',`Leg ${leg.symbol} is already in open combo ${open.symbol}`);
   if((open.legs||[]).some(x=>x.eventSlug===leg.eventSlug))fail('duplicate',`Event ${leg.eventSlug} already has an open combo`);
  }
 }
 const tolerance=limits.priceTolerance;
 let entry;
 if(mode==='limit'){
  const price=r3(Math.min(0.999,Math.max(TICK,ceilTick(limitPrice==null?combo.price:num(limitPrice)))));
  if(price>combo.price+tolerance+1e-9)fail('priceTolerance',`Limit ${price} exceeds est. ${combo.price} + tolerance ${tolerance}`);
  const limitQty=comboBudget(price,stake).quantity;
  if(!(limitQty>=MIN_QTY))fail('stakeInvalid',`Stake $${r2(stake)} is too small at limit price ${price}`);
  const {symbol}=await createCombo(combo.legs);
  const order={marketSlug:symbol,intent:'ORDER_INTENT_BUY_LONG',type:'ORDER_TYPE_LIMIT',
   price:{value:price.toFixed(3),currency:'USD'},quantity:limitQty,
   tif:'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',participateDontInitiate:false,
   manualOrderIndicator:'MANUAL_ORDER_INDICATOR_MANUAL'};
  await signedFetch('POST','/v1/order/preview',{body:order});
  const placed=await signedFetch('POST','/v1/orders',{body:order});
  entry=journalEntry({combo,symbol,mode:'limit',price,quantity:limitQty,orderId:String(placed?.id||placed?.order?.id||placed?.orderId||''),placedBy});
 }else{
  const id=String(rfqId||lastQuote?.rfqId||'').trim(),qid=String(quoteId||lastQuote?.quoteId||'').trim();
  if(!id||!qid)fail('noQuote','A live RFQ quote is required before placing (rfqId + quoteId)');
  // Never trust a client-supplied price: re-read the quote before accepting.
  const res=await signedFetch('GET','/v1/rfqs/quotes',{query:{rfqId:id}});
  const quote=(Array.isArray(res?.quotes)?res.quotes:[]).find(q=>String(q?.id||'')===qid);
  if(!quote)fail('noQuote','Quote is no longer available');
  if(quote.status!=='QUOTE_STATUS_ACTIVE')fail('noQuote',`Quote is ${quote.status}, not active`);
  const buyPrice=r4(quote.buyPrice);
  if(!(buyPrice>0))fail('noQuote','Quote has no executable buy price');
  if(buyPrice>combo.price+tolerance+1e-9)fail('priceTolerance',`Quote ${buyPrice} exceeds est. ${combo.price} + tolerance ${tolerance}`);
  // B2: the quote must be for the canonical combo of exactly these legs (createCombo is idempotent).
  const legSig=combo.legs.map(l=>`${l.symbol}|${l.side}`).sort().join(',');
  const known=j.combos[String(quote.symbol||'')];
  const knownSig=known?(known.legs||[]).map(l=>`${l.symbol}|${l.side}`).sort().join(','):null;
  const boundSymbol=knownSig===legSig?String(quote.symbol):(await createCombo(combo.legs)).symbol;
  if(String(quote.symbol||'')!==boundSymbol)fail('quoteMismatch',`Quote is for ${quote.symbol||'?'}, not for the selected legs (${boundSymbol}); request a new quote`);
  // B1: the maker-derived quantity, not the request field, is what gets bought. Bind it to the capped stake.
  const quoteQty=r2(num(quote.buyQtyDecimal));
  if(!(quoteQty>=MIN_QTY))fail('noQuote','Quote has no executable buy quantity');
  const allIn=quoteQty*buyPrice+r2(quoteQty*comboFeePerContract(buyPrice));
  if(allIn>Math.min(stake,limits.maxStakeUsd)+1e-9)fail('stakeCap',`Quote notional plus fees $${r2(allIn)} exceeds the $${r2(Math.min(stake,limits.maxStakeUsd))} total budget`);
  const expiresAt=Date.parse(quote.confirmationDeadline||quote.executionDeadline||'');
  if(Number.isFinite(expiresAt)&&expiresAt<=Date.now())fail('noQuote','Quote expired before acceptance');
  // Journal before accept: a crash or transport failure after this point can never leave an
  // untracked position. The entry stays SUBMITTED/unverified until reconcile reads the real order.
  entry=journalEntry({combo,symbol:boundSymbol,mode:'rfq',price:buyPrice,quantity:quoteQty,
   rfqId:id,quoteId:qid,orderId:String(quote.rfqCreatorOrderId||''),placedBy});
  const pre=loadJournal();
  pre.open.push(entry);
  saveJournal(pre);
  const settle=(patch,count)=>{
   const s=loadJournal();
   const idx=s.open.findIndex(x=>x.id===entry.id);
   if(idx<0)return;
   if(patch===null)s.open.splice(idx,1);else s.open[idx]={...s.open[idx],...patch};
   if(count)s.stats.placed=num(s.stats.placed)+1;
   saveJournal(recomputeStats(s));
  };
  try{
   await signedFetch('PUT',`/v1/rfqs/${encodeURIComponent(id)}/quotes/${encodeURIComponent(qid)}/accept`,{body:{acceptedSide:'SIDE_BUY'}});
  }catch(e){
   // Only a definite exchange rejection (4xx) proves nothing was accepted. A timeout, network error or
   // 5xx may still have accepted, so that entry stays for reconcile (which cancels it if the quote died unaccepted).
   const status=num(e?.status);
   if(status>=400&&status<500)settle(null,false);
   else settle({acceptUncertain:true,acceptError:String(e?.message||e).slice(0,200)},true);
   throw e;
  }
  try{
   await signedFetch('PUT',`/v1/rfqs/${encodeURIComponent(id)}/quotes/${encodeURIComponent(qid)}/confirm`,{body:{}});
  }catch(e){
   // Accepted but not confirmed: the maker may still fill. Keep the entry; reconcile decides.
   settle({confirmError:String(e?.message||e).slice(0,200)},true);
   if(e&&typeof e==='object')e.entryId=entry.id;
   throw e;
  }
  if(lastQuote?.rfqId===id)lastQuote=null;
  settle({},true);
  return {ok:true,entry:loadJournal().open.find(x=>x.id===entry.id)||entry};
 }
 const s=loadJournal();
 s.open.push(entry);
 s.stats.placed=num(s.stats.placed)+1;
 saveJournal(recomputeStats(s));
 return {ok:true,entry};
}

function journalEntry({combo,symbol,mode,price,quantity=null,rfqId=null,quoteId=null,orderId='',placedBy='manual'}){
 const qty=quantity!=null?r2(quantity):combo.quantity;
 return {id:`uc-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`,at:Date.now(),symbol,
  legs:combo.legs,estPrice:combo.price,fillPrice:price,quantity:qty,requestedQuantity:combo.quantity,stakeUsd:combo.stakeUsd,
  mode,rfqId,quoteId,orderId,status:'SUBMITTED',fillVerified:false,payoutUsd:null,pnlUsd:null,settledAt:null,
  costUsd:r2(qty*price+qty*comboFeePerContract(price)),placedBy,window:combo.window||'NEAR_END',outsideWindow:!!combo.outsideWindow};
}

// Operator escape hatch: drop an open entry from the local book without touching the exchange.
// It frees a slot and the legs' duplicate gate; it books no P/L and starts no cooldown.
export function forgetUSCombo({id,confirmation}={}){
 if(confirmation!=='FORGET')fail('confirmation','Type FORGET to drop an open combo entry from the local journal');
 const j=loadJournal();
 const idx=j.open.findIndex(x=>String(x.id)===String(id||''));
 if(idx<0)fail('notFound','No open combo entry with that id');
 const [entry]=j.open.splice(idx,1);
 const gone={...entry,status:'FORGOTTEN',pnlUsd:0,payoutUsd:null,forgottenAt:Date.now()};
 j.history=[gone,...j.history].slice(0,200);
 saveJournal(recomputeStats(j));
 return {ok:true,entry:gone};
}

// M2: reconcile journalled entries against real exchange orders before settling.
// SUBMITTED -> OPEN (filled qty verified) | CANCELLED (nothing filled) ; unknown shapes stay SUBMITTED.
const TERMINAL_UNFILLED=/CANCEL|REJECT|EXPIRE/i;
export async function reconcileUSOrders(j=loadJournal()){
 let changed=0,aborted=null;
 const keep=[];
 for(let i=0;i<j.open.length;i++){
  const entry=j.open[i];
  if(aborted){keep.push(entry);continue}
  if(entry.fillVerified||entry.status==='CANCELLED'){keep.push(entry);continue}
  try{
   if(!entry.orderId&&entry.rfqId&&entry.quoteId){
    const res=await signedFetch('GET','/v1/rfqs/quotes',{query:{rfqId:entry.rfqId}});
    const q=(Array.isArray(res?.quotes)?res.quotes:[]).find(x=>String(x?.id||'')===String(entry.quoteId));
    if(q?.rfqCreatorOrderId){entry.orderId=String(q.rfqCreatorOrderId);changed++}
    // A quote that was never accepted and is now gone was never a trade. An accepted quote that vanished
    // without an order id may still be a filled position: leave it open and unverified (never write it off).
    else if(q&&/DELETED/.test(String(q.status||''))&&!q.acceptedTime&&!q.confirmedTime&&!q.executedTime){keep.push({...entry,status:'CANCELLED',fillVerified:true,pnlUsd:0,cancelledAt:Date.now()});changed++;continue}
   }
   if(entry.orderId){
    const r=await signedFetch('GET',`/v1/order/${encodeURIComponent(entry.orderId)}`);
    const o=r?.order||r||{};
    const state=String(o.state||o.status||'');
    const qty=num(o.quantity),leaves=num(o.leavesQuantity);
    const quantitiesKnown=o.quantity!=null&&o.leavesQuantity!=null&&Number.isFinite(Number(o.quantity))&&Number.isFinite(Number(o.leavesQuantity))&&leaves>=0&&leaves<=qty;
    const filled=quantitiesKnown&&qty>0?r2(qty-leaves):null;
    if(filled!=null&&filled<=0&&TERMINAL_UNFILLED.test(state)){keep.push({...entry,status:'CANCELLED',fillVerified:true,pnlUsd:0,cancelledAt:Date.now()});changed++;continue}
    if(filled!=null&&filled>0&&(leaves<=0||TERMINAL_UNFILLED.test(state)||/FILL/i.test(state))){
     const price=num(entry.fillPrice);
     keep.push({...entry,quantity:filled,costUsd:r2(filled*price+r2(filled*comboFeePerContract(price,num(entry.at)||Date.now()))),status:'OPEN',fillVerified:true,verifiedAt:Date.now()});changed++;continue;
    }
   }
  }catch(e){if(e?.code==='keyNotFound'||e?.code==='betaNotEnabled')aborted=e.code}
  keep.push(entry); // N1: an entry is never dropped, whatever the transport did
 }
 if(keep.length!==j.open.length)throw new Error('reconcile invariant: entry count changed');
 if(changed){
  // Cancelled entries leave the open book without touching P/L or cooldowns.
  j.open=keep.filter(x=>x.status!=='CANCELLED');
  j.history=[...keep.filter(x=>x.status==='CANCELLED'),...j.history].slice(0,200);
  saveJournal(recomputeStats(j));
 }
 return {changed,aborted};
}

// ------------------------------------------------------------- settlement
let settleAt=0,settleBusy=null;
const settlementCache=new Map();
export function comboDue(entry,now=nowMs()){
 const etas=(entry?.legs||[]).filter(l=>l?.etaMinutes!==null&&l?.etaMinutes!==undefined&&l?.etaMinutes!=='').map(l=>Number(l.etaMinutes)).filter(Number.isFinite);
 const at=Number(entry?.at);
 if(!etas.length||!Number.isFinite(at)||at<=0)return false;
 const dueAt=at+Math.max(...etas)*60000;
 return now>=dueAt&&now<dueAt+SETTLE_FAST.windowMs;
}
function cachedSettlement(symbol,pendingTtlMs=SETTLE_CACHE_PENDING_MS){
 const hit=settlementCache.get(String(symbol||''));
 if(!hit)return undefined;
 const ttl=hit.value===null?pendingTtlMs:SETTLE_CACHE_RESOLVED_MS;
 if(nowMs()-hit.at>=ttl){settlementCache.delete(String(symbol||''));return undefined}
 return hit.value;
}
async function fetchSettlement(symbol,{pendingTtlMs=SETTLE_CACHE_PENDING_MS}={}){
 const key=String(symbol||'');if(!key)return null;
 const hit=cachedSettlement(key,pendingTtlMs);if(hit!==undefined)return hit;
 const r=await signedFetch('GET',`/v1/markets/${encodeURIComponent(key)}/settlement`);
 const settledAt=r?.settledAt||r?.marketSettlement?.settledAt;
 const px=val(r?.settlementPrice??r?.marketSettlement?.settlementPrice);
 const value=settledAt?{px:clamp(px,0,1),settledAt}:null;
 settlementCache.set(key,{at:nowMs(),value});
 return value;
}
async function settlementValue(entry){
 const legs=entry?.legs||[];
 const pendingTtlMs=comboDue(entry)?SETTLE_FAST.pendingMs:SETTLE_CACHE_PENDING_MS;
 let value=1;
 for(let i=0;i<legs.length;i+=SETTLE_FETCH_CONCURRENCY){
  const chunk=legs.slice(i,i+SETTLE_FETCH_CONCURRENCY);
  const rows=await Promise.all(chunk.map(l=>fetchSettlement(l.symbol,{pendingTtlMs})));
  if(rows.some(x=>x===null))return null;
  for(let k=0;k<chunk.length;k++){const leg=chunk[k],px=rows[k].px;value*=leg.side==='SIDE_SELL'?clamp(1-px,0,1):clamp(px,0,1)}
 }
 return value;
}
export async function settleUSCombos({force=false}={}){
 const preview=loadJournal();
 const throttle=preview.open.some(e=>e.fillVerified===true&&comboDue(e))?SETTLE_FAST.throttleMs:SETTLE_THROTTLE_MS;
 if(!force&&nowMs()-settleAt<throttle)return {ran:false,reason:'throttled'};
 if(settleBusy)return settleBusy;
 settleAt=nowMs();
 settleBusy=(async()=>{
  let j=loadJournal();
  if(!j.open.length)return {ran:true,settled:0};
  if(!usReadiness().credentialsReady)return {ran:false,reason:'noCredentials'};
  try{await reconcileUSOrders(j);j=loadJournal()}catch{}
  if(!j.open.length)return {ran:true,settled:0};
  let settled=0;
  const stillOpen=[];
  for(const entry of j.open){
   // N2: never settle (and never book P/L for) an order whose fill was not verified on the exchange.
   if(entry.fillVerified!==true){stillOpen.push(entry);continue}
   let value=null;
   try{value=await settlementValue(entry)}catch(e){
    if(e?.code==='keyNotFound'||e?.code==='betaNotEnabled'){entry.status='UNKNOWN';stillOpen.push(entry);continue}
   }
   if(value===null){stillOpen.push(entry);continue}
   const payout=r2(num(entry.quantity)*value);
   const pnl=r2(payout-num(entry.costUsd));
   settled++;
   const closed={...entry,status:pnl>0?'WON':'LOST',payoutUsd:payout,pnlUsd:pnl,settledAt:nowMs()};
   j.history.unshift(closed);
   for(const leg of closed.legs||[])j.cooldowns[leg.eventSlug]=nowMs();
  }
  j.open=stillOpen;
  j.history=j.history.slice(0,200);
  saveJournal(recomputeStats(j));
  return {ran:true,settled};
 })().finally(()=>{settleBusy=null});
 return settleBusy;
}

let loopTimer=null;
export function startUSComboLoops(){
 if(loopTimer||!AUTOSTART())return loopTimer;
 loopTimer=setInterval(()=>{
  settleUSCombos().catch(()=>{});
 },5000);
 loopTimer.unref?.();
 return loopTimer;
}
export function stopUSComboLoops(){if(loopTimer)clearInterval(loopTimer);loopTimer=null}

// --------------------------------------------------------------- snapshot
async function enrichBBO(candidates){
 const settings=usComboSettings();
 const out=await mapLimit(candidates.slice(0,12),4,async c=>{
  try{
   const cached=bboCache.get(c.symbol);
   const data=cached&&Date.now()-cached.at<BBO_TTL_MS?cached.data:(await publicFetch(`/v1/markets/${encodeURIComponent(c.symbol)}/bbo`))?.marketData;
   if(!cached||Date.now()-cached.at>=BBO_TTL_MS)bboCache.set(c.symbol,{at:Date.now(),data});
   if(!data)return null;
   const ask=val(data.bestAsk),bid=val(data.bestBid),liquidity=num(data.openInterest);
   if(!(ask>0&&ask<1&&bid>0&&bid<=ask))return null;
   const price=c.side==='SIDE_SELL'?r4(1-bid):r4(ask);
   const spread=bid>0?Math.max(0,r4(ask-bid)):null;
   const spreadLimit=spreadLimitFor(liquidity);
   if(price<settings.priceMin||price>PRICE_MAX)return null;
   if(spread!=null&&spread>spreadLimit+1e-9)return null;
   const feePerContract=r4(standardFeePerContract(price,c.feeCoefficient));
   const rank=c.nearEndScore*4+(100-Math.abs(price-.90)*260)+Math.min(35,Math.log10(Math.max(1,liquidity))*8)-c.etaMinutes*8-spread*500;
   return {...c,price,bid:r4(bid),ask:r4(ask),spread,spreadLimit,liquidity,liquidityKnown:liquidity>0,feePerContract,rank:Math.round(rank),
    netPrice:r4(clamp(price+feePerContract,0,1)),priceSource:'bbo',bookAt:bboCache.get(c.symbol)?.at||Date.now()};
  }catch{return null;}
 });
 return out.filter(c=>c&&!c.__error).sort((a,b)=>b.rank-a.rank);
}

// Manual picks: board rows rejected only by the strategy window may still be built by hand.
function withManualRows(candidates,board=[]){
 const have=new Set(candidates.map(c=>c.key));
 return [...candidates,...board.filter(b=>b.key&&b.outsideWindow&&!have.has(b.key))];
}
async function refreshCandidates(){
 const f=await usLiveEvents();
 const {candidates,board}=usCandidatesFromEvents(f.ok?f.events:[],Date.now());
 const enriched=String(process.env.POLYMARKET_US_COMBO_BBO||'true').toLowerCase()==='false'?candidates:await enrichBBO(candidates);
 lastCandidates=withManualRows(enriched,board);
 return lastCandidates;
}

let snapCache={at:0,data:null},snapBusy=null;
export async function usComboSnapshot({force=false}={}){
 if(!force&&snapCache.data&&Date.now()-snapCache.at<SNAPSHOT_TTL_MS)return snapCache.data;
 if(snapBusy)return snapBusy;
 snapBusy=(async()=>{
  const now=Date.now();
  const readiness=usReadiness();
  let candidates=[],board=[],rejections={},feedErr=null,feedInfo={};
  try{
   const f=await usLiveEvents({force});
   const built=usCandidatesFromEvents(f.ok?f.events:[],Date.now());
   rejections=built.rejections;
   candidates=String(process.env.POLYMARKET_US_COMBO_BBO||'true').toLowerCase()==='false'?built.candidates:await enrichBBO(built.candidates);
   const enrichedByKey=new Map(candidates.map(c=>[c.key,c]));
   board=built.board.map(b=>enrichedByKey.get(b.key)||(b.eligible?{...b,eligible:false,addable:false,reason:'bbo-filter'}:b));
   lastCandidates=withManualRows(candidates,built.board);
   feedInfo={total:f.total??f.inPlay,comboLive:f.comboLive??null,pages:f.pages??null,capped:!!f.capped};
   feedErr=f.ok?null:f.error;
  }catch(e){feedErr=String(e?.message||e);lastError=feedErr}
  const j=loadJournal();
  if(lastQuote&&num(lastQuote.expiresAt)<now)lastQuote=null;
  let suggested=null;
  const picked=chooseUSCombo(candidates,j.settings.maxLegs,j);
  if(picked.length>=2){
   try{
    const c=buildUSCombo({legKeys:picked.map(l=>l.key),stakeUsd:Math.min(SUGGEST_STAKE_USD,usComboLimits().maxStakeUsd),candidates,at:now});
    suggested={legs:picked.map(l=>l.key),price:c.price,decimalOdds:c.decimalOdds,stakeUsd:c.stakeUsd,
     quantity:c.quantity,feeUsd:c.feeUsd,payoutUsd:c.payoutUsd,profitUsd:c.profitUsd};
   }catch{suggested=null}
  }
  const data={at:now,
   readiness:{credentialsReady:!!readiness.credentialsReady,sessionArmed:!!readiness.sessionArmed,realEnabled:readiness.realEnabled!==false,
    lastAuthError:readiness.lastAuthError??null,authCode:readiness.authCode??null,developerPortal:'https://polymarket.us/developer'},
   feed:{ok:!feedErr,error:feedErr,ageMs:feed.at?Math.max(0,Date.now()-feed.at):null,eventsInPlay:feed.inPlay,eventsLive:feed.live,
    candidates:candidates.length,rejections,...feedInfo},
   // The panel lists games by time left, soonest first.
   candidates:[...candidates].sort((a,b)=>num(a.etaMinutes)-num(b.etaMinutes)||b.rank-a.rank).slice(0,20),
   board:board.slice(0,400),
   suggested,
   quote:lastQuote,
   journal:{open:j.open,history:j.history.slice(0,8),stats:{...j.stats,unverified:j.open.filter(x=>x.fillVerified!==true).length}},
   limits:usComboLimits(),
   settings:{...j.settings},
   settingsBounds:SETTINGS_BOUNDS,windows:STRATEGY_WINDOWS,windowRules:WINDOW_RULES,rankWeightBounds:RANK_WEIGHT_BOUNDS,
   betaAccess,
   lastError};
  snapCache={at:now,data};
  return data;
 })().finally(()=>{snapBusy=null});
 return snapBusy;
}

export const __testing={resetJournal(){journalCache=null;lastQuote=null;lastCandidates=[];betaAccess='unknown';lastError=null;snapCache={at:0,data:null};feed={at:0,fetchedAt:0,ok:false,error:null,events:[],inPlay:0,live:0};bboCache.clear();settlementCache.clear();settleAt=0;settleClock=null;placeBusy=null},
 setClock(fn){settleClock=typeof fn==='function'?fn:null},
 get lastQuote(){return lastQuote},get candidates(){return lastCandidates},stateFile:STATE_FILE,CONFIRM_PLACE,SETTLE_THROTTLE_MS,SETTLE_CACHE_PENDING_MS,SETTLE_CACHE_RESOLVED_MS,SETTLE_FETCH_CONCURRENCY,settlementCache};
