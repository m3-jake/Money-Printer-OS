// Paired Pump.fun profit-capture contract. Pure, deterministic, and simulation-only.
import { createHash } from 'node:crypto';
export const PUMP_PROFIT_SCHEMA = 'mpo.pump-profit.v1';
export const finite = x => x !== null && x !== '' && Number.isFinite(Number(x));
export const num = (x, fallback = 0) => finite(x) ? Number(x) : fallback;
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, num(x)));
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const policyHash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const sum = xs => xs.reduce((a, b) => a + b, 0);
const avg = xs => xs.length ? sum(xs) / xs.length : null;
const median = xs => { const a = [...xs].sort((a, b) => a - b), n = a.length; return n ? (a[(n - 1) >> 1] + a[n >> 1]) / 2 : null; };
export function outcomeMetrics(rows = []) {
  const values = rows.map(x => num(x.pnlSol)), wins = values.filter(x => x > 0), losses = values.filter(x => x < 0);
  const best = values.length ? Math.max(...values) : null;
  return { outcomeCount: values.length, wins: wins.length, losses: losses.length, flats: values.length - wins.length - losses.length,
    netSol: sum(values), winRate: values.length ? wins.length / values.length : null, expectancySol: avg(values), medianSol: median(values),
    averageWinSol: avg(wins), medianWinSol: median(wins), averageLossSol: avg(losses), medianLossSol: median(losses),
    profitFactor: losses.length ? sum(wins) / -sum(losses) : null, noLossesObserved: !losses.length,
    bestSol: best, worstSol: values.length ? Math.min(...values) : null, withoutBestSol: best === null ? null : sum(values) - best,
    feesSol: sum(rows.map(x => num(x.feesSol))), medianHoldMinutes: median(rows.filter(x => finite(x.openedAt) && finite(x.closedAt)).map(x => (x.closedAt - x.openedAt) / 60000)),
    meanReturnOnAllocatedPct: avg(rows.filter(x => num(x.sizeSol) > 0).map(x => num(x.pnlSol) / x.sizeSol * 100)) };
}
export function markedDrawdown(series = []) {
  let peak = 0, amount = 0, pct = 0;
  for (const p of [...series].sort((a, b) => a.ts - b.ts)) { if (!finite(p.equitySol)) continue; peak = Math.max(peak, p.equitySol); amount = Math.max(amount, peak - p.equitySol); pct = Math.max(pct, peak > 0 ? (peak - p.equitySol) / peak * 100 : 0); }
  return { sol: amount, pct, firstAt: series[0]?.ts ?? null, lastAt: series.at(-1)?.ts ?? null, kind: 'OBSERVED_MARKS_NOT_EXECUTABLE_LIQUIDATION' };
}

