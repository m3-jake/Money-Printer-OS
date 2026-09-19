import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createResearchLifecycle, applyEvidenceGate, LIFECYCLE_SCHEMA } from "./researchLifecycle.js";

export const EXPERIMENT_REGISTRY_SCHEMA = "mpo.experiment-registry.v1";
const allowed = new Set(["solana", "polymarket"]);
const keyOf = ({ module, candidateHash, candidateId }) => `${String(module || "").toLowerCase()}:${candidateHash || candidateId || "unknown"}`;
const ensureParent = file => fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

function atomicJson(file, value) {
  ensureParent(file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readExperimentRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.schema !== EXPERIMENT_REGISTRY_SCHEMA || !parsed.experiments || typeof parsed.experiments !== "object") throw new Error("bad registry");
    return parsed;
  } catch {
    return { schema: EXPERIMENT_REGISTRY_SCHEMA, updatedAt: null, experiments: {} };
  }
}

export function experimentFromEvidenceBundle(bundle = {}, { source = "research-evidence", now = Date.now() } = {}) {
  const evidence = bundle.evidence || {};
  const gate = bundle.gate || {};
  const module = String(evidence.module || gate.module || "").toLowerCase();
  if (!allowed.has(module)) throw new Error("evidence bundle must identify solana or polymarket");
  const candidateId = evidence.candidate?.id || gate.candidateId || "unknown";
  const candidateHash = evidence.candidate?.hash || null;
  const incumbentHash = evidence.incumbentHash || null;
  return {
    schema: "mpo.experiment.v1",
    id: keyOf({ module, candidateHash, candidateId }),
    module,
    candidateId: String(candidateId),
    candidateHash,
    incumbentHash,
    source,
    evidenceStage: gate.stage || "RESEARCH_ONLY",
    paperEligible: gate.paperEligible === true,
    reviewReady: gate.reviewReady === true,
    automaticLivePromotionAllowed: false,
    evidence: bundle,
    observedAt: Number(now),
  };
}

export function upsertExperiment(file, record, { now = Date.now() } = {}) {
  if (!record || record.schema !== "mpo.experiment.v1") throw new Error("valid experiment record required");
  const registry = readExperimentRegistry(file), at = Number(now);
  const prior = registry.experiments[record.id] || null;
  let lifecycle;
  if (prior?.lifecycle?.schema === LIFECYCLE_SCHEMA) lifecycle = applyEvidenceGate(prior.lifecycle, record.evidence?.gate || {}, at);
  else lifecycle = createResearchLifecycle({ module: record.module, candidateId: record.candidateId, candidateHash: record.candidateHash, incumbentHash: record.incumbentHash, gate: record.evidence?.gate || {}, now: at });
  const next = {
    ...(prior || {}),
    ...record,
    createdAt: prior?.createdAt || at,
    updatedAt: at,
    lifecycle,
    automaticLivePromotionAllowed: false,
  };
  registry.experiments[record.id] = next;
  registry.updatedAt = at;
  atomicJson(file, registry);
  return { registry, experiment: next, prior };
}

export function experimentSummary(registryOrFile) {
  const reg = typeof registryOrFile === "string" ? readExperimentRegistry(registryOrFile) : (registryOrFile || { experiments: {} });
  const rows = Object.values(reg.experiments || {});
  const stages = {};
  for (const x of rows) stages[x.lifecycle?.stage || "UNKNOWN"] = (stages[x.lifecycle?.stage || "UNKNOWN"] || 0) + 1;
  return {
    total: rows.length,
    byModule: {
      solana: rows.filter(x => x.module === "solana").length,
      polymarket: rows.filter(x => x.module === "polymarket").length,
    },
    stages,
    automaticLivePromotionAllowed: false,
  };
}
