// Shared PAPER/BACKTEST execution primitives. This module has no network or signing imports.
const finite=(v,d=null)=>{const n=Number(v);return Number.isFinite(n)?n:d};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,finite(v,a)));
const upper=v=>String(v||'').trim().toUpperCase();
const envNumber=(env,key,fallback)=>{const n=Number(env?.[key]);return Number.isFinite(n)?n:fallback};
const safeVenue=v=>upper(v).replace(/[^A-Z0-9]+/g,'_')||'GENERIC';

function hash32(value=''){
 let h=2166136261;
 for(const c of String(value)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}
 return h>>>0;
}
export function seededRandom(seed='paper'){
 let s=hash32(seed)||1;
 return ()=>{s=(Math.imul(1664525,s)+1013904223)>>>0;return s/4294967296};
}
const levelsOf=(rows,desc=false)=>(Array.isArray(rows)?rows:[])
 .map(x=>({price:finite(x?.price),quantity:finite(x?.quantity??x?.qty??x?.size)}))
 .filter(x=>x.price>0&&x.quantity>0).sort((a,b)=>desc?b.price-a.price:a.price-b.price);

export class MarketAdapter {
 constructor({venue='generic',staleMs=30000,syntheticDepthUsd=0}={}){
  this.venue=String(venue);this.staleMs=Math.max(1,finite(staleMs,30000));this.syntheticDepthUsd=Math.max(0,finite(syntheticDepthUsd,0));
 }
 normalize(raw={}, {now=Date.now(),symbol=null}={}){
  let bids=levelsOf(raw?.depth?.bids??raw?.bids,true),asks=levelsOf(raw?.depth?.asks??raw?.asks,false);
  const bid=finite(raw.bid??raw.bestBid??bids[0]?.price),ask=finite(raw.ask??raw.bestAsk??asks[0]?.price);
  if(!bids.length&&bid>0&&this.syntheticDepthUsd>0)bids=[{price:bid,quantity:this.syntheticDepthUsd/bid}];
  if(!asks.length&&ask>0&&this.syntheticDepthUsd>0)asks=[{price:ask,quantity:this.syntheticDepthUsd/ask}];
  const timestamp=finite(raw.timestamp??raw.providerTimestamp??raw.observedAt??raw.at,now);
  const receivedAt=finite(raw.receivedAt??raw.observedAt??raw.at,now);
  const ageMs=Math.max(0,now-timestamp);
  return {venue:this.venue,symbol:String(symbol??raw.symbol??raw.instrumentId??''),bid:bid??bids[0]?.price??null,
   ask:ask??asks[0]?.price??null,last:finite(raw.last??raw.lastTrade??raw.price),depth:{bids,asks},timestamp,receivedAt,
   ageMs,stale:timestamp>now+1000||ageMs>this.staleMs,staleMs:this.staleMs,source:raw.source||null,rawMeta:raw.meta||null};
 }
}

export class FrictionModel {
 constructor(config={}){
  this.venue=String(config.venue||'generic');
  this.fee={kind:'bps',bps:0,...(config.fee||{})};
  this.slippage={kind:'fixed-bps',bps:0,...(config.slippage||{})};
  this.latency={kind:'uniform',minMs:0,maxMs:0,...(config.latency||{})};
  this.partialFill={enabled:true,probability:0,rejectProbability:0,minFraction:.35,maxFraction:.9,...(config.partialFill||{})};
  this.minOrderQty=Math.max(0,finite(config.minOrderQty,0));
  this.minNotional=Math.max(0,finite(config.minNotional,0));
  this.maxStaleMs=Math.max(1,finite(config.maxStaleMs,30000));
  this.allowDepthPartial=config.allowDepthPartial!==false;
 }
 latencyMs(rand=Math.random){
  if(this.latency.kind==='fixed')return Math.max(0,Math.round(finite(this.latency.ms,this.latency.minMs||0)));
  const lo=Math.max(0,finite(this.latency.minMs,0)),hi=Math.max(lo,finite(this.latency.maxMs,lo));
  return Math.round(lo+(hi-lo)*rand());
 }
 extraSlippageBps(context={}){
  const s=this.slippage;
  if(typeof s.bpsFor==='function')return Math.max(0,finite(s.bpsFor(context),0));
  const latencyBps=Math.max(0,finite(s.latencyBpsPerSecond,0))*Math.max(0,finite(context.latencyMs,0))/1000;
  if(s.kind==='curve'){
   const notional=Math.max(0,finite(context.notional,0)),liq=Math.max(1,finite(context.liquidityUsd,s.liquidityUsd||1));
   const power=Math.max(.25,finite(s.power,1)),scale=Math.max(0,finite(s.scaleBps,10000));
   return Math.max(0,finite(s.bps,0)+scale*Math.pow(notional/liq,power)+latencyBps);
  }
  return Math.max(0,finite(s.bps,0)+latencyBps);
 }
 feeUsd({gross=0,quantity=0,price=0,fills=[]}={}){
  const f=this.fee;if(typeof f.compute==='function')return Math.max(0,finite(f.compute({gross,quantity,price,fills}),0));
  if(f.kind==='flat')return Math.max(0,finite(f.usd,0));
  if(f.kind==='per-contract')return Math.max(0,finite(f.usd,0)*quantity);
  const bps=f.kind==='percent'?finite(f.percent,0)*100:finite(f.bps,0);
  return Math.max(0,gross*bps/10000);
 }
}

