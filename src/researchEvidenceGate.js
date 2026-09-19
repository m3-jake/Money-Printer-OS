/** Research evidence contract. Pure/read-only; never authorizes real orders. */
export const EVIDENCE_SCHEMA = 'mpo.research-evidence.v1';
export const POLICY = Object.freeze({minIndependentGroups:100, confidenceLevel:0.95, maxDrawdownPct:20});
const finite = x => typeof x === 'number' && Number.isFinite(x);
const text = x => typeof x === 'string' && x.trim().length > 0;
const integer = x => Number.isSafeInteger(x) && x > 0;

export function evaluateResearchEvidence(e = {}, now = Date.now()) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) e = {};
  const reasons = [];
  const add = (code, message, phase='sealed') => reasons.push({code, message, phase});
  const candidate = e.candidate || {};
  const search = e.search || {};
  if (e.schema !== EVIDENCE_SCHEMA) add('SCHEMA', 'Evidence schema is missing or unsupported.');
  if (!['solana','polymarket'].includes(e.module)) add('MODULE', 'A separate module-specific evaluation is required.');
  if (!text(candidate.id) || !text(candidate.hash) || !text(e.incumbentHash)) add('IDENTITY', 'Frozen candidate and incumbent identities are required.');
  if (!finite(candidate.frozenAt) || candidate.frozenAt <= 0 || candidate.frozenAt > now) add('FREEZE', 'Candidate must be frozen before evaluation.');
  if (!integer(search.trials) || !text(search.ledgerHash)) add('SEARCH_LEDGER', 'Record all search trials in an immutable ledger.');
  if (e.provenance !== 'observed') add('PROVENANCE', 'Synthetic fixtures cannot establish promotion evidence.');
  if (e.evaluator?.kind !== 'executable-path' || !text(e.evaluator?.version)) add('PROXY_ONLY', 'Endpoint/proxy scores need executable path replay.');
  for (const key of ['asOfSignals','costs','depth','latency','sharedCapital','eventGrouping']) {
    if (e.coverage?.[key] !== true) add('COVERAGE_'+key.toUpperCase(), 'Missing verified '+key+' coverage.');
  }
  const rankingEnd = search.rankingWindowEnd;
  if (!finite(rankingEnd) || rankingEnd <= 0 || rankingEnd > candidate.frozenAt) add('RANKING_WINDOW', 'Ranking data must end no later than candidate freeze.');
  function check(stage, phase) {
    const s = stage || {};
    const fail = (code,msg) => add(phase.toUpperCase()+'_'+code,msg,phase);
    if (s.candidateHash !== candidate.hash || s.incumbentHash !== e.incumbentHash || !text(s.candidateHash)) fail('IDENTITY','Evaluation must match the frozen candidate and incumbent.');
    if (!text(s.datasetHash) || !text(s.opportunitySetHash)) fail('DATASET','Record dataset and shared opportunity-set fingerprints.');
    if (s.sameOpportunities !== true || s.sameStartingCapital !== true) fail('COMPARISON','Compare candidate and incumbent on the same opportunities and starting capital.');
    if (!finite(s.startAt) || !finite(s.endAt) || s.startAt <= candidate.frozenAt || s.endAt <= s.startAt || s.endAt > now) fail('TIME','Evaluation must use a complete period after candidate freeze.');
    if (s.usedForSelection !== false) fail('SELECTION','Evaluation data must be excluded from tuning and ranking.');
    if (!integer(s.independentGroups) || s.independentGroups < POLICY.minIndependentGroups) fail('SAMPLES','Need at least '+POLICY.minIndependentGroups+' independent groups under the initial policy.');
    if (!finite(s.netReturnPct) || s.netReturnPct <= 0) fail('NET_RETURN','Candidate must be profitable after modeled costs.');
    if (!finite(s.incumbentNetReturnPct) || !finite(s.netReturnPct) || s.netReturnPct <= s.incumbentNetReturnPct) fail('IMPROVEMENT','Candidate must improve on the incumbent net of costs.');
    if (!finite(s.maxDrawdownPct) || s.maxDrawdownPct < 0 || s.maxDrawdownPct > POLICY.maxDrawdownPct) fail('DRAWDOWN','Drawdown is missing or exceeds the initial policy limit.');
    if (!finite(s.stressNetReturnPct) || s.stressNetReturnPct <= 0) fail('STRESS','Candidate must remain net positive under documented execution stress.');
    if (!text(s.stressModelHash)) fail('STRESS_MODEL','Record the stress assumptions.');
    const ci = s.improvementInterval || {};
    if (!finite(ci.lowerPct) || !finite(ci.upperPct) || ci.lowerPct <= 0 || ci.upperPct < ci.lowerPct || !finite(ci.level) || ci.level < POLICY.confidenceLevel || ci.level >= 1 || !text(ci.method) || ci.grouped !== true || !integer(ci.adjustedForTrials) || ci.adjustedForTrials < search.trials || !integer(search.trials)) fail('UNCERTAINTY','Need a positive grouped improvement interval accounting for the full recorded search.');
  }
  check(e.sealed, 'sealed');
  if (e.sealed?.auditCount !== 1 || e.sealed?.consumed !== true) add('SEALED_REUSE','Final audit must be recorded once and its window retired from future final exams.');
  const sealedPassed = reasons.length === 0;
  if (sealedPassed) {
    check(e.forward, 'forward');
    if (e.forward?.mode !== 'paper') add('FORWARD_MODE','Fresh comparison must be paper evidence.','forward');
    if (e.forward?.startAt <= e.sealed?.endAt || e.forward?.datasetHash === e.sealed?.datasetHash) add('FORWARD_REUSE','Forward comparison must use fresh data after the sealed audit.','forward');
  }
  const stage = !sealedPassed ? 'RESEARCH_ONLY' : reasons.length ? 'PAPER_COMPARISON' : 'REVIEW_READY';
  return {schema:EVIDENCE_SCHEMA, module:e.module || null, candidateId:candidate.id || null,
    stage, paperEligible:sealedPassed, reviewReady:stage === 'REVIEW_READY', livePromotionAllowed:false,
    policy:POLICY, reasons, improvementPct:finite(e.forward?.netReturnPct) && finite(e.forward?.incumbentNetReturnPct) ? e.forward.netReturnPct-e.forward.incumbentNetReturnPct : null};
}
