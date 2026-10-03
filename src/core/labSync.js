import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { championState, championPaperAllowed } from '../championState.js';
import { canonicalJson, fingerprint } from './model.js';
import { labChampionLifecycle, promotionCheck, strategyEvidenceIdentity, STRATEGY_STATES } from './strategies.js';

// Evolution Lab champions mirrored into the common strategy registry. The Lab keeps its own
// lifecycle and gates; the registry applies the common promotion gate on top, so a Lab PAPER
// champion only reaches PAPER here when the common criteria pass too. Read-only on the Lab side.
export const LAB_CHAMPION_SOURCES = Object.freeze([
  { id: 'lab-solana', file: 'champion.json', name: 'Solana meme (Lab champion)', markets: ['solana'], probabilistic: false },
  { id: 'lab-robinhood', file: 'robinhood-champion.json', name: 'Robinhood crypto (Lab champion)', markets: ['robinhood'], probabilistic: false },
  { id: 'lab-robinhood-equities', file: 'robinhood-equities-champion.json', name: 'Robinhood equities (Lab champion)', markets: ['robinhood'], probabilistic: false },
  { id: 'lab-polymarket', file: 'polymarket-champion.json', name: 'Polymarket CLOB (Lab champion)', markets: ['polymarket'], probabilistic: true },
  { id: 'lab-polymarket-combo', file: 'polymarket-combo-champion.json', name: 'Polymarket US combos (Lab champion)', markets: ['polymarket-us'], probabilistic: true },
]);

const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const abs = v => (num(v) === null ? null : Math.abs(num(v)));

// Only fields a Lab record states explicitly are mapped. Anything else stays null and the
// common gate names it as a blocker. Percent returns map to outOfSampleNetPct, never to USD.
// Summary metrics alone never carry an evaluator version, so they can never pass the gate.
export function labEvidence(doc) {
  if (!doc || typeof doc !== 'object') return {};
  if (doc.schema === 'mpo.lab-champion.v1') {
    const m = doc.champion?.metrics || {};
    return { sampleSize: num(m.heldOutN), outOfSampleNetPct: num(m.heldOutAvgPct), maxDrawdownPct: abs(m.maxDrawdownPct),
      positiveFoldShare: num(m.consistencyPct) === null ? null : num(m.consistencyPct) / 100, costsModeled: doc.evidence?.feesModeled === true ? true : null,
      source: 'lab-champion.v1' };
  }
  const c = doc.candidate || {}, holdout = c.holdout ?? c.metrics?.holdout ?? doc.evidence?.holdout;
  const h = holdout && typeof holdout === 'object' ? holdout : null;
  return { sampleSize: num(h?.trades ?? h?.combos ?? h?.sessions ?? h?.n), outOfSampleNetPct: num(h?.netReturnPct ?? h?.netPct ?? h?.totalReturnPct), maxDrawdownPct: abs(h?.maxDrawdownPct),
    positiveFoldShare: null, costsModeled: doc.evidence?.feesModeled === true || num(doc.evidence?.markup) !== null || doc.evidence?.costs?.known === true ? true : null,
    brier: num(h?.brier), source: 'lab-module-champion.v1' };
}

// ---------------------------------------------------------------- Lab provenance (mpo.lab-provenance.v1)
// A Lab record may carry `provenance`: the evaluator that produced its numbers (version, source file,
// code hash), the dataset it read (a trader-local path and its hash), the exact evaluator output and
// its hash, a strategy identity binding all of them, and receipts. The trader recomputes every hash it
// can. Integrity failures and hashes that disagree with what the trader sees are REJECTED; provenance
// the trader cannot bind (evaluator code not shared, dataset not visible here) stays UNVERIFIED. Only
// VERIFIED provenance may set verifiedEvaluatorOutput, and promotionCheck still applies every gate.
export const LAB_PROVENANCE_SCHEMA = 'mpo.lab-provenance.v1';
export const EVALUATOR_OUTPUT_FIELDS = Object.freeze(['sampleSize', 'effectiveSampleSize', 'outOfSampleNetPct', 'maxDrawdownPct', 'positiveFoldShare',
  'brier', 'costsModeled', 'lookAheadViolations', 'syntheticShare', 'pendingOpenPositions', 'incompleteFolds']);
