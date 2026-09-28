import { estimatePaperExecution, simulatePumpPaperExecution } from './executionSim.js';
import { equity, solFxRatio } from './accounting.js';

export function paperExitQuote(position,price,simulation,fraction=1) {
  const basis=Number(position.remainingSol??position.sizeSol??0)*Math.max(0,Math.min(1,fraction));
  const exitPrice=Number(price)*(1-Number(simulation.slippageBps)/10000);
  const gross=basis*exitPrice/Number(position.entryPrice)*solFxRatio(position,simulation.solUsd);
  const fee=Math.max(0,gross*Number(simulation.feeBps)/10000);
  const proceeds=Math.max(0,gross-fee);
  const pnlSol=Number(position.realizedSol||0)+proceeds-basis;
  return {basis,exitPrice,fee,proceeds,pnlSol,netReturnPct:pnlSol/Math.max(1e-12,Number(position.sizeSol))*100};
}

export function exitSimulation(position,pair,solUsd,slippageBps,feeBps,fraction=1) {
  const basis=Number(position.remainingSol??position.sizeSol??0)*fraction;
  // Exit impact is based on current sale notional, including any gain or loss.
  const value=basis*Number(pair?.priceUsd||position.lastPrice)/Number(position.entryPrice)*solFxRatio(position,solUsd);
  return {...estimatePaperExecution({liq:Number(pair?.liquidity?.usd??position.lastLiquidityUsd??0),
    executionScore:Number(position.executionScore||50),micro:position.lastMicro||{},priceAccel:Number(position.lastPriceAccel||0)},
    value,solUsd,slippageBps,feeBps),solUsd};
}

export function simulatePaperExit(position,pair,solUsd,slippageBps,feeBps,fraction=1,{now=Date.now(),seed=null}={}){
  const requestedFraction=Math.max(0,Math.min(1,Number(fraction||0))),basis=Number(position.remainingSol??position.sizeSol??0)*requestedFraction;
  const priceUsd=Number(pair?.priceUsd||position.lastPrice||0),entryPrice=Number(position.entryPrice||0),valueSol=entryPrice>0?basis*priceUsd/entryPrice*solFxRatio(position,solUsd):0;
  const candidate={mint:position.mint,symbol:position.symbol,priceUsd,priceObservedAt:Number(pair?.priceObservedAt||now),liq:Number(pair?.liquidity?.usd??position.lastLiquidityUsd??0),
    executionScore:Number(position.executionScore||50),micro:position.lastMicro||{},priceAccel:Number(position.lastPriceAccel||0)};
  const sim=simulatePumpPaperExecution(candidate,valueSol,solUsd,slippageBps,feeBps,{side:'SELL',now,seed:seed??`pump-exit:${position.id||position.mint}:${Math.floor(now/8000)}`});
  return {...sim,requestedBasisSol:basis,requestedValueSol:valueSol,requestedFraction,filledBasisSol:basis*Math.max(0,Math.min(1,Number(sim.fillRatio||0)))};
}

// A single bad tick cannot create a windfall or a write-off. Paper-only recovery
// of a >95% drop requires three independent refreshes of the exact pool over 15s.
// Upward discontinuities and all live discontinuities remain quarantined.
// F7 (ACCOUNTING-AUDIT §4 RC-B) — the 0.05..20x anchor window compares each tick only with the
// one before it, so a staircase of sub-20x steps walks the mark anywhere: 1e-5 -> 1.9e-4 -> 1.1e-3
// is a 110x teleport in two "legal" moves. An accepted tick is therefore also banded against the
// MEDIAN of the position's own recent ticks, which no single bad print can move.
//
// The band is deliberately one-sided. Upward discontinuities are what manufacture phantom equity
// (and phantom position size, see F8); genuine crashes keep the existing three-refresh
// corroboration path and are not touched here. The band lifts once the tick history goes stale,
// so a quiet position can never be trapped by an old median.
export const TICK_BAND_MAX_RATIO = 5;
export const TICK_BAND_MIN_TICKS = 4;
export const TICK_BAND_WINDOW = 12;
export const TICK_BAND_MAX_AGE_MS = 10 * 60_000;

