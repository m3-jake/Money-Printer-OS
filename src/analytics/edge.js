import { tradeRows, confidenceInterval, mean } from './shared.js';

export function edgeBySignal(rows = []) {
  const groups = new Map();
  for (const t of tradeRows(rows)) { const arr = groups.get(t.signal) || []; arr.push(t.pnl); groups.set(t.signal, arr); }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([signal, pnls]) => ({ signal, samples: pnls.length, expectancy: mean(pnls), confidenceInterval: confidenceInterval(pnls) }));
}
