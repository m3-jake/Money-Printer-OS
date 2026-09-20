/**
 * Solana executable bid/quote path-replay evaluator (research-only).
 *
 * Isolated from evolutionLoop / evolutionWorker. Those files still clamp a
 * lone 5-minute returnPct into [-stopPct, takePct] and sequentially compound
 * overlapping labels; this module does not patch them.
 *
 * Public interface
 * ----------------
 * normalizeQuote(raw) -> quote | null
 * quotesFromReplayEvents(events) -> quote[]
 * quotesFromTickHistory(tickHistory) -> quote[]
 * quotesFromTokenObservations(rows) -> quote[]
 * classifyOpportunityCoverage(opportunity, quotes, variant) -> coverage
 * diagnoseCoverage(opportunities, quotes, variant) -> diagnostics
 * evaluateExecutableReplay({variant, opportunities, quotes, capital, execution})
 *
 * Quote fields consumed when present: ts, mint, bid, ask, price/priceUsd/last,
 * liq, executionScore, staleResume. Bid/ask are used as the executable prices
 * when captured; otherwise last price is adjusted with executionSim slippage.
 * Intermediate ticks are never interpolated or invented.
 *
 * A lone 5-minute return is proxy-only: it cannot infer stop/target hits or an
 * arbitrary hold duration, and it is ineligible for promotion.
 *
 * No live execution, wallets, credentials, or network I/O.
 */
import { ReplayClock } from './replayLab.js';
import { estimatePaperExecution, deterministicFillAllowed } from './executionSim.js';

export const EXECUTABLE_REPLAY_VERSION = 1;
export const FEATURES = ['edge','explosion','execution','momentum','liquidity','freshness','flow','volumeAccel','priceAccel'];
export const STALE_QUOTE_MS = 30 * 60_000;
export const DEFAULT_FEE_BPS = 25;
export const DEFAULT_BASE_SLIPPAGE_BPS = 80;
export const MIN_SIZE_SOL = 0.002;
export const PROXY_REASONS = Object.freeze(['five-minute-endpoint-only','insufficient-path','absent-quotes','missing-path']);

const r4 = x => Math.round((Number(x) || 0) * 1e4) / 1e4;
const r8 = x => Math.round((Number(x) || 0) * 1e8) / 1e8;
const num = x => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const mean = a => a.length ? a.reduce((s, x) => s + Number(x || 0), 0) / a.length : 0;
const median = a => {
  if (!a.length) return 0;
  const x = [...a].sort((p, q) => p - q);
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
};
const stdev = a => {
  const m = mean(a);
  return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
};

export function modelScore(variant = {}, features = {}) {
  return FEATURES.reduce((s, k) => s + Number(variant.weights?.[k] || 0) * Number(features[k] || 0), 0) * 100;
}

export function sequentialCompoundMultiple(returns = []) {
  let wallet = 1;
  for (const r of returns) wallet *= Math.max(0.01, 1 + Number(r || 0) / 100);
  return wallet;
}

export function normalizeQuote(raw = {}) {
  const ts = num(raw.ts);
  const mint = String(raw.mint || raw.a?.mint || '');
  if (!ts || !mint) return null;
  const last = num(raw.price ?? raw.priceUsd ?? raw.last ?? raw.a?.priceUsd);
  const bid = num(raw.bid ?? raw.bidUsd ?? raw.a?.bidUsd);
  const ask = num(raw.ask ?? raw.askUsd ?? raw.a?.askUsd);
  const mid = last > 0 ? last : (bid > 0 && ask > 0 ? (bid + ask) / 2 : null);
  if (!(mid > 0) && !(bid > 0) && !(ask > 0)) return null;
  const liq = Math.max(0, num(raw.liq ?? raw.liquidity ?? raw.a?.liq ?? raw.a?.liquidity?.usd) || 0);
  const executionScore = num(raw.executionScore ?? raw.execution ?? raw.a?.executionScore) ?? 50;
  const kind = bid > 0 && ask > 0 ? 'bid-ask' : 'last-price';
  return {
    ts,
    mint,
    symbol: String(raw.symbol || raw.a?.symbol || mint.slice(0, 6)),
    last: mid > 0 ? mid : (bid > 0 ? bid : ask),
    bid: bid > 0 ? bid : null,
    ask: ask > 0 ? ask : null,
    liq,
    executionScore,
    staleResume: Boolean(raw.staleResume),
    kind,
    invented: false,
    source: raw.source || 'captured',
  };
}

