import fs from "node:fs";
import path from "node:path";
import { experimentFromEvidenceBundle, upsertExperiment, readExperimentRegistry, experimentSummary } from "./experimentRegistry.js";
import { appendLifecycleMilestone, appendProjectJournal, projectJournalSnapshot } from "./projectJournal.js";
import { evolutionChampionPolicy } from "./learner.js";

export const CONTROL_PLANE_SCHEMA = "mpo.research-control-plane.v1";
const SAFETY = Object.freeze({
  automaticLivePromotionAllowed: false,
  liveActivationAllowed: false,
  liveExecution: "manual",
});
const envFlag = name => {
  if (process.env[name] == null) return null;
  return ["1", "true", "yes", "on"].includes(String(process.env[name]).toLowerCase());
};
const readJson = file => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
const finite = x => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

export function controlPlaneFiles(dataDir = "data") {
  const root = path.resolve(dataDir);
  return {
    registry: path.join(root, "experiment-registry.json"),
    journal: path.join(root, "project-journal.ndjson"),
    furnace: path.join(root, "research-furnace.json"),
    beast: path.join(root, "research-beast.json"),
    loop: path.join(root, "evolution-loop.json"),
  };
}

export function recordEvidenceControlPlane({ dataDir = "data", bundle, source = "research-evidence", now = Date.now() } = {}) {
  const files = controlPlaneFiles(dataDir);
  const record = experimentFromEvidenceBundle(bundle, { source, now });
  const result = upsertExperiment(files.registry, record, { now });
  const before = result.prior?.lifecycle?.stage || null;
  const after = result.experiment.lifecycle?.stage || null;
  let milestone = null;
  if (before !== after) {
    const last = result.experiment.lifecycle?.history?.at?.(-1);
    milestone = appendLifecycleMilestone(files.journal, {
      module: record.module,
      candidateId: record.candidateId,
      from: before,
      to: after,
      reason: last?.reason || record.evidenceStage,
      at: now,
    });
  }
  return { schema: CONTROL_PLANE_SCHEMA, files, experiment: result.experiment, milestone };
}

export function recordChampionPublication({ dataDir = "data", from, to, stage = "PAPER_CANARY", reason, now = Date.now() } = {}) {
  const files = controlPlaneFiles(dataDir);
  return appendProjectJournal(files.journal, {
    kind: "champion-publication",
    category: "research",
    module: "solana",
    candidateId: to,
    from: from || null,
    to,
    title: `Champion ${to} published for ${stage}`,
    detail: reason || "bounded paper/shadow evaluation only; live execution remains manual",
    stage,
    liveActivationAllowed: false,
    automaticLivePromotionAllowed: false,
    at: now,
  });
}

export function compactChampionMetrics(m = {}) {
  return {
    heldOutAvgPct: finite(m.heldOutAvgPct),
    geometricMeanPct: finite(m.geometricMeanPct),
    compoundedMultiple: finite(m.compoundedMultiple),
    activityPct: finite(m.activityPct),
    profitVelocityPctPerMin: finite(m.profitVelocityPctPerMin),
    maxDrawdownPct: finite(m.maxDrawdownPct),
    monteCarloPassPct: finite(m.monteCarloPassPct),
    consistencyPct: finite(m.consistencyPct),
    stressAvgPct: finite(m.stressAvgPct),
    samples: finite(m.samples ?? m.n),
    heldOutN: finite(m.heldOutN),
    n: finite(m.n ?? m.samples),
    realizedPnl: finite(m.realizedPnl),
    robustScore: finite(m.robustScore),
  };
}

