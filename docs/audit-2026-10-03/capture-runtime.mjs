// Read-only, allowlisted evidence. Never persist account payloads, credentials, raw journals or wallet identities.
import fs from 'node:fs';
const get = async (port, path) => {
  const start = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return { ms: Date.now() - start, body: await response.json() };
};
const at = new Date().toISOString();
const [health, state, board, rh, copy, coordinator, lab] = await Promise.all([
  get(8792, '/api/health'), get(8792, '/api/state'), get(8792, '/api/scoreboard'),
  get(8792, '/api/robinhood'), get(8792, '/api/copy-funnel'), get(8792, '/api/coordinator'), get(8793, '/api/state'),
]);
const selected = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const snapshot = {
  at, kind: 'read-only aggregate snapshot; changing runtime, not a benchmark',
  traderBuild: state.body.build,
  health: selected(health.body, ['ok', 'health', 'stalledVenues', 'venues', 'switches']),
  profiles: { trader: state.body.runtime?.profile, lab: lab.body.schedulerPolicy?.profile },
  scoreboard: { summary: board.body.summary, paperSummary: board.body.paperSummary, errors: board.body.errors,
    rows: board.body.rows.map(x => selected(x, ['id', 'module', 'book', 'kind', 'unit', 'closes', 'open', 'netPnl', 'beatsBaseline', 'reason', 'status', 'measurementScope', 'freshness'])) },
  robinhood: { strict: selected(rh.body.paper, ['cashUsd', 'startUsd', 'equityUsd', 'unrealizedUsd', 'stats', 'paramsHash', 'evaluations', 'qualification']),
    exploration: selected(rh.body.explore, ['enabled', 'countsTowardQualification', 'stats', 'equityUsd']),
    keyValid: rh.body.readiness?.keyValid, source: rh.body.readiness?.paperQuoteSource },
  copy: { books: copy.body.books.map(x => ({ ...selected(x, ['id', 'platform', 'unit', 'policy', 'paused', 'funnel', 'status']),
    afterCost: selected(x.afterCost, ['netPnl', 'qualified', 'independentPositions', 'unknownPnlSlices']) })),
    collection: selected(copy.body.indexer, ['status', 'dailyCredits', 'credits', 'remaining', 'backlog', 'calls', 'eventsToday', 'trackedMints', 'budgetSkips', 'paceSkips']) },
  pumpStudy: selected(state.body.pumpProfitCapture, ['state', 'entryStreamState', 'experimentPaused', 'baselineHash', 'liveExecutionAllowed', 'paidApiCallsAllowed', 'evidenceNote']),
  coordinator: { summary: coordinator.body.summary, executionAuthority: coordinator.body.executionAuthority,
    liveAuthority: coordinator.body.liveAuthority, modules: coordinator.body.modules.map(x => selected(x, ['id', 'stage', 'priority', 'bottleneck', 'nextAction', 'readiness'])) },
  lab: { build: lab.body.build, legacyStatus: lab.body.status?.status,
    modules: Object.entries(lab.body.modules || {}).map(([id, x]) => ({ id, ...selected(x, ['status', 'phase', 'paperPromotionAllowed', 'blockers', 'note', 'updatedAt']) })),
    resources: { cpu: selected(lab.body.resources?.cpu, ['logicalProcessors', 'machinePct', 'labPct', 'machineFresh', 'labFresh']),
      memory: selected(lab.body.resources?.memory, ['totalMiB', 'freeMiB', 'usedPct', 'labWorkingSetMiB']), gpuStatus: lab.body.resources?.gpuStatus },
    liveActivationAllowed: lab.body.liveActivationAllowed, automaticLivePromotionAllowed: lab.body.automaticLivePromotionAllowed },
  responseMs: { health: health.ms, state: state.ms, scoreboard: board.ms, robinhood: rh.ms, copyFunnel: copy.ms, coordinator: coordinator.ms, labState: lab.ms },
};
fs.writeFileSync(new URL('./runtime-snapshot.json', import.meta.url), JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify({ at, summary: snapshot.scoreboard.summary, paperSummary: snapshot.scoreboard.paperSummary,
  health: snapshot.health.health, stalledVenues: snapshot.health.stalledVenues, profiles: snapshot.profiles, pumpStudy: snapshot.pumpStudy.entryStreamState }));
