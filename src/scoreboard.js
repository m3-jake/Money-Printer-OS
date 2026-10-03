// One scoreboard across every module: is each paper book working, after fees, against its own baseline?
//
// Pure part (buildScoreboard and the row builders) takes snapshots each module already produces and
// only summarises them. It never recomputes a fill, a fee or a mark: every P/L figure here is a number
// the owning module already recorded (Pump.fun pnlSol, Robinhood pnlUsd, equities equityDaily, Polymarket
// shadow pnlUsd, the core ledger's realized P/L). readScoreboard() is the thin impure layer that reads
// those snapshots from the running engine, with no network calls and no writes.
//
// Columns per row: net P/L after fees, closes, hit rate, profit factor, net per trade, the module's own
// baseline (cash 0, do-nothing 0, buy-and-hold SPY, buy-and-hold coins), beats baseline (YES/NO only once
// n >= MIN_CLOSES, else NOT ENOUGH DATA), net without the single best trade, and data freshness.
export const SCOREBOARD_SCHEMA = 'mpo.scoreboard.v1';
// The repo's existing evidence gates all use 20 closes (evidenceFlags minCloses, Robinhood qualification,
// Polymarket MIN_SETTLED_PER_WINDOW), so the scoreboard uses the same bar.
export const MIN_CLOSES = 20;
export const VERDICT = Object.freeze({ YES: 'YES', NO: 'NO', NOT_ENOUGH: 'NOT ENOUGH DATA' });
// The best trade may carry at most half of a positive net before the row is flagged as outlier-driven.
export const OUTLIER_SHARE = 0.5;
const MIN = 60_000, HOUR = 3_600_000;

