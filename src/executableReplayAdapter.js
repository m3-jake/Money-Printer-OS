/**
 * Integration adapter / contract for replacing evolution endpoint-clamped
 * scoring with executable path replay.
 *
 * DO NOT import this from evolutionLoop.js or evolutionWorker.js while the
 * fast-path CPU-optimization task owns those files. The swap is a later
 * single-site change:
 *
 *   import { scoreVariantExecutable, buildExecutableDataset, EVOLUTION_EVALUATOR_CONTRACT }
 *     from './executableReplayAdapter.js';
 *   const dataset = buildExecutableDataset({ outcomes: learnerRows, events, tickHistory });
 *   const { metrics } = scoreVariantExecutable(variant, dataset);
 *
 * Current (owned) behavior this replaces
 * --------------------------------------
 * evolutionWorker.metrics / evolutionLoop.metrics:
 *   ret = clamp(executionAdjusted(returnPct), -stopPct, takePct)
 *   wallet *= (1 + ret/100)   // sequential full-bankroll compound
 * Dataset: learner.outcomes.filter(horizonMin === 5)
 *
 * This adapter
 * ------------
 * Walks captured bid/quote paths. Lone 5-minute returns are scored only as
 * proxy diagnostics, never as stop/target or arbitrary-hold evidence, and
 * cannot promote. Overlapping trades share one cash pool.
 *
 * Always live:false. No wallets, credentials, or network I/O.
 */
import { loadEvents } from './replayLab.js';
import { promotionDecision, createExperiment, addChallenger, recordResult, assertNoLiveChallengers } from './experimentLane.js';
import {
  evaluateExecutableReplay,
  quotesFromReplayEvents,
  quotesFromTickHistory,
  quotesFromTokenObservations,
  diagnoseCoverage,
  sequentialCompoundMultiple,
  EXECUTABLE_REPLAY_VERSION,
} from './executableReplayEvaluator.js';

export const EVOLUTION_EVALUATOR_CONTRACT = Object.freeze({
  version: EXECUTABLE_REPLAY_VERSION,
  id: 'solana-executable-path-replay',
  live: false,
  ownedFilesDoNotEdit: Object.freeze(['src/evolutionLoop.js', 'src/evolutionWorker.js']),
  currentCallSite: Object.freeze({
    file: 'src/evolutionLoop.js',
    select: 'learner.outcomes.filter(o => o.horizonMin === 5 && Number.isFinite(o.returnPct) && o.features)',
    score: 'scoreInWorkers(variants, rows) -> evolutionWorker.metrics',
  }),
  replacement: Object.freeze({
    build: 'buildExecutableDataset({outcomes, events, tickHistory, observations, quotes})',
    score: 'scoreVariantExecutable(variant, dataset, options)',
    load: 'loadCapturedQuoteDataset({dataDir, extra, limitEvents, outcomes, tickHistory})',
  }),
  replaces: Object.freeze([
    'endpoint clamp of 5-minute returnPct into [-stopPct, takePct]',
    'sequential full-bankroll compound of overlapping 5m labels',
    'velocity = avgReturn / assumed maxHoldMin on a 5m endpoint',
  ]),
  requiredDataset: Object.freeze([
    'opportunities with mint, entryTs, features; optional returnPct/horizonMin',
    'captured quotes from replayLab loadEvents, tickHistory, or token_observations',
  ]),
  promotion: Object.freeze({
    live: false,
    proxyOnlyIneligible: true,
    fiveMinuteEndpointIneligible: true,
    requiresExecutableCoverage: true,
  }),
});

export function buildExecutableDataset({
  outcomes = [],
  events = [],
  tickHistory = {},
  observations = [],
  quotes = [],
} = {}) {
  const captured = [
    ...quotesFromReplayEvents(events),
    ...quotesFromTickHistory(tickHistory),
    ...quotesFromTokenObservations(observations),
    ...quotes,
  ];
  const opportunities = (outcomes || []).map(o => ({
    mint: String(o.mint || ''),
    symbol: o.symbol,
    entryTs: Number(o.entryTs ?? o.ts ?? 0),
    ts: Number(o.ts || o.entryTs || 0),
    features: o.features || {},
    returnPct: Number.isFinite(Number(o.returnPct)) ? Number(o.returnPct) : null,
    horizonMin: o.horizonMin ?? o.horizon_min ?? null,
    predicted: o.predicted,
    context: o.context || {},
  })).filter(o => o.mint && o.entryTs);
  return {
    version: EXECUTABLE_REPLAY_VERSION,
    opportunities,
    quotes: captured,
    coverage: diagnoseCoverage(opportunities, captured, {}),
    sources: {
      replayEvents: (events || []).length,
      tickHistoryMints: Object.keys(tickHistory || {}).length,
      observations: (observations || []).length,
      explicitQuotes: (quotes || []).length,
    },
    inventedTicks: 0,
  };
}

