export const LIFECYCLE_SCHEMA = "mpo.research-lifecycle.v1";

export const RESEARCH_STAGES = Object.freeze({
  RESEARCH: "RESEARCH",
  PAPER: "PAPER",
  REVIEW_READY: "REVIEW_READY",
  CANARY_REVIEW: "CANARY_REVIEW",
  CANARY: "CANARY",
  LIVE_REVIEW_READY: "LIVE_REVIEW_READY",
  LIVE_APPROVED: "LIVE_APPROVED",
  RETIRED: "RETIRED",
});

export const LIVE_CANARY_LIMITS = Object.freeze({
  maxCapitalFraction: 0.01,
  maxOpenExposureFraction: 0.005,
  maxDailyLossFraction: 0.0025,
  minClosedGroups: 20,
  maxDrawdownPct: 5,
});

const validModule = x => ["solana", "polymarket"].includes(String(x || "").toLowerCase());
const finite = x => Number.isFinite(Number(x));
const nowOf = x => finite(x) ? Number(x) : Date.now();
const clone = x => JSON.parse(JSON.stringify(x));

function assertModule(module) {
  const m = String(module || "").toLowerCase();
  if (!validModule(m)) throw new Error("module must be solana or polymarket");
  return m;
}

function event(type, from, to, reason, at, extra = {}) {
  return { type, from: from || null, to, reason: String(reason || ""), at: nowOf(at), ...extra };
}

function deriveEvidenceStage(gate = {}) {
  if (gate.reviewReady === true || gate.stage === "REVIEW_READY") return RESEARCH_STAGES.REVIEW_READY;
  if (gate.paperEligible === true || gate.stage === "PAPER_COMPARISON") return RESEARCH_STAGES.PAPER;
  return RESEARCH_STAGES.RESEARCH;
}

export function createResearchLifecycle({ module, candidateId, candidateHash = null, incumbentHash = null, gate = null, now = Date.now() } = {}) {
  const at = nowOf(now);
  const stage = deriveEvidenceStage(gate || {});
  return {
    schema: LIFECYCLE_SCHEMA,
    module: assertModule(module),
    candidateId: String(candidateId || candidateHash || "unknown"),
    candidateHash: candidateHash || null,
    incumbentHash: incumbentHash || null,
    stage,
    createdAt: at,
    updatedAt: at,
    automaticLivePromotionAllowed: false,
    humanApprovalRequiredForLive: true,
    evidence: gate ? clone(gate) : null,
    canary: null,
    history: [event("created", null, stage, gate?.stage || "candidate registered", at)],
  };
}

export function applyEvidenceGate(lifecycle, gate = {}, now = Date.now()) {
  if (!lifecycle || lifecycle.schema !== LIFECYCLE_SCHEMA) throw new Error("valid lifecycle required");
  const next = clone(lifecycle);
  const derived = deriveEvidenceStage(gate);
  const protectedStages = new Set([
    RESEARCH_STAGES.CANARY_REVIEW,
    RESEARCH_STAGES.CANARY,
    RESEARCH_STAGES.LIVE_REVIEW_READY,
    RESEARCH_STAGES.LIVE_APPROVED,
    RESEARCH_STAGES.RETIRED,
  ]);
  const at = nowOf(now);
  if (!protectedStages.has(next.stage) && next.stage !== derived) {
    next.history.push(event("evidence", next.stage, derived, gate?.stage || "evidence updated", at));
    next.stage = derived;
  }
  next.evidence = clone(gate);
  next.updatedAt = at;
  return next;
}

export function requestCanaryReview(lifecycle, { reason = "candidate passed paper comparison", now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.schema !== LIFECYCLE_SCHEMA) throw new Error("valid lifecycle required");
  if (lifecycle.stage !== RESEARCH_STAGES.REVIEW_READY) throw new Error("candidate must be REVIEW_READY before canary review");
  const next = clone(lifecycle), at = nowOf(now);
  next.history.push(event("canary-review-requested", next.stage, RESEARCH_STAGES.CANARY_REVIEW, reason, at));
  next.stage = RESEARCH_STAGES.CANARY_REVIEW;
  next.updatedAt = at;
  return next;
}

function normalizedRiskBudget(budget = {}) {
  const b = {
    maxCapitalFraction: Number(budget.maxCapitalFraction),
    maxOpenExposureFraction: Number(budget.maxOpenExposureFraction),
    maxDailyLossFraction: Number(budget.maxDailyLossFraction),
  };
  const l = LIVE_CANARY_LIMITS;
  if (!(b.maxCapitalFraction > 0 && b.maxCapitalFraction <= l.maxCapitalFraction)) throw new Error("canary capital fraction exceeds hard limit");
  if (!(b.maxOpenExposureFraction > 0 && b.maxOpenExposureFraction <= l.maxOpenExposureFraction)) throw new Error("canary exposure fraction exceeds hard limit");
  if (!(b.maxDailyLossFraction > 0 && b.maxDailyLossFraction <= l.maxDailyLossFraction)) throw new Error("canary daily-loss fraction exceeds hard limit");
  return b;
}