export function frictionConfigFor(venue,{env=process.env,overrides={}}={}){
 const key=safeVenue(venue),get=(name,fallback)=>envNumber(env,`MPO_PAPER_${key}_${name}`,fallback);
 const defaults={
  fee:{kind:'bps',bps:get('FEE_BPS',0)},slippage:{kind:'fixed-bps',bps:get('SLIPPAGE_BPS',0),latencyBpsPerSecond:get('LATENCY_SLIPPAGE_BPS_PER_SECOND',0)},
  latency:{kind:'uniform',minMs:get('LATENCY_MIN_MS',100),maxMs:get('LATENCY_MAX_MS',600)},
  partialFill:{enabled:true,probability:get('PARTIAL_PROBABILITY',0),rejectProbability:get('REJECT_PROBABILITY',0),
   minFraction:get('PARTIAL_MIN_FRACTION',0.35),maxFraction:get('PARTIAL_MAX_FRACTION',0.9)},
  minOrderQty:get('MIN_ORDER_QTY',0),minNotional:get('MIN_NOTIONAL',0),maxStaleMs:get('STALE_MS',30000),allowDepthPartial:true
 };
 return new FrictionModel({...defaults,...overrides,venue,fee:{...defaults.fee,...overrides.fee},
  slippage:{...defaults.slippage,...overrides.slippage},latency:{...defaults.latency,...overrides.latency},
  partialFill:{...defaults.partialFill,...overrides.partialFill}});
}
function walkQuantity(levels,quantity){
 let remain=quantity,filled=0,gross=0;const fills=[];
 for(const l of levels){if(remain<=1e-12)break;const take=Math.min(remain,l.quantity);if(take<=0)continue;
  filled+=take;gross+=take*l.price;fills.push({price:l.price,quantity:take});remain-=take}
 return {filled,gross,fills,complete:remain<=1e-9};
}
function walkNotional(levels,budget){
 let remain=budget,filled=0,gross=0;const fills=[];
 for(const l of levels){if(remain<=1e-9)break;const take=Math.min(l.quantity,remain/l.price);if(take<=0)continue;
  const cost=take*l.price;filled+=take;gross+=cost;fills.push({price:l.price,quantity:take});remain-=cost}
 return {filled,gross,fills,complete:remain<=1e-7};
}
const rejected=(reason,base={})=>({mode:'PAPER',status:'REJECTED',reason,filledQuantity:0,fillPrice:null,feeUsd:0,gross:0,...base});