export function auditPumpBook(state = {}) {
  const seen = new Map(), rows = [], issues = [], coverage = { complete: 0, partial: 0, missing: 0, invalid: 0 };
  for (const p of state.history || []) {
    if (!p?.id || !finite(p.pnlSol) || !finite(p.closedAt) || num(p.remainingSol) > 1e-8) { issues.push('incomplete-position-outcome'); continue; }
    if (seen.has(p.id)) { issues.push(seen.get(p.id) === policyHash(p) ? 'duplicate-position' : 'conflicting-position'); continue; }
    seen.set(p.id, policyHash(p)); rows.push(p);
    const receipts = p.paperCashEvents || [];
    if (p.paperCashCoverage !== 'COMPLETE_FROM_ENTRY') { coverage[receipts.length ? 'partial' : 'missing']++; continue; }
    const total = sum(receipts.map(r => num(r.deltaSol)));
    const buys = receipts.filter(r => r.side === 'BUY'), sells = receipts.filter(r => r.side === 'SELL');
    const valid = buys.length === 1 && sells.length > 0 && Math.abs(total - p.pnlSol) < 1e-8 &&
      Math.abs(sum(sells.map(r => num(r.basisSol))) - num(p.sizeSol)) < 1e-8 &&
      receipts.every((r, i) => r.positionId === p.id && r.sequence === i && num(r.postedAt) > 0 && Math.abs(num(r.cashBeforeSol) + num(r.deltaSol) - num(r.cashAfterSol)) < 1e-8);
    coverage[valid ? 'complete' : 'invalid']++;
  }
  const m = outcomeMetrics(rows), positions = state.positions || [], basis = sum(positions.map(p => num(p.remainingSol, num(p.sizeSol))));
  const openRealized = sum(positions.map(p => num(p.realizedSol))), ledgerNet = finite(state.realizedLifetimePnlSol) ? Number(state.realizedLifetimePnlSol) : m.netSol;
  const identityResidualSol = num(state.cashSol) + basis - num(state.paperStartSol) - ledgerNet - openRealized;
  const group = key => { const out = {}; for (const r of rows) (out[key(r)] ||= []).push(r); return Object.fromEntries(Object.entries(out).map(([k, rs]) => [k, outcomeMetrics(rs)])); };
  const complete = rows.filter(p => p.paperCashCoverage === 'COMPLETE_FROM_ENTRY'), proceeds = sum(complete.flatMap(p => (p.paperCashEvents || []).filter(r => r.side === 'SELL').map(r => num(r.grossSol))));
  return { schema: PUMP_PROFIT_SCHEMA, ...m, originalStartSol: num(state.paperStartSol), realizedReturnPct: num(state.paperStartSol) > 0 ? m.netSol / state.paperStartSol * 100 : null,
    cashSol: num(state.cashSol), openBasisSol: basis, openPositions: positions.length, openRealizedSol: openRealized, identityResidualSol,
    retainedClosedPnlGapSol:ledgerNet-m.netSol, reconciled: Math.abs(identityResidualSol) < 1e-8 && !issues.length && !coverage.invalid, receiptCoverage: coverage, issues,
    markedDrawdown: markedDrawdown(state.portfolioSeries), byHourUtc: group(r => new Date(r.closedAt).toISOString().slice(0, 13)), byProfile: group(r => `${r.profile || 'UNKNOWN'} / ${r.championId || 'UNKNOWN'}`), byPolicyHash: group(r => r.pumpPolicy?.hash || 'HISTORICAL_POLICY_NOT_PINNED'), byExit: group(r => r.reason || 'UNKNOWN'),
    completeReceiptFeesShareOfProceeds: proceeds > 0 ? sum(complete.map(p => num(p.feesSol))) / proceeds : null,
    overRequestedFills: rows.filter(p => finite(p.requestedSizeSol) && p.sizeSol > p.requestedSizeSol + 1e-9).length,
    legacyFxUnknownCount:rows.filter(p=>!(num(p.entrySolUsd)>0)).length, evidenceState: 'MODELED_PAPER_NOT_EXCHANGE_RECEIPTS', missingEvidence: ['historical SOL/USD entry conversion for untagged positions', 'historical network and failed-transaction charges', 'exact-size executable exit trajectories', ...(coverage.missing + coverage.partial ? ['historical partial-exit cash timestamps'] : [])] };
}

