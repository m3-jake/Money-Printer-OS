// Robinhood crypto DAILY-BAR paper book (a book inside the Robinhood module, next to the strict 15 s book,
// the exploration book and the practice sandbox). Paper only: this file imports no transport, signer or
// journal, and nothing here can reach a broker or grant live authority.
//
// Why a separate book: at 0.95% per side a round trip costs about 2%, which the 15 s strategies rarely clear.
// The Evolution Lab searches slow, multi-day families on Coinbase public daily candles (its robinhoodDaily.js)
// and publishes the verdict as the `daily` block of lab-link/modules/robinhood.json. This book executes one of
// those families on paper:
//   - the Lab's daily.proposal, only when championState clears it for paper and its params are in bounds;
//   - otherwise the Lab's default daily family (LAB_DEFAULT_DAILY), clearly labelled as an unqualified book.
//
// Rules (mirroring the Lab's replay so the two can be compared):
//   - Bars: Coinbase public daily candles (UTC days), one request per symbol per closed day.
//   - Exactly one decision per closed UTC bar, taken at the first run after that bar closes, persisted before
//     any fill, so a restart never decides the same bar twice. Days the app was off are counted as missed and
//     never decided after the fact.
//   - Decisions use the close of day D; forward fills require a fresh supported Robinhood quote
//     after decision plus processing latency. Historical next-open proxies belong only to daily-shadow.
//   - Costs: fee max(0.95%, account fee) per side plus slippage (default 5 bps) on both sides.
//   - Long or flat per symbol, one equal sleeve per symbol, holds for as many days as the signal says.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchPublicCandles } from './robinhoodPaperFeed.js';
import { writeJsonAtomic } from './robinhoodEquitiesData.js';
import { championState, championPaperAllowed } from './championState.js';
import { CHALLENGER_BOUNDS, validateChallenger, atrChallengerSignal, challengerCapabilities } from './strategyChallengers.js';

export const DAILY_BOOK_SCHEMA = 'mpo.robinhood-daily-paper.v1';
export const DAILY_BOOK_LABELS = Object.freeze({
  'lab-proposal': 'LAB DAILY PROPOSAL · PAPER ONLY',
  'lab-default': 'LAB DEFAULT DAILY FAMILY · PAPER ONLY · NOT A QUALIFIED STRATEGY',
});
// The Lab's default daily family: its 200-day SMA trend filter with a 2% band. It sits inside the Lab grid and
// its rule (lookback >= 100 days), and is the book that runs whenever no proposal is cleared for paper.
export const LAB_DEFAULT_DAILY = Object.freeze({ family: 'trend', params: Object.freeze({ smaDays: 200, bandPct: 2 }) });
export const DAILY_DEFAULTS = Object.freeze({
  startUsd: 25, feeFloor: 0.0095, slipBps: 5, symbols: Object.freeze(['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD', 'XRP-USD', 'AVAX-USD', 'LINK-USD', 'ADA-USD']),
  quoteWindowMin: 30, processingLatencyMs:250,retryMs: 15 * 60_000, barsKeep: 500, historyDays: 299,
});
// Qualification suited to a book that trades one or two times a month. Paper evidence only: passing it never
// unlocks live execution (liveEligible is always false).
export const DAILY_QUALIFICATION = Object.freeze({
  windowDays: 365, minRunDays: 180, minClosedTrades: 10, minProfitFactor: 1.2,
});
// Parameter bounds for any family the Lab may propose. Integer day counts; the history fetched covers them.
export const DAILY_PARAM_BOUNDS = Object.freeze({
  'atr-breakout': Object.freeze(CHALLENGER_BOUNDS['atr-breakout']),
  breakout: Object.freeze({ entryDays: [10, 200, true], exitDays: [5, 100, true] }),
  trend: Object.freeze({ smaDays: [50, 250, true], bandPct: [0, 10, false] }),
  tsmom: Object.freeze({ lookbackDays: [14, 250, true], thresholdPct: [0, 25, false] }),
});
const DAY = 864e5;
const SYMBOL_RE = /^[A-Z0-9]{2,10}-USD$/;
const r2 = v => Math.round(Number(v) * 100) / 100;
const r4 = v => Math.round(Number(v) * 1e4) / 1e4;
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const dayStart = d => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => dayKey(dayStart(d) + n * DAY);
const finite = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export function dailyParamsHash(family, params) {
  return createHash('sha256').update(JSON.stringify({ family, params })).digest('hex').slice(0, 12);
}
// Validates a family + params pair against DAILY_PARAM_BOUNDS and the Lab's structural rules. No clamping:
// out-of-bounds params are refused, never silently bent into range.
export function validateDailyParams(family, params) {
  if (family === 'atr-breakout') return validateChallenger(family, params);
  const bounds = DAILY_PARAM_BOUNDS[family], reasons = [];
  if (!bounds) return { ok: false, reasons: [`unknown daily family ${String(family)}`] };
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, reasons: ['params missing'] };
  for (const key of Object.keys(params)) if (!Object.hasOwn(bounds, key)) reasons.push(`unexpected param ${key}`);
  for (const [key, [lo, hi, int]] of Object.entries(bounds)) {
    const v = params[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) { reasons.push(`${key} missing`); continue; }
    if (v < lo || v > hi) reasons.push(`${key} ${v} outside [${lo}, ${hi}]`);
    if (int && !Number.isInteger(v)) reasons.push(`${key} must be a whole number of days`);
  }
  if (!reasons.length && family === 'breakout' && !(params.exitDays < params.entryDays)) reasons.push('exitDays must be shorter than entryDays');
  if (!reasons.length && family === 'trend' && !(params.smaDays >= 100 || params.bandPct >= 5)) reasons.push('trend needs smaDays >= 100 or bandPct >= 5 (short trends failed out of sample in the Lab)');
  return { ok: !reasons.length, reasons };
}

