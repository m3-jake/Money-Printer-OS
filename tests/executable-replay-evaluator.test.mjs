import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeQuote, quotesFromReplayEvents, quotesFromTickHistory, quotesFromTokenObservations,
  classifyOpportunityCoverage, diagnoseCoverage, evaluateExecutableReplay, firstHitReason,
  sequentialCompoundMultiple, modelScore, FEATURES, EXECUTABLE_REPLAY_VERSION,
} from '../tools/executableReplayEvaluator.js';
import {
  EVOLUTION_EVALUATOR_CONTRACT, buildExecutableDataset, loadCapturedQuoteDataset,
  scoreVariantExecutable, gateExecutablePromotion, endpointClampContrast,
} from '../tools/executableReplayAdapter.js';
import { loadEvents, resolveReplayDataDir } from '../tools/replayLab.js';
import { estimatePaperExecution, deterministicFillAllowed } from '../src/executionSim.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const features = Object.fromEntries(FEATURES.map(k => [k, 0.8]));
const variant = { id: 'PATH', weights: Object.fromEntries(FEATURES.map(k => [k, 1 / FEATURES.length])), threshold: 10, stopPct: 8, takePct: 10, maxHoldMin: 5 };

function q(mint, ts, price, extra = {}) {
  return { ts: T0 + ts, mint, symbol: mint, price, last: price, liq: extra.liq ?? 100000, executionScore: extra.executionScore ?? 90, bid: extra.bid ?? price, ask: extra.ask ?? price, staleResume: extra.staleResume || false, source: extra.source || 'captured' };
}
function opp(mint, extra = {}) {
  return { mint, symbol: mint, entryTs: T0, features, ...extra };
}
const exec0 = { feeBps: 0, baseSlippageBps: 0, latencyMs: 0, maxEntryWaitMs: 60_000, staleMs: 30 * MIN };
const capital = { startSol: 1, solUsd: 200, sizePct: 0.25, maxPositions: 4, maxDepthPct: 0.5, minSizeSol: 0.002, cashFraction: 0.95 };

function replay(opportunities, quotes, v = variant, cap = capital, execution = exec0) {
  return evaluateExecutableReplay({ variant: v, opportunities, quotes, capital: cap, execution });
}

test('documented contract is frozen research-only and does not point at live', () => {
  assert.equal(EVOLUTION_EVALUATOR_CONTRACT.live, false);
  assert.equal(EVOLUTION_EVALUATOR_CONTRACT.promotion.proxyOnlyIneligible, true);
  assert.ok(EVOLUTION_EVALUATOR_CONTRACT.ownedFilesDoNotEdit.includes('src/evolutionLoop.js'));
  assert.ok(EVOLUTION_EVALUATOR_CONTRACT.ownedFilesDoNotEdit.includes('src/evolutionWorker.js'));
  assert.equal(EXECUTABLE_REPLAY_VERSION, 1);
});

test('import fence keeps executable replay off live/authenticated modules', () => {
  for (const file of ['executableReplayEvaluator.js', 'executableReplayAdapter.js']) {
    const s = fs.readFileSync(new URL(`../tools/${file}`, import.meta.url), 'utf8').toLowerCase();
    for (const bad of ['polymarket', 'jupiter', '@solana', './rpc', "from 'ws'", "from './store", "from './index", 'fetch(']) {
      assert.equal(s.includes(bad), false, `${file} forbidden ${bad}`);
    }
  }
});

test('first-hit prefers stop over target over time-exit; gap fills at the bid', () => {
  assert.equal(firstHitReason({ bid: 90, stopPx: 92, targetPx: 110, heldMs: 999999, maxHoldMs: 1 }), 'stop');
  assert.equal(firstHitReason({ bid: 112, stopPx: 92, targetPx: 110, heldMs: 999999, maxHoldMs: 1 }), 'target');
  assert.equal(firstHitReason({ bid: 100, stopPx: 92, targetPx: 110, heldMs: 300000, maxHoldMs: 300000 }), 'time-exit');
  assert.equal(firstHitReason({ bid: 100, stopPx: 92, targetPx: 110, heldMs: 1000, maxHoldMs: 300000 }), null);
});

test('equal endpoints with different paths produce different first-hit results', () => {
  const startEnd = [
    q('UP', 0, 100),
    q('UP', MIN, 112),
    q('UP', 5 * MIN, 105),
  ];
  const down = [
    q('DN', 0, 100),
    q('DN', MIN, 90),
    q('DN', 5 * MIN, 105),
  ];
  const upRes = replay([opp('UP')], startEnd);
  const dnRes = replay([opp('DN')], down);
  assert.equal(upRes.trades[0].reason, 'target');
  assert.equal(dnRes.trades[0].reason, 'stop');
  assert.equal(upRes.trades[0].exitPrice, 112);
  assert.equal(dnRes.trades[0].exitPrice, 90);
  assert.ok(dnRes.trades[0].gapThroughStop);
  assert.ok(upRes.trades[0].returnPct > 0);
  assert.ok(dnRes.trades[0].returnPct < 0);
  assert.equal(upRes.coverage.mode, 'executable');
  assert.equal(dnRes.mode, 'executable');
});

