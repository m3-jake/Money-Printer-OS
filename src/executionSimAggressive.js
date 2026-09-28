import { isAggressivePaper } from './runtime.js';
import { MarketAdapter, FrictionModel, OrderSimulator } from './core/paperTrading.js';

export const AGGRESSIVE_PAPER_EXECUTION = Object.freeze({ baseSlippageBps: 20, feeBps: 10, failurePctMax: 5 });
export function estimateAggressivePaperExecution(candidate = {}, sizeSol = 0, solUsd = 0) {
  const liquidity = Math.max(1, Number(candidate.liq || candidate.liquidity?.usd || 0));
  const notional = Math.max(0, Number(sizeSol) * Math.max(50, Number(solUsd)));
  const slippageBps = Math.min(3500, 20 + notional / liquidity * 5500);
  return { slippageBps: Math.round(slippageBps), feeBps: 10, failurePct: Math.min(5, Math.max(0, 35 - Number(candidate.executionScore || 50)) * 0.1), latencyMs: 150, executionModel: 'AGGRESSIVE_PAPER' };
}

export function estimateRoutedPaperExecution(candidate, sizeSol, solUsd, runtime, mode, pessimisticEstimator) {
  const pessimistic = pessimisticEstimator(candidate, sizeSol, solUsd);
  if (!isAggressivePaper(runtime, mode)) return { selected: pessimistic, pessimistic, aggressive: null, deltaBps: null };
  const aggressive = estimateAggressivePaperExecution(candidate, sizeSol, solUsd);
  return { selected: aggressive, pessimistic, aggressive, deltaBps: aggressive.slippageBps - Number(pessimistic.slippageBps || 0) };
}

// Independent paper fill model. It deliberately bypasses the shared venue friction profile,
// whose additional speed/thin penalties are meant for pessimistic/default paper runs.
export function simulateAggressivePaperExecution(candidate, requestedSol, solUsd = 0, { side = 'BUY', now = Date.now(), seed = null } = {}) {
  const direction=String(side).toUpperCase(), budget=Math.max(0,Number(requestedSol)||0), px=Number(candidate?.priceUsd||candidate?.price||0);
  const liquidity=Math.max(0,Number(candidate?.liq||candidate?.liquidity?.usd||0)), solPrice=Math.max(50,Number(solUsd)||0);
  if(!['BUY','SELL'].includes(direction)||!(budget>0)||!(px>0)||!(liquidity>0)) return {mode:'PAPER',status:'REJECTED',reason:'invalid-market-or-order',gross:0,feeSol:0,fillRatio:0,filledQuantity:0};
  const estimate=estimateAggressivePaperExecution(candidate,budget,solPrice), priceSol=px/solPrice, depthQty=Math.max(1e-12,liquidity/px);
  const adapter=new MarketAdapter({venue:'pumpfun',staleMs:30000});
  const market=adapter.normalize({symbol:candidate?.mint||candidate?.symbol||'pump',bids:[{price:priceSol,quantity:depthQty}],asks:[{price:priceSol,quantity:depthQty}],timestamp:Number(candidate.priceObservedAt||candidate.bookAt||now)},{now});
  const friction=new FrictionModel({venue:'pumpfun',fee:{kind:'bps',bps:estimate.feeBps},slippage:{kind:'fixed-bps',bps:estimate.slippageBps},latency:{kind:'fixed',ms:estimate.latencyMs},partialFill:{enabled:false,probability:0,rejectProbability:estimate.failurePct/100},maxStaleMs:30000});
  const sim=new OrderSimulator().simulate({order:{side:direction,notional:budget},market,friction,seed:seed||`aggressive-paper:${candidate?.mint||''}:${Math.floor(now/8000)}:${direction}`,now,mode:'PAPER'});
  if(direction==='BUY'&&sim.gross>0){const gross=Math.min(budget,budget*Number(sim.fillRatio||0)),scale=gross/sim.gross;sim.filledQuantity*=scale;sim.feeUsd*=scale;sim.gross=gross;sim.fills=(sim.fills||[]).map(f=>({...f,quantity:Number(f.quantity||0)*scale}));}
  sim.orderSubmittedAt=now;sim.fillAt=now+Math.max(0,Number(sim.latencyMs||0));
  return {...sim,requestedSol:budget,feeSol:Number(sim.feeUsd||0),feeBps:estimate.feeBps,failurePct:estimate.failurePct,executionModel:'AGGRESSIVE_PAPER_V1',evidenceState:'MODELED_NOT_EXECUTABLE_RECEIPT'};
}
