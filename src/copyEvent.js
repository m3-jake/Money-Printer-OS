// Public trade receipts shared by paper followers. A price stream is not a wallet stream.
export const COPY_EVENT_SCHEMA = 'mpo.copy-event.v1';
export function tradeKey(wallet, t) {
  return [String(wallet || '').toLowerCase(), t.transactionHash, t.asset, t.side, t.timestamp, t.size].join(':');
}
export function copyEvent(leader, t, observedAt, experimentId) {
  return { schema: COPY_EVENT_SCHEMA, id: tradeKey(leader.wallet, t), sourceWallet: leader.wallet,
    sourceVenue: 'polymarket-global', sourceTradeId: t.transactionHash, eventAt: Number(t.timestamp) * 1000,
    firstObservedAt: observedAt, instrument: String(t.asset || ''), conditionId: t.conditionId || null,
    outcome: t.outcome || null, side: t.side, quantity: Number(t.size), sourcePrice: Number(t.price),
    provenance: 'public-data-api-trades', leaderSelection: { ...leader }, experimentId };
}
export function validCopyTrade(t, at) {
  return !!t?.transactionHash && !!t.asset && ['BUY', 'SELL'].includes(t.side)
    && Number.isFinite(Number(t.size)) && Number(t.size) > 0 && Number(t.price) > 0 && Number(t.price) < 1
    && Number.isSafeInteger(Number(t.timestamp) * 1000) && Number(t.timestamp) > 0 && Number(t.timestamp) * 1000 <= at;
}
// Bounded, overlapping catch-up. Never pretend the provider's truncated history is complete.
// See docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets (limit/offset).
export async function fetchLeaderTrades(get, wallet, { boundaryAt = 0, pageSize = 100, maxPages = 3 } = {}) {
  const rows = new Map(); let complete = false, pages = 0;
  for (; pages < maxPages; pages++) {
    const page = await get(`https://data-api.polymarket.com/trades?user=${encodeURIComponent(wallet)}&limit=${pageSize}&offset=${pages * pageSize}&takerOnly=false`);
    if (!Array.isArray(page)) throw new Error('Invalid public trades response');
    for (const t of page) rows.set(tradeKey(wallet, t), t);
    if (page.length < pageSize || page.some(t => Number(t.timestamp) * 1000 < boundaryAt)) { complete = true; pages++; break; }
  }
  return { trades: [...rows.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || tradeKey(wallet, a).localeCompare(tradeKey(wallet, b))), pages, complete };
}
export function classifyCopyMarket(m, t = {}) {
  const explicit = m?.category || m?.sportsMarketType || t.marketType;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().slice(0, 60);
  const tags = [...(Array.isArray(m?.tags) ? m.tags : []), ...(m?.events || []).flatMap(e => Array.isArray(e.tags) ? e.tags : [])]
    .map(x => typeof x === 'string' ? x : x.label || x.slug || '').filter(Boolean);
  if (tags.length) return tags[0].slice(0, 60);
  const title = `${t.title || ''} ${t.eventSlug || ''} ${m?.question || ''}`.toLowerCase();
  for (const [category, re] of [['sports', /\b(vs\.?|nba|nfl|mlb|nhl|soccer|tennis|spread|over\/under)\b/], ['crypto', /\b(bitcoin|btc|ethereum|eth|solana|crypto)\b/], ['weather', /\b(temperature|weather|rain|snow|hurricane)\b/], ['politics', /\b(election|president|senate|congress|governor)\b/], ['macro', /\b(fed|interest rate|gdp|inflation|cpi)\b/]]) if (re.test(title)) return `${category} (title inferred)`;
  return 'unknown';
}
// Metadata may be shared; execution quotes must always be fetched after intent eligibility.
export class CopyMetadataCache {
  constructor({ now = () => Date.now(), ttlMs = 60000, maxEntries = 500 } = {}) { this.now = now; this.ttlMs = ttlMs; this.maxEntries = maxEntries; this.entries = new Map(); }
  async get(key, loader, force = false) {
    const old = this.entries.get(key); if (!force && old && this.now() - old.at < this.ttlMs) return old.value;
    const value = await loader(); if (value != null) { this.entries.set(key, { at: this.now(), value }); while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value); }
    return value;
  }
}
export async function boundedCopyMap(rows, fn, concurrency = 4) {
  const results = new Array(rows.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => { for (;;) { const i = index++; if (i >= rows.length) break; results[i] = await fn(rows[i]); } }));
  return results;
}
export class CopyReadCache extends CopyMetadataCache {
  constructor(options = {}) { super({ ttlMs: 5000, maxEntries: 500, ...options }); this.pending = new Map(); this.stats = { hits: 0, misses: 0, coalesced: 0 }; }
  async get(key, loader) {
    // Whitelist public discovery only. Execution, marks and resolution never enter this cache.
    const u = new URL(key); if (u.origin !== 'https://data-api.polymarket.com' || !['/trades', '/v1/leaderboard'].includes(u.pathname)) return loader();
    const old = this.entries.get(key); if (old && this.now() - old.at < this.ttlMs) { this.stats.hits++; return old.value; }
    if (this.pending.has(key)) { this.stats.coalesced++; return this.pending.get(key); }
    this.stats.misses++; const promise = super.get(key, loader, true); this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }
}
export function copyLatencySummary(receipts = []) {
  const rows = receipts.slice(-2000), percentile = values => {
    const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    return { n: sorted.length, p50Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .5) - 1)] : null, p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)] : null };
  };
  const filled = rows.filter(r => r.status === 'FILLED' && Array.isArray(r.fills) && r.fills.length);
  const rejects = {}; for (const r of rows) if (r.status !== 'FILLED') rejects[r.reason || r.status || 'unknown'] = (rejects[r.reason || r.status || 'unknown'] || 0) + 1;
  return { retainedReceipts: rows.length, scope: 'recent bounded forward receipts; historical unknown timings excluded', sourceToObserve: percentile(rows.map(r => r.firstObservedAt - r.eventAt)), observeToDecision: percentile(rows.map(r => r.decisionAt - r.firstObservedAt)), observeToFill: percentile(filled.map(r => (r.fillAt ?? r.quoteAt) - r.firstObservedAt)), sourceToFill: percentile(filled.map(r => (r.fillAt ?? r.quoteAt) - r.eventAt)), filled: filled.length, rejectionReasons: rejects };
}
