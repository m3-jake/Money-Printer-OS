// Isolated Robinhood paper-practice lane.
//
// This file deliberately does not import robinhoodTransport, robinhoodAutoTrader, or the
// qualified paper journal. It is a small, public-data-only simulator for exercising the UI and
// paper controls when the strict qualified book is cold or intentionally idle. Its ledger is
// separate from qualification, Lab promotion, real authority, and the real journal.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchPublicPaperMarket } from './robinhoodPaperFeed.js';
import { writeJsonAtomic } from './robinhoodEquitiesData.js';

export const PRACTICE_SCHEMA = 'mpo.robinhood-paper-practice.v1';
export const PRACTICE_MODES = Object.freeze(['STRICT', 'PRACTICE', 'BUY_AND_HOLD', 'OBSERVE_ONLY']);
export const PRACTICE_STRATEGIES = Object.freeze(['MOMENTUM', 'MEAN_REVERSION', 'BUY_AND_HOLD']);
export const PRACTICE_DEFAULTS = Object.freeze({
  mode: 'PRACTICE', strategyMode: 'MOMENTUM', budgetUsd: 500, orderUsd: 25,
  symbols: ['BTC-USD', 'ETH-USD'], maxOpenPositions: 3, dailyLossCapUsd: 25,
  holdMinutes: 240, stopPct: 0.02, takePct: 0.04, slippageBps: 8, feeBps: 95,
  quoteMaxAgeMs: 30_000, entryMovePct: 0.0005, autopilot: false,
});
const SYMBOL_RE = /^[A-Z0-9]{2,10}-USD$/;
const QTY_STEP = 1e-6;
const r2 = n => Math.round(Number(n) * 100) / 100;
const r6 = n => Math.floor(Number(n) / QTY_STEP + 1e-9) * QTY_STEP;
const finite = (n, fallback = null) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const utcDay = at => new Date(Number(at)).toISOString().slice(0, 10);

export function practiceFile(dataDir) { return path.join(dataDir, 'robinhood-paper-practice.json'); }

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function practiceSettingsHash(settings) {
  return crypto.createHash('sha256').update(stable(normalizePracticeSettings(settings))).digest('hex').slice(0, 16);
}

export function normalizePracticeSettings(patch = {}, base = PRACTICE_DEFAULTS) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const out = { ...PRACTICE_DEFAULTS, ...(base || {}) };
  const mode = String(src.mode ?? out.mode).toUpperCase();
  out.mode = PRACTICE_MODES.includes(mode) ? mode : PRACTICE_DEFAULTS.mode;
  const strategy = String(src.strategyMode ?? out.strategyMode).toUpperCase();
  out.strategyMode = PRACTICE_STRATEGIES.includes(strategy) ? strategy : PRACTICE_DEFAULTS.strategyMode;
  const positive = (key, min, max) => {
    const n = Number(src[key] ?? out[key]);
    out[key] = Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : PRACTICE_DEFAULTS[key];
  };
  positive('budgetUsd', 50, 1_000_000);
  positive('orderUsd', 1, 100_000);
  positive('maxOpenPositions', 1, 100); out.maxOpenPositions = Math.round(out.maxOpenPositions);
  positive('dailyLossCapUsd', 0, 1_000_000);
  positive('holdMinutes', 1, 30 * 24 * 60);
  positive('slippageBps', 0, 500);
  positive('feeBps', 0, 2_500);
  positive('quoteMaxAgeMs', 1_000, 10 * 60_000); out.quoteMaxAgeMs = Math.round(out.quoteMaxAgeMs);
  positive('entryMovePct', 0, .25);
  const pct = (key, fallback) => {
    const n = Number(src[key] ?? out[key]);
    out[key] = Number.isFinite(n) ? Math.max(0, Math.min(.95, n)) : fallback;
  };
  pct('stopPct', PRACTICE_DEFAULTS.stopPct); pct('takePct', PRACTICE_DEFAULTS.takePct);
  out.symbols = [...new Set((Array.isArray(src.symbols) ? src.symbols : String(src.symbols ?? out.symbols).split(','))
    .map(x => String(x).trim().toUpperCase()).filter(x => SYMBOL_RE.test(x)))].slice(0, 12);
  if (!out.symbols.length) out.symbols = [...PRACTICE_DEFAULTS.symbols];
  out.autopilot = src.autopilot === undefined ? !!out.autopilot : src.autopilot === true;
  return out;
}

