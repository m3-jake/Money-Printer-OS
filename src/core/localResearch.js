// This development build cannot spend model credits, even when credentials are present.
import { createHash } from 'node:crypto';
export const PAID_AI_BUILD_ENABLED = false;
export const LOCAL_RESEARCH_MODEL = 'mpos-local-excerpts.v1';
export function assertPaidResearchEnabled() {
  if (!PAID_AI_BUILD_ENABLED) throw Object.assign(new Error('Paid model calls are disabled in this zero-credit build; use cached research or local excerpts'), { code: 'PAID_AI_DISABLED' });
}
export function localFilingSummary({ text, facts = {}, now = Date.now() }) {
  const body = String(text || '');
  if (!body.trim()) throw new Error('Filing text is empty');
  if (body.length > 1_500_000) throw Object.assign(new Error('Filing exceeds the local extraction limit; read the source directly'), { code: 'TOO_LONG' });
  const candidates = []; let cursor = 0;
  for (const separator of body.matchAll(/[.!?](?=\s)|\n+|$/g)) {
    const end = separator.index + (/^[.!?]$/.test(separator[0]) ? 1 : 0);
    const raw = body.slice(cursor, end), trimmed = raw.trim();
    if (trimmed.length >= 40) {
      const start = cursor + raw.indexOf(trimmed);
      let length = Math.min(700, trimmed.length);
      if (length < trimmed.length) { const word = trimmed.lastIndexOf(' ', length); if (word > 350) length = word; }
      const quote = body.slice(start, start + length);
      const score = (/revenue|earnings|income|loss|cash|guidance|risk|agreement|acquisition|director|officer|debt|liquidity/i.test(quote) ? 4 : 0) + (/\$|\d[%]|million|billion/i.test(quote) ? 2 : 0);
      candidates.push({ quote, start, end: start + length, score, excerpted: length < trimmed.length });
    }
    cursor = separator.index + separator[0].length;
  }
  const seen = new Set(), selected = candidates.sort((a, b) => b.score - a.score || a.start - b.start).filter(c => !seen.has(c.quote) && seen.add(c.quote)).slice(0, 6).sort((a, b) => a.start - b.start);
  if (!selected.length) { const quote = body.trim().slice(0, 700), start = body.indexOf(quote); selected.push({ quote, start, end: start + quote.length, excerpted: quote.length < body.trim().length }); }
  return { kind: 'LOCAL_EXTRACTIVE_SUMMARY', status: 'LOCAL_EXCERPTS', model: LOCAL_RESEARCH_MODEL,
    at: now, source: facts.url || null, subject: facts.accession || null,
    contentHash: createHash('sha256').update(body).digest('hex'), expiresAt: null,
    freshness: 'IMMUTABLE_FILING_SNAPSHOT', originatingModule: 'edgar',
    marketsAffected: facts.ticker ? [facts.ticker] : [], confidence: null,
    scope: 'Selected verbatim source excerpts, not a complete summary, model analysis, or investment assessment. Consult the full filing.',
    blocks: selected.map(c => ({ text: c.quote, excerpted: c.excerpted, citations: [{ quote: c.quote, start: c.start, end: c.end }] })),
    usage: { input: 0, output: 0 }, cost: { modelCalls: 0, tokens: 0 }, citedShare: 1 };
}

// Shared, durable cache. An expired result is never silently returned as fresh.
export class ResearchCache {
  constructor(store, { now = Date.now } = {}) {
    this.store = store; this.now = now;
    store.db.exec(`CREATE TABLE IF NOT EXISTS local_research_cache(
      identity TEXT PRIMARY KEY, content_hash TEXT NOT NULL, result TEXT NOT NULL,
      at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER NOT NULL, reuse_count INTEGER NOT NULL DEFAULT 0);`);
  }
  get(identity) {
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM local_research_cache WHERE identity=?').get(identity);
      if (!row || (row.expires_at !== null && row.expires_at <= this.now())) return null;
      this.store.db.prepare('UPDATE local_research_cache SET last_used_at=?,reuse_count=reuse_count+1 WHERE identity=?').run(this.now(), identity);
      return { ...JSON.parse(row.result), at: row.at, cached: true, reuseCount: row.reuse_count + 1 };
    });
  }
  put(identity, result) {
    if (!identity || !result?.contentHash) throw new Error('Research identity and content hash are required');
    const expiresAt = result.expiresAt ?? null;
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now())) throw new Error('Research expiry must be a future timestamp or null for immutable evidence');
    const at = this.now(), stored = { ...result, at };
    this.store.db.prepare(`INSERT INTO local_research_cache VALUES(?,?,?,?,?,?,0)
      ON CONFLICT(identity) DO UPDATE SET content_hash=excluded.content_hash,result=excluded.result,
      at=excluded.at,expires_at=excluded.expires_at,last_used_at=excluded.last_used_at,reuse_count=0`)
      .run(identity, result.contentHash, JSON.stringify(stored), at, expiresAt, at);
    return { ...stored, cached: false, reuseCount: 0 };
  }
  snapshot() {
    const now = this.now();
    const row = this.store.db.prepare('SELECT COUNT(*) entries,COALESCE(SUM(reuse_count),0) reused FROM local_research_cache WHERE expires_at IS NULL OR expires_at>?').get(now);
    return { ...row, paidModelsEnabled: PAID_AI_BUILD_ENABLED, mode: 'ZERO_CREDIT_BUILD' };
  }
}