export function describePumpPolicy(runtime = {}, config = {}, baseExit = {}, champion = null) {
  const exit = { ...baseExit, ...(champion ? { tp1: champion.takePct, tp2: champion.takePct, stop: champion.stopPct, maxHold: champion.maxHoldMin } : {}),
    tp1Fraction: runtime.profile === 'SPRINT' ? 1 : clamp(num(config.takeProfit1SellPct, 35) / 100, .01, 1),
    tp2Fraction: runtime.profile === 'SPRINT' ? 1 : clamp(num(config.takeProfit2SellPct, 35) / 100, .01, 1), breakEvenTriggerPct: num(config.breakEvenTriggerPct, 4) };
  const policy = { schema: PUMP_PROFIT_SCHEMA, mode: 'PAPER', owner: champion ? 'EVOLUTION_LAB' : runtime.followLabBest === false ? 'MANUAL' : 'BASELINE_WAITING_FOR_LAB',
    championId: champion?.id || 'BASE', entry: { threshold: champion?.threshold ?? null, weights: champion?.weights ? structuredClone(champion.weights) : null }, profile: runtime.profile || 'UNKNOWN', exit, sizing: { kind: 'BASELINE', multiplier: 1 },
    configuredSizing:Object.fromEntries(['tradeSizeSol','riskPerTradePct','maxPositionSol','maxTotalExposureSol','minSolReserve','simulatedFeeBps','simulatedSlippageBps','cooldownMin'].map(k=>[k,num(config[k])])), openPositionOverride:runtime.maxOpenPositions??null, aggression: num(runtime.aggression), entryFrequency: runtime.entryFrequency || 'normal', operatorSafety: sanitizePumpSafety(runtime.pumpSafety) };
  return { ...policy, hash: policyHash(policy) };
}
export function pinPumpPolicy(position, policy, { now = Date.now(), migration = false } = {}) {
  if (position.pumpPolicy) return false;
  position.pumpPolicy = structuredClone(policy);
  position.pumpPolicyPinnedAt = now;
  position.pumpPolicyProvenance = migration ? 'POLICY_IN_FORCE_AT_UPGRADE_NOT_RECONSTRUCTED_ENTRY_POLICY' : 'PINNED_AT_ENTRY';
  return true;
}
export function sanitizePumpSafety(raw = {}) {
  const out = {}, bounds = { maxPositionSol: [.001, 100], maxExposureSol: [.001, 1000], feeReserveSol: [0, 100], maxLossBudgetPct: [.1, 25], maxRoundTripPct: [.1, 25], maxExitImpactPct: [.1, 5] };
  for (const [k, [lo, hi]] of Object.entries(bounds)) if (finite(raw?.[k])) out[k] = clamp(raw[k], lo, hi);
  return out;
}
export function evidenceGroup(pick = {}, roundTripPct = null) {
  return { signal: num(pick.score) >= 75 ? 'strong' : 'ordinary', liquidity: num(pick.liq) >= 100000 ? 'deep' : 'thin',
    cost: finite(roundTripPct) && roundTripPct <= 3 ? 'low' : 'high-or-unknown', volatility: Math.abs(num(pick.micro?.p10)) > 5 ? 'high' : 'ordinary',
    execution: num(pick.executionScore) >= 70 ? 'strong' : 'ordinary' };
}

