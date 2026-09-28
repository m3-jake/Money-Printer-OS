import { tradeRows, mean } from './analytics/shared.js';
import { maxDrawdown } from './analytics/journalReport.js';

export const QUALIFICATION_DEFAULTS = Object.freeze({ minSharpe: 1, maxDrawdownPct: 20, minWinRate: 0.5, minSamples: 100, minDays: 30, maxOptimismGap: 0.25, maxShadowGapBps: 100 });
const safeRatio = (a, b) => b > 0 ? a / b : 0;
const sharpe = xs => { if (xs.length < 2) return null; const avg = mean(xs), variance = mean(xs.map(x => (x - avg) ** 2)); return variance > 0 ? avg / Math.sqrt(variance) : null; };

export function qualificationMetrics(id, rows = [], { now = Date.now() } = {}) {
  const all = tradeRows(rows).filter(x => x.strategy === String(id));
  const pnls = all.map(x => x.pnl), wins = pnls.filter(x => x > 0), net = pnls.reduce((a, b) => a + b, 0), start = all[0]?.closedAt || null, end = all.at(-1)?.closedAt || null;
  const replay = all.map(x => Number(x.replayPnl)).filter(Number.isFinite), shadow = all.map(x => Number(x.shadowDivergenceBps)).filter(Number.isFinite);
  const expectancy = mean(pnls), replayExpectancy = mean(replay), optimismGap = replayExpectancy == null ? null : expectancy - replayExpectancy;
  return { id: String(id), sharpe: sharpe(pnls), maxDrawdownSol: maxDrawdown(pnls), maxDrawdownPct: net !== 0 ? maxDrawdown(pnls) / Math.max(1e-9, Math.abs(net)) * 100 : maxDrawdown(pnls) > 0 ? 100 : 0,
    winRate: all.length ? wins.length / all.length : null, sampleCount: all.length, daysObserved: start && end ? Math.max(0, (Math.min(now, end) - start) / 86_400_000) : 0,
    expectancy, replayExpectancy, optimismGap, shadowGapBps: mean(shadow), asOf: now };
}

export function qualifiesForLivePromotion(id, rows = [], thresholds = {}) {
  const limits = { ...QUALIFICATION_DEFAULTS, ...thresholds }, metrics = qualificationMetrics(id, rows, { now: thresholds.now || Date.now() }), reasons = [];
  if (metrics.sharpe == null || metrics.sharpe < limits.minSharpe) reasons.push('sharpe-below-threshold');
  if (metrics.maxDrawdownPct > limits.maxDrawdownPct) reasons.push('max-drawdown-exceeded');
  if (metrics.winRate == null || metrics.winRate < limits.minWinRate) reasons.push('win-rate-below-threshold');
  if (metrics.sampleCount < limits.minSamples) reasons.push('insufficient-samples');
  if (metrics.daysObserved < limits.minDays) reasons.push('insufficient-observation-days');
  if (metrics.optimismGap != null && metrics.optimismGap > limits.maxOptimismGap) reasons.push('paper-replay-optimism-gap');
  if (metrics.shadowGapBps != null && metrics.shadowGapBps > limits.maxShadowGapBps) reasons.push('shadow-divergence-exceeded');
  return { id: String(id), ok: reasons.length === 0, reasons, metrics, badge: reasons.length ? 'NOT QUALIFIED' : 'PAPER QUALIFIED', liveActivationAllowed: false, automaticLivePromotionAllowed: false };
}

export function paperQualificationBadge(result) {
  return { label: result?.badge || 'NOT QUALIFIED', status: result?.ok ? 'QUALIFIED' : 'BLOCKED', reasons: [...(result?.reasons || [])], readOnly: true, liveActivationAllowed: false };
}
