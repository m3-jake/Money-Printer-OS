import { PAID_AI_BUILD_ENABLED } from './localResearch.js';
// Unknown/failed provider calls retain reservations, including across process restarts.
import { randomUUID } from 'node:crypto';
export class ResearchBudget {
  constructor(store, { now = Date.now, env = process.env } = {}) {
    this.store = store; this.now = now; this.env = env;
    store.db.exec(`CREATE TABLE IF NOT EXISTS research_usage(
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, category TEXT NOT NULL, identity TEXT NOT NULL,
      reserved INTEGER NOT NULL, status TEXT NOT NULL, usage TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS research_usage_at ON research_usage(at);`);
  }
  limits() {
    const limit = (name, fallback) => {
      const v = this.env[name] === undefined ? fallback : Number(this.env[name]);
      if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Invalid research limit: ${name}`);
      return v;
    };
    return { calls: limit('MPO_AI_DAILY_CALLS', 0), tokens: limit('MPO_AI_DAILY_TOKEN_RESERVATIONS', 0) };
  }
  snapshot() {
    const since = Math.floor(this.now() / 86400000) * 86400000;
    const rows = this.store.db.prepare('SELECT * FROM research_usage WHERE at>=?').all(since);
    return { paidModelsEnabled: PAID_AI_BUILD_ENABLED, mode: 'ZERO_CREDIT_BUILD', scope: 'Optional SEC model adapter / UTC day; paid execution is build-locked',
      limits: this.limits(), calls: rows.length, reservedTokens: rows.reduce((n, r) => n + r.reserved, 0),
      uncertain: rows.filter(r => r.status !== 'COMPLETED').length,
      actualTokens: rows.reduce((n, r) => { const u = r.usage ? JSON.parse(r.usage) : {}; return n + (u.input || 0) + (u.output || 0); }, 0) };
  }
  reserve(identity, text, outputTokens) {
    const reserved = Buffer.byteLength(text, 'utf8') + outputTokens + 4096;
    return this.store.transaction(() => {
      const s = this.snapshot();
      if (s.calls >= s.limits.calls || s.reservedTokens + reserved > s.limits.tokens)
        throw Object.assign(new Error('Daily research budget exhausted; cached summaries remain available'), { code: 'RESEARCH_BUDGET' });
      const id = randomUUID();
      this.store.db.prepare('INSERT INTO research_usage VALUES(?,?,?,?,?,?,?,?)')
        .run(id, this.now(), 'sec-summary', identity, reserved, 'RESERVED', null, null);
      return id;
    });
  }
  finish(id, result, error = null) {
    this.store.db.prepare('UPDATE research_usage SET status=?,usage=?,error=? WHERE id=?')
      .run(error ? 'UNCERTAIN' : 'COMPLETED', result?.usage ? JSON.stringify(result.usage) : null,
        error ? String(error.code || 'PROVIDER_ERROR').slice(0, 100) : null, id);
  }
}
