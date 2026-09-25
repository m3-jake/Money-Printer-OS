// Robinhood Auto Trader — paper-only parameter evolution (docs/ROBINHOOD-AUTO-TRADER.md §22).
// Mirrors the Evolution Lab's evolve -> score -> promote loop in miniature and self-contained: candidates are bounded
// mutations of the current PAPER params, scored by walk-forward replay (robinhoodBacktest.js) on the durable tape
// (robinhoodTape.js), and a champion is only ever PROPOSED for the paper book. Applying it goes through
// setRobinhoodPaperAutopilot({params}) in robinhoodAutoTrader.js, never to real autopilot. Fail-closed: no champion
// without a minimum gain over the incumbent on the test split; autopromote is off unless ROBINHOOD_EVOLVE_AUTOPROMOTE
// is exactly 'true'. This module imports the strategy and backtest modules only; the ledger lives in
// <DATA_DIR>/robinhood-evolve.json.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as S from './robinhoodStrategy.js';
import {backtestTape,walkForwardSplit,emptyMetrics} from './robinhoodBacktest.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||path.join(ROOT,'data'));
export const EVOLVE_FILE=path.join(DATA_DIR,'robinhood-evolve.json');
const HISTORY_CAP=100, EVENT_CAP=50, DAY_MS=864e5;
const envNum=(k,d)=>{const v=Number(process.env[k]);return Number.isFinite(v)&&v>0?v:d};
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

// [min, max, integer] — deliberately narrower than robinhoodStrategy PARAM_RANGES so the search stays near the live regime.
export const EVOLVE_BOUNDS=Object.freeze({
 emaFast:[5,30,true],emaSlow:[20,120,true],lookbackSamples:[30,240,true],costMultiple:[1,3,false],takeMult:[2,8,false],stopMult:[0.5,2,false],
 trailArmMult:[1,4,false],trailMult:[0.5,2,false],maxHoldMin:[30,720,false],maxSpreadBps:[10,80,false],breakoutBufferPct:[0,0.002,false],fadeExit:[false,true,'bool'],
});
export const EVOLVE_KEYS=Object.keys(EVOLVE_BOUNDS);

export function evolveConfig(){
 return {
  enabled:String(process.env.ROBINHOOD_EVOLVE_ENABLED??'true').toLowerCase()!=='false',
  intervalMin:envNum('ROBINHOOD_EVOLVE_INTERVAL_MIN',360),
  candidates:Math.max(1,Math.min(200,Math.floor(envNum('ROBINHOOD_EVOLVE_CANDIDATES',24)))),
  minGain:(()=>{const v=Number(process.env.ROBINHOOD_EVOLVE_MIN_GAIN);return Number.isFinite(v)&&v>=0?v:0.15})(),
  autopromote:String(process.env.ROBINHOOD_EVOLVE_AUTOPROMOTE||'false').toLowerCase()==='true',
  minTapeDays:envNum('ROBINHOOD_EVOLVE_MIN_TAPE_DAYS',3),
  maxTapeDays:Math.min(45,envNum('ROBINHOOD_EVOLVE_MAX_TAPE_DAYS',14)),
  budgetMs:Math.min(20000,envNum('ROBINHOOD_EVOLVE_BUDGET_MS',20000)),
  minCloses:20,maxDrawdownFrac:0.03,trainFrac:0.7,
 };
}

// Deterministic RNG (same construction as the Lab's evolutionScoring.mulberry32) so a generation is reproducible.
export function mulberry32(seed){let a=seed>>>0;return function(){a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296}}

// One bounded mutation of `base`: 2-4 keys nudged within EVOLVE_BOUNDS, emaFast < emaSlow enforced, other keys untouched.
export function mutateParams(base,rng=Math.random,{keys=EVOLVE_KEYS}={}){
 const p=S.normalizeParams(base),out={...p};
 const n=2+Math.floor(rng()*3),pool=[...keys];
 for(let i=0;i<n&&pool.length;i++){
  const key=pool.splice(Math.floor(rng()*pool.length),1)[0],[lo,hi,kind]=EVOLVE_BOUNDS[key];
  if(kind==='bool'){out[key]=rng()<0.5;continue}
  const span=hi-lo,cur=clamp(num(p[key]),lo,hi);
  let v=rng()<0.5?cur+(rng()*2-1)*span*0.25:lo+rng()*span; // local nudge or global jump (Lab's mutate/global split in spirit)
  v=clamp(v,lo,hi);if(kind===true)v=Math.round(v);
  out[key]=v;
 }
 for(const key of EVOLVE_KEYS){const [lo,hi,kind]=EVOLVE_BOUNDS[key];if(kind==='bool')continue;out[key]=clamp(num(out[key]),lo,hi);if(kind===true)out[key]=Math.round(out[key])}
 if(out.emaFast>=out.emaSlow)out.emaFast=Math.max(EVOLVE_BOUNDS.emaFast[0],Math.min(out.emaSlow-1,out.emaFast));
 if(out.emaFast>=out.emaSlow)out.emaSlow=Math.min(EVOLVE_BOUNDS.emaSlow[1],out.emaFast+1);
 return S.normalizeParams(out);
}
export function withinEvolveBounds(params){
 const p=S.normalizeParams(params);
 for(const key of EVOLVE_KEYS){const [lo,hi,kind]=EVOLVE_BOUNDS[key];if(kind==='bool'){if(typeof p[key]!=='boolean')return false;continue}if(!(p[key]>=lo&&p[key]<=hi))return false;if(kind===true&&!Number.isInteger(p[key]))return false}
 return p.emaFast<p.emaSlow;
}

