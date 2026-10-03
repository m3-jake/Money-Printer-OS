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
import {assertPaperPrimaryAvailable,markPaperInitialized} from './paperBookStore.js';
import { takerFee } from './core/fees.js';
import { normCdf, bucketProbability, probAbove, btcContractProbability, realizedVol, scoreSides, weatherMuSigma } from './kalshiModel.js';
// The pricing model lives in the shared core (src/kalshiModel.js, run B4) so the Lab replays exactly this model.
export { normCdf, bucketProbability, probAbove, btcContractProbability, realizedVol, scoreSides, weatherMuSigma };
import { weatherTapeRow, btcTapeRow } from './botTape.js';

// weather-nws is the control arm of a forward A/B test: same rules as weather, but never uses the calibration.
export const KALSHI_BOT_IDS = Object.freeze(['weather', 'weather-nws', 'btc']);
const SCHEMA = 'mpo.kalshi-paper-bots.v1';
// The Kalshi paper wallet is $25 (bing, 2026-10-03): $12.50 weather + $12.50 BTC, $1 bets.
export const KALSHI_DEFAULTS = Object.freeze({
  weather: { enabled: true, useCalibration: true, calibrationSafety: 1.1, startUsd: 12.5, stakeUsd: 1, maxOpen: 10, minEdge: 0.07, maxDisagreement: 0.2, minPrice: 0.05, maxPrice: 0.92, biasF: 0, sigmaBaseF: 1.6, sigmaPerDayF: 1.0, minHoursToClose: 1 },
  'weather-nws': { enabled: true, useCalibration: false, calibrationSafety: 1.1, startUsd: 12.5, stakeUsd: 1, maxOpen: 10, minEdge: 0.07, maxDisagreement: 0.2, minPrice: 0.05, maxPrice: 0.92, biasF: 0, sigmaBaseF: 1.6, sigmaPerDayF: 1.0, minHoursToClose: 1 },
  // BTC model revision 2 (2026-10-03, run A2): avoid widening already conservative current-regime vol.
  // See reports/KALSHI-BTC-A2-2026-10-03.json: a small, overlapping diagnostic sample, not qualification.
  // Longshot guard: a side under 15¢ needs a 15¢ edge; the model-vs-market guard controls forward use.
  btc: { enabled: true, startUsd: 12.5, stakeUsd: 1, maxOpen: 4, minEdge: 0.06, maxDisagreement: 0.2, minPrice: 0.05, maxPrice: 0.92, volMultiple: 1.0, minHoursToClose: 0.5, maxHoursToClose: 30, longshotPrice: 0.15, longshotMinEdge: 0.15 },
});
const LIMITS = { calibrationSafety: [1, 3], maxDisagreement: [0.02, 1], stakeUsd: [1, 250], maxOpen: [1, 50], minEdge: [0.01, 0.5], minPrice: [0.01, 0.5], maxPrice: [0.5, 0.99], biasF: [-10, 10], sigmaBaseF: [0.5, 8], sigmaPerDayF: [0, 5], volMultiple: [0.5, 4], startUsd: [1, 100000], minHoursToClose: [0, 48], maxHoursToClose: [1, 240], longshotPrice: [0, 0.5], longshotMinEdge: [0, 0.5] };
// The BTC bot's model revision. A saved book from an older revision is moved to the current BTC model once, and
// the change is written to its decision log (history is never touched).
export const BTC_MODEL_REV = 2;