export function decidePumpSize({ legacy, state = {}, config = {}, pick = {}, policy = { kind: 'BASELINE', multiplier: 1 }, evidence = null } = {}) {
  if (String(state.mode || state.pnlMode || config.mode || '').toUpperCase() !== 'PAPER') throw new Error('Pump profit sizing is PAPER-only');
  const safety = sanitizePumpSafety(state.runtime?.pumpSafety), reasons = [], baselineRequested = num(legacy?.targetSize), cash = Math.max(0, num(state.cashSol) - num(state.pendingCashReserveSol));
  const reserve = Math.max(num(config.minSolReserve), num(safety.feeReserveSol)), feeRate = Math.max(0, num(config.simulatedFeeBps)) / 10000;
  let multiplier = clamp(num(policy.multiplier, 1), .1, 2);
  const group = evidenceGroup(pick, evidence?.roundTripPct), groupHash = policyHash(group), adaptive = policy.kind === 'ADAPTIVE';
  const independentlyValidated = evidence?.state === 'VALIDATED' && evidence.groupHash === groupHash && evidence.untouched === true &&
    num(evidence.independentClusters) >= 50 && num(evidence.afterCostLowerBound) > 0 && num(evidence.withoutBestLowerBound) > 0 && evidence.executionComplete === true;
  if (adaptive && multiplier > 1 && !independentlyValidated) { multiplier = 1; reasons.push('no-independent-group-evidence-for-increase'); }
  const streak = [...(state.history || [])].reverse().findIndex(x => num(x.pnlSol) >= 0), losses = streak < 0 ? (state.history || []).length : streak;
  if (adaptive && (losses >= 3 || evidence?.deteriorating || num(pick.executionScore) < 50)) { multiplier = Math.min(multiplier, .5); reasons.push('deteriorating-outcomes-or-execution'); }
  const limits = { requested: baselineRequested * multiplier, position: num(legacy?.positionCap), stopBasedLegacyBudget: num(legacy?.riskSized),
    aggregateExposure: num(legacy?.headroom), cashAndFeeReserve: Math.max(0, (cash - reserve) / (1 + feeRate)) };
  const basis = (state.positions || []).reduce((n,p)=>n+num(p.remainingSol,num(p.sizeSol)),0);
  if(num(config.maxPositionSol)>0) limits.configuredPosition = num(config.maxPositionSol);
  if(num(config.maxTotalExposureSol)>0) limits.configuredExposure = Math.max(0,num(config.maxTotalExposureSol)-basis-num(state.pendingExposureSol));
  if(finite(state.paperStartSol)){
    const openRealized=(state.positions||[]).reduce((n,p)=>n+num(p.realizedSol),0);
    const residual=num(state.cashSol)+basis-num(state.paperStartSol)-num(state.realizedLifetimePnlSol)-openRealized;
    if(Math.abs(residual)>1e-8 || !(num(state.paperStartSol)>0)) {limits.accountingIntegrity=0; reasons.push('paper-book-not-reconciled');}
  }
  if (finite(safety.maxPositionSol)) limits.operatorPosition = safety.maxPositionSol;
  if (finite(safety.maxExposureSol)) limits.operatorExposure = Math.max(0, safety.maxExposureSol - (state.positions || []).reduce((n, p) => n + num(p.remainingSol, num(p.sizeSol)), 0));
  if (adaptive) {
    const cluster=pick.risk?.mintAuthority||pick.correlationGroup||'SOLANA_HIGH_BETA';
    const correlated=(state.positions||[]).filter(p=>(p.correlationGroup||p.cluster||'SOLANA_HIGH_BETA')===cluster).reduce((q,p)=>q+num(p.remainingSol,num(p.sizeSol)),0);
    limits.correlatedExposure=Math.max(0,num(legacy?.eq)*num(policy.maxCorrelatedPct,10)/100-correlated);
    limits.nearTotalLossBudget = num(legacy?.eq) * num(safety.maxLossBudgetPct, 1) / 100 / (1 + feeRate);
    limits.executableExitCapacity = evidence?.executionComplete === true ? Math.max(0, num(evidence.exitCapacitySol)) : 0;
    if (num(evidence?.roundTripPct, Infinity) > num(safety.maxRoundTripPct, 4)) limits.afterCostEconomics = 0;
    if (num(evidence?.drawdownPct) >= num(policy.maxDrawdownPct, 10)) limits.drawdownBudget = 0;
  }
  const [bindingLimit, allowed] = Object.entries(limits).sort((a, b) => a[1] - b[1])[0];
  const allowedSol = Math.floor(Math.max(0, allowed) * 1e9) / 1e9, sizeSol = allowedSol >= .005 ? allowedSol : 0;
  if (!sizeSol) reasons.push('uneconomic-or-budget-exhausted'); else if (sizeSol < limits.requested - 1e-9) reasons.push(`limited-by-${bindingLimit}`);
  return { schema: PUMP_PROFIT_SCHEMA, mode: 'PAPER', baselineRequestedSol: baselineRequested, requestedSol: limits.requested, allowedSol, sizeSol, filledSol: null,
    bindingLimit, limits, reasons, reserveSol: reserve, estimatedEntryFeeSol: sizeSol * feeRate, potentialLossSol: sizeSol * (1 + feeRate), configuredStopIsGuaranteed: false,
    multiplier, independentlyValidated, evidenceGroup: group, groupHash, costCoverage: 'TRADING_FEE_ESTIMATE_NETWORK_AND_FAILURE_COSTS_REQUIRE_EVIDENCE' };
}

