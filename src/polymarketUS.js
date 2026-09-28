import fs from 'node:fs';
import { assertLiveDispatchAllowed } from './core/executionBoundary.js';
import path from 'node:path';
import { PolymarketUS } from 'polymarket-us';

const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||path.join(process.cwd(),'data'));
const USER_ROOT=path.dirname(DATA_DIR);
const ENV_FILE=path.join(USER_ROOT,'.env');
const PUBLIC=new PolymarketUS({timeout:15000});
let authClient=null,authKey='';
let sessionArmed=false,privateWs=null,marketWs=null,marketWsKey='';
let usCache={at:0,data:null},usBusy=null;
let incentiveCache={at:0,map:null};
const bboCache=new Map();
const stream={connected:false,privateConnected:false,lastMarketAt:0,lastPrivateAt:0,prices:{},trades:{},balance:null,positions:null,orders:null,error:null};
// Item 15: remember the most recent authenticated failure so the UI can say
// "regenerate keys at polymarket.us/developer" instead of showing a blank panel.
let lastAuth={error:null,code:null,at:0};
const UA=()=>process.env.POLYMARKET_US_UA||'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MoneyPrinterOS/0.5';
export function classifyUSAuthError(message='',status=0){
 const t=String(message||'');
 if(status===401||/api key not found|key not found|missing required api key|invalid signature|unauthorized/i.test(t))return 'keyNotFound';
 if(status===403||/not enabled|beta|permission|not authorized|forbidden/i.test(t))return 'betaNotEnabled';
 if(status===429||/rate limit|too many requests/i.test(t))return 'rateLimited';
 if(/fetch failed|timeout|network|abort|econn|enotfound/i.test(t))return 'network';
 return t?'unknown':'ok';
}
export function noteUSAuthResult({code=null,message=null,status=0}={}){
 const resolved=code||classifyUSAuthError(message,status);
 if(resolved==='ok'){lastAuth={error:null,code:'ok',at:Date.now()};return lastAuth}
 lastAuth={error:message?String(message).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,240):resolved,code:resolved,at:Date.now()};
 return lastAuth;
}
export function usLastAuth(){return {...lastAuth}}
const n=v=>Number.isFinite(Number(v))?Number(v):0;
const val=x=>n(x?.value??x);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

function creds(){return {keyId:String(process.env.POLYMARKET_KEY_ID||'').trim(),secretKey:String(process.env.POLYMARKET_SECRET_KEY||'').trim()}}
function client(){const c=creds(),k=c.keyId+'|'+c.secretKey;if(!c.keyId||!c.secretKey)return null;if(!authClient||k!==authKey){authClient=new PolymarketUS({...c,timeout:20000});authKey=k}return authClient}
export function usReadiness(){const c=creds(),credentialsReady=!!(c.keyId&&c.secretKey),realEnabled=String(process.env.POLYMARKET_US_REAL_ENABLED||'true').toLowerCase()!=='false';const executionMode=realEnabled?(sessionArmed&&credentialsReady?'LIVE_ARMED':'LIVE_CAPABLE_UNARMED'):'LIVE_DISABLED';return {platform:'Polymarket US',mode:executionMode,pnlMode:'LIVE',hasKeyId:!!c.keyId,hasSecretKey:!!c.secretKey,credentialsReady,realEnabled,sessionArmed,execution:'manual-confirm-only',developerPortal:'https://polymarket.us/developer',lastAuthError:lastAuth.error,authCode:lastAuth.code,keyVerified:lastAuth.code==='ok',lastAuthAt:lastAuth.at}}