function mapQuotes(rows, source) {
  const out = [];
  for (const row of rows || []) {
    const q = normalizeQuote({ ...row, source: row.source || source });
    if (q) out.push(q);
  }
  return sortQuotes(out);
}

export function sortQuotes(quotes = []) {
  return [...quotes].sort((a, b) => a.ts - b.ts || String(a.mint).localeCompare(String(b.mint)));
}

export function quotesFromReplayEvents(events = []) {
  return mapQuotes(events, 'replay-lab');
}

export function quotesFromTickHistory(tickHistory = {}) {
  const rows = [];
  for (const [mint, xs] of Object.entries(tickHistory || {})) {
    for (const x of xs || []) rows.push({ ...x, mint, source: x.source || 'tick-history' });
  }
  return mapQuotes(rows, 'tick-history');
}

export function quotesFromTokenObservations(rows = []) {
  return mapQuotes((rows || []).map(r => ({
    ts: r.ts,
    mint: r.mint,
    symbol: r.symbol,
    price: r.price,
    liq: r.liquidity ?? r.liq,
    executionScore: r.execution ?? r.executionScore,
    bid: r.bid,
    ask: r.ask,
    source: r.source || 'token-observations',
  })), 'token-observations');
}

export function groupQuotesByMint(quotes = []) {
  const map = new Map();
  for (const q of sortQuotes(quotes)) {
    const xs = map.get(q.mint) || [];
    xs.push(q);
    map.set(q.mint, xs);
  }
  return map;
}

export function executablePrices(quote, sim = {}) {
  const slip = Math.max(0, Number(sim.slippageBps || 0)) / 10000;
  const last = Number(quote.last || 0);
  const ask = quote.ask > 0 ? quote.ask : last * (1 + slip);
  const bid = quote.bid > 0 ? quote.bid : last * (1 - slip);
  return { bid, ask, last, kind: quote.bid > 0 && quote.ask > 0 ? 'bid-ask' : 'last-price+execution-model' };
}

/** Stop and target are first-hit on the executable bid. A gap through the stop fills at the gapped bid, not the stop. Time-exit is last. */
export function firstHitReason({ bid, stopPx, targetPx, heldMs, maxHoldMs }) {
  if (Number(bid) <= Number(stopPx)) return 'stop';
  if (Number(bid) >= Number(targetPx)) return 'target';
  if (Number(heldMs) >= Number(maxHoldMs)) return 'time-exit';
  return null;
}

function holdWindow(opportunity, variant = {}) {
  const entryTs = Number(opportunity.entryTs ?? opportunity.ts ?? 0);
  const maxHoldMin = Number(variant.maxHoldMin ?? opportunity.maxHoldMin ?? 5);
  return { entryTs, maxHoldMin, holdEnd: entryTs + Math.max(0, maxHoldMin) * 60_000 };
}

