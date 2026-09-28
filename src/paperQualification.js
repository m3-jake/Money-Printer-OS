import { tradeRows, mean, finite } from './analytics/shared.js';
import { maxDrawdown } from './analytics/journalReport.js';

export const QUALIFICATION_DEFAULTS = Object.freeze({ minSharpe: 1, maxDrawdownPct: 20, minWinRate: 0.5, minSamples: 100, minDays: 30, maxOptimismGap: 0.25, maxShadowGapBps: 100 });
const sharpe = xs => { if (xs.length < 2) return null; const avg = mean(xs), variance = mean(xs.map(x => (x - avg) ** 2)); return variance > 0 ? avg / Math.sqrt(variance) : null; };

export function qualificationMetrics(id, rows = [], { now = Date.now(), markedEquitySeries = [] } = {}) {
  const all = tradeRows(rows).filter(x => x.strategy === String(id) && x.closedAt <= now && String(x.mode || 'PAPER').toUpperCase() !== 'LIVE');
  const pnls = all.map(x => x.pnl), wins = pnls.filter(x => x > 0), start = all[0]?.closedAt ?? null, end = all.at(-1)?.closedAt ?? null;
  const replay = all.map(x => finite(x.replayPnl)).filter(x => x !== null);
  const shadow = all.map(x => finite(x.shadowDivergenceBps)).filter(x => x !== null).map(Math.abs);
  const returns = all.map(x => finite(x.returnPct) === null ? null : Number(x.returnPct) / 100).filter(x => x !== null);
  // A percentage drawdown needs observed marked equity, not final net P&L as its denominator.
  const curve = markedEquitySeries.filter(x => x?.strategy === String(id) && finite(x.at) !== null && x.at <= now && finite(x.equitySol) !== null && x.equitySol >= 0).sort((a,b) => a.at-b.at);
  let peak = 0, drawdown = 0;
  for (const x of curve) { peak = Math.max(peak, x.equitySol); if (peak > 0) drawdown = Math.max(drawdown, (peak-x.equitySol)/peak*100); }
  const covered = curve.length > 1 && peak > 0 && start !== null && curve[0].at <= start && curve.at(-1).at >= end;
  const expectancy = mean(pnls), replayExpectancy = mean(replay);
  return { id: String(id), sharpe: returns.length === all.length ? sharpe(returns) : null,
    sharpeBasis: 'UNANNUALIZED_CLOSED_TRADE_RETURNS_NOT_CALENDAR_SHARPE', maxDrawdownSol: maxDrawdown(pnls),
    maxDrawdownPct: covered ? drawdown : null, drawdownBasis: covered ? 'OBSERVED_MARKED_EQUITY' : 'MISSING_MARKED_EQUITY',
    winRate: all.length ? wins.length / all.length : null, sampleCount: all.length,
    daysObserved: start !== null && end !== null ? Math.max(0, (end-start)/86_400_000) : 0,
    expectancy, replayExpectancy, optimismGap: replayExpectancy === null || expectancy === null ? null : expectancy-replayExpectancy,
    replaySampleCount: replay.length, shadowSampleCount: shadow.length, shadowGapBps: mean(shadow), asOf: now };
}
export function qualifiesForLivePromotion(id, rows = [], thresholds = {}) {
  const limits = { ...QUALIFICATION_DEFAULTS, ...thresholds }, metrics = qualificationMetrics(id, rows, { ...thresholds, now: thresholds.now ?? Date.now() }), reasons = [];
  if (metrics.sharpe == null || metrics.sharpe < limits.minSharpe) reasons.push('sharpe-below-threshold');
  if (metrics.maxDrawdownPct == null) reasons.push('marked-equity-evidence-missing');
  else if (metrics.maxDrawdownPct > limits.maxDrawdownPct) reasons.push('max-drawdown-exceeded');
  if (metrics.winRate == null || metrics.winRate < limits.minWinRate) reasons.push('win-rate-below-threshold');
  if (metrics.sampleCount < limits.minSamples) reasons.push('insufficient-samples');
  if (metrics.daysObserved < limits.minDays) reasons.push('insufficient-observation-days');
  if (metrics.replaySampleCount < metrics.sampleCount || metrics.optimismGap == null) reasons.push('replay-evidence-missing');
  else if (metrics.optimismGap > limits.maxOptimismGap) reasons.push('paper-replay-optimism-gap');
  if (metrics.shadowSampleCount < metrics.sampleCount || metrics.shadowGapBps == null) reasons.push('shadow-evidence-missing');
  else if (metrics.shadowGapBps > limits.maxShadowGapBps) reasons.push('shadow-divergence-exceeded');
  return { id: String(id), ok: reasons.length === 0, reasons, metrics, badge: reasons.length ? 'NOT QUALIFIED' : 'PAPER QUALIFIED', liveActivationAllowed: false, automaticLivePromotionAllowed: false };
}

export function paperQualificationBadge(result) {
  return { label: result?.badge || 'NOT QUALIFIED', status: result?.ok ? 'QUALIFIED' : 'BLOCKED', reasons: [...(result?.reasons || [])], readOnly: true, liveActivationAllowed: false };
}
