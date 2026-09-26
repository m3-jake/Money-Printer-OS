import { canonicalJson, finite, requiredText } from './model.js';

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

// evidence: { sampleSize, outOfSampleNetUsd, costsModeled, maxDrawdownPct, positiveFoldShare, brier? }.
// Missing values fail closed with a named blocker. Brier is checked only when the strategy prices probabilities.
export function promotionCheck(target, evidence = {}, { probabilistic = false } = {}) {
  const c = PROMOTION_CRITERIA[target];
  if (!c) return { allowed: true, blockers: [] };
  const e = evidence && typeof evidence === 'object' ? evidence : {}, blockers = [];
  const n = finite(e.sampleSize), oos = finite(e.outOfSampleNetUsd), dd = finite(e.maxDrawdownPct), folds = finite(e.positiveFoldShare);
  if (n === null || n < c.minSample) blockers.push(`SAMPLE_SIZE<${c.minSample}`);
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
  }
  register({ id, name, version = '1', markets = [], params = {}, allocationUsd = 0, probabilistic = false }, now = Date.now()) {
    requiredText(id, 'Strategy ID', 100); requiredText(name, 'Strategy name', 200); requiredText(String(version), 'Strategy version', 50);
    if (!Array.isArray(markets) || markets.some(m => typeof m !== 'string' || !m.trim())) throw new Error('Supported markets must be a list of venue IDs');
    const alloc = finite(allocationUsd); if (alloc === null || alloc < 0) throw new Error('Capital allocation must be a nonnegative amount');
    return this.store.transaction(() => {
      if (this.store.db.prepare('SELECT 1 FROM strategies WHERE id=?').get(id)) throw new Error('Strategy ID already registered');
      this.store.db.prepare('INSERT INTO strategies VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, name, String(version), canonicalJson(markets), canonicalJson(params), alloc, 'DRAFT', 'PAPER', probabilistic ? 1 : 0, '{}', now, now);
      this.store.db.prepare('INSERT INTO strategy_transitions(strategy_id,from_state,to_state,at,reason,evidence) VALUES(?,?,?,?,?,?)').run(id, null, 'DRAFT', now, 'Registered', '{}');
      this.store.record('STRATEGY_REGISTERED', { id, name, version: String(version) }, now);
      return this.get(id);
    });
  }
  get(id) {
    const r = this.store.db.prepare('SELECT * FROM strategies WHERE id=?').get(id);
    return r ? { id: r.id, name: r.name, version: r.version, markets: JSON.parse(r.markets), params: JSON.parse(r.params), allocationUsd: r.allocation_usd, state: r.state,
      executionMode: r.execution_mode, probabilistic: r.probabilistic === 1, evidence: JSON.parse(r.evidence), createdAt: r.created_at, updatedAt: r.updated_at } : null;
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
      if (!check.allowed) throw Object.assign(new Error(`Promotion to ${to} blocked: ${check.blockers.join(', ')}`), { code: 'PROMOTION_BLOCKED', blockers: check.blockers });
      this.store.db.prepare('UPDATE strategies SET state=?,evidence=?,updated_at=? WHERE id=?').run(to, canonicalJson(used), now, id);
      this.store.db.prepare('INSERT INTO strategy_transitions(strategy_id,from_state,to_state,at,reason,evidence) VALUES(?,?,?,?,?,?)').run(id, s.state, to, now, reason, canonicalJson(used));
      const promoted = STRATEGY_STATES.indexOf(to) > STRATEGY_STATES.indexOf(s.state) && !['PAUSED', 'RETIRED'].includes(to);
      this.store.record(promoted ? 'STRATEGY_PROMOTED' : 'STRATEGY_DEMOTED', { id, from: s.state, to, reason }, now);
      return { ...this.get(id), promoted };
    });
  }
}