export function classifyOpportunityCoverage(opportunity = {}, quotes = [], variant = {}) {
  const { entryTs, maxHoldMin, holdEnd } = holdWindow(opportunity, variant);
  const mint = String(opportunity.mint || '');
  const mintQuotes = sortQuotes((quotes || []).filter(q => q.mint === mint));
  const inWindow = mintQuotes.filter(q => q.ts >= entryTs && q.ts <= holdEnd);
  const after = mintQuotes.filter(q => q.ts > entryTs && q.ts <= holdEnd);
  const interior = after.filter(q => q.ts < holdEnd);
  const hasReturn = Number.isFinite(Number(opportunity.returnPct));
  const lone5m = Number(opportunity.horizonMin) === 5 && hasReturn;
  const quoteKind = inWindow.some(q => q.kind === 'bid-ask' || (q.bid > 0 && q.ask > 0)) ? 'bid-ask' : 'last-price';
  const gaps = [];
  for (let i = 1; i < inWindow.length; i++) gaps.push(inWindow[i].ts - inWindow[i - 1].ts);
  const maxUnobservedGapMs = gaps.length ? Math.max(...gaps) : null;
  const base = {
    mint,
    entryTs,
    maxHoldMin,
    quoteCount: inWindow.length,
    interiorQuotes: interior.length,
    quoteKind,
    maxUnobservedGapMs,
    invented: false,
    promotionEligible: false,
  };
  if (!entryTs || !mint) {
    return { ...base, mode: 'missing-path', reason: 'invalid-opportunity', executable: false };
  }
  if (!inWindow.length) {
    return { ...base, mode: hasReturn ? 'proxy-only' : 'missing-path', reason: 'absent-quotes', executable: false };
  }
  if (lone5m && interior.length === 0) {
    return { ...base, mode: 'proxy-only', reason: 'five-minute-endpoint-only', executable: false };
  }
  if (after.length < 1 || (inWindow.length < 3 && after.length < 2)) {
    return { ...base, mode: hasReturn ? 'proxy-only' : 'insufficient-path', reason: 'insufficient-path', executable: false };
  }
  return {
    ...base,
    mode: 'executable',
    reason: 'captured-path',
    executable: true,
    promotionEligible: true,
  };
}

export function diagnoseCoverage(opportunities = [], quotes = [], variant = {}) {
  const byMint = groupQuotesByMint(quotes);
  const rows = [];
  const quoteKinds = { 'bid-ask': 0, 'last-price': 0, 'proxy-return': 0 };
  let executable = 0, proxyOnly = 0, missingPath = 0, interiorQuotes = 0;
  for (const o of opportunities || []) {
    const cov = classifyOpportunityCoverage(o, byMint.get(o.mint) || [], variant);
    rows.push(cov);
    if (cov.mode === 'executable') {
      executable++;
      interiorQuotes += cov.interiorQuotes;
      quoteKinds[cov.quoteKind === 'bid-ask' ? 'bid-ask' : 'last-price']++;
    } else if (cov.mode === 'proxy-only') {
      proxyOnly++;
      quoteKinds['proxy-return']++;
    } else {
      missingPath++;
    }
  }
  const mode = executable === 0 ? (proxyOnly ? 'proxy-only' : 'missing-path') : (proxyOnly || missingPath ? 'mixed' : 'executable');
  return {
    version: EXECUTABLE_REPLAY_VERSION,
    opportunities: (opportunities || []).length,
    quotes: (quotes || []).length,
    executableOpportunities: executable,
    proxyOnly,
    missingPath,
    interiorQuotes,
    quoteKinds,
    mode,
    inventedTicks: 0,
    promotionEligible: mode === 'executable' && executable > 0 && proxyOnly === 0,
    reasons: [...new Set(rows.map(r => r.reason).filter(Boolean))],
    rows,
  };
}

function markEquity(state, ts) {
  let eq = state.cash + state.censoredValue;
  for (const p of state.positions.values()) {
    const px = p.lastExitPx || p.lastPrice || p.entryPrice;
    eq += p.remainingBasis * (px / p.entryPrice);
  }
  state.curve.push({ ts, equity: eq });
  return eq;
}

