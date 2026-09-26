// Robinhood Auto Trader — venue module (docs/ROBINHOOD-AUTO-TRADER.md §5-§13, §20 D, §21).
// Paper-first crypto auto-trader on Robinhood's official Crypto Trading API. Bitcoin-primary: the
// ROBINHOOD_PRIMARY_SYMBOL (default BTC-USD) is sampled first, its candidate score is multiplied by
// ROBINHOOD_PRIMARY_WEIGHT (default 1.5) and its autopilot order may use ROBINHOOD_PRIMARY_ORDER_MULT
// (default 1.0, max 2.0) x orderUsd, never above ROBINHOOD_MAX_ORDER_USD. Other *-USD pairs trade too.
//
// Snapshot contract (key order pinned by tests):
//   { at, readiness, account, pairs, quotes, tape, paper, journal, limits, qualificationThresholds, strategy, loop, equities, evolve, lastError }
//   tape[symbol].signal is the enum 'WARMUP'|'STALE'|'WAIT'|'SPREAD'|'NO-TREND'|'BREAKOUT'|'LONG'; strategy.primary = { symbol, weight, orderMult }.
//
// Real-money gate order (every real mutation, server-side, before any signed request):
//   1 stateRecovery  2 noCredentials  3 realDisabled (env re-read every call)  4 notArmed (module let, never persisted)
//   5 confirmation (strict ===)  6 orderCap / openCap / dailyLossCap (limits re-read from env)  7 cooldown / duplicate / busy
//   8 fresh read-only preview (notTradable / minOrder / increment / priceTolerance / buyingPower)
//   9 journal PENDING_SUBMIT written with clientOrderId  10 only now the signed placeOrder.
// Real autopilot additionally requires the CONFIRM_AUTOPILOT phrase, ROBINHOOD_REAL_ENABLED=true and paper qualification.
// Cancel / cancel-all need credentials + phrase only (no arm); forget needs the phrase only and no network.
// Evolution (§22) is paper-only: champions found by robinhoodEvolve.js are proposed, and applied only to the paper params
// (operator APPLY or ROBINHOOD_EVOLVE_AUTOPROMOTE=true); a paramsHash change while real autopilot is on disables it ('paramsChanged').
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail, RobinhoodError } from './robinhoodErrors.js';
import { creds, keyObject, rhLastAuth, rhClock, rhRateLimit, rhCallStats, fetchAccount, fetchTradingPairs, fetchBestBidAsk, fetchEstimatedPrice, listOrders, getOrder, placeOrder, cancelOrder, orderBody } from './robinhoodTransport.js';
import { loadRobinhoodPrivateKey, publicKeyBase64 } from './robinhoodSigner.js';
import * as J from './robinhoodJournal.js';
import * as S from './robinhoodStrategy.js';
import * as T from './robinhoodTape.js';
import * as E from './robinhoodEvolve.js';
import { volGateStats, realisticSpreads } from './robinhoodEvidence.js';
import { fetchPublicPaperMarket, fetchPublicCandles } from './robinhoodPaperFeed.js';
import * as W from './robinhoodWarmStart.js';
import { gauge } from './robinhoodGauge.js';
import * as C from './robinhoodChart.js';
import { championState, championPaperAllowed } from './championState.js';
import * as RP from './robinhoodPractice.js';
import { paperRecordFrom } from './fitnessLedger.js';
import { laneMayPropose } from './evidenceFlags.js';
import { appendProjectJournal } from './projectJournal.js';
export const CONFIRM_PLACE='PLACE REAL CRYPTO ORDER', CONFIRM_CANCEL='CANCEL REAL CRYPTO ORDER', CONFIRM_CANCEL_ALL='CANCEL REAL CRYPTO ORDERS', CONFIRM_AUTOPILOT='ENABLE REAL CRYPTO AUTOPILOT', CONFIRM_FORGET='FORGET';
const clone=x=>structuredClone(x), envNum=(k,d)=>{const n=Number(process.env[k]);return Number.isFinite(n)&&n>0?n:d};
const TICK_MS=Math.max(5000,envNum('ROBINHOOD_TICK_MS',15000)), PREVIEW_TTL_MS=30000, PREVIEW_CACHE_MS=10000, SNAPSHOT_TTL_MS=5000, ENTRY_TTL_MS=90000, RECONCILE_THROTTLE_MS=5000, NEVER_RECEIVED_MS=600000, NEVER_RECEIVED_LISTINGS=3;
const SYMBOL_RE=/^[A-Z0-9]{2,10}-USD$/;
const DATA_DIR=path.dirname(J.JOURNAL_FILE), USER_ROOT=path.dirname(DATA_DIR), ENV_FILE=path.join(USER_ROOT,'.env');
let timer=null, clockFn=null, tickBusy=false, paperBusy=false, feedFlight=null, snapshotFlight=null;
const PAPER_ONLY_BUILD=true;
let testRealExecutionUnlocked=false;
let account=null, pairs=new Map(), quotes=new Map(), feedAt=0, identity='', lastTickAt=0, lastError=null, paperDirty=false;
let paperQuoteSource=null, paperFallbackReason=null, paperFallbackUntil=0;
let sessionArmed=false, placeBusy=false, apBusy=false, reconcileBusy=false, lastPreview=null, lastReconcileRun=0;
let evolveBusy=false, evolveCheckedAt=0;
// §23: quotes are collected on every tick while the app runs (ROBINHOOD_COLLECT_QUOTES=false restores the old idle tick),
// and a second paper book explores with looser, bounded params. It never counts toward qualification or promotion.
export const EXPLORE_LABEL='EXPLORATION (NOT A STRATEGY)', EXPLORE_OVERRIDES=Object.freeze({costMultiple:0.5,lookbackSamples:40,maxHoldMin:120});
const collectAlways=()=>String(process.env.ROBINHOOD_COLLECT_QUOTES??'true').toLowerCase()!=='false';
const exploreEnabled=()=>String(process.env.ROBINHOOD_EXPLORE_ENABLED??'true').toLowerCase()!=='false';
let warmStatus=null, warmFlight=null;
const EVOLVE_CHECK_MS=300000;
const previewCache=new Map();
const now=()=>clockFn?clockFn():Date.now();
const symbols=v=>[...new Set((Array.isArray(v)?v:String(v||'').split(',')).map(x=>String(x).trim().toUpperCase()).filter(x=>SYMBOL_RE.test(x)))].slice(0,6);
const validSymbol=s=>{const v=String(s||'').trim().toUpperCase();if(!SYMBOL_RE.test(v))fail('validation','Use a crypto USD pair such as BTC-USD');return v};
const safeMessage=e=>{let m=String(e?.message||e);for(const v of Object.values(creds()))if(v)m=m.split(v).join('[redacted]');return m.slice(0,240)};
const noteText=t=>String(t).replace(/\s+/g,' ').slice(0,160);
function note(stage,e){lastError={at:now(),stage,code:e?.code||'unknown',message:safeMessage(e)}}
function addNote(entry,text){entry.notes=[...(entry.notes||[]).slice(-7),{at:now(),text:noteText(text)}]}
const paperOnlyBuild=()=>PAPER_ONLY_BUILD&&!testRealExecutionUnlocked;
const realEnabled=()=>!paperOnlyBuild()&&String(process.env.ROBINHOOD_REAL_ENABLED||'false').toLowerCase()==='true';
function assertRealExecutionAvailable(){if(paperOnlyBuild())fail('paperOnly','Robinhood real execution is locked in this build; paper trading only')}
export function robinhoodLimits(){return {maxOrderUsd:envNum('ROBINHOOD_MAX_ORDER_USD',25),maxOpen:Math.floor(envNum('ROBINHOOD_MAX_OPEN',5)),dailyLossCapUsd:envNum('ROBINHOOD_DAILY_LOSS_CAP_USD',50),priceTolerance:envNum('ROBINHOOD_PRICE_TOLERANCE',0.02)}}
// §21 Bitcoin specialization: primary symbol, candidate weight and per-order multiplier, all re-read from env.
export function robinhoodPrimary(){
 const s=String(process.env.ROBINHOOD_PRIMARY_SYMBOL||'BTC-USD').trim().toUpperCase(),symbol=SYMBOL_RE.test(s)?s:'BTC-USD';
 const w=Number(process.env.ROBINHOOD_PRIMARY_WEIGHT),weight=Number.isFinite(w)&&w>0?Math.min(w,10):1.5;
 const m=Number(process.env.ROBINHOOD_PRIMARY_ORDER_MULT),orderMult=Number.isFinite(m)&&m>0?Math.min(m,2):1;
 return {symbol,weight,orderMult};
}
const primaryFirst=list=>{const p=robinhoodPrimary().symbol;return list.includes(p)?[p,...list.filter(s=>s!==p)]:list};
const primaryWeights=()=>{const p=robinhoodPrimary();return {[p.symbol]:p.weight}};
export function primaryOrderUsd(symbol,orderUsd,limits=robinhoodLimits()){const p=robinhoodPrimary(),base=Number(orderUsd)||0;return Math.min(symbol===p.symbol?base*p.orderMult:base,limits.maxOrderUsd)}
export function robinhoodSymbols(){const s=symbols(process.env.ROBINHOOD_SYMBOLS);return primaryFirst(s.length?s:['BTC-USD','ETH-USD','SOL-USD'])}
function needCredentials(){if(!creds().apiKey||!keyObject())fail('noCredentials','Robinhood API credentials are required for Robinhood-authenticated data or future live execution')}
function paper(){const p=J.loadPaper();p.params=S.normalizeParams({...p.params,sampleMs:TICK_MS});p.paramsHash=S.paramsHash(p.params);return p}
function exploreParams(strictParams){return S.normalizeParams({...strictParams,...EXPLORE_OVERRIDES,sampleMs:TICK_MS})}
function explore(strict=paper()){const e=J.loadExplore();e.params=exploreParams(strict.params);e.paramsHash=S.paramsHash(e.params);return e}
function fee(){const f=account?.feeRatio;return Number.isFinite(f)&&f>=0&&f<0.25?f:envNum('ROBINHOOD_FEE_RATIO_FALLBACK',0.0095)}
function fresh(q){return q&&Number.isFinite(q.bid)&&q.bid>0&&Number.isFinite(q.ask)&&q.ask>=q.bid&&Number.isFinite(q.at)&&q.at<=now()&&now()-q.at<=30000}
function quote(symbol){const q=quotes.get(symbol);if(!fresh(q))fail('validation','A fresh, valid bid/ask quote is required');return q}
const openSymbolsReal=(j=J.loadJournal())=>j.open.map(e=>e.symbol);
async function refreshFeed(requested=robinhoodSymbols(),force=false){
 const c=creds(),key=keyObject(),hasCredentials=!!(c.apiKey&&key),fingerprint=hasCredentials?createHash('sha256').update(JSON.stringify(c)).digest('hex'):'paper-public';
 if(identity!==fingerprint){identity=fingerprint;account=null;pairs=new Map();quotes=new Map();feedAt=0;paperFallbackUntil=0}
 const wanted=primaryFirst([...new Set([robinhoodPrimary().symbol,...requested,...paper().positions.map(p=>p.symbol),...openSymbolsReal()])]);
 if(!force&&now()-feedAt<15000&&wanted.every(s=>fresh(quotes.get(s))&&pairs.has(s)))return;
 if(feedFlight){await feedFlight;if(wanted.every(s=>fresh(quotes.get(s))&&pairs.has(s)))return}
 feedFlight=(async()=>{
  const canFallback=paperOnlyBuild();
  if(hasCredentials&&!(canFallback&&now()<paperFallbackUntil)){
   try{
    if(!account||now()-account.at>600000){account=await fetchAccount();if(!account.accountNumber)fail('validation','API account response lacks an account number');account.at=now()}
    if(force||wanted.some(s=>!pairs.has(s)))for(const [s,p] of await fetchTradingPairs(wanted))pairs.set(s,p);
    const batch=await fetchBestBidAsk(wanted);let valid=0;
    for(const q of batch){if(!wanted.includes(q.symbol)||!fresh(q))continue;quotes.set(q.symbol,{...q,source:q.source||'robinhood'});valid++}
    if(!valid)fail('badQuotes','Robinhood returned no valid current quotes');
    feedAt=now();paperQuoteSource='robinhood';paperFallbackReason=null;paperFallbackUntil=0;lastError=null;return;
   }catch(e){
    // badQuotes: the quote call worked but no row passed fresh(); paper keeps running on the public book.
    const fallbackCodes=new Set(['keyNotFound','notPermitted','noCredentials','badKey','rateLimited','network','http','badQuotes']);
    if(!canFallback||!fallbackCodes.has(e?.code))throw e;
    note('robinhood-quotes',e);paperFallbackReason={code:e.code||'unknown',message:safeMessage(e),at:now()};
    paperFallbackUntil=now()+(['keyNotFound','notPermitted','badKey'].includes(e?.code)?300000:30000);
   }
  }else if(!canFallback)needCredentials();
  const market=await fetchPublicPaperMarket(wanted,{now});
  for(const p of market.pairs)pairs.set(p.symbol,p);
  let valid=0;for(const q of market.quotes){if(!wanted.includes(q.symbol)||!fresh(q))continue;quotes.set(q.symbol,q);valid++}
  if(!valid)fail('validation','Public paper feed returned no valid current quotes');
  account=null;feedAt=now();paperQuoteSource=market.source;lastError=null;
 })();try{await feedFlight}catch(e){note('quotes',e);throw e}finally{feedFlight=null}
}
function qualification(p=paper()){return J.evaluateQualification(p,now(),J.qualificationThresholds(),robinhoodLimits())}
export function robinhoodReadiness(){
 const c=creds(),key=keyObject(),auth=rhLastAuth(),clock=rhClock(),rate=rhRateLimit(),j=J.loadJournal(),p=paper(),primary=robinhoodPrimary();
 return {platform:'Robinhood Crypto',hasApiKey:!!c.apiKey,hasPrivateKey:!!c.privateKeyBase64,keyValid:!!key,credentialsReady:!!(c.apiKey&&key),publicKey:key?publicKeyBase64(key):null,paperOnlyBuild:paperOnlyBuild(),paperQuoteSource,paperFallbackReason:paperFallbackReason?clone(paperFallbackReason):null,realEnabled:realEnabled(),sessionArmed,execution:paperOnlyBuild()?'paper-only':'manual-confirm-only',equities:'official Agentic Trading MCP only — not automated here',developerPortal:'https://robinhood.com/account/crypto',lastAuthError:auth.error?safeMessage(auth.error):null,authCode:auth.code,lastAuthAt:auth.at,clockSkewSec:clock.lastDateHeaderSec===null?null:clock.lastDateHeaderSec-Math.floor(clock.syncedAt/1000),rateLimit:{backoffUntil:rate.backoffUntil,consecutive429:rate.consecutive429},recoveryRequired:!!j.recoveryRequired,paperRecoveryRequired:!!p.recoveryRequired,qualified:qualification(p).qualified,primary:{symbol:primary.symbol,weight:primary.weight}};
}
// ------------------------------------------------------------------ credentials / arming
function rewriteEnv(values){let text='';try{text=fs.readFileSync(ENV_FILE,'utf8')}catch{}for(const [k,v] of Object.entries(values)){const line=`${k}=${String(v).replace(/\n/g,'')}`;const re=new RegExp(`^${k}=.*$`,'m');text=re.test(text)?text.replace(re,line):`${text.trimEnd()}\n${line}\n`}fs.mkdirSync(USER_ROOT,{recursive:true});fs.writeFileSync(ENV_FILE,text,{encoding:'utf8',mode:0o600});try{fs.chmodSync(ENV_FILE,0o600)}catch{}}
export function configureRobinhood({apiKey,privateKey,realEnabled:enable=false}={}){
 const key=String(apiKey||'').trim(),seed=String(privateKey||'').trim();
 if(key.length<8||/\s/.test(key))fail('validation','API key looks incomplete (expected rh-api-<uuid>)');
 loadRobinhoodPrivateKey(seed); // throws badKey with the seed||publicKey hint
 const liveAllowed=!paperOnlyBuild()&&enable===true;
 process.env.ROBINHOOD_API_KEY=key;process.env.ROBINHOOD_PRIVATE_KEY=seed;process.env.ROBINHOOD_REAL_ENABLED=liveAllowed?'true':'false';
 rewriteEnv({ROBINHOOD_API_KEY:key,ROBINHOOD_PRIVATE_KEY:seed,ROBINHOOD_REAL_ENABLED:liveAllowed?'true':'false'});
 account=null;pairs=new Map();quotes=new Map();feedAt=0;identity='';paperQuoteSource=null;paperFallbackReason=null;paperFallbackUntil=0;previewCache.clear();lastPreview=null;sessionArmed=false;
 return robinhoodReadiness();
}
export function armRobinhood(armed=false){
 if(armed===true)assertRealExecutionAvailable();
 const j=J.loadJournal();if(j.recoveryRequired)fail('stateRecovery',j.recoveryError||'STATE RECOVERY REQUIRED');
 if(!robinhoodReadiness().credentialsReady)fail('noCredentials','Connect Robinhood API credentials first');
 if(armed===true&&!realEnabled())fail('realDisabled','Set ROBINHOOD_REAL_ENABLED=true in your .env and restart to arm real trading');
 sessionArmed=armed===true;return robinhoodReadiness();
}
// ------------------------------------------------------------------ gates
const GATE_ORDER=['stateRecovery','credentials','realEnabled','armed','orderCap','openCap','dailyLossCap','cooldown','duplicate','qualified'];
const GATE_CODES={stateRecovery:'stateRecovery',credentials:'noCredentials',realEnabled:'realDisabled',armed:'notArmed',orderCap:'orderCap',openCap:'openCap',dailyLossCap:'dailyLossCap',cooldown:'cooldown',duplicate:'duplicate',qualified:'notQualified'};
const GATE_TEXT={stateRecovery:'STATE RECOVERY REQUIRED: review the real journal before trading',credentials:'Robinhood API credentials are not configured',realEnabled:'Real trading is disabled (ROBINHOOD_REAL_ENABLED is not true)',armed:'Real trading is not armed for this session',orderCap:'Order cost exceeds ROBINHOOD_MAX_ORDER_USD',openCap:'Open real order cap reached (ROBINHOOD_MAX_OPEN)',dailyLossCap:'Daily loss cap reached (ROBINHOOD_DAILY_LOSS_CAP_USD)',cooldown:'The symbol is cooling down after a recent close',duplicate:'A real entry is already open for this symbol',qualified:'Paper qualification is not met; real autopilot cannot trade'};
function gateState({symbol,side='buy',costUsd=null,placedBy='manual',overrideCooldown=false}={}){
 const j=J.loadJournal(),limits=robinhoodLimits(),c=creds(),buy=side!=='sell';
 return {limits,journal:j,gates:{
  stateRecovery:!j.recoveryRequired,credentials:!!(c.apiKey&&keyObject()),realEnabled:realEnabled(),armed:sessionArmed,
  orderCap:costUsd===null||(Number.isFinite(costUsd)&&costUsd<=limits.maxOrderUsd+1e-9),
  openCap:!buy||j.open.length<limits.maxOpen,
  dailyLossCap:!buy||J.realizedTodayUsd(j,now())>-limits.dailyLossCapUsd,
  cooldown:!buy||(overrideCooldown===true&&placedBy!=='autopilot')||!J.inCooldown(j,symbol,now()),
  duplicate:!buy||!j.open.some(e=>e.symbol===symbol&&e.side==='buy'),
  qualified:qualification().qualified}};
}
function assertGates(gates,{confirmation,phrase,requireQualified=false}={}){
 for(const g of ['stateRecovery','credentials','realEnabled','armed'])if(!gates[g])fail(GATE_CODES[g],GATE_TEXT[g]);
 if(phrase!==undefined&&confirmation!==phrase)fail('confirmation',`Type ${phrase} to confirm`);
 for(const g of ['orderCap','openCap','dailyLossCap','cooldown','duplicate'])if(!gates[g])fail(GATE_CODES[g],GATE_TEXT[g]);
 if(requireQualified&&!gates.qualified)fail('notQualified',GATE_TEXT.qualified);
}
const wouldPass=gates=>GATE_ORDER.filter(g=>g!=='qualified').every(g=>gates[g]);
// ------------------------------------------------------------------ preview
async function buildPreview({symbol,side='buy',usd,qty,orderType='market',entryId,placedBy='manual',overrideCooldown=false}){
 needCredentials();const type=String(orderType||'market').toLowerCase();if(!['market','limit'].includes(type))fail('validation','orderType must be market or limit');
 let sym,entry=null;
 if(side==='sell'){const j=J.loadJournal();entry=j.open.find(e=>e.id===entryId);if(!entry)fail('notFound','Real entry not found');if(entry.status!=='OPEN'||!entry.fillVerified)fail('validation','Only OPEN entries with a verified fill can be sold');sym=entry.symbol}
 else sym=validSymbol(symbol);
 await refreshFeed([sym],true);const q=quote(sym),pair=pairs.get(sym),limits=robinhoodLimits(),feeRatio=fee();
 if(!pair||!pair.isApiTradable)fail('notTradable','Pair is not marked API-tradable for this account');
 const spreadPct=(q.ask-q.bid)/((q.ask+q.bid)/2),costPct=S.roundTripCost(feeRatio,spreadPct,paper().params),warnings=[];
 let size;
 if(side==='sell'){const qtyStr=S.formatIncrement(entry.filledQty,pair.assetIncrement),qn=Number(qtyStr);if(!(qn>0))fail('minOrder','Held quantity is below the asset increment');size={ok:true,reason:null,qty:qn,qtyStr,notionalUsd:qn*q.bid,estFeeUsd:qn*q.bid*feeRatio,costUsd:qn*q.bid*(1-feeRatio)}}
 else{
  let requested=Number(usd);if(qty!==undefined&&qty!==null&&!(requested>0))requested=Number(qty)*q.ask*(1+feeRatio);
  if(!Number.isFinite(requested)||requested<=0)fail('validation','usd (or qty) must be a positive number');
  if(requested>limits.maxOrderUsd+1e-9)fail('orderCap',GATE_TEXT.orderCap);
  size=S.sizeOrder({orderUsd:requested,ask:q.ask,pair,buyingPowerUsd:account?.buyingPowerUsd??Infinity,maxOrderUsd:limits.maxOrderUsd,feeRatio});
  if(!size.ok)fail(size.reason,'Order sizing failed: '+size.reason);
 }
 let estFeeUsd=size.estFeeUsd,estTotalUsd=side==='sell'?size.notionalUsd-size.estFeeUsd:size.costUsd,estimate=null;
 try{const rows=await fetchEstimatedPrice(sym,side==='sell'?'bid':'ask',[size.qtyStr]);estimate=rows.find(r=>Math.abs(r.quantity-size.qty)<1e-12)||rows[0]||null;
  if(estimate){if(Number.isFinite(estimate.estFee))estFeeUsd=estimate.estFee;if(side==='sell'&&Number.isFinite(estimate.estTotalCredit))estTotalUsd=estimate.estTotalCredit;if(side!=='sell'&&Number.isFinite(estimate.estTotalCost))estTotalUsd=estimate.estTotalCost;if(Number.isFinite(estimate.feeRatio)&&account)account.feeRatio=estimate.feeRatio}}
 catch(e){warnings.push('estimated_price unavailable: '+safeMessage(e))}
 const limitPrice=type==='limit'&&side!=='sell'?S.limitBuyPrice(q.ask,pair.quoteIncrement,limits.priceTolerance):null;
 const {gates}=gateState({symbol:sym,side,costUsd:side==='sell'?null:estTotalUsd,placedBy,overrideCooldown});
 const f=S.computeFeatures(J.tapeFor(paper(),sym),paper().params,now()),signal=S.entrySignal(f,{costPct,params:paper().params});
 if(!gates.qualified)warnings.push('Not qualified: manual orders allowed, real autopilot unavailable');
 if(side!=='sell'&&!signal.enter)warnings.push('Strategy says '+signal.reason+' for this pair right now');
 const at=now();
 return {symbol:sym,side,orderType:type,entryId:entry?.id||null,qty:size.qty,qtyStr:size.qtyStr,refAsk:q.ask,refBid:q.bid,refAt:q.at,limitPrice,feeRatio,estFeeUsd,estTotalUsd,costPct,requiredMovePct:signal.requiredMovePct,expectedMovePct:f.expectedMovePct,stopPct:signal.stopPct,takePct:signal.takePct,trailArmPct:signal.trailArmPct,trailPct:signal.trailPct,primary:sym===robinhoodPrimary().symbol,limits,gates,wouldPass:wouldPass(gates),warnings,previewAt:at,expiresAt:at+PREVIEW_TTL_MS};
}
export async function previewRobinhoodOrder(input={}){
 const key=[input.symbol,input.side||'buy',input.usd,input.qty,input.orderType||'market',input.entryId].map(x=>String(x??'')).join('|');
 const cached=previewCache.get(key);
 if(cached&&now()-cached.previewAt<PREVIEW_CACHE_MS){const {gates}=gateState({symbol:cached.symbol,side:cached.side,costUsd:cached.side==='sell'?null:cached.estTotalUsd});return lastPreview={...cached,gates,wouldPass:wouldPass(gates),limits:robinhoodLimits()}}
 const preview=await buildPreview({...input,side:input.side||'buy'});previewCache.set(key,preview);return lastPreview=clone(preview);
}
// ------------------------------------------------------------------ journal helpers
const byId=(j,id)=>j.open.find(e=>e.id===id);
function disableAutopilot(reason,text){const j=J.loadJournal();if(j.recoveryRequired)return;j.autopilot.enabled=false;j.autopilot.disabledReason=reason;j.autopilot.disabledAt=now();if(text)j.autopilot.lastAction={action:'disabled',reason,at:now(),text:noteText(text)};J.saveJournal(j)}
function authFailure(e){if(e?.code==='keyNotFound'||e?.code==='notPermitted')disableAutopilot(e.code,safeMessage(e))}
function recordAccount(j){if(account)j.account={accountNumber:'****'+String(account.accountNumber).slice(-4),feeRatio:account.feeRatio,buyingPowerUsd:account.buyingPowerUsd,apiVersion:account.apiVersion,at:account.at}}
const uncertainSend=e=>e?.sent===true&&(e.code==='network'||e.code==='uncertain');
function applyBuyOrderState(j,entry,order){
 const st=order.state,feeRatio=fee(),tol=robinhoodLimits().priceTolerance;
 if(st==='filled'||((st==='canceled'||st==='failed')&&order.filledQty>0)){
  const filledQty=order.filledQty>0?order.filledQty:entry.requestedQty,avgPrice=Number.isFinite(order.averagePrice)&&order.averagePrice>0?order.averagePrice:entry.refAsk;
  const feeUsd=Number.isFinite(order.feeCharged)?order.feeCharged:filledQty*avgPrice*feeRatio,costUsd=filledQty*avgPrice+feeUsd;
  const patch={orderId:order.id||entry.orderId,fillVerified:true,filledQty,avgPrice,feeUsd,costUsd,openedAt:now(),peakBid:entry.refBid,markBid:entry.refBid,unrealizedUsd:null};
  if(entry.refAsk>0&&Math.abs(avgPrice-entry.refAsk)/entry.refAsk>tol){patch.notes=[...(entry.notes||[]).slice(-7),{at:now(),text:noteText(`fill ${avgPrice} deviates from preview ask ${entry.refAsk} beyond tolerance`)}];J.setCooldown(j,entry.symbol,S.cooldownUntil({closedAt:now(),pnlUsd:-1},paper().params))}
  if(st!=='filled')patch.notes=[...(patch.notes||entry.notes||[]).slice(-7),{at:now(),text:'partial fill kept as open exposure'}];
  J.transition(j,entry.id,'OPEN',patch);return 'OPEN';
 }
 if(st==='canceled'){J.transition(j,entry.id,'CANCELLED',{orderId:order.id||entry.orderId,notes:[...(entry.notes||[]).slice(-7),{at:now(),text:'cancelled with zero fill'}]});return 'CANCELLED'}
 if(st==='failed'){J.transition(j,entry.id,'FAILED',{orderId:order.id||entry.orderId,notes:[...(entry.notes||[]).slice(-7),{at:now(),text:'failed with zero fill'}]});return 'FAILED'}
 if(entry.status!=='SUBMITTED'||entry.orderId!==order.id)J.transition(j,entry.id,'SUBMITTED',{orderId:order.id||entry.orderId,submittedAt:entry.submittedAt||now()});
 return 'SUBMITTED';
}
function applyExitState(j,entry,order){
 const st=order.state,feeRatio=fee(),exit={...entry.exit,orderId:order.id||entry.exit?.orderId||null};
 if(st==='filled'||((st==='canceled'||st==='failed')&&order.filledQty>0)){
  const filledQty=order.filledQty>0?Math.min(order.filledQty,entry.filledQty):entry.filledQty,avgPrice=Number.isFinite(order.averagePrice)&&order.averagePrice>0?order.averagePrice:(entry.markBid||entry.refBid||0);
  const feeUsd=Number.isFinite(order.feeCharged)?order.feeCharged:filledQty*avgPrice*feeRatio,proceedsUsd=filledQty*avgPrice-feeUsd;
  const full=filledQty>=entry.filledQty-1e-12,ratio=full?1:filledQty/entry.filledQty,costPart=entry.costUsd*ratio,pnlUsd=proceedsUsd-costPart;
  const closed=J.transition(j,entry.id,'CLOSED',{exit:{...exit,filledQty,avgPrice,feeUsd,proceedsUsd},filledQty,costUsd:costPart,feeUsd:entry.feeUsd*ratio,pnlUsd,closedAt:now(),notes:full?entry.notes:[...(entry.notes||[]).slice(-7),{at:now(),text:'partial exit split; remainder stays OPEN'}]});
  J.setCooldown(j,entry.symbol,S.cooldownUntil({closedAt:now(),pnlUsd},paper().params));
  if(!full)j.open.push({...clone(entry),id:J.newEntryId(),status:'OPEN',exit:null,filledQty:entry.filledQty-filledQty,costUsd:entry.costUsd-costPart,feeUsd:entry.feeUsd*(1-ratio),notes:[{at:now(),text:`remainder of ${entry.id} after partial exit`}]});
  return closed.status;
 }
 if(st==='canceled'||st==='failed'){J.transition(j,entry.id,'OPEN',{exit:null,notes:[...(entry.notes||[]).slice(-7),{at:now(),text:`exit ${st} with zero fill; position stays open`}]});return 'OPEN'}
 if(entry.status!=='CLOSING')J.transition(j,entry.id,'CLOSING',{exit});else entry.exit=exit;
 return 'CLOSING';
}
// ------------------------------------------------------------------ place (buy / sell)
export async function placeRobinhoodOrder({symbol,side='buy',usd,qty,orderType='market',entryId,confirmation,placedBy='manual',overrideCooldown=false,reason='manual'}={}){
 assertRealExecutionAvailable();
 const who=placedBy==='autopilot'?'autopilot':'manual';
 if(side==='sell'||(entryId&&side!=='buy'))return placeRealSell({entryId,confirmation,placedBy:who,reason});
 const sym=validSymbol(symbol),type=String(orderType||'market').toLowerCase();if(!['market','limit'].includes(type))fail('validation','orderType must be market or limit');
 const requested=Number(usd);
 const pre=gateState({symbol:sym,side:'buy',costUsd:Number.isFinite(requested)&&requested>0?requested:null,placedBy:who,overrideCooldown});
 assertGates(pre.gates,{confirmation,phrase:CONFIRM_PLACE,requireQualified:who==='autopilot'});
 if(placeBusy)fail('busy','A real order is already being placed');placeBusy=true;
 try{
  const prior=lastPreview&&lastPreview.symbol===sym&&lastPreview.side==='buy'&&now()-lastPreview.previewAt<=PREVIEW_TTL_MS?lastPreview:null;
  const preview=await buildPreview({symbol:sym,side:'buy',usd,qty,orderType:type,placedBy:who,overrideCooldown});
  const limits=robinhoodLimits();
  if(prior&&prior.refAsk>0&&Math.abs(preview.refAsk-prior.refAsk)/prior.refAsk>limits.priceTolerance)fail('priceTolerance',`Ask moved ${(100*Math.abs(preview.refAsk-prior.refAsk)/prior.refAsk).toFixed(2)}% since the preview; preview again`);
  const post=gateState({symbol:sym,side:'buy',costUsd:preview.estTotalUsd,placedBy:who,overrideCooldown});
  assertGates(post.gates,{confirmation,phrase:CONFIRM_PLACE,requireQualified:who==='autopilot'});
  if(Number.isFinite(account?.buyingPowerUsd)&&account.buyingPowerUsd<preview.estTotalUsd)fail('buyingPower','Buying power is below the order cost');
  const p=paper();
  let j=J.loadJournal();
  const entry=J.makeRealEntry({symbol:sym,side:'buy',requestedQty:preview.qty,requestedUsd:preview.estTotalUsd,refAsk:preview.refAsk,refBid:preview.refBid,refAt:preview.refAt,orderType:type,limitPrice:preview.limitPrice,timeInForce:'gtc',previewFeeUsd:preview.estFeeUsd,placedBy:who,stopPct:preview.stopPct,takePct:preview.takePct,trailArmPct:preview.trailArmPct,trailPct:preview.trailPct,paramsHash:p.paramsHash});
  entry.at=now();entry.refAt=preview.refAt;entry.costPct=preview.costPct;entry.reason=who==='autopilot'?'breakout':String(reason||'manual').slice(0,40);
  j.open.push(entry);j.stats.placed=(j.stats.placed||0)+1;recordAccount(j);J.saveJournal(j); // durable idempotency record BEFORE the signed request
  const body=orderBody({clientOrderId:entry.clientOrderId,symbol:sym,side:'buy',type,qtyStr:preview.qtyStr,limitPriceStr:preview.limitPrice||undefined,timeInForce:'gtc'});
  let order;
  try{order=await placeOrder(account.accountNumber,body)}
  catch(e){
   j=J.loadJournal();
   if(uncertainSend(e)){J.transition(j,entry.id,'SUBMITTED_UNCERTAIN',{submittedAt:now(),notes:[{at:now(),text:`send uncertain: ${safeMessage(e)}`}]});J.recomputeStats(j);J.saveJournal(j);note('place',e);const err=new RobinhoodError('uncertain',`Order send uncertain; entry ${entry.id} kept for reconcile`,0,{entryId:entry.id});err.sent=true;throw err}
   J.transition(j,entry.id,'REJECTED',{notes:[{at:now(),text:e.sent?`rejected: ${safeMessage(e)}`:`never sent: ${safeMessage(e)}`}]});J.recomputeStats(j);J.saveJournal(j);authFailure(e);note('place',e);throw e;
  }
  j=J.loadJournal();
  J.transition(j,entry.id,'SUBMITTED',{orderId:order.id||null,submittedAt:now()});
  const current=byId(j,entry.id);if(current&&order.id)applyBuyOrderState(j,current,order);
  J.recomputeStats(j);J.saveJournal(j);
  const final=J.loadJournal(),row=byId(final,entry.id)||final.history.find(e=>e.id===entry.id);
  return {ok:true,entry:clone(row),journal:{open:clone(final.open),unverified:final.stats.unverified}};
 }finally{placeBusy=false}
}
async function placeRealSell({entryId,confirmation,placedBy,reason}){
 let j=J.loadJournal();const existing=j.open.find(e=>e.id===entryId);
 const pre=gateState({symbol:existing?.symbol||'',side:'sell',placedBy});
 assertGates(pre.gates,{confirmation,phrase:CONFIRM_PLACE});
 if(!existing)fail('notFound','Real entry not found');
 if(existing.status!=='OPEN'||!existing.fillVerified)fail('validation','Only OPEN entries with a verified fill can be sold');
 if(placeBusy)fail('busy','A real order is already being placed');placeBusy=true;
 try{
  const preview=await buildPreview({side:'sell',entryId,placedBy});
  j=J.loadJournal();
  const exit={reason:['stop','take','trail','time','fade','manual','cancel'].includes(reason)?reason:'manual',clientOrderId:randomUUID(),orderId:null,orderType:'market',requestedAt:now(),filledQty:0,avgPrice:null,feeUsd:0,proceedsUsd:null,refBid:preview.refBid,qtyStr:preview.qtyStr};
  J.transition(j,entryId,'CLOSING',{exit,markBid:preview.refBid});J.saveJournal(j); // exit persisted BEFORE the POST
  const body=orderBody({clientOrderId:exit.clientOrderId,symbol:preview.symbol,side:'sell',type:'market',qtyStr:preview.qtyStr,timeInForce:'gtc'});
  let order;
  try{order=await placeOrder(account.accountNumber,body)}
  catch(e){
   j=J.loadJournal();const row=byId(j,entryId);
   if(uncertainSend(e)){J.transition(j,entryId,'CLOSING_UNCERTAIN',{notes:[...(row.notes||[]).slice(-7),{at:now(),text:`exit send uncertain: ${safeMessage(e)}`}]});J.saveJournal(j);note('sell',e);const err=new RobinhoodError('uncertain',`Exit send uncertain; entry ${entryId} kept for reconcile`,0,{entryId});err.sent=true;throw err}
   J.transition(j,entryId,'OPEN',{exit:null,notes:[...(row.notes||[]).slice(-7),{at:now(),text:`exit rejected: ${safeMessage(e)}`}]});J.saveJournal(j);authFailure(e);note('sell',e);throw e;
  }
  j=J.loadJournal();const row=byId(j,entryId);
  if(row)applyExitState(j,row,order);
  J.recomputeStats(j);J.saveJournal(j);
  const final=J.loadJournal(),result=byId(final,entryId)||final.history.find(e=>e.id===entryId);
  return {ok:true,entry:clone(result),journal:{open:clone(final.open),unverified:final.stats.unverified}};
 }finally{placeBusy=false}
}
// ------------------------------------------------------------------ cancel / forget
function cancellable(e){if(['SUBMITTED','SUBMITTED_UNCERTAIN'].includes(e.status)&&e.orderId)return {orderId:e.orderId,kind:'entry'};if(['CLOSING','CLOSING_UNCERTAIN'].includes(e.status)&&e.exit?.orderId)return {orderId:e.exit.orderId,kind:'exit'};return null}
async function ensureAccount(){needCredentials();if(!account||now()-account.at>600000){await refreshFeed([],true)}return account}
export async function cancelRobinhoodOrder({entryId,confirmation}={}){
 assertRealExecutionAvailable();
 if(confirmation!==CONFIRM_CANCEL)fail('confirmation',`Type ${CONFIRM_CANCEL} to confirm`);
 needCredentials();const j=J.loadJournal(),entry=byId(j,entryId);if(!entry)fail('notFound','Real entry not found');
 const target=cancellable(entry);if(!target)fail('notCancellable','Only submitted (unverified) buys or pending exits with an order id can be cancelled; use Reconcile first');
 const acct=await ensureAccount();
 await cancelOrder(acct.accountNumber,target.orderId);
 const j2=J.loadJournal(),row=byId(j2,entryId);if(row){addNote(row,`cancel requested for ${target.kind} order ${target.orderId}; status changes on reconcile`);row.cancelRequestedAt=now();J.saveJournal(j2)}
 return {ok:true,entry:clone(byId(J.loadJournal(),entryId))};
}
export async function cancelAllRobinhood({confirmation}={}){
 assertRealExecutionAvailable();
 if(confirmation!==CONFIRM_CANCEL_ALL)fail('confirmation',`Type ${CONFIRM_CANCEL_ALL} to confirm`);
 needCredentials();const cancelled=[],errors=[];
 for(const e of J.loadJournal().open.filter(cancellable)){try{await cancelRobinhoodOrder({entryId:e.id,confirmation:CONFIRM_CANCEL});cancelled.push(e.id)}catch(err){errors.push({entryId:e.id,error:safeMessage(err)});if(err.code==='keyNotFound'||err.code==='notPermitted')break}}
 return {ok:true,cancelled,errors};
}
export function forgetRobinhoodEntry({entryId,confirmation,acknowledgeHolding=false}={}){
 if(confirmation!=='FORGET')fail('confirmation','Type FORGET to drop an entry from the local journal (this never cancels anything on Robinhood)');
 const j=J.loadJournal();if(j.recoveryRequired)fail('stateRecovery',j.recoveryError||'STATE RECOVERY REQUIRED');
 const entry=byId(j,entryId);if(!entry)fail('notFound','Real entry not found');
 if(entry.status==='OPEN'&&entry.fillVerified&&acknowledgeHolding!==true)fail('holding','This entry holds a verified fill; the coin stays in your Robinhood account. Pass acknowledgeHolding:true to forget it anyway');
 const row=J.transition(j,entryId,'FORGOTTEN',{closedAt:now(),notes:[...(entry.notes||[]).slice(-7),{at:now(),text:'forgotten by operator; nothing cancelled on Robinhood'}]});
 J.recomputeStats(j);J.saveJournal(j);return {ok:true,entry:clone(row)};
}
// ------------------------------------------------------------------ reconcile
export async function reconcileRobinhood({force=false}={}){
 assertRealExecutionAvailable();
 const j0=J.loadJournal();
 if(j0.recoveryRequired)return {ran:false,checked:0,changed:0,lastReconcileAt:j0.lastReconcileAt,errors:[{entryId:null,code:'stateRecovery',message:j0.recoveryError}]};
 if(reconcileBusy||(!force&&now()-lastReconcileRun<RECONCILE_THROTTLE_MS))return {ran:false,checked:0,changed:0,lastReconcileAt:j0.lastReconcileAt,errors:[]};
 if(!j0.open.length){lastReconcileRun=now();return {ran:true,checked:0,changed:0,lastReconcileAt:j0.lastReconcileAt,errors:[]}}
 needCredentials();reconcileBusy=true;lastReconcileRun=now();
 const errors=[];let checked=0,changed=0;
 try{
  const acct=await ensureAccount();
  try{await refreshFeed(openSymbolsReal(),true)}catch(e){errors.push({entryId:null,code:e.code||'unknown',message:safeMessage(e)})}
  for(const id of j0.open.map(e=>e.id)){
   const j=J.loadJournal(),entry=byId(j,id);if(!entry)continue;checked++;
   const before=entry.status,count=j.open.length+j.history.length;
   try{
    entry.reconcile={...entry.reconcile,attempts:(entry.reconcile?.attempts||0)+1,lastAt:now()};
    if(entry.status==='PENDING_SUBMIT'||entry.status==='SUBMITTED_UNCERTAIN'||(entry.status==='SUBMITTED'&&!entry.orderId)){
     const rows=await listOrders(acct.accountNumber,{symbol:entry.symbol,created_at_start:new Date(entry.at-60000).toISOString()});
     const found=rows.find(o=>o.clientOrderId===entry.clientOrderId);
     if(found){J.transition(j,id,'SUBMITTED',{orderId:found.id,submittedAt:entry.submittedAt||now()});applyBuyOrderState(j,byId(j,id),found)}
     else{
      const rc={...entry.reconcile,successfulListings:(entry.reconcile?.successfulListings||0)+1,firstListingAt:entry.reconcile?.firstListingAt||now()};entry.reconcile=rc;
      if(rc.successfulListings>=NEVER_RECEIVED_LISTINGS&&now()-entry.at>=NEVER_RECEIVED_MS)J.transition(j,id,'FAILED',{notes:[...(entry.notes||[]).slice(-7),{at:now(),text:'never received: not listed after 3 listings over 10 min'}]});
      else addNote(entry,`not listed yet (${rc.successfulListings} listings)`);
     }
    }else if(entry.status==='SUBMITTED'){
     const order=await getOrder(acct.accountNumber,entry.orderId);
     if(order){const st=applyBuyOrderState(j,entry,order);
      if(st==='SUBMITTED'&&entry.orderType==='limit'&&now()-entry.at>ENTRY_TTL_MS&&!entry.cancelRequestedAt){try{await cancelOrder(acct.accountNumber,entry.orderId);const row=byId(j,id);row.cancelRequestedAt=now();addNote(row,'resting limit buy older than ENTRY_TTL cancelled; awaiting verification')}catch(e){errors.push({entryId:id,code:e.code||'unknown',message:safeMessage(e)})}}}
     else addNote(entry,'order id not found on listing');
    }else if(entry.status==='CLOSING'||entry.status==='CLOSING_UNCERTAIN'){
     let order=entry.exit?.orderId?await getOrder(acct.accountNumber,entry.exit.orderId):null;
     if(!order){const rows=await listOrders(acct.accountNumber,{symbol:entry.symbol,side:'sell',created_at_start:new Date((entry.exit?.requestedAt||entry.at)-60000).toISOString()});order=rows.find(o=>o.clientOrderId===entry.exit?.clientOrderId)||null}
     if(order)applyExitState(j,entry,order);
     else{const rc={...entry.reconcile,successfulListings:(entry.reconcile?.successfulListings||0)+1};entry.reconcile=rc;
      if(rc.successfulListings>=NEVER_RECEIVED_LISTINGS&&now()-(entry.exit?.requestedAt||entry.at)>=NEVER_RECEIVED_MS)J.transition(j,id,'OPEN',{exit:null,notes:[...(entry.notes||[]).slice(-7),{at:now(),text:'exit never received; position stays open'}]});
      else addNote(entry,`exit not listed yet (${rc.successfulListings} listings)`)}
    }else if(entry.status==='OPEN'){
     const q=quotes.get(entry.symbol);
     if(fresh(q)){entry.markBid=q.bid;entry.peakBid=Math.max(entry.peakBid||0,q.bid);entry.unrealizedUsd=entry.filledQty*q.bid*(1-fee())-entry.costUsd}
    }
    const after=J.loadJournal();const row=byId(after,id);const status=row?row.status:(after.history.find(e=>e.id===id)?.status);
    if(status!==before)changed++;
    const expect=after.open.length+after.history.length;
    if(expect!==count&&!(expect===count+1&&status==='CLOSED'))throw new RobinhoodError('unknown',`reconcile invariant broken for ${id}`);
    J.recomputeStats(after);after.lastReconcileAt=now();recordAccount(after);J.saveJournal(after);
   }catch(e){
    errors.push({entryId:id,code:e.code||'unknown',message:safeMessage(e)});note('reconcile',e);
    if(e.code==='keyNotFound'||e.code==='notPermitted'){authFailure(e);break}
    if(e.code==='rateLimited')break;
   }
  }
 }catch(e){errors.push({entryId:null,code:e.code||'unknown',message:safeMessage(e)});note('reconcile',e);authFailure(e)}
 finally{reconcileBusy=false}
 const jf=J.loadJournal();if(!jf.recoveryRequired&&checked){jf.lastReconcileAt=now();J.saveJournal(jf)}
 return {ran:true,checked,changed,lastReconcileAt:J.loadJournal().lastReconcileAt,errors};
}
// ------------------------------------------------------------------ real autopilot
export function robinhoodAutopilot(){return clone(J.loadJournal().autopilot)}
export function setRobinhoodAutopilot(patch={}){
 if(patch.enabled===true)assertRealExecutionAvailable();
 const j=J.loadJournal();if(j.recoveryRequired)fail('stateRecovery',j.recoveryError||'STATE RECOVERY REQUIRED');
 if(apBusy)fail('busy','Real autopilot pass in progress');
 const ap=clone(j.autopilot),limits=robinhoodLimits();
 if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')fail('validation','enabled must be a boolean');
 if(patch.enabled===true){
  if(patch.confirmation!==CONFIRM_AUTOPILOT)fail('confirmation',`Type ${CONFIRM_AUTOPILOT} to enable real autopilot`);
  const {gates}=gateState({symbol:robinhoodPrimary().symbol,side:'sell'});
  for(const g of ['stateRecovery','credentials','realEnabled','armed'])if(!gates[g])fail(GATE_CODES[g],GATE_TEXT[g]);
  const p=paper(),q=qualification(p);if(!q.qualified)fail('notQualified','Paper qualification not met: '+q.reasons.join('; '));
  ap.enabled=true;ap.enabledAt=now();ap.disabledReason=null;ap.disabledAt=0;ap.paramsHash=p.paramsHash;
 }else if(patch.enabled===false&&ap.enabled){ap.enabled=false;ap.disabledReason='operator';ap.disabledAt=now()}
 if(patch.orderUsd!==undefined){const n=Number(patch.orderUsd);if(!Number.isFinite(n)||n<1)fail('orderCap','orderUsd must be at least 1');ap.orderUsd=Math.min(n,limits.maxOrderUsd)}
 if(patch.maxOpen!==undefined){const n=Number(patch.maxOpen);if(!Number.isInteger(n)||n<1)fail('openCap','maxOpen must be a positive integer');ap.maxOpen=Math.min(n,limits.maxOpen)}
 if(patch.dailyLossCapUsd!==undefined){const n=Number(patch.dailyLossCapUsd);if(!Number.isFinite(n)||n<1)fail('dailyLossCap','dailyLossCapUsd must be at least 1');ap.dailyLossCapUsd=Math.min(n,limits.dailyLossCapUsd)}
 if(patch.symbols!==undefined){const list=Array.isArray(patch.symbols)?patch.symbols:String(patch.symbols).split(',');const v=[...new Set(list.map(s=>String(s).trim()).filter(Boolean).map(validSymbol))];if(!v.length||v.length>6)fail('validation','Choose one to six crypto USD pairs');ap.symbols=primaryFirst(v)}
 if(patch.orderType!==undefined){if(!['market','limit'].includes(patch.orderType))fail('validation','orderType must be market or limit');ap.orderType=patch.orderType}
 ap.orderUsd=Math.min(ap.orderUsd,limits.maxOrderUsd);ap.maxOpen=Math.min(ap.maxOpen,limits.maxOpen);ap.dailyLossCapUsd=Math.min(ap.dailyLossCapUsd,limits.dailyLossCapUsd);
 j.autopilot=ap;J.saveJournal(j);return clone(J.loadJournal().autopilot);
}
function featureRows(p,list,tapeBook=p){const out={};for(const symbol of primaryFirst([...new Set(list)])){
 const f=S.computeFeatures(J.tapeFor(tapeBook,symbol),p.params,now()),costPct=S.roundTripCost(fee(),f.spreadPct||0,p.params),signal=S.entrySignal(f,{costPct,params:p.params});out[symbol]={features:f,costPct,signal};
}return out}
export async function runRobinhoodAutopilotOnce(){
 if(paperOnlyBuild())return {ran:false,reason:'paperOnly',disabled:true};
 if(apBusy)return {ran:false,reason:'busy'};
 let j=J.loadJournal();
 if(!j.autopilot.enabled)return {ran:false,reason:'disabled'};
 if(j.recoveryRequired)return {ran:false,reason:'stateRecovery',disabled:true};
 const r=robinhoodReadiness();if(!r.credentialsReady||!r.realEnabled||!r.sessionArmed)return {ran:false,reason:'notArmed'};
 const p=paper(),q=qualification(p);
 if(!q.qualified||j.autopilot.paramsHash!==p.paramsHash){disableAutopilot('qualificationLost',q.reasons.join('; ')||'paramsHash changed');return {ran:false,reason:'qualificationLost',disabled:true}}
 if(now()<rhRateLimit().backoffUntil)return {ran:false,reason:'rateLimited'};
 apBusy=true;const placed=[],closed=[],skipped=[];
 const push=(symbol,reason)=>{skipped.push({symbol,reason:String(reason)})};
 try{
  await refreshFeed([...j.autopilot.symbols,...openSymbolsReal(j)],true);
  await reconcileRobinhood({force:true});
  j=J.loadJournal();if(!j.autopilot.enabled)return {ran:false,reason:j.autopilot.disabledReason||'disabled',disabled:true};
  const limits=robinhoodLimits(),ap=j.autopilot,orderUsd=Math.min(ap.orderUsd,limits.maxOrderUsd),maxOpen=Math.min(ap.maxOpen,limits.maxOpen),lossCap=Math.min(ap.dailyLossCapUsd,limits.dailyLossCapUsd);
  // Exits first, on every verified open real entry.
  for(const e of j.open.filter(x=>x.status==='OPEN'&&x.fillVerified)){
   const qt=quotes.get(e.symbol);if(!fresh(qt))continue;
   const f=S.computeFeatures(J.tapeFor(p,e.symbol),p.params,now());
   const x=S.exitSignal({fillPrice:e.avgPrice,openedAt:e.openedAt||e.at,stopPct:e.stopPct,takePct:e.takePct,trailArmPct:e.trailArmPct,trailPct:e.trailPct,peakBid:e.peakBid,trailStop:e.trailStop},{bid:qt.bid,features:f,now:now(),feeRatio:fee(),params:p.params});
   const jj=J.loadJournal(),row=byId(jj,e.id);if(row){row.peakBid=x.peakBid;row.trailStop=x.trailStop;row.markBid=qt.bid;J.saveJournal(jj)}
   if(!x.exit)continue;
   try{await placeRobinhoodOrder({entryId:e.id,side:'sell',confirmation:CONFIRM_PLACE,placedBy:'autopilot',reason:x.reason});closed.push(e.id)}
   catch(err){push(e.symbol,err.code||safeMessage(err));if(err.code==='keyNotFound'||err.code==='notPermitted')return {ran:false,reason:err.code,disabled:true,closed,placed,skipped};if(err.code==='rateLimited')return {ran:true,reason:'rateLimited',closed,placed,skipped}}
  }
  j=J.loadJournal();
  if(J.realizedTodayUsd(j,now())<=-lossCap){disableAutopilot('dailyLossCap',`realized today ${J.realizedTodayUsd(j,now())} <= -${lossCap}`);return {ran:true,reason:'dailyLossCap',disabled:true,closed,placed,skipped}}
  // Entries: ranked candidates with the primary-symbol weight; sizing honours the primary order multiplier and the env ceiling.
  const universe=ap.symbols.filter(s=>pairs.get(s)?.isApiTradable);for(const s of ap.symbols)if(!universe.includes(s))push(s,'notTradable');
  const rows=featureRows(p,universe),eligible={};
  for(const [symbol,row] of Object.entries(rows)){if(row.signal.enter)eligible[symbol]=row;else push(symbol,row.signal.reason)}
  const openSyms=[...new Set(j.open.map(e=>e.symbol))];
  for(const symbol of S.pickCandidates(eligible,openSyms,j.cooldowns,maxOpen,now(),primaryWeights())){
   if(J.loadJournal().open.length>=maxOpen){push(symbol,'openCap');break}
   try{const res=await placeRobinhoodOrder({symbol,usd:primaryOrderUsd(symbol,orderUsd,limits),orderType:ap.orderType,confirmation:CONFIRM_PLACE,placedBy:'autopilot'});placed.push(res.entry.id)}
   catch(err){push(symbol,err.code||safeMessage(err));if(err.code==='keyNotFound'||err.code==='notPermitted')return {ran:false,reason:err.code,disabled:true,closed,placed,skipped};if(err.code==='rateLimited'||err.code==='dailyLossCap')break}
  }
  return {ran:true,placed,closed,skipped};
 }catch(e){note('autopilot',e);authFailure(e);return {ran:false,reason:e.code||'unknown',error:safeMessage(e),placed,closed,skipped}}
 finally{
  apBusy=false;
  try{const jf=J.loadJournal();if(!jf.recoveryRequired){jf.autopilot.lastRunAt=now();jf.autopilot.skipped=skipped.slice(-8);if(placed.length||closed.length)jf.autopilot.lastAction={action:placed.length?'buy':'close',ids:[...placed,...closed],at:now()};J.saveJournal(jf)}}catch(e){note('autopilot-save',e)}
 }
}
// ------------------------------------------------------------------ paper book
function paperStats(p){bookStats(p);p.qualification=qualification(p);return p}
function exploreStats(e){bookStats(e);e.qualification={qualified:false,exploration:true,paramsHash:e.paramsHash,closes:e.stats.closes,hitRate:e.stats.hitRate,profitFactor:e.stats.profitFactor,pnlUsd:e.stats.pnlUsd,reasons:[EXPLORE_LABEL+': never counts toward qualification or promotion']};return e}
function bookStats(p){
 const rows=p.history.filter(x=>x.status==='CLOSED'&&Number.isFinite(x.pnlUsd));let win=0,loss=0,total=0,fees=0,cum=0,peak=0,dd=0;
 for(const x of [...rows].reverse()){const pl=x.pnlUsd;total+=pl;win+=Math.max(pl,0);loss+=Math.max(-pl,0);fees+=(x.feeUsd||0)+(x.exit?.feeUsd||0);cum+=pl;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum)}
 const won=rows.filter(x=>x.pnlUsd>0).length;p.stats={closes:rows.length,won,lost:rows.length-won,pnlUsd:total,grossWinUsd:win,grossLossUsd:loss,feesUsd:fees,hitRate:rows.length?won/rows.length:null,profitFactor:loss?win/loss:win?'infinity':null,maxDrawdownUsd:dd};
 return p;
}
function commitPaper(p,force=true){paperStats(p);paperDirty=true;return J.savePaper(p,{force})}
async function withPaperLock(fn){if(paperBusy)fail('busy','A paper operation is already in progress');paperBusy=true;try{return await fn()}finally{paperBusy=false}}
function assertPaper(p){if(p.recoveryRequired)fail('paperRecovery','Paper book requires recovery; use Reset paper after reviewing the error')}
function paperSizing(p,symbol,usd,q){
 const pair=pairs.get(symbol);if(!pair||!pair.isApiTradable)fail('notTradable','Pair is not marked API-tradable');
 if(!Number.isFinite(usd)||usd<=0||usd>robinhoodLimits().maxOrderUsd)fail('orderCap','Paper order must be positive and within the configured per-order cap');
 const model=S.paperBuyFill({qty:1,bid:q.bid,ask:q.ask,feeRatio:fee(),now:now(),params:p.params});
 const size=S.sizeOrder({orderUsd:usd,ask:model.fillPrice,pair,feeRatio:fee(),buyingPowerUsd:p.cashUsd,maxOrderUsd:robinhoodLimits().maxOrderUsd});
 if(!size.ok)fail(size.reason==='buyingPower'?'paperCash':size.reason,'Paper order sizing failed: '+size.reason);return size;
}
function openPaperAt(p,symbol,usd,placedBy='manual',tapeBook=p){
 assertPaper(p);if(p.positions.length>=Math.min(p.autopilot.maxOpen,robinhoodLimits().maxOpen))fail('openCap','Paper position cap reached');
 if(p.positions.some(x=>x.symbol===symbol))fail('duplicate','A paper position already exists for this symbol');
 if(J.inCooldown(p,symbol,now()))fail('cooldown','The symbol is cooling down');
 const q=quote(symbol),size=paperSizing(p,symbol,usd,q),f=S.computeFeatures(J.tapeFor(tapeBook,symbol),p.params,now());
 const costPct=S.roundTripCost(fee(),(q.ask-q.bid)/((q.ask+q.bid)/2),p.params),signal=S.entrySignal(f,{costPct,params:p.params});
 if((placedBy==='paper-autopilot'||placedBy==='explore-autopilot')&&!signal.enter)fail('validation','No entry signal: '+signal.reason);
 const fill=S.paperBuyFill({qty:size.qty,bid:q.bid,ask:q.ask,feeRatio:fee(),now:now(),params:p.params});
 if(!(fill.costUsd>0)||fill.costUsd>usd+1e-8||fill.costUsd>p.cashUsd)fail('paperCash','Modeled fill would exceed the paper budget');
 const position={id:J.newPaperId(),symbol,status:'OPEN',placedBy,qty:size.qty,entryAsk:q.ask,...fill,at:now(),openedAt:now(),stopPct:signal.stopPct,takePct:signal.takePct,trailArmPct:signal.trailArmPct,trailPct:signal.trailPct,peakBid:q.bid,trailStop:null,maxFavorablePct:0,maxAdversePct:0,params:clone(p.params),paramsHash:p.paramsHash,costPct,quoteSource:q.source,exit:null,pnlUsd:null};
 p.cashUsd-=fill.costUsd;p.positions.push(position);p.feeRatio=fee();return position;
}
function closePaperAt(p,id,reason='manual',closedBy='manual'){
 assertPaper(p);const index=p.positions.findIndex(x=>x.id===id);if(index<0)fail('notFound','Paper position not found');
 const position=p.positions[index],q=quote(position.symbol),fill=S.paperSellFill({qty:position.qty,bid:q.bid,ask:q.ask,feeRatio:fee(),now:now(),params:position.params||p.params});
 if(!(fill.proceedsUsd>=0)||!Number.isFinite(fill.proceedsUsd))fail('validation','Invalid modeled exit');
 const closed={...position,status:'CLOSED',exit:{reason,bid:q.bid,...fill,filledQty:position.qty,at:now()},pnlUsd:fill.proceedsUsd-position.costUsd,closedBy,closedAt:now()};
 p.positions.splice(index,1);p.history.unshift(closed);p.cashUsd+=fill.proceedsUsd;J.setCooldown(p,position.symbol,S.cooldownUntil(closed,position.params||p.params));return closed;
}
export async function placeRobinhoodPaperOrder({symbol,usd}={}){return withPaperLock(async()=>{
 const sym=validSymbol(symbol);assertPaper(paper());await refreshFeed([sym],true);
 const p=clone(paper()),position=openPaperAt(p,sym,Number(usd),'manual');commitPaper(p);return {ok:true,position:clone(position)};
})}
export async function closeRobinhoodPaperPosition({id}={}){return withPaperLock(async()=>{
 const position=paper().positions.find(p=>p.id===id);if(!position)fail('notFound','Paper position not found');
 await refreshFeed([position.symbol],true);const p=clone(paper()),closed=closePaperAt(p,id,'manual','manual');commitPaper(p);return {ok:true,position:clone(closed)};
})}
export function setRobinhoodPaperAutopilot(patch={}){
 if(paperBusy)fail('busy','A paper operation is in progress');const p=clone(paper());assertPaper(p);
 if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')fail('validation','enabled must be a boolean');
 if(patch.orderUsd!==undefined){const n=Number(patch.orderUsd);if(!Number.isFinite(n)||n<=0||n>robinhoodLimits().maxOrderUsd)fail('orderCap','Invalid paper order size');p.autopilot.orderUsd=n}
 if(patch.maxOpen!==undefined){const n=Number(patch.maxOpen);if(!Number.isInteger(n)||n<1||n>robinhoodLimits().maxOpen)fail('openCap','Invalid paper position cap');p.autopilot.maxOpen=n}
 if(patch.symbols!==undefined){const list=Array.isArray(patch.symbols)?patch.symbols:String(patch.symbols).split(',');if(!list.length||list.length>6)fail('validation','Choose one to six crypto USD pairs');p.autopilot.symbols=primaryFirst([...new Set(list.map(validSymbol))])}
 const priorHash=p.paramsHash;
 if(patch.params!==undefined){if(!patch.params||typeof patch.params!=='object'||Array.isArray(patch.params))fail('validation','Strategy parameters must be a JSON object');p.params=S.normalizeParams({...p.params,...patch.params,sampleMs:TICK_MS});p.paramsHash=S.paramsHash(p.params)}
 if(patch.enabled!==undefined)p.autopilot.enabled=patch.enabled;
 commitPaper(p);
 // A new strategy hash invalidates the qualification the real autopilot was enabled under: disable it now, not at the next pass.
 if(p.paramsHash!==priorHash){const j=J.loadJournal();if(!j.recoveryRequired&&j.autopilot.enabled)disableAutopilot('paramsChanged',`paper params ${priorHash} -> ${p.paramsHash}`)}
 return {...clone(p.autopilot),paramsHash:p.paramsHash};
}
export function resetRobinhoodPaper({amountUsd=1000}={}){
 if(paperBusy)fail('busy','A paper operation is in progress');const amount=Number(amountUsd);
 if(!Number.isFinite(amount)||amount<50||amount>100000)fail('validation','Paper bank must be between 50 and 100000 USD');
 const old=paper();if(old.recoveryRequired&&fs.existsSync(J.PAPER_FILE))fs.copyFileSync(J.PAPER_FILE,J.PAPER_FILE+'.corrupt-'+Date.now()+'.bak');
 const p={...J.defaultPaper(),cashUsd:amount,startUsd:amount,params:clone(old.params),paramsHash:old.paramsHash,tape:clone(old.tape),tapeAt:old.tapeAt,autopilot:{...clone(old.autopilot),enabled:false}};
 commitPaper(p);
 const j=J.loadJournal();if(!j.recoveryRequired&&j.autopilot.enabled)disableAutopilot('paperReset','paper book reset revoked qualification');
 return clone(p);
}
// ------------------------------------------------------------------ loop
// Robinhood quotes carry their API version (v1/v2) as source; the tape, the evolve holdout's Robinhood-share
// gate and the Lab all count them as 'robinhood'. Public-feed sources pass through unchanged.
const tapeSrc=q=>q.source==='v1'||q.source==='v2'||q.source==='robinhood'?'robinhood':q.source;
function needsQuotes(p=paper(),j=J.loadJournal()){return !!(p.autopilot.enabled||p.positions.length||j.autopilot.enabled||j.open.length)}
async function paperPass(initial){
 return withPaperLock(async()=>{
  const ex=exploreEnabled()?explore(initial):null;
  const wanted=[...new Set([...(collectAlways()?robinhoodSymbols():[]),...initial.autopilot.symbols,...initial.positions.map(p=>p.symbol),...(ex?[...ex.autopilot.symbols,...ex.positions.map(p=>p.symbol)]:[]),...(J.loadJournal().autopilot.enabled?J.loadJournal().autopilot.symbols:[])])];
  await refreshFeed(wanted,true);const p=clone(paper());assertPaper(p);p.autopilot.skipped=[];let changed=false;
  for(const symbol of primaryFirst([...new Set([robinhoodPrimary().symbol,...wanted,...openSymbolsReal()])])){const q=quotes.get(symbol);if(fresh(q)){J.appendTape(p,symbol,{...q,quoteSource:q.source});T.bufferTape(symbol,{t:q.at,bid:q.bid,ask:q.ask,src:tapeSrc(q)})}}
  for(const position of [...p.positions]){
   const q=quotes.get(position.symbol);if(!fresh(q))continue;const params=position.params||p.params;
   const features=S.computeFeatures(J.tapeFor(p,position.symbol),params,now());
   const exit=S.exitSignal(position,{bid:q.bid,features,now:now(),feeRatio:fee(),params});
   position.peakBid=exit.peakBid;position.trailStop=exit.trailStop;position.maxFavorablePct=Math.max(position.maxFavorablePct||0,q.bid/position.fillPrice-1);position.maxAdversePct=Math.min(position.maxAdversePct||0,q.bid/position.fillPrice-1);
   if(exit.exit){closePaperAt(p,position.id,exit.reason,'strategy');changed=true;p.autopilot.lastAction={action:'close',symbol:position.symbol,reason:exit.reason,at:now()}}
  }
  if(p.autopilot.enabled){const rows=featureRows(p,[...p.autopilot.symbols,...p.positions.map(x=>x.symbol)]),eligible=Object.fromEntries(Object.entries(rows).filter(([,r])=>r.signal.enter));
   for(const [symbol,row]of Object.entries(rows))if(!row.signal.enter)p.autopilot.skipped.push({symbol,reason:row.signal.reason});
   for(const symbol of S.pickCandidates(eligible,p.positions.map(p=>p.symbol),p.cooldowns,Math.min(p.autopilot.maxOpen,robinhoodLimits().maxOpen),now(),primaryWeights())){
    try{openPaperAt(p,symbol,p.autopilot.orderUsd,'paper-autopilot');changed=true;p.autopilot.lastAction={action:'buy',symbol,at:now()}}catch(e){p.autopilot.skipped.push({symbol,reason:e.code||safeMessage(e)})}
   }
  }
  p.autopilot.lastRunAt=now();commitPaper(p,changed);
  let exploreOut={ran:false,reason:'disabled'};if(exploreEnabled()){try{exploreOut=explorePass(p)}catch(e){note('explore-loop',e);exploreOut={ran:false,reason:e.code||'unknown',error:safeMessage(e)}}}
  return {ran:true,changed,open:p.positions.length,skipped:clone(p.autopilot.skipped),explore:exploreOut};
 });
}
// The exploration book trades on the strict book's tape and quotes with looser params. Same fees, spread and fill model.
function explorePass(strict){
 const e=clone(explore(strict));if(e.recoveryRequired)return {ran:false,reason:'paperRecovery'};e.autopilot.skipped=[];let changed=false;
 for(const position of [...e.positions]){
  const q=quotes.get(position.symbol);if(!fresh(q))continue;const params=position.params||e.params;
  const features=S.computeFeatures(J.tapeFor(strict,position.symbol),params,now());
  const exit=S.exitSignal(position,{bid:q.bid,features,now:now(),feeRatio:fee(),params});
  position.peakBid=exit.peakBid;position.trailStop=exit.trailStop;position.maxFavorablePct=Math.max(position.maxFavorablePct||0,q.bid/position.fillPrice-1);position.maxAdversePct=Math.min(position.maxAdversePct||0,q.bid/position.fillPrice-1);
  if(exit.exit){closePaperAt(e,position.id,exit.reason,'strategy');changed=true;e.autopilot.lastAction={action:'close',symbol:position.symbol,reason:exit.reason,at:now()}}
 }
 if(e.autopilot.enabled){const rows=featureRows(e,[...e.autopilot.symbols,...e.positions.map(x=>x.symbol)],strict),eligible=Object.fromEntries(Object.entries(rows).filter(([,r])=>r.signal.enter));
  for(const [symbol,row]of Object.entries(rows))if(!row.signal.enter)e.autopilot.skipped.push({symbol,reason:row.signal.reason});
  for(const symbol of S.pickCandidates(eligible,e.positions.map(x=>x.symbol),e.cooldowns,Math.min(e.autopilot.maxOpen,robinhoodLimits().maxOpen),now(),primaryWeights())){
   try{openPaperAt(e,symbol,e.autopilot.orderUsd,'explore-autopilot',strict);changed=true;e.autopilot.lastAction={action:'buy',symbol,at:now()}}catch(err){e.autopilot.skipped.push({symbol,reason:err.code||safeMessage(err)})}
  }
 }
 e.autopilot.lastRunAt=now();exploreStats(e);J.saveExplore(e,{force:changed});return {ran:true,changed,open:e.positions.length};
}
// §23 warm start: refill the in-memory tape from the durable tape, then fill any hole (restart gap or short tape) from
// public 1-minute candles tagged src 'coinbase-candles'. Unauthenticated; one request per symbol; never throws.
export async function warmStartRobinhood({fetchCandles=fetchPublicCandles}={}){
 if(warmFlight)return warmFlight;
 warmFlight=withPaperLock(async()=>{
  const p=clone(paper()),at=now();if(p.recoveryRequired)return warmStatus={at,ran:false,reason:'paperRecovery'};
  const to=at,from=to-J.__testing.TAPE_CAP*TICK_MS,bySymbol={};
  for(const sym of primaryFirst([...new Set([...robinhoodSymbols(),...p.autopilot.symbols,...p.positions.map(x=>x.symbol)])])){
   const mem=J.tapeFor(p,sym).filter(r=>r.t>=from),disk=T.loadTape(sym,from),byT=new Map();
   for(const r of [...disk,...mem])byT.set(r.t,{t:r.t,bid:r.bid,ask:r.ask});
   const real=[...byT.values()].sort((a,b)=>a.t-b.t),gaps=W.findGaps(real,{from,to,sampleMs:TICK_MS}),row={memory:mem.length,disk:disk.length,gaps:gaps.length,candles:0,total:real.length,error:null};
   let rows=real;
   if(gaps.length){
    try{const candles=await fetchCandles(sym,{startMs:Math.max(from,gaps[0][0]-60000),endMs:to});const m=W.mergeWarm(real,W.candlesToSamples(candles,TICK_MS),{from,to,sampleMs:TICK_MS});rows=m.rows;row.candles=m.added.length;T.bufferBackfill(sym,m.added)}
    catch(e){row.error=safeMessage(e)}
   }
   const prior=p.tape?.[sym];if(!p.tape||typeof p.tape!=='object')p.tape={};
   p.tape[sym]={intervalMs:TICK_MS,quoteSource:prior?.quoteSource||'v2',samples:rows.slice(-J.__testing.TAPE_CAP).map(r=>[r.t,r.bid,r.ask])};
   if(rows.length)p.tapeAt=Math.max(Number(p.tapeAt)||0,rows[rows.length-1].t);
   row.total=Math.min(rows.length,J.__testing.TAPE_CAP);bySymbol[sym]=row;
  }
  commitPaper(p);T.flushTape({force:true,now:now()});
  return warmStatus={at,ran:true,bySymbol};
 }).catch(e=>{note('warm-start',e);return warmStatus={at:now(),ran:false,reason:e.code||'unknown',error:safeMessage(e)}});
 try{return await warmFlight}finally{warmFlight=null}
}
async function tick(){
 if(tickBusy||paperBusy)return {ran:false,reason:'busy'};
 const initial=paper(),j=J.loadJournal();if(initial.recoveryRequired&&!j.open.length&&!j.autopilot.enabled)return {ran:false,reason:'paperRecovery'};
 if(!collectAlways()&&!needsQuotes(initial,j))return {ran:false,reason:'idle'};
 if(lastTickAt&&now()-lastTickAt<TICK_MS)return {ran:false,reason:'cadence'};
 tickBusy=true;lastTickAt=now();const out={ran:true};
 try{
  if(!initial.recoveryRequired){try{out.paper=await paperPass(initial)}catch(e){note('paper-loop',e);out.paper={ran:false,reason:e.code||'unknown',error:safeMessage(e)}}}
  const jn=J.loadJournal();
  if(jn.open.length&&!jn.recoveryRequired){try{out.reconcile=await reconcileRobinhood()}catch(e){note('reconcile',e)}}
  if(jn.autopilot.enabled){try{out.real=await runRobinhoodAutopilotOnce()}catch(e){note('autopilot',e)}}
  const flushed=T.flushTape({now:now()});if(flushed.error&&!flushed.skipped)note('tape',{code:'unknown',message:flushed.error.message});
  return out;
 }finally{tickBusy=false;if(evolveDue()){evolveCheckedAt=now();runRobinhoodEvolveOnce().catch(e=>note('evolve',e))}if(labPassDue()){labPassAt=now();try{labProposalPass()}catch(e){note('lab-trial',e)}}}
}
export async function runRobinhoodPaperOnce(){if(tickBusy||paperBusy)return {ran:false,reason:'busy'};const p=paper();if(p.recoveryRequired)return {ran:false,reason:'paperRecovery'};if(!collectAlways()&&!p.autopilot.enabled&&!p.positions.length)return {ran:false,reason:'idle'};tickBusy=true;try{return await paperPass(p)}catch(e){note('paper-loop',e);return {ran:false,reason:e.code||'unknown',error:safeMessage(e)}}finally{tickBusy=false}}
const PAPER_PRACTICE_VERSION=1;
function ensureRobinhoodPaperPractice(){
 const p=paper();
 if(p.recoveryRequired||Number(p.paperPracticeVersion||0)>=PAPER_PRACTICE_VERSION)return p;
 // alpha.60 migration: the strict Robinhood PAPER book should actually practice by default.
 // This only flips the simulated book. PAPER_ONLY_BUILD still hard-blocks every real order path.
 p.autopilot={...p.autopilot,enabled:true};
 p.paperPracticeVersion=PAPER_PRACTICE_VERSION;
 J.savePaper(p,{force:true});
 return p;
}
export function startRobinhoodLoops(){if(timer)return timer;const setting=process.env.ROBINHOOD_AUTOSTART??'true'; /* §23: no longer falls back to POLYMARKET_AUTOSTART */if(String(setting).toLowerCase()==='false')return null;try{ensureRobinhoodPaperPractice()}catch(e){note('paper-practice-default',e)}timer=setInterval(()=>{tick().catch(()=>{})},TICK_MS);timer.unref?.();if(collectAlways()&&String(process.env.ROBINHOOD_WARM_START??'true').toLowerCase()!=='false')warmStartRobinhood().then(()=>tick()).catch(()=>{});return timer}
export function stopRobinhoodLoops(){if(timer)clearInterval(timer);timer=null;if(paperDirty){try{J.savePaper(paper(),{force:true});paperDirty=false}catch(e){note('paper-save',e)}}T.flushTape({force:true,now:now()})}
// ------------------------------------------------------------------ evolution (§22, paper-only)
const LAB_RH_STATUS_FILE=path.join(DATA_DIR,'lab-link','modules','robinhood.json');
const LAB_RH_CHAMPION_FILE=path.join(DATA_DIR,'lab-link','robinhood-champion.json');
function readLabRobinhoodStatus(){try{const v=JSON.parse(fs.readFileSync(LAB_RH_STATUS_FILE,'utf8'));return v?.module==='robinhood'?v:null}catch{return null}}
function readLabRobinhoodChampion(){try{const v=JSON.parse(fs.readFileSync(LAB_RH_CHAMPION_FILE,'utf8'));return v?.schema==='mpo.lab-module-champion.v1'&&v?.module==='robinhood'?v:null}catch{return null}}
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
function evolveSymbols(p=paper()){return primaryFirst([...new Set([robinhoodPrimary().symbol,...robinhoodSymbols(),...p.autopilot.symbols])])}
function compactCandidate(c){return c?{params:c.params,paramsHash:c.paramsHash,score:Math.round(num(c.score)*1000)/1000,metrics:c.metrics,bySymbol:Object.fromEntries(Object.entries(c.bySymbol||{}).map(([s,r])=>[s,{score:Math.round(num(r.score)*1000)/1000,notes:r.notes,test:r.test,train:r.train}])),at:c.at,generation:c.generation}:null}
// The Evolution Lab owns Robinhood search. While its lane has reported within LAB_RH_FRESH_MS the trader never runs its own
// automatic pass (a manual evolve/run still works); if the Lab goes quiet the local search is the fallback.
const LAB_RH_FRESH_MS=30*60000;
export function labRobinhoodResearchActive(t=now()){const l=readLabRobinhoodStatus();return !!l&&l.status!=='ERROR'&&t-num(l.updatedAt)<LAB_RH_FRESH_MS}
function evolveDue(){
 const cfg=E.evolveConfig();if(!cfg.enabled||evolveBusy||timer===null)return false;
 if(labRobinhoodResearchActive())return false;
 if(now()-evolveCheckedAt<EVOLVE_CHECK_MS)return false;
 const l=E.loadEvolveLedger();return now()-l.lastRunAt>=cfg.intervalMin*60000;
}
// Vol-gate ratio per evolve symbol over the last 7 days of Robinhood rows. Reads a week of tape, so it is cached.
const VOL_GATE_TTL_MS=10*60000;let volGateCache={at:0,key:'',value:null};
export function robinhoodVolGate(p=paper(),{force=false}={}){
 const key=p.paramsHash+':'+fee();if(!force&&volGateCache.value&&volGateCache.key===key&&now()-volGateCache.at<VOL_GATE_TTL_MS)return volGateCache.value;
 const bySymbol={};for(const s of evolveSymbols(p)){try{bySymbol[s]=volGateStats(T.loadTape(s,now()-7*864e5),{params:p.params,feeRatio:fee(),now:now()})}catch(e){bySymbol[s]={verdict:'ERROR',error:safeMessage(e)}}}
 const ratios=Object.values(bySymbol).map(x=>x.ratio).filter(Number.isFinite);
 const value={at:now(),days:7,bySymbol,maxRatio:ratios.length?Math.max(...ratios):null,binding:ratios.length>0&&ratios.every(r=>r<1)};
 volGateCache={at:now(),key,value};return value;
}
// Quote-source mix of the primary pair over the last 7 days (the evidence gate wants >= 90 % Robinhood rows). Cached like the vol gate.
let evidenceCache={at:0,key:'',value:null};
function robinhoodEvidence7d(){
 const primary=robinhoodPrimary().symbol,key=primary;if(evidenceCache.value&&evidenceCache.key===key&&now()-evidenceCache.at<VOL_GATE_TTL_MS)return evidenceCache.value;
 const rows=T.loadTape(primary,now()-7*864e5),sources={};for(const r of rows){const k=r.src||'unknown';sources[k]=(sources[k]||0)+1}
 const venue=rows.filter(r=>r.src==='robinhood'),total=rows.length;
 const value={symbol:primary,rows:total,sources,venueShare:total?venue.length/total:null,syntheticShare:total?(total-venue.length)/total:null,spanDays:venue.length>1?(venue[venue.length-1].t-venue[0].t)/864e5:0};
 evidenceCache={at:now(),key,value};return value;
}
// Parts for the fitness ledger (src/fitnessLedger.js). Read-only.
export function robinhoodFitnessParts({at=now()}={}){
 const p=paper(),j=J.loadJournal(),ev=robinhoodEvidence7d(),vg=robinhoodVolGate(p),l=E.loadEvolveLedger(),labDoc=readLabRobinhoodChampion(),tr=loadLabTrial();
 const rows=p.history.filter(x=>x.status==='CLOSED'&&x.paramsHash===p.paramsHash&&Number.isFinite(Number(x.pnlUsd))).map(x=>({pnl:Number(x.pnlUsd),closedAt:x.closedAt}));
 const applied=l.applied&&l.applied.paramsHash===p.paramsHash?l.applied:null,trialApplied=tr.active&&tr.active.hash===p.paramsHash?tr.active:null;
 const fullWeek=ev.spanDays>=7&&ev.venueShare!==null&&ev.venueShare>=0.9;
 return {
  running:{hash:p.paramsHash,params:p.params,since:trialApplied?.startedAt??applied?.at??null,source:trialApplied?'lab-auto':applied?'operator':'BASE'},
  paperRecord:paperRecordFrom(rows,{unit:'USD',startBalance:p.startUsd,now:at}),
  evidence:{executablePrices:(ev.sources.robinhood||0)>0,spanDays:ev.spanDays,closes:rows.length,venueShare:ev.venueShare,syntheticShare:ev.syntheticShare,quoteSources:ev.sources},
  proposal:labDoc?{id:labDoc.candidate?.paramsHash||null,stage:labDoc.qualificationStage||labDoc.stage||null,basis:labDoc.basis||null,proposalVersion:labDoc.proposalVersion??null,publishedAt:labDoc.publishedAt||null,paperPromotionAllowed:championPaperAllowed(labDoc)}:null,
  trial:labTrialView(tr),lastDecision:tr.lastDecision||null,
  park:fullWeek&&vg.binding?`vol gate binding on every pair after 7 days of Robinhood quotes (best ratio ${vg.maxRatio})`:null,
  blockers:[...(p.recoveryRequired?['paper book needs recovery']:[]),...(j.recoveryRequired?['journal needs recovery']:[])],
 };
}
export function robinhoodEvolveView(p=paper()){
 const lab=readLabRobinhoodStatus(),labDoc=readLabRobinhoodChampion();
 if(lab||labDoc){const c=labDoc?.candidate||null,champion=c?compactCandidate({params:c.params,paramsHash:c.paramsHash,score:c.score,metrics:c.metrics,bySymbol:c.bySymbol,at:labDoc.publishedAt,generation:lab?.generation||0}):null,proposed=champion&&champion.paramsHash!==p.paramsHash?champion:null;return {source:'evolution-lab',volGate:robinhoodVolGate(p),enabled:true,running:lab?.status==='RUNNING',phase:lab?.phase||lab?.status||'STARTING',generation:lab?.generation||0,champion,proposed,incumbent:lab?.incumbent||null,applied:null,currentParamsHash:p.paramsHash,tapeDays:lab?.tapeDays||{},tapeSources:lab?.tapeSources||{},minTapeDays:lab?.minTapeDays||7,lastRunAt:lab?.lastRunAt||null,nextRunAt:null,intervalMin:5,candidates:null,minGainPct:lab?.gainPct??null,autopromote:false,history:[],events:[],lastError:lab?.lastError?{stage:'lab',message:String(lab.lastError)}:null,tape:T.tapeStatus(),paperPromotionAllowed:championPaperAllowed(labDoc),championState:championState(labDoc).state,note:lab?.note||null};}
 const cfg=E.evolveConfig(),l=E.loadEvolveLedger(),tapeDays={},tapeSources={};
 for(const s of evolveSymbols(p)){try{const c=T.tapeCoverage(s,now());tapeDays[s]=Math.round(c.days*100)/100;tapeSources[s]=c.sources}catch{tapeDays[s]=0;tapeSources[s]={}}}
 const champion=compactCandidate(l.champion),proposed=champion&&champion.paramsHash!==p.paramsHash?champion:null;
 return {volGate:robinhoodVolGate(p),enabled:cfg.enabled,running:evolveBusy,generation:l.generation,champion,proposed,incumbent:compactCandidate(l.incumbent),applied:l.applied,currentParamsHash:p.paramsHash,tapeDays,tapeSources,minTapeDays:cfg.minTapeDays,lastRunAt:l.lastRunAt,nextRunAt:l.lastRunAt?l.lastRunAt+cfg.intervalMin*60000:null,intervalMin:cfg.intervalMin,candidates:cfg.candidates,minGainPct:Math.round(cfg.minGain*1000)/10,autopromote:cfg.autopromote,history:l.history.slice(0,10),events:l.events.slice(0,10),lastError:l.lastError,tape:T.tapeStatus()};
}
export async function runRobinhoodEvolveOnce({manual=false}={}){
 const cfg=E.evolveConfig();
 if(!cfg.enabled&&!manual)return {ran:false,reason:'disabled'};
 if(evolveBusy)return {ran:false,reason:'busy'};
 const p=paper();if(p.recoveryRequired)return {ran:false,reason:'paperRecovery'};
 evolveBusy=true;
 try{
  T.flushTape({force:true,now:now()});
  const since=now()-cfg.maxTapeDays*864e5,tapes={},tapeDays={},need=Math.max(p.params.warmupSamples,p.params.minSamples)*3;
  const synthetic={};for(const s of evolveSymbols(p)){const adj=realisticSpreads(T.loadTape(s,since),{params:p.params}),rows=adj.rows;synthetic[s]={rowsSynthetic:adj.rowsSynthetic,syntheticShare:adj.syntheticShare};tapeDays[s]=rows.length?Math.round((rows[rows.length-1].t-rows[0].t)/864e5*100)/100:0;if(rows.length>=need)tapes[s]=rows}
  const primary=robinhoodPrimary().symbol;
  if(!tapes[primary]||tapeDays[primary]<cfg.minTapeDays){const l=E.loadEvolveLedger();l.lastError={at:now(),stage:'tape',message:`primary tape ${tapeDays[primary]||0} days < ${cfg.minTapeDays}`};E.saveEvolveLedger(l);return {ran:false,reason:'insufficientTape',tapeDays}}
  const l0=E.loadEvolveLedger(),generation=l0.generation+1,split=E.holdoutSplit(tapes,cfg.holdoutFrac),orderUsd=Math.min(p.autopilot.orderUsd,robinhoodLimits().maxOrderUsd);
  const r=await E.searchGeneration({tapes:split.search,incumbentParams:p.params,feeRatio:fee(),orderUsd:Math.min(p.autopilot.orderUsd,robinhoodLimits().maxOrderUsd),startUsd:p.startUsd,weights:primaryWeights(),cfg,generation,now:now()});
  // Only the generation's best is replayed on the sealed holdout; a failed or reused look proposes nothing.
  const gate=r.beats?E.holdoutGate(r.best.params,split.holdout,{feeRatio:fee(),orderUsd,startUsd:p.startUsd,cfg,lookedThrough:l0.holdoutLookedThrough,context:split.context}):null,beats=!!gate?.pass;
  const l=E.loadEvolveLedger();l.generation=generation;l.lastRunAt=now();l.lastError=null;if(gate&&!gate.reasons.includes('holdoutReused'))l.holdoutLookedThrough=gate.through;
  const holdout=gate&&{pass:gate.pass,reasons:gate.reasons,closes:gate.closes,profitFactor:gate.profitFactor,pnlUsd:gate.pnlUsd,robinhoodShare:gate.robinhoodShare};
  l.incumbent={params:r.incumbent.params,paramsHash:r.incumbent.paramsHash,score:r.incumbent.score,metrics:r.incumbent.metrics,bySymbol:r.incumbent.bySymbol,at:now(),generation};
  let promoted=false,proposed=false;
  if(beats){
   const already=l.champion&&l.champion.paramsHash===r.best.paramsHash;
   if(!already||r.best.score>l.champion.score){l.champion={params:r.best.params,paramsHash:r.best.paramsHash,score:r.best.score,metrics:{...r.best.metrics,holdout},bySymbol:r.best.bySymbol,at:now(),generation};E.ledgerEvent(l,'champion',`G${generation}: ${r.best.paramsHash} scored ${r.best.score.toFixed(3)} vs incumbent ${r.incumbent.score.toFixed(3)} (+${r.gainPct}%)`,{paramsHash:r.best.paramsHash,gainPct:r.gainPct})}
   proposed=true;
  }
  l.history=[{generation,at:now(),elapsedMs:r.elapsedMs,timedOut:r.timedOut,evaluated:r.evaluated.length,symbols:Object.keys(tapes),tapeDays,synthetic,incumbentHash:r.incumbent.paramsHash,incumbentScore:Math.round(r.incumbent.score*1000)/1000,bestHash:r.best?.paramsHash||null,bestScore:r.best?Math.round(r.best.score*1000)/1000:null,gainPct:r.gainPct,beats,searchBeats:r.beats,holdout,promoted:false},...l.history].slice(0,E.__testing.HISTORY_CAP);
  E.saveEvolveLedger(l);
  if(beats&&cfg.autopromote&&l.champion.paramsHash!==p.paramsHash){
   try{applyRobinhoodEvolution({paramsHash:l.champion.paramsHash,by:'autopromote'});promoted=true;const l2=E.loadEvolveLedger();if(l2.history[0])l2.history[0].promoted=true;E.saveEvolveLedger(l2)}
   catch(e){const l2=E.loadEvolveLedger();l2.lastError={at:now(),stage:'autopromote',code:e.code||'unknown',message:safeMessage(e)};E.saveEvolveLedger(l2)}
  }
  return {ran:true,generation,evaluated:r.evaluated.length,timedOut:r.timedOut,elapsedMs:r.elapsedMs,incumbentScore:r.incumbent.score,bestScore:r.best?.score??null,bestHash:r.best?.paramsHash||null,gainPct:r.gainPct,beats,searchBeats:r.beats,holdout,proposed:proposed&&!promoted,promoted,tapeDays};
 }catch(e){note('evolve',e);try{const l=E.loadEvolveLedger();l.lastError={at:now(),stage:'search',code:e.code||'unknown',message:safeMessage(e)};E.saveEvolveLedger(l)}catch{}return {ran:false,reason:e.code||'unknown',error:safeMessage(e)}}
 finally{evolveBusy=false}
}
// Apply the ledger champion to the PAPER params only. Real autopilot is never touched here except through the
// paramsChanged disable inside setRobinhoodPaperAutopilot. Qualification resets because the paramsHash changes.
export function applyRobinhoodEvolution({paramsHash,by='operator'}={}){
 const hash=String(paramsHash||'').trim(),labDoc=readLabRobinhoodChampion(),labCandidate=labDoc?.candidate;
 if(labCandidate&&labCandidate.paramsHash===hash){if(!championPaperAllowed(labDoc))fail('notQualified',`Evolution Lab candidate is ${championState(labDoc).state}, not cleared for paper`);if(!E.withinEvolveBounds(labCandidate.params))fail('validation','Lab candidate parameters fall outside the evolution bounds');const p=paper();if(hash===p.paramsHash)return {ok:true,applied:false,paramsHash:p.paramsHash,autopilot:clone(p.autopilot),realAutopilot:robinhoodAutopilot()};const autopilot=setRobinhoodPaperAutopilot({params:labCandidate.params});if(autopilot.paramsHash!==hash)fail('validation',`Applied params hash ${autopilot.paramsHash} does not match Lab candidate ${hash}`);return {ok:true,applied:true,paramsHash:hash,autopilot,realAutopilot:robinhoodAutopilot(),source:'evolution-lab'};}
 const l=E.loadEvolveLedger();
 if(!l.champion)fail('notFound','No evolution champion has been proposed yet');
 if(!hash||l.champion.paramsHash!==hash)fail('validation',`paramsHash must match the proposed champion ${l.champion.paramsHash}`);
 if(!E.withinEvolveBounds(l.champion.params))fail('validation','Champion parameters fall outside the evolution bounds');
 const p=paper();if(l.champion.paramsHash===p.paramsHash)return {ok:true,applied:false,paramsHash:p.paramsHash,autopilot:clone(p.autopilot),realAutopilot:robinhoodAutopilot()};
 const autopilot=setRobinhoodPaperAutopilot({params:l.champion.params});
 if(autopilot.paramsHash!==hash)fail('validation',`Applied params hash ${autopilot.paramsHash} does not match champion ${hash}`);
 const l2=E.loadEvolveLedger();l2.applied={paramsHash:hash,at:now(),by:by==='autopromote'?'autopromote':'operator'};E.ledgerEvent(l2,'applied',`${l2.applied.by} applied ${hash} to the paper autopilot; qualification reset`,{paramsHash:hash,by:l2.applied.by});E.saveEvolveLedger(l2);
 return {ok:true,applied:true,paramsHash:hash,autopilot,realAutopilot:robinhoodAutopilot()};
}
// ------------------------------------------------------------------ Lab paper trials (docs/FITNESS-LEDGER.md)
// With ROBINHOOD_LAB_AUTO_APPLY_PAPER=true (default false) a cleared Lab proposal is applied to the PAPER params
// only, as a trial against the incumbent. After TRIAL_CLOSES new closes it is kept only if its profit factor is
// >= the incumbent's and its drawdown stays within TRIAL_MAX_DD_PCT of the paper start; otherwise, or with no
// close in TRIAL_IDLE_DAYS, the incumbent params come back and the hash is never applied again. Paper only.
export const TRIAL_CLOSES=20, TRIAL_MAX_DD_PCT=3, TRIAL_IDLE_DAYS=14, LAB_PASS_MS=5*60000;
const LAB_TRIAL_FILE=path.join(DATA_DIR,'robinhood-lab-trial.json'), LAB_TRIAL_SCHEMA='mpo.robinhood-lab-trial.v1', PROJECT_JOURNAL_FILE=path.join(DATA_DIR,'project-journal.ndjson');
let labPassAt=0;
export const labAutoApplyEnabled=()=>String(process.env.ROBINHOOD_LAB_AUTO_APPLY_PAPER||'').toLowerCase()==='true';
function loadLabTrial(){try{const v=JSON.parse(fs.readFileSync(LAB_TRIAL_FILE,'utf8'));if(v?.schema===LAB_TRIAL_SCHEMA)return {active:v.active||null,rejected:Array.isArray(v.rejected)?v.rejected.slice(-200):[],lastDecision:v.lastDecision||null,lastCheck:v.lastCheck||null,history:Array.isArray(v.history)?v.history.slice(0,50):[]}}catch{}return {active:null,rejected:[],lastDecision:null,lastCheck:null,history:[]}}
function saveLabTrial(t){atomicWrite(LAB_TRIAL_FILE,{schema:LAB_TRIAL_SCHEMA,...t})}
function atomicWrite(file,doc){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`,fd=fs.openSync(tmp,'w');try{fs.writeSync(fd,JSON.stringify(doc,null,1));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file)}
function trialCloses(p,hash,since){return p.history.filter(x=>x.status==='CLOSED'&&x.paramsHash===hash&&Number.isFinite(Number(x.pnlUsd))&&num(x.closedAt)>=since).map(x=>({pnl:Number(x.pnlUsd),closedAt:x.closedAt}))}
function labTrialView(t){const a=t.active;if(!a)return t.lastDecision&&['kept','reverted'].includes(t.lastDecision.action)?{status:t.lastDecision.action==='kept'?'KEPT':'REVERTED',hash:t.lastDecision.hash,incumbentHash:t.lastDecision.incumbentHash||null,startedAt:t.lastDecision.startedAt||null,endedAt:t.lastDecision.at,closes:t.lastDecision.closes??null,needed:TRIAL_CLOSES,incumbent:t.lastDecision.incumbent||null,candidate:t.lastDecision.candidate||null}:null;
 const p=paper(),rec=paperRecordFrom(trialCloses(p,a.hash,a.startedAt),{unit:'USD',startBalance:p.startUsd});
 return {status:'RUNNING',hash:a.hash,incumbentHash:a.incumbentHash,startedAt:a.startedAt,endedAt:null,closes:rec.closes,needed:TRIAL_CLOSES,incumbent:a.incumbent,candidate:{profitFactor:rec.profitFactor,profitFactorUnbounded:rec.profitFactorUnbounded,closes:rec.closes,maxDrawdownPct:rec.maxDrawdownPct}};}
function labTrialJournal(title,detail,at){try{appendProjectJournal(PROJECT_JOURNAL_FILE,{kind:'paper-trial',category:'research',module:'robinhood',title,detail,at})}catch{}}
function decide(t,decision){t.lastDecision=decision;t.history.unshift(decision);t.history=t.history.slice(0,50)}
// One pass: settle a running trial, or apply a cleared proposal when auto-apply is on. Never throws on refusal.
export function labProposalPass({at=now()}={}){
 const t=loadLabTrial(),p=paper();
 if(p.recoveryRequired)return {ran:false,reason:'paperRecovery'};
 if(t.active){
  const a=t.active;
  if(p.paramsHash!==a.hash){decide(t,{action:'abandoned',reason:'paper params changed during the trial',hash:a.hash,incumbentHash:a.incumbentHash,startedAt:a.startedAt,at,by:'operator'});t.active=null;saveLabTrial(t);labTrialJournal(`Robinhood Lab trial ${a.hash} abandoned`,'The paper params were changed by hand while the trial ran.',at);return {ran:true,decision:'abandoned'}}
  const rows=trialCloses(p,a.hash,a.startedAt),rec=paperRecordFrom(rows,{unit:'USD',startBalance:p.startUsd,now:at}),lastAt=rows.length?Math.max(...rows.map(r=>num(r.closedAt))):a.startedAt;
  let verdict=null,reason='';
  if(rec.closes>=TRIAL_CLOSES){
   const incPf=a.incumbent?.profitFactorUnbounded?Infinity:a.incumbent?.profitFactor,candPf=rec.profitFactorUnbounded?Infinity:rec.profitFactor,dd=rec.maxDrawdownPct;
   const pfOk=candPf!==null&&(incPf===null||incPf===undefined||candPf>=incPf),ddOk=dd!==null&&dd<=TRIAL_MAX_DD_PCT;
   verdict=pfOk&&ddOk?'kept':'reverted';reason=`${rec.closes} closes: PF ${rec.profitFactorUnbounded?'inf':rec.profitFactor} vs incumbent ${a.incumbent?.profitFactorUnbounded?'inf':a.incumbent?.profitFactor??'n/a'}, drawdown ${dd}% (max ${TRIAL_MAX_DD_PCT}%)`;
  }else if(at-lastAt>=TRIAL_IDLE_DAYS*864e5){verdict='reverted';reason=`no close in ${TRIAL_IDLE_DAYS} days (${rec.closes}/${TRIAL_CLOSES})`}
  if(!verdict)return {ran:true,decision:'running',closes:rec.closes};
  if(verdict==='reverted'){
   const back=setRobinhoodPaperAutopilot({params:a.incumbentParams});
   if(back.paramsHash!==a.incumbentHash)note('lab-trial',{code:'validation',message:`revert produced ${back.paramsHash}, expected ${a.incumbentHash}`});
   t.rejected=[...new Set([...t.rejected,a.hash])].slice(-200);
  }
  const l=E.loadEvolveLedger();E.ledgerEvent(l,verdict==='kept'?'trial-kept':'trial-reverted',`lab-auto trial ${a.hash}: ${reason}`,{paramsHash:a.hash,incumbentHash:a.incumbentHash});if(verdict==='reverted')l.applied={paramsHash:a.incumbentHash,at,by:'lab-auto-revert'};E.saveEvolveLedger(l);
  decide(t,{action:verdict,reason,hash:a.hash,incumbentHash:a.incumbentHash,startedAt:a.startedAt,at,by:'lab-auto',closes:rec.closes,incumbent:a.incumbent,candidate:{profitFactor:rec.profitFactor,profitFactorUnbounded:rec.profitFactorUnbounded,closes:rec.closes,maxDrawdownPct:rec.maxDrawdownPct}});
  t.active=null;saveLabTrial(t);
  labTrialJournal(`Robinhood Lab trial ${a.hash} ${verdict}`,reason,at);
  return {ran:true,decision:verdict,reason};
 }
 if(!labAutoApplyEnabled())return {ran:false,reason:'autoApplyOff'};
 const doc=readLabRobinhoodChampion(),c=doc?.candidate;
 const refuse=reason=>{const sig=`${c?.paramsHash||'none'}:${reason}`;if(t.lastCheck?.sig!==sig){t.lastCheck={sig,at,reason,hash:c?.paramsHash||null};saveLabTrial(t)}return {ran:false,reason}};
 if(!doc||!c)return refuse('no proposal');
 if(doc.qualificationStage!=='PAPER_REVIEW'||!championPaperAllowed(doc))return refuse(`proposal is ${doc.qualificationStage||championState(doc).state}, not cleared for paper`);
 if(c.paramsHash===p.paramsHash)return refuse('proposal is already running');
 if(t.rejected.includes(c.paramsHash))return refuse('proposal was reverted before');
 if(doc.basis?.incumbentHash!==p.paramsHash)return refuse(`proposal basis ${doc.basis?.incumbentHash||'missing'} is not the running params ${p.paramsHash}`);
 if(!E.withinEvolveBounds(c.params))return refuse('proposal params fall outside the evolution bounds');
 const ev=robinhoodEvidence7d(),incRows=trialCloses(p,p.paramsHash,0),may=laneMayPropose({executablePrices:(ev.sources.robinhood||0)>0,spanDays:ev.spanDays,closes:incRows.length,venueShare:ev.venueShare,syntheticShare:ev.syntheticShare});
 if(!may.ok)return refuse(`evidence: ${may.blockers.join('; ')}`);
 const inc=paperRecordFrom(incRows,{unit:'USD',startBalance:p.startUsd,now:at}),incumbentParams=clone(p.params),incumbentHash=p.paramsHash;
 const applied=setRobinhoodPaperAutopilot({params:c.params});
 if(applied.paramsHash!==c.paramsHash){setRobinhoodPaperAutopilot({params:incumbentParams});return refuse(`applied hash ${applied.paramsHash} does not match proposal ${c.paramsHash}`)}
 t.active={hash:c.paramsHash,incumbentHash,incumbentParams,incumbent:{profitFactor:inc.profitFactor,profitFactorUnbounded:inc.profitFactorUnbounded,closes:inc.closes,maxDrawdownPct:inc.maxDrawdownPct},startedAt:at,proposalVersion:doc.proposalVersion??null,proposalId:doc.candidate?.id||c.paramsHash};
 decide(t,{action:'applied',reason:`Lab proposal v${doc.proposalVersion??'?'} applied to paper as a ${TRIAL_CLOSES}-close trial`,hash:c.paramsHash,incumbentHash,startedAt:at,at,by:'lab-auto'});t.lastCheck=null;saveLabTrial(t);
 const l=E.loadEvolveLedger();l.applied={paramsHash:c.paramsHash,at,by:'lab-auto'};E.ledgerEvent(l,'applied',`lab-auto applied ${c.paramsHash} to paper as a trial against ${incumbentHash}`,{paramsHash:c.paramsHash,by:'lab-auto'});E.saveEvolveLedger(l);
 labTrialJournal(`Robinhood Lab trial ${c.paramsHash} started`,`Paper only. Kept after ${TRIAL_CLOSES} closes if PF >= incumbent ${inc.profitFactorUnbounded?'inf':inc.profitFactor??'n/a'} and drawdown <= ${TRIAL_MAX_DD_PCT}%.`,at);
 return {ran:true,decision:'applied',hash:c.paramsHash};
}
function labPassDue(){return !!timer&&now()-labPassAt>=LAB_PASS_MS}
// ------------------------------------------------------------------ snapshot
function signalEnum(symbol,row,p,j){
 if(p.positions.some(x=>x.symbol===symbol)||j.open.some(e=>e.symbol===symbol&&['OPEN','CLOSING','CLOSING_UNCERTAIN'].includes(e.status)))return 'LONG';
 const f=row.features;if(!f.ok)return f.reason==='warmup'?'WARMUP':'STALE';
 switch(row.signal.reason){case 'spread':return 'SPREAD';case 'noTrend':return 'NO-TREND';case 'breakout':return 'BREAKOUT';default:return 'WAIT'}
}
function signalText(row,p){
 const f=row.features,s=row.signal,pct=v=>Number.isFinite(v)?(100*v).toFixed(2)+'%':'n/a';
 if(!f.ok)return f.reason==='warmup'?`warming up ${f.n}/${Math.max(p.params.warmupSamples,p.params.minSamples)}`:f.reason;
 if(s.reason==='lowVol')return `expected move ${pct(f.expectedMovePct)} < ${p.params.costMultiple}x cost ${pct(s.requiredMovePct)}`;
 if(s.reason==='spread')return `spread ${f.spreadBps?.toFixed(1)} bps > ${p.params.maxSpreadBps}`;
 if(s.reason==='noBreakout')return 'no Donchian breakout';if(s.reason==='noTrend')return 'EMA not aligned';return s.reason;
}
function snapshotView(){
 const p=clone(paper()),j=J.loadJournal(),primary=robinhoodPrimary();paperStats(p);
 const rows=featureRows(p,[...robinhoodSymbols(),...p.autopilot.symbols,...j.autopilot.symbols,...p.positions.map(x=>x.symbol),...openSymbolsReal(j)]);
 const positions=p.positions.map(position=>{const q=quotes.get(position.symbol),known=fresh(q);return {...position,markBid:known?q.bid:null,unrealizedUsd:known?S.markToMarket(position,q.bid,fee()):null,unrealizedPct:known?q.bid/position.fillPrice-1:null,ageMs:now()-position.openedAt}});
 const known=positions.every(p=>p.unrealizedUsd!==null),unrealizedUsd=known?positions.reduce((s,p)=>s+p.unrealizedUsd,0):null;
 const ex=exploreStats(clone(explore(p))),exRows=featureRows(ex,Object.keys(rows),p);
 const gaugeOf=(book,r,s)=>gauge({features:r.features,signal:r.signal,params:book.params,holding:book.positions.some(x=>x.symbol===s),cooldownUntil:Number(book.cooldowns?.[s])||null,autopilotEnabled:!!book.autopilot.enabled,now:now()});
 const gauges={strict:Object.fromEntries(Object.entries(rows).map(([s,r])=>[s,gaugeOf(p,r,s)])),explore:Object.fromEntries(Object.entries(exRows).map(([s,r])=>[s,gaugeOf(ex,r,s)]))};
 const exPositions=ex.positions.map(position=>{const q=quotes.get(position.symbol),known=fresh(q);return {...position,markBid:known?q.bid:null,unrealizedUsd:known?S.markToMarket(position,q.bid,fee()):null,unrealizedPct:known?q.bid/position.fillPrice-1:null,ageMs:now()-position.openedAt}});
 const exKnown=exPositions.every(x=>x.unrealizedUsd!==null);
 const exploreView={label:EXPLORE_LABEL,enabled:exploreEnabled()&&!!ex.autopilot.enabled,countsTowardQualification:false,cashUsd:ex.cashUsd,startUsd:ex.startUsd,equityUsd:exKnown?ex.cashUsd+exPositions.reduce((s,x)=>s+x.costUsd+x.unrealizedUsd,0):null,unrealizedUsd:exKnown?exPositions.reduce((s,x)=>s+x.unrealizedUsd,0):null,positions:exPositions,history:ex.history.slice(0,8),stats:ex.stats,params:ex.params,paramsHash:ex.paramsHash,overrides:{...EXPLORE_OVERRIDES},autopilot:ex.autopilot,qualification:ex.qualification,recoveryRequired:!!ex.recoveryRequired};
 const tape=Object.fromEntries(Object.entries(rows).map(([s,r])=>[s,{n:r.features.n,ageMs:r.features.ageMs,expectedMovePct:r.features.expectedMovePct,costPct:r.costPct,requiredMovePct:r.signal.requiredMovePct,signal:signalEnum(s,r,p,j),reason:signalText(r,p),primary:s===primary.symbol,spark:J.tapeFor(p,s).slice(-60).map(x=>x.mid)}]));
 const entry=e=>{const q=quotes.get(e.symbol),known=fresh(q)&&e.status==='OPEN'&&e.fillVerified;return {id:e.id,symbol:e.symbol,side:e.side,status:e.status,placedBy:e.placedBy,orderType:e.orderType,orderId:e.orderId,requestedUsd:e.requestedUsd,requestedQty:e.requestedQty,filledQty:e.filledQty,avgPrice:e.avgPrice,costUsd:e.costUsd,feeUsd:e.feeUsd,fillVerified:e.fillVerified,markBid:known?q.bid:e.markBid,unrealizedUsd:known?e.filledQty*q.bid*(1-fee())-e.costUsd:e.unrealizedUsd,pnlUsd:e.pnlUsd,exitReason:e.exit?.reason||null,stopPct:e.stopPct,takePct:e.takePct,at:e.at,openedAt:e.openedAt,closedAt:e.closedAt,ageMs:now()-(e.openedAt||e.at),lastNote:e.notes?.length?e.notes[e.notes.length-1].text:null}};
 if(p.qualification.profitFactor===Infinity)p.qualification.profitFactor='infinity';
 const stats={...j.stats};if(stats.profitFactor===Infinity)stats.profitFactor='infinity';
 return {at:now(),readiness:robinhoodReadiness(),outbound:rhCallStats(),account:account?{...account,accountNumber:'****'+String(account.accountNumber).slice(-4)}:null,pairs:[...pairs.values()].map(x=>({symbol:x.symbol,assetIncrement:x.assetIncrement,quoteIncrement:x.quoteIncrement,minOrderAmountUsd:x.minOrderAmountUsd,isApiTradable:x.isApiTradable})),quotes:[...quotes.values()].map(q=>({...q,spreadPct:(q.ask-q.bid)/((q.ask+q.bid)/2)})),tape,
  paper:{cashUsd:p.cashUsd,startUsd:p.startUsd,equityUsd:known?p.cashUsd+positions.reduce((s,x)=>s+x.costUsd+x.unrealizedUsd,0):null,unrealizedUsd,positions,history:p.history.slice(0,8),stats:p.stats,autopilot:p.autopilot,params:p.params,paramsHash:p.paramsHash,qualification:p.qualification,recoveryRequired:!!p.recoveryRequired,recoveryError:p.recoveryError||null,fillModel:'Conservative simulated fills with spread, slippage and estimated fees; not actual executions'},
  practice:RP.practiceSnapshot({dataDir:DATA_DIR,now:now()}),
  journal:{open:j.open.map(entry),history:j.history.slice(0,12).map(entry),stats,autopilot:clone(j.autopilot),cooldowns:clone(j.cooldowns),realizedTodayUsd:J.realizedTodayUsd(j,now()),lastReconcileAt:j.lastReconcileAt,recoveryRequired:!!j.recoveryRequired,recoveryError:j.recoveryError||null},limits:robinhoodLimits(),qualificationThresholds:J.qualificationThresholds(),strategy:{params:p.params,paramsHash:p.paramsHash,requiredHitRate:p.qualification.requiredHitRate,primary:{symbol:primary.symbol,weight:primary.weight,orderMult:primary.orderMult}},loop:{running:!!timer,tickMs:TICK_MS,lastTickAt,needsQuotes:needsQuotes(p,j),alwaysOn:collectAlways(),warmStart:warmStatus?clone(warmStatus):null},equities:{automated:false,route:'Agentic Trading MCP',url:'https://agent.robinhood.com/mcp/trading',note:'Separate integration; no stock or option orders from this app'},evolve:robinhoodEvolveView(p),explore:exploreView,gauges,lastError};
}
// §24 read-only chart payload: tape (durable tail + in-memory), indicators, both books' markers, equity and trades.
// No network, no writes. The warm-up context before the range lets the EMAs and Donchian start settled.
export function robinhoodChart({symbol,range='6h'}={}){
 const sym=validSymbol(symbol||robinhoodPrimary().symbol),r=String(range||'6h');
 if(!C.CHART_RANGES[r])fail('validation','range must be one of '+Object.keys(C.CHART_RANGES).join(', '));
 const p=paper(),t=now(),since=t-C.CHART_RANGES[r]-(p.params.emaSlow*4+p.params.lookbackSamples)*TICK_MS,byT=new Map();
 for(const row of J.tapeFor(p,sym))if(row.t>=since)byT.set(row.t,row);
 for(const row of T.loadTapeSince(sym,since))byT.set(row.t,row);
 const rows=[...byT.values()].sort((a,b)=>a.t-b.t),ex=exploreStats(clone(explore(p)));
 return C.buildChart({symbol:sym,range:r,rows,params:p.params,books:{strict:p,explore:ex},now:t});
}
export async function robinhoodSnapshot({force=false}={}){
 if(snapshotFlight)return snapshotFlight;
 snapshotFlight=(async()=>{try{if(paperOnlyBuild()||robinhoodReadiness().credentialsReady)await refreshFeed([...new Set([...robinhoodSymbols(),...paper().autopilot.symbols,...J.loadJournal().autopilot.symbols])],force)}catch(e){note('snapshot',e)}return snapshotView()})();
 try{return await snapshotFlight}finally{snapshotFlight=null}
}
export const __testing={tick,setClock(fn){clockFn=fn},unlockRealExecutionForTests(v=true){testRealExecutionUnlocked=v===true;sessionArmed=false},reset(){stopRobinhoodLoops();testRealExecutionUnlocked=false;account=null;pairs=new Map();quotes=new Map();feedAt=0;identity='';paperQuoteSource=null;paperFallbackReason=null;paperFallbackUntil=0;lastTickAt=0;lastError=null;paperDirty=false;feedFlight=null;snapshotFlight=null;sessionArmed=false;placeBusy=false;apBusy=false;reconcileBusy=false;lastPreview=null;lastReconcileRun=0;previewCache.clear();evolveBusy=false;evolveCheckedAt=0;warmStatus=null;warmFlight=null;volGateCache={at:0,key:'',value:null};evidenceCache={at:0,key:'',value:null};labPassAt=0;J.__testing.resetPaper();J.__testing.resetJournal();T.__testing.reset();E.__testing.reset()},journalFile:J.JOURNAL_FILE,paperFile:J.PAPER_FILE,envFile:ENV_FILE,TICK_MS,SNAPSHOT_TTL_MS,PREVIEW_TTL_MS,ENTRY_TTL_MS,CONFIRM_PLACE,CONFIRM_CANCEL,CONFIRM_CANCEL_ALL,CONFIRM_AUTOPILOT,get lastPreview(){return lastPreview},get sessionArmed(){return sessionArmed},primaryOrderUsd,evolveFile:E.EVOLVE_FILE,tapeDir:T.TAPE_DIR,exploreFile:J.EXPLORE_FILE,explorePass,get warmStatus(){return warmStatus},labTrialFile:LAB_TRIAL_FILE,labChampionFile:LAB_RH_CHAMPION_FILE};
