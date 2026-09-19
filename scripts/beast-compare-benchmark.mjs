#!/usr/bin/env node
/**
 * Same-corpus comparison: alpha45 baseline vs optimized CPU/RAM vs GPU-assisted.
 * Isolated research-only harness. Never loads store/state, never starts daemons,
 * never touches wallets, credentials, Polymarket, or the running app.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DEFAULT_OUT = path.join(REPO, 'artifacts', 'beast-compare');
const LOCKED_BASELINE = path.join(REPO, 'artifacts', 'beast-baseline', 'report.json');

const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-beast-compare-'));
process.env.MONEY_PRINTER_DATA_DIR = benchDir;
process.env.CLUSTER_HUB_URL = '';
delete process.env.MPO_RESEARCH_FURNACE;
delete process.env.MPO_RESEARCH_BEAST;
delete process.env.MPO_RESEARCH_GPU;
delete process.env.EVOLUTION_DAEMON;
delete process.env.MONEY_PRINTER_SUPERVISED;

const {
  DEFAULT_SEED, DEFAULT_ROWS, DEFAULT_VARIANTS, SCHEMA,
  buildCorpus, corpusHash, rankingFingerprint, evolutionPromotionGate,
  championTrusted, scoreWithProductionWorker, renderReport,
} = await import('./beast-baseline-benchmark.mjs');
const { packDataset, scoreVariantPacked, mulberry32, MC_ROUNDS_WORKER } = await import('../src/evolutionScoring.js');
const { EvolutionPool } = await import('../src/evolutionPool.js');
const { beastProfile, furnaceProfile, PROMOTION_GATES, promotionImproves, closePool } = await import('../src/evolutionEngine.js');
const { splitResearchRows, searchCoverage } = await import('../src/evolutionSearch.js');
const { probeGpu, scoreBeastGpu, resetGpuProbe } = await import('../src/evolutionGpu.js');
const { NUMERICAL_TOLERANCE, deterministicParity } = await import('../src/gpuFurnaceContract.js');

export const KIND = 'beast-compare-benchmark';

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const gitSha = () => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', timeout: 4000 }).trim(); }
  catch { return null; }
};

function measureSync() {
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 25);
  if (typeof sampler.unref === 'function') sampler.unref();
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  return {
    async done(value) {
      const wallMs = performance.now() - wall0;
      clearInterval(sampler);
      const cpu = process.cpuUsage(cpu0);
      const rssAfter = process.memoryUsage().rss;
      rssPeak = Math.max(rssPeak, rssAfter);
      const cpuMicros = cpu.user + cpu.system;
      return {
        value,
        wallMs,
        rssBefore, rssAfter, rssPeak,
        cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, cpuTotalMicros: cpuMicros,
        cpuProxyPct: wallMs > 0 ? (cpuMicros / 1000) / wallMs * 100 : null,
        cpuUtilPct: wallMs > 0 ? (cpuMicros / 1000) / wallMs / os.cpus().length * 100 : null,
      };
    },
  };
}

function publicGate(winner, incumbent, parentId = 'BASE') {
  const gate = evolutionPromotionGate(winner, incumbent, parentId);
  return {
    ...gate,
    winnerId: winner?.variant?.id || null,
    incumbentId: incumbent?.variant?.id || null,
    winnerTrusted: championTrusted(winner),
    incumbentTrusted: championTrusted(incumbent),
    improves: promotionImproves(winner, incumbent, parentId),
  };
}

function summarizeScored(scored, corpus) {
  const ranked = scored.filter(x => x.metrics).sort((a, b) => b.metrics.robustScore - a.metrics.robustScore);
  const parent = ranked.find(x => x.variant?.id === 'BASE') || { variant: corpus.variants[0], metrics: null };
  const winner = ranked[0] || null;
  const fingerprints = rankingFingerprint(ranked);
  return {
    scoredWithMetrics: ranked.length,
    scoredNull: scored.length - ranked.length,
    rankingFingerprint: fingerprints.topNHash,
    rankingOrderHash: fingerprints.rankingOrderHash,
    topN: fingerprints.topN,
    promotionGate: publicGate(winner, parent, 'BASE'),
    winnerId: winner?.variant?.id || null,
  };
}

function deterministicMaxAbs(a, b) {
  let maxAbs = 0;
  const n = Math.min(a.length, b.length);
  let mismatches = 0;
  for (let i = 0; i < n; i++) {
    const parity = deterministicParity(a[i]?.metrics, b[i]?.metrics);
    if (parity.maxAbs > maxAbs) maxAbs = parity.maxAbs;
    if (!parity.ok) mismatches++;
  }
  return { maxAbs, mismatches, compared: n, ok: mismatches === 0 && n > 0 && a.length === b.length };
}

async function scoreBaseline(corpus, { workers = 1, timeoutMs = 180000, seed = DEFAULT_SEED } = {}) {
  const m = measureSync();
  const scored = await scoreWithProductionWorker({
    variants: corpus.variants, rows: corpus.rows, workers, seed, timeoutMs,
  });
  const timed = await m.done(scored);
  return { ...timed, ...summarizeScored(scored, corpus), workers };
}

async function scoreCpuFast(corpus, { workers = 1, seed = DEFAULT_SEED } = {}) {
  const ds = packDataset(corpus.rows);
  const pool = new EvolutionPool({ size: workers });
  const m = measureSync();
  try {
    const scored = await pool.score(corpus.variants, ds, { rounds: MC_ROUNDS_WORKER, seed, chunkSize: 32 });
    const timed = await m.done(scored);
    return { ...timed, ...summarizeScored(scored, corpus), workers, poolStats: pool.stats() };
  } finally {
    await pool.close();
  }
}

async function scorePackedInProcess(corpus, { seed = DEFAULT_SEED } = {}) {
  const ds = packDataset(corpus.rows, { shared: false });
  const m = measureSync();
  const scored = corpus.variants.map((variant, i) => ({
    variant,
    metrics: scoreVariantPacked(variant, ds, { rounds: MC_ROUNDS_WORKER, rng: mulberry32((seed + i) >>> 0) }),
  }));
  const timed = await m.done(scored);
  return { ...timed, ...summarizeScored(scored, corpus), workers: 1 };
}

async function scoreGpu(corpus, { seed = DEFAULT_SEED, beast } = {}) {
  resetGpuProbe();
  const probeStarted = Date.now();
  const probe = await probeGpu({ timeoutMs: 8000 });
  const probeMs = Date.now() - probeStarted;
  const m = measureSync();
  const gpu = await scoreBeastGpu(corpus.variants, corpus.rows, { beast, seed, parentId: 'BASE' });
  const timed = await m.done(gpu);
  if (!gpu.ok) {
    return {
      ...timed,
      ok: false,
      reason: gpu.reason || 'gpu-unavailable',
      fallback: 'cpu',
      probe,
      probeMs,
      workers: 0,
      scoredWithMetrics: 0,
    };
  }
  return {
    ...timed,
    ok: true,
    ...summarizeScored(gpu.scored, corpus),
    probe,
    probeMs,
    sidecarMs: gpu.sidecarMs,
    peakMemoryMb: gpu.peakMemoryMb,
    device: gpu.device,
    deviceName: gpu.deviceName,
    vramBudgetMb: gpu.vramBudgetMb,
    recomputeRate: gpu.recomputeRate,
    rescored: gpu.rescored,
    parityMaxAbs: gpu.parityMaxAbs,
    workers: 0,
  };
}

function loadLockedBaseline() {
  try { return JSON.parse(fs.readFileSync(LOCKED_BASELINE, 'utf8')); }
  catch { return null; }
}

function witchdoctorGpuCitation() {
  const p = path.join(REPO, 'research', 'gpu-furnace', 'BENCHMARK_WITCHDOCTOR_20260916.md');
  try { return fs.readFileSync(p, 'utf8'); }
  catch { return null; }
}

export async function runCompare(opts = {}) {
  const seed = Number(opts.seed ?? DEFAULT_SEED) >>> 0;
  const rowCount = Math.max(80, Number(opts.rows ?? DEFAULT_ROWS) || DEFAULT_ROWS);
  const variantCount = Math.max(1, Number(opts.variants ?? DEFAULT_VARIANTS) || DEFAULT_VARIANTS);
  const timeoutMs = Math.max(5_000, Number(opts.timeoutMs ?? 180_000) || 180_000);
  const throughputWorkers = Math.max(1, Number(opts.throughputWorkers ?? Math.min(4, Math.max(1, os.cpus().length - 1))) || 1);
  const write = opts.write !== false;
  const outDir = opts.outDir || DEFAULT_OUT;

  fs.writeFileSync(path.join(benchDir, 'node-resource-policy.json'), JSON.stringify({
    cpuPercent: 80, memoryGB: Math.max(.25, Math.min(os.totalmem() / 1073741824 * .8, 4)),
    diskGB: 5, autoCoordinate: false, source: 'beast-compare', updatedAt: Date.now(),
  }));

  const corpus = buildCorpus({ seed, rowCount, variantCount });
  const hash = corpusHash(corpus);
  const locked = loadLockedBaseline();
  const furnace = furnaceProfile();
  const beast = beastProfile(furnace);
  const coverage = searchCoverage(corpus.variants);
  const sealed = splitResearchRows(corpus.rows, { sealedFraction: furnace.sealedFraction });
  const sealedMutated = structuredClone(corpus.rows);
  const cut = sealed.meta.available ? sealed.meta.ranking : corpus.rows.length;
  for (let i = cut; i < sealedMutated.length; i++) sealedMutated[i].returnPct = i % 2 ? 99 : -99;
  const sealedMutSplit = splitResearchRows(sealedMutated, { sealedFraction: furnace.sealedFraction });
  const sealedIntact = JSON.stringify(sealed.rankingRows) === JSON.stringify(sealedMutSplit.rankingRows);

  const baseline = await scoreBaseline(corpus, { workers: 1, timeoutMs, seed });
  const cpuFast1 = await scoreCpuFast(corpus, { workers: 1, seed });
  const cpuFastN = throughputWorkers > 1 ? await scoreCpuFast(corpus, { workers: throughputWorkers, seed }) : null;
  const packed = await scorePackedInProcess(corpus, { seed });
  const gpu = await scoreGpu(corpus, { seed, beast: { ...beast, enabled: true, gpu: true, gpuTimeoutMs: 15000, gpuVramMb: 2048, gpuParitySample: 4, gpuFinalists: 12, gpuRounds: MC_ROUNDS_WORKER } });

  const packedVsBaseline = deterministicMaxAbs(
    corpus.variants.map((v) => ({ metrics: packed.value.find(x => x.variant.id === v.id)?.metrics })),
    corpus.variants.map((v) => ({ metrics: baseline.value.find(x => x.variant.id === v.id)?.metrics })),
  );
  // Packed in-process vs pool (same per-variant seed) must match ranking fingerprints.
  const cpuParity = {
    rankingFingerprintMatch: packed.rankingFingerprint === cpuFast1.rankingFingerprint,
    rankingOrderMatch: packed.rankingOrderHash === cpuFast1.rankingOrderHash,
    promotionMatch: packed.promotionGate.stage === cpuFast1.promotionGate.stage
      && packed.promotionGate.winnerId === cpuFast1.promotionGate.winnerId
      && packed.promotionGate.promoted === cpuFast1.promotionGate.promoted,
  };
  const lockedParity = locked && rowCount === locked.datasetRows && corpus.variants.length === locked.candidateCount ? {
    corpusHashMatch: hash === locked.corpusHash,
    rankingFingerprintMatch: baseline.rankingFingerprint === locked.rankingFingerprint,
    rankingOrderMatch: baseline.rankingOrderHash === locked.rankingOrderHash,
    promotionMatch: baseline.promotionGate.stage === locked.promotionGate.stage
      && baseline.promotionGate.winnerId === locked.promotionGate.winnerId,
  } : null;

  const report = {
    schema: SCHEMA,
    kind: KIND,
    researchOnly: true,
    liveAppTouched: false,
    sourceCommit: gitSha(),
    generatedAt: new Date().toISOString(),
    seed,
    corpusHash: hash,
    candidateCount: corpus.variants.length,
    datasetRows: corpus.rows.length,
    hardware: {
      platform: process.platform, arch: process.arch, node: process.version,
      cpuThreads: os.cpus().length, memoryTotalBytes: os.totalmem(), hostname: os.hostname(),
    },
    promotionGates: PROMOTION_GATES,
    numericalTolerance: NUMERICAL_TOLERANCE,
    beastDefault: { enabled: beastProfile().enabled, gpu: beastProfile().gpu, workers: beast.workers, batchSize: beast.batchSize, ramTargetGB: beast.ramTargetGB, cpuPercent: beast.cpuPercent, gpuVramMb: beast.gpuVramMb, cpuFallback: true },
    furnace: { enabled: furnace.enabled, batchSize: furnace.batchSize, throughputVerifiedBatchSize: furnace.throughputVerifiedBatchSize, sealedFraction: furnace.sealedFraction },
    searchCoverage: coverage,
    sealed: { available: sealed.meta.available, ranking: sealed.rankingRows.length, sealed: sealed.sealedRows.length, selectionUse: false, intactUnderMutation: sealedIntact },
    modes: {
      baseline: {
        wallMs: +baseline.wallMs.toFixed(1),
        variantsPerSec: +((baseline.value.length / (baseline.wallMs / 1000)) || 0).toFixed(3),
        workers: 1,
        rssPeakMB: +(baseline.rssPeak / 1048576).toFixed(2),
        cpuProxyPct: baseline.cpuProxyPct != null ? +baseline.cpuProxyPct.toFixed(1) : null,
        rankingFingerprint: baseline.rankingFingerprint,
        rankingOrderHash: baseline.rankingOrderHash,
        promotionGate: baseline.promotionGate.stage,
        promoted: baseline.promotionGate.promoted,
        winnerId: baseline.winnerId,
        startupMs: null,
      },
      cpuFast1: {
        wallMs: +cpuFast1.wallMs.toFixed(1),
        variantsPerSec: +((cpuFast1.value.length / (cpuFast1.wallMs / 1000)) || 0).toFixed(3),
        workers: 1,
        rssPeakMB: +(cpuFast1.rssPeak / 1048576).toFixed(2),
        cpuProxyPct: cpuFast1.cpuProxyPct != null ? +cpuFast1.cpuProxyPct.toFixed(1) : null,
        rankingFingerprint: cpuFast1.rankingFingerprint,
        rankingOrderHash: cpuFast1.rankingOrderHash,
        promotionGate: cpuFast1.promotionGate.stage,
        promoted: cpuFast1.promotionGate.promoted,
        winnerId: cpuFast1.winnerId,
        duplicateRate: coverage.duplicateRate,
        recomputeRate: 0,
      },
      cpuFastN: cpuFastN ? {
        wallMs: +cpuFastN.wallMs.toFixed(1),
        variantsPerSec: +((cpuFastN.value.length / (cpuFastN.wallMs / 1000)) || 0).toFixed(3),
        workers: throughputWorkers,
        rssPeakMB: +(cpuFastN.rssPeak / 1048576).toFixed(2),
        cpuProxyPct: cpuFastN.cpuProxyPct != null ? +cpuFastN.cpuProxyPct.toFixed(1) : null,
        rankingFingerprint: cpuFastN.rankingFingerprint,
        rankingOrderHash: cpuFastN.rankingOrderHash,
        promotionGate: cpuFastN.promotionGate.stage,
        promoted: cpuFastN.promotionGate.promoted,
        winnerId: cpuFastN.winnerId,
      } : null,
      gpu: {
        ok: !!gpu.ok,
        reason: gpu.reason || null,
        fallback: gpu.ok ? null : (gpu.fallback || 'cpu'),
        wallMs: +gpu.wallMs.toFixed(1),
        probeMs: gpu.probeMs,
        sidecarMs: gpu.sidecarMs || null,
        variantsPerSec: gpu.ok ? +((corpus.variants.length / (gpu.wallMs / 1000)) || 0).toFixed(3) : null,
        rssPeakMB: +(gpu.rssPeak / 1048576).toFixed(2),
        peakMemoryMb: gpu.peakMemoryMb || null,
        device: gpu.device || gpu.probe?.device || null,
        deviceName: gpu.deviceName || gpu.probe?.deviceName || null,
        vramBudgetMb: gpu.vramBudgetMb || null,
        recomputeRate: gpu.recomputeRate || null,
        rankingFingerprint: gpu.rankingFingerprint || null,
        promotionGate: gpu.promotionGate?.stage || null,
        winnerId: gpu.winnerId || null,
        parityMaxAbs: gpu.parityMaxAbs ?? null,
      },
    },
    parity: {
      locked: lockedParity,
      cpuPackedVsPool: cpuParity,
      promotionGatesUnchanged: JSON.stringify(PROMOTION_GATES) === JSON.stringify({
        robustScoreMargin: 1.0, minHeldOutAvgPct: 0, minHeldOutN: 12, minSamples: 40,
        minActivityPct: 8, minStressAvgPct: -2, minMonteCarloPassPct: 70, minConsistencyPct: 50,
      }),
      gpuAccepted: !!gpu.ok,
      packedVsBaseline: packedVsBaseline,
    },
    speedup: {
      cpuFast1VsBaseline: baseline.wallMs > 0 ? +((cpuFast1.value.length / (cpuFast1.wallMs / 1000)) / (baseline.value.length / (baseline.wallMs / 1000))).toFixed(2) : null,
      cpuFastNVsBaseline: cpuFastN && baseline.wallMs > 0 ? +((cpuFastN.value.length / (cpuFastN.wallMs / 1000)) / (baseline.value.length / (baseline.wallMs / 1000))).toFixed(2) : null,
    },
    recommendations: null,
    witchdoctorGpu: {
      source: 'research/gpu-furnace/BENCHMARK_WITCHDOCTOR_20260916.md',
      device: 'WITCHDOCTOR NVIDIA GeForce RTX 5070',
      variants: 4097, rows: 3000, rounds: 90, dtype: 'float64',
      wallMs: 657.87, variantsPerSec: 6227.7, peakVramMb: 1188.423,
      deterministicMaxAbs: 4.263256414560601e-14,
    },
    priorCpuThroughput: {
      source: 'task 20260916-175609-f1e6e / npm run bench:evolution',
      variants: 2048, rows: 3000, generations: 3,
      legacyVariantsPerSec: 2134.5, fastVariantsPerSec: 2558, speedupX: 1.20,
    },
  };

  const nFaster = cpuFastN && cpuFastN.wallMs < cpuFast1.wallMs;
  const recWorkers = nFaster ? throughputWorkers : 1;
  const recBatch = beast.batchSize;
  const recRam = +Math.max(0.8, recWorkers * 0.4).toFixed(1);
  const recVram = 2048;
  const acceptCpu = report.parity.promotionGatesUnchanged && report.parity.cpuPackedVsPool.promotionMatch && report.parity.locked?.promotionMatch !== false;
  const acceptGpu = !!gpu.ok;
  report.recommendations = {
    acceptCpuRamFastPath: !!acceptCpu,
    acceptGpuDefault: false,
    acceptGpuOptIn: acceptGpu,
    reason: acceptGpu
      ? 'CUDA sidecar passed parity on this host; keep GPU opt-in behind MPO_RESEARCH_GPU with CPU finalist rescore.'
      : `GPU not accepted as default (${gpu.reason || 'unavailable'}). BEAST uses the packed CPU/RAM fast path; extra workers are only recommended when they beat 1-worker wall time.`,
    workers: recWorkers,
    batchSize: recBatch,
    ramTargetGB: recRam,
    cpuPercent: Math.min(80, beast.cpuPercent || 65),
    gpuBatch: 4096,
    gpuVramMb: recVram,
    gpuFinalists: 'deterministic-floor (robustScore MC ≤ +10) plus at least 12',
    observedSpeedupX: nFaster ? report.speedup.cpuFastNVsBaseline : report.speedup.cpuFast1VsBaseline,
  };

  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outDir, 'REPORT.md'), renderCompare(report));
  }
  await closePool();
  return report;
}

export function renderCompare(r) {
  const m = r.modes || {};
  const rec = r.recommendations || {};
  const lines = [
    '# BEAST furnace final benchmark',
    '',
    'Research-only comparison of baseline alpha45 scoring vs optimized CPU/RAM vs GPU-assisted modes on the same frozen corpus. Live execution, wallet, credentials, order sizing, Polymarket, and the running app were not touched.',
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| generatedAt | ${r.generatedAt} |`,
    `| sourceCommit | ${r.sourceCommit} |`,
    `| corpusHash | ${r.corpusHash} |`,
    `| candidates | ${r.candidateCount} |`,
    `| rows | ${r.datasetRows} |`,
    `| seed | ${r.seed} |`,
    `| hardware | ${r.hardware?.platform} ${r.hardware?.arch} ${r.hardware?.cpuThreads} threads node ${r.hardware?.node} |`,
    `| sealed intact | ${r.sealed?.intactUnderMutation} (ranking ${r.sealed?.ranking} / sealed ${r.sealed?.sealed}, selectionUse=${r.sealed?.selectionUse}) |`,
    `| duplicateRate | ${r.searchCoverage?.duplicateRate} |`,
    `| promotion gates locked | ${r.parity?.promotionGatesUnchanged} |`,
    `| locked corpus match | ${r.parity?.locked?.corpusHashMatch} |`,
    `| locked ranking match | ${r.parity?.locked?.rankingFingerprintMatch} |`,
    '',
    '## Modes',
    '',
    `| Mode | variants/sec | wall ms | workers | RSS peak MB | CPU proxy % | promotion | winner |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |`,
    `| baseline (seeded worker) | ${m.baseline?.variantsPerSec} | ${m.baseline?.wallMs} | ${m.baseline?.workers} | ${m.baseline?.rssPeakMB} | ${m.baseline?.cpuProxyPct} | ${m.baseline?.promotionGate} | ${m.baseline?.winnerId} |`,
    `| CPU/RAM fast (1 worker) | ${m.cpuFast1?.variantsPerSec} | ${m.cpuFast1?.wallMs} | ${m.cpuFast1?.workers} | ${m.cpuFast1?.rssPeakMB} | ${m.cpuFast1?.cpuProxyPct} | ${m.cpuFast1?.promotionGate} | ${m.cpuFast1?.winnerId} |`,
  ];
  if (m.cpuFastN) {
    lines.push(`| CPU/RAM fast (${m.cpuFastN.workers} workers) | ${m.cpuFastN.variantsPerSec} | ${m.cpuFastN.wallMs} | ${m.cpuFastN.workers} | ${m.cpuFastN.rssPeakMB} | ${m.cpuFastN.cpuProxyPct} | ${m.cpuFastN.promotionGate} | ${m.cpuFastN.winnerId} |`);
  }
  lines.push(`| GPU-assisted | ${m.gpu?.ok ? m.gpu.variantsPerSec : 'FALLBACK'} | ${m.gpu?.wallMs} | 0 | ${m.gpu?.rssPeakMB} | — | ${m.gpu?.promotionGate || m.gpu?.reason} | ${m.gpu?.winnerId || m.gpu?.reason} |`);
  lines.push('', '## GPU', '');
  lines.push(`This host: ok=${m.gpu?.ok} reason=${m.gpu?.reason || 'n/a'} probeMs=${m.gpu?.probeMs} device=${m.gpu?.deviceName || m.gpu?.device || 'none'} recomputeRate=${m.gpu?.recomputeRate}.`);
  lines.push('');
  lines.push(`Cited WITCHDOCTOR RTX 5070 (4097×3000, 90-round float64): **${r.witchdoctorGpu.variantsPerSec} variants/sec**, wall ${r.witchdoctorGpu.wallMs} ms, peak VRAM ${r.witchdoctorGpu.peakVramMb} MB, deterministic max abs ${r.witchdoctorGpu.deterministicMaxAbs}.`);
  lines.push('');
  lines.push('## Prior CPU throughput corpus (2048×3000, not the parity corpus)', '');
  lines.push(`Legacy ${r.priorCpuThroughput.legacyVariantsPerSec} → fast ${r.priorCpuThroughput.fastVariantsPerSec} variants/sec (**${r.priorCpuThroughput.speedupX}×**).`);
  lines.push('', '## Integration decision', '');
  lines.push(`- CPU/RAM fast path: **${rec.acceptCpuRamFastPath ? 'ACCEPT' : 'REJECT'}** into opt-in BEAST (default GPU off).`);
  lines.push(`- GPU default: **REJECT**. GPU opt-in: **${rec.acceptGpuOptIn ? 'ACCEPT if CUDA+parity' : 'fallback-only on this host'}**.`);
  lines.push(`- ${rec.reason}`);
  lines.push('', '## Recommended BEAST knobs', '');
  lines.push(`| Knob | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| workers | ${rec.workers} |`);
  lines.push(`| batchSize | ${rec.batchSize} |`);
  lines.push(`| ramTargetGB | ${rec.ramTargetGB} |`);
  lines.push(`| cpuPercent | ${rec.cpuPercent} |`);
  lines.push(`| GPU batch | ${rec.gpuBatch} |`);
  lines.push(`| GPU VRAM target | ${rec.gpuVramMb} MB |`);
  lines.push(`| GPU finalists | ${rec.gpuFinalists} |`);
  lines.push(`| observed speedup (this corpus) | ${rec.observedSpeedupX}× |`);
  lines.push('');
  lines.push('Enable with `MPO_RESEARCH_BEAST=1`. GPU additionally requires `MPO_RESEARCH_GPU=1` and a CUDA sidecar; any probe/parity/timeout failure falls back to CPU. Champions remain SHADOW/RESEARCH. No live promotion.');
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const nxt = argv[i + 1];
    if (nxt == null || nxt.startsWith('--')) out[key] = true;
    else { out[key] = nxt; i++; }
  }
  return out;
}

export function isMainModule(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(argv1); }
  catch { return false; }
}

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  const report = await runCompare({
    seed: args.seed,
    rows: args.rows,
    variants: args.variants,
    throughputWorkers: args['throughput-workers'],
    timeoutMs: args.timeout,
    outDir: args.out,
    write: args['no-write'] ? false : true,
  });
  try { fs.rmSync(benchDir, { recursive: true, force: true }); } catch {}
  console.log(JSON.stringify({
    ok: true,
    researchOnly: true,
    candidateCount: report.candidateCount,
    datasetRows: report.datasetRows,
    corpusHash: report.corpusHash,
    baselineVariantsPerSec: report.modes.baseline.variantsPerSec,
    cpuFastVariantsPerSec: report.modes.cpuFastN?.variantsPerSec || report.modes.cpuFast1.variantsPerSec,
    gpu: report.modes.gpu.ok ? report.modes.gpu.variantsPerSec : report.modes.gpu.reason,
    speedupX: report.recommendations.observedSpeedupX,
    acceptCpu: report.recommendations.acceptCpuRamFastPath,
    acceptGpuDefault: report.recommendations.acceptGpuDefault,
    workers: report.recommendations.workers,
    batchSize: report.recommendations.batchSize,
    ramTargetGB: report.recommendations.ramTargetGB,
    gpuVramMb: report.recommendations.gpuVramMb,
    outDir: args.out || DEFAULT_OUT,
  }, null, 2));
}