function emptyTelemetry(now) {
  return {
    loopStatus: 'IDLE', lastTickAt: null, lastSource: null, lastFreshnessMs: null,
    lastQuotes: {}, tape: {}, lastDecision: { at: now, action: 'WAIT', reason: 'no cycle yet' },
    blockingReason: 'autopilot disabled', candidatesChecked: [], rejectionReasons: {},
    entries: 0, exits: 0, fills: 0, feesUsd: 0, lastCycle: null,
  };
}

export function newPracticeBook({ settings = {}, now = Date.now() } = {}) {
  const normalized = normalizePracticeSettings(settings);
  return {
    schema: PRACTICE_SCHEMA, version: 1, createdAt: now, updatedAt: now,
    settings: normalized, settingsHash: practiceSettingsHash(normalized),
    startUsd: normalized.budgetUsd, cashUsd: normalized.budgetUsd, positions: [], history: [],
    realizedPnlUsd: 0, reservedUsd: 0, recoveryRequired: false, recoveryReason: null,
    telemetry: emptyTelemetry(now), lastError: null,
  };
}

export function loadPracticeBook(dataDir, { settings = {}, now = Date.now() } = {}) {
  const file = practiceFile(dataDir);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return newPracticeBook({ settings, now });
    return { ...newPracticeBook({ settings, now }), recoveryRequired: true, recoveryReason: `unreadable: ${e.code || 'file'}` };
  }
  if (!raw || raw.schema !== PRACTICE_SCHEMA || raw.version !== 1 || !Array.isArray(raw.positions) || !Array.isArray(raw.history) || !raw.settings) {
    return { ...newPracticeBook({ settings, now }), recoveryRequired: true, recoveryReason: 'corrupt practice ledger; reset it after review' };
  }
  const normalized = normalizePracticeSettings(raw.settings);
  return { ...newPracticeBook({ settings: normalized, now }), ...raw, settings: normalized, settingsHash: practiceSettingsHash(normalized) };
}

export function savePracticeBook(dataDir, book) {
  if (!book || book.recoveryRequired) return false;
  const next = { ...book, schema: PRACTICE_SCHEMA, version: 1, updatedAt: Date.now(), settingsHash: practiceSettingsHash(book.settings) };
  writeJsonAtomic(practiceFile(dataDir), next);
  return true;
}

function freshQuote(q, now, maxAgeMs) {
  const at = finite(q?.at);
  return !!q && finite(q.bid, 0) > 0 && finite(q.ask, 0) >= finite(q.bid, 0) && at !== null && at <= now && now - at <= maxAgeMs;
}
function quoteRecord(q, now) {
  return { symbol: String(q.symbol).toUpperCase(), bid: finite(q.bid), ask: finite(q.ask), at: finite(q.at, now), source: String(q.source || 'public-observed') };
}
function dayLoss(book, now) {
  return book.history.filter(x => x.status === 'CLOSED' && utcDay(x.closedAt || x.at) === utcDay(now)).reduce((n, x) => n + Math.min(0, finite(x.pnlUsd, 0)), 0);
}
function currentEquity(book, quoteBySymbol) {
  return r2(book.cashUsd + book.positions.reduce((n, p) => {
    const q = quoteBySymbol.get(p.symbol); const bid = freshQuote(q, Date.now(), book.settings.quoteMaxAgeMs) ? q.bid : p.lastBid;
    return n + (finite(bid, 0) * p.qty);
  }, 0));
}
function addReject(t, reason) {
  t.rejectionReasons[reason] = Number(t.rejectionReasons[reason] || 0) + 1;
}
function buyFill({ quote, orderUsd, settings, now }) {
  const price = quote.ask * (1 + settings.slippageBps / 10_000);
  const qty = r6(orderUsd / price);
  const gross = r2(qty * price), fee = r2(gross * settings.feeBps / 10_000);
  return { qty, fillPrice: price, grossUsd: gross, feeUsd: fee, costUsd: r2(gross + fee), at: now };
}
function sellFill({ position, quote, settings, now }) {
  const price = quote.bid * (1 - settings.slippageBps / 10_000);
  const gross = r2(position.qty * price), fee = r2(gross * settings.feeBps / 10_000);
  return { qty: position.qty, fillPrice: price, grossUsd: gross, feeUsd: fee, proceedsUsd: r2(gross - fee), at: now };
}
function entrySignal(book, symbol, quote, settings, now) {
  // The cycle appends this tick to the tape before entries, so compare against the last point before now.
  const tape = book.telemetry.tape[symbol] || [];
  const previous = tape.filter(x => x.at < now).at(-1)?.mid;
  if (settings.mode === 'BUY_AND_HOLD' || settings.strategyMode === 'BUY_AND_HOLD') return { enter: true, reason: 'buy-and-hold' };
  if (previous === undefined) return { enter: false, reason: 'warmup: one prior observed quote required' };
  const move = ((quote.bid + quote.ask) / 2) / previous - 1;
  if (settings.strategyMode === 'MEAN_REVERSION') return { enter: move <= -settings.entryMovePct, reason: move <= -settings.entryMovePct ? 'mean-reversion' : 'no-reversion' };
  return { enter: move >= settings.entryMovePct, reason: move >= settings.entryMovePct ? 'momentum' : 'no-momentum' };
}

