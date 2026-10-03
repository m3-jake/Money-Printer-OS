// Kalshi paper bots (2026-10-02, bing: "bots that bet on the weather ... or bitcoin going up and down").
// PAPER ONLY: this module has no order code and never calls a mutating Kalshi endpoint. Two strategies
// share one book file (<data>/kalshi-paper-bots.json):
//
//   weather  Daily-high bucket markets (KXHIGH*). The NWS point forecast becomes a probability for each
//            bucket: high ~ Normal(forecast + bias, sigma), sigma widening with time to close. Kalshi
//            settles on its series source, not on NWS, so the bias and sigma are settings to learn.
//   btc      Bitcoin range (KXBTC) and above/below (KXBTCD) markets. Spot and realized volatility come from
//            Coinbase public 5-minute candles; P(S_T > K) uses a lognormal with the realized vol widened by
//            a safety multiple. Kalshi settles on CF Benchmarks RTI, which tracks spot closely.
//
// Each run scores every YES and NO side as (model probability − ask − taker fee per contract), takes the best
// side per event when that edge clears minEdge, and fills by walking the live order book (no mid fills).
// Settlement reads the market's own result. Every settled bet also records the Brier score of the model and
// of the market price, so "does the model beat the market?" is measured, not assumed.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicRename.js';
import { takerFee } from './core/fees.js';

