import { isAggressivePaper } from './runtime.js';

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