// The Lab's decision rule (robinhoodDaily.js signalFn), verbatim: desired position after the close of bar i
// (true long, false flat, null no change). Reads only bars[0..i].
export function dailySignal(family, params, bars, i, long) {
  const p = params;
  if (family === 'atr-breakout') return atrChallengerSignal(params, bars, i, long);
  if (family === 'breakout') {
    if (!long) {
      if (i < p.entryDays) return null;
      let hi = -Infinity; for (let k = i - p.entryDays; k < i; k++) hi = Math.max(hi, bars[k].h);
      return bars[i].c > hi ? true : null;
    }
    if (i < p.exitDays) return null;
    let lo = Infinity; for (let k = i - p.exitDays; k < i; k++) lo = Math.min(lo, bars[k].l);
    return bars[i].c < lo ? false : null;
  }
  if (family === 'trend') {
    if (i + 1 < p.smaDays) return null;
    let sum = 0; for (let k = i + 1 - p.smaDays; k <= i; k++) sum += bars[k].c;
    const sma = sum / p.smaDays, band = p.bandPct / 100;
    if (!long && bars[i].c > sma * (1 + band)) return true;
    if (long && bars[i].c < sma * (1 - band)) return false;
    return null;
  }
  if (family === 'tsmom') {
    if (i < p.lookbackDays || new Date(bars[i].t).getUTCDay() !== 0) return null;
    return bars[i].c / bars[i - p.lookbackDays].c - 1 > p.thresholdPct / 100;
  }
  throw new Error(`unknown daily family ${family}`);
}
// Bars a family needs before its first signal.
export function warmupDays(family, params) {
  if (family === 'atr-breakout') return Math.max(params.entryDays, params.atrDays) + 1;
  if (family === 'breakout') return params.entryDays + 1;
  if (family === 'trend') return params.smaDays;
  if (family === 'tsmom') return params.lookbackDays + 7;
  return Infinity;
}

// ---------------------------------------------------------------- Lab record
export function readLabDaily(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, 'lab-link', 'modules', 'robinhood.json'), 'utf8'));
    return v?.module === 'robinhood' && v.daily && typeof v.daily === 'object' ? v.daily : null;
  } catch { return null; }
}
// Which family this book runs. The Lab's proposal only when it is cleared for paper by championState (state
// PAPER or higher plus the Lab's paper-promotion flag), claims no live authority and has in-bounds params.
export function pickDailyStrategy(daily) {
  const prop = daily?.proposal || null, reasons = [];
  let state = null;
  if (!prop) reasons.push(daily ? `the Lab has no daily proposal (${String(daily.phase || 'no phase')})` : 'no Lab daily record yet');
  else {
    const doc = { ...prop, paperPromotionAllowed: daily.paperPromotionAllowed === true && prop.paperPromotionAllowed !== false };
    state = championState(doc).state;
    if (daily.liveActivationAllowed === true || prop.liveActivationAllowed === true || prop.automaticLivePromotionAllowed === true) reasons.push('the record claims live authority; refused');
    if (!championPaperAllowed(doc)) reasons.push(`the proposal is ${state}${doc.paperPromotionAllowed ? '' : ' without the Lab paper-promotion flag'}, not cleared for paper`);
    if (prop.family === 'atr-breakout') reasons.push('challenger adapter requires a separate frozen exploratory cohort; the incumbent daily book is preserved');
    const v = validateDailyParams(prop.family, prop.params);
    if (!v.ok) reasons.push(...v.reasons.map(r => `proposal params: ${r}`));
  }
  if (!reasons.length) {
    const params = { ...prop.params };
    return { kind: 'lab-proposal', label: DAILY_BOOK_LABELS['lab-proposal'], id: String(prop.id || ''), family: prop.family, params, paramsHash: dailyParamsHash(prop.family, params), state, reasons: [] };
  }
  const { family } = LAB_DEFAULT_DAILY, params = { ...LAB_DEFAULT_DAILY.params };
  return { kind: 'lab-default', label: DAILY_BOOK_LABELS['lab-default'], id: `lab-default-${family}-${Object.values(params).join('-')}`, family, params, paramsHash: dailyParamsHash(family, params), state, reasons, proposalId: prop?.id || null };
}

// ---------------------------------------------------------------- bars (Coinbase public daily candles)
export function barsFile(dataDir) { return path.join(dataDir, 'robinhood-daily', 'bars.json'); }
export function readDailyBars(dataDir) {
  try { const v = JSON.parse(fs.readFileSync(barsFile(dataDir), 'utf8')); if (v?.version === 1 && v.bars && typeof v.bars === 'object') return { today: {}, ...v }; } catch {}
  return { version: 1, source: 'coinbase-public-daily', fetchedAt: null, lastAttemptAt: null, lastError: null, bars: {}, today: {} };
}
// Newest complete UTC day at `now` (the bar whose close has passed).
export function lastClosedDay(now) { return dayKey(now - DAY); }
// One request per symbol per closed day (retried no sooner than retryMs after an error). Complete days are
// stored; today's in-progress candle is kept only for its open, which is the fill price of yesterday's decision.
export async function refreshDailyBars(dataDir, symbols, { now = Date.now(), fetchFn = globalThis.fetch, retryMs = DAILY_DEFAULTS.retryMs, force = false } = {}) {
  const store = readDailyBars(dataDir), closed = lastClosedDay(now), today = dayKey(now);
  const fresh = symbols.every(s => store.bars[s]?.at(-1)?.d >= closed && store.today?.[s]?.d === today);
  if (!force && fresh) return { store, fetched: false, reason: 'FRESH' };
  if (!force && store.lastAttemptAt && now - store.lastAttemptAt < retryMs) return { store, fetched: false, reason: 'BUDGET' };
  store.lastAttemptAt = now;
  const errors = [];
  for (const s of symbols) {
    if (!SYMBOL_RE.test(s)) continue;
    const have = store.bars[s] || [];
    if (have.at(-1)?.d >= closed && store.today?.[s]?.d === today) continue;
    const startMs = Math.max(have.length ? have.at(-1).t + DAY : 0, dayStart(today) - DAILY_DEFAULTS.historyDays * DAY);
    try {
      const candles = await fetchPublicCandles(s, { startMs, endMs: now, granularity: 86400, fetchFn });
      const byT = new Map(have.map(b => [b.t, b]));
      for (const c of candles) {
        if (c.t === dayStart(today)) { store.today[s] = { d: today, t: c.t, o: c.open }; continue; }
        if (c.t > dayStart(closed)) continue;
        byT.set(c.t, { d: dayKey(c.t), t: c.t, o: c.open, h: c.high, l: c.low, c: c.close });
      }
      store.bars[s] = [...byT.values()].sort((a, b) => a.t - b.t).slice(-DAILY_DEFAULTS.barsKeep);
    } catch (e) { errors.push(`${s}: ${String(e?.message || e).slice(0, 120)}`); }
  }
  store.lastError = errors.length ? { at: now, message: errors.join('; ') } : null;
  if (!errors.length) store.fetchedAt = now;
  writeJsonAtomic(barsFile(dataDir), store);
  return { store, fetched: true, reason: errors.length ? 'ERROR' : 'OK' };
}
function openOf(store, symbol, day) {
  const bar = (store.bars[symbol] || []).find(b => b.d === day);
  if (bar) return bar.o;
  const t = store.today?.[symbol];
  return t && t.d === day && t.o > 0 ? t.o : null;
}

