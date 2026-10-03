import crypto from "node:crypto";
import { recordEvidenceControlPlane } from "../src/researchControlPlane.js";

const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function recordPolymarketResearchReport({ dataDir = "data", report, now = Date.now() } = {}) {
  if (!report || report.schema !== "polymarket-research-tape/v1") throw new Error("valid Polymarket research report required");
  const candidateId = String(report.candidate?.strategyId || "unknown");
  const incumbentId = String(report.incumbent?.strategyId || "unknown");
  const candidateHash = hash({ module:"polymarket", strategyId:candidateId });
  const incumbentHash = hash({ module:"polymarket", strategyId:incumbentId });
  const bundle = {
    evidence: { module:"polymarket", candidate:{ id:candidateId, hash:candidateHash }, incumbentHash },
    gate: {
      module:"polymarket", candidateId, stage:"RESEARCH_ONLY", paperEligible:false, reviewReady:false, livePromotionAllowed:false,
      reasons:[{code:"FORMAL_EVIDENCE_REQUIRED",message:"Independent research result recorded; frozen post-selection evidence is still required."}],
    },
    observation: {
      datasetHash: report.dataset?.hash || null,
      independentGroups: Number(report.candidate?.independentEventCount || 0),
      netPnlUsd: Number(report.candidate?.netPnlUsd || 0),
      maxDrawdownUsd: Number(report.candidate?.maxDrawdownUsd || 0),
      researchEligible: report.promotion?.eligible === true,
      researchReason: report.promotion?.reason || null,
    },
    formalEvidence:false,
  };
  return recordEvidenceControlPlane({ dataDir, bundle, source:"polymarket-independent-research", now });
}
