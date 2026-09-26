import fs from 'node:fs';
import path from 'node:path';

// Market Lab historical replay. A session reveals records strictly in order of when they became
// AVAILABLE (availableAt), never when they were observed or what period they describe, so a strategy
// can only ever see what was knowable at the replay clock. Orders decided at time t fill against the
// first quote that becomes available AFTER t (one-step latency), at the ask to buy and the bid to sell.
//
// Availability rules per source:
//   robinhood-tape live rows      availableAt = t (the quote was received then)
//   robinhood-tape candle rows    availableAt = end of that 1-minute candle; they are synthetic
//                                 (one candle expanded to four 15 s samples, bid = ask), and flagged
//   alpaca minute bars            availableAt = bar start + 60 s (the bar is final only at its close)
//   core order-book history       availableAt = the stored availableAt of that book observation

export const CANDLE_SRC = 'coinbase-candles';
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const minuteEnd = t => Math.floor(t / 60000) * 60000 + 60000;

export function tapeRecords(rows, symbol) {
  const out = [];
  for (const r of rows || []) {
    const t = num(r?.t), bid = num(r?.bid), ask = num(r?.ask);
    if (t === null || !(bid > 0) || !(ask >= bid)) continue;
    const synthetic = r.src === CANDLE_SRC;
    out.push({ key: symbol, observedAt: t, availableAt: synthetic ? minuteEnd(t) : t, bid, ask, synthetic, src: r.src || null });
  }
  return out;
}
export function readTape(dataDir, symbol, { start = 0, end = Infinity } = {}) {
  const file = path.join(dataDir, 'robinhood-tape', `${String(symbol).toUpperCase()}.ndjson`);
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r.t >= start - 60000 && r.t <= end) rows.push(r); } catch {} }
  return tapeRecords(rows, String(symbol).toUpperCase()).filter(r => r.availableAt >= start && r.availableAt <= end);
}
export function tapeSymbols(dataDir) {
  try { return fs.readdirSync(path.join(dataDir, 'robinhood-tape')).filter(f => f.endsWith('.ndjson')).map(f => f.slice(0, -7)).sort(); } catch { return []; }
}
export function alpacaMinuteRecords(bars, symbol) {
  return (bars || []).map(b => { const t = Date.parse(b.t); const c = num(b.c); return Number.isFinite(t) && c > 0 ? { key: symbol, observedAt: t, availableAt: t + 60000, bid: c, ask: c, synthetic: true, src: 'alpaca-minute-close' } : null; }).filter(Boolean);
}
// Minute bars from Alpaca (IEX feed; key required). A bar is final only when its minute ends.
export async function fetchAlpacaMinutes({ symbol, start, end, env = process.env, fetchImpl = globalThis.fetch }) {
  const id = env.ALPACA_KEY_ID || env.APCA_API_KEY_ID, secret = env.ALPACA_SECRET_KEY || env.APCA_API_SECRET_KEY;
  if (!id || !secret) throw Object.assign(new Error('Minute bars need an Alpaca market-data key (ALPACA_KEY_ID / ALPACA_SECRET_KEY)'), { code: 'NO_KEY' });
  const bars = []; let token = null, pages = 0;
  do {
    const u = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    for (const [k, v] of Object.entries({ timeframe: '1Min', start: new Date(start - 60000).toISOString(), end: new Date(end).toISOString(), feed: 'iex', adjustment: 'raw', limit: '10000' })) u.searchParams.set(k, v);
    if (token) u.searchParams.set('page_token', token);
    const r = await fetchImpl(u.toString(), { headers: { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret, accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error(`Alpaca HTTP ${r.status}`), { code: r.status === 401 || r.status === 403 ? 'AUTH_ERROR' : 'HTTP_ERROR' });
    const j = await r.json(); bars.push(...(j.bars || [])); token = j.next_page_token || null; pages++;
  } while (token && pages < 10);
  return alpacaMinuteRecords(bars, String(symbol).toUpperCase());
}
export function bookRecords(versions, key) {
  const out = [];
  for (const v of versions || []) {
    const d = v.data || {}, yb = d.yes?.bids?.[0]?.price, ya = d.yes?.asks?.[0]?.price;
    if (num(yb) === null || num(ya) === null) continue;
    out.push({ key, observedAt: v.observedAt, availableAt: v.availableAt, bid: yb, ask: ya, synthetic: false, src: 'core-orderbook' });
  }
  return out;
}

export class ReplaySession {
  constructor(records, { start, end }) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Replay needs a start before its end');
    this.records = records.filter(r => r.availableAt >= start && r.availableAt <= end).sort((a, b) => a.availableAt - b.availableAt || a.observedAt - b.observedAt);
    this.start = start; this.end = end; this.clock = start; this.i = 0; this.latest = new Map(); this.seen = []; this.byKey = new Map();
    // Anything available exactly at the start is visible from the start.
    this.advanceTo(start);
  }
  get done() { return this.clock >= this.end || this.i >= this.records.length; }
  // Reveals every record with availableAt <= t. The clock never moves backwards.
  advanceTo(t) {
    const to = Math.min(this.end, Math.max(this.clock, t)), fresh = [];
    while (this.i < this.records.length && this.records[this.i].availableAt <= to) { const r = this.records[this.i++]; this.latest.set(r.key, r); this.seen.push(r); if (!this.byKey.has(r.key)) this.byKey.set(r.key, []); this.byKey.get(r.key).push(r); fresh.push(r); }
    this.clock = to; return fresh;
  }
  quote(key) { return this.latest.get(key) || null; }
  // First revealed record for key that became available strictly after t (the fill for a decision at t).
  nextAvailableAfter(t, key) { const h = this.byKey.get(key) || []; let lo = 0, hi = h.length; while (lo < hi) { const m = (lo + hi) >> 1; if (h[m].availableAt <= t) lo = m + 1; else hi = m; } return h[lo] || null; }
  history(key, n = Infinity) { const h = this.byKey.get(key) || []; return n === Infinity ? h : h.slice(-n); }
}

const mid = r => (r.bid + r.ask) / 2;
export const REPLAY_STRATEGIES = Object.freeze({
  'buy-hold': { label: 'Buy and hold', params: {}, decide: ({ position, quote }) => (!position && quote ? 'BUY' : null) },
  momentum: { label: 'Momentum (N visible quotes)', params: { lookback: 20, thresholdBps: 10 },
    decide: ({ history, position, params }) => {
      if (history.length <= params.lookback) return null;
      const now = mid(history.at(-1)), then = mid(history.at(-1 - params.lookback)), move = (now / then - 1) * 10000;
      if (!position && move > params.thresholdBps) return 'BUY';
      if (position && move < -params.thresholdBps) return 'SELL';
      return null;
    } },
  'mean-reversion': { label: 'Mean reversion (N visible quotes)', params: { lookback: 20, thresholdBps: 15 },
    decide: ({ history, position, params }) => {
      if (history.length <= params.lookback) return null;
      const w = history.slice(-params.lookback - 1, -1), avg = w.reduce((s, r) => s + mid(r), 0) / w.length, dev = (mid(history.at(-1)) / avg - 1) * 10000;
      if (!position && dev < -params.thresholdBps) return 'BUY';
      if (position && dev > 0) return 'SELL';
      return null;
    } },
});
export function strategyParams(id, patch = {}) {
  const s = REPLAY_STRATEGIES[id]; if (!s) throw new Error('Unknown replay strategy');
  const out = { ...s.params };
  for (const [k, v] of Object.entries(patch || {})) { if (!(k in out)) continue; const n = num(v); if (n === null || n <= 0 || n > 10000) throw new Error(`Invalid ${k}`); out[k] = k === 'lookback' ? Math.round(n) : n; }
  return out;
}

// Sequential backtest over a session. Decisions see only session-visible data; fills use the next
// record that becomes available after the decision. lookAheadViolations counts any decision input
// whose availableAt is later than the decision time (must be 0; tested).
export function runReplay(session, { key, strategy = 'buy-hold', params = {}, stepMs = 15000, cash = 1000, feeBps = 0, maxPoints = 600 } = {}) {
  const s = REPLAY_STRATEGIES[strategy]; if (!s) throw new Error('Unknown replay strategy');
  const p = strategyParams(strategy, params);
  let position = null, pending = null, violations = 0; const trades = [], curve = [];
  const fee = v => v * feeBps / 10000;
  const markEquity = q => cash + (position && q ? position.qty * q.bid : 0);
  while (!session.done) {
    const t = session.clock;
    if (pending) {
      const fill = session.nextAvailableAfter(pending.at, key);
      if (fill && fill.availableAt <= t) {
        if (pending.side === 'BUY') { const px = fill.ask, qty = cash / (px * (1 + feeBps / 10000)); const f = fee(qty * px); cash -= qty * px + f; position = { qty, px, at: fill.availableAt }; trades.push({ side: 'BUY', at: fill.availableAt, decidedAt: pending.at, price: px, qty, fee: f, synthetic: fill.synthetic }); }
        else { const px = fill.bid, gross = position.qty * px, f = fee(gross); cash += gross - f; trades.push({ side: 'SELL', at: fill.availableAt, decidedAt: pending.at, price: px, qty: position.qty, fee: f, pnl: gross - f - position.qty * position.px, synthetic: fill.synthetic }); position = null; }
        pending = null;
      }
    }
    const history = session.history(key), quote = session.quote(key);
    if (history.length && history.at(-1).availableAt > t) violations++; // records are revealed in availableAt order, so the last is the latest
    if (!pending && quote) { const d = s.decide({ history, quote, position, params: p }); if ((d === 'BUY' && !position) || (d === 'SELL' && position)) pending = { side: d, at: t }; }
    curve.push({ t, equity: markEquity(quote), mid: quote ? mid(quote) : null });
    session.advanceTo(t + stepMs);
  }
  const last = session.quote(key), finalEquity = markEquity(last), start = curve.find(c => c.mid !== null);
  let peak = -Infinity, maxDd = 0; for (const c of curve) { peak = Math.max(peak, c.equity); maxDd = Math.max(maxDd, peak > 0 ? (peak - c.equity) / peak : 0); }
  const every = Math.max(1, Math.ceil(curve.length / maxPoints)), rows = session.seen.filter(r => r.key === key);
  return {
    strategy, params: p, key, start: session.start, end: session.end, stepMs, feeBps, startCash: curve[0]?.equity ?? cash, finalEquity,
    returnPct: curve.length ? (finalEquity / curve[0].equity - 1) * 100 : null,
    buyHoldPct: start && last ? (last.bid / start.mid - 1) * 100 : null, maxDrawdownPct: maxDd * 100, trades, openPosition: position,
    records: rows.length, syntheticShare: rows.length ? rows.filter(r => r.synthetic).length / rows.length : null, lookAheadViolations: violations,
    curve: curve.filter((_, i) => i % every === 0 || i === curve.length - 1),
  };
}