export function recentTickMedian(ticks, now = Date.now()) {
  const xs = (Array.isArray(ticks) ? ticks : [])
    .filter(t => t && (now - Number(t.ts ?? now)) <= TICK_BAND_MAX_AGE_MS)
    .map(t => Number(t.price ?? t.priceUsd))
    .filter(x => Number.isFinite(x) && x > 0)
    .slice(-TICK_BAND_WINDOW)
    .sort((a, b) => a - b);
  if (xs.length < TICK_BAND_MIN_TICKS) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function reviewPositionPrice(p,pair,{paper=false,now=Date.now(),ticks=null}={}) {
  const price=Number(pair?.priceUsd),at=Number(pair?.priceObservedAt||now);
  if(!pair||!Number.isFinite(price)||price<=0||pair.baseToken?.address!==p.mint||
    (p.pairAddress&&pair.pairAddress!==p.pairAddress)||now-at>30000||at>now+1000)return {accepted:false,reason:'missing-or-stale-price'};
  const anchor=Number(p.lastPrice||p.entryPrice),ratio=price/anchor;
  if(ratio>=0.05&&ratio<=20){
    const median=recentTickMedian(ticks??p.tickHistory,now);
    if(median!=null&&price>median*TICK_BAND_MAX_RATIO){
      return {accepted:false,reason:'price-outside-tick-band',ratio,median,medianRatio:price/median};
    }
    delete p.priceReview;return {accepted:true,price,at};
  }
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

// ---------------------------------------------------------------------------------------------
// F7(a) / F8 (ACCOUNTING-AUDIT §4 RC-B, RC-C) — entry rails, extracted so they are testable.
// src/index.js is a top-level script (it calls main() on import) and exports nothing, so the
// entry-side arithmetic lives here and index.js calls into it.
// ---------------------------------------------------------------------------------------------

// A paper position with no pool binding accepts a price from ANY pool of that mint
// (reviewPositionPrice only enforces the pair when p.pairAddress is truthy), and index.js
// back-fills pairAddress from the FIRST accepted tick, so it can latch onto the wrong pool
// permanently. The PEG position that produced the 71 SOL book had no pairAddress. Live entries
// already require one.
export const paperEntryRejection = pick => (pick && pick.pairAddress ? null : 'missing-pair-address');

export const openBasisSol = s => (s?.positions || []).reduce((q, p) => q + Number(p?.remainingSol ?? p?.sizeSol ?? 0), 0);

// Marked equity is `cash + Sigma basis * lastPrice/entryPrice`; one bad mark inflated it ~7x and
// the next two fills came out an order of magnitude larger than every other position in the book.
// Paper sizing is bounded by realisable capital -- cash plus cost basis -- so a phantom mark can
// never become phantom risk. Live sizing is NOT routed through this ceiling.
export const paperSizingEquity = s =>
  Math.min(equity(s), Math.max(0, Number(s?.cashSol || 0) + openBasisSol(s)));

export function entrySizing({ state, config, sizeFactor = 1, aggression = 0, stopPct, paper = false, sprint = false }) {
  const sprintPaper = Boolean(paper && sprint);
  const eq = paper ? paperSizingEquity(state) : equity(state);
  const agg = Number(aggression || 0);
  const riskSized = eq * (Number(config.riskPerTradePct) / 100) / (Math.max(3, Number(stopPct)) / 100);
  const paperPositionCap = sprintPaper ? Math.max(config.maxPositionSol, eq * .15) : Math.max(config.maxPositionSol, eq * (0.035 + agg / 2200));
  const paperExposureCap = sprintPaper ? Math.max(config.maxTotalExposureSol, eq * .88) : Math.max(config.maxTotalExposureSol, eq * (0.12 + agg / 330));
  const positionCap = paper ? paperPositionCap : config.maxPositionSol;
  const exposureCap = paper ? paperExposureCap : config.maxTotalExposureSol;
  const headroom = Math.max(0, exposureCap - openBasisSol(state));
  const targetSize = sprintPaper ? Math.max(config.tradeSizeSol * sizeFactor, eq * .06)
    : paper ? Math.max(config.tradeSizeSol * sizeFactor, eq * (0.012 + agg / 1800))
    : config.tradeSizeSol * sizeFactor;
  const size = Math.max(0, Math.min(targetSize, positionCap, riskSized, headroom));
  return { eq, markedEquity: equity(state), riskSized, positionCap, exposureCap, headroom, targetSize, size };
}