// ---------------------------------------------------------------- book
export function bookFile(dataDir) { return path.join(dataDir, 'robinhood-daily-paper.json'); }
export function newDailyBook({ startUsd = DAILY_DEFAULTS.startUsd, symbols = DAILY_DEFAULTS.symbols, slipBps = DAILY_DEFAULTS.slipBps, now = Date.now() } = {}) {
  const list = [...new Set(symbols)].filter(s => SYMBOL_RE.test(s));
  if (!list.length || !Number.isFinite(startUsd) || startUsd <= 0) throw new Error('Daily paper book requires symbols and a positive bankroll');
  const cents = Math.round(startUsd * 100), alloc = Math.floor(cents / list.length);
  return {
    schema: DAILY_BOOK_SCHEMA, version: 1, createdAt: now, startUsd, slipBps, symbols: list, execution: 'paper-only', liveEligible: false,
    source: null, sleeves: Object.fromEntries(list.map((s, i) => [s, { cashUsd: (alloc + (i === list.length - 1 ? cents - alloc * list.length : 0)) / 100, qty: 0, entry: null }])),
    pending: [], lastDecidedDay: null, lastDecision: null, missedDays: 0, history: [], fills: [], equityDaily: [], bench: null, events: [],
    recoveryRequired: false, recoveryReason: null,
  };
}
export function loadDailyBook(dataDir, init = {}) {
  let raw;
  try { raw = fs.readFileSync(bookFile(dataDir), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return newDailyBook(init); return { ...newDailyBook(init), recoveryRequired: true, recoveryReason: `unreadable: ${e.code}` }; }
  try {
    const b = JSON.parse(raw);
    if (b?.schema !== DAILY_BOOK_SCHEMA || b.version !== 1 || !b.sleeves || !Array.isArray(b.pending) || !Array.isArray(b.history)) throw new Error('shape');
    if(!Array.isArray(b.symbols)||b.symbols.some(s=>!SYMBOL_RE.test(s)||!b.sleeves[s]||!Number.isFinite(b.sleeves[s].cashUsd)||b.sleeves[s].cashUsd<0||!Number.isFinite(b.sleeves[s].qty)||b.sleeves[s].qty<0))throw new Error('invalid sleeve capital');
    return { ...b, execution: 'paper-only', liveEligible: false };
  } catch { return { ...newDailyBook(init), recoveryRequired: true, recoveryReason: 'corrupt daily paper book; review it, then reset with RESET DAILY' }; }
}
export function saveDailyBook(dataDir, book) { if (book.recoveryRequired) return false; writeJsonAtomic(bookFile(dataDir), book); return true; }
function event(book, now, text) { book.events = [{ at: now, text: String(text).slice(0, 200) }, ...(book.events || [])].slice(0, 40); }

function fillOne(book, order, { price, priceSource, late, fee, now,quoteEvidence=null }) {
  const sl = book.sleeves[order.symbol], slip = book.slipBps / 1e4;
  if (order.side === 'buy') {
    if (sl.qty > 0 || !(sl.cashUsd > 0)) return null;
    const fillPrice = price * (1 + slip),wanted=sl.cashUsd*(1-fee)/fillPrice,step=quoteEvidence?.quantityStep;
    const qty=step>0?Math.floor(wanted/step)*step:wanted;if(!(qty>0))return null;
    const costUsd=qty*fillPrice/(1-fee),feeUsd=costUsd*fee;
    sl.qty = qty; sl.cashUsd = Math.max(0,sl.cashUsd-costUsd);
    sl.entry = { day: dayKey(now), refPrice: price, fillPrice: r4(fillPrice), costUsd: r2(costUsd), feeUsd: r2(feeUsd), priceSource, late, paramsHash: order.paramsHash, at: now,quoteEvidence,executionEvidence:!!quoteEvidence };
    const f = { at: now, day: order.fillDay, decidedForDay: order.decidedForDay, symbol: order.symbol, side: 'buy', qty, refPrice: price, fillPrice: r4(fillPrice), notionalUsd: r2(costUsd), feeUsd: r2(feeUsd), priceSource, late, paramsHash: order.paramsHash };
    Object.assign(f,{quoteEvidence,executionEvidence:!!quoteEvidence,decisionAt:order.decidedAt,filledAt:now});book.fills = [f, ...book.fills];
    return f;
  }
  if (!(sl.qty > 0)) return null;
  const fillPrice = price * (1 - slip), gross = sl.qty * fillPrice, feeUsd = gross * fee, proceeds = gross - feeUsd, e = sl.entry || {};
  const trade = {
    symbol: order.symbol, entryDay: e.day || null, exitDay: dayKey(now), holdDays: e.day ? Math.round((dayStart(dayKey(now)) - dayStart(e.day)) / DAY) : null,
    entryPrice: e.fillPrice ?? null, exitPrice: r4(fillPrice), costUsd: e.costUsd ?? null, proceedsUsd: r2(proceeds), feesUsd: r2((e.feeUsd || 0) + feeUsd),
    pnlUsd: r2(proceeds - (e.costUsd || 0)), returnPct: e.costUsd ? r2((proceeds / e.costUsd - 1) * 100) : null,
    paramsHash: e.paramsHash === order.paramsHash ? order.paramsHash : null, entryParamsHash: e.paramsHash || null, exitParamsHash: order.paramsHash,
    priceSource: { entry: e.priceSource || null, exit: priceSource }, late: { entry: !!e.late, exit: late }, closedAt: now,executionEvidence:e.executionEvidence===true&&!!quoteEvidence,quoteEvidence:{entry:e.quoteEvidence||null,exit:quoteEvidence},entryDecisionAt:e.quoteEvidence?.decisionAt??null,exitDecisionAt:order.decidedAt,
  };
  const f = { at: now, day: order.fillDay, decidedForDay: order.decidedForDay, symbol: order.symbol, side: 'sell', qty: sl.qty, refPrice: price, fillPrice: r4(fillPrice), notionalUsd: r2(gross), feeUsd: r2(feeUsd), priceSource, late, paramsHash: order.paramsHash };
  sl.cashUsd = r2(sl.cashUsd + proceeds); sl.qty = 0; sl.entry = null;
  book.history = [trade, ...book.history];
  Object.assign(f,{quoteEvidence,executionEvidence:!!quoteEvidence,decisionAt:order.decidedAt,filledAt:now});book.fills = [f, ...book.fills];
  return f;
}
export function observedDailyQuote(q,symbol,{now,eligibleAt=0,side=null,quantity=null}={}){
  if(!q||q.symbol!==symbol||q.supported!==true||!/^(robinhood(?:-[\w.-]+)?|v[12])$/i.test(String(q.source||'')))return {ok:false,reason:'SUPPORTED_ROBINHOOD_QUOTE_REQUIRED'};
  if(!(q.bid>0)||!(q.ask>=q.bid)||!Number.isFinite(q.at)||q.at>now||now-q.at>30000||q.at<eligibleAt)return {ok:false,reason:'POST_DECISION_FRESH_QUOTE_REQUIRED'};
  if(q.feeRatio!==undefined&&q.feeRatio!==null&&(!Number.isFinite(Number(q.feeRatio))||Number(q.feeRatio)<0||Number(q.feeRatio)>=.25))return {ok:false,reason:'OBSERVED_FEE_UNSUPPORTED'};
  if(side&&quantity!==null){const available=Number(q.executableQuantity??(side==='buy'?q.askSize:q.bidSize));if(!(available>=quantity))return {ok:false,reason:'EXACT_SIZE_EXECUTION_EVIDENCE_REQUIRED'}}
  return {ok:true,reason:null};
}
// Existing forward intents retry on current quotes at any hour. Exits never expire.
// Candle opens are permitted only in the explicitly unqualified research shadow.
async function fillPending(book, store, { now, fee, quoteFn, quoteWindowMs,shadow=false,executionClock=null }) {
  const out = [], keep = [];
  for (const order of book.pending) {
    const openMs = dayStart(order.fillDay);
    if (now < openMs) { keep.push(order); continue; }
    const inWindow = now - openMs <= quoteWindowMs;
    let price = null, priceSource = null;
    if(!shadow&&order.side==='buy'&&(now-order.decidedAt>DAY||order.paramsHash!==book.source?.paramsHash)){event(book,now,`CANCELLED ${order.symbol} stale forward entry intent`);continue}
    const eligibleAt=order.eligibleAt??order.decidedAt+DAILY_DEFAULTS.processingLatencyMs;
    let q=null;try{q=typeof quoteFn==='function'?await quoteFn(order.symbol,{side:order.side,quantity:order.side==='sell'?book.sleeves[order.symbol].qty:null,budgetUsd:book.sleeves[order.symbol].cashUsd,decidedAt:order.decidedAt,eligibleAt}):null}catch(e){order.waitReason=e.code||'QUOTE_UNAVAILABLE'}
    if(executionClock)now=executionClock();
    const actualFee=Math.max(fee,feeFrom(q?.feeRatio)),sl=book.sleeves[order.symbol],quantity=order.side==='buy'&&q?.ask>0?sl.cashUsd*(1-actualFee)/(q.ask*(1+book.slipBps/1e4)):sl.qty;
    const valid=observedDailyQuote(q,order.symbol,{now,eligibleAt,side:order.side,quantity});
    let evidence=null;
    if(valid.ok){price=order.side==='buy'?q.ask:q.bid;priceSource=`robinhood-quote:${q.source}`;evidence={symbol:q.symbol,source:q.source,quoteAt:q.at,decisionAt:order.decidedAt,eligibleAt,quantity,feeRatio:actualFee,quantityStep:q.quantityStep||null,availableQuantity:Number(q.executableQuantity??(order.side==='buy'?q.askSize:q.bidSize)),executionModel:q.executionModel||'observed-depth-plus-slippage.v1'};delete order.waitReason}
    else if(shadow){
      const o = openOf(store, order.symbol, order.fillDay);
      if (o > 0) { price = o; priceSource = 'coinbase-open'; }
    }else{order.waitReason=order.waitReason||valid.reason;keep.push(order);continue}
    if (!price) { keep.push(order); continue; }
    const f = fillOne(book, order, { price, priceSource, late:shadow?!inWindow:false, fee:evidence?actualFee:fee, now,quoteEvidence:evidence });
    if (f) out.push(f);
  }
  book.pending = keep;
  return out;
}
function closeOf(store, symbol, day) { return (store.bars[symbol] || []).find(b => b.d === day)?.c ?? null; }
function markDay(book, store, day, fee) {
  if (book.equityDaily.at(-1)?.d >= day) return false;
  const closes = Object.fromEntries(book.symbols.map(s => [s, closeOf(store, s, day)]));
  if (book.symbols.some(s => !(closes[s] > 0))) return false;
  const slip = book.slipBps / 1e4;
  if (!book.bench) {
    // Buy-and-hold baseline: the same equal sleeves bought at this close with the same entry costs.
    const alloc = book.startUsd / book.symbols.length;
    book.bench = { startDay: day, qty: Object.fromEntries(book.symbols.map(s => [s, alloc * (1 - fee) / (closes[s] * (1 + slip))])), note: 'equal sleeves bought at the first marked close with the same fee and slippage' };
  }
  let eq = 0, bench = 0;
  for (const s of book.symbols) { const sl = book.sleeves[s]; eq += sl.cashUsd + sl.qty * closes[s]; bench += (book.bench.qty[s] || 0) * closes[s]; }
  book.equityDaily.push({ d: day, equityUsd: r2(eq), benchUsd: r2(bench), cashUsd: book.startUsd, paramsHash: book.source?.paramsHash || null,executionEvidence:false,valuationSource:'COINBASE_DAILY_RESEARCH_PROXY' });
  return true;
}
async function markForwardDay(book,day,{quoteFn,now,fee,executionClock=null}){
 if(book.equityDaily.at(-1)?.d>=day)return false;
 const observed={};
 for(const symbol of book.symbols){let q=null;try{q=typeof quoteFn==='function'?await quoteFn(symbol,{side:'sell',quantity:Math.max(book.sleeves[symbol].qty,book.executionBench?.qty?.[symbol]||0),budgetUsd:book.startUsd/book.symbols.length,valuation:true,eligibleAt:now-30000}):null}catch{}
  if(executionClock)now=executionClock();
  if(!observedDailyQuote(q,symbol,{now,eligibleAt:now-30000}).ok)return false;observed[symbol]=q}
 const slip=book.slipBps/1e4,alloc=book.startUsd/book.symbols.length;
 if(!book.executionBench){const quantity={},fees={};let residual=0;for(const s of book.symbols){const q=observed[s],actualFee=Math.max(fee,feeFrom(q.feeRatio)),step=Number(q.quantityStep)||.000001,qty=Math.floor(alloc*(1-actualFee)/(q.ask*(1+slip))/step)*step;if(!(Number(q.executableQuantity??q.askSize)>=qty))return false;quantity[s]=qty;fees[s]=actualFee;residual+=alloc-qty*q.ask*(1+slip)/(1-actualFee)}book.executionBench={startAt:now,qty:quantity,cashUsd:residual,source:'SUPPORTED_ROBINHOOD_OBSERVED_QUOTES',feeRatio:fee,feesBySymbol:fees}}
 let equity=0,baseline=book.executionBench.cashUsd||0;const evidence=[];
 for(const s of book.symbols){const q=observed[s],sl=book.sleeves[s],required=Math.max(sl.qty,book.executionBench.qty[s]||0);
  if(!(Number(q.executableQuantity??q.bidSize)>=required))return false;
  const actualFee=Math.max(fee,feeFrom(q.feeRatio)),bidNet=q.bid*(1-slip)*(1-actualFee);sl.observedMark={at:q.at,valueUsd:sl.qty*bidNet,quantity:sl.qty,source:q.source,feeRatio:actualFee};equity+=sl.cashUsd+sl.qty*bidNet;baseline+=(book.executionBench.qty[s]||0)*bidNet;evidence.push({symbol:s,quoteAt:q.at,source:q.source,feeRatio:actualFee,availableQuantity:Number(q.executableQuantity??q.bidSize)})}
 book.equityDaily.push({d:day,equityUsd:r2(equity),benchUsd:r2(baseline),cashUsd:Object.values(book.sleeves).reduce((sum,s)=>sum+s.cashUsd,0),paramsHash:book.source?.paramsHash||null,executionEvidence:true,valuationAt:now,valuationSource:'ROBINHOOD_EXECUTABLE_QUOTES',quoteEvidence:evidence});return true;
}

function feeFrom(feeRatio) { const f = Number(feeRatio); return Math.max(DAILY_DEFAULTS.feeFloor, Number.isFinite(f) && f >= 0 && f < 0.25 ? f : 0); }
function envNum(env, key, d) { const n = Number(env?.[key]); return Number.isFinite(n) && n > 0 ? n : d; }

// One pass: refresh bars, fill what is due, mark the closed day, decide it once, and fill at the open if possible.
export async function runDailyOnce({ dataDir, now, clock = () => Date.now(), env = process.env, fetchFn = globalThis.fetch, quoteFn = null, feeRatio = null, labDaily, shadowPick = null } = {}) {
  const realtime = now === undefined;
  now ??= clock();
  const startUsd = envNum(env, 'ROBINHOOD_DAILY_START_USD', DAILY_DEFAULTS.startUsd);
  const slipBps = Number.isFinite(Number(env?.ROBINHOOD_DAILY_SLIP_BPS)) && env.ROBINHOOD_DAILY_SLIP_BPS !== '' ? Math.min(100, Math.max(0, Number(env.ROBINHOOD_DAILY_SLIP_BPS))) : DAILY_DEFAULTS.slipBps;
  const fee = feeFrom(feeRatio), quoteWindowMs = envNum(env, 'ROBINHOOD_DAILY_QUOTE_WINDOW_MIN', DAILY_DEFAULTS.quoteWindowMin) * 60_000;
  const symbols = String(env?.ROBINHOOD_DAILY_SYMBOLS || '').split(',').map(x => x.trim().toUpperCase()).filter(x => SYMBOL_RE.test(x));
  const book = loadDailyBook(dataDir, { startUsd, slipBps, now, ...(symbols.length ? { symbols } : {}) });
  if (book.recoveryRequired) return { book, events: ['RECOVERY'] };
  const events = [];
  // Strategy source: re-read the Lab record every pass. A switch applies from the next decision on.
  const pick = shadowPick && path.basename(dataDir)==='daily-shadow' ? shadowPick : pickDailyStrategy(labDaily === undefined ? readLabDaily(dataDir) : labDaily);
  if (!book.source || book.source.paramsHash !== pick.paramsHash || book.source.kind !== pick.kind) {
    event(book, now, book.source ? `strategy ${book.source.id} -> ${pick.id} (${pick.kind})` : `started on ${pick.id} (${pick.kind})`);
    events.push(`SOURCE ${pick.kind} ${pick.id}`);
  }
  book.source = { kind: pick.kind, label: pick.label, id: pick.id, family: pick.family, params: pick.params, paramsHash: pick.paramsHash, state: pick.state, reasons: pick.reasons, since: book.source?.paramsHash === pick.paramsHash ? book.source.since : now };
  const shadow=path.basename(dataDir)==='daily-shadow'&&book.source.kind==='walk-forward-shadow';
  book.executionPolicy=shadow?'HISTORICAL_PROXY_RESEARCH_ONLY':'PROSPECTIVE_ROBINHOOD_QUOTES_ONLY';
  const { store } = await refreshDailyBars(dataDir, book.symbols, { now, fetchFn });
  if (realtime) now = clock();
  // 1) Orders due at an open that has already passed (decided earlier, not yet filled).
  for (const f of await fillPending(book, store, { now, fee, quoteFn, quoteWindowMs,shadow,executionClock:realtime?clock:null })) events.push(`FILLED ${f.side} ${f.symbol} ${f.day} @ ${f.priceSource}${f.late ? ' (late)' : ''}`);
  if(realtime)now=clock();
  // 2) Mark and decide the newest closed day, once.
  const D = lastClosedDay(now);
  const ready = book.symbols.every(s => store.bars[s]?.at(-1)?.d === D);
  if (!ready) events.push('WAITING_FOR_BARS');
  else {
    if(shadow)markDay(book,store,D,fee);else if(!await markForwardDay(book,D,{quoteFn,now,fee,executionClock:realtime?clock:null}))events.push('WAITING_FOR_EXECUTABLE_VALUATION');
    if(realtime)now=clock();
    if (!book.lastDecidedDay || D > book.lastDecidedDay) {
      if (book.lastDecidedDay) book.missedDays += Math.max(0, Math.round((dayStart(D) - dayStart(book.lastDecidedDay)) / DAY) - 1);
      const bySymbol = {};
      for (const s of book.symbols) {
        const bars = store.bars[s], i = bars.length - 1, sl = book.sleeves[s], holding = sl.qty > 0;
        if (book.pending.some(o => o.symbol === s)) { bySymbol[s] = { action: 'SKIP', reason: 'an earlier order is still unfilled' }; continue; }
        if (bars.length < warmupDays(pick.family, pick.params)) { bySymbol[s] = { action: 'WARMUP', reason: `${bars.length}/${warmupDays(pick.family, pick.params)} daily bars` }; continue; }
        const want = dailySignal(pick.family, pick.params, bars, i, holding);
        if (want === null || want === holding) { bySymbol[s] = { action: 'HOLD', long: holding, close: bars[i].c }; continue; }
        const side = want ? 'buy' : 'sell';
        book.pending.push({ symbol: s, side, decidedForDay: D, fillDay: addDays(D, 1), decidedAt: now,eligibleAt:now+DAILY_DEFAULTS.processingLatencyMs,paramsHash: pick.paramsHash, family: pick.family });
        bySymbol[s] = { action: side.toUpperCase(), close: bars[i].c };
        events.push(`DECIDED ${side} ${s} for the ${addDays(D, 1)} open`);
      }
      book.lastDecidedDay = D;
      book.lastDecision = { day: D, at: now, paramsHash: pick.paramsHash, family: pick.family, bySymbol };
      // Persist the decision before any fill, so a crash between the two never decides this bar again.
      saveDailyBook(dataDir, book);
      for (const f of await fillPending(book, store, { now, fee, quoteFn, quoteWindowMs,shadow,executionClock:realtime?clock:null })) events.push(`FILLED ${f.side} ${f.symbol} ${f.day} @ ${f.priceSource}${f.late ? ' (late)' : ''}`);
    }
  }
  book.feeRatio = fee;
  saveDailyBook(dataDir, book);
  return { book, store, events };
}

// ---------------------------------------------------------------- qualification (paper evidence only)
function maxDrawdownPct(values) { let peak = -Infinity, mdd = 0; for (const v of values) { peak = Math.max(peak, v); if (peak > 0) mdd = Math.max(mdd, 1 - v / peak); } return r2(mdd * 100); }
export function dailyQualification(book, { rules = DAILY_QUALIFICATION } = {}) {
  if(book.source?.kind==='walk-forward-shadow')return {qualified:false,countsTowardQualification:false,reasons:['SHADOW: never counts toward qualification']};
  const hash = book.source?.paramsHash || null, marks = [];
  // The contiguous tail of marks under the current parameters, cut to the window.
  for (let i = book.equityDaily.length - 1; i >= 0; i--) { const m = book.equityDaily[i]; if (m.paramsHash !== hash) break; marks.unshift(m); }
  const last = marks.at(-1)?.d || null, from = last ? addDays(last, -rules.windowDays) : null, win = marks.filter(m => m.d >= from);
  const runDays = win.length > 1 ? Math.round((dayStart(win.at(-1).d) - dayStart(win[0].d)) / DAY) : 0;
  const trades = book.history.filter(t => t.paramsHash === hash && t.exitDay >= (win[0]?.d || '9999'));
  const gw = trades.filter(t => t.pnlUsd > 0).reduce((a, t) => a + t.pnlUsd, 0), gl = -trades.filter(t => t.pnlUsd <= 0).reduce((a, t) => a + t.pnlUsd, 0);
  const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : null;
  const bookRet = win.length > 1 ? (win.at(-1).equityUsd / win[0].equityUsd - 1) * 100 : null;
  const benchRet = win.length > 1 ? (win.at(-1).benchUsd / win[0].benchUsd - 1) * 100 : null;
  const bookDd = maxDrawdownPct(win.map(m => m.equityUsd)), benchDd = maxDrawdownPct(win.map(m => m.benchUsd));
  const gates = {
    runDays: runDays >= rules.minRunDays,
    closedTrades: trades.length >= rules.minClosedTrades,
    beatsCash: bookRet !== null && bookRet > 0,
    beatsBuyHold: bookRet !== null && benchRet !== null && bookRet > benchRet,
    drawdownVsBuyHold: win.length > 1 && bookDd <= benchDd,
    profitFactor: pf !== null && pf >= rules.minProfitFactor,
    observedExecution: trades.length > 0 && trades.every(t => t.executionEvidence===true&&t.quoteEvidence?.entry&&t.quoteEvidence?.exit&&!t.late?.entry && !t.late?.exit
      && String(t.priceSource?.entry || '').startsWith('robinhood-quote') && String(t.priceSource?.exit || '').startsWith('robinhood-quote')),
    observedValuation:win.length>0&&win.every(m=>m.executionEvidence===true&&m.valuationSource==='ROBINHOOD_EXECUTABLE_QUOTES'),
  };
  const reasons = [];
  if (!gates.runDays) reasons.push(`${runDays} of ${rules.minRunDays} paper days under ${hash || 'these params'}`);
  if (!gates.closedTrades) reasons.push(`${trades.length} of ${rules.minClosedTrades} closed round trips in the ${rules.windowDays}-day window`);
  if (!gates.beatsCash) reasons.push(`return ${bookRet === null ? '--' : r2(bookRet) + '%'} does not beat cash (0%)`);
  if (!gates.beatsBuyHold) reasons.push(`return ${bookRet === null ? '--' : r2(bookRet) + '%'} does not beat buy-and-hold ${benchRet === null ? '--' : r2(benchRet) + '%'}`);
  if (!gates.drawdownVsBuyHold) reasons.push(`drawdown ${bookDd}% is deeper than buy-and-hold ${benchDd}%`);
  if (!gates.profitFactor) reasons.push(`profit factor ${pf === null ? '--' : pf === Infinity ? 'inf' : r2(pf)} < ${rules.minProfitFactor}`);
  if (!gates.observedExecution) reasons.push('qualification requires prospectively observed entry and exit quotes; candle-open or late fills are diagnostic only');
  if(!gates.observedValuation)reasons.push('qualification requires executable Robinhood portfolio and baseline valuations; existing daily-candle proxies remain research evidence');
  return {
    qualified: Object.values(gates).every(Boolean), gates, reasons, rules: { ...rules },
    metrics: { paramsHash: hash, from: win[0]?.d || null, to: last, runDays, closedTrades: trades.length, returnPct: bookRet === null ? null : r2(bookRet), buyHoldReturnPct: benchRet === null ? null : r2(benchRet), maxDrawdownPct: bookDd, buyHoldMaxDrawdownPct: benchDd, profitFactor: pf === Infinity ? 'infinity' : pf === null ? null : r2(pf) },
    liveEligible: false, note: 'Paper evidence only. Qualification never unlocks live execution.',
  };
}

// ---------------------------------------------------------------- snapshot, loop
// Compact verdict of the Lab's daily research, for the HUD.
export function labDailyVerdict(daily) {
  if (!daily) return null;
  const l = daily.leader || null, h = l?.holdout || null;
  return {
    phase: daily.phase || null, computedAt: daily.computedAt || null, leader: l ? { id: l.id, family: l.family, params: l.params, paramsHash: l.paramsHash } : null,
    holdout: h ? { returnPct: h.strategy?.totalReturnPct ?? null, buyHoldReturnPct: h.buyHold?.totalReturnPct ?? null, sharpe: h.strategy?.sharpe ?? null, buyHoldSharpe: h.buyHold?.sharpe ?? null, trades: h.trades ?? null } : null,
    proposal: daily.proposal ? { id: daily.proposal.id, family: daily.proposal.family, paramsHash: daily.proposal.paramsHash, traderExecutable: daily.proposal.traderExecutable === true } : null,
    blockers: Array.isArray(daily.blockers) ? daily.blockers.slice(0, 4) : [], paperPromotionAllowed: daily.paperPromotionAllowed === true,
  };
}
let state = { running: false, lastRunAt: null, lastError: null, busy: false, lastEvents: [] }, timer = null, firstRun = null;
export function dailySnapshot({ dataDir, now = Date.now(), labDaily, includeShadow = true } = {}) {
  const book = loadDailyBook(dataDir), store = readDailyBars(dataDir), lab = labDaily === undefined ? readLabDaily(dataDir) : labDaily;
  const pick = book.source?.kind==='walk-forward-shadow' ? book.source : pickDailyStrategy(lab), last = book.equityDaily.at(-1) || null;
  const positions = Object.entries(book.sleeves || {}).map(([symbol, sl]) => {
    const close = store.bars[symbol]?.at(-1)?.c ?? null;
    const shadow=book.source?.kind==='walk-forward-shadow',mark=sl.observedMark,observed=mark&&mark.quantity===sl.qty&&mark.at<=now&&now-mark.at<=30000;
    const exposure=sl.qty===0?0:shadow&&close?sl.qty*close:observed?mark.valueUsd:null;
    return { symbol, long: sl.qty > 0, qty: sl.qty, cashUsd: sl.cashUsd, entry: sl.entry, lastClose: close, valueUsd:exposure===null?null:r2(sl.cashUsd+exposure),unrealizedUsd:sl.qty>0&&exposure!==null?r2(exposure-(sl.entry?.costUsd||0)):null,valuationSource:shadow?'RESEARCH_CANDLE_PROXY':observed?'ROBINHOOD_EXECUTABLE_QUOTES':'AWAITING_EXECUTABLE_QUOTE',markAt:observed?mark.at:null };
  });
  return {
    at: now, execution: 'paper-only', liveEligible: false, challengerAdapters: challengerCapabilities(), label: (book.source || pick).label, source: book.source || { ...pick, since: null },
    nextSource: book.source && book.source.paramsHash !== pick.paramsHash ? { kind: pick.kind, id: pick.id, reasons: pick.reasons } : null,
    lab: labDailyVerdict(lab),
    book: {
      startUsd: book.startUsd, equityUsd: last?.equityUsd ?? book.startUsd, returnPct: last ? r2((last.equityUsd / book.startUsd - 1) * 100) : 0,
      buyHoldUsd: last?.benchUsd ?? null, buyHoldReturnPct: last?.benchUsd ? r2((last.benchUsd / book.startUsd - 1) * 100) : null,
      positions, pending: book.pending, lastDecidedDay: book.lastDecidedDay, lastDecision: book.lastDecision, missedDays: book.missedDays,
      history: book.history.slice(0, 12), fills: book.fills.slice(0, 12), equityDaily: book.equityDaily.slice(-400), events: (book.events || []).slice(0, 10),
      costs: { feeRatio: book.feeRatio ?? DAILY_DEFAULTS.feeFloor, feeFloor: DAILY_DEFAULTS.feeFloor, slipBps: book.slipBps, note: 'fee max(0.95%, account fee) per side plus slippage on both sides' },
      recoveryRequired: !!book.recoveryRequired, recoveryReason: book.recoveryReason || null,
    },
    qualification: book.source?.kind==='walk-forward-shadow' ? {qualified:false,reasons:['SHADOW: never counts toward qualification'],countsTowardQualification:false} : dailyQualification(book),
    ...(includeShadow && path.basename(dataDir)!=='daily-shadow' ? {shadow:fs.existsSync(bookFile(path.join(dataDir,'daily-shadow'))) ? dailySnapshot({dataDir:path.join(dataDir,'daily-shadow'),now,labDaily:lab,includeShadow:false}) : null} : {}),
    data: { source: 'Coinbase public daily candles (UTC days)', lastClosedDay: lastClosedDay(now), latestBar: (ds => ds.length && ds.every(Boolean) ? ds.reduce((a, b) => a < b ? a : b) : null)(book.symbols.map(s => store.bars[s]?.at(-1)?.d || null)), fetchedAt: store.fetchedAt, lastError: store.lastError },
    rules: 'One decision per closed UTC bar; forward fills require fresh supported Robinhood quotes after decision plus processing latency and size evidence. Missing quotes retain exit intents. Historical candle opens belong only to the unqualified research shadow. Missed days are not decided retrospectively.',
    loop: { running: state.running, lastRunAt: state.lastRunAt, lastEvents: state.lastEvents }, lastError: state.lastError,
  };
}
export function resetDailyBook({ dataDir, confirmation, now = Date.now(), env = process.env } = {}) {
  if (confirmation !== 'RESET DAILY') { const e = new Error('Type RESET DAILY to confirm'); e.code = 'confirmation'; throw e; }
  const book = newDailyBook({ startUsd: envNum(env, 'ROBINHOOD_DAILY_START_USD', DAILY_DEFAULTS.startUsd), now });
  if(fs.existsSync(bookFile(dataDir))){const archive=path.join(dataDir,'robinhood-daily-archives',`${now}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);fs.mkdirSync(path.dirname(archive),{recursive:true});fs.copyFileSync(bookFile(dataDir),archive,fs.constants.COPYFILE_EXCL);book.previousEvidenceArchive=archive}
  event(book, now, 'daily paper book reset');
  writeJsonAtomic(bookFile(dataDir), book);
  return dailySnapshot({ dataDir, now });
}
export async function runDailyTick(opts) {
  if (state.busy) return { ran: false, reason: 'busy' };
  state.busy = true;
  try { const feeRatio=typeof opts.feeFn==='function'?opts.feeFn():opts.feeRatio;
    const r = await runDailyOnce({ ...opts, feeRatio });
    const daily=opts.labDaily===undefined?readLabDaily(opts.dataDir):opts.labDaily;
    const t=opts.now??Date.now(),stamp=daily?.computedAt??daily?.at;
    const current=Number.isFinite(stamp)&&stamp<=t&&t-stamp<=48*3600e3&&daily.liveActivationAllowed!==true?daily.leader:null;
    const previous=loadDailyBook(path.join(opts.dataDir,'daily-shadow')).source;
    const leader=current || (previous?.kind==='walk-forward-shadow'?previous:null);
    let shadowEvents=[];
    if(leader&&validateDailyParams(leader.family,leader.params).ok){
      const dataDir=path.join(opts.dataDir,'daily-shadow');
      writeJsonAtomic(barsFile(dataDir),readDailyBars(opts.dataDir));
      const shadowPick={kind:'walk-forward-shadow',label:'WALK-FORWARD SHADOW · NOT QUALIFIED',id:String(leader.id||'walk-forward'),family:leader.family,params:{...leader.params},paramsHash:dailyParamsHash(leader.family,leader.params),state:'RESEARCH',reasons:['diagnostic forward record only']};
      const shadow=await runDailyOnce({...opts,dataDir,feeRatio,shadowPick,env:{...(opts.env||process.env),ROBINHOOD_DAILY_START_USD:25},fetchFn:async()=>{throw Error('shadow waits for shared daily cache')}});
      shadowEvents=shadow.events;
    }
    state.lastError = null; state.lastEvents = r.events; return { ran: true, events: r.events, shadowEvents }; }
  catch (e) { state.lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 200) }; return { ran: false, reason: 'error', error: state.lastError.message }; }
  finally { state.lastRunAt = Date.now(); state.busy = false; }
}
function dailyDisabled(env = process.env) { return String(env.ROBINHOOD_DAILY_ENABLED ?? 'true').toLowerCase() === 'false'; }
export function startDailyLoop({ dataDir, quoteFn = null, feeFn = null, tickMs = 5 * 60_000, firstRunMs = 20_000, env = process.env } = {}) {
  if (timer || dailyDisabled(env)) return false;
  state.running = true;
  const run = () => runDailyTick({ dataDir, quoteFn, feeFn }).catch(() => {});
  timer = setInterval(run, Math.max(60_000, tickMs)); timer.unref?.();
  firstRun = setTimeout(run, firstRunMs); firstRun.unref?.();
  return true;
}
export function stopDailyLoop() { if (timer) clearInterval(timer); if (firstRun) clearTimeout(firstRun); timer = null; firstRun = null; state.running = false; }
export const __testing = { reset() { stopDailyLoop(); state = { running: false, lastRunAt: null, lastError: null, busy: false, lastEvents: [] }; }, dayKey, addDays };
