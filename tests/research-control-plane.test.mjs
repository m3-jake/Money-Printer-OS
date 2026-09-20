import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordEvidenceControlPlane,
  readResearchControlPlane,
  recordChampionPublication,
  boundedChampionActivation,
  furnaceActivityView,
  leaderboardRows,
  attachControlPlaneToMonitor,
} from "../src/researchControlPlane.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = (stage = "RESEARCH_ONLY") => ({ evidence: { module: "solana", candidate: { id: "c1", hash: "h1" }, incumbentHash: "i1" }, gate: { stage, paperEligible: stage !== "RESEARCH_ONLY", reviewReady: stage === "REVIEW_READY" } });
const goodChampion = {
  id: "CHAMP",
  stage: "SHADOW",
  promotedAt: 1_000,
  previousId: "BASE",
  variant: { id: "CHAMP", threshold: 62, stopPct: 1.5, takePct: 100, maxHoldMin: 2, weights: { edge: .05, explosion: .16, execution: .08, momentum: .34, liquidity: .08, freshness: .07, flow: .11, volumeAccel: .04, priceAccel: .07 } },
  metrics: { heldOutAvgPct: 4.2, geometricMeanPct: 3.1, compoundedMultiple: 1.2, activityPct: 8.1, profitVelocityPctPerMin: 0.4, maxDrawdownPct: 6.5, monteCarloPassPct: 100, consistencyPct: 100, stressAvgPct: 18, heldOutN: 22, samples: 60, n: 22, robustScore: 12 },
};
const challenger = { id: "CHAL-1", parentId: "CHAMP", stage: "RESEARCH", heldOutAvgPct: 1.4, geometricMeanPct: 0.8, maxDrawdownPct: 9.1, monteCarloPassPct: 72, samples: 48, n: 18, consistencyPct: 61, promotedAt: 2_000 };