function closePosition(book, index, quote, reason, now) {
  const p = book.positions[index], fill = sellFill({ position: p, quote, settings: book.settings, now });
  const pnlUsd = r2(fill.proceedsUsd - p.costUsd);
  const closed = { ...p, status: 'CLOSED', exit: { ...fill, reason }, closedAt: now, pnlUsd };
  book.cashUsd = r2(book.cashUsd + fill.proceedsUsd); book.realizedPnlUsd = r2(book.realizedPnlUsd + pnlUsd);
  book.history.unshift(closed); book.positions.splice(index, 1);
  return closed;
}

function enterPosition(book, quote, now, placedBy = 'practice-autopilot') {
  const s = book.settings, signal = entrySignal(book, quote.symbol, quote, s, now);
  if (s.mode === 'OBSERVE_ONLY') return { ok: false, reason: 'observe-only mode' };
  if (s.mode === 'STRICT') return { ok: false, reason: 'strict mode belongs to the qualified book; practice is isolated' };
  if (!signal.enter && placedBy !== 'manual') return { ok: false, reason: signal.reason };
  if (book.positions.length >= s.maxOpenPositions) return { ok: false, reason: 'max-open-positions' };
  if (!(book.cashUsd > 0)) return { ok: false, reason: 'budget' };
  const fill = buyFill({ quote, orderUsd: Math.min(s.orderUsd, book.cashUsd), settings: s, now });
  if (!(fill.qty > 0) || fill.costUsd > book.cashUsd + 1e-9) return { ok: false, reason: 'minimum-size-or-budget' };
  const position = { id: `rhp-${now.toString(36)}-${book.history.length}-${book.positions.length}`, symbol: quote.symbol, status: 'OPEN', qty: fill.qty,
    entryPrice: fill.fillPrice, lastBid: quote.bid, costUsd: fill.costUsd, feeUsd: fill.feeUsd, openedAt: now,
    stopPct: s.stopPct, takePct: s.takePct, holdMinutes: s.holdMinutes, placedBy, source: quote.source };
  book.cashUsd = r2(book.cashUsd - fill.costUsd); book.positions.push(position);
  return { ok: true, position, fill };
}