function feePerContract(p,taker=true){return (taker?.05:-.0125)*p*(1-p)}
function marketScore(m,reward=0,live=false){
 const sidePx=n(m.marketSides?.find?.(x=>x.long)?.quote?.value||m.marketSides?.find?.(x=>x.long)?.price);
 const bid=n(m.bestBid?.value??m.bestBid),ask=n(m.bestAsk?.value??m.bestAsk??m.bestAskQuote?.value),mid=bid&&ask?(bid+ask)/2:n(m.lastTradePrice||sidePx||ask);
 const spread=bid&&ask?Math.max(0,ask-bid):n(m.spread),liq=n(m.liquidityNum||m.liquidity||m.openInterest),vol=n(m.volume24hr||m.volumeNum||m.volume||m.sharesTraded);
 const tick=Math.max(.001,n(m.orderPriceMinTickSize)||.001),makerQuote=bid&&ask?Math.min(ask-tick,bid+tick):0;
 const makerRebate=Math.abs(feePerContract(makerQuote||mid,false)),makerEdge=makerQuote>0?Math.max(0,mid-makerQuote)+makerRebate:0;
 const takerFee=feePerContract(ask||mid,true),takerFriction=ask&&mid?Math.max(0,ask-mid)+takerFee:takerFee;
 const endTs=Date.parse(m.endDate||''),hoursToEnd=Number.isFinite(endTs)?Math.max(0,(endTs-Date.now())/3600000):null;
 let type='WATCH';
 if(reward>0)type='INCENTIVE';
 else if(live)type='LIVE_SPORTS';
 else if(hoursToEnd!=null&&hoursToEnd<=12&&(mid>=.9||mid<=.1))type='NEAR_EXPIRY';
 else if(spread>=.012&&makerEdge>=.003&&liq>=1000)type='SPREAD_MAKER';
 else if((mid>=.9||mid<=.1)&&liq>=5000)type='EXTREME';
 else if(mid>=.9||mid<=.1)type='EXTREME_WATCH';
 else if(Math.abs(n(m.oneDayPriceChange))>=.08)type='MOMENTUM';
 const executionScore=clamp(70-spread*1200-Math.max(0,takerFriction-.01)*1600+Math.log10(1+liq)*6,0,100);
 const score=clamp(Math.log10(1+liq)*8+Math.log10(1+vol)*5+Math.min(22,spread*600)+Math.min(25,Math.log10(1+reward)*10)+(live?18:0)+(type==='NEAR_EXPIRY'?12:0)+(type==='EXTREME_WATCH'?12:0),0,100);
 return {...m,bid,ask,mid,spread,liquidity:liq,volume24h:vol,rewardPool:reward,makerQuote,makerEdgePerContract:makerEdge,makerRebatePerContract:makerRebate,takerFeePerContract:takerFee,takerFrictionPerContract:takerFriction,executionScore,hoursToEnd,liveSports:live,opportunityType:type,opportunityScore:score};
}


async function incentiveMap(){
 if(incentiveCache.map&&Date.now()-incentiveCache.at<60000)return incentiveCache.map;
 const map=new Map(),openRows=[];let token='';
 try{
  for(let page=0;page<6;page++){
   const u=new URL('https://api.prod.polymarketexchange.com/v1/incentives');u.searchParams.set('pageSize','250');u.searchParams.set('statuses','active');if(token)u.searchParams.set('pageToken',token);
   const r=await fetch(u,{signal:AbortSignal.timeout(9000)});if(!r.ok)break;const j=await r.json();
   for(const p of j.programs||[]){if(p.instrumentState==='INSTRUMENT_STATE_CLOSED')continue;const total=Math.max(0,...(p.timePeriods||[]).map(x=>n(x.rewardPool)));if(total<=0)continue;const slug=String(p.marketSlug||'');if(!slug)continue;map.set(slug,Math.max(total,map.get(slug)||0));openRows.push({slug,rewardPool:total,rewardScope:'shared-program-pool',periods:(p.timePeriods||[]).map(x=>({programId:x.programId,programType:x.programType,period:x.period,rewardPool:n(x.rewardPool),discountFactor:n(x.discountFactor),targetSize:n(x.targetSize)}))})}
   token=j.nextPageToken||'';if(!token)break;
  }
 }catch{}
 map.topRows=openRows.sort((a,b)=>b.rewardPool-a.rewardPool).filter((x,i,a)=>a.findIndex(y=>y.slug===x.slug)===i).slice(0,80);
 incentiveCache={at:Date.now(),map};return map;
}