test("shared control plane persists lifecycle and milestones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpo-control-"));
  recordEvidenceControlPlane({ dataDir: dir, bundle: bundle(), now: 10 });
  recordEvidenceControlPlane({ dataDir: dir, bundle: bundle("PAPER_COMPARISON"), now: 20 });
  recordEvidenceControlPlane({ dataDir: dir, bundle: bundle("REVIEW_READY"), now: 30 });
  const s = readResearchControlPlane({ dataDir: dir, now: 40 });
  assert.equal(s.summary.total, 1);
  assert.equal(s.summary.byModule.solana, 1);
  assert.equal(s.experiments[0].lifecycle.stage, "REVIEW_READY");
  assert.equal(s.automaticLivePromotionAllowed, false);
  assert.equal(s.liveActivationAllowed, false);
  assert.equal(s.liveExecution, "manual");
  assert.equal(s.journal.rows.filter(x => x.kind === "research-lifecycle").length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("paper mode exposes furnace, champion, leaderboard, and paper-canary fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpo-plane-"));
  fs.writeFileSync(path.join(dir, "research-furnace.json"), JSON.stringify({ enabled: true, workers: 4, batchSize: 512 }));
  fs.writeFileSync(path.join(dir, "research-beast.json"), JSON.stringify({ enabled: true, gpu: true }));
  recordChampionPublication({ dataDir: dir, from: "BASE", to: "CHAMP", stage: "PAPER_CANARY", now: 3_000 });
  const loop = {
    generation: 7,
    variantsTested: 4096,
    workerCount: 4,
    researchMode: "BEAST",
    currentBatchSize: 128,
    currentBatchCompleted: 40,
    currentBatchStatus: "SCORING",
    updatedAt: 5_000,
    lastGenerationCompletedAt: 4_000,
    champion: goodChampion,
    challengers: [challenger],
    beastProfile: { enabled: true, gpu: true },
  };
  const s = readResearchControlPlane({ dataDir: dir, state: { evolutionLoop: loop }, mode: "paper", now: 6_000 });
  assert.equal(s.furnaceActivity.researchMode, "BEAST");
  assert.equal(s.furnaceActivity.enabled, true);
  assert.equal(s.furnaceActivity.beast, true);
  assert.equal(s.furnaceActivity.gpu, true);
  assert.equal(s.furnaceActivity.batchSize, 128);
  assert.equal(s.furnaceActivity.queueRemaining, 88);
  assert.equal(s.activeEvolutionPolicy.id, "CHAMP");
  assert.equal(s.activeEvolutionPolicy.stage, "PAPER_CANARY");
  assert.equal(s.activeEvolutionPolicy.applied, true);
  assert.equal(s.activeEvolutionPolicy.hotReload, true);
  assert.equal(s.activeEvolutionPolicy.liveActivationAllowed, false);
  assert.equal(s.latestChampion.id, "CHAMP");
  assert.equal(s.latestChampion.stage, "SHADOW");
  assert.equal(s.latestChampion.ageMs, 5_000);
  assert.equal(s.paperCanary.automated, true);
  assert.equal(s.paperCanary.stage, "PAPER_CANARY");
  assert.equal(s.paperCanary.championId, "CHAMP");
  assert.equal(s.paperCanary.liveExecution, "manual");
  assert.equal(s.leaderboard.length, 2);
  const champ = s.leaderboard[0];
  assert.equal(champ.config, "CHAMP");
  assert.equal(champ.status, "SHADOW");
  assert.equal(champ.decision, "evolution-champion");
  assert.equal(champ.validationPnlPct, 4.2);
  assert.equal(champ.shadowPnlPct, 4.2);
  assert.equal(champ.drawdownPct, 6.5);
  assert.equal(champ.trades, 22);
  assert.equal(champ.confidence, 100);
  assert.equal(champ.gate.live, false);
  assert.equal(s.journal.rows.some(x => x.kind === "champion-publication" && x.to === "CHAMP"), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("live mode never auto-applies a champion and stays safety-gated", () => {
  const activation = boundedChampionActivation({ mode: "live", champion: goodChampion, now: 6_000 });
  assert.equal(activation.applied, false);
  assert.equal(activation.policy.applied, false);
  assert.equal(activation.policy.hotReload, false);
  assert.equal(activation.policy.liveActivationAllowed, false);
  assert.equal(activation.policy.automaticLivePromotionAllowed, false);
  assert.equal(activation.paperCanary.automated, false);
  assert.equal(activation.paperCanary.stage, "INACTIVE");
  assert.equal(activation.liveExecution, "manual");
  const liveStage = boundedChampionActivation({ mode: "paper", champion: { ...goodChampion, stage: "LIVE" }, now: 6_000 });
  assert.equal(liveStage.applied, false);
  assert.equal(liveStage.paperCanary.automated, false);
});

test("furnace activity falls back to profile files when the loop is idle", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpo-furnace-"));
  fs.writeFileSync(path.join(dir, "research-furnace.json"), JSON.stringify({ enabled: true }));
  const idle = furnaceActivityView({}, { dataDir: dir, now: 1 });
  assert.equal(idle.enabled, true);
  assert.equal(idle.researchMode, "FURNACE");
  assert.equal(idle.beast, false);
  fs.writeFileSync(path.join(dir, "research-beast.json"), JSON.stringify({ enabled: true, gpu: false }));
  const beast = furnaceActivityView({}, { dataDir: dir, now: 1 });
  assert.equal(beast.researchMode, "BEAST");
  assert.equal(beast.beast, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("leaderboard rows keep activation visibility off live", () => {
  const rows = leaderboardRows({ champion: goodChampion, challengers: [challenger] }, { now: 3_000 });
  assert.equal(rows[0].gate.live, false);
  assert.equal(rows[0].gate.nextMode, "paper");
  assert.equal(rows[1].id, "CHAL-1");
  assert.equal(rows[1].status, "RESEARCH");
  assert.equal(rows[1].trades, 18);
  assert.equal(rows[1].confidence, 72);
});

test("research monitor contract attaches control-plane fields without dropping replay P/L", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpo-mon-"));
  const plane = readResearchControlPlane({
    dataDir: dir,
    state: { evolutionLoop: { champion: goodChampion, challengers: [challenger], researchMode: "FURNACE", generation: 3 } },
    mode: "paper",
    now: 4_000,
    includeJournal: false,
    includeExperiments: false,
  });
  const merged = attachControlPlaneToMonitor({
    schema: 1,
    source: "replay-lab",
    leaderboard: [{ config: "FAST", metrics: { n: 80, realizedPnl: 0.42, maxDrawdownPct: 3.2 }, gate: { eligible: false, reason: "shadow-candidate", live: false } }],
  }, plane, { now: 4_000 });
  assert.equal(merged.source, "replay-lab");
  assert.equal(merged.leaderboard[0].metrics.realizedPnl, 0.42);
  assert.equal(merged.leaderboard[0].trades, 80);
  assert.equal(merged.leaderboard[0].gate.live, false);
  assert.equal(merged.activeEvolutionPolicy.stage, "PAPER_CANARY");
  assert.equal(merged.latestChampion.id, "CHAMP");
  assert.equal(merged.furnaceActivity.researchMode, "FURNACE");
  assert.equal(merged.paperCanary.automated, true);
  assert.equal(merged.challengers[0].id, "CHAMP");
  assert.equal(merged.liveActivationAllowed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dashboard snapshot and monitor surfaces keep the control-plane contract", () => {
  const dash = fs.readFileSync(path.join(ROOT, "src", "dashboard.js"), "utf8");
  assert.match(dash, /activeEvolutionPolicy/);
  assert.match(dash, /furnaceActivity/);
  assert.match(dash, /latestChampion/);
  assert.match(dash, /paperCanary/);
  assert.match(dash, /liveActivationAllowed: false/);
  assert.match(dash, /attachControlPlaneToMonitor/);
  const engine = fs.readFileSync(path.join(ROOT, "src", "index.js"), "utf8");
  assert.match(engine, /recordChampionPublication/);
  assert.match(engine, /liveExecution:'manual'/);
  assert.doesNotMatch(engine, /cfg\.mode==='live'\?evolutionChampion/);
});