export async function runPracticeCycle({ dataDir, now = Date.now(), settings = null, fetchMarket = fetchPublicPaperMarket } = {}) {
  if (!dataDir) throw new Error('dataDir required');
  let book = loadPracticeBook(dataDir, { now });
  if (settings) { book.settings = normalizePracticeSettings(settings, book.settings); book.settingsHash = practiceSettingsHash(book.settings); }
  if (book.recoveryRequired) return practiceSnapshot({ dataDir, book, now });
  const s = book.settings, t = book.telemetry = { ...emptyTelemetry(now), ...(book.telemetry || {}), at: now, loopStatus: 'RUNNING', rejectionReasons: {}, candidatesChecked: [] };
  let market;
  try { market = await fetchMarket(s.symbols, { now }); }
  catch (e) {
    t.loopStatus = 'BLOCKED'; t.blockingReason = `public quote source unavailable: ${String(e?.message || e).slice(0, 180)}`; book.lastError = t.blockingReason; savePracticeBook(dataDir, book); return practiceSnapshot({ dataDir, book, now });
  }
  const quotes = new Map();
  for (const raw of market?.quotes || []) { const q = quoteRecord(raw, now); if (s.symbols.includes(q.symbol)) quotes.set(q.symbol, q); }
  t.lastSource = market?.source || 'public-observed'; t.lastQuotes = Object.fromEntries(quotes);
  const fresh = [...quotes.values()].filter(q => freshQuote(q, now, s.quoteMaxAgeMs));
  t.lastFreshnessMs = fresh.length ? Math.max(...fresh.map(q => now - q.at)) : null;
  for (const symbol of s.symbols) {
    const q = quotes.get(symbol); t.candidatesChecked.push(symbol);
    if (!q) { addReject(t, 'no-quote'); continue; }
    if (!freshQuote(q, now, s.quoteMaxAgeMs)) { addReject(t, 'stale-quote'); continue; }
    t.tape[symbol] = [...(t.tape[symbol] || []), { at: now, mid: r2((q.bid + q.ask) / 2), source: q.source }].slice(-720);
  }
  const freshBySymbol = new Map(fresh.map(q => [q.symbol, q]));
  for (let i = book.positions.length - 1; i >= 0; i--) {
    const p = book.positions[i], q = freshBySymbol.get(p.symbol); if (!q) continue;
    p.lastBid = q.bid;
    const ret = q.bid / p.entryPrice - 1, age = now - p.openedAt;
    const reason = ret <= -p.stopPct ? 'stop' : ret >= p.takePct ? 'take' : age >= p.holdMinutes * 60_000 ? 'hold-time' : null;
    if (reason && s.mode !== 'BUY_AND_HOLD') { closePosition(book, i, q, reason, now); t.exits++; t.fills++; }
  }
  const loss = dayLoss(book, now);
  const capHit = s.dailyLossCapUsd > 0 && loss <= -s.dailyLossCapUsd;
  if (capHit) { t.blockingReason = `daily loss cap reached (${r2(-loss)} / ${r2(s.dailyLossCapUsd)} USD)`; addReject(t, 'daily-loss-cap'); }
  if (s.autopilot && !capHit) {
    for (const q of fresh) {
      if (book.positions.some(p => p.symbol === q.symbol)) continue;
      const r = enterPosition(book, q, now);
      if (r.ok) { t.entries++; t.fills++; t.feesUsd = r2(t.feesUsd + r.fill.feeUsd); t.lastDecision = { at: now, action: 'BUY', symbol: q.symbol, reason: 'autopilot', fill: r.fill }; }
      else addReject(t, r.reason);
      if (book.positions.length >= s.maxOpenPositions) break;
    }
  }
  if (!t.lastDecision || t.lastDecision.at !== now) {
    t.lastDecision = { at: now, action: 'WAIT', reason: t.blockingReason || (s.autopilot ? 'no eligible candidate' : 'autopilot disabled') };
  }
  t.blockingReason ||= fresh.length ? (s.autopilot ? null : 'autopilot disabled') : 'no fresh observed quotes';
  t.loopStatus = 'IDLE'; t.lastTickAt = now; t.lastCycle = { at: now, source: t.lastSource, freshQuotes: fresh.length, candidates: t.candidatesChecked.length, fills: t.fills };
  book.reservedUsd = r2(book.positions.reduce((n, p) => n + p.costUsd, 0)); book.updatedAt = now; savePracticeBook(dataDir, book);
  return practiceSnapshot({ dataDir, book, now, quotes: freshBySymbol });
}

async function withQuote(dataDir, symbol, now, fetchMarket) {
  const book = loadPracticeBook(dataDir, { now }), s = book.settings;
  const market = await fetchMarket([symbol], { now });
  const raw = (market?.quotes || []).find(q => String(q.symbol).toUpperCase() === symbol);
  const q = raw && quoteRecord(raw, now);
  if (!freshQuote(q, now, s.quoteMaxAgeMs)) throw Object.assign(new Error('a fresh public quote is required'), { code: 'staleQuote' });
  return { book, quote: q };
}

export async function placePracticeOrder({ dataDir, symbol, now = Date.now(), fetchMarket = fetchPublicPaperMarket } = {}) {
  const sym = String(symbol || '').trim().toUpperCase(); if (!SYMBOL_RE.test(sym)) throw new Error('invalid practice symbol');
  const { book, quote } = await withQuote(dataDir, sym, now, fetchMarket);
  if (book.recoveryRequired) throw new Error('practice ledger requires recovery');
  if (!book.settings.symbols.includes(sym)) throw new Error('symbol is not in the isolated practice watchlist');
  if (book.settings.mode === 'OBSERVE_ONLY' || book.settings.mode === 'STRICT') throw new Error(`${book.settings.mode} mode blocks practice fills`);
  if (book.positions.some(p => p.symbol === sym)) throw new Error('practice position already open for symbol');
  const r = enterPosition(book, quote, now, 'manual'); if (!r.ok) throw new Error(r.reason);
  book.telemetry = { ...book.telemetry, lastTickAt: now, lastDecision: { at: now, action: 'BUY', symbol: sym, reason: 'manual', fill: r.fill }, entries: Number(book.telemetry.entries || 0) + 1, fills: Number(book.telemetry.fills || 0) + 1 };
  book.reservedUsd = r2(book.positions.reduce((n, p) => n + p.costUsd, 0)); savePracticeBook(dataDir, book); return r.position;
}