async function ensurePrivateStream(){const c=client();if(!c||privateWs)return;try{privateWs=c.ws.private();privateWs.on('orderSnapshot',d=>{stream.orders=d;stream.lastPrivateAt=Date.now()});privateWs.on('orderUpdate',d=>{stream.orders=d;stream.lastPrivateAt=Date.now()});privateWs.on('positionSnapshot',d=>{stream.positions=d;stream.lastPrivateAt=Date.now()});privateWs.on('positionUpdate',d=>{stream.positions=d;stream.lastPrivateAt=Date.now()});privateWs.on('accountBalanceSnapshot',d=>{stream.balance=d;stream.lastPrivateAt=Date.now()});privateWs.on('accountBalanceUpdate',d=>{stream.balance=d;stream.lastPrivateAt=Date.now()});privateWs.on('error',e=>{stream.error=String(e?.message||e);stream.privateConnected=false});await privateWs.connect();privateWs.subscribeOrders('mpo-orders');privateWs.subscribePositions('mpo-positions');privateWs.subscribeAccountBalance('mpo-balance');stream.privateConnected=true}catch(e){stream.error=String(e?.message||e);privateWs=null}}

async function ensureMarketStream(slugs){const c=client();if(!c||!slugs.length)return;const key=slugs.slice(0,80).sort().join('|');if(marketWs&&marketWsKey===key)return;try{if(marketWs)await marketWs.close?.();marketWs=c.ws.markets();marketWs.on('marketDataLite',d=>{const slug=d?.marketSlug||d?.market_slug;if(slug)stream.prices[slug]=d;stream.lastMarketAt=Date.now()});marketWs.on('trade',d=>{const slug=d?.marketSlug||d?.market_slug;if(slug)stream.trades[slug]=d;stream.lastMarketAt=Date.now()});marketWs.on('error',e=>{stream.error=String(e?.message||e);stream.connected=false});await marketWs.connect();marketWs.subscribeMarketDataLite('mpo-prices',slugs.slice(0,80));marketWs.subscribeTrades('mpo-trades',slugs.slice(0,80));marketWsKey=key;stream.connected=true}catch(e){stream.error=String(e?.message||e);marketWs=null}}

async function authSnapshot(){const c=client();if(!c)return {connected:false};await ensurePrivateStream();let authFailure=null;const safe=async(fn,fallback)=>{try{const r=await fn();return r}catch(e){const message=String(e?.message||e);if(!authFailure)authFailure={message,status:Number(e?.status||0)};return {...fallback,error:message}}};const [balances,positions,activities,orders]=await Promise.all([safe(()=>c.account.balances(),{balances:[]}),safe(()=>c.portfolio.positions({limit:100}),{positions:[]}),safe(()=>c.portfolio.activities({limit:50}),{activities:[]}),safe(()=>c.orders.list(),{orders:[]})]);noteUSAuthResult(authFailure?{message:authFailure.message,status:authFailure.status}:{code:'ok'});return {connected:true,lastAuthError:lastAuth.error,authCode:lastAuth.code,balances,positions,activities,orders,stream:{privateConnected:stream.privateConnected,lastPrivateAt:stream.lastPrivateAt,error:stream.error}}}

// Item 11: the gateway rejects SDK-default requests behind Cloudflare, so BBO is
// fetched directly with a browser-like user-agent.
async function bboFetch(slug){
 const r=await fetch(`https://gateway.polymarket.us/v1/markets/${encodeURIComponent(slug)}/bbo`,
  {headers:{accept:'application/json','user-agent':UA()},signal:AbortSignal.timeout(9000)});
 if(!r.ok)throw new Error(`bbo ${r.status}`);
 return (await r.json())?.marketData||{};
}
// Item 11: events.list({live:true}) returns stale closed games. Use the shared
// date-windowed in-play scanner so `liveSports` reflects real in-play markets.
async function liveSportsEvents(){
 try{const m=await import('./polymarketUSCombos.js');const f=await m.usLiveEvents();return f.events||[]}
 catch{try{const r=await PUBLIC.events.list({live:true,categories:['sports']});return (r.events||[]).filter(e=>e.live&&!e.closed)}catch{return []}}
}

