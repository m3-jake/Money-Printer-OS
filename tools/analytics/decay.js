import { tradeRows, mean } from '../../src/analytics/shared.js';

export function edgeDecay(rows = [], { window = 20, dropThreshold = 0.5 } = {}) {
  const groups = new Map();
  for (const t of tradeRows(rows)) { const arr = groups.get(t.signal) || []; arr.push(t); groups.set(t.signal, arr); }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([signal, ts]) => {
    const pnls = ts.map(t => t.pnl), recent = pnls.slice(-window), prior = pnls.slice(Math.max(0, pnls.length - window * 2), Math.max(0, pnls.length - window));
    const baseline = mean(prior), current = mean(recent), droppedPct = baseline > 0 && current !== null ? (baseline - current) / baseline : null;
    return { signal, samples: pnls.length, windowSamples: recent.length, expectancy: current, baselineExpectancy: baseline, droppedPct,
      decayed: droppedPct !== null && droppedPct > dropThreshold };
  });
}