export async function closePracticeOrder({ dataDir, id, now = Date.now(), fetchMarket = fetchPublicPaperMarket } = {}) {
  const book = loadPracticeBook(dataDir, { now }), index = book.positions.findIndex(p => p.id === id); if (index < 0) throw new Error('practice position not found');
  const { quote } = await withQuote(dataDir, book.positions[index].symbol, now, fetchMarket);
  const closed = closePosition(book, index, quote, 'manual', now);
  book.telemetry = { ...book.telemetry, lastTickAt: now, lastDecision: { at: now, action: 'SELL', symbol: closed.symbol, reason: 'manual', pnlUsd: closed.pnlUsd }, exits: Number(book.telemetry.exits || 0) + 1, fills: Number(book.telemetry.fills || 0) + 1 };
  book.reservedUsd = r2(book.positions.reduce((n, p) => n + p.costUsd, 0)); savePracticeBook(dataDir, book); return closed;
}

export function configurePractice({ dataDir, patch = {}, now = Date.now() } = {}) {
  const book = loadPracticeBook(dataDir, { now }); if (book.recoveryRequired) throw new Error('practice ledger requires recovery');
  book.settings = normalizePracticeSettings(patch, book.settings); book.settingsHash = practiceSettingsHash(book.settings); book.telemetry = { ...book.telemetry, lastDecision: { at: now, action: 'CONFIG', reason: `settings hash ${book.settingsHash}` } }; savePracticeBook(dataDir, book); return book.settings;
}

export function resetPractice({ dataDir, budgetUsd, now = Date.now() } = {}) {
  const file = practiceFile(dataDir), old = loadPracticeBook(dataDir, { now });
  if (old.recoveryRequired && fs.existsSync(file)) fs.copyFileSync(file, `${file}.corrupt-${now}.bak`);
  const settings = normalizePracticeSettings({ ...old.settings, budgetUsd: budgetUsd ?? old.settings.budgetUsd, autopilot: false });
  const next = newPracticeBook({ settings, now }); savePracticeBook(dataDir, next); return next;
}

export function practiceSnapshot({ dataDir, book = loadPracticeBook(dataDir), now = Date.now(), quotes = new Map() } = {}) {
  const q = quotes instanceof Map ? quotes : new Map(Object.entries(quotes || {}));
  const positions = book.positions.map(p => { const quote = q.get(p.symbol); const bid = finite(quote?.bid, p.lastBid); const unrealized = bid > 0 ? r2(p.qty * bid - p.costUsd) : null; return { ...p, markBid: bid, unrealizedPnlUsd: unrealized, ageMs: Math.max(0, now - p.openedAt) }; });
  const unrealized = positions.every(p => p.unrealizedPnlUsd !== null) ? r2(positions.reduce((n, p) => n + p.unrealizedPnlUsd, 0)) : null;
  return { schema: PRACTICE_SCHEMA, at: now, mode: book.settings.mode, isolated: true, countsTowardQualification: false, countsTowardLabPromotion: false, realAuthority: false,
    settings: book.settings, settingsHash: book.settingsHash, budgetUsd: book.startUsd, cashUsd: book.cashUsd, reservedUsd: book.reservedUsd,
    equityUsd: unrealized === null ? null : r2(book.cashUsd + book.positions.reduce((n, p) => n + p.costUsd, 0) + unrealized), realizedPnlUsd: book.realizedPnlUsd,
    unrealizedPnlUsd: unrealized, positions, history: book.history.slice(0, 25), telemetry: book.telemetry, recoveryRequired: !!book.recoveryRequired, recoveryReason: book.recoveryReason || null, lastError: book.lastError || null,
    safety: { paperOnly: true, signedCalls: false, realJournal: false, qualification: false, promotion: false, maxQuoteAgeMs: book.settings.quoteMaxAgeMs },
  };
}

let timer = null;
export function startPracticeLoop({ dataDir, tickMs = 15_000, fetchMarket = fetchPublicPaperMarket } = {}) {
  if (timer || String(process.env.ROBINHOOD_PRACTICE_AUTOSTART ?? 'true').toLowerCase() === 'false') return timer;
  timer = setInterval(() => runPracticeCycle({ dataDir, fetchMarket }).catch(() => {}), Math.max(5_000, tickMs)); timer.unref?.();
  runPracticeCycle({ dataDir, fetchMarket }).catch(() => {}); return timer;
}
export function stopPracticeLoop() { if (timer) clearInterval(timer); timer = null; }
export const practiceLoopRunning = () => !!timer;
