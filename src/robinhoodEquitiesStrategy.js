// Robinhood stocks & ETFs paper lane: strategy registry + pure replay (docs/ROBINHOOD-AUTO-TRADER.md §25).
// 'tactical-a' is the research track's verified winner ("Book A"): 50% SPY 200-day trend sleeve (1% band,
// T-bills when out) + 50% dual-momentum rotation (12-1 momentum, top 3 of 8 ETFs, T-bill hurdle, IEF fallback),
// rotation rebalanced on the last session of each month. Expectation set honestly: it is a drawdown-control
// book, not alpha; out-of-sample it trailed buy-and-hold SPY on return. Every result is shown next to the
// baselines 'buy-hold' (100% SPY) and cash (0%).
// Pure: targetWeights(bars, asOf) reads only rows with d <= asOf.
import { createHash } from 'node:crypto';
import { nextSession } from './robinhoodEquitiesCalendar.js';

export const CASH='CASH';
export const STRATEGIES={
 'tactical-a':{
  title:'Tactical ETF (50% SPY 200d trend + 50% dual-momentum top 3)',
  defaults:{trendSymbol:'SPY',smaDays:200,bandPct:1,tbill:'BIL',universe:['SPY','QQQ','IWM','EFA','EEM','VNQ','GLD','DBC'],topN:3,momLookback:252,momSkip:21,fallback:'IEF',trendWeight:0.5},
  bounds:{smaDays:[100,300],bandPct:[0,5],topN:[1,5],momLookback:[63,300],momSkip:[0,42],trendWeight:[0,1]},
 },
 'buy-hold':{title:'Buy and hold SPY (baseline)',defaults:{symbol:'SPY'},bounds:{}},
 'cash':{title:'Cash, 0% (baseline)',defaults:{},bounds:{}},
};
export const DEFAULT_STRATEGY='tactical-a';

export function normalizeParams(id,params={}){
 const s=STRATEGIES[id];if(!s)throw new Error('Unknown strategy '+id);
 const out={...s.defaults};
 for(const [k,[lo,hi]] of Object.entries(s.bounds))if(Number.isFinite(Number(params[k])))out[k]=Math.min(hi,Math.max(lo,Number(params[k])));
 if(Number.isFinite(out.topN))out.topN=Math.round(out.topN);
 return out;
}
export function paramsHash(id,params){return createHash('sha256').update(JSON.stringify({id,params})).digest('hex').slice(0,12)}
export function symbolsFor(id,params){
 if(id==='tactical-a')return [...new Set([params.trendSymbol,params.tbill,params.fallback,...params.universe,'SPY'])];
 return ['SPY'];
}

// Index series: map symbol -> rows d<=asOf (binary-search cut).
function upTo(rows,asOf){if(!rows?.length)return [];let lo=0,hi=rows.length;while(lo<hi){const m=(lo+hi)>>1;if(rows[m].d<=asOf)lo=m+1;else hi=m}return rows.slice(0,lo)}
function sma(rows,n,endIdx){if(endIdx+1<n)return null;let s=0;for(let i=endIdx-n+1;i<=endIdx;i++)s+=rows[i].c;return s/n}
function mom(rows,look,skip){const n=rows.length;if(n<look+1)return null;const a=rows[n-1-look].c,b=rows[n-1-skip].c;return b/a-1}

// Trend sleeve state with hysteresis, replayed deterministically from the first bar with an SMA.
function trendIn(rows,p){
 let state=false,seen=false;
 for(let i=p.smaDays-1;i<rows.length;i++){
  const m=sma(rows,p.smaDays,i);seen=true;
  if(!state&&rows[i].c>m*(1+p.bandPct/100))state=true;
  else if(state&&rows[i].c<m*(1-p.bandPct/100))state=false;
 }
 return seen?state:null;
}
function rotationPicks(bars,asOf,p){
 const tb=upTo(bars[p.tbill],asOf);const hurdle=mom(tb,p.momLookback,p.momSkip);
 const ranked=[];
 for(const s of p.universe){const m=mom(upTo(bars[s],asOf),p.momLookback,p.momSkip);if(m!==null)ranked.push({s,m})}
 if(ranked.length<p.topN||hurdle===null)return null;
 ranked.sort((a,b)=>b.m-a.m||(a.s<b.s?-1:1));
 return ranked.slice(0,p.topN).map(x=>x.m>hurdle?x.s:p.fallback);
}