export async function polymarketUSSnapshot({force=false}={}){
 if(!force&&usCache.data&&Date.now()-usCache.at<12000)return usCache.data;
 if(usBusy)return usBusy;
 usBusy=(async()=>{
  const [raw,rewards,liveEvents]=await Promise.all([
   PUBLIC.markets.list({active:true,closed:false,limit:500}).catch(()=>({markets:[]})),
   incentiveMap(),
   liveSportsEvents(),
  ]);
  const liveMarkets=liveEvents.flatMap(e=>(e.markets||[]).filter(m=>m&&!m.closed&&m.comboEnabled!==false).slice(0,12)
   .map(m=>({...m,bestAsk:m.bestAskQuote??m.bestAsk,bestBid:m.bestBidQuote??m.bestBid,eventSlug:String(e.slug||''),eventTitle:String(e.title||''),livePeriod:e.period??null,liveScore:e.score??null})));
  const liveSlugs=new Set(liveMarkets.map(m=>String(m.slug||'')).filter(Boolean));
  const base=[...(raw.markets||[])];
  const known=new Set(base.map(m=>String(m.slug||'')));
  // In-play markets are usually outside the first 500 catalog rows; add them explicitly.
  for(const m of liveMarkets){const slug=String(m.slug||'');if(!slug||known.has(slug))continue;base.push(m);known.add(slug)}
  const incentiveExtras=(rewards.topRows||[]).filter(x=>!known.has(x.slug)).slice(0,24);
  if(incentiveExtras.length){const rows=await Promise.all(incentiveExtras.map(async x=>{try{const r=await PUBLIC.markets.retrieveBySlug(x.slug);const m=r?.market;return m&&!m.closed?m:null}catch{return null}}));for(const m of rows.filter(Boolean)){base.push(m);known.add(String(m.slug||''))}}
  // Prioritize live, incentivized, recently updated, and already-quoted markets before BBO enrichment.
  base.sort((a,b)=>(liveSlugs.has(String(b.slug))-liveSlugs.has(String(a.slug)))+((rewards.has(String(b.slug))?1:0)-(rewards.has(String(a.slug))?1:0))||Date.parse(b.updatedAt||0)-Date.parse(a.updatedAt||0));
  const enriched=[];
  for(let i=0;i<Math.min(36,base.length);i+=6){const rows=await Promise.all(base.slice(i,i+6).map(async m=>{try{const cached=bboCache.get(m.slug);let b=cached&&Date.now()-cached.at<45000?cached.data:null;if(!b){b=await bboFetch(m.slug);bboCache.set(m.slug,{at:Date.now(),data:b})}return {...m,bestBid:b.bestBid,bestAsk:b.bestAsk,lastTradePrice:val(b.lastTradePx)||n(m.lastTradePrice),sharesTraded:n(b.sharesTraded),openInterest:n(b.openInterest),bidDepth:n(b.bidDepth),askDepth:n(b.askDepth),marketState:b.state}}catch{const cached=bboCache.get(m.slug)?.data;return cached?{...m,bestBid:cached.bestBid,bestAsk:cached.bestAsk,lastTradePrice:val(cached.lastTradePx),sharesTraded:n(cached.sharesTraded),openInterest:n(cached.openInterest),bidDepth:n(cached.bidDepth),askDepth:n(cached.askDepth),marketState:cached.state}:m}}));enriched.push(...rows)}
  enriched.push(...base.slice(enriched.length));
  let markets=enriched.map(m=>marketScore(m,rewards.get(String(m.slug))||0,liveSlugs.has(String(m.slug))));
  markets.sort((a,b)=>b.opportunityScore-a.opportunityScore);
  const top=markets.slice(0,60);await ensureMarketStream(top.map(x=>x.slug));
  for(const m of top){const t=stream.prices[m.slug];if(t){m.bid=val(t.bestBid||t.best_bid)||m.bid;m.ask=val(t.bestAsk||t.best_ask)||m.ask;m.mid=m.bid&&m.ask?(m.bid+m.ask)/2:m.mid;m.spread=m.bid&&m.ask?m.ask-m.bid:m.spread}}
  const counts={total:markets.length,liveSports:markets.filter(x=>x.opportunityType==='LIVE_SPORTS').length,incentive:markets.filter(x=>x.opportunityType==='INCENTIVE').length,spreadMaker:markets.filter(x=>x.opportunityType==='SPREAD_MAKER').length,nearExpiry:markets.filter(x=>x.opportunityType==='NEAR_EXPIRY').length,extreme:markets.filter(x=>x.opportunityType==='EXTREME').length,extremeWatch:markets.filter(x=>x.opportunityType==='EXTREME_WATCH').length,momentum:markets.filter(x=>x.opportunityType==='MOMENTUM').length};
  const auth=await authSnapshot();
  const data={platform:'us',at:Date.now(),readiness:usReadiness(),counts,opportunities:markets.slice(0,80),incentiveMarkets:markets.filter(x=>x.rewardPool>0).slice(0,40),incentivePrograms:(rewards.topRows||[]).slice(0,40),liveSports:markets.filter(x=>x.liveSports).slice(0,40),stream:{connected:stream.connected,lastMarketAt:stream.lastMarketAt,lastPrivateAt:stream.lastPrivateAt,error:stream.error},auth};
  usCache={at:Date.now(),data};return data;
 })().finally(()=>{usBusy=null});
 return usBusy;
}