export function furnaceActivityView(loop = {}, { dataDir = "data", now = Date.now() } = {}) {
  const files = controlPlaneFiles(dataDir);
  const furnaceFile = readJson(files.furnace) || {};
  const beastFile = readJson(files.beast) || {};
  const furnaceEnv = envFlag("MPO_RESEARCH_FURNACE");
  const beastEnv = envFlag("MPO_RESEARCH_BEAST");
  const gpuEnv = envFlag("MPO_RESEARCH_GPU");
  const beastEnabled = !!(loop.beastProfile?.enabled || beastFile.enabled || beastEnv);
  const furnaceEnabled = !!(beastEnabled || loop.researchProfile?.enabled || furnaceFile.enabled || furnaceEnv);
  const researchMode = loop.researchMode || (beastEnabled ? "BEAST" : furnaceEnabled ? "FURNACE" : "NORMAL");
  const batchSize = Number(loop.currentBatchSize || loop.researchProfile?.effectiveBatchSize || loop.researchProfile?.batchSize || 0);
  const batchCompleted = Number(loop.currentBatchCompleted || 0);
  return {
    enabled: furnaceEnabled,
    researchMode,
    generation: Number(loop.generation || 0),
    activeGeneration: loop.activeGeneration ?? null,
    status: loop.currentBatchStatus || loop.status || "IDLE",
    workers: Number(loop.workerCount || loop.researchProfile?.workers || 0),
    batchSize,
    batchCompleted,
    queueRemaining: Math.max(0, batchSize - batchCompleted),
    gpu: !!(loop.beastProfile?.gpu || beastFile.gpu || gpuEnv),
    beast: beastEnabled,
    lastGenerationMs: Number(loop.lastGenerationMs || 0),
    lastGenerationCompletedAt: loop.lastGenerationCompletedAt || null,
    updatedAt: Number(loop.updatedAt || now),
  };
}

export function championPublicationView(champion = {}, { now = Date.now() } = {}) {
  const c = champion || {};
  const promotedAt = finite(c.promotedAt);
  return {
    id: c.id || "BASE",
    stage: c.stage || "BASE",
    previousId: c.previousId || null,
    promotedAt,
    ageMs: promotedAt != null ? Math.max(0, now - promotedAt) : null,
    variantId: c.variant?.id || c.id || "BASE",
    metrics: compactChampionMetrics(c.metrics || {}),
    liveActivationAllowed: false,
    automaticLivePromotionAllowed: false,
  };
}

export function normalizeLeaderboardRow(row = {}, { now = Date.now() } = {}) {
  const m = row.metrics || {};
  const promotedAt = finite(row.promotedAt ?? row.updatedAt ?? row.ts);
  const trades = finite(m.n ?? m.samples ?? row.trades);
  const validationPnlPct = finite(m.heldOutAvgPct ?? row.validationPnlPct);
  const shadowPnlPct = finite(row.shadowPnlPct ?? m.heldOutAvgPct ?? m.geometricMeanPct);
  const drawdownPct = finite(m.maxDrawdownPct ?? row.drawdownPct);
  const confidence = finite(m.monteCarloPassPct ?? m.consistencyPct ?? row.confidence);
  const gateReason = row.gate?.reason || row.decision || row.stage || "research";
  return {
    config: row.config || row.id || "unknown",
    id: row.id || row.config || "unknown",
    ageMs: promotedAt != null ? Math.max(0, now - promotedAt) : finite(row.ageMs),
    status: row.status || row.stage || "RESEARCH",
    decision: gateReason,
    validationPnlPct,
    shadowPnlPct,
    drawdownPct,
    trades,
    confidence,
    metrics: {
      ...compactChampionMetrics(m),
      n: trades,
      realizedPnl: finite(m.realizedPnl),
      heldOutAvgPct: validationPnlPct,
      maxDrawdownPct: drawdownPct,
      monteCarloPassPct: confidence,
    },
    gate: {
      eligible: row.gate?.eligible === true,
      reason: gateReason,
      nextMode: row.gate?.nextMode || null,
      live: false,
    },
  };
}