function censorPosition(state, p, ts, reason, markPrice) {
  const px = Math.max(0, Number(markPrice ?? p.lastExitPx ?? p.lastPrice ?? p.entryPrice) || 0);
  const value = p.remainingBasis * (px / p.entryPrice);
  const markPnl = value - p.remainingBasis;
  state.censoredValue += value;
  state.censored++;
  state.censoredMarks.push({
    mint: p.mint, symbol: p.symbol, openedAt: p.openedAt, markedAt: ts, reason,
    entryPrice: p.entryPrice, markPrice: px, basis: p.initialBasis, markValue: value, markPnl,
    returnPct: p.initialBasis ? markPnl / p.initialBasis * 100 : 0,
  });
  state.exitReasons[reason] = (state.exitReasons[reason] || 0) + 1;
  state.positions.delete(p.mint);
}

function closePosition(state, p, ts, exitPx, sim, reason, extras = {}) {
  if (!deterministicFillAllowed(p.mint, ts, sim.failurePct)) {
    state.exitFailures++;
    return false;
  }
  const gross = p.remainingBasis * (exitPx / p.entryPrice);
  const fee = gross * Number(sim.feeBps || 0) / 10000;
  const net = gross - fee;
  const delta = net - p.remainingBasis;
  const pnl = delta + p.realizedPnl;
  state.cash += net;
  state.realizedPnl += delta;
  state.fees += fee;
  state.slippage += p.remainingBasis * Number(sim.slippageBps || 0) / 10000;
  state.turnover += p.remainingBasis;
  state.exitReasons[reason] = (state.exitReasons[reason] || 0) + 1;
  const stopPx = p.stopPx;
  const gapThroughStop = reason === 'stop' && exitPx < stopPx - 1e-12;
  state.trades.push({
    mint: p.mint,
    symbol: p.symbol,
    openedAt: p.openedAt,
    closedAt: ts,
    reason,
    censored: false,
    entryPrice: p.entryPrice,
    exitPrice: exitPx,
    stopPrice: stopPx,
    targetPrice: p.targetPx,
    basis: p.initialBasis,
    pnl,
    returnPct: p.initialBasis ? pnl / p.initialBasis * 100 : 0,
    holdMs: ts - p.openedAt,
    holdMin: (ts - p.openedAt) / 60000,
    gapThroughStop,
    gapLossPct: gapThroughStop && p.entryPrice ? (stopPx - exitPx) / p.entryPrice * 100 : 0,
    quoteKind: extras.quoteKind || p.quoteKind,
    invented: false,
  });
  state.positions.delete(p.mint);
  return true;
}

function considerExit(state, p, quote, variant, execution) {
  if (quote.staleResume) {
    censorPosition(state, p, quote.ts, 'stale-quotes', p.lastExitPx ?? p.lastPrice);
    return;
  }
  if (p.lastQuoteTs && quote.ts - p.lastQuoteTs > execution.staleMs) {
    censorPosition(state, p, p.lastQuoteTs, 'stale-quotes', p.lastExitPx ?? p.lastPrice);
    return;
  }
  const sim = estimatePaperExecution(
    { liq: quote.liq, executionScore: quote.executionScore },
    p.remainingBasis, state.solUsd, execution.baseSlippageBps, execution.feeBps,
  );
  const px = executablePrices(quote, sim);
  const heldMs = quote.ts - p.openedAt;
  const reason = firstHitReason({ bid: px.bid, stopPx: p.stopPx, targetPx: p.targetPx, heldMs, maxHoldMs: p.maxHoldMs });
  p.lastPrice = quote.last;
  p.lastExitPx = px.bid;
  p.lastQuoteTs = quote.ts;
  p.high = Math.max(p.high, px.bid);
  if (!reason) return;
  closePosition(state, p, quote.ts, px.bid, sim, reason, { quoteKind: px.kind });
}