export async function loadCapturedQuoteDataset({
  dataDir,
  extra = [],
  limitEvents = 0,
  outcomes = [],
  tickHistory = {},
  observations = [],
} = {}) {
  const ds = dataDir ? await loadEvents({ dataDir, extra, limitEvents }) : { events: [], hash: null, quarantine: {} };
  const dataset = buildExecutableDataset({
    outcomes,
    events: ds.events || [],
    tickHistory,
    observations,
  });
  return {
    ...dataset,
    replay: {
      events: (ds.events || []).length,
      hash: ds.hash || null,
      quarantine: ds.quarantine || {},
    },
  };
}

function workerShapedMetrics(result) {
  const m = result.metrics || {};
  return {
    n: m.n || 0,
    avg: m.avg || 0,
    median: m.median || 0,
    winPct: m.winPct || 0,
    worstPct: m.worstPct || 0,
    velocity: m.velocity || 0,
    sharpe: m.sharpe ?? -9,
    activityPct: m.activityPct || 0,
    geometricMeanPct: m.geometricMeanPct || 0,
    compoundedMultiple: m.compoundedMultiple || 1,
    maxDrawdownPct: m.maxDrawdownPct || 0,
    returns: m.returns || [],
    realizedPnl: m.realizedPnl || 0,
    expectancy: m.n ? m.realizedPnl / m.n : 0,
    profitFactor: profitFactor(m.returns || []),
    sequentialCompoundMultiple: m.sequentialCompoundMultiple ?? sequentialCompoundMultiple(m.returns || []),
    avgHoldMin: m.avgHoldMin || 0,
    fees: m.fees || 0,
    slippageCost: m.slippageCost || 0,
    censored: m.censored || 0,
    exitReasons: m.exitReasons || {},
    entryFailures: m.entryFailures || 0,
    exitFailures: m.exitFailures || 0,
  };
}

function profitFactor(returns) {
  const wins = returns.filter(x => x > 0).reduce((s, x) => s + x, 0);
  const loss = Math.abs(returns.filter(x => x < 0).reduce((s, x) => s + x, 0));
  return loss ? wins / loss : (wins ? 999 : 0);
}

export function scoreVariantExecutable(variant, dataset, options = {}) {
  const opportunities = dataset?.opportunities || [];
  const quotes = dataset?.quotes || [];
  const result = evaluateExecutableReplay({
    variant,
    opportunities,
    quotes,
    capital: options.capital,
    execution: options.execution,
  });
  const metrics = workerShapedMetrics(result);
  const promotion = gateExecutablePromotion(variant, metrics, result.coverage);
  return {
    variant,
    metrics: {
      ...metrics,
      coverageMode: result.coverage.mode,
      executableOpportunities: result.coverage.executableOpportunities,
      proxyOnly: result.coverage.proxyOnly,
    },
    coverage: result.coverage,
    promotion,
    contrast: {
      sequentialCompoundMultiple: metrics.sequentialCompoundMultiple,
      sharedCapitalMultiple: metrics.compoundedMultiple,
    },
    trades: result.trades,
    proxyDiagnostics: result.proxyDiagnostics,
    mode: result.mode,
    live: false,
    contract: EVOLUTION_EVALUATOR_CONTRACT.id,
  };
}

export function gateExecutablePromotion(variant, metrics, coverage) {
  if (coverage?.mode !== 'executable' || coverage?.proxyOnly > 0) {
    return { eligible: false, reason: coverage?.mode === 'missing-path' ? 'insufficient-path-coverage' : 'proxy-only', nextMode: null, live: false };
  }
  if ((coverage?.inventedTicks || 0) > 0) {
    return { eligible: false, reason: 'invented-ticks', nextMode: null, live: false };
  }
  const exp = createExperiment({ stableConfig: { profile: 'RESEARCH' }, datasetHash: 'executable-replay', versionHash: 'executable-replay', createdAt: 1 });
  const c = addChallenger(exp, { config: { id: variant?.id || 'executable', ...(variant || {}), promotable: variant?.promotable }, mode: 'backtest' });
  recordResult(exp, c.id, {
    n: metrics.n,
    realizedPnl: metrics.realizedPnl,
    expectancy: metrics.expectancy,
    profitFactor: metrics.profitFactor,
    maxDrawdownPct: metrics.maxDrawdownPct,
    positiveSplits: metrics.n > 0 && metrics.realizedPnl > 0 ? 1 : 0,
    totalSplits: 1,
    top3PnlConcentrationPct: 0,
  });
  const decision = promotionDecision(exp, c.id);
  assertNoLiveChallengers(exp);
  return { eligible: decision.eligible === true, reason: decision.reason, nextMode: decision.nextMode || null, live: false };
}

export function endpointClampContrast(row, variant) {
  const raw = Number(row?.returnPct || 0);
  const friction = 0.35;
  const clamped = Math.max(-Number(variant.stopPct || 0), Math.min(Number(variant.takePct || 0), raw - friction));
  return { raw, clamped, inferredStopOrTarget: true, note: 'legacy evolutionWorker.metrics behavior; not used by executable replay' };
}
