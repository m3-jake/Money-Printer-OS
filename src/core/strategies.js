import { canonicalJson, finite, fingerprint, requiredText } from './model.js';
import { REPLAY_EVALUATOR_VERSION, paramGrid } from './replay.js';

// Common strategy metadata and lifecycle. Every transition is appended to strategy_transitions;
// the strategies row is only the latest reading of that history.
export const STRATEGY_STATES = Object.freeze(['DRAFT', 'BACKTESTING', 'PAPER', 'CANDIDATE', 'LIVE', 'PAUSED', 'RETIRED']);
const EDGES = {
  DRAFT: ['BACKTESTING', 'PAUSED', 'RETIRED'],
  BACKTESTING: ['DRAFT', 'PAPER', 'PAUSED', 'RETIRED'],
  PAPER: ['BACKTESTING', 'CANDIDATE', 'PAUSED', 'RETIRED'],
  CANDIDATE: ['PAPER', 'LIVE', 'PAUSED', 'RETIRED'],
  LIVE: ['CANDIDATE', 'PAPER', 'PAUSED', 'RETIRED'],
  PAUSED: ['DRAFT', 'BACKTESTING', 'PAPER', 'RETIRED'],
  RETIRED: [],
};
// Gated moves: both need evidence; neither can pass on one metric alone.
export const PROMOTION_CRITERIA = Object.freeze({
  PAPER: { minSample: 30, requireOutOfSample: true, requireCosts: true, maxDrawdownPct: 35, minStableFolds: 0.5 },
  CANDIDATE: { minSample: 50, requireOutOfSample: true, requireCosts: true, maxDrawdownPct: 25, minStableFolds: 0.6, maxBrier: 0.25 },
});
export const strategyEvidenceIdentity = s => fingerprint({ id: s.id, version: s.version, params: s.params,
  identity: { codeHash: null, dataLineage: null, feeModelHash: null, ...(s.identity || {}) } });
function matchesRegisteredReplayPolicy(s, run, summary) {
  try {
    const family = s.params?.replayStrategy, parameters = s.params?.parameters;
    if (typeof family !== 'string' || !parameters || typeof parameters !== 'object' || Array.isArray(parameters) || run.strategy !== `walkforward:${family}`) return false;
    const grid = JSON.parse(run.params).grid || {}, combinations = paramGrid(family, grid);
    return combinations.length === 1 && canonicalJson(combinations[0]) === canonicalJson(parameters)
      && Array.isArray(summary.folds) && summary.folds.length > 0
      && summary.folds.every(f => f.train?.candidates === 1 && canonicalJson(f.train.params) === canonicalJson(parameters));
  } catch { return false; }
}

// Only evidence produced by a current verified evaluator can qualify. Legacy Market Lab
// artifacts are retained in history but its pre-v2 accounting must not promote strategies.
// Missing values fail closed with a named blocker. Brier is checked only when the strategy prices probabilities.
export function promotionCheck(target, evidence = {}, { probabilistic = false } = {}) {
  const c = PROMOTION_CRITERIA[target];
  if (!c) return { allowed: true, blockers: [] };
  const e = evidence && typeof evidence === 'object' ? evidence : {}, blockers = [];
  const n = finite(e.sampleSize), effective = finite(e.effectiveSampleSize), oos = finite(e.outOfSampleNetUsd) ?? finite(e.outOfSampleNetPct), dd = finite(e.maxDrawdownPct), folds = finite(e.positiveFoldShare);
  if (e.evaluatorVersion !== REPLAY_EVALUATOR_VERSION) blockers.push('EVALUATOR_VERSION_UNVERIFIED');
  if (e.verifiedEvaluatorOutput !== true) blockers.push('EVALUATOR_OUTPUT_UNVERIFIED');
  if (typeof e.strategyIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(e.strategyIdentity)) blockers.push('STRATEGY_IDENTITY_UNVERIFIED');
  if (n === null || n < c.minSample || effective === null || effective < c.minSample || effective > n) blockers.push(`SAMPLE_SIZE<${c.minSample}`);
  if (finite(e.lookAheadViolations) !== 0) blockers.push('LOOK_AHEAD_UNVERIFIED');
  if (finite(e.syntheticShare) !== 0) blockers.push('EXECUTION_DATA_SYNTHETIC_OR_UNKNOWN');
  if (finite(e.pendingOpenPositions) !== 0) blockers.push('OPEN_POSITIONS_WITH_UNMODELED_EXIT_COST');
  if (finite(e.incompleteFolds) !== 0) blockers.push('INCOMPLETE_WALK_FORWARD_FOLDS');
  if (c.requireCosts && e.costsModeled !== true) blockers.push('FEES_AND_SLIPPAGE_NOT_MODELED');
  if (c.requireOutOfSample && (oos === null || oos <= 0)) blockers.push('OUT_OF_SAMPLE_NOT_PROFITABLE_AFTER_COSTS');
  if (dd === null || dd > c.maxDrawdownPct) blockers.push(`MAX_DRAWDOWN>${c.maxDrawdownPct}%`);
  if (folds === null || folds < c.minStableFolds) blockers.push(`UNSTABLE_ACROSS_FOLDS<${c.minStableFolds}`);
  if (probabilistic && c.maxBrier !== undefined) { const b = finite(e.brier); if (b === null || b > c.maxBrier) blockers.push(`CALIBRATION_BRIER>${c.maxBrier}`); }
  return { allowed: blockers.length === 0, blockers, criteria: c };
}

