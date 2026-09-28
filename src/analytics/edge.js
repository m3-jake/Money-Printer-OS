/** Pure Phase 0 statistics. Inputs are completed, net-of-cost trades in ONE currency. */
export const DAY_MS = 86_400_000;
export function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function timestamp(value) {
  const n = finite(value);
  if (n !== null) return n > 0 ? n : null;
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t > 0 ? t : null;
}
export function average(values) {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
}
export function sampleDeviation(values) {
  if (values.length < 2) return null;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (values.length - 1));
}
// Non-annualized excess-return mean / sample SD. Never sqrt(N)-scale trade returns.
// Definition: William F. Sharpe (1994), https://web.stanford.edu/~wfsharpe/art/sr/sr.htm
export function sharpe(returns, riskFreePerPeriod = 0) {
  if (returns.some(n => finite(n) === null)) return null;
  const excess = returns.map(n => n - riskFreePerPeriod), sd = sampleDeviation(excess);
  return sd > 0 ? average(excess) / sd : null;
}

/** Absolute peak-to-trough decline; percent requires a known positive starting capital. */
export function drawdown(curve, startingCapital = null) {
  let peak = finite(startingCapital) ?? 0, amount = 0, pct = null;
  const knownCapital = finite(startingCapital) > 0;
  for (const value of curve) {
    if (finite(value) === null) continue;
    peak = Math.max(peak, value);
    amount = Math.max(amount, peak - value);
    if (knownCapital && peak > 0) pct = Math.max(pct ?? 0, (peak - value) / peak * 100);
  }
  return { amount, pct: knownCapital ? pct ?? 0 : null };
}
/** Rolling hourly REALIZED-only proxy, not marked portfolio Sharpe or a live-readiness test. */
export function realizedSharpe(trades, { start, end, startingCapital, periods = 24, periodMs = 3_600_000 } = {}) {
  if (!(finite(startingCapital) > 0) || !(end > start)) return { value: null, samples: 0, reason: 'unknown capital or observation window' };
  const first = Math.ceil(start / periodMs) * periodMs, last = Math.floor(end / periodMs) * periodMs;
  if ((last - first) / periodMs > 100_000) throw new Error('Observation window exceeds 100000 periods');
  let equity = startingCapital, previous = null, index = 0;
  const returns = [], ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  for (let at = first; at <= last; at += periodMs) {
    while (index < ordered.length && ordered[index].closedAt <= at) equity += ordered[index++].pnl;
    if (previous !== null) returns.push(previous > 0 ? equity / previous - 1 : null);
    previous = equity;
  }
  const sample = returns.slice(-periods), value = sample.length >= 3 && !sample.includes(null) ? sharpe(sample) : null;
  return { value, samples: sample.length, reason: value === null ? 'fewer than 3 full periods, nonpositive capital, or zero variance' : null,
    periodMs, rollingPeriods: periods, annualized: false, benchmarkPerPeriod: 0, kind: 'realized-only proxy' };
}

export function summarizeTrades(trades, options = {}) {
  const valid = trades.filter(t => finite(t.pnl) !== null && timestamp(t.closedAt) !== null && !t.censored).map(t => ({ ...t, pnl: finite(t.pnl), closedAt: timestamp(t.closedAt), openedAt: timestamp(t.openedAt) }));
  const units = new Set(valid.map(t => t.currency).filter(Boolean));
  if (units.size > 1) throw new Error('Cannot combine currencies');
  const ordered = [...valid].sort((a, b) => a.closedAt - b.closedAt || String(a.id).localeCompare(String(b.id)));
  const pnl = ordered.map(t => t.pnl), wins = pnl.filter(n => n > 0), losses = pnl.filter(n => n < 0);
  const start = options.start ?? (ordered.length ? Math.min(...ordered.map(t => t.openedAt ?? t.closedAt)) : null);
  const end = options.end ?? ordered.at(-1)?.closedAt ?? null;
  const capital = finite(options.startingCapital), curve = [];
  let running = capital ?? 0;
  for (const value of pnl) { running += value; curve.push(running); }
  const dd = drawdown(curve, capital), rolling = realizedSharpe(ordered, { ...options, start, end, startingCapital: capital });
  const total = pnl.reduce((sum, n) => sum + n, 0), winSum = wins.reduce((sum, n) => sum + n, 0);
  const top = [...wins].sort((a, b) => b - a), returns = ordered.filter(t => t.basis > 0).map(t => t.pnl / t.basis);
  return { tradeCount: ordered.length, sampleCount: ordered.length, excludedCount: trades.length - ordered.length,
    wins: wins.length, losses: losses.length, breakeven: pnl.filter(n => n === 0).length,
    winRate: ordered.length ? wins.length / ordered.length : null, expectancy: average(pnl), avgWin: average(wins), avgLoss: average(losses),
    totalPnl: total, maxDrawdown: ordered.length ? dd.amount : null, maxDrawdownPct: ordered.length ? dd.pct : null, drawdownKind: 'closed-trade net-PnL curve; open risk excluded',
    rollingSharpe: rolling.value, sharpeDetails: rolling, daysObserved: start !== null && end >= start ? (end - start) / DAY_MS : null,
    returnSampleCount: returns.length, meanNetReturnPct: returns.length ? average(returns) * 100 : null,
    profitFactor: losses.length ? winSum / -losses.reduce((sum, n) => sum + n, 0) : null,
    bestTradePnl: top[0] ?? null, pnlExcludingBestTrade: total - (top[0] ?? 0),
    top3ShareOfGrossWins: winSum ? top.slice(0, 3).reduce((sum, n) => sum + n, 0) / winSum : null,
    observationStart: start, observationEnd: end };
}
