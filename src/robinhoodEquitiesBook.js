// Robinhood stocks & ETFs paper lane: persistent paper book (docs/ROBINHOOD-AUTO-TRADER.md §25).
// Long-only, no margin, cash account with T+1 settlement (sale proceeds usable from the next session), fractional
// shares to 1e-6 with a $1 minimum, $0 commission + modeled slippage (bps) + SEC/FINRA pass-through fees.
// File: <DATA_DIR>/robinhood-equities-paper.json. A corrupt file sets recoveryRequired and blocks trading.
// Paper only: nothing here can reach a broker.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './robinhoodEquitiesData.js';

export const FEES={
 commissionUsd:0,
 secFeePerMillion:20.60, secFeeWaivedAtOrBelowUsd:500, // SEC Section 31 on sells; RH does not pass it on for sales <= $500
 tafPerShare:0.000195, tafWaivedAtOrBelowShares:50, tafCapUsd:9.79, // FINRA TAF on sells
 source:'https://robinhood.com/us/en/support/articles/trading-fees-on-robinhood',effective:'SEC 2026-04-04; TAF 2026-01-01',checkedAt:'2026-09-26',
};
export const DEFAULTS={startUsd:1000,slippageBps:2,minOrderUsd:1,minTradeUsd:5,driftPct:2};
const QTY_STEP=1e-6;
const r2=v=>Math.round(v*100)/100;
const floorQty=q=>Math.floor(q/QTY_STEP+1e-9)*QTY_STEP;

export function bookFile(dataDir){return path.join(dataDir,'robinhood-equities-paper.json')}
export function newBook({startUsd=DEFAULTS.startUsd,slippageBps=DEFAULTS.slippageBps,strategyId,paramsHash,now=Date.now()}={}){
 return {version:1,createdAt:new Date(now).toISOString(),startUsd,slippageBps,settledCashUsd:startUsd,unsettled:[],positions:{},pending:null,history:[],
  equityDaily:[],bench:null,lastDecidedSession:null,lastDecision:null,missedSessions:0,strategyId,paramsHash,recoveryRequired:false};
}
export function loadBook(dataDir,init={}){
 const f=bookFile(dataDir);
 let raw;try{raw=fs.readFileSync(f,'utf8')}catch(e){if(e.code==='ENOENT')return newBook(init);return {...newBook(init),recoveryRequired:true,recoveryReason:'unreadable: '+e.code}}
 try{const b=JSON.parse(raw);if(b?.version!==1||typeof b.settledCashUsd!=='number'||!b.positions)throw new Error('shape');return b}
 catch{return {...newBook(init),recoveryRequired:true,recoveryReason:'corrupt paper book file; reset with RESET PAPER'}}
}
export function saveBook(dataDir,book){if(book.recoveryRequired)return false;writeJsonAtomic(bookFile(dataDir),book);return true}

export function sellFees(notionalUsd,shares){
 const sec=notionalUsd>FEES.secFeeWaivedAtOrBelowUsd?Math.ceil(notionalUsd*FEES.secFeePerMillion/1e6*100)/100:0;
 const taf=shares>FEES.tafWaivedAtOrBelowShares?Math.min(FEES.tafCapUsd,Math.ceil(shares*FEES.tafPerShare*100)/100):0;
 return {sec,taf};
}
export function settle(book,session){
 const keep=[];for(const u of book.unsettled){if(u.settlesOn<=session)book.settledCashUsd=r2(book.settledCashUsd+u.usd);else keep.push(u)}
 book.unsettled=keep;
}
export function cashUsd(book){return r2(book.settledCashUsd+book.unsettled.reduce((a,u)=>a+u.usd,0))}
export function equityAt(book,priceOf){let e=cashUsd(book);for(const [s,p] of Object.entries(book.positions)){const px=priceOf(s);if(Number.isFinite(px))e+=p.qty*px;else e+=p.qty*p.lastPx}return r2(e)}

// Execute the pending targets at `session` open. openOf(sym) -> open price. settlesOn = next session (T+1).
export function fillPending(book,{session,openOf,settlesOn,late=false,now=Date.now()}){
 const pend=book.pending;if(!pend)return [];
 settle(book,session);
 const slip=book.slippageBps/10000;const fills=[];
 const equity=equityAt(book,openOf);
 const minTrade=Math.max(DEFAULTS.minTradeUsd,equity*DEFAULTS.driftPct/100);
 // Sells first.
 for(const [s,p] of Object.entries(book.positions)){
  const o=openOf(s);if(!Number.isFinite(o))continue;
  const cur=p.qty*o,tgt=(pend.targets[s]||0)*equity;
  if(cur-tgt<minTrade&&tgt>0)continue;
  let q=tgt<=0?p.qty:floorQty((cur-tgt)/o);if(q<=0)continue;
  const px=o*(1-slip);const gross=q*px;const fees=sellFees(gross,q);const net=r2(gross-fees.sec-fees.taf);
  p.qty=floorQty(p.qty-q);const realized=r2(net-q*p.avgPx);
  if(p.qty<QTY_STEP)delete book.positions[s];else p.lastPx=o;
  book.unsettled.push({usd:net,settlesOn});
  fills.push({at:new Date(now).toISOString(),session,side:'sell',symbol:s,qty:q,fillPrice:r2(px*1e4)/1e4,refOpen:o,notionalUsd:r2(gross),fees,pnlUsd:realized,late,strategyId:pend.strategyId,paramsHash:pend.paramsHash||null});
 }
 // Buys with settled cash only (cash account: no trading on unsettled proceeds). Shortfall is re-decided next close.
 const buys=Object.entries(pend.targets).map(([s,w])=>{const o=openOf(s);const cur=(book.positions[s]?.qty||0)*(o||0);return {s,o,need:w*equity-cur}}).filter(x=>Number.isFinite(x.o)&&x.need>=minTrade);
 const totalNeed=buys.reduce((a,x)=>a+x.need,0);const scale=totalNeed>book.settledCashUsd?book.settledCashUsd/totalNeed:1;
 for(const b of buys){
  const spend=Math.floor(b.need*scale*100)/100;if(spend<DEFAULTS.minOrderUsd)continue;
  const px=b.o*(1+slip);const q=floorQty(spend/px);if(q<=0)continue;const cost=r2(q*px);
  const p=book.positions[b.s]||{qty:0,avgPx:0,lastPx:b.o};
  p.avgPx=(p.qty*p.avgPx+cost)/(p.qty+q);p.qty=floorQty(p.qty+q);p.lastPx=b.o;book.positions[b.s]=p;
  book.settledCashUsd=r2(book.settledCashUsd-cost);
  fills.push({at:new Date(now).toISOString(),session,side:'buy',symbol:b.s,qty:q,fillPrice:r2(px*1e4)/1e4,refOpen:b.o,notionalUsd:cost,fees:{sec:0,taf:0},late,shortOfSettledCash:scale<1,strategyId:pend.strategyId,paramsHash:pend.paramsHash||null});
 }
 book.history.push(...fills);if(book.history.length>500)book.history.splice(0,book.history.length-500);
 book.lastFill={session,late,decidedForSession:pend.decidedForSession,count:fills.length};
 book.pending=null;
 return fills;
}