export const KALSHI_BOT_IDS = Object.freeze(['weather', 'btc']);
const SCHEMA = 'mpo.kalshi-paper-bots.v1';
const DEFAULTS = Object.freeze({
  weather: { enabled: true, useCalibration: true, calibrationSafety: 1.1, startUsd: 500, stakeUsd: 10, maxOpen: 10, minEdge: 0.07, maxDisagreement: 0.2, minPrice: 0.05, maxPrice: 0.92, biasF: 0, sigmaBaseF: 1.6, sigmaPerDayF: 1.0, minHoursToClose: 1 },
  btc: { enabled: true, startUsd: 500, stakeUsd: 10, maxOpen: 4, minEdge: 0.06, maxDisagreement: 0.2, minPrice: 0.05, maxPrice: 0.92, volMultiple: 1.25, minHoursToClose: 0.5, maxHoursToClose: 30 },
});
const LIMITS = { calibrationSafety: [1, 3], maxDisagreement: [0.02, 1], stakeUsd: [1, 250], maxOpen: [1, 50], minEdge: [0.01, 0.5], minPrice: [0.01, 0.5], maxPrice: [0.5, 0.99], biasF: [-10, 10], sigmaBaseF: [0.5, 8], sigmaPerDayF: [0, 5], volMultiple: [0.5, 4], startUsd: [10, 100000], minHoursToClose: [0, 48], maxHoursToClose: [1, 240] };
const BTC_SERIES = ['KXBTCD', 'KXBTC'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Kalshi rate-limits bursts; every bot call is paced and a RATE_LIMITED answer is retried twice with backoff.
export async function paced(fn, { tries = 3, paceMs = 150, backoffMs = 4000 } = {}) {
  for (let i = 0; ; i++) { try { const out = await fn(); if (paceMs) await sleep(paceMs); return out; } catch (e) { if (!/RATE_LIMITED|rate limit/i.test(String(e.code || e.message)) || i >= tries - 1) throw e; await sleep(backoffMs * (i + 1)); } }
}
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7).
export function normCdf(z) {
  if (z === Infinity) return 1; if (z === -Infinity) return 0;
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
// Probability that a whole-degree daily high lands in [lo, hi] (either may be ±Infinity), continuity-corrected.
export function bucketProbability(lo, hi, mu, sigma) {
  const a = lo === -Infinity || lo == null ? -Infinity : (lo - 0.5 - mu) / sigma, b = hi === Infinity || hi == null ? Infinity : (hi + 0.5 - mu) / sigma;
  return clamp(normCdf(b) - normCdf(a), 0, 1);
}
// P(S_T > K) for spot S, horizon tauSec, per-sqrt-second vol sigma (lognormal, zero drift).
export function probAbove(spot, strike, tauSec, sigmaPerSqrtSec) {
  const s = sigmaPerSqrtSec * Math.sqrt(Math.max(1, tauSec));
  return clamp(normCdf((Math.log(spot / strike) - s * s / 2) / s), 0, 1);
}
// Contract probability for a normalized Kalshi BTC contract (strikeType greater/less/between).
export function btcContractProbability(d, spot, tauSec, sigma) {
  if (d.strikeType === 'greater' && Number.isFinite(d.floorStrike)) return probAbove(spot, d.floorStrike, tauSec, sigma);
  if (d.strikeType === 'less' && Number.isFinite(d.capStrike)) return 1 - probAbove(spot, d.capStrike, tauSec, sigma);
  if (d.strikeType === 'between' && Number.isFinite(d.floorStrike) && Number.isFinite(d.capStrike)) return clamp(probAbove(spot, d.floorStrike, tauSec, sigma) - probAbove(spot, d.capStrike, tauSec, sigma), 0, 1);
  return null;
}
// Realized vol per sqrt-second from Coinbase candles [[time, low, high, open, close, vol], ...] (newest first).
export function realizedVol(candles, granularitySec = 300) {
  const closes = (candles || []).slice().sort((a, b) => a[0] - b[0]).map(c => Number(c[4])).filter(v => v > 0);
  if (closes.length < 30) return null;
  const r = []; for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const m = r.reduce((s, x) => s + x, 0) / r.length, v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v / granularitySec);
}
// Best side of one contract: YES at the YES ask, or NO at the NO ask, after the taker fee for `qty` contracts.
// A side whose model probability differs from the market's by more than maxDisagreement is dropped: a gap that
// large is more often a model error (wrong vol, wrong settlement source) than an edge, so it is logged, not bet.
export function scoreSides({ pYes, yesAsk, noAsk, yesBid = null, feeModel, stakeUsd, minPrice, maxPrice, maxDisagreement = 1 }) {
  const marketYes = yesBid != null && yesAsk != null ? (yesBid + yesAsk) / 2 : yesAsk != null ? yesAsk : noAsk != null ? 1 - noAsk : null;
  if (marketYes != null && Math.abs(pYes - marketYes) > maxDisagreement) return { disagree: true, pModel: pYes, marketYes, edge: -Infinity };
  const out = [];
  for (const [side, p, ask] of [['YES', pYes, yesAsk], ['NO', 1 - pYes, noAsk]]) {
    if (!(ask >= minPrice && ask <= maxPrice)) continue;
    const qty = Math.floor(stakeUsd / ask); if (qty < 1) continue;
    const fee = feeModel ? takerFee(feeModel, [{ price: ask, quantity: qty }]) : null; if (fee === null) continue;
    out.push({ side, pModel: p, ask, qty, fee, edge: p - ask - fee / qty });
  }
  return out.sort((a, b) => b.edge - a.edge)[0] || null;
}
// Walk the asks of one side for up to `qty` contracts. book: {yes:{asks}, no:{asks}} with ascending asks.
export function walkAsks(book, side, qty, limitPrice) {
  const asks = (side === 'YES' ? book?.yes?.asks : book?.no?.asks) || [];
  let left = qty; const fills = [];
  for (const l of asks) { if (left <= 0 || l.price > limitPrice) break; const q = Math.min(left, Math.floor(l.quantity)); if (q > 0) { fills.push({ price: l.price, quantity: q }); left -= q; } }
  return fills;
}

function emptyBot(id, startUsd) { return { id, startUsd, cashUsd: startUsd, open: [], history: [], decisions: [], settings: { ...DEFAULTS[id], startUsd }, lastRunAt: null, lastError: null, lastNote: null, epoch: 1 }; }
function sanitize(id, patch = {}) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS[id])) continue;
    if (k === 'enabled' || k === 'useCalibration') { out[k] = v === true || v === 'true' || v === 1 || v === '1'; continue; }
    const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
    const [a, b] = LIMITS[k] || [-Infinity, Infinity]; if (n < a || n > b) throw new Error(`${k} must be between ${a} and ${b}`);
    out[k] = n;
  }
  return out;
}

