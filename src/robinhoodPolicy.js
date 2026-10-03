// Robinhood venue policy primitives — shared by robinhoodAutoTrader.js (the loop) and robinhoodLab.js (the Lab).
// Moved verbatim out of robinhoodAutoTrader.js (P2.3) so the Lab can read the clock, the symbol universe, the
// limits and the paper params without importing the loop, and so there is never a second copy of the policy.
// The only module state here is the injectable clock: the loop still exposes it as __testing.setClock.
import path from 'node:path';
import { fail } from './robinhoodErrors.js';
import { creds } from './robinhoodTransport.js';
import * as J from './robinhoodJournal.js';
import * as S from './robinhoodStrategy.js';

export const clone=x=>structuredClone(x), envNum=(k,d)=>{const n=Number(process.env[k]);return Number.isFinite(n)&&n>0?n:d};
// TICK_MS lives here because the loop cadence, the paper params sampleMs and the Lab trial hash all derive from it.
export const TICK_MS=Math.max(5000,envNum('ROBINHOOD_TICK_MS',15000));
export const SYMBOL_RE=/^[A-Z0-9]{2,10}-USD$/;
export const DATA_DIR=path.dirname(J.JOURNAL_FILE), USER_ROOT=path.dirname(DATA_DIR), ENV_FILE=path.join(USER_ROOT,'.env');
let clockFn=null;
export const now=()=>clockFn?clockFn():Date.now();
export function setRobinhoodClock(fn){clockFn=fn}
export const symbols=v=>[...new Set((Array.isArray(v)?v:String(v||'').split(',')).map(x=>String(x).trim().toUpperCase()).filter(x=>SYMBOL_RE.test(x)))].slice(0,6);
export const validSymbol=s=>{const v=String(s||'').trim().toUpperCase();if(!SYMBOL_RE.test(v))fail('validation','Use a crypto USD pair such as BTC-USD');return v};
export const safeMessage=e=>{let m=String(e?.message||e);for(const v of Object.values(creds()))if(v)m=m.split(v).join('[redacted]');return m.slice(0,240)};
// §21 Bitcoin specialization: primary symbol, candidate weight and per-order multiplier, all re-read from env.
export function robinhoodLimits(){return {maxOrderUsd:envNum('ROBINHOOD_MAX_ORDER_USD',25),maxOpen:Math.floor(envNum('ROBINHOOD_MAX_OPEN',5)),dailyLossCapUsd:envNum('ROBINHOOD_DAILY_LOSS_CAP_USD',50),priceTolerance:envNum('ROBINHOOD_PRICE_TOLERANCE',0.02)}}
export function robinhoodPrimary(){
 const s=String(process.env.ROBINHOOD_PRIMARY_SYMBOL||'BTC-USD').trim().toUpperCase(),symbol=SYMBOL_RE.test(s)?s:'BTC-USD';
 const w=Number(process.env.ROBINHOOD_PRIMARY_WEIGHT),weight=Number.isFinite(w)&&w>0?Math.min(w,10):1.5;
 const m=Number(process.env.ROBINHOOD_PRIMARY_ORDER_MULT),orderMult=Number.isFinite(m)&&m>0?Math.min(m,2):1;
 return {symbol,weight,orderMult};
}
export const primaryFirst=list=>{const p=robinhoodPrimary().symbol;return list.includes(p)?[p,...list.filter(s=>s!==p)]:list};
export const primaryWeights=()=>{const p=robinhoodPrimary();return {[p.symbol]:p.weight}};
export function primaryOrderUsd(symbol,orderUsd,limits=robinhoodLimits()){const p=robinhoodPrimary(),base=Number(orderUsd)||0;return Math.min(symbol===p.symbol?base*p.orderMult:base,limits.maxOrderUsd)}
export function robinhoodSymbols(){const s=symbols(process.env.ROBINHOOD_SYMBOLS);return primaryFirst(s.length?s:['BTC-USD','ETH-USD','SOL-USD','DOGE-USD','XRP-USD','AVAX-USD','LINK-USD','ADA-USD'])}
export function paper(){const p=J.loadPaper();p.params=S.normalizeParams({...p.params,sampleMs:TICK_MS});p.paramsHash=S.paramsHash(p.params);return p}
export function fresh(q){return q&&Number.isFinite(q.bid)&&q.bid>0&&Number.isFinite(q.ask)&&q.ask>=q.bid&&Number.isFinite(q.at)&&q.at<=now()&&now()-q.at<=30000}
