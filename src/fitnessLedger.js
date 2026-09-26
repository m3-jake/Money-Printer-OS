// Fitness ledger (docs/FITNESS-LEDGER.md): one record per module answering "what is running, how is
// it doing on paper, and may the Evolution Lab propose anything?". The trader writes it under
// <data>/lab-link/fitness/; the Lab only reads it. Paper only: nothing here can grant live authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { laneMayPropose } from './evidenceFlags.js';
import { writeFileAtomicSync } from './atomicRename.js';
import { activeExitPreset, baselineRoundTripPct, fairExpectancy } from './solanaEconomics.js';

export const FITNESS_SCHEMA = 'mpo.fitness-ledger.v1';
export const FITNESS_MODULES = Object.freeze(['solana', 'robinhood', 'polymarket']);
export const FITNESS_MAX_BYTES = 64 * 1024;
const SAFETY = Object.freeze({ liveExecution: 'manual', liveActivationAllowed: false, automaticLivePromotionAllowed: false });
const DAY_MS = 864e5;

const fin = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v, d = 4) => (fin(v) === null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
const stable = v => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));
export const policyHash = obj => crypto.createHash('sha256').update(stable(obj)).digest('hex').slice(0, 16);

// Profit factor for JSON: Infinity (no losing close yet) is reported as null with a flag, never as a number.
function pf(v) { const n = Number(v); return { profitFactor: Number.isFinite(n) ? round(n, 3) : null, profitFactorUnbounded: n === Infinity }; }

// Closed-trade record from {pnl, closedAt} rows, oldest first. Drawdown is peak-to-trough of cumulative P/L.
export function paperRecordFrom(rows, { unit, startBalance = null, now = Date.now() } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => fin(r?.pnl) !== null).sort((a, b) => (fin(a.closedAt) ?? 0) - (fin(b.closedAt) ?? 0));
  let wins = 0, gw = 0, gl = 0, net = 0, peak = 0, dd = 0;
  for (const r of list) { const p = Number(r.pnl); net += p; if (p > 0) { wins++; gw += p; } else gl += -p; peak = Math.max(peak, net); dd = Math.max(dd, peak - net); }
  const n = list.length, since = n ? fin(list[0].closedAt) : null, start = fin(startBalance);
  return { closes: n, hitRate: n ? round(wins / n) : null, ...pf(!n ? NaN : gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN), netPnl: round(net, 6) ?? 0, unit,
    maxDrawdown: round(dd, 6) ?? 0, maxDrawdownPct: start > 0 ? round(dd / start * 100, 3) : null, windowDays: since ? round((now - since) / DAY_MS, 2) : null, since };
}

// Normalises one module's parts into the v1 record. Unknown numbers stay null.
export function fitnessDoc(module, parts = {}, { now = Date.now() } = {}) {
  if (!FITNESS_MODULES.includes(module)) throw new Error(`unknown fitness module ${module}`);
  const e = parts.evidence || {};
  const evidence = { executablePrices: e.executablePrices === true, spanDays: round(e.spanDays, 3) ?? 0, closes: fin(e.closes) ?? 0,
    venueShare: round(e.venueShare), syntheticShare: round(e.syntheticShare), quoteSources: e.quoteSources && typeof e.quoteSources === 'object' ? { ...e.quoteSources } : {} };
  const mayPropose = laneMayPropose(evidence);
  const park = parts.park ? String(parts.park) : null;
  const blockers = [...new Set([...(park ? [park] : []), ...(parts.blockers || []).filter(Boolean).map(String), ...mayPropose.blockers])];
  return { schema: FITNESS_SCHEMA, module, updatedAt: now, ...SAFETY,
    running: parts.running || null, paperRecord: parts.paperRecord || paperRecordFrom([], { unit: null, now }), evidence,
    mayPropose: { ok: mayPropose.ok, blockers: mayPropose.blockers }, proposal: parts.proposal || null, trial: parts.trial || null, lastDecision: parts.lastDecision || null,
    verdict: park ? 'PARK' : blockers.length ? 'BLOCKED' : 'KEEP_RESEARCHING', blockers };
}

// What the Solana book actually runs; also published as trader-status.runningPolicy for the Lab.
export function solanaRunningPolicy(runtime = {}, config = {}) {
  const pr = activeExitPreset(runtime || {}, config || {});
  const policy = { module: 'solana', profile: runtime?.profile || null, exitPreset: runtime?.exitPreset || null,
    stopPct: fin(pr.stop), takePct: fin(pr.tp1), take2Pct: fin(pr.tp2), trailPct: fin(pr.trail), maxHoldMin: fin(pr.maxHold), roundTripPct: round(baselineRoundTripPct(config || {}), 3) };
  return { ...policy, hash: policyHash(policy) };
}