const HEX64 = /^[0-9a-f]{64}$/;
const TRADER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATASET_ROOTS = ['lab-link/', 'robinhood-tape', 'robinhood-equities/', 'research-evidence/'];
const MAX_DATASET_FILE_BYTES = 64 * 1024 * 1024, MAX_MANIFEST_FILES = 5000;
const sha256 = text => createHash('sha256').update(text).digest('hex');
// Same normalisation as scripts/sync-shared-core.mjs, so a shared file hashes identically in both repos.
export const sourceHash = file => sha256(fs.readFileSync(file, 'utf8').replace(/\r/g, ''));
export const labStrategyIdentity = ({ module, candidateId, paramsHash, evaluatorVersion, codeHash, datasetHash }) =>
  fingerprint({ module: module ?? null, candidateId: candidateId ?? null, paramsHash: paramsHash ?? null, evaluatorVersion: evaluatorVersion ?? null, codeHash: codeHash ?? null, datasetHash: datasetHash ?? null });

// Evaluator sources the trader can bind byte-for-byte: every shared-core file (Lab path -> trader path)
// plus the trader's own replay evaluator. Anything else is Lab-only code the trader cannot verify.
let bindCache = null;
export function bindableEvaluators(root = TRADER_ROOT) {
  if (bindCache?.root === root) return bindCache.map;
  const map = new Map([['src/core/replay.js', 'src/core/replay.js']]);
  try { for (const [trader, e] of Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'shared-core.json'), 'utf8')).files || {})) if (typeof e?.lab === 'string') map.set(e.lab, trader); } catch {}
  bindCache = { root, map };
  return map;
}

// Dataset identity both apps compute the same way: a file's normalised-content sha256, or for a
// directory a manifest of [name, size, mtime] (optionally filtered by `include`). Content hashes are
// cached by size+mtime so a 60 s sync does not reread unchanged files.
const digestCache = new Map();
export function datasetDigest(dataDir, spec = {}) {
  const rel = String(spec.path || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || !DATASET_ROOTS.some(r => rel === r.replace(/\/$/, '') || rel.startsWith(r.endsWith('/') ? r : r + '/') || rel === r)) throw new Error('DATASET_PATH_NOT_ALLOWED');
  const file = path.join(dataDir, rel), st = fs.statSync(file);
  if (st.isFile()) {
    if (st.size > MAX_DATASET_FILE_BYTES) throw new Error('DATASET_TOO_LARGE');
    const key = `${file}|${st.size}|${Math.trunc(st.mtimeMs)}`;
    if (!digestCache.has(key)) { if (digestCache.size > 64) digestCache.clear(); digestCache.set(key, sha256(fs.readFileSync(file))); }
    return { kind: 'file-sha256.v1', hash: digestCache.get(key), files: 1, bytes: st.size };
  }
  if (!st.isDirectory()) throw new Error('DATASET_NOT_A_FILE');
  let include = null;
  if (spec.include != null) { if (typeof spec.include !== 'string' || spec.include.length > 200) throw new Error('DATASET_FILTER_INVALID'); include = new RegExp(spec.include); }
  const names = fs.readdirSync(file).sort().filter(n => !include || include.test(n));
  if (names.length > MAX_MANIFEST_FILES) throw new Error('DATASET_TOO_LARGE');
  const rows = []; let bytes = 0;
  for (const n of names) { const s = fs.statSync(path.join(file, n)); if (s.isFile()) { rows.push([n, s.size, Math.trunc(s.mtimeMs)]); bytes += s.size; } }
  return { kind: 'file-manifest.v1', hash: fingerprint(rows), files: rows.length, bytes };
}

