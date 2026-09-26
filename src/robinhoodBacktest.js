// Robinhood Auto Trader — pure tape replay (docs/ROBINHOOD-AUTO-TRADER.md §22).
// Walks recorded {t,bid,ask} samples through the live strategy functions (computeFeatures / entrySignal / exitSignal /
// sizeOrder / paperBuyFill / paperSellFill) exactly as the paper pass does, one position per symbol, fees on both legs,
// and returns replay metrics. Deterministic: no clock, env, fs or randomness. The Bitcoin-primary weight is NOT applied
// here; robinhoodEvolve.js weights per-symbol scores. Imports only the strategy module.
import * as S from './robinhoodStrategy.js';

export const REPLAY_WINDOW=720; // same depth as the live in-memory tape (robinhoodJournal TAPE_CAP)
const DAY_MS=864e5;
const r2=v=>Math.round(v*100)/100;

export function emptyMetrics(){return {closes:0,wins:0,hitRate:null,profitFactor:null,pnlUsd:0,feesUsd:0,maxDrawdownUsd:0,exposureMin:0,tradesPerDay:0,avgHoldMin:0,samples:0,spanDays:0,entries:0}}

// samples: [{t,bid,ask,mid?}] oldest first. Options: params (normalized inside), feeRatio, orderUsd, startUsd, pair.
export function backtestTape(samples,{params,feeRatio=0.0095,orderUsd=25,startUsd=1000,pair=null,window=REPLAY_WINDOW}={}){
 const p=S.normalizeParams(params),fee=Number.isFinite(feeRatio)&&feeRatio>=0?feeRatio:0;
 const rows=(Array.isArray(samples)?samples:[]).filter(s=>s&&Number.isFinite(s.t)&&s.bid>0&&s.ask>=s.bid).map(s=>({t:s.t,bid:s.bid,ask:s.ask,mid:Number.isFinite(s.mid)?s.mid:(s.bid+s.ask)/2}));
 const m=emptyMetrics();m.samples=rows.length;
 if(rows.length<2)return {...m,closes:[],metrics:m};
 const pr=pair||{assetIncrement:'0.00000001',minOrderAmountUsd:1,maxOrderSize:null};
 const need=Math.max(p.warmupSamples,p.minSamples);
 let cash=startUsd,position=null,cooldownUntil=0,peak=startUsd,dd=0,exposureMs=0,holdMs=0,entries=0;
 const closes=[];let grossWin=0,grossLoss=0,fees=0;
 const closeAt=(i,reason)=>{
  const s=rows[i],fill=S.paperSellFill({qty:position.qty,bid:s.bid,ask:s.ask,feeRatio:fee,now:s.t,params:p});
  const pnlUsd=fill.proceedsUsd-position.costUsd;cash+=fill.proceedsUsd;
  const closed={symbolIndex:i,openedAt:position.openedAt,closedAt:s.t,reason,pnlUsd,feeUsd:position.feeUsd+fill.feeUsd,holdMin:(s.t-position.openedAt)/60000};
  closes.push(closed);if(pnlUsd>0)grossWin+=pnlUsd;else grossLoss+=-pnlUsd;fees+=closed.feeUsd;holdMs+=s.t-position.openedAt;exposureMs+=s.t-position.openedAt;
  cooldownUntil=S.cooldownUntil({closedAt:s.t,pnlUsd},p);position=null;
  peak=Math.max(peak,cash);dd=Math.max(dd,peak-cash);
 };
 for(let i=need-1;i<rows.length;i++){
  const s=rows[i],slice=rows.slice(Math.max(0,i+1-window),i+1);
  const f=S.computeFeatures(slice,p,s.t);
  if(position){
   const x=S.exitSignal(position,{bid:s.bid,features:f,now:s.t,feeRatio:fee,params:p});
   position.peakBid=x.peakBid;position.trailStop=x.trailStop;
   if(x.exit)closeAt(i,x.reason);
   continue;
  }
  if(!f.ok||s.t<cooldownUntil)continue;
  const costPct=S.roundTripCost(fee,f.spreadPct||0,p),sig=S.entrySignal(f,{costPct,params:p});
  if(!sig.enter)continue;
  const size=S.sizeOrder({orderUsd,ask:s.ask,pair:pr,buyingPowerUsd:cash,maxOrderUsd:orderUsd,feeRatio:fee});
  if(!size.ok)continue;
  const fill=S.paperBuyFill({qty:size.qty,bid:s.bid,ask:s.ask,feeRatio:fee,now:s.t,params:p});
  if(!(fill.costUsd>0)||fill.costUsd>cash)continue;
  cash-=fill.costUsd;entries++;
  position={qty:size.qty,fillPrice:fill.fillPrice,costUsd:fill.costUsd,feeUsd:fill.feeUsd,openedAt:s.t,stopPct:sig.stopPct,takePct:sig.takePct,trailArmPct:sig.trailArmPct,trailPct:sig.trailPct,peakBid:s.bid,trailStop:null};
 }
 if(position){exposureMs+=rows[rows.length-1].t-position.openedAt;const s=rows[rows.length-1];const mark=S.markToMarket(position,s.bid,fee);peak=Math.max(peak,cash+position.costUsd+mark);dd=Math.max(dd,peak-(cash+position.costUsd+mark))}
 const spanMs=rows[rows.length-1].t-rows[0].t,spanDays=spanMs/DAY_MS,n=closes.length,wins=closes.filter(c=>c.pnlUsd>0).length;
 Object.assign(m,{closes:n,wins,hitRate:n?wins/n:null,profitFactor:!n?null:grossLoss>0?grossWin/grossLoss:grossWin>0?Infinity:null,pnlUsd:r2(grossWin-grossLoss),feesUsd:r2(fees),maxDrawdownUsd:r2(dd),exposureMin:Math.round(exposureMs/60000),tradesPerDay:spanDays>0?n/spanDays:0,avgHoldMin:n?holdMs/n/60000:0,spanDays,entries});
 return {...m,closes,metrics:m};
}
// Walk-forward split by time: train = older `trainFrac` of the span, test = the rest (newest samples).
export function walkForwardSplit(samples,trainFrac=0.7){
 const rows=Array.isArray(samples)?samples:[];if(!rows.length)return {train:[],test:[],cutAt:null};
 const frac=Math.min(0.95,Math.max(0.05,Number(trainFrac)||0.7));
 const cut=Math.floor(rows.length*frac);
 return {train:rows.slice(0,cut),test:rows.slice(cut),cutAt:rows[cut]?rows[cut].t:null};
}