export function leaderboardRows(loop = {}, { now = Date.now(), limit = 12 } = {}) {
  const champion = loop.champion;
  const rows = [];
  if (champion?.id && champion.id !== "BASE") {
    rows.push(normalizeLeaderboardRow({
      id: champion.id,
      config: champion.id,
      stage: champion.stage || "SHADOW",
      status: champion.stage || "SHADOW",
      promotedAt: champion.promotedAt,
      metrics: champion.metrics || {},
      gate: { eligible: String(champion.stage || "") === "SHADOW" || String(champion.stage || "") === "PAPER_CANARY", reason: "evolution-champion", nextMode: "paper", live: false },
    }, { now }));
  }
  for (const x of loop.challengers || []) {
    if (!x?.id || rows.some(r => r.id === x.id)) continue;
    rows.push(normalizeLeaderboardRow({
      id: x.id,
      config: x.id,
      stage: x.stage || "RESEARCH",
      status: x.stage || "RESEARCH",
      promotedAt: x.promotedAt || loop.lastGenerationCompletedAt || loop.updatedAt,
      metrics: x,
      gate: { eligible: false, reason: x.stage || "research", nextMode: null, live: false },
    }, { now }));
  }
  return rows.slice(0, Math.max(1, Math.min(24, Number(limit) || 12)));
}

export function boundedChampionActivation({ mode = "paper", champion = null, persistedPolicy = null, labLink = null, now = Date.now() } = {}) {
  const paper = String(mode || "").toLowerCase() === "paper";
  const policy = evolutionChampionPolicy({ evolutionLoop: { champion }, labLink });
  const applied = paper && !!policy;
  const base = {
    ...SAFETY,
    hotReload: applied,
    applied,
  };
  const active = applied
    ? { ...policy, ...base, stage: "PAPER_CANARY" }
    : {
      id: paper ? "BASE" : (persistedPolicy?.id || champion?.id || "BASE"),
      sourceStage: champion?.stage || persistedPolicy?.sourceStage || "BASE",
      stage: paper ? "BASE" : (champion?.stage || persistedPolicy?.stage || "BASE"),
      ...base,
      hotReload: false,
    };
  return {
    applied,
    policy: active,
    paperCanary: {
      automated: applied,
      stage: applied ? "PAPER_CANARY" : "INACTIVE",
      championId: applied ? policy.id : null,
      sourceStage: policy?.sourceStage || champion?.stage || null,
      hotReload: applied,
      ...SAFETY,
    },
    latestChampion: championPublicationView(champion, { now }),
    liveExecution: "manual",
  };
}

export function attachControlPlaneToMonitor(monitor = {}, plane = {}, { now = Date.now() } = {}) {
  const replayRows = Array.isArray(monitor.leaderboard) && monitor.leaderboard.length
    ? monitor.leaderboard.map(row => normalizeLeaderboardRow(row, { now }))
    : null;
  return {
    ...monitor,
    furnaceActivity: plane.furnaceActivity,
    activeEvolutionPolicy: plane.activeEvolutionPolicy,
    latestChampion: plane.latestChampion,
    paperCanary: plane.paperCanary,
    leaderboard: replayRows || plane.leaderboard || [],
    challengers: plane.leaderboard || [],
    journalMilestones: plane.journal || { rows: [] },
    ...SAFETY,
  };
}

export function readResearchControlPlane({ dataDir = "data", journalLimit = 250, state = null, mode = "paper", now = Date.now(), includeJournal = true, includeExperiments = true } = {}) {
  const files = controlPlaneFiles(dataDir);
  const registry = includeExperiments ? readExperimentRegistry(files.registry) : { experiments: {}, updatedAt: null };
  const loop = state?.evolutionLoop || state?.evolution?.loop || readJson(files.loop) || {};
  const activation = boundedChampionActivation({
    mode,
    champion: loop.champion,
    persistedPolicy: state?.system?.activeEvolutionPolicy,
    labLink: state?.labLink,
    now,
  });
  const journal = includeJournal ? projectJournalSnapshot(files.journal, { limit: journalLimit }) : { schema: "mpo.project-journal.v1", total: 0, categories: {}, rows: [] };
  return {
    schema: CONTROL_PLANE_SCHEMA,
    updatedAt: Number(loop.updatedAt || registry.updatedAt || now),
    summary: experimentSummary(registry),
    experiments: includeExperiments ? Object.values(registry.experiments || {}).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)) : [],
    journal,
    furnaceActivity: furnaceActivityView(loop, { dataDir, now }),
    activeEvolutionPolicy: activation.policy,
    latestChampion: activation.latestChampion,
    leaderboard: leaderboardRows(loop, { now }),
    paperCanary: activation.paperCanary,
    ...SAFETY,
  };
}
