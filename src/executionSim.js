import { MarketAdapter, FrictionModel, OrderSimulator, frictionConfigFor } from './core/paperTrading.js';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,Number(x)||0));

// A deliberately pessimistic paper execution model for thin, fast pools.
export function estimatePaperExecution(candidate, sizeSol, solUsd=0, baseSlippageBps=80, feeBps=25) {
  const liqUsd=Math.max(1,Number(candidate?.liq||0));
  const sizeUsd=Math.max(0,Number(sizeSol||0)*Math.max(50,Number(solUsd||0)));
  const impactPct=sizeUsd>0 ? (sizeUsd/liqUsd)*55 : 0;
  const speedPenalty=Math.max(0,Number(candidate?.micro?.p10||0))*2.2 + Math.max(0,Number(candidate?.priceAccel||0))*1.2;
  const thinPenalty=liqUsd<5000 ? (5000/liqUsd-1)*45 : 0;
  const modeledSlippage=Math.round(clamp(baseSlippageBps + impactPct*100 + speedPenalty + thinPenalty, baseSlippageBps, 3500));
  const executionScore=Number(candidate?.executionScore||50);
  const failurePct=clamp((35-executionScore)*.8 + Math.max(0,2500-liqUsd)/120 + speedPenalty/8, 0, 55);
  const modeledLatency=Math.round(clamp(180 + speedPenalty*12 + thinPenalty*4, 120, 2500));
  const adapter=new MarketAdapter({venue:'pumpfun',staleMs:30000}),market=adapter.normalize({symbol:candidate?.mint||candidate?.symbol||'pump',
    bids:[{price:1,quantity:Math.max(liqUsd,sizeUsd,1)}],asks:[{price:1,quantity:Math.max(liqUsd,sizeUsd,1)}],timestamp:0},{now:0});
  const friction=new FrictionModel({venue:'pumpfun',fee:{kind:'bps',bps:Number(feeBps||0)},slippage:{kind:'fixed-bps',bps:modeledSlippage},
    latency:{kind:'fixed',ms:modeledLatency},partialFill:{enabled:false,probability:0,rejectProbability:0},maxStaleMs:30000});
  const sim=new OrderSimulator().simulate({order:{side:'BUY',quantity:Math.max(sizeUsd,1e-9)},market,friction,seed:`pump:${candidate?.mint||''}:${sizeSol}`,now:0});
  return { slippageBps:Math.round(sim.slippageBps), feeBps:Number(feeBps||0), impactPct, failurePct, latencyMs:sim.latencyMs,simulation:'shared-paper-core' };
}