const pf=m=>{const v=m?.profitFactor;return v===Infinity||v==='infinity'?5:Number.isFinite(v)?Math.min(5,Math.max(0,v)):0};
// Test-split score for one symbol with the fail-closed penalties. 0 means "no evidence".
export function scoreSymbol({train,test},{startUsd=1000,minCloses=20,maxDrawdownFrac=0.03}={}){
 let score=pf(test);const notes=[];
 if(!test||!(test.closes>0)){return {score:0,notes:['noCloses']}}
 if(test.closes<minCloses){score*=test.closes/minCloses;notes.push(`closes ${test.closes} < ${minCloses}`)}
 if(test.maxDrawdownUsd>maxDrawdownFrac*startUsd){score*=0.5;notes.push(`drawdown ${test.maxDrawdownUsd} > ${(maxDrawdownFrac*100).toFixed(0)}% of ${startUsd}`)}
 if(!(test.pnlUsd>0)){score*=0.25;notes.push('pnl <= 0')}
 const gap=Math.max(0,pf(train)-pf(test));if(gap>0){score/=1+gap;if(gap>=1)notes.push(`overfit gap ${gap.toFixed(2)}`)}
 return {score,notes};
}
// Weighted mean of symbol scores (weights default 1; the primary symbol carries ROBINHOOD_PRIMARY_WEIGHT from the caller).
export function compositeScore(bySymbol,weights={}){
 let sum=0,wsum=0;
 for(const [symbol,row] of Object.entries(bySymbol||{})){const w=num(weights?.[symbol])>0?num(weights[symbol]):1;sum+=w*num(row.score);wsum+=w}
 return wsum?sum/wsum:0;
}
function aggregate(bySymbol){
 const out=emptyMetrics();let hold=0,wins=0,gw=0,gl=0;
 for(const row of Object.values(bySymbol)){const t=row.test||{};out.closes+=num(t.closes);wins+=num(t.wins);out.pnlUsd+=num(t.pnlUsd);out.feesUsd+=num(t.feesUsd);out.maxDrawdownUsd=Math.max(out.maxDrawdownUsd,num(t.maxDrawdownUsd));out.exposureMin+=num(t.exposureMin);out.tradesPerDay+=num(t.tradesPerDay);hold+=num(t.avgHoldMin)*num(t.closes);out.samples+=num(t.samples);out.spanDays=Math.max(out.spanDays,num(t.spanDays));
  for(const c of row.testCloses||[]){if(c.pnlUsd>0)gw+=c.pnlUsd;else gl+=-c.pnlUsd}}
 out.wins=wins;out.hitRate=out.closes?wins/out.closes:null;out.avgHoldMin=out.closes?hold/out.closes:0;out.profitFactor=!out.closes?null:gl>0?Math.round(gw/gl*1000)/1000:gw>0?'infinity':null;
 out.pnlUsd=Math.round(out.pnlUsd*100)/100;out.feesUsd=Math.round(out.feesUsd*100)/100;return out;
}
// tapes: { [symbol]: samples[] }. Returns { params, paramsHash, score, bySymbol, metrics }.
export function evaluateCandidate(params,tapes,{feeRatio=0.0085,orderUsd=25,startUsd=1000,weights={},cfg=evolveConfig()}={}){
 const p=S.normalizeParams(params),bySymbol={};
 for(const [symbol,samples] of Object.entries(tapes||{})){
  const split=walkForwardSplit(samples,cfg.trainFrac);
  const train=backtestTape(split.train,{params:p,feeRatio,orderUsd,startUsd}),test=backtestTape(split.test,{params:p,feeRatio,orderUsd,startUsd});
  const {score,notes}=scoreSymbol({train:train.metrics,test:test.metrics},{startUsd,minCloses:cfg.minCloses,maxDrawdownFrac:cfg.maxDrawdownFrac});
  bySymbol[symbol]={score,notes,train:train.metrics,test:test.metrics,testCloses:test.closes,cutAt:split.cutAt};
 }
 const metrics=aggregate(bySymbol);
 for(const row of Object.values(bySymbol))delete row.testCloses;
 return {params:p,paramsHash:S.paramsHash(p),score:compositeScore(bySymbol,weights),bySymbol,metrics};
}
const yieldNow=()=>new Promise(r=>setImmediate(r));
// The search. Evaluates the incumbent first, then up to `candidates` bounded mutations while inside `budgetMs`
// (checked between candidates, with a macrotask yield so the loop tick stays responsive). Pure of fs/env except `cfg`.
export async function searchGeneration({tapes,incumbentParams,feeRatio,orderUsd,startUsd,weights={},cfg=evolveConfig(),generation=1,now=Date.now(),clock=Date.now,rng=null,yieldFn=yieldNow}={}){
 const startedAt=clock(),rand=rng||mulberry32((generation*2654435761+Math.floor(now/1000))>>>0);
 const incumbent=evaluateCandidate(incumbentParams,tapes,{feeRatio,orderUsd,startUsd,weights,cfg});
 const evaluated=[],seen=new Set([incumbent.paramsHash]);let best=null,timedOut=false;
 for(let i=0;i<cfg.candidates;i++){
  if(clock()-startedAt>cfg.budgetMs){timedOut=true;break}
  let params=null;for(let tries=0;tries<8&&!params;tries++){const c=mutateParams(incumbent.params,rand);const h=S.paramsHash(c);if(!seen.has(h)){seen.add(h);params=c}}
  if(!params)continue;
  const r=evaluateCandidate(params,tapes,{feeRatio,orderUsd,startUsd,weights,cfg});
  evaluated.push({paramsHash:r.paramsHash,score:r.score,closes:r.metrics.closes,pnlUsd:r.metrics.pnlUsd,profitFactor:r.metrics.profitFactor});
  if(!best||r.score>best.score||(r.score===best.score&&r.paramsHash<best.paramsHash))best=r;
  await yieldFn();
 }
 const gain=best&&best.score>0?(best.score-incumbent.score)/Math.max(incumbent.score,1e-9):-1;
 const beats=!!best&&best.score>0&&(incumbent.score<=0?best.score>0:best.score>=incumbent.score*(1+cfg.minGain));
 return {generation,at:now,elapsedMs:clock()-startedAt,timedOut,incumbent,best,evaluated,gainPct:Number.isFinite(gain)&&gain>=0?Math.round(gain*1000)/10:null,beats};
}

