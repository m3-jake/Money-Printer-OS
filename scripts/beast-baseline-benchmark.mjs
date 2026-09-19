#!/usr/bin/env node
/**
 * Isolated research-only BEAST baseline benchmark.
 * Scores a frozen seeded corpus with the production evolutionWorker scorer.
 * Does not load store/state, start daemons, touch wallets, or contact networks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export const FEATURES = ['edge', 'explosion', 'execution', 'momentum', 'liquidity', 'freshness', 'flow', 'volumeAccel', 'priceAccel'];
export const BASE_WEIGHTS = { edge: .28, explosion: .20, execution: .16, momentum: .10, liquidity: .08, freshness: .04, flow: .06, volumeAccel: .04, priceAccel: .04 };
export const TEST_LANES = ['LAUNCH_SNIPE', 'EARLY_MOMENTUM', 'LIQUIDITY_FILTER', 'EXIT_TIMING', 'RISK_STRESS', 'BASELINE_CONTROL'];
export const SCHEMA = 1;
export const KIND = 'beast-baseline-benchmark';
export const DEFAULT_SEED = 45;
export const DEFAULT_ROWS = 250;
export const DEFAULT_VARIANTS = 512;
export const TOP_N = 10;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORKER_PATH = path.join(REPO, 'src', 'evolutionWorker.js');
const SEED_PRELOAD = path.join(HERE, 'beast-baseline-seed.cjs');
const DEFAULT_OUT = path.join(REPO, 'artifacts', 'beast-baseline');

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1e8) / 1e8;
  return value;
}

export function canonicalHash(value) {
  return sha256(JSON.stringify(canonical(value)));
}

function round6(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null;
}

function normalize(w) {
  let t = 0;
  const o = {};
  for (const k of FEATURES) {
    o[k] = Math.max(.005, Number(w[k] || 0));
    t += o[k];
  }
  for (const k of FEATURES) o[k] /= t || 1;
  return o;
}

function mutate(parent, lane, rng, id) {
  const rnd = (lo, hi) => lo + rng() * (hi - lo);
  const pw = parent.weights || BASE_WEIGHTS;
  const w = {};
  const amp = lane === 'BASELINE_CONTROL' ? .16 : lane === 'RISK_STRESS' ? .24 : .34;
  for (const k of FEATURES) {
    let mult = 1 + rnd(-amp, amp);
    if (lane === 'EARLY_MOMENTUM' && ['momentum', 'explosion', 'flow', 'priceAccel'].includes(k)) mult *= rnd(1.05, 1.28);
    if (lane === 'LIQUIDITY_FILTER' && ['liquidity', 'execution'].includes(k)) mult *= rnd(1.08, 1.32);
    w[k] = Math.max(.005, Number(pw[k] || BASE_WEIGHTS[k]) * mult);
  }
  let threshold = clamp(Number(parent.threshold ?? 60) + rnd(-8, 8), 35, 88);
  let stopPct = clamp(Number(parent.stopPct ?? 8) + rnd(-3, 3), 2, 20);
  let takePct = clamp(Number(parent.takePct ?? 16) + rnd(-6, 10), 4, 80);
  let maxHoldMin = Math.round(clamp(Number(parent.maxHoldMin ?? 30) + rnd(-12, 20), 3, 180));
  if (lane === 'LAUNCH_SNIPE') {
    threshold = clamp(threshold - rnd(3, 10), 30, 80);
    maxHoldMin = Math.round(clamp(maxHoldMin - rnd(5, 18), 2, 90));
  }
  if (lane === 'EXIT_TIMING') {
    stopPct = clamp(Number(parent.stopPct ?? 8) + rnd(-5, 6), 1.5, 24);
    takePct = clamp(Number(parent.takePct ?? 16) + rnd(-10, 22), 3, 100);
    maxHoldMin = Math.round(clamp(maxHoldMin - rnd(-22, 45), 2, 240));
  }
  if (lane === 'RISK_STRESS') {
    threshold = clamp(threshold + rnd(2, 10), 40, 92);
    stopPct = clamp(stopPct - rnd(0, 3), 1.5, 14);
  }
  return { id, weights: normalize(w), threshold, stopPct, takePct, maxHoldMin, parentId: parent.id || 'BASE', testLane: lane };
}

export function baseChampion() {
  return { id: 'BASE', weights: { ...BASE_WEIGHTS }, threshold: 60, stopPct: 8, takePct: 16, maxHoldMin: 30, parentId: null, testLane: 'BASE' };
}

export function buildCorpus({ seed = DEFAULT_SEED, rowCount = DEFAULT_ROWS, variantCount = DEFAULT_VARIANTS } = {}) {
  const rowsRng = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  const trueW = normalize({ ...BASE_WEIGHTS, explosion: .26, momentum: .14, edge: .24, flow: .08, liquidity: .07 });
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const features = {};
    for (const k of FEATURES) {
      const drift = (i / Math.max(1, rowCount - 1)) * (k === 'liquidity' || k === 'execution' ? .25 : -.08);
      features[k] = clamp(rowsRng() * .75 + rowsRng() * .2 + drift, 0, 1);
    }
    const signal = FEATURES.reduce((q, k) => q + trueW[k] * features[k], 0);
    const noise = (rowsRng() - .5) * 16;
    const spike = rowsRng() < .08 ? rowsRng() * 28 : 0;
    const dump = rowsRng() < .07 ? -rowsRng() * 22 : 0;
    rows.push({
      ts: 1_700_000_000_000 + i * 300_000,
      horizonMin: 5,
      returnPct: (signal - .42) * 90 + noise + spike + dump,
      features,
    });
  }
  const parent = baseChampion();
  const mutRng = mulberry32((seed >>> 0) ^ 0x85ebca6b);
  const variants = [parent];
  for (let i = 0; i < variantCount; i++) {
    const lane = TEST_LANES[i % TEST_LANES.length];
    variants.push(mutate(parent, lane, mutRng, `BEAST-${String(i + 1).padStart(4, '0')}`));
  }
  return { seed, rowCount, variantCount, rows, variants };
}

export function corpusHash(corpus) {
  return canonicalHash({
    seed: corpus.seed,
    rowCount: corpus.rowCount,
    variantCount: corpus.variantCount,
    rows: corpus.rows,
    variants: corpus.variants,
  });
}

export function evolutionPromotionGate(winner, incumbent, parentId = 'BASE') {
  const missing = [];
  if (!winner?.metrics) return { ok: false, promoted: false, stage: 'RETAIN', missing: ['no-winner'] };
  if (!incumbent?.metrics) return { ok: false, promoted: false, stage: 'RETAIN', missing: ['no-incumbent'] };
  if (winner.variant?.id === parentId) missing.push('winner-is-parent');
  if (!(Number(winner.metrics.robustScore) > Number(incumbent.metrics.robustScore) + 1.0)) missing.push('robustScore-margin');
  if (!(Number(winner.metrics.heldOutAvgPct) > 0)) missing.push('heldOutAvgPct');
  if (!(Number(winner.metrics.heldOutN) >= 12)) missing.push('heldOutN');
  if (!(Number(winner.metrics.samples) >= 40)) missing.push('samples');
  if (!(Number(winner.metrics.activityPct) >= 8)) missing.push('activityPct');
  if (!(Number(winner.metrics.stressAvgPct) > -2)) missing.push('stressAvgPct');
  if (!(Number(winner.metrics.monteCarloPassPct) >= 70)) missing.push('monteCarloPassPct');
  if (!(Number(winner.metrics.consistencyPct) >= 50)) missing.push('consistencyPct');
  return { ok: missing.length === 0, promoted: missing.length === 0, stage: missing.length === 0 ? 'SHADOW' : 'RETAIN', missing };
}

export function championTrusted(entry) {
  const m = entry?.metrics || {};
  return !!entry?.variant && Number(m.heldOutN || 0) >= 12 && Number(m.samples || 0) >= 40 && Number(m.activityPct || 0) >= 8 && Number(m.monteCarloPassPct || 0) >= 70;
}

function publicMetrics(m) {
  if (!m) return null;
  return {
    robustScore: round6(m.robustScore),
    walkAvgPct: round6(m.walkAvgPct),
    geometricMeanPct: round6(m.geometricMeanPct),
    compoundedMultiple: round6(m.compoundedMultiple),
    maxDrawdownPct: round6(m.maxDrawdownPct),
    profitVelocityPctPerMin: round6(m.profitVelocityPctPerMin),
    consistencyPct: round6(m.consistencyPct),
    activityPct: round6(m.activityPct),
    inactivityPenalty: round6(m.inactivityPenalty),
    heldOutAvgPct: round6(m.heldOutAvgPct),
    heldOutN: Number(m.heldOutN || 0),
    stressAvgPct: round6(m.stressAvgPct),
    monteCarloPassPct: round6(m.monteCarloPassPct),
    worstPct: round6(m.worstPct),
    samples: Number(m.samples || 0),
  };
}

function rankRow(entry) {
  const v = entry.variant || {};
  return {
    id: v.id,
    parentId: v.parentId || null,
    testLane: v.testLane || null,
    threshold: round6(v.threshold),
    stopPct: round6(v.stopPct),
    takePct: round6(v.takePct),
    maxHoldMin: Number(v.maxHoldMin || 0),
    weights: canonical(v.weights || {}),
    metrics: publicMetrics(entry.metrics),
  };
}

export function rankingFingerprint(ranked, topN = TOP_N) {
  const top = ranked.filter(x => x.metrics).slice(0, topN).map(rankRow);
  const order = ranked.filter(x => x.metrics).map(x => x.variant?.id);
  return {
    topN: top,
    topNHash: canonicalHash(top),
    rankingOrderHash: canonicalHash(order),
  };
}

function workerEnv(seed) {
  const env = { ...process.env };
  env.BEAST_BASELINE_SEED = String(seed);
  env.CLUSTER_HUB_URL = '';
  env.CLUSTER_TOKEN = '';
  env.EVOLUTION_DAEMON = '';
  env.MPO_RESEARCH_FURNACE = '';
  env.MPO_RESEARCH_BEAST = '';
  env.MPO_RESEARCH_GPU = '';
  env.MONEY_PRINTER_SUPERVISED = '';
  return env;
}

function scoreBatch(variants, rows, seed, timeoutMs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../src/evolutionWorker.js', import.meta.url), {
      execArgv: ['--require', SEED_PRELOAD],
      env: workerEnv(seed),
    });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error(`beast-baseline worker timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (fn, value) => {
      clearTimeout(timer);
      try { w.terminate(); } catch {}
      fn(value);
    };
    w.once('message', x => finish(resolve, x));
    w.once('error', e => finish(reject, e));
    w.postMessage({ variants, rows });
  });
}

export async function scoreWithProductionWorker({ variants, rows, workers = 1, seed = DEFAULT_SEED, timeoutMs = 180_000 } = {}) {
  const n = Math.max(1, Number(workers) || 1);
  if (n <= 1) return scoreBatch(variants, rows, seed, timeoutMs);
  const batches = Array.from({ length: n }, () => []);
  variants.forEach((v, i) => batches[i % n].push(v));
  const parts = await Promise.all(batches.filter(b => b.length).map(batch => scoreBatch(batch, rows, seed, timeoutMs)));
  return parts.flat();
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', timeout: 4000 }).trim();
  } catch {
    return null;
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function sampleResources() {
  const mu = process.memoryUsage();
  return { rss: mu.rss, heapUsed: mu.heapUsed, heapTotal: mu.heapTotal, cpu: process.cpuUsage() };
}

export async function runBaseline(opts = {}) {
  const seed = Number(opts.seed ?? DEFAULT_SEED) >>> 0;
  const rowCount = Math.max(80, Number(opts.rows ?? DEFAULT_ROWS) || DEFAULT_ROWS);
  const variantCount = Math.max(1, Number(opts.variants ?? DEFAULT_VARIANTS) || DEFAULT_VARIANTS);
  const workers = Math.max(1, Number(opts.workers ?? 1) || 1);
  const throughputWorkers = Math.max(0, Number(opts.throughputWorkers ?? 0) || 0);
  const timeoutMs = Math.max(5_000, Number(opts.timeoutMs ?? 180_000) || 180_000);
  const write = opts.write !== false;
  const outDir = opts.outDir || DEFAULT_OUT;

  const corpus = buildCorpus({ seed, rowCount, variantCount });
  const hash = corpusHash(corpus);
  const scorerSha = sha256(fs.readFileSync(WORKER_PATH));
  const cpu0 = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const sampler = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 25);
  if (typeof sampler.unref === 'function') sampler.unref();

  const wall0 = Date.now();
  const scored = await scoreWithProductionWorker({
    variants: corpus.variants,
    rows: corpus.rows,
    workers,
    seed,
    timeoutMs,
  });
  const generationWallMs = Date.now() - wall0;
  clearInterval(sampler);
  const cpu = process.cpuUsage(cpu0);
  const rssAfter = process.memoryUsage().rss;
  rssPeak = Math.max(rssPeak, rssAfter);

  const ranked = scored.filter(x => x.metrics).sort((a, b) => b.metrics.robustScore - a.metrics.robustScore);
  const parent = ranked.find(x => x.variant?.id === 'BASE') || scored.find(x => x.variant?.id === 'BASE') || { variant: corpus.variants[0], metrics: null };
  const winner = ranked[0] || null;
  const fingerprints = rankingFingerprint(ranked);
  const gate = evolutionPromotionGate(winner, parent, 'BASE');
  const candidateCount = corpus.variants.length;
  const variantsPerSec = generationWallMs > 0 ? candidateCount / (generationWallMs / 1000) : null;

  let throughput = null;
  if (throughputWorkers > 1) {
    const t0 = Date.now();
    const cpuT0 = process.cpuUsage();
    await scoreWithProductionWorker({
      variants: corpus.variants,
      rows: corpus.rows,
      workers: throughputWorkers,
      seed,
      timeoutMs,
    });
    const wallMs = Date.now() - t0;
    const cpuT = process.cpuUsage(cpuT0);
    throughput = {
      workerCount: throughputWorkers,
      generationWallMs: wallMs,
      variantsPerSec: wallMs > 0 ? candidateCount / (wallMs / 1000) : null,
      cpu: { userMicros: cpuT.user, systemMicros: cpuT.system },
    };
  }

  const cpuMicros = cpu.user + cpu.system;
  const report = {
    schema: SCHEMA,
    kind: KIND,
    researchOnly: true,
    liveAppTouched: false,
    version: packageVersion(),
    sourceCommit: gitSha(),
    generatedAt: new Date().toISOString(),
    seed,
    scorer: {
      path: 'src/evolutionWorker.js',
      sha256: scorerSha,
      bootstrapRounds: 90,
      foldCount: 4,
      notes: '1-worker seeded Math.random so ranking fingerprints are partition-independent. Mutate RNG is harness-local; production evolutionLoop.js is not imported and not started.',
    },
    hardware: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpuThreads: os.cpus().length,
      memoryTotalBytes: os.totalmem(),
      loadavg: os.loadavg(),
    },
    candidateCount,
    datasetRows: corpus.rows.length,
    variantBatchSize: variantCount,
    workerCount: workers,
    generationWallMs,
    variantsPerSec,
    process: {
      rssBeforeBytes: rssBefore,
      rssAfterBytes: rssAfter,
      rssPeakBytes: rssPeak,
      heapUsedAfterBytes: process.memoryUsage().heapUsed,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      cpuTotalMicros: cpuMicros,
      cpuProxyPct: generationWallMs > 0 ? (cpuMicros / 1000) / generationWallMs * 100 : null,
    },
    corpusHash: hash,
    rankingFingerprint: fingerprints.topNHash,
    rankingOrderHash: fingerprints.rankingOrderHash,
    topN: fingerprints.topN,
    promotionGate: {
      ...gate,
      winnerId: winner?.variant?.id || null,
      incumbentId: parent?.variant?.id || null,
      winnerTrusted: championTrusted(winner),
      incumbentTrusted: championTrusted(parent),
      winnerMetrics: publicMetrics(winner?.metrics),
      incumbentMetrics: publicMetrics(parent?.metrics),
    },
    scoredWithMetrics: ranked.length,
    scoredNull: scored.length - ranked.length,
    throughput,
  };

  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    const corpusOut = {
      schema: SCHEMA,
      kind: 'beast-baseline-corpus',
      researchOnly: true,
      seed,
      rowCount: corpus.rowCount,
      variantCount: corpus.variantCount,
      corpusHash: hash,
      rows: corpus.rows,
      variants: corpus.variants,
    };
    fs.writeFileSync(path.join(outDir, 'corpus.json'), JSON.stringify(corpusOut));
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outDir, 'ranking.json'), JSON.stringify({
      schema: SCHEMA,
      corpusHash: hash,
      rankingFingerprint: fingerprints.topNHash,
      rankingOrderHash: fingerprints.rankingOrderHash,
      topN: fingerprints.topN,
      challengers: ranked.slice(0, 12).map(rankRow),
    }, null, 2));
    fs.writeFileSync(path.join(outDir, 'REPORT.md'), renderReport(report));
  }

  return report;
}

export function renderReport(r) {
  const rssMb = n => (Number(n || 0) / 1048576).toFixed(2);
  const lines = [
    '# BEAST baseline benchmark',
    '',
    'Research-only evolution scoring baseline. Isolated harness; live app was not started or modified.',
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| generatedAt | ${r.generatedAt} |`,
    `| version | ${r.version} |`,
    `| sourceCommit | ${r.sourceCommit} |`,
    `| seed | ${r.seed} |`,
    `| candidateCount | ${r.candidateCount} |`,
    `| datasetRows | ${r.datasetRows} |`,
    `| workerCount | ${r.workerCount} |`,
    `| generationWallMs | ${r.generationWallMs} |`,
    `| variantsPerSec | ${Number(r.variantsPerSec).toFixed(3)} |`,
    `| rssPeakMiB | ${rssMb(r.process?.rssPeakBytes)} |`,
    `| cpuUserMicros | ${r.process?.cpuUserMicros} |`,
    `| cpuSystemMicros | ${r.process?.cpuSystemMicros} |`,
    `| cpuProxyPct | ${Number(r.process?.cpuProxyPct).toFixed(1)} |`,
    `| corpusHash | ${r.corpusHash} |`,
    `| rankingFingerprint | ${r.rankingFingerprint} |`,
    `| rankingOrderHash | ${r.rankingOrderHash} |`,
    `| scorer | ${r.scorer?.path} ${r.scorer?.sha256} |`,
    `| promotion | ${r.promotionGate?.stage} promoted=${r.promotionGate?.promoted} winner=${r.promotionGate?.winnerId} |`,
    `| promotionMissing | ${(r.promotionGate?.missing || []).join(', ') || '(none)'} |`,
    `| hardware | ${r.hardware?.platform} ${r.hardware?.arch} ${r.hardware?.cpuThreads} threads node ${r.hardware?.node} |`,
  ];
  if (r.throughput) {
    lines.push(`| throughputWorkers | ${r.throughput.workerCount} |`);
    lines.push(`| throughputWallMs | ${r.throughput.generationWallMs} |`);
    lines.push(`| throughputVariantsPerSec | ${Number(r.throughput.variantsPerSec).toFixed(3)} |`);
  }
  lines.push('', '## Top-N', '');
  for (const [i, row] of (r.topN || []).entries()) {
    const m = row.metrics || {};
    lines.push(`${i + 1}. \`${row.id}\` lane=${row.testLane} robust=${m.robustScore} heldOut=${m.heldOutAvgPct} n=${m.heldOutN} samples=${m.samples} activity=${m.activityPct} stress=${m.stressAvgPct} mc=${m.monteCarloPassPct} cons=${m.consistencyPct}`);
  }
  lines.push('', '## Promotion gate', '', '```json', JSON.stringify(r.promotionGate, null, 2), '```', '');
  return lines.join('\n');
}

export function isMainModule(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(argv1); }
  catch { return false; }
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

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  const report = await runBaseline({
    seed: args.seed,
    rows: args.rows,
    variants: args.variants,
    workers: args.workers ?? 1,
    throughputWorkers: args['throughput-workers'] ?? Math.min(4, Math.max(0, os.cpus().length - 1)),
    timeoutMs: args.timeout,
    outDir: args.out,
    write: args['no-write'] ? false : true,
  });
  console.log(JSON.stringify({
    ok: true,
    researchOnly: true,
    candidateCount: report.candidateCount,
    datasetRows: report.datasetRows,
    variantsPerSec: report.variantsPerSec,
    generationWallMs: report.generationWallMs,
    workerCount: report.workerCount,
    rssPeakBytes: report.process.rssPeakBytes,
    cpuProxyPct: report.process.cpuProxyPct,
    rankingFingerprint: report.rankingFingerprint,
    rankingOrderHash: report.rankingOrderHash,
    corpusHash: report.corpusHash,
    promotionGate: report.promotionGate.stage,
    promoted: report.promotionGate.promoted,
    sourceCommit: report.sourceCommit,
    outDir: args.out || DEFAULT_OUT,
    throughput: report.throughput,
  }, null, 2));
}
