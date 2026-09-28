import { randomUUID } from 'node:crypto';
export const EVENTS = Object.freeze(['MARKET_PRICE_UPDATED', 'ORDERBOOK_UPDATED', 'SPORT_EVENT_UPDATED', 'NEWS_RECEIVED', 'SEC_FILING_RECEIVED', 'MACRO_RELEASED', 'WALLET_ACTIVITY', 'SIGNAL_CREATED', 'ORDER_PROPOSED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_FILLED', 'RISK_STATE_CHANGED', 'OPPORTUNITY_FOUND', 'RESEARCH_COMPLETED']);

// Bounded notifications, never accounting authority. Explicit source-event identities dedupe
// retries; entity/order IDs alone are NOT event IDs (partial fills must remain distinct).
export class MarketEventBus {
  #listeners = new Map(); #queue = []; #scheduled = false; #seen = new Map();
  constructor({ capacity = 1000, dedupeCapacity = 5000, dedupeTtlMs = 300000, now = Date.now } = {}) {
    for (const [name, value] of Object.entries({ capacity, dedupeCapacity, dedupeTtlMs })) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid event bus ' + name);
    this.capacity = capacity; this.dedupeCapacity = dedupeCapacity; this.dedupeTtlMs = dedupeTtlMs; this.now = now;
    this.metrics = { published: 0, delivered: 0, dropped: 0, duplicates: 0, listenerErrors: 0, lastError: null };
  }
  on(type, fn) {
    if (!EVENTS.includes(type) || typeof fn !== 'function') throw new Error('Invalid event subscription');
    const set = this.#listeners.get(type) || new Set(); set.add(fn); this.#listeners.set(type, set);
    return () => set.delete(fn);
  }
  publish(type, data, metadata = {}) {
    if (!EVENTS.includes(type)) throw new Error('Unknown event type');
    this.metrics.published++;
    const at = this.now(), source = String(metadata.source || data?.provider || data?.source || 'mpos').slice(0, 200);
    for (const [key, expiry] of this.#seen) { if (expiry > at) break; this.#seen.delete(key); }
    const sourceId = metadata.id ?? metadata.dedupeKey ?? data?.eventId;
    const id = sourceId == null ? randomUUID() : String(sourceId).slice(0, 1024);
    const dedupeKey = sourceId == null ? null : JSON.stringify([type, source, id]);
    if (dedupeKey && this.#seen.has(dedupeKey)) { this.metrics.duplicates++; return false; }
    if (this.#queue.length >= this.capacity) { this.metrics.dropped++; return false; }
    const validTime = value => Number.isSafeInteger(value) && value > 0;
    const observedAt = validTime(metadata.observedAt) ? metadata.observedAt : at;
    const expiry = metadata.expiresAt ?? data?.expiresAt;
    const expiresAt = validTime(expiry) ? expiry : null;
    const confidence = metadata.confidence ?? data?.confidence;
    const relevance = metadata.marketRelevance ?? data?.marketRelevance;
    const event = { schema: 'mpo.market-event.v1', id, type, at, observedAt, availableAt: at, source,
      expiresAt, freshness: expiresAt === null ? 'UNKNOWN' : expiresAt <= at ? 'STALE' : 'FRESH',
      confidence: typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
      marketRelevance: Array.isArray(relevance) ? [...new Set(relevance.filter(v => typeof v === 'string').map(v => v.slice(0, 200)))].slice(0, 30) : [],
      data: structuredClone(data) };
    if (dedupeKey) {
      this.#seen.set(dedupeKey, at + this.dedupeTtlMs);
      while (this.#seen.size > this.dedupeCapacity) this.#seen.delete(this.#seen.keys().next().value);
    }
    this.#queue.push(event);
    if (!this.#scheduled) { this.#scheduled = true; setImmediate(() => this.#drain()); }
    return true;
  }
  #drain() {
    const batch = this.#queue.splice(0, 100);
    for (const event of batch) for (const fn of this.#listeners.get(event.type) || []) {
      try { Promise.resolve(fn(structuredClone(event))).catch(e => this.#error(e)); this.metrics.delivered++; } catch (e) { this.#error(e); }
    }
    if (this.#queue.length) setImmediate(() => this.#drain()); else this.#scheduled = false;
  }
  #error(error) { this.metrics.listenerErrors++; this.metrics.lastError = String(error?.message || 'Listener failed').slice(0, 200); }
  snapshot() { return { ...this.metrics, queueDepth: this.#queue.length, dedupeEntries: this.#seen.size }; }
}