// ---------------------------------------------------------------- ledger
export function defaultLedger(){return {version:1,generation:0,champion:null,incumbent:null,applied:null,history:[],events:[],lastRunAt:0,lastError:null}}
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function normalizeLedger(s){
 const d=defaultLedger(),src=isObj(s)?s:{};
 const cand=c=>isObj(c)&&isObj(c.params)&&typeof c.paramsHash==='string'?{params:S.normalizeParams(c.params),paramsHash:c.paramsHash,score:num(c.score),metrics:isObj(c.metrics)?c.metrics:{},bySymbol:isObj(c.bySymbol)?c.bySymbol:{},at:num(c.at),generation:num(c.generation)}:null;
 return {version:1,generation:Math.max(0,Math.floor(num(src.generation))),champion:cand(src.champion),incumbent:cand(src.incumbent),applied:isObj(src.applied)&&typeof src.applied.paramsHash==='string'?{paramsHash:src.applied.paramsHash,at:num(src.applied.at),by:String(src.applied.by||'operator')}:null,
  history:(Array.isArray(src.history)?src.history.filter(isObj):[]).slice(0,HISTORY_CAP),events:(Array.isArray(src.events)?src.events.filter(isObj):[]).slice(0,EVENT_CAP),lastRunAt:num(src.lastRunAt),lastError:isObj(src.lastError)?src.lastError:null,...(d.version?{}:{})};
}
let cache=null;
export function loadEvolveLedger(){
 if(cache)return cache;
 try{cache=normalizeLedger(JSON.parse(fs.readFileSync(EVOLVE_FILE,'utf8')))}
 catch(e){cache=defaultLedger();if(e?.code!=='ENOENT')cache.lastError={at:Date.now(),stage:'load',message:String(e?.message||e).slice(0,200)}}
 return cache;
}
export function saveEvolveLedger(l){
 cache=normalizeLedger(l);
 const dir=path.dirname(EVOLVE_FILE);fs.mkdirSync(dir,{recursive:true});
 const tmp=path.join(dir,`.robinhood-evolve.${process.pid}.${Date.now().toString(36)}.tmp`);
 try{fs.writeFileSync(tmp,JSON.stringify(cache,null,2));fs.renameSync(tmp,EVOLVE_FILE)}catch(e){try{fs.rmSync(tmp,{force:true})}catch{}throw e}
 return cache;
}
export function ledgerEvent(l,type,text,extra={}){l.events=[{at:Date.now(),type,text:String(text).slice(0,200),...extra},...(l.events||[])].slice(0,EVENT_CAP)}
export const __testing={reset(){cache=null},HISTORY_CAP,EVENT_CAP,DAY_MS};
