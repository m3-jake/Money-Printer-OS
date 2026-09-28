import { summarizeTrades } from './edge.js';

/** One observed dominant signal per trade; association, NOT causal attribution. */
export function signalAtEntry(trade, byMint, maxAgeMs = 30_000) {
  if (typeof trade.dominantSignal === 'string' && trade.dominantSignal.trim())
    return { signalSource: trade.dominantSignal, method: 'recorded-on-trade', lagMs: 0 };
  const rows = byMint.get(trade.mint) || [];
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].ts <= trade.openedAt) lo = mid + 1; else hi = mid; }
  const row = rows[lo - 1], age = row ? trade.openedAt - row.ts : null;
  if (!row || age < 0 || age > maxAgeMs || typeof row.dominantSignal !== 'string' || !row.dominantSignal.trim())
    return { signalSource: 'UNKNOWN', method: 'missing-or-stale-entry-evidence', lagMs: age };
  return { signalSource: row.dominantSignal, method: 'as-of-candidate', lagMs: age };
}
export function groupMetrics(trades, key, options = {}) {
  const groups = new Map();
  for (const trade of trades) {
    const value = key(trade), compound = JSON.stringify([trade.currency, value]);
    if (!groups.has(compound)) groups.set(compound, { currency: trade.currency, strategyId: value, trades: [] });
    groups.get(compound).trades.push(trade);
  }
  return [...groups.values()].map(({ trades: rows, ...group }) => ({ ...group, ...summarizeTrades(rows, options) }));
}
export function attributeSignals(trades) {
  const rows = groupMetrics(trades, t => t.signalSource || 'UNKNOWN');
  return { method: 'single dominant signal; no multi-signal double counting; not causal', rows,
    unknownTradeCount: trades.filter(t => !t.signalSource || t.signalSource === 'UNKNOWN').length,
    totalsByCurrency: Object.fromEntries([...new Set(trades.map(t => t.currency))].map(currency => [currency,
      rows.filter(r => r.currency === currency).reduce((sum, r) => sum + r.totalPnl, 0)])) };
}