export function solanaFitnessParts(state = {}, config = {}, { now = Date.now() } = {}) {
  const policy = solanaRunningPolicy(state.runtime, config), history = Array.isArray(state.history) ? state.history : [];
  const running = history.filter(h => !policy.exitPreset || h?.exitPreset === policy.exitPreset);
  const rows = running.map(h => ({ pnl: h.pnlSol, closedAt: h.closedAt }));
  const fair = fairExpectancy(history, config);
  const champion = state.runtime?.activeEvolutionChampionId;
  return {
    running: { hash: policy.hash, params: policy, since: fin(state.runtime?.profileChangedAt) ?? null, source: champion && champion !== 'BASE' ? 'lab-auto' : 'operator' },
    paperRecord: paperRecordFrom(rows, { unit: 'SOL', startBalance: fin(state.portfolio?.startSol ?? state.portfolio?.startingSol), now }),
    // Paper fills are simulated from marks; there is no executable Jupiter quote tape yet (plan batch F item 5).
    evidence: { executablePrices: false, spanDays: rows.length > 1 ? ((fin(rows.at(-1).closedAt) ?? 0) - (fin(rows[0].closedAt) ?? 0)) / DAY_MS : 0, closes: rows.length, venueShare: null, syntheticShare: null, quoteSources: { 'simulated-marks': rows.length } },
    park: fair.verdict === 'PARK' ? `FAIR: upper 95% hit rate ${round(fair.hitRate95?.high, 3)} < break-even ${round(fair.breakEvenHitRate, 3)} after ${fair.closes} closes` : null,
    blockers: ['Solana stays research-only until an executable Jupiter quote tape exists'],
  };
}

// polymarketFitness() from src/polymarketUSEvidence.js: shadow combos, public data only.
export function polymarketFitnessParts(pf = {}, { now = Date.now() } = {}) {
  const w = Object.values(pf.byWindow || {});
  const settled = w.reduce((a, x) => a + (fin(x.settled) ?? 0), 0);
  const won = w.reduce((a, x) => a + (fin(x.hitRate) ?? 0) * (fin(x.settled) ?? 0), 0);
  const pnl = w.reduce((a, x) => a + (fin(x.pnlUsd) ?? 0), 0);
  return {
    running: { hash: null, params: { windows: Object.keys(pf.byWindow || {}) }, since: null, source: 'BASE' },
    paperRecord: { closes: settled, hitRate: settled ? round(won / settled) : null, profitFactor: null, profitFactorUnbounded: false, netPnl: round(pnl, 2) ?? 0, unit: 'USD', maxDrawdown: null, maxDrawdownPct: null, windowDays: null, since: null },
    // Combo prices are estimated from public legs plus a markup; there is no executable combo quote (beta 403).
    evidence: { executablePrices: false, spanDays: null, closes: settled, venueShare: null, syntheticShare: null, quoteSources: { 'public-legs': fin(pf.trackedLegs) ?? 0 } },
    park: null,
    blockers: [...(pf.blockers || []), ...(pf.combosParked ? ['combos parked: Polymarket US combo beta not enabled'] : [])],
  };
}

export function fitnessSnapshot({ solana = null, robinhood = null, polymarket = null, now = Date.now() } = {}) {
  const modules = {};
  for (const [id, parts] of Object.entries({ solana, robinhood, polymarket })) {
    try { modules[id] = parts ? fitnessDoc(id, parts, { now }) : fitnessDoc(id, { blockers: [`${id} fitness unavailable`] }, { now }); }
    catch (e) { modules[id] = fitnessDoc(id, { blockers: [`${id} fitness failed: ${String(e?.message || e).slice(0, 160)}`] }, { now }); }
  }
  return { schema: FITNESS_SCHEMA, at: now, ...SAFETY, modules };
}

// <dataDir>/lab-link/fitness/<module>.json, tmp + fsync + rename, capped at FITNESS_MAX_BYTES.
export function writeFitnessFiles(dataDir, snapshot) {
  const out = { written: [], errors: [] };
  for (const [id, doc] of Object.entries(snapshot?.modules || {})) {
    try {
      const text = JSON.stringify(doc) + '\n';
      if (Buffer.byteLength(text) > FITNESS_MAX_BYTES) throw new Error(`record exceeds ${FITNESS_MAX_BYTES} bytes`);
      writeFileAtomicSync(path.join(dataDir, 'lab-link', 'fitness', `${id}.json`), text); out.written.push(id);
    } catch (e) { out.errors.push(`${id}: ${String(e?.code || e?.message || e)}`); }
  }
  return out;
}

export function readFitnessFile(dataDir, module) {
  try {
    const file = path.join(dataDir, 'lab-link', 'fitness', `${module}.json`);
    if (fs.statSync(file).size > FITNESS_MAX_BYTES) return null;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc?.schema === FITNESS_SCHEMA && doc.module === module ? doc : null;
  } catch { return null; }
}