// Returns {weights:{SYM:w}, ready, reasons[], detail}. Weights sum to 1; CASH is implicit remainder.
export function targetWeights(id,params,bars,asOf){
 const p=normalizeParams(id,params);
 if(id==='cash')return {weights:{},ready:true,reasons:[],detail:{}};
 if(id==='buy-hold'){const ok=upTo(bars[p.symbol],asOf).length>0;return {weights:ok?{[p.symbol]:1}:{},ready:ok,reasons:ok?[]:['no '+p.symbol+' bars'],detail:{}}}
 const reasons=[];const w={};const add=(s,x)=>{if(x>0)w[s]=(w[s]||0)+x};
 const tRows=upTo(bars[p.trendSymbol],asOf);
 const inTrend=trendIn(tRows,p);
 if(inTrend===null)reasons.push(`trend sleeve needs ${p.smaDays} ${p.trendSymbol} bars (have ${tRows.length})`);
 else add(inTrend?p.trendSymbol:p.tbill,p.trendWeight);
 let rebalAt=null;for(let i=tRows.length-1;i>=0;i--){if(isLastOfMonth(tRows[i].d)){rebalAt=tRows[i].d;break}}
 const picks=rebalAt?rotationPicks(bars,rebalAt,p):null;
 if(!picks)reasons.push(`rotation sleeve needs ${p.momLookback+1} bars for every ETF and ${p.tbill}`);
 else for(const s of picks)add(s,(1-p.trendWeight)/p.topN);
 const ready=reasons.length===0;
 return {weights:ready?w:{},ready,reasons,detail:{trend:inTrend===null?null:(inTrend?'IN':'OUT'),sma:tRows.length>=p.smaDays?sma(tRows,p.smaDays,tRows.length-1):null,lastClose:tRows.at(-1)?.c??null,rotationAsOf:rebalAt,picks}};
}
function isLastOfMonth(d){const n=nextSession(d);return !!n&&n.slice(0,7)!==d.slice(0,7)}

// Pure replay: decide at each close, fill at the next session's open with slippage; cash earns 0.
// Ignores T+1 settlement (the live book enforces it). Used for the baseline comparison panel.
export function replay(id,params,bars,{startUsd=1000,slippageBps=2,from=null}={}){
 const p=normalizeParams(id,params);
 const spy=bars.SPY||[];const dates=spy.map(r=>r.d).filter(d=>!from||d>=from);
 const idx={};for(const [s,rows] of Object.entries(bars)){idx[s]=new Map(rows.map(r=>[r.d,r]))}
 let cash=startUsd;const pos={};let trades=0;const curve=[];let pending=null;
 const px=(s,d,k)=>idx[s]?.get(d)?.[k];
 for(const d of dates){
  if(pending){
   const slip=slippageBps/10000;
   const eq=cash+Object.entries(pos).reduce((a,[s,q])=>a+q*(px(s,d,'o')??0),0);
   for(const [s,q] of Object.entries(pos)){const tgt=(pending[s]||0)*eq;const o=px(s,d,'o');if(!o)continue;const cur=q*o;if(cur>tgt+0.01){const sellQ=(cur-tgt)/o;cash+=sellQ*o*(1-slip);pos[s]-=sellQ;trades++;if(pos[s]<1e-9)delete pos[s]}}
   for(const [s,wt] of Object.entries(pending)){const o=px(s,d,'o');if(!o)continue;const cur=(pos[s]||0)*o;const tgt=wt*eq;if(tgt>cur+0.01){const spend=Math.min(cash,tgt-cur);if(spend<=0)continue;pos[s]=(pos[s]||0)+spend/(o*(1+slip));cash-=spend;trades++}}
   pending=null;
  }
  const eqC=cash+Object.entries(pos).reduce((a,[s,q])=>a+q*(px(s,d,'c')??0),0);
  curve.push({d,equityUsd:eqC});
  const t=targetWeights(id,p,bars,d);
  if(t.ready){const eq=eqC;let drift=0;const all=new Set([...Object.keys(pos),...Object.keys(t.weights)]);for(const s of all){const cw=eq>0?((pos[s]||0)*(px(s,d,'c')??0))/eq:0;drift=Math.max(drift,Math.abs(cw-(t.weights[s]||0)))}if(drift>0.02)pending=t.weights}
 }
 return {curve,trades,stats:curveStats(curve)};
}
export function curveStats(curve){
 if(curve.length<2)return {sessions:curve.length,returnPct:null,cagrPct:null,maxDrawdownPct:null,sharpe:null};
 const a=curve[0].equityUsd,b=curve.at(-1).equityUsd;let peak=-Infinity,mdd=0;const rets=[];
 for(let i=0;i<curve.length;i++){const e=curve[i].equityUsd;peak=Math.max(peak,e);mdd=Math.max(mdd,peak>0?1-e/peak:0);if(i)rets.push(e/curve[i-1].equityUsd-1)}
 const years=(curve.length-1)/252;const mean=rets.reduce((x,y)=>x+y,0)/rets.length;const sd=Math.sqrt(rets.reduce((x,y)=>x+(y-mean)**2,0)/Math.max(1,rets.length-1));
 const r=v=>Math.round(v*100)/100;
 return {sessions:curve.length,from:curve[0].d,to:curve.at(-1).d,returnPct:r((b/a-1)*100),cagrPct:years>0?r(((b/a)**(1/years)-1)*100):null,maxDrawdownPct:r(mdd*100),sharpe:sd>0?r(mean/sd*Math.sqrt(252)):null};
}