const candidateOf = doc => doc?.champion?.id ?? doc?.candidate?.id ?? null;
const paramsOf = doc => doc?.champion?.variant ?? doc?.candidate?.params ?? null;
export function verifyLabProvenance(doc, { dataDir = null, root = TRADER_ROOT } = {}) {
  const p = doc?.provenance;
  if (!p || typeof p !== 'object') return { status: 'MISSING', blockers: ['PROVENANCE_MISSING'] };
  if (p.schema !== LAB_PROVENANCE_SCHEMA) return { status: 'REJECTED', blockers: ['PROVENANCE_SCHEMA_UNKNOWN'] };
  if (p.status === 'UNAVAILABLE') return { status: 'UNVERIFIED', blockers: [`PROVENANCE_UNAVAILABLE:${String(p.reason || 'unknown').slice(0, 80)}`] };
  const rejected = [], unverified = [];
  const ev = p.evaluator && typeof p.evaluator === 'object' ? p.evaluator : {}, ds = p.dataset && typeof p.dataset === 'object' ? p.dataset : {};
  const out = p.evaluatorOutput && typeof p.evaluatorOutput === 'object' && !Array.isArray(p.evaluatorOutput) ? p.evaluatorOutput : null;
  // Only an immutable content-addressed evaluated snapshot can bind evidence. A changing
  // live directory's size/mtime manifest cannot prove which records the evaluator consumed.
  if (ds.kind !== 'file-sha256.v1' || ds.path !== `lab-link/provenance/${ds.hash}.json`) unverified.push('EVALUATED_DATASET_NOT_FROZEN');
  const receipts = Array.isArray(p.receipts) ? p.receipts : [];
  for (const [kind, hash] of [['evaluator-code', ev.codeHash], ['frozen-dataset', ds.hash], ['evaluator-output', p.evaluatorOutputHash]]) {
    if (!receipts.some(r => r?.kind === kind && r.hash === hash && num(r.at) !== null && r.at > 0)) unverified.push(`EVIDENCE_RECEIPT_MISSING:${kind}`);
  }
  if (p.liveAuthority === true || p.executionAuthority === true) rejected.push('PROVENANCE_CLAIMS_AUTHORITY');
  if (p.candidateId !== candidateOf(doc)) rejected.push('PROVENANCE_CANDIDATE_MISMATCH');
  if (![ev.codeHash, ds.hash, p.evaluatorOutputHash, p.strategyIdentity, p.paramsHash].every(h => typeof h === 'string' && HEX64.test(h))) rejected.push('PROVENANCE_HASH_MALFORMED');
  if (typeof ev.version !== 'string' || !ev.version || typeof ev.source !== 'string') rejected.push('EVALUATOR_UNDECLARED');
  try { if (p.paramsHash !== fingerprint(paramsOf(doc))) rejected.push('PARAMS_HASH_MISMATCH'); } catch { rejected.push('PARAMS_HASH_MISMATCH'); }
  if (!out || Object.keys(out).some(k => !EVALUATOR_OUTPUT_FIELDS.includes(k))) rejected.push('EVALUATOR_OUTPUT_MALFORMED');
  else {
    try { if (fingerprint(out) !== p.evaluatorOutputHash) rejected.push('EVALUATOR_OUTPUT_HASH_MISMATCH'); } catch { rejected.push('EVALUATOR_OUTPUT_HASH_MISMATCH'); }
    // The summary a trader displays and the evaluator output must be the same numbers.
    const summary = labEvidence(doc);
    for (const k of ['sampleSize', 'outOfSampleNetPct', 'maxDrawdownPct', 'brier'])
      if (summary[k] != null && (out[k] == null || Math.abs(Number(out[k]) - summary[k]) > 1e-9)) { rejected.push('EVALUATOR_OUTPUT_DISAGREES_WITH_SUMMARY'); break; }
  }
  if (p.strategyIdentity !== labStrategyIdentity({ module: p.module, candidateId: p.candidateId, paramsHash: p.paramsHash, evaluatorVersion: ev.version, codeHash: ev.codeHash, datasetHash: ds.hash })) rejected.push('STRATEGY_IDENTITY_MISMATCH');
  if (!rejected.length) {
    const traderSource = bindableEvaluators(root).get(ev.source);
    if (!traderSource) unverified.push('EVALUATOR_CODE_NOT_SHARED');
    else { let h = null; try { h = sourceHash(path.join(root, traderSource)); } catch {} if (h === null) unverified.push('EVALUATOR_CODE_UNAVAILABLE'); else if (h !== ev.codeHash) rejected.push('EVALUATOR_CODE_HASH_MISMATCH'); }
    if (!dataDir) unverified.push('DATASET_UNAVAILABLE');
    else {
      let d = null; try { d = datasetDigest(dataDir, ds); } catch (e) { unverified.push(`DATASET_UNAVAILABLE:${String(e?.code || e?.message || e).slice(0, 60)}`); }
      if (d && (d.kind !== ds.kind || d.hash !== ds.hash)) rejected.push('DATASET_HASH_MISMATCH');
    }
  }
  const status = rejected.length ? 'REJECTED' : unverified.length ? 'UNVERIFIED' : 'VERIFIED';
  return { status, blockers: [...new Set([...rejected, ...unverified])], evaluatorVersion: typeof ev.version === 'string' ? ev.version : null,
    evaluatorSource: typeof ev.source === 'string' ? ev.source : null, codeHash: ev.codeHash ?? null, datasetHash: ds.hash ?? null, datasetPath: ds.path ?? null,
    strategyIdentity: p.strategyIdentity ?? null, evaluatorOutput: out, evaluatorOutputHash: p.evaluatorOutputHash ?? null,
    receipts: (Array.isArray(p.receipts) ? p.receipts : []).slice(0, 20).map(r => ({ kind: String(r?.kind ?? '').slice(0, 40), hash: typeof r?.hash === 'string' && HEX64.test(r.hash) ? r.hash : null, at: num(r?.at) })) };
}

