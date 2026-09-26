export const EVENTS = Object.freeze(['MARKET_PRICE_UPDATED', 'ORDERBOOK_UPDATED', 'SPORT_EVENT_UPDATED', 'NEWS_RECEIVED', 'SEC_FILING_RECEIVED', 'MACRO_RELEASED', 'WALLET_ACTIVITY', 'SIGNAL_CREATED', 'ORDER_PROPOSED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_FILLED', 'RISK_STATE_CHANGED']);

// Financial commits happen in the database first. Subscribers are bounded notifications,
// never an accounting or execution authority; a failed UI observer cannot undo a fill.
export class MarketEventBus {
  #listeners = new Map(); #queue = []; #scheduled = false;
  constructor({ capacity = 1000 } = {}) { this.capacity = capacity; this.metrics = { published: 0, delivered: 0, dropped: 0, listenerErrors: 0, lastError: null }; }
  on(type, fn) {
    if (!EVENTS.includes(type) || typeof fn !== 'function') throw new Error('Invalid event subscription');
    const set = this.#listeners.get(type) || new Set(); set.add(fn); this.#listeners.set(type, set);
    return () => set.delete(fn);
  }
  publish(type, data) {
    if (!EVENTS.includes(type)) throw new Error('Unknown event type');
    this.metrics.published++;
    if (this.#queue.length >= this.capacity) { this.metrics.dropped++; return false; }
    this.#queue.push({ type, at: Date.now(), data: structuredClone(data) });
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
  snapshot() { return { ...this.metrics, queueDepth: this.#queue.length }; }
}
