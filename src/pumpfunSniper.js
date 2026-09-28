import { cfg } from './config.js';
import { isAggressivePaper } from './runtime.js';
import { estimateAggressivePaperExecution } from './executionSimAggressive.js';

export function createSniper({ perBlockLimit = 1 } = {}) {
  const seen = new Set(), blocks = new Map();
  return function sniperDecision(event, { mode = cfg.mode, runtime = {}, block = event?.slot, sizeSol = runtime?.paperOverrides?.tradeSizeSol || 1 } = {}) {
    if (!isAggressivePaper(runtime, mode)) return { accepted: false, reason: 'aggressive-paper-required' };
    const mint = String(event?.mint || ''); if (!mint) return { accepted: false, reason: 'missing-mint' };
    if (seen.has(mint)) return { accepted: false, reason: 'duplicate-mint' };
    const key = String(block ?? Math.floor(Number(event.ts || Date.now()) / 400));
    const count = blocks.get(key) || 0; if (count >= perBlockLimit) return { accepted: false, reason: 'block-rate-limit' };
    seen.add(mint); blocks.set(key, count + 1);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    while (blocks.size > 128) blocks.delete(blocks.keys().next().value);
    const requestedSizeSol = Math.min(Number(sizeSol) || 0, Number(runtime?.paperOverrides?.maxPositionSol || 3));
    const execution = estimateAggressivePaperExecution(event, requestedSizeSol, Number(event.solUsd || 0));
    return { accepted: true, mode: 'PAPER', shadowOnly: true, mint, requestedSizeSol, execution, priorityFeeLamports: 0, jitoBundle: false,
      note: 'paper launch signal; no transaction submitted' };
  };
}