export function approveCanary(lifecycle, { humanApproved = false, approvedBy = null, riskBudget = {}, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.schema !== LIFECYCLE_SCHEMA) throw new Error("valid lifecycle required");
  if (lifecycle.stage !== RESEARCH_STAGES.CANARY_REVIEW) throw new Error("candidate must be in CANARY_REVIEW");
  if (humanApproved !== true) throw new Error("explicit human approval required for live canary");
  const budget = normalizedRiskBudget(riskBudget), at = nowOf(now), next = clone(lifecycle);
  next.canary = {
    approvedAt: at,
    approvedBy: approvedBy ? String(approvedBy) : "human",
    riskBudget: budget,
    automaticEscalationAllowed: false,
    closedGroups: 0,
    netReturnPct: null,
    maxDrawdownPct: null,
  };
  next.history.push(event("canary-approved", next.stage, RESEARCH_STAGES.CANARY, "explicit human approval", at, { riskBudget: budget }));
  next.stage = RESEARCH_STAGES.CANARY;
  next.updatedAt = at;
  return next;
}

export function assessCanary(lifecycle, metrics = {}, now = Date.now()) {
  if (!lifecycle || lifecycle.schema !== LIFECYCLE_SCHEMA) throw new Error("valid lifecycle required");
  if (lifecycle.stage !== RESEARCH_STAGES.CANARY) throw new Error("candidate must be in CANARY");
  const next = clone(lifecycle), at = nowOf(now);
  const closedGroups = Math.max(0, Math.floor(Number(metrics.closedGroups) || 0));
  const netReturnPct = Number(metrics.netReturnPct);
  const maxDrawdownPct = Number(metrics.maxDrawdownPct);
  const pass = closedGroups >= LIVE_CANARY_LIMITS.minClosedGroups
    && finite(netReturnPct) && netReturnPct > 0
    && finite(maxDrawdownPct) && maxDrawdownPct >= 0 && maxDrawdownPct <= LIVE_CANARY_LIMITS.maxDrawdownPct;
  next.canary = { ...(next.canary || {}), closedGroups, netReturnPct: finite(netReturnPct) ? netReturnPct : null, maxDrawdownPct: finite(maxDrawdownPct) ? maxDrawdownPct : null, lastAssessedAt: at };
  if (pass) {
    next.history.push(event("canary-assessed", next.stage, RESEARCH_STAGES.LIVE_REVIEW_READY, "canary evidence passed; live still requires human approval", at, { closedGroups, netReturnPct, maxDrawdownPct }));
    next.stage = RESEARCH_STAGES.LIVE_REVIEW_READY;
  } else {
    next.history.push(event("canary-assessed", next.stage, next.stage, "canary evidence not yet sufficient", at, { closedGroups, netReturnPct: finite(netReturnPct) ? netReturnPct : null, maxDrawdownPct: finite(maxDrawdownPct) ? maxDrawdownPct : null }));
  }
  next.updatedAt = at;
  return next;
}

export function approveLive(lifecycle, { humanApproved = false, approvedBy = null, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.schema !== LIFECYCLE_SCHEMA) throw new Error("valid lifecycle required");
  if (lifecycle.stage !== RESEARCH_STAGES.LIVE_REVIEW_READY) throw new Error("candidate must be LIVE_REVIEW_READY");
  if (humanApproved !== true) throw new Error("explicit human approval required for live approval");
  const next = clone(lifecycle), at = nowOf(now);
  next.history.push(event("live-approved", next.stage, RESEARCH_STAGES.LIVE_APPROVED, "explicit human approval", at, { approvedBy: approvedBy ? String(approvedBy) : "human" }));
  next.stage = RESEARCH_STAGES.LIVE_APPROVED;
  next.updatedAt = at;
  next.liveApprovedAt = at;
  next.liveApprovedBy = approvedBy ? String(approvedBy) : "human";
  next.automaticLivePromotionAllowed = false;
  return next;
}

export function retireCandidate(lifecycle, { reason = "retired", now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.schema !== LIFECYCLE_SCHEMA) throw new Error("valid lifecycle required");
  const next = clone(lifecycle), at = nowOf(now);
  if (next.stage !== RESEARCH_STAGES.RETIRED) next.history.push(event("retired", next.stage, RESEARCH_STAGES.RETIRED, reason, at));
  next.stage = RESEARCH_STAGES.RETIRED;
  next.updatedAt = at;
  return next;
}
