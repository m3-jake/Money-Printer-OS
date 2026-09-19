import { estimatePaperExecution } from './executionSim.js';

export function paperExitQuote(position,price,simulation,fraction=1) {
  const basis=Number(position.remainingSol??position.sizeSol??0)*Math.max(0,Math.min(1,fraction));
  const exitPrice=Number(price)*(1-Number(simulation.slippageBps)/10000);
  const gross=basis*exitPrice/Number(position.entryPrice);
  const fee=Math.max(0,gross*Number(simulation.feeBps)/10000);
  const proceeds=Math.max(0,gross-fee);
  const pnlSol=Number(position.realizedSol||0)+proceeds-basis;
  return {basis,exitPrice,fee,proceeds,pnlSol,netReturnPct:pnlSol/Math.max(1e-12,Number(position.sizeSol))*100};
}

export function exitSimulation(position,pair,solUsd,slippageBps,feeBps,fraction=1) {
  const basis=Number(position.remainingSol??position.sizeSol??0)*fraction;
  // Exit impact is based on current sale notional, including any gain or loss.
  const value=basis*Number(pair?.priceUsd||position.lastPrice)/Number(position.entryPrice);
  return estimatePaperExecution({liq:Number(pair?.liquidity?.usd??position.lastLiquidityUsd??0),
    executionScore:Number(position.executionScore||50),micro:position.lastMicro||{},priceAccel:Number(position.lastPriceAccel||0)},
    value,solUsd,slippageBps,feeBps);
}

// A single bad tick cannot create a windfall or a write-off. Paper-only recovery
// of a >95% drop requires three independent refreshes of the exact pool over 15s.
// Upward discontinuities and all live discontinuities remain quarantined.
export function reviewPositionPrice(p,pair,{paper=false,now=Date.now()}={}) {
  const price=Number(pair?.priceUsd),at=Number(pair?.priceObservedAt||now);
  if(!pair||!Number.isFinite(price)||price<=0||pair.baseToken?.address!==p.mint||
    (p.pairAddress&&pair.pairAddress!==p.pairAddress)||now-at>30000||at>now+1000)return {accepted:false,reason:'missing-or-stale-price'};
  const anchor=Number(p.lastPrice||p.entryPrice),ratio=price/anchor;
  if(ratio>=0.05&&ratio<=20){delete p.priceReview;return {accepted:true,price,at};}
  if(!paper||ratio>=0.05||!p.pairAddress)return {accepted:false,reason:'price-discontinuity',ratio};
  const prev=p.priceReview;
  if(!prev||now-prev.lastAt>120000||price/prev.price<0.8||price/prev.price>1.25){
    p.priceReview={price,firstAt:at,lastAt:at,count:1};
  }else if(at>prev.lastAt){
    p.priceReview={price,firstAt:prev.firstAt,lastAt:at,count:prev.count+1};
  }
  const review=p.priceReview;
  if(review.count>=3&&at-review.firstAt>=15000){
    delete p.priceReview;
    return {accepted:true,price,at,corrected:true,ratio,evidence:'three exact-pool refreshes over at least 15 seconds'};
  }
  return {accepted:false,reason:'confirming-price-drop',ratio};
}
