const n=x=>Number.isFinite(Number(x))?Number(x):0;

export function pnlRows(s={}){
  if(Array.isArray(s.pnlLedger)&&s.pnlLedger.length)return s.pnlLedger;
  return (s.history||[]).filter(x=>x&&x.closedAt!=null).map(x=>({closedAt:Number(x.closedAt),pnlSol:n(x.pnlSol)}));
}
export function recentPnl(s,ms,now=Date.now()){return pnlRows(s).filter(x=>Number(x.closedAt)>=now-ms).reduce((q,x)=>q+n(x.pnlSol),0)}
export function dailyPnl(s,now=Date.now()){const d=new Date(now);d.setHours(0,0,0,0);return pnlRows(s).filter(x=>Number(x.closedAt)>=d.getTime()).reduce((q,x)=>q+n(x.pnlSol),0)}
export function ensurePnlLedger(s={}){
  if(!Array.isArray(s.pnlLedger))s.pnlLedger=(s.history||[]).filter(x=>x&&x.closedAt!=null).map(x=>({closedAt:Number(x.closedAt),pnlSol:n(x.pnlSol)}));
  if(!Number.isFinite(Number(s.realizedLifetimePnlSol))){
    const strategyTotal=Object.values(s.strategies||{}).reduce((q,x)=>q+n(x?.pnlSol),0);
    s.realizedLifetimePnlSol=strategyTotal||s.pnlLedger.reduce((q,x)=>q+n(x.pnlSol),0);
  }
  return s;
}
export function bookClosedPnl(s,trade){
  ensurePnlLedger(s);
  const row={closedAt:Number(trade?.closedAt||Date.now()),pnlSol:n(trade?.pnlSol)};
  s.pnlLedger.push(row);
  if(s.pnlLedger.length>100000)s.pnlLedger.splice(0,s.pnlLedger.length-100000);
  s.realizedLifetimePnlSol=n(s.realizedLifetimePnlSol)+row.pnlSol;
  return row;
}
export const markedPositionValue=p=>{const basis=n(p?.remainingSol??p?.sizeSol);if(!basis)return 0;const entry=n(p?.entryPrice),last=n(p?.lastPrice||entry);return entry>0?basis*(last/entry):basis};
export const markedPositionsValue=s=>(s?.positions||[]).reduce((q,p)=>q+markedPositionValue(p),0);
export const unrealizedPnl=s=>(s?.positions||[]).reduce((q,p)=>q+(markedPositionValue(p)-n(p?.remainingSol??p?.sizeSol)),0);
export const equity=s=>n(s?.cashSol)+markedPositionsValue(s);
export function updatePortfolio(s,{now=Date.now()}={}){
  ensurePnlLedger(s);
  const solUsd=n(s.market?.solUsd),cash=n(s.cashSol),positions=markedPositionsValue(s),eq=equity(s),unrealized=unrealizedPnl(s);
  const day=dailyPnl(s,now),life=n(s.realizedLifetimePnlSol);
  s.portfolio={cashSol:cash,cashUsd:cash*solUsd,positionsValueSol:positions,positionsValueUsd:positions*solUsd,unrealizedPnlSol:unrealized,unrealizedPnlUsd:unrealized*solUsd,realizedDayPnlSol:day,realizedLifetimePnlSol:life,realizedSessionPnlSol:day,equitySol:eq,equityUsd:eq*solUsd,solUsd,updatedAt:now};
  s.portfolioSeries=Array.isArray(s.portfolioSeries)?s.portfolioSeries:[];
  const last=s.portfolioSeries.at(-1);
  if(!last||now-Number(last.ts||0)>=4000){s.portfolioSeries.push({ts:now,equitySol:eq,cashSol:cash,realizedSol:day,unrealizedSol:unrealized});if(s.portfolioSeries.length>21600)s.portfolioSeries.splice(0,s.portfolioSeries.length-21600)}
  return s.portfolio;
}

export const openRealizedSol=s=>(s?.positions||[]).reduce((q,p)=>q+n(p?.realizedSol),0);
export function paperIdentity(s={},eps=1e-3){
  ensurePnlLedger(s);
  const start=n(s.paperStartSol), life=n(s.realizedLifetimePnlSol), unreal=unrealizedPnl(s), openRz=openRealizedSol(s);
  const eq=equity(s), expected=start+life+unreal, expectedExact=expected+openRz;
  const hole=eq-expected, holeExact=eq-expectedExact;
  return {
    start, life, unreal, openRz, equity:eq, expected, expectedExact, hole, holeExact,
    ok:Math.abs(hole)<=eps, okExact:Math.abs(holeExact)<=eps,
  };
}
export function assertPaperIdentity(s,eps=1e-3){
  const id=paperIdentity(s,eps);
  if(!id.ok){
    const err=new Error(`paper identity broken: equity ${id.equity} != start+life+unreal ${id.expected} (hole ${id.hole})`);
    err.code='PAPER_IDENTITY'; err.identity=id; throw err;
  }
  return id;
}
/** Flag impossible equity leaps vs paper start / prior mark. Does not mutate balances. */
export function guardEquityJump({prevEquity=null, nextEquity, startSol, maxMultiple=20, maxAbsJump=null}={}){
  const start=Math.max(1e-9,n(startSol)), next=n(nextEquity), prev=prevEquity==null?null:n(prevEquity);
  const multiple=next/start;
  const absJump=prev==null?0:Math.abs(next-prev);
  const jumpLimit=maxAbsJump==null?Math.max(start*maxMultiple, start*5):n(maxAbsJump);
  const reasons=[];
  if(!(next>=0) || !Number.isFinite(next)) reasons.push('nonfinite-or-negative-equity');
  if(multiple>maxMultiple) reasons.push(`equity-multiple>${maxMultiple}x-start`);
  if(prev!=null && absJump>jumpLimit) reasons.push(`equity-abs-jump>${jumpLimit}`);
  return {ok:!reasons.length, reasons, start, prev, next, multiple, absJump, jumpLimit};
}