// "The model must beat the market" (run A2). Over the latest MODEL_GUARD.window settled bets (real and observed),
// once at least MODEL_GUARD.minSettled exist: when the model's Brier score is worse than the market price's, the
// bot stands down. It keeps recording the bets it would have made (observe-only, no cash), and those settle like
// real ones, so a model that becomes better than the market earns its way back.
export const MODEL_GUARD = Object.freeze({ minSettled: 10, window: 20 });
export function modelGuard(settled = [], { minSettled = MODEL_GUARD.minSettled, window = MODEL_GUARD.window } = {}) {
  const rows = (Array.isArray(settled) ? settled : []).filter(x => Number.isFinite(x?.brierModel) && Number.isFinite(x?.brierMarket))
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0)).slice(0, window);
  const n = rows.length, mean = k => n ? round(rows.reduce((s, x) => s + x[k], 0) / n, 4) : null;
  const brierModel = mean('brierModel'), brierMarket = mean('brierMarket'), observed = rows.filter(x => x.observed).length;
  if (n < minSettled) return { active: false, n, observed, brierModel, brierMarket, reason: `${n} of ${minSettled} settled bets before the model-vs-market check` };
  if (rows.reduce((s, x) => s + x.brierModel - x.brierMarket, 0) > 0) return { active: true, n, observed, brierModel, brierMarket, reason: `observe-only: over the last ${n} settled bets the model's probabilities (Brier ${brierModel}) were worse than the market's own prices (${brierMarket}); it records what it would bet until it beats the market` };
  return { active: false, n, observed, brierModel, brierMarket, reason: `trading: over the last ${n} settled bets the model (Brier ${brierModel}) is at least as good as the market (${brierMarket})` };
}
// An observe-only bet: the quoted ask, no cash, settled on the market's own result like a real bet.
export function observedBet(x, now, extra = {}) {
  return { ticker: x.ticker, eventTicker: x.eventTicker, label: x.label, side: x.side, qty: x.qty, price: x.ask, pModel: round(x.pModel, 4), marketPrice: x.ask, openedAt: now, closeAt: x.closeAt, observed: true, ...extra };
}
export function settleObserved(p, outcome, now) {
  const won = outcome === p.side, cost = p.price * p.qty;
  return { ...p, outcome, won, settledAt: now, pnlUsd: round((won ? p.qty : 0) - cost, 4), brierModel: round((p.pModel - (won ? 1 : 0)) ** 2, 4), brierMarket: round((p.marketPrice - (won ? 1 : 0)) ** 2, 4) };
}
const BTC_SERIES = ['KXBTCD', 'KXBTC'];
// One market snapshot (a frame) is shared by every bot and farm variant priced within its lifetime, and is
// written to the tape once. Weather bots run 70 s apart; the BTC farm runs 20 s after the BTC bot.
const FRAME_TTL_MS = { weather: 240_000, btc: 60_000 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Kalshi rate-limits bursts; every bot call is paced and a RATE_LIMITED answer is retried twice with backoff.
export async function paced(fn, { tries = 3, paceMs = 150, backoffMs = 4000 } = {}) {
  for (let i = 0; ; i++) { try { const out = await fn(); if (paceMs) await sleep(paceMs); return out; } catch (e) { if (!/RATE_LIMITED|rate limit/i.test(String(e.code || e.message)) || i >= tries - 1) throw e; await sleep(backoffMs * (i + 1)); } }
}
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// Walk the asks of one side for up to `qty` contracts. book: {yes:{asks}, no:{asks}} with ascending asks.
export function walkAsks(book, side, qty, limitPrice) {
  const asks = (side === 'YES' ? book?.yes?.asks : book?.no?.asks) || [];
  let left = qty; const fills = [];
  for (const l of asks) { if (left <= 0 || l.price > limitPrice) break; const q = Math.min(left, Math.floor(l.quantity)); if (q > 0) { fills.push({ price: l.price, quantity: q }); left -= q; } }
  return fills;
}

// Price every weather event in a frame under one bot's settings and return the best side per event.
// Pure, so the live bot and every farm variant score the same snapshot the same way.
export function pickWeather(frame, s, held, now) {
  const cands = []; let priced = 0, calibrated = 0, disagreements = 0, bindingRejected = 0;
  for (const { city, m, cm: calModel } of frame.events) {
    if (held.has(m.eventTicker)) continue;
    // A contract whose own rules name a different station/date/unit than the forecast city is not priced.
    if (m.binding?.ok === false) { bindingRejected++; continue; }
    const hours = (m.closeAt - now) / 3600e3; if (!(hours >= s.minHoursToClose)) continue;
    // Calibrated Open-Meteo model when this city/lead beat the default on held-out days (weatherCalibration.js);
    // otherwise the NWS forecast with the default bias and sigma.
    const cm = s.useCalibration ? calModel : null;
    if (!cm && m.nwsHigh == null) continue;
    const { mu, sigma } = weatherMuSigma({ cm, nwsHigh: m.nwsHigh, hours, settings: s }); priced++; if (cm) calibrated++;
    let best = null;
    for (const bk of m.buckets || []) {
      if (bk.yesAsk == null || bk.noAsk == null) continue;
      const sc = scoreSides({ pYes: bucketProbability(bk.lo, bk.hi, mu, sigma), yesAsk: bk.yesAsk, noAsk: bk.noAsk, yesBid: bk.yesBid, feeModel: bk.feeModel, stakeUsd: s.stakeUsd, minPrice: s.minPrice, maxPrice: s.maxPrice, maxDisagreement: s.maxDisagreement, longshotPrice: s.longshotPrice, longshotMinEdge: s.longshotMinEdge });
      if (sc?.disagree) { disagreements++; continue; }
      if (sc && (!best || sc.edge > best.edge)) best = { ...sc, bk };
    }
    if (best) cands.push({ ...best, city, m, mu, sigma, cm, eventTicker: m.eventTicker, ticker: best.bk.sourceId, closeAt: best.bk.closeAt || m.closeAt, feeModel: best.bk.feeModel,
      label: `${city} ${m.date} ${best.bk.lo === -Infinity ? '≤' + best.bk.hi : best.bk.hi === Infinity ? best.bk.lo + '+' : best.bk.lo + '–' + best.bk.hi}°F` });
  }
  return { cands: cands.sort((a, b) => b.edge - a.edge), priced, calibrated, disagreements, bindingRejected };
}
// Same for the BTC range and above/below contracts in a frame.
export function pickBtc(frame, s, held, now) {
  const cands = []; let disagreements = 0;
  const sigmaFor = hours => (hours <= 6 ? frame.volNow : frame.volDay) * s.volMultiple;
  for (const { e, markets } of frame.events) {
    if (held.has(e.event_ticker)) continue;
    let best = null;
    for (const m of markets) {
      const d = m.data, hours = (d.closeAt - now) / 3600e3;
      if (!(hours >= s.minHoursToClose && hours <= s.maxHoursToClose) || d.status !== 'ACTIVE' && d.status !== 'OPEN') continue;
      const p = btcContractProbability(d, frame.spot, (d.closeAt - now) / 1000, sigmaFor(hours)); if (p === null || d.yesAsk == null || d.noAsk == null) continue;
      const sc = scoreSides({ pYes: p, yesAsk: d.yesAsk, noAsk: d.noAsk, yesBid: d.yesBid, feeModel: d.feeModel, stakeUsd: s.stakeUsd, minPrice: s.minPrice, maxPrice: s.maxPrice, maxDisagreement: s.maxDisagreement, longshotPrice: s.longshotPrice, longshotMinEdge: s.longshotMinEdge });
      if (sc?.disagree) { disagreements++; continue; }
      if (sc && (!best || sc.edge > best.edge)) best = { ...sc, m, e };
    }
    if (best) {
      const d = best.m.data;
      cands.push({ ...best, eventTicker: best.e.event_ticker, ticker: best.m.sourceId, closeAt: d.closeAt, feeModel: d.feeModel, volPerHour: round(sigmaFor((d.closeAt - now) / 3600e3) * 60, 5),
        label: `${d.strikeType === 'between' ? `$${d.floorStrike}–${d.capStrike}` : d.strikeType === 'greater' ? `above $${d.floorStrike}` : `below $${d.capStrike}`} · ${new Date(d.closeAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })}` });
    }
  }
  return { cands: cands.sort((a, c) => c.edge - a.edge), disagreements, sigmaNow: frame.volNow * s.volMultiple, sigmaDay: frame.volDay * s.volMultiple };
}

function emptyBot(id, startUsd) { return { id, startUsd, cashUsd: startUsd, open: [], history: [], decisions: [], observedOpen: [], observedHistory: [], settings: { ...KALSHI_DEFAULTS[id], startUsd }, modelRev: id === 'btc' ? BTC_MODEL_REV : undefined, lastRunAt: null, lastError: null, lastNote: null, epoch: 1 }; }
function validateBotCapital(b){
 if(!b||!Number.isFinite(b.cashUsd)||b.cashUsd<0||!Number.isFinite(b.startUsd)||b.startUsd<0||!Array.isArray(b.open)||!Array.isArray(b.history))throw new Error('invalid bot capital/journal');
 for(const p of b.open)if(!p||!Number.isFinite(p.qty)||p.qty<=0||!Number.isFinite(p.costUsd)||p.costUsd<0||!Number.isFinite(p.feeUsd)||p.feeUsd<0||(p.markUsd!=null&&(!Number.isFinite(p.markUsd)||p.markUsd<0)))throw new Error('invalid bot open exposure');
 for(const p of b.history)if(!p||(p.pnlUsd!==undefined&&!Number.isFinite(p.pnlUsd)))throw new Error('invalid bot outcome');
}
function sanitize(id, patch = {}) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in KALSHI_DEFAULTS[id])) continue;
    if (k === 'enabled' || k === 'useCalibration') { out[k] = v === true || v === 'true' || v === 1 || v === '1'; continue; }
    const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
    const [a, b] = LIMITS[k] || [-Infinity, Infinity]; if (n < a || n > b) throw new Error(`${k} must be between ${a} and ${b}`);
    out[k] = n;
  }
  return out;
}