// Gate evidence for one Lab record. Unverified provenance contributes nothing beyond the summary;
// verified provenance contributes the evaluator's own output with the registry's identity, and the
// common gate (promotionCheck) decides as before.
export function labGateEvidence(doc, verification, strategy) {
  const provenance = { status: verification?.status || 'MISSING', blockers: verification?.blockers || ['PROVENANCE_MISSING'] };
  if (verification?.status !== 'VERIFIED' || !strategy) return { ...labEvidence(doc), provenance };
  const output = Object.fromEntries(Object.entries(verification.evaluatorOutput || {}).filter(([, v]) => v !== null && v !== undefined));
  return { ...output, evaluatorVersion: verification.evaluatorVersion, verifiedEvaluatorOutput: true, strategyIdentity: strategyEvidenceIdentity(strategy),
    labStrategyIdentity: verification.strategyIdentity, codeHash: verification.codeHash, datasetHash: verification.datasetHash, datasetPath: verification.datasetPath,
    evaluatorSource: verification.evaluatorSource, evaluatorOutputHash: verification.evaluatorOutputHash, receipts: verification.receipts, source: 'lab-provenance.v1', provenance };
}

export function readLabChampion(dir, source) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, source.file), 'utf8'));
    // Never mirror a record that claims live authority.
    if (!doc || typeof doc !== 'object' || doc.liveActivationAllowed === true || doc.automaticLivePromotionAllowed === true) return null;
    return doc;
  } catch { return null; }
}

