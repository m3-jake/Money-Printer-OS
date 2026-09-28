import { narrative } from './intelligence.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
export function correlationMatrix(positions = [], correlations = {}) {
  const tags = positions.map(p => String(p.narrativeTag || narrative(p.symbol, p.name)[0] || 'OTHER'));
  const out = {};
  for (let i = 0; i < positions.length; i++) for (let j = 0; j < positions.length; j++) {
    const a = String(positions[i].underlying || positions[i].mint || positions[i].symbol || tags[i]), b = String(positions[j].underlying || positions[j].mint || positions[j].symbol || tags[j]);
    out[`${i}:${j}`] = i === j ? 1 : clamp(correlations[`${a}|${b}`] ?? correlations[`${b}|${a}`] ?? (tags[i] === tags[j] ? 0.75 : 0), -1, 1);
  }
  return out;
}

export function drawdownTier({ equity, peak, tiers = { tier1: 0.05, tier2: 0.1, tier3: 0.2 } } = {}) {
  const dd = Number(peak) > 0 ? Math.max(0, (Number(peak) - Number(equity)) / Number(peak)) : 0;
  const t3 = Math.max(0, Number(tiers.tier3) || 0.2), t2 = Math.min(t3, Math.max(0, Number(tiers.tier2) || 0.1)), t1 = Math.min(t2, Math.max(0, Number(tiers.tier1) || 0.05));
  const tier = dd >= t3 ? 3 : dd >= t2 ? 2 : dd >= t1 ? 1 : 0;
  return { drawdownPct: dd, tier, sizeMultiplier: tier === 1 ? 0.5 : tier >= 2 ? 0 : 1, haltNewEntries: tier >= 2, flatten: tier >= 3 };
}

export function assessPortfolioRisk(state = {}, candidate = {}, { mode = state.mode?.toLowerCase?.() || 'paper', profile = state.runtime?.profile, maxNarrativeExposureSol = 2, maxEffectiveExposureSol = 5, tiers, correlations } = {}) {
  const positions = Array.isArray(state.positions) ? state.positions : [], tags = p => String(p.narrativeTag || narrative(p.symbol, p.name)[0] || 'OTHER');
  const exposure = p => Math.max(0, Number(p.remainingSol ?? p.sizeSol ?? 0) || 0);
  const matrix = correlationMatrix(positions, correlations), values = Object.values(matrix).filter(x => x < 1);
  const avgCorr = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const total = positions.reduce((s, p) => s + exposure(p), 0), effective = total * (1 + avgCorr * Math.max(0, positions.length - 1)) / Math.max(1, positions.length);
  const tag = String(candidate.narrativeTag || narrative(candidate.symbol, candidate.name)[0] || 'OTHER');
  const sameTag = positions.filter(p => tags(p) === tag).reduce((s, p) => s + exposure(p), 0);
  const dd = drawdownTier({ equity: state.portfolio?.equitySol ?? state.cashSol, peak: state.portfolioPeakSol ?? state.peakEquitySol ?? state.paperStartSol, tiers });
  const enabled = mode === 'paper' && String(profile || '').toUpperCase() === 'AGGRESSIVE_PAPER';
  const reasons = [];
  if (enabled && sameTag >= maxNarrativeExposureSol) reasons.push('narrative-exposure-cap');
  if (enabled && effective >= maxEffectiveExposureSol) reasons.push('correlated-exposure-cap');
  if (enabled && dd.haltNewEntries) reasons.push(dd.flatten ? 'drawdown-flatten' : 'drawdown-halt');
  return { enabled, allowed: reasons.length === 0, reasons, narrativeTag: tag, sameNarrativeExposureSol: sameTag,
    totalExposureSol: total, averageCorrelation: avgCorr, effectiveExposureSol: effective, ...dd,
    sizeMultiplier: enabled ? dd.sizeMultiplier : 1, haltNewEntries: enabled && dd.haltNewEntries, flatten: enabled && dd.flatten };
}