function rewriteEnv(values){let text='';try{text=fs.readFileSync(ENV_FILE,'utf8')}catch{}for(const [k,v] of Object.entries(values)){const line=`${k}=${String(v).replace(/\n/g,'')}`;const re=new RegExp(`^${k}=.*$`,'m');text=re.test(text)?text.replace(re,line):`${text.trimEnd()}\n${line}\n`}fs.mkdirSync(USER_ROOT,{recursive:true});fs.writeFileSync(ENV_FILE,text,'utf8');try{fs.chmodSync(ENV_FILE,0o600)}catch{}}
export function configurePolymarketUS({keyId,secretKey,realEnabled=true}={}){keyId=String(keyId||'').trim();secretKey=String(secretKey||'').trim();if(keyId.length<8||secretKey.length<20)throw new Error('Key ID or Secret Key looks incomplete');process.env.POLYMARKET_KEY_ID=keyId;process.env.POLYMARKET_SECRET_KEY=secretKey;process.env.POLYMARKET_US_REAL_ENABLED=realEnabled?'true':'false';rewriteEnv({POLYMARKET_KEY_ID:keyId,POLYMARKET_SECRET_KEY:secretKey,POLYMARKET_US_REAL_ENABLED:realEnabled?'true':'false'});authClient=null;authKey='';privateWs=null;marketWs=null;marketWsKey='';sessionArmed=false;lastAuth={error:null,code:null,at:0};accountCache={at:0,data:null};return usReadiness()}
export function armPolymarketUS(armed=false){if(!usReadiness().credentialsReady)throw new Error('Connect Polymarket US API credentials first');sessionArmed=!!armed;return usReadiness()}

function cleanOrder(x={}){const price=clamp(n(x.price),.001,.999),qty=Math.max(1,Math.floor(n(x.quantity)));if(!x.marketSlug||!qty)throw new Error('marketSlug and quantity are required');return {marketSlug:String(x.marketSlug),intent:['ORDER_INTENT_BUY_LONG','ORDER_INTENT_BUY_SHORT','ORDER_INTENT_SELL_LONG','ORDER_INTENT_SELL_SHORT'].includes(x.intent)?x.intent:'ORDER_INTENT_BUY_LONG',type:'ORDER_TYPE_LIMIT',price:{value:price.toFixed(3).replace(/0+$/,'').replace(/\.$/,''),currency:'USD'},quantity:qty,tif:'TIME_IN_FORCE_GOOD_TILL_CANCEL',participateDontInitiate:x.makerOnly!==false,manualOrderIndicator:'MANUAL_ORDER_INDICATOR_MANUAL'}}
export async function previewPolymarketUSOrder(input={}){const c=client();if(!c)throw new Error('Polymarket US API credentials are not configured');return c.orders.preview(cleanOrder(input))}
export async function submitPolymarketUSOrder(input={}){const c=client(),r=usReadiness();if(!c)throw new Error('Polymarket US API credentials are not configured');if(!r.realEnabled||!r.sessionArmed)throw new Error('Real Polymarket trading is not armed for this session');if(input.confirmation!=='PLACE REAL ORDER')throw new Error('Explicit PLACE REAL ORDER confirmation required');assertLiveDispatchAllowed();return c.orders.create(cleanOrder(input))}
export async function closePolymarketUSPosition(input={}){const c=client(),r=usReadiness();if(!c)throw new Error('Polymarket US API credentials are not configured');if(!r.realEnabled||!r.sessionArmed)throw new Error('Real Polymarket trading is not armed for this session');if(input.confirmation!=='CLOSE REAL POSITION')throw new Error('Explicit CLOSE REAL POSITION confirmation required');assertLiveDispatchAllowed();return c.orders.closePosition({marketSlug:String(input.marketSlug||''),manualOrderIndicator:'MANUAL_ORDER_INDICATOR_MANUAL',synchronousExecution:true,maxBlockTime:'10',slippageTolerance:{ticks:Math.max(1,Math.min(25,Math.round(n(input.slippageTicks)||5)))}})}
export async function cancelAllPolymarketUS(input={}){const c=client();if(!c)throw new Error('Polymarket US API credentials are not configured');if(input.confirmation!=='CANCEL REAL ORDERS')throw new Error('Explicit CANCEL REAL ORDERS confirmation required');return c.orders.cancelAll(input.marketSlug?{slugs:[String(input.marketSlug)]}:{})}

