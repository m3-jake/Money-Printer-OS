export const finite = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;

export function tradeRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const trade = row?.trade && typeof row.trade === 'object' ? row.trade : row;
    const pnl = finite(trade?.pnlSol ?? trade?.pnl ?? row?.pnlSol ?? row?.pnl);
    const closedAt = finite(trade?.closedAt ?? row?.closedAt ?? row?.ts);
    if (pnl === null || closedAt === null || closedAt <= 0) return null;
    return { ...trade, pnl, closedAt, strategy: String(trade.strategy ?? row.strategy ?? 'UNKNOWN'),
      signal: String(trade.dominantSignal ?? trade.signal ?? row.dominantSignal ?? row.signal ?? 'UNKNOWN'),
      source: String(trade.signalSource ?? trade.source ?? row.signalSource ?? row.source ?? 'UNKNOWN') };
  }).filter(Boolean).sort((a, b) => a.closedAt - b.closedAt);
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }

export function confidenceInterval(values, z = 1.96) {
  if (!values.length) return { low: null, high: null, confidence: 0.95 };
  const avg = mean(values);
  const variance = values.length > 1 ? values.reduce((s, x) => s + (x - avg) ** 2, 0) / (values.length - 1) : 0;
  const margin = z * Math.sqrt(variance / values.length);
  return { low: avg - margin, high: avg + margin, confidence: 0.95 };
}