export class KalshiPaperBots {
  constructor({ dataDir, kalshi = () => null, weather = async () => null, calibration = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'kalshi-paper-bots.json'); this.kalshi = kalshi; this.weather = weather; this.calibration = calibration; this.fetch = fetchImpl; this.now = now; this.busy = new Set();
    this.recoveryError = null; this.state = this.load();
  }
  load() {
    try {
      if (!fs.existsSync(this.file)) return { schema: SCHEMA, bots: Object.fromEntries(KALSHI_BOT_IDS.map(id => [id, emptyBot(id, DEFAULTS[id].startUsd)])) };
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s.schema !== SCHEMA || !s.bots) throw new Error('unknown schema');
      for (const id of KALSHI_BOT_IDS) { s.bots[id] ||= emptyBot(id, DEFAULTS[id].startUsd); s.bots[id].settings = { ...DEFAULTS[id], ...s.bots[id].settings }; }
      return s;
    } catch (e) {
      // Never overwrite a book we cannot read: trading stops until a reset, and the file is left in place.
      this.recoveryError = `Kalshi paper book unreadable (${e.message}); the file was kept. Reset a bot to start a new book.`;
      return { schema: SCHEMA, bots: Object.fromEntries(KALSHI_BOT_IDS.map(id => [id, emptyBot(id, DEFAULTS[id].startUsd)])) };
    }
  }
  save() { if (this.recoveryError) return; fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeFileAtomicSync(this.file, JSON.stringify(this.state)); }
  bot(id) { if (!KALSHI_BOT_IDS.includes(id)) throw new Error('Unknown Kalshi bot ' + id); return this.state.bots[id]; }
  configure(id, patch) { const b = this.bot(id); b.settings = { ...b.settings, ...sanitize(id, patch) }; this.save(); return this.snapshot(id); }
  reset(id, { startUsd, confirmation } = {}) {
    if (confirmation !== 'RESET BOT') throw new Error('Type RESET BOT to confirm');
    const b = this.bot(id), start = startUsd == null ? b.settings.startUsd : sanitize(id, { startUsd }).startUsd;
    const fresh = emptyBot(id, start); fresh.settings = { ...b.settings, startUsd: start }; fresh.epoch = (b.epoch || 1) + 1;
    this.recoveryError = null; this.state.bots[id] = fresh; this.save(); return this.snapshot(id);
  }
  decide(b, row) { b.decisions.unshift({ at: this.now(), ...row }); b.decisions.length = Math.min(b.decisions.length, 60); }

  async run(id) {
    if (this.recoveryError) throw new Error(this.recoveryError);
    if (this.busy.has(id)) return this.snapshot(id);
    const b = this.bot(id), k = this.kalshi(); this.busy.add(id);
    try {
      if (!k) throw new Error('Kalshi provider unavailable');
      await this.settle(b, k);
      if (b.settings.enabled) { if (id === 'weather') await this.runWeather(b, k); else await this.runBtc(b, k); }
      b.lastError = null;
    } catch (e) { b.lastError = String(e.message || e).slice(0, 300); }
    finally { b.lastRunAt = this.now(); this.busy.delete(id); this.save(); }
    return this.snapshot(id);
  }

  // Fill one chosen side against the live book, then book it.
  async enter(b, k, { ticker, eventTicker, title, label, side, pModel, qty, closeAt, feeModel, marketAsk, context }) {
    const book = await paced(() => k.book(ticker)), fills = walkAsks(book, side, qty, marketAsk + 0.02);
    const filled = fills.reduce((s, f) => s + f.quantity, 0);
    if (filled < 1) { this.decide(b, { event: eventTicker, ticker, side, action: 'SKIP', reason: 'no depth at the quoted ask' }); return false; }
    const cost = fills.reduce((s, f) => s + f.price * f.quantity, 0), fee = takerFee(feeModel, fills);
    if (fee === null) { this.decide(b, { event: eventTicker, ticker, side, action: 'SKIP', reason: 'fee model unavailable' }); return false; }
    const avg = cost / filled, edge = pModel - avg - fee / filled;
    if (edge < b.settings.minEdge) { this.decide(b, { event: eventTicker, ticker, side, action: 'SKIP', reason: `edge ${round(edge, 3)} after walking the book` }); return false; }
    if (cost + fee > b.cashUsd) { this.decide(b, { event: eventTicker, ticker, side, action: 'SKIP', reason: 'not enough paper cash' }); return false; }
    b.cashUsd = round(b.cashUsd - cost - fee, 6);
    b.open.push({ id: `${b.id}-${this.now()}-${ticker}`, ticker, eventTicker, title, label, side, qty: filled, avgPrice: round(avg, 4), costUsd: round(cost, 4), feeUsd: round(fee, 4), pModel: round(pModel, 4), marketPrice: round(avg, 4), openedAt: this.now(), closeAt, markUsd: round(cost, 4), context });
    this.decide(b, { event: eventTicker, ticker, label, side, action: 'ENTER', pModel: round(pModel, 3), price: round(avg, 3), fee: round(fee, 2), edge: round(edge, 3), qty: filled });
    return true;
  }

  async runWeather(b, k) {
    const s = b.settings, wx = await this.weather(); if (!wx) throw new Error('weather desk unavailable');
    const now = this.now(), held = new Set(b.open.map(p => p.eventTicker));
    const cands = []; let disagreements = 0;
    let calibrated = 0;
    for (const c of wx.cities || []) for (const m of c.markets || []) {
      if (held.has(m.eventTicker)) continue;
      const hours = (m.closeAt - now) / 3600e3; if (!(hours >= s.minHoursToClose)) continue;
      // Calibrated Open-Meteo model when this city/lead beat the default on held-out days (weatherCalibration.js);
      // otherwise the NWS forecast with the default bias and sigma.
      const cm = s.useCalibration && this.calibration ? await this.calibration.model(c.id, m.date).catch(() => null) : null;
      if (!cm && m.nwsHigh == null) continue;
      const sigma = cm ? cm.sigma * s.calibrationSafety : s.sigmaBaseF + s.sigmaPerDayF * Math.max(0, hours) / 24, mu = cm ? cm.mu : m.nwsHigh + s.biasF; if (cm) calibrated++;
      let best = null;
      for (const bk of m.buckets || []) {
        if (bk.yesAsk == null || bk.noAsk == null) continue;
        const sc = scoreSides({ pYes: bucketProbability(bk.lo, bk.hi, mu, sigma), yesAsk: bk.yesAsk, noAsk: bk.noAsk, yesBid: bk.yesBid, feeModel: bk.feeModel, stakeUsd: s.stakeUsd, minPrice: s.minPrice, maxPrice: s.maxPrice, maxDisagreement: s.maxDisagreement });
        if (sc?.disagree) { disagreements++; continue; }
        if (sc && (!best || sc.edge > best.edge)) best = { ...sc, bk };
      }
      if (best) cands.push({ ...best, city: c.label, m, mu, sigma, cm });
    }
    cands.sort((a, b2) => b2.edge - a.edge);
    let entered = 0;
    for (const x of cands) {
      const label = `${x.city} ${x.m.date} ${x.bk.lo === -Infinity ? '≤' + x.bk.hi : x.bk.hi === Infinity ? x.bk.lo + '+' : x.bk.lo + '–' + x.bk.hi}°F`;
      if (x.edge < s.minEdge) { this.decide(b, { event: x.m.eventTicker, label, side: x.side, action: 'SKIP', pModel: round(x.pModel, 3), price: x.ask, edge: round(x.edge, 3), reason: `best edge ${round(x.edge, 3)} < ${s.minEdge}` }); continue; }
      if (b.open.length >= s.maxOpen) { this.decide(b, { event: x.m.eventTicker, label, action: 'SKIP', reason: 'max open bets' }); break; }
      if (await this.enter(b, k, { ticker: x.bk.sourceId, eventTicker: x.m.eventTicker, title: x.m.title, label, side: x.side, pModel: x.pModel, qty: x.qty, closeAt: x.bk.closeAt || x.m.closeAt, feeModel: x.bk.feeModel, marketAsk: x.ask, context: { nwsHigh: x.m.nwsHigh, model: x.cm ? x.cm.source : 'nws + default', forecast: x.cm?.forecast ?? x.m.nwsHigh, lead: x.cm?.lead ?? null, mu: round(x.mu, 2), sigma: round(x.sigma, 2), marketExpected: x.m.expectedHigh } })) entered++;
    }
    b.lastNote = `${cands.length} events scored (${calibrated} on the calibrated model), ${entered} entered, ${disagreements} buckets skipped (model vs market gap > ${s.maxDisagreement})`;
  }

  async runBtc(b, k) {
    const s = b.settings, now = this.now();
    const get = async u => { const r = await this.fetch(u, { headers: { accept: 'application/json', 'user-agent': 'MoneyPrinterOS/0.5' }, signal: AbortSignal.timeout?.(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(u).host}`); return r.json(); };
    const [ticker, c5, c1] = await Promise.all([get('https://api.exchange.coinbase.com/products/BTC-USD/ticker'), get('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300'), get('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60')]);
    // Bets closing within 6 h use the last ~5 h of 1-minute vol (current regime); longer ones use ~25 h of 5-minute vol.
    const spot = Number(ticker.price), volDay = realizedVol(c5, 300), volNow = realizedVol(c1, 60) ?? volDay;
    if (!(spot > 0) || !volDay) throw new Error('BTC spot or volatility unavailable');
    const sigmaFor = hours => (hours <= 6 ? volNow : volDay) * s.volMultiple, sigma = volDay * s.volMultiple, held = new Set(b.open.map(p => p.eventTicker)), cands = []; let disagreements = 0;
    for (const series of BTC_SERIES) {
      const events = await paced(() => k.events({ series, limit: 6 }));
      for (const e of events) {
        if (held.has(e.event_ticker)) continue;
        const { markets } = await paced(() => k.markets({ eventTicker: e.event_ticker, limit: 200 }));
        let best = null;
        for (const m of markets) {
          const d = m.data, hours = (d.closeAt - now) / 3600e3;
          if (!(hours >= s.minHoursToClose && hours <= s.maxHoursToClose) || d.status !== 'ACTIVE' && d.status !== 'OPEN') continue;
          const p = btcContractProbability(d, spot, (d.closeAt - now) / 1000, sigmaFor(hours)); if (p === null || d.yesAsk == null || d.noAsk == null) continue;
          const sc = scoreSides({ pYes: p, yesAsk: d.yesAsk, noAsk: d.noAsk, yesBid: d.yesBid, feeModel: d.feeModel, stakeUsd: s.stakeUsd, minPrice: s.minPrice, maxPrice: s.maxPrice, maxDisagreement: s.maxDisagreement });
          if (sc?.disagree) { disagreements++; continue; }
          if (sc && (!best || sc.edge > best.edge)) best = { ...sc, m, e };
        }
        if (best) cands.push(best);
      }
    }
    cands.sort((a, c) => c.edge - a.edge);
    let entered = 0;
    for (const x of cands) {
      const d = x.m.data, label = `${d.strikeType === 'between' ? `$${d.floorStrike}–${d.capStrike}` : d.strikeType === 'greater' ? `above $${d.floorStrike}` : `below $${d.capStrike}`} · ${new Date(d.closeAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })}`;
      if (x.edge < s.minEdge) { this.decide(b, { event: x.e.event_ticker, label, side: x.side, action: 'SKIP', pModel: round(x.pModel, 3), price: x.ask, edge: round(x.edge, 3), reason: `best edge ${round(x.edge, 3)} < ${s.minEdge}` }); continue; }
      if (b.open.length >= s.maxOpen) { this.decide(b, { event: x.e.event_ticker, label, action: 'SKIP', reason: 'max open bets' }); break; }
      if (await this.enter(b, k, { ticker: x.m.sourceId, eventTicker: x.e.event_ticker, title: x.e.title, label, side: x.side, pModel: x.pModel, qty: x.qty, closeAt: d.closeAt, feeModel: d.feeModel, marketAsk: x.ask, context: { spot: round(spot, 2), volPerHour: round(sigmaFor((d.closeAt - now) / 3600e3) * 60, 5) } })) entered++;
    }
    b.lastNote = `BTC $${round(spot, 0)} · hourly vol ${(volNow * s.volMultiple * 60 * 100).toFixed(2)}% now / ${(sigma * 60 * 100).toFixed(2)}% 24h · ${cands.length} events scored, ${entered} entered, ${disagreements} contracts skipped (model vs market gap > ${s.maxDisagreement})`;
  }

  // Settle closed bets from the market's own result; mark open bets at the side's bid.
  async settle(b, k) {
    const now = this.now(), keep = [];
    for (const p of b.open) {
      let m = null; try { m = await paced(() => k.market(p.ticker)); } catch { keep.push(p); continue; }
      const d = m.data, outcome = d.settlementOutcome;
      if (outcome === 'YES' || outcome === 'NO') {
        const won = outcome === p.side, payout = won ? p.qty : 0, pnl = payout - p.costUsd - p.feeUsd;
        b.cashUsd = round(b.cashUsd + payout, 6);
        b.history.unshift({ ...p, status: 'SETTLED', outcome, won, payoutUsd: payout, pnlUsd: round(pnl, 4), settledAt: now, brierModel: round((p.pModel - (won ? 1 : 0)) ** 2, 4), brierMarket: round((p.marketPrice - (won ? 1 : 0)) ** 2, 4) });
        continue;
      }
      const bid = p.side === 'YES' ? d.yesBid : d.noBid; if (bid != null) p.markUsd = round(bid * p.qty, 4);
      keep.push(p);
    }
    b.open = keep; b.history.length = Math.min(b.history.length, 500);
  }

  snapshot(id) {
    const b = this.bot(id), h = b.history, n = h.length, wins = h.filter(x => x.won).length, pnl = h.reduce((s, x) => s + x.pnlUsd, 0);
    const openValue = b.open.reduce((s, p) => s + (p.markUsd ?? p.costUsd), 0), equity = b.cashUsd + openValue;
    const brier = k => n ? round(h.reduce((s, x) => s + x[k], 0) / n, 4) : null;
    let peak = b.startUsd, dd = 0, run = b.startUsd; const curve = [{ at: null, equityUsd: b.startUsd }];
    for (const x of h.slice().reverse()) { run += x.pnlUsd; peak = Math.max(peak, run); dd = Math.max(dd, peak - run); curve.push({ at: x.settledAt, equityUsd: round(run, 2) }); }
    return { id, label: id === 'weather' ? 'Kalshi weather bot' : 'Kalshi BTC range bot', mode: 'PAPER', epoch: b.epoch, settings: b.settings, startUsd: b.startUsd, cashUsd: round(b.cashUsd, 2), equityUsd: round(equity, 2), returnPct: round((equity - b.startUsd) / b.startUsd * 100, 2),
      open: b.open, history: h.slice(0, 50), decisions: b.decisions.slice(0, 30), curve: curve.slice(-200),
      stats: { settled: n, wins, hitRate: n ? round(wins / n, 3) : null, pnlUsd: round(pnl, 2), feesUsd: round(h.reduce((s, x) => s + x.feeUsd, 0), 2), brierModel: brier('brierModel'), brierMarket: brier('brierMarket'), maxDrawdownUsd: round(dd, 2) },
      lastRunAt: b.lastRunAt, lastError: this.recoveryError || b.lastError, lastNote: b.lastNote, running: this.busy.has(id) };
  }
  snapshots() { return Object.fromEntries(KALSHI_BOT_IDS.map(id => [id, this.snapshot(id)])); }
}