function tryEnter(state, intent, quote, capital, execution, variant) {
  if (intent.coverage?.executable !== true) {
    state.proxySkipped++;
    return { ok: false, reason: intent.coverage?.reason || 'proxy-only' };
  }
  if (quote.staleResume) return { ok: false, reason: 'stale-quotes' };
  const wait = quote.ts - intent.fillAt;
  if (wait < 0) return { ok: false, reason: 'not-yet' };
  if (wait > execution.maxEntryWaitMs) return { ok: false, reason: 'missing-fill' };
  if (intent.prevQuote && quote.ts - intent.prevQuote.ts > execution.staleMs) {
    return { ok: false, reason: 'stale-quotes' };
  }
  if (state.positions.has(intent.mint)) return { ok: false, reason: 'already-open' };
  if (state.positions.size >= capital.maxPositions) return { ok: false, reason: 'position-limit' };

  const eq = markEquity(state, quote.ts);
  const depthCapSol = quote.liq > 0 ? (quote.liq / capital.solUsd) * capital.maxDepthPct : capital.startSol;
  const size = Math.min(eq * capital.sizePct, state.cash * capital.cashFraction, Math.max(0, depthCapSol));
  if (size < capital.minSizeSol) return { ok: false, reason: 'capital-exhaustion' };

  const sim = estimatePaperExecution(
    { liq: quote.liq, executionScore: quote.executionScore },
    size, capital.solUsd, execution.baseSlippageBps, execution.feeBps,
  );
  if (!deterministicFillAllowed(intent.mint, quote.ts, sim.failurePct)) {
    state.entryFailures++;
    return { ok: false, reason: 'failed-fill' };
  }
  const px = executablePrices(quote, sim);
  const fee = size * Number(sim.feeBps || 0) / 10000;
  if (state.cash < size + fee) return { ok: false, reason: 'capital-exhaustion' };

  const stopPct = Math.max(0, Number(variant.stopPct ?? intent.stopPct ?? 0));
  const takePct = Math.max(0, Number(variant.takePct ?? intent.takePct ?? 0));
  const maxHoldMin = Number(variant.maxHoldMin ?? intent.maxHoldMin ?? 5);
  state.cash -= size + fee;
  state.realizedPnl -= fee;
  state.fees += fee;
  state.slippage += size * Number(sim.slippageBps || 0) / 10000;
  state.turnover += size;
  state.positions.set(intent.mint, {
    mint: intent.mint,
    symbol: intent.symbol || quote.symbol,
    openedAt: quote.ts,
    signalTs: intent.entryTs,
    entryPrice: px.ask,
    high: px.ask,
    lastPrice: quote.last,
    lastExitPx: px.bid,
    lastQuoteTs: quote.ts,
    initialBasis: size,
    remainingBasis: size,
    realizedPnl: -fee,
    stopPx: px.ask * (1 - stopPct / 100),
    targetPx: px.ask * (1 + takePct / 100),
    maxHoldMs: maxHoldMin * 60_000,
    quoteKind: px.kind,
  });
  return { ok: true, reason: 'filled' };
}

function latencyMsFor(intent, quote, capital, execution) {
  if (execution.latencyMs != null) return Math.max(0, Number(execution.latencyMs) || 0);
  const eq = Math.max(capital.minSizeSol, capital.startSol * capital.sizePct);
  const sim = estimatePaperExecution(
    { liq: quote.liq, executionScore: quote.executionScore },
    eq, capital.solUsd, execution.baseSlippageBps, execution.feeBps,
  );
  return Math.max(0, Number(sim.latencyMs) || 0);
}