export class KalshiPaperBots {
  constructor({ dataDir, kalshi = () => null, weather = async () => null, calibration = null, tape = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'kalshi-paper-bots.json'); this.kalshi = kalshi; this.weather = weather; this.calibration = calibration; this.tape = tape; this.fetch = fetchImpl; this.now = now; this.busy = new Set();
    this.frames = {}; this.framing = {}; this.settledTape = new Set();
    this.recoveryError = null; this.state = this.load();
  }
  load() {
    try {
      assertPaperPrimaryAvailable(this.file);
      if (!fs.existsSync(this.file)) return { schema: SCHEMA, wallet25: true, bots: Object.fromEntries(KALSHI_BOT_IDS.map(id => [id, emptyBot(id, KALSHI_DEFAULTS[id].startUsd)])) };
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s.schema !== SCHEMA || !s.bots || Array.isArray(s.bots)) throw new Error('unknown schema');
      for(const b of Object.values(s.bots))validateBotCapital(b);
      if (!s.wallet25 && KALSHI_BOT_IDS.some(id => s.bots[id]?.startUsd === 500 && s.bots[id]?.settings?.stakeUsd === 10)) {
        fs.copyFileSync(this.file, this.file.replace(/\.json$/, `.pre-25usd-${Date.now()}.json`));
        for (const id of KALSHI_BOT_IDS) if (s.bots[id]?.startUsd === 500 && s.bots[id]?.settings?.stakeUsd === 10) { const fresh = emptyBot(id, KALSHI_DEFAULTS[id].startUsd); fresh.epoch = (s.bots[id].epoch || 1) + 1; fresh.settings.enabled = s.bots[id].settings.enabled !== false; s.bots[id] = fresh; }
      }
      s.wallet25 = true;
      for (const id of KALSHI_BOT_IDS) { s.bots[id] ||= emptyBot(id, KALSHI_DEFAULTS[id].startUsd); s.bots[id].settings = { ...KALSHI_DEFAULTS[id], ...s.bots[id].settings }; s.bots[id].observedOpen ||= []; s.bots[id].observedHistory ||= []; }
      const btc = s.bots.btc;
      if ((btc.modelRev || 1) < BTC_MODEL_REV) {
        // Model revision 2: the saved book keeps its history; only the model settings move (run A2, see KALSHI_DEFAULTS).
        const was = btc.settings.volMultiple;
        if (was === 1.25) btc.settings.volMultiple = KALSHI_DEFAULTS.btc.volMultiple;
        btc.modelRev = BTC_MODEL_REV;
        btc.decisions.unshift({ at: this.now(), action: 'SETTINGS', reason: `BTC model revision ${BTC_MODEL_REV}: vol × ${was} → × ${btc.settings.volMultiple} (1-minute realized vol already matched later BTC moves); sides under ${btc.settings.longshotPrice * 100}¢ need a ${btc.settings.longshotMinEdge * 100}¢ edge` });
      }
      markPaperInitialized(this.file);return s;
    } catch (e) {
      // Never overwrite a book we cannot read: trading stops until a reset, and the file is left in place.
      this.recoveryError = `Kalshi paper book unreadable (${e.message}); the file was kept. Reset a bot to start a new book.`;
      return { schema: SCHEMA,recoveryRequired:true,bots:Object.fromEntries(KALSHI_BOT_IDS.map(id=>[id,{...emptyBot(id,0),settings:{...KALSHI_DEFAULTS[id]},recoveryRequired:true}])) };
    }
  }
  save() { if (this.recoveryError) return;try{assertPaperPrimaryAvailable(this.file);for(const b of Object.values(this.state.bots))validateBotCapital(b);fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeFileAtomicSync(this.file, JSON.stringify(this.state));markPaperInitialized(this.file);}catch(e){this.recoveryError=`RECOVERY_REQUIRED: ${e.message}`;throw e;} }
  bot(id) { if (!KALSHI_BOT_IDS.includes(id)) throw new Error('Unknown Kalshi bot ' + id); return this.state.bots[id]; }
  configure(id, patch) { const b = this.bot(id); b.settings = { ...b.settings, ...sanitize(id, patch) }; this.save(); return this.snapshot(id); }
  reset(id, { startUsd, confirmation } = {}) {
    if (confirmation !== 'RESET BOT') throw new Error('Type RESET BOT to confirm');
    assertPaperPrimaryAvailable(this.file);if(fs.existsSync(this.file))fs.copyFileSync(this.file,`${this.file}.archive-${this.now()}-${Date.now()}.json`,fs.constants.COPYFILE_EXCL);
    const b = this.bot(id), start = startUsd == null ? b.settings.startUsd : sanitize(id, { startUsd }).startUsd;
    const fresh = emptyBot(id, start); fresh.settings = { ...b.settings, startUsd: start }; fresh.epoch = (b.epoch || 1) + 1;
    this.recoveryError = null; this.state.bots[id] = fresh; this.save(); return this.snapshot(id);
  }
  decide(b, row) { b.decisions.unshift({ at: this.now(), ...row }); b.decisions.length = Math.min(b.decisions.length, 60); }

  async run(id) {
    if (this.recoveryError) throw new Error(this.recoveryError);
    try{assertPaperPrimaryAvailable(this.file);}catch(e){this.recoveryError=`RECOVERY_REQUIRED: ${e.message}`;throw e;}
    if(this.bot(id).recoveryRequired)throw new Error('RECOVERY_REQUIRED: this bot has unknown archived capital; explicitly reset only this bot');
    if (this.busy.has(id)) return this.snapshot(id);
    const b = this.bot(id), k = this.kalshi(); this.busy.add(id);
    try {
      if (!k) throw new Error('Kalshi provider unavailable');
      await this.settle(b, k);
      this.guard(b);
      if (b.settings.enabled) { if (id.startsWith('weather')) await this.runWeather(b, k); else await this.runBtc(b, k); }
      b.lastError = null;
    } catch (e) { b.lastError = String(e.message || e).slice(0, 300); }
    finally { b.lastRunAt = this.now(); this.busy.delete(id); this.save(); }
    return this.snapshot(id);
  }

  // The model-vs-market guard over real and observed settled bets; a change of state goes to the decision log.
  guard(b) {
    // Only bets placed under the current model revision count: a new model is not judged on the old one's bets.
    const rev = b.modelRev ?? 1, current = x => (x.modelRev ?? 1) === rev;
    const was = b.standDown?.active === true, g = modelGuard([...b.history, ...(b.observedHistory || [])].filter(current));
    b.standDown = { ...g, since: g.active ? (was ? b.standDown.since : this.now()) : null };
    if (g.active !== was) this.decide(b, { action: g.active ? 'STAND DOWN' : 'RESUME', reason: g.reason });
    return b.standDown;
  }
  // Events already held, really or observe-only, are not scored again.
  held(b) { return new Set([...b.open, ...(b.observedOpen || [])].map(p => p.eventTicker)); }
  // Enter candidates best first; while the bot stands down, record them observe-only instead (no cash, no book walk).
  async place(b, k, cands, enterArgs) {
    const s = b.settings, observing = b.standDown?.active === true, held = this.held(b);
    let entered = 0, observed = 0;
    for (const x of cands) {
      if (x.edge < s.minEdge) { this.decide(b, { event: x.eventTicker, label: x.label, side: x.side, action: 'SKIP', pModel: round(x.pModel, 3), price: x.ask, edge: round(x.edge, 3), reason: `best edge ${round(x.edge, 3)} < ${s.minEdge}` }); continue; }
      if (observing) {
        if (held.has(x.eventTicker)) continue;
        if (b.observedOpen.length >= s.maxOpen) { this.decide(b, { event: x.eventTicker, label: x.label, action: 'SKIP', reason: 'max observed bets' }); break; }
        b.observedOpen.push(observedBet(x, this.now(), { modelRev: b.modelRev ?? 1 })); held.add(x.eventTicker); observed++;
        this.decide(b, { event: x.eventTicker, ticker: x.ticker, label: x.label, side: x.side, action: 'OBSERVE', pModel: round(x.pModel, 3), price: x.ask, edge: round(x.edge, 3), reason: 'observe-only: recorded, no paper cash used' });
        continue;
      }
      if (b.open.length >= s.maxOpen) { this.decide(b, { event: x.eventTicker, label: x.label, action: 'SKIP', reason: 'max open bets' }); break; }
      if (await this.enter(b, k, enterArgs(x))) entered++;
    }
    return { entered, observed, note: observing ? `OBSERVE-ONLY (${b.standDown.reason.replace(/^observe-only: /, '')}) · ${observed} recorded` : `${entered} entered` };
  }

  // Fill one chosen side against the live book, then book it.
  async enter(b, k, { ticker, eventTicker, title, label, side, pModel, qty, closeAt, feeModel, marketAsk, context }) {
    const book = await paced(() => k.book(ticker)), fills = walkAsks(book, side, qty, marketAsk + 0.02);
    const filled = fills.reduce((s, f) => s + f.quantity, 0);
    if (filled < 1) { this.decide(b, { event: eventTicker, ticker, side, action: 'SKIP', reason: 'no depth at the quoted ask' }); return false; }
    const cost = fills.reduce((s, f) => s + f.price * f.quantity, 0), fee = takerFee(feeModel, fills);
    if (fee === null) { this.decide(b, { event: eventTicker, ticker, side, action: 'SKIP', reason: 'fee model unavailable' }); return false; }
    const avg = cost / filled, edge = pModel - avg - fee / filled;
    const requiredEdge = Math.max(b.settings.minEdge, avg < (b.settings.longshotPrice || 0) ? (b.settings.longshotMinEdge || 0) : 0);
    if (edge < requiredEdge) { this.decide(b, { event: eventTicker, ticker, side, action: 'SKIP', reason: `edge ${round(edge, 3)} after walking the book < ${requiredEdge}` }); return false; }
    if (cost + fee > b.cashUsd) { this.decide(b, { event: eventTicker, ticker, side, action: 'SKIP', reason: 'not enough paper cash' }); return false; }
    b.cashUsd = round(b.cashUsd - cost - fee, 6);
    b.open.push({ id: `${b.id}-${this.now()}-${ticker}`, modelRev: b.modelRev ?? 1, ticker, eventTicker, title, label, side, qty: filled, avgPrice: round(avg, 4), costUsd: round(cost, 4), feeUsd: round(fee, 4), pModel: round(pModel, 4), marketPrice: round(avg, 4), openedAt: this.now(), closeAt, markUsd: round(cost, 4), context });
    this.decide(b, { event: eventTicker, ticker, label, side, action: 'ENTER', pModel: round(pModel, 3), price: round(avg, 3), fee: round(fee, 2), edge: round(edge, 3), qty: filled });
    return true;
  }

  // The current weather frame: every city's open daily-high markets with bid/ask, the NWS forecast and the
  // calibrated model (whether or not a given bot uses it). Fetched once per FRAME_TTL_MS and taped once.
  weatherFrame() {
    return this.frame('weather', async () => {
      const wx = await this.weather(); if (!wx) throw new Error('weather desk unavailable');
      const events = [];
      for (const c of wx.cities || []) for (const m of c.markets || []) {
        const cm = this.calibration ? await this.calibration.model(c.id, m.date).catch(() => null) : null;
        events.push({ cityId: c.id, city: c.label, m, cm });
      }
      return { events };
    }, weatherTapeRow, 'kalshi-weather');
  }
  // The current BTC frame: Coinbase spot, 1-minute and 5-minute realized vol, and every open KXBTCD/KXBTC event's markets.
  btcFrame(k) {
    return this.frame('btc', async () => {
      const get = async u => { const r = await this.fetch(u, { headers: { accept: 'application/json', 'user-agent': 'MoneyPrinterOS/0.5' }, signal: AbortSignal.timeout?.(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(u).host}`); return r.json(); };
      const [ticker, c5, c1] = await Promise.all([get('https://api.exchange.coinbase.com/products/BTC-USD/ticker'), get('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300'), get('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60')]);
      // Bets closing within 6 h use the last ~5 h of 1-minute vol (current regime); longer ones use ~25 h of 5-minute vol.
      const spot = Number(ticker.price), volDay = realizedVol(c5, 300), volNow = realizedVol(c1, 60) ?? volDay;
      if (!(spot > 0) || !volDay) throw new Error('BTC spot or volatility unavailable');
      const events = [];
      for (const series of BTC_SERIES) for (const e of await paced(() => k.events({ series, limit: 6 }))) {
        const { markets } = await paced(() => k.markets({ eventTicker: e.event_ticker, limit: 200 }));
        events.push({ e: { event_ticker: e.event_ticker, title: e.title }, markets });
      }
      return { spot, volNow, volDay, events };
    }, btcTapeRow, 'kalshi-btc');
  }
  async frame(kind, build, toRow, stream) {
    const hit = this.frames[kind]; if (hit && this.now() - hit.at < FRAME_TTL_MS[kind]) return hit;
    if (!this.framing[kind]) this.framing[kind] = (async () => { const f = { at: this.now(), ...(await build()) }; this.frames[kind] = f; this.tape?.append(stream, toRow(f)); return f; })().finally(() => { this.framing[kind] = null; });
    return this.framing[kind];
  }

  async runWeather(b, k) {
    const s = b.settings, frame = await this.weatherFrame(), now = this.now();
    const { cands, priced, calibrated, disagreements } = pickWeather(frame, s, this.held(b), now);
    const r = await this.place(b, k, cands, x => ({ ticker: x.ticker, eventTicker: x.eventTicker, title: x.m.title, label: x.label, side: x.side, pModel: x.pModel, qty: x.qty, closeAt: x.closeAt, feeModel: x.feeModel, marketAsk: x.ask, context: { nwsHigh: x.m.nwsHigh, model: x.cm ? x.cm.source : 'nws + default', forecast: x.cm?.forecast ?? x.m.nwsHigh, lead: x.cm?.lead ?? null, mu: round(x.mu, 2), sigma: round(x.sigma, 2), marketExpected: x.m.expectedHigh } }));
    b.lastNote = `${priced} events priced (${calibrated} on the calibrated model), ${cands.length} with a buyable side, ${r.note}, ${disagreements} buckets skipped (model vs market gap > ${s.maxDisagreement})`;
  }

  async runBtc(b, k) {
    const s = b.settings, frame = await this.btcFrame(k), now = this.now();
    const { cands, disagreements, sigmaNow, sigmaDay } = pickBtc(frame, s, this.held(b), now);
    const r = await this.place(b, k, cands, x => ({ ticker: x.ticker, eventTicker: x.eventTicker, title: x.e.title, label: x.label, side: x.side, pModel: x.pModel, qty: x.qty, closeAt: x.closeAt, feeModel: x.feeModel, marketAsk: x.ask, context: { spot: round(frame.spot, 2), volPerHour: x.volPerHour } }));
    b.lastNote = `BTC ${round(frame.spot, 0)} · hourly vol ${(sigmaNow * 60 * 100).toFixed(2)}% now / ${(sigmaDay * 60 * 100).toFixed(2)}% 24h · ${cands.length} events scored, ${r.note}, ${disagreements} contracts skipped (model vs market gap > ${s.maxDisagreement})`;
  }

  // A market's result, taped once per ticker (the farm calls this too).
  tapeSettlement(ticker, eventTicker, d) {
    if (!this.tape || this.settledTape.has(ticker)) return; this.settledTape.add(ticker);
    this.tape.append('kalshi-settle', { ticker, event: eventTicker, outcome: d.settlementOutcome, status: d.status || null });
  }

  // Settle closed bets from the market's own result; mark open bets at the side's bid.
  async settle(b, k) {
    const now = this.now(), keep = [];
    for (const p of b.open) {
      let m = null; try { m = await paced(() => k.market(p.ticker)); } catch { keep.push(p); continue; }
      const d = m.data, outcome = d.settlementOutcome;
      if (outcome === 'YES' || outcome === 'NO') {
        this.tapeSettlement(p.ticker, p.eventTicker, d);
        const won = outcome === p.side, payout = won ? p.qty : 0, pnl = payout - p.costUsd - p.feeUsd;
        b.cashUsd = round(b.cashUsd + payout, 6);
        b.history.unshift({ ...p, status: 'SETTLED', outcome, won, payoutUsd: payout, pnlUsd: round(pnl, 4), settledAt: now, brierModel: round((p.pModel - (won ? 1 : 0)) ** 2, 4), brierMarket: round((p.marketPrice - (won ? 1 : 0)) ** 2, 4) });
        continue;
      }
      const bid = p.side === 'YES' ? d.yesBid : d.noBid; if (bid != null) p.markUsd = round(bid * p.qty, 4);
      keep.push(p);
    }
    b.open = keep;
    // Observe-only bets settle on the same result once their market has closed.
    const still = [];
    for (const p of b.observedOpen || []) {
      if (p.closeAt > now) { still.push(p); continue; }
      let d = null; try { d = (await paced(() => k.market(p.ticker))).data; } catch { still.push(p); continue; }
      const outcome = d?.settlementOutcome;
      if (outcome !== 'YES' && outcome !== 'NO') { still.push(p); continue; }
      this.tapeSettlement(p.ticker, p.eventTicker, d);
      (b.observedHistory ||= []).unshift(settleObserved(p, outcome, now));
    }
    b.observedOpen = still;
  }

  snapshot(id) {
    if(this.recoveryError||this.bot(id).recoveryRequired)return {id,mode:'PAPER',status:'RECOVERY_REQUIRED',recoveryRequired:true,cashUsd:null,equityUsd:null,startUsd:null,open:[],history:[],decisions:[],stats:{settled:0,pnlUsd:null},lastError:this.recoveryError||'Archived capital unknown; this bot requires explicit reset'};
    const b = this.bot(id), h = b.history, n = h.length, wins = h.filter(x => x.won).length, pnl = h.reduce((s, x) => s + x.pnlUsd, 0);
    const openValue = b.open.reduce((s, p) => s + (p.markUsd ?? p.costUsd), 0), equity = b.cashUsd + openValue;
    const brier = k => n ? round(h.reduce((s, x) => s + x[k], 0) / n, 4) : null;
    let peak = b.startUsd, dd = 0, run = b.startUsd; const curve = [{ at: null, equityUsd: b.startUsd }];
    for (const x of h.slice().reverse()) { run += x.pnlUsd; peak = Math.max(peak, run); dd = Math.max(dd, peak - run); curve.push({ at: x.settledAt, equityUsd: round(run, 2) }); }
    return { id, label: id === 'weather' ? 'Kalshi weather bot' : id === 'weather-nws' ? 'Kalshi weather bot · control (NWS only, no calibration)' : 'Kalshi BTC range bot', mode: 'PAPER', epoch: b.epoch, settings: b.settings, startUsd: b.startUsd, cashUsd: round(b.cashUsd, 2), equityUsd: round(equity, 2), returnPct: round((equity - b.startUsd) / b.startUsd * 100, 2),
      open: b.open, history: h.slice(0, 50), decisions: b.decisions.slice(0, 30), curve: curve.slice(-200),
      stats: { settled: n, wins, hitRate: n ? round(wins / n, 3) : null, pnlUsd: round(pnl, 2), feesUsd: round(h.reduce((s, x) => s + x.feeUsd, 0), 2), brierModel: brier('brierModel'), brierMarket: brier('brierMarket'), maxDrawdownUsd: round(dd, 2) },
      standDown: b.standDown || modelGuard([...h, ...(b.observedHistory || [])].filter(x => (x.modelRev ?? 1) === (b.modelRev ?? 1))), modelRev: b.modelRev ?? 1,
      observed: { open: (b.observedOpen || []).length, settled: (b.observedHistory || []).length, wins: (b.observedHistory || []).filter(x => x.won).length, pnlUsd: round((b.observedHistory || []).reduce((s, x) => s + x.pnlUsd, 0), 2), recent: (b.observedHistory || []).slice(0, 20), openBets: b.observedOpen || [] },
      lastRunAt: b.lastRunAt, lastError: this.recoveryError || b.lastError, lastNote: b.lastNote, running: this.busy.has(id) };
  }
  snapshots() { return Object.fromEntries(KALSHI_BOT_IDS.map(id => [id, this.snapshot(id)])); }
}
