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
// Historical Market Lab results before this version used intrabar candle prices and incomplete
// round-trip accounting. They remain readable, but cannot qualify a strategy.
export const REPLAY_EVALUATOR_VERSION = 'market-replay.v2';
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const minuteEnd = t => Math.floor(t / 60000) * 60000 + 60000;

export function tapeRecords(rows, symbol) {
  const out = [];
  const candles = new Map();
  for (const r of rows || []) {
    const t = num(r?.t), bid = num(r?.bid), ask = num(r?.ask);
    if (t === null || !(bid > 0) || !(ask >= bid)) continue;
    const synthetic = r.src === CANDLE_SRC;
    // Warm-start expands OHLC into samples at :00/:15/:30/:45. Only :45 is the
    // candle close. Missing close samples cannot be reconstructed from an open or high.
    if (synthetic) {
      if (t % 60000 === 45000) candles.set(minuteEnd(t), { key: symbol, observedAt: t, availableAt: minuteEnd(t), bid, ask, synthetic: true, src: r.src });
      continue;
    }
    out.push({ key: symbol, observedAt: t, availableAt: t, bid, ask, synthetic: false, src: r.src || null });
  }
  return out.concat([...candles.values()]).sort((a, b) => a.availableAt - b.availableAt || a.observedAt - b.observedAt);
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
export function runReplay(session, { key, strategy = 'buy-hold', params = {}, stepMs = 15000, cash = 1000, feeBps = 0, slippageBps = 0, liquidateAtEnd = false, maxPoints = 600 } = {}) {
  const s = REPLAY_STRATEGIES[strategy]; if (!s) throw new Error('Unknown replay strategy');
  if (!(Number.isFinite(stepMs) && stepMs > 0 && Number.isFinite(cash) && cash > 0 && Number.isFinite(feeBps) && feeBps >= 0 && Number.isFinite(slippageBps) && slippageBps >= 0 && slippageBps < 10000)) throw new Error('Invalid replay step, cash, fee, or slippage');
  const p = strategyParams(strategy, params);
  const initialCash = cash;
  let position = null, pending = null, violations = 0; const trades = [], curve = [];
  const fee = v => v * feeBps / 10000;
  const markEquity = q => cash + (position && q ? position.qty * q.bid : 0);
  const execute = fill => {
    if (pending.side === 'BUY') {
      const px = fill.ask * (1 + slippageBps / 10000), qty = cash / (px * (1 + feeBps / 10000)), f = fee(qty * px);
      cash -= qty * px + f; position = { qty, px, entryFee: f, at: fill.availableAt };
      trades.push({ side: 'BUY', at: fill.availableAt, decidedAt: pending.at, price: px, qty, fee: f, synthetic: fill.synthetic });
    } else {
      const px = fill.bid * (1 - slippageBps / 10000), gross = position.qty * px, f = fee(gross), basis = position.qty * position.px + position.entryFee;
      cash += gross - f;
      trades.push({ side: 'SELL', at: fill.availableAt, decidedAt: pending.at, price: px, qty: position.qty, fee: f, entryFee: position.entryFee, pnl: gross - f - basis, ret: (gross - f) / basis - 1, synthetic: fill.synthetic, boundaryLiquidation: pending.reason === 'BOUNDARY' });
      position = null;
    }
    pending = null;
  };
  while (!session.done) {
    const t = session.clock;
    if (pending) {
      const fill = session.nextAvailableAfter(pending.at, key);
      if (fill && fill.availableAt <= t) execute(fill);
    }
    const history = session.history(key), quote = session.quote(key);
    if (history.length && history.at(-1).availableAt > t) violations++; // records are revealed in availableAt order, so the last is the latest
    if (!pending && quote) { const d = s.decide({ history, quote, position, params: p }); if ((d === 'BUY' && !position) || (d === 'SELL' && position)) pending = { side: d, at: t }; }
    // Each walk-forward fold declares its exit one step before the boundary. The
    // next quote may fill it at the boundary, with the same fee/slippage as other sells.
    if (liquidateAtEnd && position && t + stepMs >= session.end && !pending) pending = { side: 'SELL', at: t, reason: 'BOUNDARY' };
    curve.push({ t, equity: markEquity(quote), mid: quote ? mid(quote) : null });
    session.advanceTo(t + stepMs);
  }
  // Only a predeclared SELL may execute on the terminal quote. Other pending orders
  // remain unfilled, and any open position is marked but makes this fold incomplete.
  if (liquidateAtEnd && pending?.side === 'SELL') {
    const fill = session.nextAvailableAfter(pending.at, key);
    if (fill && fill.availableAt <= session.end) execute(fill);
  }
  const last = session.quote(key), finalEquity = markEquity(last), start = curve.find(c => c.mid !== null);
  if (!curve.length || curve.at(-1).t !== session.clock) curve.push({ t: session.clock, equity: finalEquity, mid: last ? mid(last) : null });
  else curve[curve.length - 1].equity = finalEquity;
  let peak = -Infinity, maxDd = 0; for (const c of curve) { peak = Math.max(peak, c.equity); maxDd = Math.max(maxDd, peak > 0 ? (peak - c.equity) / peak : 0); }
  const every = Math.max(1, Math.ceil(curve.length / maxPoints)), rows = session.seen.filter(r => r.key === key);
  return {
    evaluatorVersion: REPLAY_EVALUATOR_VERSION, strategy, params: p, key, start: session.start, end: session.end, stepMs, feeBps, slippageBps, liquidateAtEnd, startCash: initialCash, finalEquity,
    returnPct: (finalEquity / initialCash - 1) * 100,
    buyHoldPct: start && last ? (last.bid / start.mid - 1) * 100 : null, maxDrawdownPct: maxDd * 100, trades, openPosition: position, pendingOrder: pending,
    records: rows.length, syntheticShare: rows.length ? rows.filter(r => r.synthetic).length / rows.length : null, lookAheadViolations: violations,
    curve: curve.filter((_, i) => i % every === 0 || i === curve.length - 1),
  };
}

// ---------------------------------------------------------------- validation
// Walk-forward: the window is cut into consecutive folds. For each fold after the first, every
// parameter set in the grid is run on the PREVIOUS fold only (train), the best by return is chosen,
// and only that choice is run on the current fold (test). Test folds never influence the choice.
// The result carries the evidence fields the strategy promotion gate reads (strategies.js).
export function paramGrid(strategy, grid = {}) {
  const base = REPLAY_STRATEGIES[strategy]?.params; if (!base) throw new Error('Unknown replay strategy');
  let combos = [{}];
  for (const k of Object.keys(base)) { const vals = Array.isArray(grid[k]) && grid[k].length ? grid[k].slice(0, 8) : [base[k]]; combos = combos.flatMap(c => vals.map(v => ({ ...c, [k]: v }))); }
  if (combos.length > 64) throw new Error('Parameter grid too large (max 64 combinations)');
  return combos.map(c => strategyParams(strategy, c));
}
function effectiveClosedSamples(returns) {
  const n = returns.length;
  if (n < 2) return n;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0);
  if (variance <= 1e-20) return 1;
  let dependence = 0;
  for (let lag = 1; lag <= Math.min(10, Math.floor(n / 4)); lag++) {
    let covariance = 0;
    for (let i = lag; i < n; i++) covariance += (returns[i] - mean) * (returns[i - lag] - mean);
    const rho = covariance / variance;
    if (rho <= 0) break;
    dependence += rho;
  }
  return Math.max(1, Math.min(n, Math.floor(n / (1 + 2 * dependence))));
}
export function walkForward(records, { key, strategy, grid = {}, folds = 4, start, end, stepMs = 15000, feeBps = 0, slippageBps = 0, feeModelVerified = false, cash = 1000 } = {}) {
  if (!(folds >= 2 && folds <= 12)) throw new Error('Folds must be between 2 and 12');
  const combos = paramGrid(strategy, grid), span = (end - start) / folds, out = [];
  const run = (params, a, b, selectedStrategy = strategy) => runReplay(new ReplaySession(records, { start: a, end: b }), { key, strategy: selectedStrategy, params, stepMs, feeBps, slippageBps, cash, liquidateAtEnd: true, maxPoints: 50 });
  for (let i = 1; i < folds; i++) {
    const trA = start + (i - 1) * span, trB = start + i * span, teB = start + (i + 1) * span;
    const trained = combos.map(p => ({ p, r: run(p, trA, trB) })).sort((x, y) =>
      (y.r.openPosition || y.r.pendingOrder ? -Infinity : y.r.returnPct) - (x.r.openPosition || x.r.pendingOrder ? -Infinity : x.r.returnPct));
    const best = trained[0], test = run(best.p, trB, teB), baseline = run({}, trB, teB, 'buy-hold');
    const closed = test.trades.filter(t => t.side === 'SELL');
    const complete = !test.openPosition && !test.pendingOrder;
    out.push({ fold: i, train: { start: trA, end: trB, params: best.p, returnPct: best.r.openPosition || best.r.pendingOrder ? null : best.r.returnPct, candidates: combos.length }, test: { start: trB, end: teB, returnPct: complete ? test.returnPct : null, markedReturnPct: test.returnPct, buyHoldPct: baseline.openPosition || baseline.pendingOrder ? null : baseline.returnPct, trades: test.trades.length, closedTrades: closed.length, openPosition: !!test.openPosition, complete, boundaryLiquidations: closed.filter(t => t.boundaryLiquidation).length, maxDrawdownPct: test.maxDrawdownPct, lookAheadViolations: test.lookAheadViolations, syntheticShare: test.syntheticShare, tradeReturns: closed.map(t => t.ret) } });
  }
  const tests = out.map(f => f.test), incompleteFolds = tests.filter(t => !t.complete).length;
  const compounded = incompleteFolds ? null : tests.reduce((m, t) => m * (1 + t.returnPct / 100), 1);
  const closedReturns = tests.flatMap(t => t.tradeReturns);
  // Round trips, not order legs, are observations. Estimate effective N within each
  // chronological fold using the positive serial-correlation sequence; flat returns count
  // as one observation. This estimate cannot establish independence by itself.
  const effectiveN = tests.reduce((s, t) => s + effectiveClosedSamples(t.tradeReturns), 0);
  const evidence = { evaluatorVersion: REPLAY_EVALUATOR_VERSION, sampleSize: closedReturns.length, effectiveSampleSize: effectiveN, outOfSampleNetPct: compounded === null ? null : Math.round((compounded - 1) * 1e6) / 1e4,
    costsModeled: incompleteFolds === 0 && feeBps > 0 && slippageBps > 0 && feeModelVerified === true && tests.every(t => t.syntheticShare === 0), feeBps, slippageBps, feeModelVerified,
    maxDrawdownPct: Math.max(0, ...tests.map(t => t.maxDrawdownPct || 0)), positiveFoldShare: incompleteFolds || !tests.length ? null : tests.filter(t => t.returnPct > 0).length / tests.length,
    lookAheadViolations: tests.reduce((s, t) => s + (t.lookAheadViolations || 0), 0), syntheticShare: tests.length ? Math.max(...tests.map(t => t.syntheticShare ?? 0)) : null, pendingOpenPositions: tests.filter(t => t.openPosition).length,
    incompleteFolds, boundaryLiquidations: tests.reduce((s, t) => s + t.boundaryLiquidations, 0),
    method: `walk-forward ${folds} folds, train on previous fold, ${combos.length} parameter sets; predeclared boundary exits fill at next quote with costs; incomplete folds excluded; effective N estimated from positive serial autocorrelation within folds` };
  return { strategy, key, folds: out, evidence };
}

// Seeded bootstrap of per-trade returns: distribution of the compounded result over the same number
// of trades. Deterministic for a given seed (recorded with the run).
export function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function monteCarlo(tradeReturns, { runs = 1000, seed = 1 } = {}) {
  const r = (tradeReturns || []).filter(Number.isFinite); if (r.length < 2) return { runs: 0, seed, note: 'Needs at least 2 closed trades' };
  const rand = mulberry32(seed), finals = [];
  for (let i = 0; i < Math.min(10000, runs); i++) { let m = 1; for (let j = 0; j < r.length; j++) m *= 1 + r[Math.floor(rand() * r.length)]; finals.push((m - 1) * 100); }
  finals.sort((a, b) => a - b); const q = p => Math.round(finals[Math.min(finals.length - 1, Math.floor(p * finals.length))] * 100) / 100;
  return { runs: finals.length, seed, trades: r.length, p5: q(0.05), p50: q(0.5), p95: q(0.95), probLoss: Math.round(finals.filter(x => x < 0).length / finals.length * 1000) / 1000 };
}