const rank = s => STRATEGY_STATES.indexOf(s);
// Brings one registry strategy in line with its Lab champion. PAUSED/RETIRED are user decisions
// and are never overridden. Moves up one step at a time through the common gate.
export function syncLabChampion(registry, source, doc, { transition = (id, to, opts) => registry.transition(id, to, opts), now = Date.now(), dataDir = null } = {}) {
  const out = { id: source.id, present: !!doc, labState: null, target: null, state: null, blockers: [], skipped: null, provenance: null };
  const existing = registry.get(source.id);
  if (!doc) { out.state = existing?.state ?? null; out.skipped = 'No Lab champion published'; return out; }
  const lab = championState(doc).state, verification = verifyLabProvenance(doc, { dataDir });
  out.provenance = { status: verification.status, blockers: verification.blockers, strategyIdentity: verification.strategyIdentity ?? null,
    codeHash: verification.codeHash ?? null, datasetHash: verification.datasetHash ?? null, evaluatorVersion: verification.evaluatorVersion ?? null };
  const verified = verification.status === 'VERIFIED';
  // A verified identity is part of the version: new code, data or params are a new strategy version.
  const rawVersion = String(candidateOf(doc) || doc.publishedAt || '1');
  const baseVersion = rawVersion.length > 36 ? `candidate-${fingerprint(rawVersion).slice(0, 26)}` : rawVersion;
  const version = verified ? `${baseVersion}@${verification.strategyIdentity.slice(0, 12)}` : baseVersion;
  out.labState = lab;
  let target = labChampionLifecycle(lab);
  if (target === 'PAPER' && !championPaperAllowed(doc)) target = 'BACKTESTING';
  if (doc.qualificationStage === 'WITHDRAWN') target = 'DRAFT';
  out.target = target;
  const identity = verified ? { codeHash: verification.codeHash, dataLineage: verification.datasetHash } : {};
  let s = existing || registry.register({ id: source.id, name: source.name, version, params: paramsOf(doc) ?? {}, markets: source.markets, probabilistic: source.probabilistic, ...identity }, now);
  if (['PAUSED', 'RETIRED'].includes(s.state)) { out.state = s.state; out.skipped = `Strategy is ${s.state} (user decision)`; return out; }
  if (s.version !== version) s = registry.revise(source.id, { version, params: paramsOf(doc), reason: 'Lab published a new champion', ...(verified ? identity : { codeHash: null, dataLineage: null }) }, now);
  let evidence = labGateEvidence(doc, verification, s);
  const steps = ['DRAFT', 'BACKTESTING', 'PAPER'];
  // Verified Lab evidence is attached to this version before any gated move (the registry refuses
  // promotion on evidence that is not attached). Previously verified evidence that no longer verifies
  // is replaced, which suspends any paper eligibility it supported.
  if ((verified || s.evidence?.source === 'lab-provenance.v1') && canonicalJson(s.evidence) !== canonicalJson(evidence) && typeof registry.attachLabEvidence === 'function') {
    s = registry.attachLabEvidence(source.id, evidence, verification, `Lab provenance ${verification.status}`, now);
    evidence = s.evidence;
  }
  const reason = `Lab champion sync: Lab state ${lab}, stage ${doc.qualificationStage || 'unknown'}, provenance ${verification.status}`;
  // Down one step at a time (demotions have no gate).
  const lower = { LIVE: 'CANDIDATE', CANDIDATE: 'PAPER', PAPER: 'BACKTESTING', BACKTESTING: 'DRAFT' };
  while (rank(s.state) > rank(target) && lower[s.state]) s = transition(source.id, lower[s.state], { reason, evidence: s.evidence?.source === 'lab-provenance.v1' ? s.evidence : evidence });
  while (rank(s.state) < rank(target)) {
    const next = steps[steps.indexOf(s.state) + 1];
    if (!next) break;
    const check = promotionCheck(next, evidence, { probabilistic: source.probabilistic });
    if (!check.allowed) { out.blockers = [...check.blockers, ...(verified ? [] : verification.blockers)]; break; }
    s = transition(source.id, next, { reason, evidence });
  }
  out.state = s.state;
  return out;
}

export function syncLabChampions(registry, labLinkDir, opts = {}) {
  const dataDir = opts.dataDir ?? path.dirname(labLinkDir);
  return LAB_CHAMPION_SOURCES.map(src => {
    try { return syncLabChampion(registry, src, readLabChampion(labLinkDir, src), { ...opts, dataDir }); }
    catch (e) { return { id: src.id, error: String(e?.message || e).slice(0, 200) }; }
  });
}