function metricsFromState(state, startSol, opportunityCount) {
  const trades = state.trades.filter(t => !t.censored);
  const pnls = trades.map(t => t.pnl);
  const rets = trades.map(t => t.returnPct);
  const wins = pnls.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const loss = Math.abs(pnls.filter(x => x < 0).reduce((a, b) => a + b, 0));
  let peak = startSol, dd = 0;
  for (const x of state.curve) {
    peak = Math.max(peak, x.equity);
    dd = Math.max(dd, peak ? 1 - x.equity / peak : 0);
  }
  const n = trades.length;
  const avg = mean(rets);
  const holdMins = trades.map(t => t.holdMin).filter(x => x > 0);
  const avgHold = mean(holdMins) || 0;
  const velocity = n ? mean(trades.map(t => t.returnPct / Math.max(1 / 60, t.holdMin || 0))) : 0;
  const finalEquity = state.curve.length ? state.curve.at(-1).equity : startSol;
  const sharedMultiple = startSol ? finalEquity / startSol : 1;
  return {
    n,
    avg: r4(avg),
    median: r4(median(rets)),
    winPct: r4(n ? trades.filter(t => t.pnl > 0).length / n * 100 : 0),
    worstPct: rets.length ? r4(Math.min(...rets)) : 0,
    velocity: r4(velocity),
    sharpe: n > 2 ? r4(avg / (stdev(rets) || 99) * Math.sqrt(n)) : -9,
    activityPct: r4(opportunityCount ? n / opportunityCount * 100 : 0),
    geometricMeanPct: r4(n ? (Math.pow(Math.max(1e-9, sharedMultiple), 1 / n) - 1) * 100 : 0),
    compoundedMultiple: r8(sharedMultiple),
    sequentialCompoundMultiple: r8(sequentialCompoundMultiple(rets)),
    maxDrawdownPct: r4(dd * 100),
    realizedPnl: r4(state.realizedPnl),
    finalEquity: r4(finalEquity),
    fees: r4(state.fees),
    slippageCost: r4(state.slippage),
    turnover: r4(state.turnover),
    censored: state.censored,
    exitFailures: state.exitFailures,
    entryFailures: state.entryFailures,
    exitReasons: { ...state.exitReasons },
    avgHoldMin: r4(avgHold),
    returns: rets,
  };
}

