import { cfg } from './config.js';

export function isAggressivePaper(runtime, mode = cfg.mode) { return mode === 'paper' && String(runtime?.profile || '').toUpperCase() === 'AGGRESSIVE_PAPER'; }

export function halfKelly({ expectancy = 0, variance = 0, equity = 0, floor = 0.005, ceiling = 0.15, maxFraction = 0.25 } = {}) {
  const e = Number(expectancy), v = Number(variance), eq = Number(equity);
  const kelly = v > 0 ? Math.max(0, e / v) : 0;
  const half = Math.min(Math.max(0, maxFraction), kelly / 2);
  const raw = eq * half, size = eq > 0 && raw > 0 ? Math.max(floor, Math.min(ceiling, raw)) : 0;
  return { expectancy: e, variance: v, equity: eq, kelly, halfKellyFraction: half, floor, ceiling, finalSize: size };
}

export function sizeFromEdge({ runtime, mode = cfg.mode, expectancy, variance, equity, floor, ceiling, logger = () => {} } = {}) {
  if (!isAggressivePaper(runtime, mode)) return { enabled: false, reason: 'aggressive-paper-required', finalSize: null };
  const decision = { enabled: true, ...halfKelly({ expectancy, variance, equity, floor, ceiling }) };
  logger({ type: 'sizing-decision', mode: 'PAPER', profile: 'AGGRESSIVE_PAPER', ...decision });
  return decision;
}

export function splitTranches(total, { threshold = 0.25, clips = 3, intervalMs = 5000 } = {}) {
  const size = Math.max(0, Number(total) || 0), n = Math.max(2, Math.min(4, Math.round(clips)));
  if (size <= threshold) return [{ sizeSol: size, delayMs: 0 }];
  const each = size / n;
  return Array.from({ length: n }, (_, i) => ({ sizeSol: i === n - 1 ? size - each * (n - 1) : each, delayMs: i * Math.max(0, intervalMs) }));
}
// Ledger history is oldest-first; callers must not depend on physical array order.
export function recentClosedReturns(rows = [], limit = 40, { now = Date.now() } = {}) {
  const n = Math.max(0, Math.min(5000, Math.trunc(Number(limit) || 0)));
  return (Array.isArray(rows) ? rows : []).filter(t => t && t.returnPct != null && t.returnPct !== '' && typeof t.returnPct !== 'boolean'
    && Number.isFinite(Number(t.returnPct)) && Number(t.closedAt) > 0 && Number(t.closedAt) <= now
    && String(t.pnlMode || t.mode || 'PAPER').toUpperCase() !== 'LIVE')
    .sort((a,b) => Number(b.closedAt)-Number(a.closedAt)).slice(0,n).map(t => Number(t.returnPct)/100);
}
