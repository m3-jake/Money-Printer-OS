// Robinhood paper trader + read-only venue monitor. No real-order transport is imported.
// Live execution is deliberately unavailable in this recovery build, even if an env flag is set.
// Snapshot: at/readiness/account/pairs/quotes/tape/paper/journal/limits/qualificationThresholds/strategy/loop/equities/lastError.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './robinhoodErrors.js';
import { creds, keyObject, rhLastAuth, rhClock, rhRateLimit, fetchAccount, fetchTradingPairs, fetchBestBidAsk } from './robinhoodTransport.js';
import { loadRobinhoodPrivateKey, publicKeyBase64 } from './robinhoodSigner.js';
import * as J from './robinhoodJournal.js';
import * as S from './robinhoodStrategy.js';
export const CONFIRM_PLACE='PLACE REAL CRYPTO ORDER', CONFIRM_CANCEL='CANCEL REAL CRYPTO ORDER', CONFIRM_CANCEL_ALL='CANCEL REAL CRYPTO ORDERS', CONFIRM_AUTOPILOT='ENABLE REAL CRYPTO AUTOPILOT', CONFIRM_FORGET='FORGET';
const clone=x=>structuredClone(x), envNum=(k,d)=>{const n=Number(process.env[k]);return Number.isFinite(n)&&n>0?n:d};
const TICK_MS=Math.max(5000,envNum('ROBINHOOD_TICK_MS',15000)), PREVIEW_TTL_MS=30000, SNAPSHOT_TTL_MS=5000;
const SYMBOL_RE=/^[A-Z0-9]{2,10}-USD$/;
let timer=null, clockFn=null, tickBusy=false, paperBusy=false, feedFlight=null, snapshotFlight=null;
let account=null, pairs=new Map(), quotes=new Map(), feedAt=0, identity='', lastTickAt=0, lastError=null, paperDirty=false;
const now=()=>clockFn?clockFn():Date.now();
const symbols=v=>[...new Set((Array.isArray(v)?v:String(v||'').split(',')).map(x=>String(x).trim().toUpperCase()).filter(x=>SYMBOL_RE.test(x)))].slice(0,6);
const validSymbol=s=>{const v=String(s||'').trim().toUpperCase();if(!SYMBOL_RE.test(v))fail('validation','Use a crypto USD pair such as BTC-USD');return v};
const safeMessage=e=>{let m=String(e?.message||e);for(const v of Object.values(creds()))if(v)m=m.split(v).join('[redacted]');return m.slice(0,240)};
function note(stage,e){lastError={at:now(),stage,code:e?.code||'unknown',message:safeMessage(e)}}
export function robinhoodLimits(){return {maxOrderUsd:envNum('ROBINHOOD_MAX_ORDER_USD',25),maxOpen:Math.floor(envNum('ROBINHOOD_MAX_OPEN',5)),dailyLossCapUsd:envNum('ROBINHOOD_DAILY_LOSS_CAP_USD',50),priceTolerance:envNum('ROBINHOOD_PRICE_TOLERANCE',0.02)}}
export function robinhoodSymbols(){const s=symbols(process.env.ROBINHOOD_SYMBOLS);return s.length?s:['BTC-USD','ETH-USD']}
function needCredentials(){if(!creds().apiKey||!keyObject())fail('noCredentials','Paper trading needs read-only Robinhood API keys for live quotes')}
function paper(){const p=J.loadPaper();p.params=S.normalizeParams({...p.params,sampleMs:TICK_MS});p.paramsHash=S.paramsHash(p.params);return p}
function fee(){const f=account?.feeRatio;return Number.isFinite(f)&&f>=0&&f<0.25?f:envNum('ROBINHOOD_FEE_RATIO_FALLBACK',0.0085)}
function fresh(q){return q&&Number.isFinite(q.bid)&&q.bid>0&&Number.isFinite(q.ask)&&q.ask>=q.bid&&Number.isFinite(q.at)&&q.at<=now()&&now()-q.at<=30000}
function quote(symbol){const q=quotes.get(symbol);if(!fresh(q))fail('validation','A fresh, valid bid/ask quote is required');return q}
async function refreshFeed(requested=robinhoodSymbols(),force=false){
 needCredentials();const fingerprint=createHash('sha256').update(JSON.stringify(creds())).digest('hex');
 if(identity!==fingerprint){identity=fingerprint;account=null;pairs=new Map();quotes=new Map();feedAt=0}
 const wanted=[...new Set([...requested,...paper().positions.map(p=>p.symbol)])];
 if(!force&&now()-feedAt<15000&&wanted.every(s=>fresh(quotes.get(s))&&pairs.has(s)))return;
 if(feedFlight){await feedFlight;if(wanted.every(s=>fresh(quotes.get(s))&&pairs.has(s)))return}
 feedFlight=(async()=>{
  if(!account||now()-account.at>600000){account=await fetchAccount();if(!account.accountNumber)fail('validation','API account response lacks an account number')}
  if(force||wanted.some(s=>!pairs.has(s)))for(const [s,p] of await fetchTradingPairs(wanted))pairs.set(s,p);
  const batch=await fetchBestBidAsk(wanted);let valid=0;
  for(const q of batch){if(!wanted.includes(q.symbol)||!fresh(q))continue;quotes.set(q.symbol,q);valid++}
  if(!valid)fail('validation','Robinhood returned no valid current quotes');feedAt=now();lastError=null;
 })();try{await feedFlight}catch(e){note('quotes',e);throw e}finally{feedFlight=null}
}
function qualification(p=paper()){return J.evaluateQualification(p,now(),J.qualificationThresholds(),robinhoodLimits())}
export function robinhoodReadiness(){
 const c=creds(),key=keyObject(),auth=rhLastAuth(),clock=rhClock(),rate=rhRateLimit(),j=J.loadJournal(),p=paper();
 return {platform:'Robinhood Crypto',hasApiKey:!!c.apiKey,hasPrivateKey:!!c.privateKeyBase64,keyValid:!!key,credentialsReady:!!(c.apiKey&&key),publicKey:key?publicKeyBase64(key):null,realEnabled:false,realRequested:String(process.env.ROBINHOOD_REAL_ENABLED).toLowerCase()==='true',sessionArmed:false,liveExecutionAvailable:false,execution:'paper-only',equities:'Agentic Trading MCP is separate; stocks and options are not automated here',developerPortal:'https://robinhood.com/account/crypto',lastAuthError:auth.error?safeMessage(auth.error):null,authCode:auth.code,lastAuthAt:auth.at,clockSkewSec:clock.lastDateHeaderSec===null?null:clock.lastDateHeaderSec-Math.floor(clock.syncedAt/1000),rateLimit:{backoffUntil:rate.backoffUntil,consecutive429:rate.consecutive429},recoveryRequired:!!j.recoveryRequired,paperRecoveryRequired:!!p.recoveryRequired,qualified:qualification(p).qualified};
}
function liveUnavailable(){fail('realDisabled','Live order execution is not installed in this recovery build. Paper trading only; no real order was sent.')}
export function armRobinhood(armed=false){if(armed===true)liveUnavailable();return robinhoodReadiness()}
export async function placeRobinhoodOrder(){liveUnavailable()}
export async function cancelRobinhoodOrder(){liveUnavailable()}
export async function cancelAllRobinhood(){liveUnavailable()}
export function forgetRobinhoodEntry({confirmation}={}){if(confirmation!=='FORGET')fail('confirmation','Type FORGET');fail('realDisabled','Real exposure is preserved unchanged in this paper-only build')}
export function robinhoodAutopilot(){return {...clone(J.loadJournal().autopilot),executable:false}}
export function setRobinhoodAutopilot(){liveUnavailable()}
export async function runRobinhoodAutopilotOnce(){return {ran:false,reason:'paperOnlyBuild'}}
export async function reconcileRobinhood(){return {ran:false,checked:0,changed:0,lastReconcileAt:J.loadJournal().lastReconcileAt,errors:[],reason:'paperOnlyBuild'}}
// Credential writes are not exposed by this recovery build; existing read-only env credentials are used.
export function configureRobinhood(){fail('validation','Set ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY in your local .env, then restart. This build does not save credentials from the browser.')}
function paperStats(p){
 const rows=p.history.filter(x=>x.status==='CLOSED'&&Number.isFinite(x.pnlUsd));let win=0,loss=0,total=0,fees=0,cum=0,peak=0,dd=0;
 for(const x of [...rows].reverse()){const pl=x.pnlUsd;total+=pl;win+=Math.max(pl,0);loss+=Math.max(-pl,0);fees+=(x.feeUsd||0)+(x.exit?.feeUsd||0);cum+=pl;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum)}
 const won=rows.filter(x=>x.pnlUsd>0).length;p.stats={closes:rows.length,won,lost:rows.length-won,pnlUsd:total,grossWinUsd:win,grossLossUsd:loss,feesUsd:fees,hitRate:rows.length?won/rows.length:null,profitFactor:loss?win/loss:win?'infinity':null,maxDrawdownUsd:dd};
 p.qualification=qualification(p);return p;
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
function openPaperAt(p,symbol,usd,placedBy='manual'){
 assertPaper(p);if(p.positions.length>=Math.min(p.autopilot.maxOpen,robinhoodLimits().maxOpen))fail('openCap','Paper position cap reached');
 if(p.positions.some(x=>x.symbol===symbol))fail('duplicate','A paper position already exists for this symbol');
 if(J.inCooldown(p,symbol,now()))fail('cooldown','The symbol is cooling down');
 const q=quote(symbol),size=paperSizing(p,symbol,usd,q),f=S.computeFeatures(J.tapeFor(p,symbol),p.params,now());
 const costPct=S.roundTripCost(fee(),(q.ask-q.bid)/((q.ask+q.bid)/2),p.params),signal=S.entrySignal(f,{costPct,params:p.params});
 if(placedBy==='paper-autopilot'&&!signal.enter)fail('validation','No entry signal: '+signal.reason);
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
 if(patch.symbols!==undefined){const list=Array.isArray(patch.symbols)?patch.symbols:String(patch.symbols).split(',');if(!list.length||list.length>6)fail('validation','Choose one to six crypto USD pairs');p.autopilot.symbols=[...new Set(list.map(validSymbol))]}
 if(patch.params!==undefined){if(!patch.params||typeof patch.params!=='object'||Array.isArray(patch.params))fail('validation','Strategy parameters must be a JSON object');p.params=S.normalizeParams({...p.params,...patch.params,sampleMs:TICK_MS});p.paramsHash=S.paramsHash(p.params)}
 if(patch.enabled===true)needCredentials();if(patch.enabled!==undefined)p.autopilot.enabled=patch.enabled;
 commitPaper(p);return {...clone(p.autopilot),paramsHash:p.paramsHash};
}
export function resetRobinhoodPaper({amountUsd=1000}={}){
 if(paperBusy)fail('busy','A paper operation is in progress');const amount=Number(amountUsd);
 if(!Number.isFinite(amount)||amount<50||amount>100000)fail('validation','Paper bank must be between 50 and 100000 USD');
 const old=paper();if(old.recoveryRequired&&fs.existsSync(J.PAPER_FILE))fs.copyFileSync(J.PAPER_FILE,J.PAPER_FILE+'.corrupt-'+Date.now()+'.bak');
 const p={...J.defaultPaper(),cashUsd:amount,startUsd:amount,params:clone(old.params),paramsHash:old.paramsHash,tape:clone(old.tape),tapeAt:old.tapeAt,autopilot:{...clone(old.autopilot),enabled:false}};
 commitPaper(p);return clone(p);
}
export async function previewRobinhoodOrder({symbol,side='buy',usd=10,orderType='market'}={}){
 if(side!=='buy'||orderType!=='market')fail('validation','This build previews paper market buys only');
 const sym=validSymbol(symbol);await refreshFeed([sym],true);const p=paper(),q=quote(sym),size=paperSizing(p,sym,Number(usd),q);
 return {symbol:sym,side,orderType,qty:size.qty,qtyStr:size.qtyStr,refAsk:q.ask,refBid:q.bid,refAt:q.at,feeRatio:fee(),estFeeUsd:size.estFeeUsd,estTotalUsd:size.costUsd,limits:robinhoodLimits(),gates:{liveExecution:false},wouldPass:false,paperWouldPass:!p.recoveryRequired,previewAt:now(),expiresAt:now()+PREVIEW_TTL_MS,warnings:['Simulation only. Real order execution is not available.']};
}
function featureRows(p){const out={};for(const symbol of new Set([...robinhoodSymbols(),...p.autopilot.symbols,...p.positions.map(p=>p.symbol)])){
 const f=S.computeFeatures(J.tapeFor(p,symbol),p.params,now()),costPct=S.roundTripCost(fee(),f.spreadPct||0,p.params),signal=S.entrySignal(f,{costPct,params:p.params});out[symbol]={features:f,costPct,signal};
}return out}
async function tick(){
 if(tickBusy||paperBusy)return {ran:false,reason:'busy'};
 const initial=paper();if(initial.recoveryRequired)return {ran:false,reason:'paperRecovery'};
 if(!initial.autopilot.enabled&&!initial.positions.length)return {ran:false,reason:'idle'};
 if(lastTickAt&&now()-lastTickAt<TICK_MS)return {ran:false,reason:'cadence'};
 tickBusy=true;try{return await withPaperLock(async()=>{
  lastTickAt=now();const wanted=[...new Set([...initial.autopilot.symbols,...initial.positions.map(p=>p.symbol)])];
  await refreshFeed(wanted,true);const p=clone(paper());assertPaper(p);p.autopilot.skipped=[];let changed=false;
  for(const symbol of wanted){const q=quotes.get(symbol);if(fresh(q))J.appendTape(p,symbol,{...q,quoteSource:q.source})}
  for(const position of [...p.positions]){
   const q=quotes.get(position.symbol);if(!fresh(q))continue;const params=position.params||p.params;
   const features=S.computeFeatures(J.tapeFor(p,position.symbol),params,now());
   const exit=S.exitSignal(position,{bid:q.bid,features,now:now(),feeRatio:fee(),params});
   position.peakBid=exit.peakBid;position.trailStop=exit.trailStop;position.maxFavorablePct=Math.max(position.maxFavorablePct||0,q.bid/position.fillPrice-1);position.maxAdversePct=Math.min(position.maxAdversePct||0,q.bid/position.fillPrice-1);
   if(exit.exit){closePaperAt(p,position.id,exit.reason,'strategy');changed=true;p.autopilot.lastAction={action:'close',symbol:position.symbol,reason:exit.reason,at:now()}}
  }
  if(p.autopilot.enabled){const rows=featureRows(p),eligible=Object.fromEntries(Object.entries(rows).filter(([,r])=>r.signal.enter));
   for(const [symbol,row]of Object.entries(rows))if(!row.signal.enter)p.autopilot.skipped.push({symbol,reason:row.signal.reason});
   for(const symbol of S.pickCandidates(eligible,p.positions.map(p=>p.symbol),p.cooldowns,Math.min(p.autopilot.maxOpen,robinhoodLimits().maxOpen),now())){
    try{openPaperAt(p,symbol,p.autopilot.orderUsd,'paper-autopilot');changed=true;p.autopilot.lastAction={action:'buy',symbol,at:now()}}catch(e){p.autopilot.skipped.push({symbol,reason:e.code||safeMessage(e)})}
   }
  }
  p.autopilot.lastRunAt=now();commitPaper(p,changed);return {ran:true,changed,open:p.positions.length,skipped:clone(p.autopilot.skipped)};
 })}catch(e){note('paper-loop',e);return {ran:false,reason:e.code||'unknown',error:safeMessage(e)}}finally{tickBusy=false}
}
export async function runRobinhoodPaperOnce(){return tick()}
export function startRobinhoodLoops(){if(timer)return;const setting=process.env.ROBINHOOD_AUTOSTART??process.env.POLYMARKET_AUTOSTART??'true';if(String(setting).toLowerCase()==='false')return;timer=setInterval(()=>{void tick()},TICK_MS);timer.unref?.()}
export function stopRobinhoodLoops(){if(timer)clearInterval(timer);timer=null;if(paperDirty){try{J.savePaper(paper(),{force:true});paperDirty=false}catch(e){note('paper-save',e)}}}
function snapshotView(){
 const p=clone(paper()),j=J.loadJournal(),rows=featureRows(p);paperStats(p);
 const positions=p.positions.map(position=>{const q=quotes.get(position.symbol),known=fresh(q);return {...position,markBid:known?q.bid:null,unrealizedUsd:known?S.markToMarket(position,q.bid,fee()):null,ageMs:now()-position.openedAt}});
 const known=positions.every(p=>p.unrealizedUsd!==null),unrealizedUsd=known?positions.reduce((s,p)=>s+p.unrealizedUsd,0):null;
 const tape=Object.fromEntries(Object.entries(rows).map(([s,r])=>[s,{n:r.features.n,ageMs:r.features.ageMs,expectedMovePct:r.features.expectedMovePct,costPct:r.costPct,requiredMovePct:r.signal.requiredMovePct,signal:r.signal.enter,reason:r.signal.reason,spark:J.tapeFor(p,s).slice(-60).map(x=>x.mid)}]));
 const entry=e=>({id:e.id,symbol:e.symbol,status:e.status,requestedUsd:e.requestedUsd,filledQty:e.filledQty,avgPrice:e.avgPrice,fillVerified:e.fillVerified,pnlUsd:e.pnlUsd,at:e.at});
 if(p.qualification.profitFactor===Infinity)p.qualification.profitFactor='infinity';
 return {at:now(),readiness:robinhoodReadiness(),account:account?{...account,accountNumber:'****'+account.accountNumber.slice(-4)}:null,pairs:[...pairs.values()],quotes:[...quotes.values()],tape,
  paper:{cashUsd:p.cashUsd,startUsd:p.startUsd,equityUsd:known?p.cashUsd+positions.reduce((s,x)=>s+x.costUsd+x.unrealizedUsd,0):null,unrealizedUsd,positions,history:p.history.slice(0,8),stats:p.stats,autopilot:p.autopilot,params:p.params,paramsHash:p.paramsHash,qualification:p.qualification,recoveryRequired:!!p.recoveryRequired,recoveryError:p.recoveryError||null,fillModel:'Conservative simulated fills with spread, slippage and estimated fees; not actual executions'},
  journal:{open:j.open.map(entry),history:j.history.slice(0,12).map(entry),stats:j.stats,autopilot:{...j.autopilot,executable:false},cooldowns:j.cooldowns,realizedTodayUsd:J.realizedTodayUsd(j,now()),lastReconcileAt:j.lastReconcileAt,recoveryRequired:!!j.recoveryRequired,recoveryError:j.recoveryError||null},limits:robinhoodLimits(),qualificationThresholds:J.qualificationThresholds(),strategy:{params:p.params,paramsHash:p.paramsHash,requiredHitRate:p.qualification.requiredHitRate},loop:{running:!!timer,tickMs:TICK_MS,lastTickAt,needsQuotes:p.autopilot.enabled||p.positions.length>0},equities:{automated:false,route:'Agentic Trading MCP',url:'https://agent.robinhood.com/mcp/trading',note:'Separate integration; no stock or option orders from this app'},lastError};
}
export async function robinhoodSnapshot({force=false}={}){
 if(snapshotFlight)return snapshotFlight;
 snapshotFlight=(async()=>{try{if(robinhoodReadiness().credentialsReady)await refreshFeed([...new Set([...robinhoodSymbols(),...paper().autopilot.symbols])],force)}catch(e){note('snapshot',e)}return snapshotView()})();
 try{return await snapshotFlight}finally{snapshotFlight=null}
}
export const __testing={tick,setClock(fn){clockFn=fn},reset(){stopRobinhoodLoops();account=null;pairs=new Map();quotes=new Map();feedAt=0;identity='';lastTickAt=0;lastError=null;paperDirty=false;feedFlight=null;snapshotFlight=null;J.__testing.resetPaper();J.__testing.resetJournal()},journalFile:J.JOURNAL_FILE,paperFile:J.PAPER_FILE,TICK_MS,SNAPSHOT_TTL_MS,PREVIEW_TTL_MS,CONFIRM_PLACE,CONFIRM_CANCEL,CONFIRM_CANCEL_ALL,CONFIRM_AUTOPILOT};