export class OrderSimulator {
 simulate({order={},market,friction=new FrictionModel(),seed=null,now=Date.now(),mode='PAPER'}={}){
  const simMode=upper(mode||'PAPER');
  if(!['PAPER','BACKTEST'].includes(simMode))throw new Error('OrderSimulator is simulation-only');
  const reject=(reason,base={})=>rejected(reason,{mode:simMode,...base});
  if(!market||typeof market!=='object')return reject('missing-market');
  const side=upper(order.side);if(!['BUY','SELL'].includes(side))return reject('invalid-side');
  const ageMs=Math.max(0,now-finite(market.timestamp,now));
  if(market.stale||ageMs>friction.maxStaleMs||finite(market.timestamp,now)>now+1000)return reject('stale-market',{ageMs});
  const levels=side==='BUY'?levelsOf(market.depth?.asks,false):levelsOf(market.depth?.bids,true);
  if(!levels.length)return reject('no-executable-depth');
  const requestedQuantity=finite(order.quantity),requestedNotional=finite(order.notionalUsd??order.notional);
  if(!(requestedQuantity>0)&&!(requestedNotional>0))return reject('invalid-size');
  const top=levels[0].price,nominal=requestedNotional>0?requestedNotional:requestedQuantity*top;
  if(requestedQuantity>0&&requestedQuantity<friction.minOrderQty)return reject('below-min-quantity');
  if(nominal<friction.minNotional)return reject('below-min-notional');
  const rand=seededRandom(seed??`${market.venue}:${market.symbol}:${market.timestamp}:${side}:${requestedQuantity??requestedNotional}`);
  const latencyMs=friction.latencyMs(rand);
  if(rand()<clamp(friction.partialFill.rejectProbability,0,1))return reject('simulated-no-fill',{latencyMs});
  let fraction=1;
  if(friction.partialFill.enabled&&rand()<clamp(friction.partialFill.probability,0,1)){
   const lo=clamp(friction.partialFill.minFraction,.01,1),hi=clamp(friction.partialFill.maxFraction,lo,1);fraction=lo+(hi-lo)*rand();
  }
 const walked=requestedNotional>0?walkNotional(levels,requestedNotional*fraction):walkQuantity(levels,requestedQuantity*fraction);
 if(!(walked.filled>0))return reject('no-fill',{latencyMs});
 const depthComplete=walked.complete,fractional=fraction<.999999;
 if(!depthComplete&&!friction.allowDepthPartial)return reject('insufficient-depth',{latencyMs,availableQuantity:walked.filled});
 const basePrice=walked.gross/walked.filled;
 const liquidityUsd=levels.reduce((s,l)=>s+l.price*l.quantity,0);
 const extraBps=friction.extraSlippageBps({order,market,notional:walked.gross,liquidityUsd,basePrice,filledQuantity:walked.filled,latencyMs});
 const fillPrice=Math.max(1e-12,basePrice*(side==='BUY'?1+extraBps/10000:1-extraBps/10000));
 const gross=fillPrice*walked.filled;
 const feeUsd=friction.feeUsd({gross,quantity:walked.filled,price:fillPrice,fills:walked.fills});
 const bookBps=top>0?Math.abs(basePrice/top-1)*10000:0;
 const status=(!depthComplete||fractional)?'PARTIAL':'FILLED';
 return {mode:simMode,status,reason:status==='PARTIAL'?(depthComplete?'simulated-partial':'depth-partial'):null,venue:market.venue,
  symbol:market.symbol,side,requestedQuantity:requestedQuantity??(requestedNotional/top),requestedNotionalUsd:requestedNotional,
  filledQuantity:walked.filled,fillRatio:requestedQuantity>0?walked.filled/requestedQuantity:walked.gross/requestedNotional,
  fillPrice,gross,feeUsd,slippageBps:bookBps+extraBps,bookSlippageBps:bookBps,extraSlippageBps:extraBps,
  latencyMs,signalAt:market.timestamp,fillAt:market.timestamp+latencyMs,quoteAgeMs:ageMs,liquidityUsd,fills:walked.fills};
 }
}

export class PortfolioTracker {
 constructor({mode='PAPER',cash=0,load=null,save=null}={}){
  const normalizedMode=upper(mode||'PAPER');
  if(!['PAPER','BACKTEST'].includes(normalizedMode))throw new Error('PortfolioTracker is simulation-only');
  this.mode=normalizedMode;this.saveFn=typeof save==='function'?save:null;
  const prior=typeof load==='function'?load():null;
  this.state=prior&&typeof prior==='object'?prior:{cash:finite(cash,0),realizedPnl:0,fees:0,positions:{}};
 }
 applyFill(fill,{instrumentId=fill?.symbol||'unknown'}={}){
  if(!fill||!['FILLED','PARTIAL'].includes(fill.status)||fill.mode!==this.mode)return this.snapshot();
  const p=this.state.positions[instrumentId]||{quantity:0,costBasis:0};
  const q=finite(fill.filledQuantity,0),gross=finite(fill.gross,0),fee=finite(fill.feeUsd,0);
  if(fill.side==='BUY'){p.quantity+=q;p.costBasis+=gross+fee;this.state.cash-=gross+fee}
  else{
   if(q>p.quantity+1e-9)throw new Error('PortfolioTracker oversell');
   const basis=p.quantity>0?p.costBasis*(q/p.quantity):0;
   p.quantity-=q;p.costBasis-=basis;this.state.cash+=gross-fee;this.state.realizedPnl+=gross-fee-basis;
  }
  this.state.fees+=fee;this.state.positions[instrumentId]=p;
  if(this.saveFn)this.saveFn(structuredClone(this.state));
  return this.snapshot();
 }
 snapshot(){
  return {mode:this.mode,pnlLabel:this.mode,cash:this.state.cash,realizedPnl:this.state.realizedPnl,fees:this.state.fees,
   positions:Object.entries(this.state.positions).filter(([,p])=>p.quantity>1e-12)
    .map(([instrumentId,p])=>({instrumentId,quantity:p.quantity,costBasis:p.costBasis,averageCost:p.quantity?p.costBasis/p.quantity:null}))};
 }
}
