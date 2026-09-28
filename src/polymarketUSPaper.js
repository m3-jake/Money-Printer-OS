// Polymarket US combos PAPER BOOK: a virtual bankroll the operator (or a paper autopilot) trades
// from the same live board as the real panel. It never signs a request and never sends an order:
// prices are the leg asks multiplied (as buildUSCombo does) plus the evidence module's RFQ markup,
// fees use the published combo curve, and settlement reads the public markets list.
// Separate file from the real journal, so nothing here can touch real positions or stats.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUSCombo, comboBudget, chooseUSCombo, usComboPoolReport, usComboSettings, validateUSComboSettings, STRATEGY_WINDOWS } from './polymarketUSCombos.js';
import { loadEvidenceState, effectiveMarkup, fetchMarketsBySlug, longSettlement, legWon } from './polymarketUSEvidence.js';
import { renameSyncWithRetry, writeFileSynced } from './atomicRename.js';
import { createHash } from 'node:crypto';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||path.join(ROOT,'data'));
export const PAPER_FILE=path.join(DATA_DIR,'polymarket-us-paper.json');
export const PAPER_SCHEMA='mpo.polymarket-us-paper.v1';
export const PAPER_START_USD=100;
export const PAPER_BOUNDS={startUsd:{min:1,max:1000000},stakeUsd:{min:1,max:50},maxOpen:{min:1,max:10},maxLegs:{min:2,max:4}};
export const PAPER_AUTO_MS=30_000,PAPER_SETTLE_MS=60_000,PAPER_COOLDOWN_MS=180_000;
export const PAPER_STRATEGY_VERSION='polymarket-us-paper-combo.v2';
const AUTOSTART=()=>String(process.env.POLYMARKET_AUTOSTART??'true').toLowerCase()!=='false';

const num=v=>{const x=Number(v);return Number.isFinite(x)?x:0};
const r2=x=>Math.round(num(x)*100)/100;
const r4=x=>Math.round(num(x)*10000)/10000;
const clampN=(v,b)=>Math.max(b.min,Math.min(b.max,num(v)||b.min));
class PaperError extends Error{constructor(code,message){super(message);this.code=code}}
const fail=(code,message)=>{throw new PaperError(code,message)};

export function defaultPaperAutopilot(){return {enabled:true,stakeUsd:5,maxOpen:3,maxLegs:2,window:null,lastRunAt:null}}
export function defaultPaperBook(){const createdAt=Date.now();return {schema:PAPER_SCHEMA,mode:'PAPER',pnlMode:'PAPER',epochId:`paper-${createdAt}-${process.pid}`,startUsd:PAPER_START_USD,cashUsd:PAPER_START_USD,open:[],history:[],cooldowns:{},
 autopilot:defaultPaperAutopilot(),decisions:[],evaluation:null,createdAt,resets:0}}