export async function cancelPolymarketUSOrder(input={}){const c=client();if(!c)throw new Error('Polymarket US API credentials are not configured');if(input.confirmation!=='CANCEL REAL ORDER')throw new Error('Explicit CANCEL REAL ORDER confirmation required');if(!input.orderId)throw new Error('orderId is required');if(!input.marketSlug)throw new Error('marketSlug is required');return c.orders.cancel(String(input.orderId),{marketSlug:String(input.marketSlug)})}

// Read-only account view (balance, buying power, open-order count), cached 15 s.
// Shapes come from the polymarket-us SDK typings (GetAccountBalancesResponse, GetOpenOrdersResponse).
// Fields we don't know are listed by name only, never by value.
const ACCOUNT_TTL_MS=15000,KNOWN_BALANCE_FIELDS=new Set(['currentBalance','currency','lastUpdated','buyingPower','assetNotional','assetAvailable','pendingCredit','openOrders','unsettledFunds','pendingWithdrawals','marginRequirement','balanceReservation']);
let accountCache={at:0,data:null};
export function usKeyStatus(r=usReadiness()){if(!r.credentialsReady)return 'KEYS_NEEDED';if(r.authCode==='ok')return 'VERIFIED';if(r.authCode==='keyNotFound')return 'REJECTED';return 'NOT_VERIFIED'}
export async function polymarketUSAccount({force=false,clientOverride=null,now=Date.now()}={}){
 if(!force&&accountCache.data&&now-accountCache.at<ACCOUNT_TTL_MS)return {...accountCache.data,cached:true};
 const c=clientOverride||client();
 if(!c){const data={ok:false,keyStatus:'KEYS_NEEDED',balance:null,openOrders:null,at:now};accountCache={at:now,data};return data}
 let data;
 try{
  const [bal,ord]=await Promise.all([c.account.balances(),c.orders.list()]);
  noteUSAuthResult({code:'ok'});
  const rows=Array.isArray(bal?.balances)?bal.balances:[];
  const b=rows.find(x=>String(x?.currency||'').toUpperCase()==='USD')||rows[0]||null;
  const num=v=>Number.isFinite(Number(v))?Number(v):null;
  const unknownFields=b?Object.keys(b).filter(k=>!KNOWN_BALANCE_FIELDS.has(k)):[];
  data={ok:true,keyStatus:'VERIFIED',balance:b?{currentBalance:num(b.currentBalance),buyingPower:num(b.buyingPower),currency:b.currency||null,lastUpdated:b.lastUpdated||null}:null,balanceRows:rows.length,openOrders:Array.isArray(ord?.orders)?ord.orders.length:null,unknownFields,at:now};
 }catch(e){
  noteUSAuthResult({message:String(e?.message||e),status:Number(e?.status||0)});
  data={ok:false,keyStatus:usKeyStatus(),authCode:lastAuth.code,error:lastAuth.error,balance:null,openOrders:null,at:now};
 }
 accountCache={at:now,data};return data;
}
export function resetUSAccountCacheForTests(){accountCache={at:0,data:null}}