test('short-hold reward exploit: 5m endpoint is not credited at an earlier maxHold', () => {
  const quotes = [
    q('SH', 0, 100),
    q('SH', MIN, 101),
    q('SH', 2 * MIN, 102),
    q('SH', 3 * MIN, 103),
    q('SH', 5 * MIN, 150),
  ];
  const short = { ...variant, takePct: 40, maxHoldMin: 3 };
  const path = replay([opp('SH')], quotes, short);
  assert.equal(path.trades[0].reason, 'time-exit');
  assert.equal(path.trades[0].exitPrice, 103);
  assert.ok(path.trades[0].returnPct < 10, `path return ${path.trades[0].returnPct} should be the 3m quote, not the 5m spike`);
  const legacy = endpointClampContrast({ returnPct: 50, horizonMin: 5 }, short);
  assert.equal(legacy.clamped, 40);
  assert.ok(legacy.clamped > path.trades[0].returnPct);
});

test('gap-through-stop fills worse than the stop, not clamped to the stop', () => {
  const quotes = [q('GP', 0, 100), q('GP', MIN, 80), q('GP', 5 * MIN, 80)];
  const r = replay([opp('GP')], quotes, { ...variant, stopPct: 8, takePct: 50 });
  assert.equal(r.trades[0].reason, 'stop');
  assert.equal(r.trades[0].exitPrice, 80);
  assert.ok(r.trades[0].exitPrice < r.trades[0].stopPrice);
  assert.ok(r.trades[0].gapThroughStop);
  assert.ok(r.trades[0].gapLossPct > 0);
});

test('overlapping positions share cash and cannot sequentially compound the bankroll', () => {
  const quotes = [
    q('A', 0, 100), q('B', 0, 100),
    q('A', MIN, 110), q('B', MIN, 110),
    q('A', 5 * MIN, 110), q('B', 5 * MIN, 110),
  ];
  const cap = { ...capital, sizePct: 0.9, maxPositions: 2, minSizeSol: 0.2, cashFraction: 0.95 };
  const r = replay([opp('A'), opp('B')], quotes, { ...variant, takePct: 9 }, cap);
  const bases = r.trades.map(t => t.basis);
  assert.equal(r.rejected['capital-exhaustion'] || 0, 1);
  assert.equal(r.trades.length, 1);
  assert.ok(bases[0] <= 0.9 + 1e-9);
  assert.ok(bases.reduce((s, x) => s + x, 0) <= cap.startSol + 1e-9);
  const seq = sequentialCompoundMultiple([9, 9]);
  assert.ok(seq > 1.18, 'legacy sequential compound would reuse the whole bankroll');
  assert.ok(r.metrics.compoundedMultiple < seq);
});

test('shared-capital two fills stay inside startSol when both fit residual cash', () => {
  const quotes = [
    q('A', 0, 100), q('B', 0, 100),
    q('A', MIN, 110), q('B', MIN, 110),
    q('A', 5 * MIN, 110), q('B', 5 * MIN, 110),
  ];
  const cap = { ...capital, sizePct: 0.4, maxPositions: 2, minSizeSol: 0.002, cashFraction: 0.95 };
  const r = replay([opp('A'), opp('B')], quotes, { ...variant, takePct: 9 }, cap);
  assert.equal(r.trades.length, 2);
  const deployed = r.trades.reduce((s, t) => s + t.basis, 0);
  assert.ok(deployed <= 1 + 1e-9, `deployed ${deployed}`);
  assert.ok(r.metrics.sequentialCompoundMultiple >= r.metrics.compoundedMultiple - 1e-9);
});

test('stale quotes censor at the last good mark and do not invent a fill', () => {
  const quotes = [
    q('ST', 0, 100),
    q('ST', MIN, 101),
    q('ST', MIN + 31 * MIN, 140, { staleResume: true }),
  ];
  const r = replay([opp('ST')], quotes, { ...variant, takePct: 50, maxHoldMin: 60 });
  assert.equal(r.trades.length, 0);
  assert.equal(r.metrics.censored, 1);
  assert.equal(r.censoredMarks[0].reason, 'stale-quotes');
  assert.ok(r.censoredMarks[0].markPrice <= 101 + 1e-9);
  assert.equal(r.censoredMarks[0].invented, undefined);
});