function normalize(s={}){
 const out={...defaultPaperBook(),...s,schema:PAPER_SCHEMA,mode:'PAPER',pnlMode:'PAPER'};
 out.open=Array.isArray(s.open)?s.open.map(x=>x&&typeof x==='object'?{...x,mode:'PAPER',pnlMode:'PAPER'}:x):[];out.history=Array.isArray(s.history)?s.history.map(x=>x&&typeof x==='object'?{...x,mode:'PAPER',pnlMode:'PAPER'}:x):[];
 out.cooldowns=s.cooldowns&&typeof s.cooldowns==='object'?s.cooldowns:{};
 out.decisions=Array.isArray(s.decisions)?s.decisions.slice(0,50):[];
 out.epochId=String(s.epochId||`legacy-${s.createdAt||0}`);
 out.evaluation=s.evaluation&&typeof s.evaluation==='object'?s.evaluation:null;
 const a={...defaultPaperAutopilot(),...(s.autopilot||{})};
 out.autopilot={enabled:a.enabled!==false,stakeUsd:clampN(a.stakeUsd,PAPER_BOUNDS.stakeUsd),maxOpen:Math.round(clampN(a.maxOpen,PAPER_BOUNDS.maxOpen)),
  maxLegs:Math.round(clampN(a.maxLegs,PAPER_BOUNDS.maxLegs)),window:STRATEGY_WINDOWS.includes(a.window)?a.window:null,lastRunAt:a.lastRunAt??null};
 out.startUsd=num(s.startUsd)||PAPER_START_USD;out.cashUsd=s.cashUsd==null?out.startUsd:r2(s.cashUsd);
 return out;
}
let cache=null;
export function loadPaperBook(){
 if(cache)return cache;
 try{cache=normalize(JSON.parse(fs.readFileSync(PAPER_FILE,'utf8')))}
 catch(e){cache=e?.code==='ENOENT'?defaultPaperBook():{...defaultPaperBook(),recoveryRequired:true,recoveryError:`paper book unreadable: ${e?.message||e}`}}
 return cache;
}
function savePaperBook(b){
 cache=normalize(b);
 fs.mkdirSync(path.dirname(PAPER_FILE),{recursive:true});
 const tmp=`${PAPER_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
 try{writeFileSynced(tmp,JSON.stringify(cache,null,2));renameSyncWithRetry(tmp,PAPER_FILE)}
 catch(e){try{fs.rmSync(tmp,{force:true})}catch{}throw e}
 return cache;
}
function note(b,d){
 const head=b.decisions[0];
 if(d.action==='skipped'&&head&&head.action==='skipped'&&head.reason===d.reason){head.lastAt=d.at;head.repeats=num(head.repeats)+1;return}
 b.decisions=[d,...b.decisions].slice(0,50);
}
function assertBook(b){if(b.recoveryRequired)fail('paperRecovery','Paper book needs recovery; archive and reset it after reviewing the unreadable file')}
let settlementBusy=false;
function assertMutable(b){assertBook(b);if(settlementBusy)fail('settlementBusy','Paper settlement is in progress; retry after it completes')}

// The markup the real RFQ would add. The evidence state is large, so it is re-read at most once a minute.
let markupCache={at:0,value:null,evidence:null};
function paperMarkup(now=Date.now()){
 if(markupCache.value!=null&&now-markupCache.at<60_000)return markupCache.value;
 let v=0.03,evidence={kind:'assumed',sampleCount:0,observedComboQuote:false,source:'polymarket-us-rfq'};
 try{const s=loadEvidenceState();v=effectiveMarkup(s);evidence={...evidence,kind:s.markup?.median==null?'assumed':'historical-rfq-median',sampleCount:Array.isArray(s.markup?.samples)?s.markup.samples.length:0}}catch{}
 markupCache={at:now,value:num(v),evidence};return markupCache.value;
}
function markupEvidence(){
 paperMarkup();return {...markupCache.evidence};
}

// Pure: price a combo for the paper book (ask product + markup, fees, whole-cent contracts).
export function pricePaperCombo({legKeys,stakeUsd,candidates=null,settings=usComboSettings(),markup=paperMarkup(),at=Date.now()}={}){
 const c=buildUSCombo({legKeys,stakeUsd,candidates,settings,at});
 const price=r4(num(c.price)+num(markup));
 if(!(price>0&&price<1))fail('estimatedPriceInvalid',`Estimated combo price ${price} is not a valid contract price`);
 const coef=0.06,{quantity,feePerContract,feeUsd,costUsd}=comboBudget(price,num(stakeUsd),at,coef);
 if(!(quantity>0))fail('stakeInvalid',`Stake $${stakeUsd} is too small for a paper combo priced at ${price}`);
 return {legs:c.legs,window:c.window,outsideWindow:c.outsideWindow,rawPrice:c.rawPrice,markup:r4(markup),price,priceEvidence:markupEvidence(),strategyVersion:PAPER_STRATEGY_VERSION,quantity,
  feePerContract:r4(feePerContract),feeUsd,costUsd,payoutUsd:r2(quantity),profitUsd:r2(quantity-costUsd),stakeUsd:r2(stakeUsd)};
}

export function placePaperCombo({legKeys,stakeUsd,candidates=null,settings=null,placedBy='manual',now=Date.now(),markup}={}){
 const b=loadPaperBook();
 assertMutable(b);
 settings=settings||b.policy?.settings||usComboSettings();
 const stake=num(stakeUsd);
 if(!(stake>=PAPER_BOUNDS.stakeUsd.min&&stake<=PAPER_BOUNDS.stakeUsd.max))fail('stakeInvalid',`Paper stake must be $${PAPER_BOUNDS.stakeUsd.min}-$${PAPER_BOUNDS.stakeUsd.max}`);
 const busy=new Set(b.open.flatMap(x=>x.legs.map(l=>l.eventSlug)));
 const q=pricePaperCombo({legKeys,stakeUsd:stake,candidates,settings,at:now,...(markup==null?{}:{markup})});
 if(b.open.length>=b.autopilot.maxOpen)fail('openCap',`Paper open combo cap ${b.autopilot.maxOpen} reached`);
 if(q.legs.some(l=>busy.has(l.eventSlug)))fail('duplicateEvent','A leg\'s game already has an open paper combo');
 if(q.costUsd>b.cashUsd+1e-9)fail('insufficientPaperCash',`Paper cash $${r2(b.cashUsd)} is below the $${q.costUsd} cost (reset the paper book to refill)`);
 const entry={id:`pp-${now.toString(36)}-${Math.random().toString(36).slice(2,6)}`,at:now,placedBy,status:'OPEN',...q,
  policyHash:b.policy?.appliedHash||null,
  legs:q.legs.map(l=>({symbol:l.symbol,side:l.side,event:l.event,eventSlug:l.eventSlug,outcome:l.outcome,price:l.price,etaMinutes:l.etaMinutes}))};
 b.cashUsd=r2(b.cashUsd-q.costUsd);b.open.push(entry);
 note(b,{at:now,action:'placed',by:placedBy,id:entry.id,price:entry.price,stakeUsd:entry.costUsd,legs:entry.legs.length});
 savePaperBook(b);
 return entry;
}

// Only binary public resolutions establish a paper outcome. Missing, postponed, stale, or
// nonbinary results remain open with reserved capital until the actual contract rule is known.
export async function settlePaperCombos({now=Date.now(),fetchImpl=globalThis.fetch}={}){
 const b=loadPaperBook();
 assertBook(b);
 if(settlementBusy)return {settled:0,ran:false,reason:'settlementBusy'};
 if(!b.open.length)return {settled:0,unresolved:0};
 settlementBusy=true;
 try{
 const slugs=[...new Set(b.open.flatMap(x=>x.legs.map(l=>l.symbol)))];
 const bySlug=new Map();
 try{for(let i=0;i<slugs.length;i+=20){for(const m of await fetchMarketsBySlug(slugs.slice(i,i+20),fetchImpl))bySlug.set(m.slug,m)}}
 catch(e){b.lastSettlementError=String(e?.message||e);b.lastSettlementAt=now;savePaperBook(b);throw e}
 let settled=0;const still=[];
 for(const c of b.open){
  const legChecks=c.legs.map(l=>{const m=bySlug.get(l.symbol);if(!m)return {symbol:l.symbol,status:'MISSING'};
   if(m.status!=='MARKET_STATUS_RESOLVED')return {symbol:l.symbol,status:'UNRESOLVED',marketStatus:m.status||null};
   const w=legWon(l.side,longSettlement(m));return {symbol:l.symbol,status:w==null?'UNKNOWN':w?'WON':'LOST',marketStatus:m.status}});
  const status=legChecks.every(x=>x.status==='WON'||x.status==='LOST')?(legChecks.some(x=>x.status==='LOST')?'LOST':'WON'):null;
  if(!status){still.push({...c,lastSettlementAt:now,legChecks,settlementReason:legChecks.filter(x=>!['WON','LOST'].includes(x.status)).map(x=>`${x.symbol}: ${x.status}`).join('; ')});continue}
  const payout=status==='WON'?r2(c.quantity):0;
  const pnl=r2(payout-c.costUsd);
  b.cashUsd=r2(b.cashUsd+payout);
  b.history.unshift({...c,status,legChecks,payoutUsd:payout,pnlUsd:pnl,settledAt:now});
  for(const l of c.legs)b.cooldowns[l.eventSlug]=now;
  note(b,{at:now,action:'settled',id:c.id,status,pnlUsd:pnl});settled++;
 }
 b.open=still;b.history=b.history.slice(0,500);
 evaluatePaperPolicy(b,now);
 for(const [k,t] of Object.entries(b.cooldowns))if(now-num(t)>PAPER_COOLDOWN_MS)delete b.cooldowns[k];
 b.lastSettlementError=null;b.lastSettlementAt=now;
 savePaperBook(b);
 return {settled,unresolved:still.length};
 }finally{settlementBusy=false}
}

// One paper autopilot pass: the real autopilot's leg choice over its window's eligible legs, placed on paper.
export async function runPaperAutopilotOnce({now=Date.now(),pool=null}={}){
 const b=loadPaperBook(),ap=b.autopilot;
 assertBook(b);
 if(!ap.enabled)return {ran:false,reason:'off'};
 b.autopilot.lastRunAt=now;
 const skip=reason=>{note(b,{at:now,action:'skipped',reason});savePaperBook(b);return {ran:false,reason}};
 const settings={...(b.policy?.settings||usComboSettings())};if(ap.window)settings.window=ap.window;
 settings.maxLegs=Math.max(settings.maxLegs,ap.maxLegs);
 let report;
 try{report=pool==null?await usComboPoolReport(settings):Array.isArray(pool)?{candidates:pool,board:pool,feed:{ok:true}}:pool}
 catch(e){b.lastLoopError=String(e?.message||e);return skip(`feed error: ${b.lastLoopError}`)}
 if(loadPaperBook().epochId!==b.epochId)return {ran:false,reason:'paper epoch changed during scan'};
 b.lastLoopError=null;
 const cands=report.candidates||[];
 const eligible=cands.filter(c=>c.eligible!==false&&!c.outsideWindow);
 const cooldowns=Object.fromEntries(Object.entries(b.cooldowns).filter(([,t])=>now-num(t)<PAPER_COOLDOWN_MS));
 const legs=chooseUSCombo(eligible,ap.maxLegs,{open:b.open,cooldowns},now);
 const chosen=new Set(legs.map(x=>x.key)),busy=new Set(b.open.flatMap(x=>x.legs.map(l=>l.eventSlug)));
 const gate=b.open.length>=ap.maxOpen?`max open (${ap.maxOpen})`:b.cashUsd<ap.stakeUsd?`paper cash $${r2(b.cashUsd)} below the $${ap.stakeUsd} stake`:null;
 const complete=legs.length>=ap.maxLegs;
 b.evaluation={at:now,feed:report.feed||{ok:true},rejections:report.rejections||{},strategyVersion:PAPER_STRATEGY_VERSION,
  settingsHash:createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
  rows:(report.board||cands).map(c=>({key:c.key||null,symbol:c.symbol||null,eventSlug:c.eventSlug||null,price:c.price??null,
   source:c.priceSource||'public-market',quoteAt:c.bookAt||c.at||null,eligible:c.eligible!==false,
   decision:!report.feed?.ok?'REJECTED':c.eligible===false?'REJECTED':gate||!complete?'REJECTED':chosen.has(c.key)?'SELECTED':'REJECTED',
   reason:!report.feed?.ok?report.feed?.error:c.eligible===false?(c.reason||'candidate filter'):gate||
    (busy.has(c.eventSlug)?'event already open':cooldowns[c.eventSlug]?'cooldown':c.outsideWindow?'outside strategy window':!complete?`only ${legs.length} of ${ap.maxLegs} distinct legs`:chosen.has(c.key)?null:'lower rank')}))};
 if(!report.feed?.ok)return skip(`feed error: ${report.feed?.error||'unknown'}`);
 if(gate)return skip(gate);
 if(legs.length<ap.maxLegs)return skip(`only ${legs.length} eligible leg(s) in ${String(settings.window).replace('_',' ')}`);
 try{const entry=placePaperCombo({legKeys:legs.map(l=>l.key),stakeUsd:ap.stakeUsd,candidates:cands,settings,placedBy:'paper-autopilot',now});return {ran:true,entry}}
 catch(e){const reason=`${e.code||'error'}: ${String(e.message||e).slice(0,120)}`;
  for(const row of b.evaluation.rows)if(chosen.has(row.key)){row.decision='ENTRY_REJECTED';row.reason=reason}
  return skip(reason)}
}

export function setPaperAutopilot(patch={}){
 const b=loadPaperBook(),a={...b.autopilot};
 assertMutable(b);
 if('enabled' in patch)a.enabled=!!patch.enabled;
 for(const k of ['stakeUsd','maxOpen','maxLegs'])if(patch[k]!=null)a[k]=patch[k];
 if('window' in patch)a.window=STRATEGY_WINDOWS.includes(patch.window)?patch.window:null;
 b.autopilot=a;note(b,{at:Date.now(),action:'settings',reason:`${a.enabled?'on':'off'} · $${a.stakeUsd} · ${a.maxLegs} legs · max ${a.maxOpen} open`});
 return savePaperBook(b).autopilot;
}
export function setPaperLabPolicy(proposal,now=Date.now()){
 const b=loadPaperBook();assertMutable(b);
 if(!proposal?.valid||!proposal.paperAllowed||proposal.positiveEdge!==true)fail('paperProposalIneligible','Lab proposal is not eligible for paper');
 if(!Number.isFinite(proposal.publishedAt)||proposal.publishedAt>now||now-proposal.publishedAt>7*864e5)fail('paperProposalStale','Lab proposal is stale or future dated');
 if(!/^[a-f0-9]{64}$/i.test(proposal.datasetHash||'')||!proposal.evaluatorVersion||!(proposal.independentOutcomes>=20))fail('paperProposalEvidence','Lab proposal lacks evaluator, dataset or independent outcomes');
 if(b.policy?.status==='RUNNING')fail('paperTrialRunning','A Polymarket paper trial is already running');
 const settings=validateUSComboSettings(proposal.params,usComboSettings());
 const appliedHash=createHash('sha256').update(JSON.stringify(settings)).digest('hex');
 if(proposal.proposedHash&&proposal.proposedHash!==appliedHash)fail('paperProposalHash','Lab proposal hash does not match trader settings');
 b.policy={id:proposal.id||appliedHash,proposedHash:proposal.proposedHash||appliedHash,appliedHash,settings,status:'RUNNING',
  datasetHash:proposal.datasetHash,evaluatorVersion:proposal.evaluatorVersion,independentOutcomes:proposal.independentOutcomes,
  holdout:proposal.holdout||null,startedAt:now,startEquityUsd:r2(b.cashUsd+b.open.reduce((s,x)=>s+num(x.costUsd),0)),maxLossPct:3,requiredCloses:20};
 note(b,{at:now,action:'lab-applied',hash:appliedHash,reason:'bounded paper trial'});
 savePaperBook(b);return b.policy;
}
export function rollbackPaperLabPolicy({reason='operator rollback',now=Date.now()}={}){
 const b=loadPaperBook();assertMutable(b);if(!b.policy)return null;
 const prior={...b.policy,status:'REVERTED',endedAt:now,rollbackReason:String(reason).slice(0,200)};
 b.policyHistory=[prior,...(b.policyHistory||[])].slice(0,50);b.policy=null;
 note(b,{at:now,action:'lab-reverted',hash:prior.appliedHash,reason:prior.rollbackReason});savePaperBook(b);return prior;
}
function evaluatePaperPolicy(b,now){
 const p=b.policy;if(p?.status!=='RUNNING')return;
 const rows=b.history.filter(x=>x.policyHash===p.appliedHash&&x.placedBy==='paper-autopilot'&&x.settledAt>=p.startedAt);
 const pnl=r2(rows.reduce((s,x)=>s+num(x.pnlUsd),0));
 if(pnl<=-p.startEquityUsd*p.maxLossPct/100||rows.length>=p.requiredCloses){
  const keep=rows.length>=p.requiredCloses&&pnl>0;
  const decision={...p,status:keep?'RETAINED':'REVERTED',endedAt:now,trialCloses:rows.length,trialPnlUsd:pnl,
   rollbackReason:keep?null:pnl<=-p.startEquityUsd*p.maxLossPct/100?'paper trial loss budget':'paper trial did not beat cash'};
  b.policyHistory=[decision,...(b.policyHistory||[])].slice(0,50);
  b.policy=keep?{...decision,status:'RETAINED'}:null;
  note(b,{at:now,action:keep?'lab-retained':'lab-reverted',hash:p.appliedHash,reason:decision.rollbackReason||`${rows.length} closes, net $${pnl}`});
 }
}
export function resetPaperBook({startUsd=PAPER_START_USD}={}){
 const prev=loadPaperBook();
 if(settlementBusy)fail('settlementBusy','Paper settlement is in progress; retry reset after it completes');
 const archiveDir=path.join(DATA_DIR,'polymarket-us-paper-epochs');fs.mkdirSync(archiveDir,{recursive:true});
 const archive=path.join(archiveDir,`${Date.now()}-${prev.epochId.replace(/[^a-zA-Z0-9_-]/g,'_')}-${Math.random().toString(36).slice(2,8)}.json`);
 const priorBytes=fs.existsSync(PAPER_FILE)?fs.readFileSync(PAPER_FILE):Buffer.from(JSON.stringify(prev,null,2));
 fs.writeFileSync(archive,priorBytes,{flag:'wx'});
 const archived={epochId:prev.epochId,at:Date.now(),file:path.basename(archive),sha256:createHash('sha256').update(priorBytes).digest('hex'),open:(prev.open||[]).length,settled:(prev.history||[]).length};
 const b={...defaultPaperBook(),startUsd:clampN(startUsd,PAPER_BOUNDS.startUsd),autopilot:prev.autopilot,resets:num(prev.resets)+1};
 b.priorEpochs=[archived,...(prev.priorEpochs||[])].slice(0,1000);
 b.cashUsd=b.startUsd;
 return savePaperBook(b);
}

export function paperBookView(){
 const b=loadPaperBook();
 const decided=b.history.filter(x=>x.status==='WON'||x.status==='LOST'),won=decided.filter(x=>x.status==='WON').length;
 const staked=decided.reduce((a,x)=>a+num(x.costUsd),0),pnl=decided.reduce((a,x)=>a+num(x.pnlUsd),0);
 const openCost=b.open.reduce((a,x)=>a+num(x.costUsd),0);
 return {schema:PAPER_SCHEMA,mode:'PAPER',pnlMode:'PAPER',paperOnly:true,startUsd:b.startUsd,cashUsd:b.cashUsd,openCostUsd:r2(openCost),equityUsd:r2(b.cashUsd+openCost),valuationBasis:'CASH_PLUS_RESERVED_COST_UNMARKED',
  stats:{settled:decided.length,won,lost:decided.length-won,voided:b.history.filter(x=>x.status==='VOID').length,hitRate:decided.length?r4(won/decided.length):null,
   pnlUsd:r2(pnl),roi:staked>0?r4(pnl/staked):null},
  curve:decided.slice(0,200).reverse().reduce((acc,x)=>{acc.push(r2((acc.at(-1)||0)+num(x.pnlUsd)));return acc},[]),
  open:b.open,history:b.history.slice(0,20),autopilot:b.autopilot,bounds:PAPER_BOUNDS,decisions:b.decisions.slice(0,20),evaluation:b.evaluation,
  epochId:b.epochId,priorEpochs:b.priorEpochs||[],lastSettlementAt:b.lastSettlementAt||null,lastSettlementError:b.lastSettlementError||null,lastLoopError:b.lastLoopError||null,
  policy:b.policy||null,policyHistory:(b.policyHistory||[]).slice(0,10),
  markup:paperMarkup(),markupEvidence:markupEvidence(),strategyVersion:PAPER_STRATEGY_VERSION,recoveryRequired:!!b.recoveryRequired,recoveryError:b.recoveryError||null};
}

let autoTimer=null,settleTimer=null,autoBusy=false,settleBusy=false;
function loopFailure(e){try{const b=loadPaperBook();if(!b.recoveryRequired){b.lastLoopError=String(e?.message||e);savePaperBook(b)}}catch{}}
export function startPaperLoops({autoPass=runPaperAutopilotOnce,settlePass=settlePaperCombos,autoMs=PAPER_AUTO_MS,settleMs=PAPER_SETTLE_MS,immediate=true}={}){
 if(autoTimer||!AUTOSTART())return;
 const runAuto=()=>{if(autoBusy)return;autoBusy=true;Promise.resolve().then(()=>autoPass()).catch(loopFailure).finally(()=>{autoBusy=false})};
 const runSettle=()=>{if(settleBusy)return;settleBusy=true;Promise.resolve().then(()=>settlePass()).catch(loopFailure).finally(()=>{settleBusy=false})};
 autoTimer=setInterval(runAuto,autoMs);
 settleTimer=setInterval(runSettle,settleMs);
 autoTimer.unref?.();settleTimer.unref?.();
 if(immediate){runAuto();runSettle()}
}
export function stopPaperLoops(){clearInterval(autoTimer);clearInterval(settleTimer);autoTimer=settleTimer=null}
export const __testing={reload(){cache=null},setMarkup(v){markupCache={at:Date.now(),value:v,evidence:{kind:'assumed',sampleCount:0,observedComboQuote:false,source:'test-markup'}}}};