// Runtime Pump.fun PAPER fills use the shared engine end-to-end. The older estimate above stays
// deterministic for historical replay compatibility, while this path owns rejection/partial fills.
export function simulatePumpPaperExecution(candidate,requestedSol,solUsd=0,baseSlippageBps=80,feeBps=25,{side='BUY',now=Date.now(),seed=null}={}){
  const direction=String(side||'BUY').toUpperCase(),budget=Math.max(0,Number(requestedSol||0));
  const solPrice=Math.max(50,Number(solUsd||0)),priceUsd=Number(candidate?.priceUsd||candidate?.price||0);
  if(!['BUY','SELL'].includes(direction)||!(budget>0)||!(priceUsd>0))return {mode:'PAPER',status:'REJECTED',reason:'invalid-pump-order',filledQuantity:0,fillPrice:null,fillPriceUsd:null,gross:0,feeUsd:0,feeSol:0,fillRatio:0};
  const estimate=estimatePaperExecution(candidate,budget,solPrice,baseSlippageBps,feeBps),liqUsd=Math.max(1,Number(candidate?.liq||candidate?.liquidity?.usd||0));
  const priceSol=priceUsd/solPrice,depthQty=Math.max(1e-12,liqUsd/Math.max(priceUsd,1e-12)),observedAt=Number(candidate?.priceObservedAt??candidate?.bookAt??candidate?.timestamp??now);
  const adapter=new MarketAdapter({venue:'pumpfun',staleMs:30000});
  const market=adapter.normalize({symbol:candidate?.mint||candidate?.symbol||'pump',bids:[{price:priceSol,quantity:depthQty}],asks:[{price:priceSol,quantity:depthQty}],timestamp:observedAt,source:'pumpfun-paper'},{now});
  const tuned=frictionConfigFor('pumpfun'),configuredReject=clamp(tuned.partialFill?.rejectProbability,0,1),modelReject=clamp(estimate.failurePct/100,0,1);
  const rejectProbability=1-(1-configuredReject)*(1-modelReject),extraFeeBps=Number(tuned.fee?.kind==='bps'?tuned.fee.bps:0)||0,extraSlipBps=Number(tuned.slippage?.bps||0)||0;
  const latency=tuned.latency?.kind==='fixed'?{kind:'fixed',ms:Math.max(0,estimate.latencyMs+Number(tuned.latency.ms||0))}:{kind:'uniform',minMs:Math.max(0,estimate.latencyMs+Number(tuned.latency?.minMs||0)),maxMs:Math.max(0,estimate.latencyMs+Number(tuned.latency?.maxMs||0))};
  const economicalMin=direction==='BUY'?Math.max(.005,Number(tuned.minNotional||0)):0,minFraction=economicalMin>0?Math.min(1,Math.max(Number(tuned.partialFill?.minFraction||0),economicalMin/budget)):Number(tuned.partialFill?.minFraction||0);
  const friction=new FrictionModel({venue:'pumpfun',fee:{kind:'bps',bps:Number(feeBps||0)+extraFeeBps},slippage:{...tuned.slippage,kind:'fixed-bps',bps:estimate.slippageBps+extraSlipBps},latency,
    partialFill:{...tuned.partialFill,rejectProbability,minFraction,maxFraction:Math.max(minFraction,Number(tuned.partialFill?.maxFraction||minFraction))},minOrderQty:tuned.minOrderQty,minNotional:economicalMin,maxStaleMs:tuned.maxStaleMs,allowDepthPartial:tuned.allowDepthPartial});
  const sim=new OrderSimulator().simulate({order:{side:direction,notional:budget},market,friction,seed:seed??`pump-runtime:${candidate?.mint||candidate?.symbol||''}:${Math.floor(now/8000)}:${direction}`,now,mode:'PAPER'});
  return {...sim,requestedSol:budget,feeSol:Number(sim.feeUsd||0),fillPriceUsd:sim.fillPrice==null?null:sim.fillPrice*solPrice,failurePct:estimate.failurePct,feeBps:Number(feeBps||0)+extraFeeBps,executionModel:'shared-paper-core-v2'};
}

export function deterministicFillAllowed(mint='', ts=Date.now(), failurePct=0) {
  if (failurePct<=0) return true;
  let h=2166136261;
  const str=`${mint}:${Math.floor(ts/8000)}`;
  for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}
  const u=(h>>>0)/4294967295*100;
  return u>=failurePct;
}

// Expected round-trip friction used for research labels. This is intentionally
// pessimistic: both entry and exit pay spread/slippage/fees, and thin pools
// receive an additional expected failed-fill/latency penalty.
export function estimateRoundTripFrictionPct({liquidity=0,executionScore=50,rawReturnPct=0,feeBps=25}={}) {
  const liq=Math.max(1,Number(liquidity||0));
  const execution=clamp(executionScore,0,100);
  const baseSideBps=70;
  const qualitySideBps=(100-execution)*2.2;
  const thinSideBps=liq<25_000?Math.min(1800,Math.max(0,(25_000/liq-1)*28)):0;
  const volatilityExitBps=Math.min(900,Math.max(0,Number(rawReturnPct||0))*1.8);
  const roundTripBps=(baseSideBps+qualitySideBps+thinSideBps+Number(feeBps||0))*2+volatilityExitBps;
  const failurePenaltyPct=Math.min(12,Math.max(0,40-execution)*.08+Math.max(0,5000-liq)/1800);
  return Math.min(40,roundTripBps/100+failurePenaltyPct);
}