const finite = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v, dp = 6) => (v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 0 ? n : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// closes: [{ pnl, at }], pnl already net of every fee. Order does not matter.
export function closeStats(closes = []) {
  const rows = (Array.isArray(closes) ? closes : []).map(c => ({ pnl: finite(c?.pnl), at: toMs(c?.at) })).filter(c => c.pnl !== null);
  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  let net = 0, wins = 0, grossWin = 0, grossLoss = 0, best = null, cum = 0;
  const curve = [];
  for (const c of rows) {
    net += c.pnl; cum += c.pnl; curve.push(cum);
    if (c.pnl > 0) { wins++; grossWin += c.pnl; } else grossLoss += -c.pnl;
    if (!best || c.pnl > best.pnl) best = c;
  }
  const base=fromAggregate({ closes: rows.length, wins, grossWin, grossLoss, net, best: best ? best.pnl : null, bestAt: best?.at ?? null, lastCloseAt: rows.at(-1)?.at ?? null, curve });
  const losses=rows.filter(r=>r.pnl<0).length;
  return {...base,losses,breakevens:rows.length-wins-losses,averageLoss:losses?round(-grossLoss/losses):null};
}

// Same shape from totals a module already aggregated (the core ledger's closeStats).
export function fromAggregate({ closes = 0, wins = 0, grossWin = 0, grossLoss = 0, net = 0, best = null, bestAt = null, lastCloseAt = null, curve = [] } = {}) {
  const n = Math.max(0, Math.trunc(finite(closes) ?? 0));
  const w = finite(wins) ?? 0, gw = finite(grossWin) ?? 0, gl = finite(grossLoss) ?? 0, total = finite(net) ?? 0, b = n ? finite(best) : null;
  const withoutBest = b === null ? null : total - b;
  const bestShare = b !== null && total > 0 && b > 0 ? b / total : null;
  return {
    closes: n, wins: w, losses: n - w,
    averageWin: w ? round(gw / w) : null,
    averageLoss: n-w ? round(-gl / (n-w)) : null,
    realizedDrawdown: curve.length ? round((()=>{let peak=0,dd=0;for(const v of curve){peak=Math.max(peak,v);dd=Math.max(dd,peak-v);}return dd;})()) : null,
    measurementScope: 'Closed outcomes only; drawdown excludes unrealized intraperiod marks',
    hitRate: n ? round(w / n, 4) : null,
    profitFactor: !n ? null : gl > 0 ? round(gw / gl, 3) : gw > 0 ? 'infinity' : null,
    netPnl: round(total), netPerTrade: n ? round(total / n) : null,
    bestTrade: b === null ? null : { pnl: round(b), at: bestAt },
    netWithoutBest: withoutBest === null ? null : round(withoutBest),
    bestShareOfNet: bestShare === null ? null : round(bestShare, 4),
    outlier: b !== null && total > 0 && (bestShare > OUTLIER_SHARE || withoutBest <= 0),
    lastCloseAt, curve: sample(curve),
  };
}

function sample(xs, max = 60) {
  const a = (Array.isArray(xs) ? xs : []).map(finite).filter(v => v !== null);
  if (a.length <= max) return a.map(v => round(v));
  const out = [];
  for (let i = 0; i < max; i++) out.push(round(a[Math.round(i * (a.length - 1) / (max - 1))]));
  return out;
}

// FRESH / STALE / NO_DATA, or IDLE when the book is not running (parked profile, autopilot off).
export function freshness(at, { now = Date.now(), maxAgeMs = 10 * MIN, active = true, source = null } = {}) {
  const t = toMs(at);
  const ageMs = t === null ? null : Math.max(0, now - t);
  const status = !active ? 'IDLE' : t === null ? 'NO_DATA' : ageMs <= maxAgeMs ? 'FRESH' : 'STALE';
  return { status, at: t, ageMs, maxAgeMs, source };
}

// Beats baseline only when n is enough, and (fail closed) only when it still beats it without the best trade.
export function verdict(stats, baselineNet, { minCloses = MIN_CLOSES } = {}) {
  const n = stats?.closes ?? 0, base = finite(baselineNet), net = finite(stats?.netPnl);
  if (n < minCloses) return { beatsBaseline: VERDICT.NOT_ENOUGH, reason: `${n} of ${minCloses} closes` };
  if (base === null || net === null) return { beatsBaseline: VERDICT.NOT_ENOUGH, reason: 'baseline unavailable' };
  if (!(net > base)) return { beatsBaseline: VERDICT.NO, reason: 'net is not above the baseline' };
  const without = finite(stats.netWithoutBest);
  if (without !== null && !(without > base)) return { beatsBaseline: VERDICT.NO, reason: 'beats the baseline only because of its single best trade' };
  return { beatsBaseline: VERDICT.YES, reason: 'net above the baseline, also without the best trade' };
}

// One row. baseline: { kind, label, netPnl (same unit as the row, null if unknown), note }.
export function scoreRow({ id, module, book, unit, stats, baseline, fresh, minCloses = MIN_CLOSES, kind = 'paper', note = null, extra = {} }) {
  const v = verdict(stats, baseline?.netPnl, { minCloses });
  return {
    id, module, book, kind, mode: kind === 'lab' ? 'BACKTEST' : 'PAPER', unit,
    ...stats,
    baseline: { kind: baseline?.kind || 'cash', label: baseline?.label || 'Cash (0)', netPnl: baseline?.netPnl === null || baseline?.netPnl === undefined ? null : round(Number(baseline.netPnl)), note: baseline?.note || null },
    edgeVsBaseline: finite(stats.netPnl) === null || finite(baseline?.netPnl) === null ? null : round(stats.netPnl - Number(baseline.netPnl)),
    minCloses, ...v, freshness: fresh, note, ...extra,
  };
}

// ---------------------------------------------------------------- Pump.fun
// Closed paper trades in the engine state; pnlSol already carries both fees and both slippages.
// Book = the profile the position was opened under (older closes fall back to the exit preset).
const PUMP_BOOKS = [['FAIR', 'fair'], ['SPRINT', 'sprint']];
export function pumpfunRows(state = {}, { now = Date.now() } = {}) {
  const history = Array.isArray(state?.history) ? state.history : [];
  const current = String(state?.runtime?.profile || '').toUpperCase();
  const heartbeat = state?.system?.lastCycle ?? null;
  const bookOf = h => { const p = String(h?.profile || '').toUpperCase(); if (p) return p; const e = String(h?.exitPreset || '').toLowerCase(); return PUMP_BOOKS.find(([, preset]) => preset === e)?.[0] || 'OTHER'; };
  const baseline = { kind: 'do-nothing', label: 'Do nothing (0 SOL)', netPnl: 0, note: 'Not trading keeps the paper bank flat.' };
  const rows = [];
  const groups = new Map();
  for (const h of history) { const b = bookOf(h); if (!groups.has(b)) groups.set(b, []); groups.get(b).push({ pnl: h.pnlSol, at: h.closedAt }); }
  for (const [book] of PUMP_BOOKS) {
    const stats = closeStats(groups.get(book) || []), active = current === book;
    rows.push(scoreRow({ id: `pumpfun-${book.toLowerCase()}`, module: 'Pump.fun', book: `${book} paper`, unit: 'SOL', stats, baseline,
      fresh: freshness(active ? heartbeat : stats.lastCloseAt, { now, maxAgeMs: 5 * MIN, active, source: active ? 'engine heartbeat' : 'last close (profile not active)' }),
      extra: { active } }));
  }
  const other = groups.get('OTHER') || [];
  for (const [book, closes] of groups) {
    if (book === 'OTHER' || PUMP_BOOKS.some(([b]) => b === book)) continue;
    other.push(...closes);
  }
  if (other.length) {
    const stats = closeStats(other);
    rows.push(scoreRow({ id: 'pumpfun-other', module: 'Pump.fun', book: 'Other profiles', unit: 'SOL', stats, baseline,
      fresh: freshness(stats.lastCloseAt, { now, maxAgeMs: 5 * MIN, active: !PUMP_BOOKS.some(([b]) => b === current), source: 'last close' }),
      note: 'Closes opened under any profile other than FAIR or SPRINT.' }));
  }
  return rows;
}

export function pumpfunCopyRow(book = {}, { now = Date.now() } = {}) {
  const stats = closeStats((book?.history || []).map(p => ({ pnl: p.pnlSol, at: p.closedAt })));
  return scoreRow({ id: 'pumpfun-copy', module: 'Pump.fun', book: 'Scored-wallet copy paper', unit: 'SOL', stats,
    baseline: { kind: 'cash', label: 'Cash (0 SOL)', netPnl: 0, note: 'Separate $25 paper bank, converted with observed SOL FX when funded.' },
    fresh: freshness(book?.lastRunAt, { now, maxAgeMs: 5 * MIN, source: 'copy book maintenance' }),
    note: book?.status === 'WAITING_FOR_WALLET_EVIDENCE' ? 'Waiting for prior profitable wallet round trips, also profitable without their best trade.'
      : book?.status === 'WAITING_FOR_SOL_PRICE' ? 'Waiting for a fresh observed SOL/USD price to fund the separate $25 paper bank.'
        : 'Exact-size native/Jupiter quote fills, after modeled slippage and network fees; missing exits stay open.',
    extra: { open: book?.open?.length || 0, status: book?.status || 'WAITING_FOR_WALLET_EVIDENCE' } });
}

// ---------------------------------------------------------------- Robinhood crypto
// Buy-and-hold baseline: the book's starting bank split equally across the coins it traded, bought at the
// first traded window's start and marked at the latest tape mid, after one buy and one sell fee.
// prices: { [symbol]: { from, to } } (mids). Any missing symbol makes the baseline unavailable.
export function cryptoHoldBaseline({ startUsd, feeRatio = 0, symbols = [], prices = {}, from = null } = {}) {
  const bank = finite(startUsd), f = Math.max(0, finite(feeRatio) ?? 0);
  const syms = [...new Set(symbols)].filter(Boolean);
  const label = `Buy and hold ${syms.length ? syms.join(' + ') : 'the traded coins'}`;
  if (!(bank > 0) || !syms.length) return { kind: 'buy-and-hold', label, netPnl: null, note: 'No closes yet, so there is no window to compare against.' };
  const rets = [];
  for (const s of syms) { const p = prices?.[s], a = finite(p?.from), b = finite(p?.to); if (!(a > 0) || !(b > 0)) return { kind: 'buy-and-hold', label, netPnl: null, note: `No tape price for ${s} over the window.` }; rets.push(b / a - 1); }
  const avg = rets.reduce((x, y) => x + y, 0) / rets.length;
  return { kind: 'buy-and-hold', label, netPnl: round(bank * ((1 - f) * (1 + avg) * (1 - f) - 1)), returnPct: round(avg * 100, 3), from: toMs(from),
    note: `Starting bank $${bank} held equally in ${syms.join(', ')} since the first traded window, after a ${round(f * 100, 3)}% fee each way.` };
}

function cryptoBookRow({ id, book, closes, startUsd, feeRatio, holdPrices, fresh, note, extra }) {
  const stats = closeStats(closes.map(c => ({ pnl: c.pnlUsd, at: c.closedAt ?? c.exit?.at ?? c.at })));
  const symbols = [...new Set(closes.map(c => c.symbol).filter(Boolean))];
  const from = closes.reduce((m, c) => { const t = toMs(c.openedAt ?? c.at); return t !== null && (m === null || t < m) ? t : m; }, null);
  const baseline = cryptoHoldBaseline({ startUsd, feeRatio, symbols, prices: holdPrices?.[id] || {}, from });
  return scoreRow({ id, module: 'Robinhood crypto', book, unit: 'USD', stats, baseline, fresh, note, extra });
}
// Which symbols and since when each crypto book needs a hold price for (readScoreboard fills the prices).
export function cryptoHoldWindows({ strict, explore, practice } = {}) {
  const out = {};
  for (const [id, b] of [['robinhood-strategy', strict], ['robinhood-exploration', explore], ['robinhood-practice', practice]]) {
    const closes = closedCrypto(b);
    const from = closes.reduce((m, c) => { const t = toMs(c.openedAt ?? c.at); return t !== null && (m === null || t < m) ? t : m; }, null);
    if (from !== null) out[id] = { from, symbols: [...new Set(closes.map(c => c.symbol).filter(Boolean))] };
  }
  return out;
}
const closedCrypto = b => (Array.isArray(b?.history) ? b.history : []).filter(x => x?.status === 'CLOSED' && finite(x.pnlUsd) !== null);

// strict / explore: robinhoodJournal paper books. practice: robinhoodPractice book. tapeAt: last strict tape sample.
export function robinhoodCryptoRows({ strict = null, explore = null, practice = null, tapeAt = null, holdPrices = {} } = {}, { now = Date.now() } = {}) {
  const rows = [];
  const tapeFresh = active => freshness(tapeAt, { now, maxAgeMs: 5 * MIN, active, source: 'Robinhood quote tape' });
  if (strict) rows.push(cryptoBookRow({ id: 'robinhood-strategy', book: 'Strategy paper', closes: closedCrypto(strict), startUsd: strict.startUsd, feeRatio: strict.feeRatio, holdPrices,
    fresh: tapeFresh(!!strict.autopilot?.enabled), extra: { active: !!strict.autopilot?.enabled, recoveryRequired: !!strict.recoveryRequired } }));
  if (explore) rows.push(cryptoBookRow({ id: 'robinhood-exploration', book: 'Exploration paper', closes: closedCrypto(explore), startUsd: explore.startUsd, feeRatio: explore.feeRatio ?? strict?.feeRatio, holdPrices,
    fresh: tapeFresh(!!explore.autopilot?.enabled), note: 'Exploration (not a strategy): never counts toward qualification.', extra: { active: !!explore.autopilot?.enabled, recoveryRequired: !!explore.recoveryRequired } }));
  if (practice) {
    const s = practice.settings || {}, fee = ((finite(s.feeBps) ?? 0) + (finite(s.slippageBps) ?? 0)) / 10_000;
    rows.push(cryptoBookRow({ id: 'robinhood-practice', book: 'Practice paper', closes: closedCrypto(practice), startUsd: practice.startUsd, feeRatio: fee, holdPrices,
      fresh: freshness(practice.telemetry?.lastTickAt, { now, maxAgeMs: 5 * MIN, active: s.autopilot === true, source: 'practice loop tick' }),
      note: 'Isolated practice book: never counts toward qualification or Lab promotion.', extra: { active: s.autopilot === true, recoveryRequired: !!practice.recoveryRequired } }));
  }
  return rows;
}

// ---------------------------------------------------------------- Robinhood equities
// A daily rebalancing portfolio has no per-trade closes, so its unit of evidence is the marked session:
// net = marked equity - start (fills, slippage and sell fees are already in equity), a "win" is an up session.
export const EQUITY_MIN_SESSIONS = 20;
export function equitiesRow(snap = null, { now = Date.now() } = {}) {
  const b = snap?.book || {}, start = finite(b.startUsd);
  const daily = Array.isArray(b.equityDaily) ? b.equityDaily : [];
  const closes = [];
  // The snapshot keeps the last 260 marks; once it is truncated the first mark has no known previous equity.
  let prev = daily.length >= 260 ? null : start;
  for (const r of daily) { const e = finite(r?.equityUsd); if (e === null || prev === null) { prev = e; continue; } closes.push({ pnl: e - prev, at: Date.parse(r.d + 'T21:00:00Z') }); prev = e; }
  const stats = closeStats(closes);
  // Equity already includes open positions; the per-session diffs sum to (last equity - start) only over the
  // retained window, so the headline net comes from the book itself.
  if (start !== null && finite(b.equityUsd) !== null) { stats.netPnl = round(Number(b.equityUsd) - start); stats.netPerTrade = stats.closes ? round(stats.netPnl / stats.closes) : null; if (stats.bestTrade) { stats.netWithoutBest = round(stats.netPnl - stats.bestTrade.pnl); stats.bestShareOfNet = stats.netPnl > 0 && stats.bestTrade.pnl > 0 ? round(stats.bestTrade.pnl / stats.netPnl, 4) : null; stats.outlier = stats.netPnl > 0 && (stats.bestShareOfNet > OUTLIER_SHARE || stats.netWithoutBest <= 0); } }
  const live = snap?.benchmark?.live;
  const spy = finite(live?.buyHoldSpyUsd);
  const baseline = { kind: 'buy-and-hold-spy', label: 'Buy and hold SPY', netPnl: spy !== null && start !== null ? spy - start : null,
    note: live?.since ? `Same starting bank in SPY since ${live.since}. Cash (0%) is the other reference.` : 'Starts with the first marked session.' };
  const data = snap?.data || {};
  const status = data.status === 'FRESH' ? 'FRESH' : data.status === 'STALE' || data.status === 'ERROR' ? 'STALE' : 'NO_DATA';
  const fresh = { ...freshness(data.fetchedAt ?? snap?.loop?.lastRunAt, { now, maxAgeMs: 36 * HOUR, active: snap ? true : false, source: data.source || 'end-of-day bars' }), status: snap ? status : 'NO_DATA', latestBar: data.latestBar || null };
  return scoreRow({ id: 'robinhood-equities', module: 'Robinhood equities', book: `${snap?.strategy?.title || 'Stocks & ETFs'} paper`, unit: 'USD', stats, baseline, fresh,
    minCloses: EQUITY_MIN_SESSIONS, note: 'Counted per marked session (a rebalancing book has no per-trade closes).', extra: { per: 'session', recoveryRequired: !!b.recoveryRequired } });
}

// ---------------------------------------------------------------- Polymarket US shadow
// Settled shadow combos per strategy window; pnlUsd is priced at askProduct + measured markup, VOIDs are not closes.
export function polymarketRows(evidence = null, { now = Date.now() } = {}) {
  const shadow = evidence?.shadow && typeof evidence.shadow === 'object' ? evidence.shadow : {};
  const updated = evidence?.updatedAt || null;
  return Object.entries(shadow).map(([w, sh]) => {
    const settled = (Array.isArray(sh?.history) ? sh.history : []).filter(x => x?.status === 'WON' || x?.status === 'LOST');
    const stats = closeStats(settled.map(x => ({ pnl: x.pnlUsd, at: x.settledAt })));
    return scoreRow({ id: `polymarket-shadow-${w.toLowerCase()}`, module: 'Polymarket US', book: `Shadow combos · ${w}`, unit: 'USD', kind: 'shadow', stats,
      baseline: { kind: 'cash', label: 'Cash (0)', netPnl: 0, note: 'Not betting keeps the stake.' },
      fresh: freshness(updated, { now, maxAgeMs: 30 * MIN, source: 'evidence scan' }),
      note: 'Shadow only: priced at the ask product plus the measured markup; no order was sent.', extra: { open: Array.isArray(sh?.open) ? sh.open.length : 0 } });
  });
}

// ---------------------------------------------------------------- core platform ledger (Kalshi, global Polymarket)
// portfolio: UnifiedLedger.portfolio('PAPER'); lastEntryAt: the newest ledger row time. Per venue, USD accounts only.
export function platformRows(portfolio = null, { lastEntryAt = null, now = Date.now() } = {}) {
  const byVenue = new Map();
  for (const a of portfolio?.accounts || []) {
    if (a.currency !== 'USD') continue;
    const v = byVenue.get(a.venue) || { realized: 0, closes: 0, wins: 0, grossWin: 0, grossLoss: 0, best: null, bestAt: null, lastCloseAt: null, daily: {} };
    const cs = a.closeStats || {};
    v.realized += finite(a.realized) ?? 0; v.closes += finite(cs.closes) ?? 0; v.wins += finite(cs.wins) ?? 0;
    v.grossWin += finite(cs.grossWin) ?? 0; v.grossLoss += finite(cs.grossLoss) ?? 0;
    const b = finite(cs.best); if (b !== null && (v.best === null || b > v.best)) { v.best = b; v.bestAt = cs.bestAt ?? null; }
    const lc = toMs(cs.lastCloseAt); if (lc !== null && (v.lastCloseAt === null || lc > v.lastCloseAt)) v.lastCloseAt = lc;
    for (const [d, x] of Object.entries(a.daily || {})) v.daily[d] = (v.daily[d] || 0) + (finite(x) ?? 0);
    byVenue.set(a.venue, v);
  }
  if (!byVenue.size) byVenue.set('kalshi', null);
  return [...byVenue].map(([venue, v]) => {
    let cum = 0; const curve = Object.keys(v?.daily || {}).sort().map(d => (cum += v.daily[d]));
    const stats = fromAggregate(v ? { closes: v.closes, wins: v.wins, grossWin: v.grossWin, grossLoss: v.grossLoss, net: v.realized, best: v.best, bestAt: v.bestAt, lastCloseAt: v.lastCloseAt, curve } : {});
    return scoreRow({ id: `platform-${venue}`, module: venue === 'kalshi' ? 'Kalshi' : venue === 'polymarket' ? 'Polymarket (global)' : venue, book: 'Core ledger paper fills', unit: 'USD', stats,
      baseline: { kind: 'cash', label: 'Cash (0)', netPnl: 0, note: 'Unspent simulated funding stays as cash.' },
      fresh: freshness(lastEntryAt, { now, maxAgeMs: 7 * 24 * HOUR, active: !!v, source: 'last ledger entry' }),
      note: v ? 'Realized P/L from the core ledger; open contracts are at cost until they are sold or settle.' : 'No simulated funding recorded yet.' });
  });
}

// ---------------------------------------------------------------- Evolution Lab champions
// Not paper books: each row shows the champion's lifecycle state and its held-out research result.
// input per module: { state, declared, stage, updatedAt, n, value, unit, metric }
export function labRows(lab = {}, { now = Date.now() } = {}) {
  const names = { solana: 'Pump.fun (Solana)', robinhood: 'Robinhood crypto', 'polymarket-combo': 'Polymarket combos' };
  return Object.entries(names).map(([id, name]) => {
    const x = lab?.[id] || null, n = Math.max(0, Math.trunc(finite(x?.n) ?? 0)), value = finite(x?.value), per = finite(x?.perTrade);
    const stats = { ...fromAggregate({}), closes: n, netPnl: value, netPerTrade: per, hitRate: finite(x?.hitRate), profitFactor: x?.profitFactor ?? null };
    const row = scoreRow({ id: `lab-${id}`, module: 'Evolution Lab', book: `${name} champion`, kind: 'lab', unit: x?.unit || '', stats,
      baseline: { kind: 'cash', label: x?.baselineLabel || 'Cash (0)', netPnl: value === null && per === null ? null : 0, note: 'Held-out research result against doing nothing.' },
      fresh: freshness(x?.updatedAt, { now, maxAgeMs: 30 * MIN, active: !!x, source: 'Lab status' }),
      note: x ? `${x.metric || 'held-out result'} (research replay, not paper fills).` : 'No champion published.',
      extra: { state: x?.state || 'NONE', declaredState: x?.declared ?? null, stage: x?.stage || null } });
    // The Lab publishes totals, not trades: the verdict is the held-out result against zero, and the
    // without-best-trade check cannot be applied.
    const metric = value ?? per;
    if (n >= MIN_CLOSES) Object.assign(row, metric === null ? { beatsBaseline: VERDICT.NOT_ENOUGH, reason: 'no held-out result published' }
      : metric > 0 ? { beatsBaseline: VERDICT.YES, reason: 'held-out result above zero (no per-trade outlier check)' } : { beatsBaseline: VERDICT.NO, reason: 'held-out result not above zero' });
    return row;
  });
}

// ---------------------------------------------------------------- whole board
export function buildScoreboard(inputs = {}, { now = Date.now() } = {}) {
  const rows = [], errors = [];
  const add = (name, fn) => { try { rows.push(...fn()); } catch (e) { errors.push({ source: name, error: String(e?.message || e).slice(0, 200) }); } };
  if (inputs.pumpfun !== undefined) add('pumpfun', () => pumpfunRows(inputs.pumpfun, { now }));
  if (inputs.pumpfunCopy !== undefined) add('pumpfun-copy', () => [pumpfunCopyRow(inputs.pumpfunCopy, { now })]);
  if (inputs.robinhood !== undefined) add('robinhood', () => robinhoodCryptoRows(inputs.robinhood || {}, { now }));
  if (inputs.equities !== undefined) add('equities', () => [equitiesRow(inputs.equities, { now })]);
  if (inputs.polymarket !== undefined) add('polymarket', () => polymarketRows(inputs.polymarket, { now }));
  if (inputs.platform !== undefined) add('platform', () => platformRows(inputs.platform?.portfolio, { lastEntryAt: inputs.platform?.lastEntryAt, now }));
  if (inputs.lab !== undefined) add('lab', () => labRows(inputs.lab, { now }));
  for (const e of inputs.errors || []) errors.push(e);
  const count = v => rows.filter(r => r.beatsBaseline === v).length;
  return {
    schema: SCOREBOARD_SCHEMA, at: now, paperOnly: true, minCloses: MIN_CLOSES, outlierShare: OUTLIER_SHARE,
    summary: { rows: rows.length, beating: count(VERDICT.YES), notBeating: count(VERDICT.NO), notEnoughData: count(VERDICT.NOT_ENOUGH),
      outlierDriven: rows.filter(r => r.outlier).length, stale: rows.filter(r => ['STALE', 'NO_DATA'].includes(r.freshness?.status)).length },
    paperSummary: { books: rows.filter(r=>r.kind!=='lab').length, beating: rows.filter(r=>r.kind!=='lab'&&r.beatsBaseline===VERDICT.YES).length, notBeating: rows.filter(r=>r.kind!=='lab'&&r.beatsBaseline===VERDICT.NO).length, notEnoughData: rows.filter(r=>r.kind!=='lab'&&r.beatsBaseline===VERDICT.NOT_ENOUGH).length, researchRowsExcluded: rows.filter(r=>r.kind==='lab').length },
    rows, errors,
    rules: 'Net is after every modeled fee. YES/NO needs at least ' + MIN_CLOSES + ' closes (' + EQUITY_MIN_SESSIONS + ' sessions for equities); YES also has to hold without the single best trade. Units differ per module and are never summed.',
  };
}

// ---------------------------------------------------------------- impure: read the running engine
// Reads existing snapshots only (no network, no writes). Tape reads for the crypto hold baseline are cached.
const holdStartCache = new Map();
function tapeMidAt(T, rows, symbol, t0, { maxGapMs = 30 * MIN } = {}) {
  const key = `${symbol}|${t0}`;
  if (holdStartCache.has(key)) return holdStartCache.get(key);
  const mem = rows.find(r => r[0] >= t0);
  let mid = null;
  if (rows.length && rows[0][0] <= t0 && mem) mid = (mem[1] + mem[2]) / 2;
  else { const r = T.loadTapeSince(symbol, t0).find(x => x.t >= t0); if (r && r.t - t0 <= maxGapMs) mid = r.mid; }
  if (mid !== null) { if (holdStartCache.size > 64) holdStartCache.clear(); holdStartCache.set(key, mid); }
  return mid;
}
function tapeMidNow(T, rows, symbol, now) {
  const last = rows.at(-1);
  if (last && now - last[0] <= 30 * MIN) return (last[1] + last[2]) / 2;
  const r = T.loadTapeSince(symbol, now - 6 * HOUR).at(-1);
  return r ? r.mid : null;
}

let cache = { at: 0, value: null };
export async function readScoreboard({ now = Date.now(), maxAgeMs = 5000 } = {}) {
  if (cache.value && now - cache.at >= 0 && now - cache.at < maxAgeMs) return cache.value;
  const inputs = { errors: [] };
  const attempt = async (name, fn) => { try { return await fn(); } catch (e) { inputs.errors.push({ source: name, error: String(e?.message || e).slice(0, 200) }); return undefined; } };
  const fs = await import('node:fs'), path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dataDir = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'));
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

  inputs.pumpfun = await attempt('pumpfun', async () => (await import('./store.js')).loadStateCached());
  inputs.pumpfunCopy = await attempt('pumpfun-copy', async () => (await import('./pumpfunCopyPaper.js')).pumpfunCopyPaper().view());
  inputs.robinhood = await attempt('robinhood', async () => {
    const J = await import('./robinhoodJournal.js'), T = await import('./robinhoodTape.js'), RP = await import('./robinhoodPractice.js');
    const strict = J.loadPaper(), explore = J.loadExplore(), practice = RP.loadPracticeBook(path.dirname(J.PAPER_FILE));
    const tapes = strict.tape || {};
    const tapeAt = Math.max(0, ...Object.values(tapes).map(t => t.samples?.at(-1)?.[0] || 0)) || finite(strict.tapeAt);
    const holdPrices = {};
    for (const [id, w] of Object.entries(cryptoHoldWindows({ strict, explore, practice }))) {
      holdPrices[id] = {};
      for (const s of w.symbols) {
        const rows = tapes[s]?.samples || [];
        try { holdPrices[id][s] = { from: tapeMidAt(T, rows, s, w.from), to: tapeMidNow(T, rows, s, now) }; } catch { holdPrices[id][s] = { from: null, to: null }; }
      }
    }
    return { strict, explore, practice, tapeAt, holdPrices };
  });
  inputs.equities = await attempt('equities', async () => (await import('./robinhoodEquities.js')).robinhoodEquitiesSnapshot({ now }));
  inputs.polymarket = await attempt('polymarket', async () => (await import('./polymarketUSEvidence.js')).loadEvidenceState());
  inputs.platform = await attempt('platform', async () => {
    const { marketPlatform } = await import('./core/platform.js'), p = marketPlatform();
    return { portfolio: p.ledger.portfolio('PAPER'), lastEntryAt: p.ledger.entries({ mode: 'PAPER', limit: 1 })[0]?.at ?? null };
  });
  inputs.lab = await attempt('lab', async () => {
    const { readLabLink } = await import('./labLink.js'), { championState } = await import('./championState.js');
    const out = {};
    const link = readLabLink({ now });
    if (link.champion || link.status) {
      const m = link.champion?.champion?.metrics || {};
      out.solana = { ...championState(link.champion), stage: link.champion?.qualificationStage || null, updatedAt: link.status?.updatedAt ?? null,
        n: m.heldOutN, perTrade: m.heldOutAvgPct, unit: '%', metric: 'held-out average return per trade (%)' };
    }
    const mod = id => readJson(path.join(dataDir, 'lab-link', 'modules', `${id}.json`));
    const rh = readJson(path.join(dataDir, 'lab-link', 'robinhood-champion.json'));
    if (rh?.schema === 'mpo.lab-module-champion.v1' && rh.module === 'robinhood') {
      const t = rh.candidate?.metrics || {};
      out.robinhood = { ...championState(rh), stage: rh.qualificationStage || null, updatedAt: mod('robinhood')?.updatedAt ?? rh.publishedAt ?? null,
        n: t.closes, value: t.pnlUsd, hitRate: t.hitRate, profitFactor: t.profitFactor ?? null, unit: 'USD', metric: 'test-split replay P/L' };
    }
    const pm = readJson(path.join(dataDir, 'lab-link', 'polymarket-combo-champion.json'));
    if (pm?.schema === 'mpo.lab-module-champion.v1' && pm.module === 'polymarket-combo' && pm.liveActivationAllowed === false) {
      const h = pm.candidate?.holdout || {};
      out['polymarket-combo'] = { ...championState(pm), stage: pm.qualificationStage || null, updatedAt: mod('polymarket-combo')?.updatedAt ?? pm.publishedAt ?? null,
        n: h.combos, perTrade: finite(h.roi) === null ? null : round(Number(h.roi) * 100, 3), unit: '%', metric: 'holdout ROI per staked dollar (%)' };
    }
    return out;
  });
  const value = buildScoreboard(inputs, { now });
  cache = { at: now, value };
  return value;
}
export const __testing = { resetCache() { cache = { at: 0, value: null }; holdStartCache.clear(); } };
