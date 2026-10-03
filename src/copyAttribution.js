// Point-in-time copy results. Missing leader execution receipts are unknown, never inferred from a leaderboard.
export function copyAttribution(history=[]){
 const rows=history.filter(x=>Number.isFinite(x.pnlUsd));
 const group=key=>{const groups=new Map();for(const r of rows){const k=key(r);const g=groups.get(k)||{group:k,n:0,pnlUsd:0,feesUsd:0,knownEntryDrag:0,entryDragUsd:0};
  g.n++;g.pnlUsd+=r.pnlUsd;g.feesUsd+=(Number.isFinite(r.feeUsd)?r.feeUsd:0)+(Number.isFinite(r.exitFeeUsd)?r.exitFeeUsd:0);
  const comparison=r.leaderComparisonPrice??r.leaderPrice;
  if([r.avgPrice,comparison,r.qty].every(Number.isFinite)){g.knownEntryDrag++;g.entryDragUsd+=(r.avgPrice-comparison)*r.qty}
  groups.set(k,g)}return [...groups.values()].map(g=>({...g,entryDragUsd:g.knownEntryDrag?g.entryDragUsd:null,leaderNetProfitUsd:null})).sort((a,b)=>a.pnlUsd-b.pnlUsd)};
 const lag=r=>{const ms=r.openedAt-r.leaderAt;return Number.isFinite(r.openedAt)&&Number.isFinite(r.leaderAt)&&ms>=0?ms<=60000?'0–60 seconds':ms<=300000?'1–5 minutes':'over 5 minutes':'unknown'};
 const holding=r=>{const end=r.closedAt??r.settledAt,ms=end-r.openedAt;return Number.isFinite(end)&&Number.isFinite(r.openedAt)&&ms>=0?ms<3600000?'under 1 hour':ms<86400000?'1–24 hours':'over 24 hours':'unknown'};
 return {n:rows.length,independentPositions:new Set(rows.map(r=>r.parentPositionId||r.id||`${r.ticker||r.asset}:${r.openedAt}`)).size,independentEvents:new Set(rows.map(r=>r.conditionId||r.matching?.eventDay&&`${r.game}:${r.matching.eventDay}`||r.ticker||r.asset||'unknown')).size,byLeader:group(r=>r.leaderWallet||r.leader||'unknown'),byMarketType:group(r=>r.marketType||'unknown'),byDelay:group(lag),byHoldingHorizon:group(holding),
  note:'Our realized after-cost results; leader net profitability is unknown without their own fills, fees and exits. Entry drag uses the source reference or explicitly recorded binary-complement reference for fade, and excludes unknown leader execution costs.'};
}
export const COPY_PAUSE_DRAWDOWN=0.15, COPY_EVICT_MIN_CLOSES=5;
export function copyRisk(state){
 let equity=state.startUsd,peak=state.startUsd;
 for(const row of [...state.history].reverse())if(Number.isFinite(row.pnlUsd)){equity+=row.pnlUsd;peak=Math.max(peak,equity)}
 const marked=state.cashUsd+state.open.reduce((s,p)=>s+(p.markUsd??p.costUsd),0);
 const dd=peak>0?Math.max(0,(peak-marked)/peak):null;
 return {active:dd!==null&&dd>=COPY_PAUSE_DRAWDOWN,drawdownPct:dd,peakUsd:peak,threshold:COPY_PAUSE_DRAWDOWN,reason:'New copies paused at 15% drawdown; existing positions still settle and follow exits'};
}