export function evaluateExecutableReplay({
  variant = {},
  opportunities = [],
  quotes = [],
  capital: capitalArg = {},
  execution: executionArg = {},
} = {}) {
  const capital = {
    startSol: 1,
    solUsd: 200,
    sizePct: 0.025,
    maxPositions: 4,
    maxDepthPct: 0.08,
    minSizeSol: MIN_SIZE_SOL,
    cashFraction: 0.9,
    ...capitalArg,
  };
  const execution = {
    feeBps: DEFAULT_FEE_BPS,
    baseSlippageBps: DEFAULT_BASE_SLIPPAGE_BPS,
    staleMs: STALE_QUOTE_MS,
    maxEntryWaitMs: 30_000,
    latencyMs: 0,
    ...executionArg,
  };
  const normalizedQuotes = sortQuotes((quotes || []).map(q => normalizeQuote(q)).filter(Boolean));
  const opps = (opportunities || []).map(o => ({
    ...o,
    mint: String(o.mint || ''),
    entryTs: Number(o.entryTs ?? o.ts ?? 0),
    symbol: o.symbol || String(o.mint || '').slice(0, 6),
    features: o.features || {},
  })).filter(o => o.mint && o.entryTs);
  const coverage = diagnoseCoverage(opps, normalizedQuotes, variant);
  const byMint = groupQuotesByMint(normalizedQuotes);
  const selected = opps.filter(o => {
    if (variant.threshold == null) return true;
    return modelScore(variant, o.features) >= Number(variant.threshold);
  }).sort((a, b) => a.entryTs - b.entryTs || a.mint.localeCompare(b.mint));

  const state = {
    cash: capital.startSol,
    solUsd: capital.solUsd,
    positions: new Map(),
    trades: [],
    censoredMarks: [],
    curve: [{ ts: selected[0]?.entryTs || 0, equity: capital.startSol }],
    fees: 0,
    slippage: 0,
    turnover: 0,
    censored: 0,
    censoredValue: 0,
    realizedPnl: 0,
    exitFailures: 0,
    entryFailures: 0,
    proxySkipped: 0,
    rejected: {},
    exitReasons: {},
  };
  const clock = new ReplayClock();
  const intents = selected.map(o => {
    const mintQuotes = byMint.get(o.mint) || [];
    const signalQuote = mintQuotes.find(q => q.ts >= o.entryTs) || mintQuotes.find(q => q.ts <= o.entryTs);
    const latency = latencyMsFor(o, signalQuote || { liq: 0, executionScore: 50 }, capital, execution);
    const fillAt = o.entryTs + latency;
    const prevQuote = [...mintQuotes].reverse().find(q => q.ts < fillAt) || null;
    return {
      ...o,
      fillAt,
      latencyMs: latency,
      prevQuote,
      coverage: classifyOpportunityCoverage(o, mintQuotes, variant),
      attempted: false,
    };
  });

  for (const quote of normalizedQuotes) {
    clock.set(quote.ts);
    const open = state.positions.get(quote.mint);
    if (open) considerExit(state, open, quote, variant, execution);
    for (const intent of intents) {
      if (intent.attempted || intent.mint !== quote.mint) continue;
      if (quote.ts < intent.fillAt) continue;
      intent.attempted = true;
      const result = tryEnter(state, intent, quote, capital, execution, variant);
      if (!result.ok) state.rejected[result.reason] = (state.rejected[result.reason] || 0) + 1;
    }
    markEquity(state, quote.ts);
  }

  for (const intent of intents) {
    if (!intent.attempted && intent.coverage?.executable === true) {
      state.rejected['missing-fill'] = (state.rejected['missing-fill'] || 0) + 1;
    }
  }
  const lastTs = normalizedQuotes.at(-1)?.ts || 0;
  for (const p of [...state.positions.values()]) {
    censorPosition(state, p, lastTs, 'missing-quotes', p.lastExitPx ?? p.lastPrice);
  }
  if (state.positions.size) markEquity(state, lastTs);

  const metrics = metricsFromState(state, capital.startSol, selected.length);
  const proxyDiagnostics = selected
    .filter(o => classifyOpportunityCoverage(o, byMint.get(o.mint) || [], variant).mode === 'proxy-only')
    .map(o => ({
      mint: o.mint,
      entryTs: o.entryTs,
      horizonMin: o.horizonMin ?? null,
      returnPct: Number.isFinite(Number(o.returnPct)) ? Number(o.returnPct) : null,
      inferredStopOrTarget: false,
      inferredHold: false,
    }));

  const promotion = promotionFromCoverage(coverage, metrics);
  return {
    version: EXECUTABLE_REPLAY_VERSION,
    mode: coverage.mode,
    variant: {
      id: variant.id || null,
      threshold: variant.threshold ?? null,
      stopPct: variant.stopPct ?? null,
      takePct: variant.takePct ?? null,
      maxHoldMin: variant.maxHoldMin ?? null,
    },
    metrics,
    trades: state.trades,
    censoredMarks: state.censoredMarks,
    rejected: state.rejected,
    coverage,
    proxyDiagnostics,
    promotion,
    curve: state.curve,
    live: false,
  };
}

export function promotionFromCoverage(coverage, metrics = {}) {
  const live = false;
  if (!coverage || coverage.mode !== 'executable') {
    return { eligible: false, reason: coverage?.mode === 'proxy-only' ? 'proxy-only' : 'insufficient-path-coverage', nextMode: null, live };
  }
  if (coverage.proxyOnly > 0) {
    return { eligible: false, reason: 'proxy-only', nextMode: null, live };
  }
  if (coverage.inventedTicks > 0) {
    return { eligible: false, reason: 'invented-ticks', nextMode: null, live };
  }
  if (Number(metrics.n || 0) < 50) {
    return { eligible: false, reason: 'sample-too-small', nextMode: null, live };
  }
  if (Number(metrics.realizedPnl || 0) <= 0) {
    return { eligible: false, reason: 'no-positive-edge', nextMode: null, live };
  }
  return { eligible: false, reason: 'research-only-not-wired', nextMode: 'shadow', live };
}
