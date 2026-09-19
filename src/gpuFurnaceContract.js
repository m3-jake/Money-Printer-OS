// Research-only GPU furnace fixture/score contract.
// Matches research/gpu-furnace/mpo_gpu_furnace/fixture.py. No live execution imports.
import { FEATURES } from './evolutionScoring.js';

export const FIXTURE_SCHEMA = 'mpo.gpu-furnace.fixture.v1';
export const SCORES_SCHEMA = 'mpo.gpu-furnace.scores.v1';
export const DETERMINISTIC_KEYS = [
  'walkAvgPct', 'geometricMeanPct', 'compoundedMultiple', 'maxDrawdownPct',
  'profitVelocityPctPerMin', 'consistencyPct', 'activityPct', 'inactivityPenalty',
  'heldOutAvgPct', 'heldOutN', 'stressAvgPct', 'worstPct', 'samples',
  'robustScoreDeterministic',
];
export const INTEGER_KEYS = ['samples', 'heldOutN'];
export const NUMERICAL_TOLERANCE = 1e-6;

// Monte-Carlo can add at most min(10, mc/10) to robustScore. Strip it for GPU screening.
export function deterministicRobustScore(m) {
  if (!m) return null;
  const explicit = Number(m.robustScoreDeterministic);
  if (Number.isFinite(explicit)) return explicit;
  const robust = Number(m.robustScore);
  if (!Number.isFinite(robust)) return null;
  return robust - Math.min(10, Number(m.monteCarloPassPct || 0) / 10);
}

export function buildGpuFixture({ rows, variants, seed = 0, bootstrapRounds = 90, source = 'research' } = {}) {
  return {
    schema: FIXTURE_SCHEMA,
    features: [...FEATURES],
    seed,
    generatedAt: Date.now(),
    source,
    bootstrapRounds,
    rows: (rows || []).map(r => ({ ts: r.ts, returnPct: r.returnPct, features: r.features || {} })),
    variants: (variants || []).map(v => ({
      id: v.id,
      weights: v.weights,
      threshold: v.threshold,
      stopPct: v.stopPct,
      takePct: v.takePct,
      maxHoldMin: v.maxHoldMin,
      parentId: v.parentId,
      testLane: v.testLane,
    })),
  };
}

export function deterministicParity(cpu, gpu, { tolerance = NUMERICAL_TOLERANCE } = {}) {
  if (cpu == null && gpu == null) return { ok: true, maxAbs: 0, mismatches: [] };
  if (cpu == null || gpu == null) return { ok: false, maxAbs: Infinity, mismatches: ['null-mismatch'] };
  const mismatches = [];
  let maxAbs = 0;
  for (const k of INTEGER_KEYS) {
    if (Number(cpu[k] || 0) !== Number(gpu[k] || 0)) mismatches.push(k);
  }
  for (const k of DETERMINISTIC_KEYS) {
    const derived=x=>k==='robustScoreDeterministic' && !Number.isFinite(Number(x[k]))
      ? Number(x.robustScore)-Math.min(10,Number(x.monteCarloPassPct||0)/10)
      : Number(x[k]);
    const a = derived(cpu), b = derived(gpu);
    const err = Math.abs((Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0));
    if (err > maxAbs) maxAbs = err;
    if (err > tolerance) mismatches.push(k);
  }
  return { ok: mismatches.length === 0, maxAbs, mismatches };
}
