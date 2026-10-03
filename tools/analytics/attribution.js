import { tradeRows, mean } from '../../src/analytics/shared.js';

export function attributePnl(rows = []) {
  const groups = new Map();
  for (const t of tradeRows(rows)) { const group = groups.get(t.source) || { source: t.source, tradeCount: 0, pnl: 0, wins: 0 }; group.tradeCount++; group.pnl += t.pnl; if (t.pnl > 0) group.wins++; groups.set(t.source, group); }
  return [...groups.values()].sort((a, b) => a.source.localeCompare(b.source)).map(x => ({ ...x, expectancy: mean(tradeRows(rows).filter(t => t.source === x.source).map(t => t.pnl)), winRate: x.wins / x.tradeCount }));
}