test('absent quotes after a signal are a missing fill, not an invented tick', () => {
  const r = replay([opp('NO')], [q('NO', 0, 100)], variant);
  assert.equal(r.trades.length, 0);
  assert.ok((r.coverage.proxyOnly + r.coverage.missingPath) >= 1);
  assert.equal(r.coverage.inventedTicks, 0);
  assert.equal(r.promotion.eligible, false);
});

test('lone 5-minute return is proxy-only and ineligible for promotion', () => {
  const o = opp('PX', { horizonMin: 5, returnPct: 40, exitPrice: 140 });
  const quotes = [q('PX', 0, 100), q('PX', 5 * MIN, 140)];
  const cov = classifyOpportunityCoverage(o, quotes.map(normalizeQuote), variant);
  assert.equal(cov.mode, 'proxy-only');
  assert.equal(cov.reason, 'five-minute-endpoint-only');
  assert.equal(cov.executable, false);
  const r = replay([o], quotes, { ...variant, takePct: 8, maxHoldMin: 3 });
  assert.equal(r.mode, 'proxy-only');
  assert.equal(r.trades.length, 0);
  assert.equal(r.proxyDiagnostics[0].inferredStopOrTarget, false);
  assert.equal(r.proxyDiagnostics[0].inferredHold, false);
  assert.equal(r.promotion.eligible, false);
  assert.equal(r.promotion.reason, 'proxy-only');
  assert.equal(r.live, false);
});

test('failed and missing fills do not become winning exits', () => {
  const entryTs = T0;
  const low = { liq: 1, executionScore: 0 };
  const sizeSol = 0.25;
  const failPct = estimatePaperExecution(low, sizeSol, 200, 80, 25).failurePct;
  assert.ok(failPct > 0);
  let mint = '';
  for (let i = 0; i < 20000; i++) {
    const m = `FAIL${i}`;
    if (!deterministicFillAllowed(m, entryTs, failPct)) { mint = m; break; }
  }
  assert.ok(mint);
  const quotes = [
    { ts: entryTs, mint, price: 100, bid: 100, ask: 100, liq: 1, executionScore: 0 },
    { ts: entryTs + MIN, mint, price: 120, bid: 120, ask: 120, liq: 1, executionScore: 0 },
    { ts: entryTs + 5 * MIN, mint, price: 120, bid: 120, ask: 120, liq: 1, executionScore: 0 },
  ];
  const r = evaluateExecutableReplay({
    variant, opportunities: [opp(mint)], quotes,
    capital: { ...capital, sizePct: 0.25, maxDepthPct: 100 },
    execution: { ...exec0, feeBps: 25, baseSlippageBps: 80 },
  });
  assert.equal(r.trades.length, 0);
  assert.ok((r.metrics.entryFailures || 0) + (r.rejected['failed-fill'] || 0) >= 1);
});