// Evolution Lab champions keep their own lifecycle (championState.js). This is the read-only
// mapping into the common states. LIVE never grants real money, so it reads as PAPER.
export function labChampionLifecycle(championStateValue) {
  return { INCUBATOR: 'DRAFT', SHADOW: 'BACKTESTING', PAPER: 'PAPER', LIVE: 'PAPER' }[championStateValue] || 'BACKTESTING';
}

export class StrategyRegistry {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS strategies(id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, markets TEXT NOT NULL,
        params TEXT NOT NULL, allocation_usd REAL NOT NULL, state TEXT NOT NULL, execution_mode TEXT NOT NULL, probabilistic INTEGER NOT NULL,
        evidence TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS strategy_transitions(seq INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
        at INTEGER NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL, FOREIGN KEY(strategy_id) REFERENCES strategies(id));
      CREATE TRIGGER IF NOT EXISTS strategy_transitions_no_delete BEFORE DELETE ON strategy_transitions BEGIN SELECT RAISE(ABORT,'Strategy history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS strategy_transitions_no_update BEFORE UPDATE ON strategy_transitions BEGIN SELECT RAISE(ABORT,'Strategy history is append-only'); END;`);
    if (!store.db.prepare('PRAGMA table_info(strategies)').all().some(c => c.name === 'identity'))
      store.db.exec("ALTER TABLE strategies ADD COLUMN identity TEXT NOT NULL DEFAULT '{}'");
    // Old evaluator results remain in append-only history. Suspend active paper
    // eligibility on open rather than waiting for a user to attach new evidence.
    for (const row of store.db.prepare("SELECT id,state,evidence FROM strategies WHERE state IN ('PAPER','CANDIDATE','LIVE')").all()) {
      let evidence; try { evidence = JSON.parse(row.evidence); } catch { evidence = {}; }
      const s = this.get(row.id), gate = promotionCheck(row.state === 'CANDIDATE' ? 'CANDIDATE' : 'PAPER', evidence, { probabilistic: s.probabilistic });
      if (row.state !== 'LIVE' && evidence.strategyIdentity === strategyEvidenceIdentity(s) && gate.allowed) continue;
      store.transaction(() => {
        store.db.prepare("UPDATE strategies SET state='BACKTESTING',evidence='{}',updated_at=? WHERE id=?").run(Date.now(), row.id);
        store.db.prepare('INSERT INTO strategy_transitions(strategy_id,from_state,to_state,at,reason,evidence) VALUES(?,?,?,?,?,?)').run(row.id,row.state,'BACKTESTING',Date.now(),'Existing evidence invalidated: evaluator or strategy identity is incompatible',canonicalJson(evidence));
        store.record('STRATEGY_EVIDENCE_INVALIDATED',{id:row.id,priorState:row.state,reason:'Evaluator or strategy identity incompatible'});
      });
    }
  }
  register({ id, name, version = '1', markets = [], params = {}, allocationUsd = 0, probabilistic = false, codeHash = null, dataLineage = null, feeModelHash = null }, now = Date.now()) {
    requiredText(id, 'Strategy ID', 100); requiredText(name, 'Strategy name', 200); requiredText(String(version), 'Strategy version', 50);
    if (!Array.isArray(markets) || markets.some(m => typeof m !== 'string' || !m.trim())) throw new Error('Supported markets must be a list of venue IDs');
    const alloc = finite(allocationUsd); if (alloc === null || alloc < 0) throw new Error('Capital allocation must be a nonnegative amount');
    return this.store.transaction(() => {
      if (this.store.db.prepare('SELECT 1 FROM strategies WHERE id=?').get(id)) throw new Error('Strategy ID already registered');
      this.store.db.prepare('INSERT INTO strategies(id,name,version,markets,params,allocation_usd,state,execution_mode,probabilistic,evidence,created_at,updated_at,identity) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, name, String(version), canonicalJson(markets), canonicalJson(params), alloc, 'DRAFT', 'PAPER', probabilistic ? 1 : 0, '{}', now, now, canonicalJson({ codeHash, dataLineage, feeModelHash }));
      this.store.db.prepare('INSERT INTO strategy_transitions(strategy_id,from_state,to_state,at,reason,evidence) VALUES(?,?,?,?,?,?)').run(id, null, 'DRAFT', now, 'Registered', '{}');
      this.store.record('STRATEGY_REGISTERED', { id, name, version: String(version) }, now);
      return this.get(id);
    });
  }
  get(id) {
    const r = this.store.db.prepare('SELECT * FROM strategies WHERE id=?').get(id);
    return r ? { id: r.id, name: r.name, version: r.version, markets: JSON.parse(r.markets), params: JSON.parse(r.params), allocationUsd: r.allocation_usd, state: r.state,
      executionMode: r.execution_mode, probabilistic: r.probabilistic === 1, evidence: JSON.parse(r.evidence), identity: { codeHash: null, dataLineage: null, feeModelHash: null, ...JSON.parse(r.identity || '{}') }, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }
  // A changed strategy or assumption is a new identity. Invalidate incompatible evidence
  // immediately, and suspend any paper eligibility until fresh validation is attached.
  revise(id, { version, params = null, codeHash, dataLineage, feeModelHash, reason }, now = Date.now()) {
    requiredText(String(version ?? ''), 'Strategy version', 100); requiredText(reason, 'Revision reason', 500);
    return this.store.transaction(() => {
      const s = this.get(id); if (!s) throw new Error('Unknown strategy');
      const nextParams = params ?? s.params;
      const nextIdentity = { codeHash: codeHash === undefined ? s.identity.codeHash ?? null : codeHash,
        dataLineage: dataLineage === undefined ? s.identity.dataLineage ?? null : dataLineage,
        feeModelHash: feeModelHash === undefined ? s.identity.feeModelHash ?? null : feeModelHash };
      if (s.version === String(version) && canonicalJson(nextParams) === canonicalJson(s.params) && canonicalJson(nextIdentity) === canonicalJson(s.identity)) return s;
      if (s.version === String(version)) throw new Error('Parameter or assumption changes require a new strategy version');
      const nextState = ['PAPER', 'CANDIDATE', 'LIVE'].includes(s.state) ? 'BACKTESTING' : s.state;
      this.store.db.prepare('UPDATE strategies SET version=?,params=?,identity=?,state=?,evidence=?,updated_at=? WHERE id=?').run(String(version), canonicalJson(nextParams), canonicalJson(nextIdentity), nextState, '{}', now, id);
      this.store.db.prepare('INSERT INTO strategy_transitions(strategy_id,from_state,to_state,at,reason,evidence) VALUES(?,?,?,?,?,?)').run(id, s.state, nextState, now, `${reason} (version ${s.version} -> ${version}; prior evidence invalidated)`, canonicalJson(s.evidence));
      this.store.record('STRATEGY_REVISED', { id, from: s.version, to: String(version), priorState: s.state, state: nextState, evidenceInvalidated: true }, now);
      return this.get(id);
    });
  }
  // Evidence from a validation run (e.g. Market Lab walk-forward) replaces the stored evidence without
  // changing state; the history row keeps what was attached and why. Promotion still needs a transition.
  attachEvidence(id, evidence, reason, now = Date.now()) {
    requiredText(reason, 'Evidence reason', 500);
    if (!evidence || typeof evidence !== 'object') throw new Error('Evidence object required');
    return this.store.transaction(() => {
      const s = this.get(id); if (!s) throw new Error('Unknown strategy');
      if (s.state === 'RETIRED') throw new Error('Retired strategies do not take new evidence');
      let verified = false;
      if (evidence.labRunId && evidence.evaluatorVersion === REPLAY_EVALUATOR_VERSION) {
        try {
          const run = this.store.db.prepare('SELECT at,dataset_fp,strategy,params,result FROM lab_runs WHERE id=?').get(String(evidence.labRunId));
          const summary = run ? JSON.parse(run.result) : null, actual = summary?.evidence;
          const identity = strategyEvidenceIdentity(s);
          verified = !!actual && run.at >= s.updatedAt && run.dataset_fp === evidence.datasetFp && summary.strategyIdentity === identity && evidence.strategyIdentity === identity
            && matchesRegisteredReplayPolicy(s, run, summary)
            && Object.entries(actual).every(([k, v]) => canonicalJson(v) === canonicalJson(evidence[k]));
        } catch { verified = false; }
      }
      return this.#storeEvidence(id, s, { ...evidence, verifiedEvaluatorOutput: verified }, reason, now);
    });
  }
  // Evidence transported from Evolution Lab provenance (labSync.verifyLabProvenance). It keeps
  // verifiedEvaluatorOutput only when the verification is VERIFIED and binds to this exact version:
  // registry identity, code hash and dataset lineage all match. Anything else is stored unverified, which
  // suspends paper eligibility like any other new evidence. The common gate is unchanged.
  attachLabEvidence(id, evidence, verification, reason, now = Date.now()) {
    requiredText(reason, 'Evidence reason', 500);
    if (!evidence || typeof evidence !== 'object') throw new Error('Evidence object required');
    return this.store.transaction(() => {
      const s = this.get(id); if (!s) throw new Error('Unknown strategy');
      if (s.state === 'RETIRED') throw new Error('Retired strategies do not take new evidence');
      const bound = verification?.status === 'VERIFIED' && evidence.verifiedEvaluatorOutput === true && evidence.source === 'lab-provenance.v1'
        && evidence.strategyIdentity === strategyEvidenceIdentity(s) && evidence.labStrategyIdentity === verification.strategyIdentity
        && s.identity.codeHash === verification.codeHash && s.identity.dataLineage === verification.datasetHash && evidence.evaluatorVersion === verification.evaluatorVersion
        && evidence.evaluatorOutputHash === verification.evaluatorOutputHash
        && Object.entries(verification.evaluatorOutput || {}).every(([k, v]) => v == null ? evidence[k] == null : canonicalJson(v) === canonicalJson(evidence[k]));
      return this.#storeEvidence(id, s, { ...evidence, verifiedEvaluatorOutput: bound }, reason, now);
    });
  }
  #storeEvidence(id, s, attached, reason, now) {
      const checks = { PAPER: promotionCheck('PAPER', attached, { probabilistic: s.probabilistic }), CANDIDATE: promotionCheck('CANDIDATE', attached, { probabilistic: s.probabilistic }) };
      const nextState = s.state === 'CANDIDATE' && !checks.CANDIDATE.allowed ? (checks.PAPER.allowed ? 'PAPER' : 'BACKTESTING')
        : s.state === 'PAPER' && !checks.PAPER.allowed ? 'BACKTESTING' : s.state;
      this.store.db.prepare('UPDATE strategies SET evidence=?,state=?,updated_at=? WHERE id=?').run(canonicalJson(attached), nextState, now, id);
      this.store.db.prepare('INSERT INTO strategy_transitions(strategy_id,from_state,to_state,at,reason,evidence) VALUES(?,?,?,?,?,?)').run(id, s.state, nextState, now, nextState === s.state ? reason : `${reason}; eligibility suspended by new evidence`, canonicalJson(attached));
      this.store.record('STRATEGY_EVIDENCE_ATTACHED', { id, reason, priorState: s.state, state: nextState }, now);
      return { ...this.get(id), checks };
  }
  list() { return this.store.db.prepare('SELECT id FROM strategies ORDER BY updated_at DESC').all().map(r => this.get(r.id)); }
  history(id) { return this.store.db.prepare('SELECT * FROM strategy_transitions WHERE strategy_id=? ORDER BY seq').all(id).map(r => ({ ...r, evidence: JSON.parse(r.evidence) })); }
  transition(id, to, { reason, evidence = null } = {}, now = Date.now()) {
    requiredText(reason, 'Transition reason', 500);
    return this.store.transaction(() => {
      const s = this.get(id); if (!s) throw new Error('Unknown strategy');
      if (!STRATEGY_STATES.includes(to)) throw new Error('Unknown strategy state');
      if (!EDGES[s.state].includes(to)) throw new Error(`Transition ${s.state} -> ${to} is not allowed`);
      // Real-money execution is not available; LIVE cannot be reached from here.
      if (to === 'LIVE') throw new Error('LIVE is unavailable until live adapters are certified and accounts reconciled');
      const used = evidence ?? s.evidence, check = promotionCheck(to, used, { probabilistic: s.probabilistic });
      if (PROMOTION_CRITERIA[to] && canonicalJson(used) !== canonicalJson(s.evidence)) check.blockers.push('EVIDENCE_NOT_ATTACHED_TO_VERSION');
      check.allowed = check.blockers.length === 0;
      if (!check.allowed) throw Object.assign(new Error(`Promotion to ${to} blocked: ${check.blockers.join(', ')}`), { code: 'PROMOTION_BLOCKED', blockers: check.blockers });
      this.store.db.prepare('UPDATE strategies SET state=?,evidence=?,updated_at=? WHERE id=?').run(to, canonicalJson(used), now, id);
      this.store.db.prepare('INSERT INTO strategy_transitions(strategy_id,from_state,to_state,at,reason,evidence) VALUES(?,?,?,?,?,?)').run(id, s.state, to, now, reason, canonicalJson(used));
      const promoted = STRATEGY_STATES.indexOf(to) > STRATEGY_STATES.indexOf(s.state) && !['PAUSED', 'RETIRED'].includes(to);
      this.store.record(promoted ? 'STRATEGY_PROMOTED' : 'STRATEGY_DEMOTED', { id, from: s.state, to, reason }, now);
      return { ...this.get(id), promoted };
    });
  }
}