export function makeProfitProtocol(baseline, startingCapitalSol, now = Date.now()) {
  const exits = baseline.exit, embargoMs = (num(exits.maxHold, 120) + 120) * 60000;
  const candidates = [
    { id: 'BASELINE', family: 'baseline', multiplier: 1, exit: exits },
    ...[1.25, 1.5, 2].map(multiplier => ({ id: `SIZE_${multiplier}`, family: 'sizing-only', multiplier, exit: exits })),
    { id: 'EXIT_LATER_FIRST', family: 'exit-only', multiplier: 1, exit: { ...exits, tp1: exits.tp1 * 1.25, tp2: Math.max(exits.tp2, exits.tp1 * 1.5), tp1Fraction: .25 } },
    { id: 'EXIT_SMALL_RUNNER', family: 'exit-only', multiplier: 1, exit: { ...exits, tp1Fraction: .6, tp2Fraction: .5, volatilityTrail: true } },
    { id: 'EXIT_SIGNAL_STALL', family: 'exit-only', multiplier: 1, exit: { ...exits, stallMinutes: 15, signalFailure: true, liquidityFailure: true } }
  ];
  const protocol = { schema: PUMP_PROFIT_SCHEMA, mode: 'PAPER', createdAt: now, baselineHash: baseline.hash, candidates,
    capitalsSol: [...new Set([startingCapitalSol, .15, .25])], maxOpportunities: 256, maxOpportunitiesPerPhase: 128, maxOpportunitiesPerHour: 3, maxObservations: 524288, maxCandidateEvaluations: 21,
    discovery: { start: now, end: now + 86400000 }, validation: { start: now + 86400000 + embargoMs, end: now + 3 * 86400000 + embargoMs }, embargoMs,
    postExitHorizonsMinutes: [5, 30, 120], maxQuoteAgeMs: 30000, maxBatchMilliseconds: 50,
    promotion: { minCompletedPositions: 100, minIndependentClusters: 50, minValidationSpanDays: 2, familyAlpha: .05,
      mustBeatBaselineWithoutBest: true, requirePositivePairedLowerBound: true, maxDrawdownIncreasePctPoints: 0, canaryCapitalFraction: .05 },
    stress: ['clustered-losses', 'double-costs', 'delayed-exits', 'failed-exits', 'disappearing-liquidity'],
    exposurePolicy: 'BASELINE_CAPS_UNCHANGED_NO_EXPERIMENTAL_CAP_INCREASE', holdoutUse: 'ONE_PREDECLARED_EVALUATION_PER_SEALED_DATASET', liveExecutionAllowed: false };
  return { ...protocol, hash: policyHash(protocol) };
}
export function candidateExit(policy, position, observation, now) {
  const ret = (observation.priceUsd / position.entryPrice - 1) * 100, draw = (observation.priceUsd / Math.max(position.highPrice, position.entryPrice) - 1) * 100;
  if (policy.liquidityFailure && num(observation.liquidityRatio, 1) < .5) return { reason: 'liquidity-deterioration', fraction: 1 };
  if (policy.signalFailure && observation.signalValid === false) return { reason: 'signal-failure', fraction: 1 };
  if (!position.tp1Done && ret >= policy.tp1) return { reason: 'take-profit-1', fraction: policy.tp1Fraction, flag: 'tp1Done' };
  if (!position.tp2Done && ret >= policy.tp2) return { reason: 'take-profit-2', fraction: policy.tp2Fraction, flag: 'tp2Done' };
  const trail = policy.volatilityTrail ? clamp(num(observation.volatilityPct, policy.trail) * 2, policy.trail * .5, policy.trail * 1.5) : policy.trail;
  if (ret <= -policy.stop) return { reason: 'stop-loss', fraction: 1 };
  if (position.breakEvenArmed && num(observation.netReturnPct, ret) <= 0) return { reason: 'break-even', fraction: 1 };
  if (ret > 0 && draw <= -trail) return { reason: 'trailing', fraction: 1 };
  if (policy.stallMinutes && now - num(position.lastMomentumAt, position.openedAt) >= policy.stallMinutes * 60000) return { reason: 'momentum-stalled', fraction: 1 };
  if (now - position.openedAt >= policy.maxHold * 60000) return { reason: 'stale-purge', fraction: 1 };
  return null;
}
export function profitPromotionVerdict(candidate = {}, baseline = {}, protocol = {}, { now = Date.now(), usedHoldouts = [] } = {}) {
  const v = candidate.validation || {}, rules = protocol.promotion || {}, reasons = [];
  if (candidate.mode !== 'PAPER' || protocol.liveExecutionAllowed !== false) reasons.push('paper-only');
  if (!candidate.policyHash || candidate.protocolHash !== protocol.hash || candidate.baselineHash !== protocol.baselineHash) reasons.push('policy-or-protocol-mismatch');
  if (!v.datasetHash || usedHoldouts.includes(v.datasetHash) || v.untouched !== true || v.clusterPurged !== true) reasons.push('holdout-used-or-leaking');
  if (num(v.start) < num(protocol.validation?.start) || num(v.end) > num(protocol.validation?.end) || now < num(protocol.validation?.end)) reasons.push('validation-period-incomplete');
  if (num(v.positions) < num(rules.minCompletedPositions, 100) || num(v.clusters) < num(rules.minIndependentClusters, 50)) reasons.push('insufficient-independent-outcomes');
  if ((num(v.end) - num(v.start)) / 86400000 < num(rules.minValidationSpanDays, 2)) reasons.push('insufficient-market-time');
  if (v.executionComplete !== true || v.allCostsKnown !== true || v.openPositions !== 0 || num(v.missingObservations) !== 0) reasons.push('incomplete-execution-or-costs');
  if (!(num(candidate.startSol) > 0) || candidate.startSol !== baseline.startSol) reasons.push('unequal-capital');
  if (!finite(candidate.netSol) || !finite(baseline.netSol) || candidate.netSol <= baseline.netSol || !finite(candidate.withoutBestSol) || !finite(baseline.withoutBestSol) || candidate.withoutBestSol <= baseline.withoutBestSol) reasons.push('no-outlier-robust-improvement');
  if (!finite(candidate.drawdownPct) || !finite(baseline.drawdownPct) || candidate.drawdownPct > baseline.drawdownPct + num(rules.maxDrawdownIncreasePctPoints)) reasons.push('drawdown-worse');
  if (!(num(v.pairedLowerBoundSol) > 0) || v.candidateCount !== protocol.candidates?.length || num(v.familyAdjustedAlpha, 1) > num(rules.familyAlpha, .05)) reasons.push('uncertainty-or-multiple-testing');
  if (!(protocol.stress || []).every(k => candidate.stress?.[k]?.passed === true)) reasons.push('stress-incomplete-or-failed');
  return { qualified: reasons.length === 0, state: reasons.length ? 'NOT_QUALIFIED' : 'PAPER_CANARY_ELIGIBLE', reasons, liveExecutionAllowed: false };
}
export function transitionProfitCandidate(current, action, { candidate, baseline, protocol, now = Date.now(), usedHoldouts = [], deterioration = false } = {}) {
  if (action === 'ROLLBACK' || deterioration) return { state: 'BASELINE', policy: structuredClone(baseline), rollbackAt: now, reason: deterioration ? 'evidence-or-execution-deteriorated' : 'operator', liveExecutionAllowed: false };
  const verdict = profitPromotionVerdict(candidate, baseline, protocol, { now, usedHoldouts });
  if (!verdict.qualified) return { ...current, lastRejectedPromotion: { at: now, ...verdict }, liveExecutionAllowed: false };
  if (action === 'PAPER_CANARY') return { state: 'PAPER_CANARY', policy: structuredClone(candidate), capitalFraction: protocol.promotion.canaryCapitalFraction, activatedAt: now, liveExecutionAllowed: false };
  return { ...current, lastRejectedPromotion: { at: now, reasons: ['active-champion-replacement-requires-independent-canary-validation'] }, liveExecutionAllowed: false };
}
