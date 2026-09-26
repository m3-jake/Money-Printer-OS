// Performance of settled Polymarket US combos, computed from the combo journal only.
// Implied probability is the fill price paid per contract (a $1 payout). Nothing is
// extrapolated: with no settled combos every rate is null, never 0%.
const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r4 = v => (v === null ? null : Math.round(v * 10000) / 10000);

// Wilson score interval for a binomial rate (95% by default).
export function wilson(successes, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = successes / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { low: r4(Math.max(0, (c - m) / d)), high: r4(Math.min(1, (c + m) / d)) };
}

export function comboPerformance(history = [], open = [], { bucket = 0.05 } = {}) {
  const rows = Array.isArray(history) ? history : [], live = Array.isArray(open) ? open : [];
  const decided = rows.filter(x => (x.status === 'WON' || x.status === 'LOST') && num(x.pnlUsd) !== null);
  const won = decided.filter(x => x.status === 'WON').length, n = decided.length;
  const priced = decided.filter(x => num(x.fillPrice) !== null && num(x.fillPrice) > 0 && num(x.fillPrice) < 1);
  const net = decided.reduce((s, x) => s + num(x.pnlUsd), 0);
  const cost = decided.every(x => num(x.costUsd) !== null) ? decided.reduce((s, x) => s + num(x.costUsd), 0) : null;
  const winRate = n ? won / n : null;
  const avgImplied = priced.length ? priced.reduce((s, x) => s + num(x.fillPrice), 0) / priced.length : null;
  const ordered = [...decided].sort((a, b) => (num(a.settledAt) ?? 0) - (num(b.settledAt) ?? 0));
  const curve = []; let acc = 0;
  for (const x of ordered.slice(-300)) { acc += num(x.pnlUsd); curve.push(Math.round(acc * 100) / 100); }
  const buckets = new Map();
  for (const x of priced) {
    const lo = Math.floor(num(x.fillPrice) / bucket) * bucket, key = lo.toFixed(2);
    const b = buckets.get(key) || { lo: r4(lo), hi: r4(lo + bucket), n: 0, won: 0, impliedSum: 0 };
    b.n++; b.won += x.status === 'WON' ? 1 : 0; b.impliedSum += num(x.fillPrice); buckets.set(key, b);
  }
  const openCost = live.every(x => num(x.costUsd ?? x.stakeUsd) !== null) ? live.reduce((s, x) => s + num(x.costUsd ?? x.stakeUsd), 0) : null;
  return {
    placed: rows.length + live.length, settled: n, won, lost: n - won, open: live.length,
    unverifiedOpen: live.filter(x => x.fillVerified !== true).length, openCostUsd: openCost === null ? null : Math.round(openCost * 100) / 100,
    netPnlUsd: n ? Math.round(net * 100) / 100 : null, costUsd: cost === null ? null : Math.round(cost * 100) / 100,
    roiPct: cost ? r4(net / cost * 100) : null,
    winRate: r4(winRate), winRateCi95: wilson(won, n), avgImplied: r4(avgImplied),
    // Realized minus implied. Positive means combos won more often than their prices implied.
    edge: winRate !== null && avgImplied !== null && priced.length === n ? r4(winRate - avgImplied) : null,
    curve, calibration: [...buckets.values()].sort((a, b) => a.lo - b.lo).map(b => ({ lo: b.lo, hi: b.hi, n: b.n, implied: r4(b.impliedSum / b.n), winRate: r4(b.won / b.n) })),
    sampleNote: n < 30 ? `Only ${n} settled combo(s); rates are not yet meaningful.` : null,
  };
}