test('entry latency waits for a captured quote and does not invent one', () => {
  const quotes = [q('LT', 0, 100), q('LT', 400, 104), q('LT', MIN, 104), q('LT', MIN + 400, 104), q('LT', 5 * MIN, 104)];
  const r = replay([opp('LT')], quotes, { ...variant, takePct: 50, maxHoldMin: 1 }, capital, { ...exec0, latencyMs: 200, maxEntryWaitMs: 1000 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entryPrice, 104);
  assert.ok(r.trades[0].openedAt >= T0 + 200);
  assert.notEqual(r.trades[0].entryPrice, 100);
});

test('time exit uses the actual quote timestamp, not the 5m label', () => {
  const quotes = [q('TM', 0, 100), q('TM', MIN, 101), q('TM', 2 * MIN, 102), q('TM', 4 * MIN, 103)];
  const r = replay([opp('TM')], quotes, { ...variant, stopPct: 90, takePct: 90, maxHoldMin: 2 });
  assert.equal(r.trades[0].reason, 'time-exit');
  assert.equal(r.trades[0].closedAt, T0 + 2 * MIN);
  assert.equal(r.trades[0].exitPrice, 102);
});

test('replayLab collector events attach as real paths with no invented timestamps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-exec-replay-'));
  try {
    const rows = [
      { type: 'scan-candidate', ts: T0, a: { mint: 'M1', symbol: 'M1', priceUsd: 1, liq: 50000, score: 80, executionScore: 80, eligible: true } },
      { type: 'scan-candidate', ts: T0 + MIN, a: { mint: 'M1', symbol: 'M1', priceUsd: 1.12, liq: 50000, score: 80, executionScore: 80, eligible: true } },
      { type: 'scan-candidate', ts: T0 + 5 * MIN, a: { mint: 'M1', symbol: 'M1', priceUsd: 1.05, liq: 50000, score: 80, executionScore: 80, eligible: true } },
    ];
    fs.writeFileSync(path.join(dir, 'market.ndjson'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    const ds = await loadEvents({ dataDir: dir });
    const quotes = quotesFromReplayEvents(ds.events);
    assert.equal(quotes.length, ds.events.length);
    const keys = new Set(ds.events.map(e => `${e.ts}:${e.mint}`));
    assert.ok(quotes.every(q => keys.has(`${q.ts}:${q.mint}`)));
    assert.ok(quotes.every(q => q.invented === false && q.source === 'replay-lab'));
    const dataset = buildExecutableDataset({
      outcomes: [{ mint: 'M1', entryTs: T0, features, horizonMin: 5, returnPct: 5 }],
      events: ds.events,
    });
    assert.equal(dataset.inventedTicks, 0);
    const scored = scoreVariantExecutable(variant, dataset, { capital, execution: exec0 });
    assert.equal(scored.live, false);
    assert.equal(scored.trades[0].reason, 'target');
    assert.equal(scored.contract, EVOLUTION_EVALUATOR_CONTRACT.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tickHistory and token_observations collectors normalize without inventing ticks', () => {
  const ticks = quotesFromTickHistory({ ZZ: [{ ts: T0, price: 1, liq: 9 }, { ts: T0 + MIN, price: 1.1, liq: 9 }] });
  const obs = quotesFromTokenObservations([{ ts: T0, mint: 'ZZ', price: 1, liquidity: 9, execution: 80 }]);
  assert.equal(ticks.length, 2);
  assert.equal(obs.length, 1);
  assert.ok(ticks.every(x => x.invented === false && x.source === 'tick-history'));
  assert.equal(obs[0].source, 'token-observations');
});

test('same inputs are deterministic', () => {
  const quotes = [q('D', 0, 100), q('D', MIN, 90), q('D', 5 * MIN, 90)];
  const a = replay([opp('D')], quotes);
  const b = replay([opp('D')], quotes);
  assert.deepEqual(a.metrics, b.metrics);
  assert.deepEqual(a.trades, b.trades);
});

test('adapter promotion stays off live and rejects proxy-only 5m labels', () => {
  const dataset = buildExecutableDataset({
    outcomes: [{ mint: 'P', entryTs: T0, features, horizonMin: 5, returnPct: 25 }],
    quotes: [q('P', 0, 100), q('P', 5 * MIN, 125)],
  });
  const scored = scoreVariantExecutable(variant, dataset, { capital, execution: exec0 });
  assert.equal(scored.mode, 'proxy-only');
  assert.equal(scored.promotion.eligible, false);
  assert.equal(scored.promotion.live, false);
  assert.equal(scored.promotion.reason, 'proxy-only');
  const gated = gateExecutablePromotion(variant, scored.metrics, scored.coverage);
  assert.equal(gated.live, false);
  assert.equal(gated.eligible, false);
});

test('coverage diagnostics report quote kinds and never count invented ticks', () => {
  const opps = [opp('C'), opp('P', { horizonMin: 5, returnPct: 3 })];
  const quotes = [q('C', 0, 100), q('C', MIN, 101), q('C', 5 * MIN, 102), q('P', 0, 1), q('P', 5 * MIN, 1.03)];
  const d = diagnoseCoverage(opps, quotes.map(normalizeQuote), variant);
  assert.equal(d.inventedTicks, 0);
  assert.equal(d.executableOpportunities, 1);
  assert.equal(d.proxyOnly, 1);
  assert.equal(d.mode, 'mixed');
  assert.equal(d.promotionEligible, false);
  assert.ok(d.quoteKinds['bid-ask'] >= 1);
});

test('modelScore matches the evolution feature list', () => {
  const w = Object.fromEntries(FEATURES.map(k => [k, 0]));
  w.edge = 1;
  assert.equal(modelScore({ weights: w }, { edge: 0.5 }), 50);
});

test('installed-app captured paths reuse collector timestamps when present', async () => {
  const resolved = resolveReplayDataDir();
  if (!resolved.found) {
    assert.equal(typeof resolved.dataDir, 'string');
    return;
  }
  const loaded = await loadCapturedQuoteDataset({ dataDir: resolved.dataDir, limitEvents: 80 });
  assert.ok(loaded.quotes.length <= 80);
  assert.equal(loaded.inventedTicks, 0);
  const keys = new Set(loaded.quotes.map(x => `${x.ts}:${x.mint}`));
  assert.equal(keys.size, loaded.quotes.length);
  assert.ok(loaded.quotes.every(x => x.invented === false));
});
