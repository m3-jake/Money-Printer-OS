import { estimatePaperExecution, simulatePumpPaperExecution } from './executionSim.js';
import { equity } from './accounting.js';

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

export function simulatePaperExit(position,pair,solUsd,slippageBps,feeBps,fraction=1,{now=Date.now(),seed=null}={}){
  const requestedFraction=Math.max(0,Math.min(1,Number(fraction||0))),basis=Number(position.remainingSol??position.sizeSol??0)*requestedFraction;
  const priceUsd=Number(pair?.priceUsd||position.lastPrice||0),entryPrice=Number(position.entryPrice||0),valueSol=entryPrice>0?basis*priceUsd/entryPrice:0;
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

// Which dial actually sized the last trade (P1.3). V7 of the audit claimed sizing is risk-based and
// that `tradeSizeSol` is "not binding"; measured at the default profile it is the other way round:
// with 1 SOL of paper equity, `riskPerTradePct` 1 / stop 8 allows 0.125 SOL while the trade-size dial
// asks for max(0.05 * sizeFactor, 0.012 + aggression/1800) = 0.052 SOL, and the position cap (0.15) and
// exposure headroom are looser still. So `tradeSizeSol` binds by default and `riskPerTradePct` only
// becomes the structural limit below about 0.42 SOL of equity (or with a stop far tighter than 8%) --
// which is the number `crossoverEquitySol` reports for whatever profile is actually running.
export const SIZING_DIALS = Object.freeze(['tradeSizeSol', 'riskPerTradePct', 'maxPositionSol', 'maxTotalExposureSol']);
const DIAL_LABELS = Object.freeze({
  tradeSizeSol: 'the trade size dial', riskPerTradePct: 'the risk-per-trade dial',
  maxPositionSol: 'the per-position cap', maxTotalExposureSol: 'the exposure headroom',
});
export function sizingReadout(input = {}) {
  const s = entrySizing(input);
  const config = input.config || {}, agg = Number(input.aggression || 0), stop = Math.max(3, Number(input.stopPct));
  const sprint = Boolean(input.paper && input.sprint);
  const riskRate = (Number(config.riskPerTradePct) / 100) / (stop / 100);           // riskSized per SOL of equity
  const targetRate = input.paper ? (sprint ? .06 : 0.012 + agg / 1800) : 0;         // targetSize per SOL of equity
  const flatTarget = Number(config.tradeSizeSol) * Number(input.sizeFactor ?? 1);
  // riskSized == targetSize happens once, in the range where targetSize is still flat. Beyond that the
  // target grows at `targetRate`: if that is faster than the risk cap, the risk dial never binds.
  const crossoverEquitySol = riskRate > targetRate && flatTarget > 0 ? flatTarget / riskRate : null;
  const dials = [
    { dial: 'tradeSizeSol', value: s.targetSize }, { dial: 'riskPerTradePct', value: s.riskSized },
    { dial: 'maxPositionSol', value: s.positionCap }, { dial: 'maxTotalExposureSol', value: s.headroom },
  ];
  const lowest = Math.min(...dials.map(d => d.value));
  const bound = dials.filter(d => d.value <= lowest + 1e-12);
  const binding = bound.map(d => d.dial), bindingLabels = binding.map(d => DIAL_LABELS[d]);
  const riskBinds = binding.includes('riskPerTradePct');
  return { ...s, dials: dials.map(d => ({ ...d, binding: binding.includes(d.dial), label: DIAL_LABELS[d.dial] })), binding, bindingLabel: bindingLabels.join(' and '),
    riskRatePerSol: riskRate, targetRatePerSol: targetRate, crossoverEquitySol,
    statement: `Size ${s.size.toFixed(4)} SOL is set by ${bindingLabels.join(' and ')}` + (riskBinds ? '.' :
      `; risk sizing would allow ${s.riskSized.toFixed(4)} SOL and only becomes the limit below ${
        crossoverEquitySol === null ? 'any equity (the aggression ramp always sizes smaller)' : crossoverEquitySol.toFixed(4) + ' SOL of equity'}.`) };
}
