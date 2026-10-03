// Forward-test farm (2026-10-03, Research Workbench phase 3; see docs/EVOLUTION-LAB-AUDIT-2026-10-02.md).
// A small, fixed set of paper variants of the Kalshi weather and BTC bots, each with its own $500 paper book,
// priced on the same market snapshot (frame) as the live paper bots. That way no extra Kalshi or weather
// calls are made. The only question it answers is the one a backtest cannot: which settings make money
// going forward, after fees, on markets nobody has seen yet.
//
// Honest by construction:
//  - A variant enters only on markets that are open now, and settles on Kalshi's own result.
//  - Variants fill at the quoted ask plus one cent of slippage, without walking the book, to save API calls.
//    The live paper bots do walk the real book. Variant wx-cal-e07 uses the live weather bot's settings,
//    so comparing the two shows what this shortcut costs.
//  - A verdict needs at least MIN_SETTLED settled bets, then a t-statistic of per-bet P/L. Until then the
//    farm says "too early".
// PAPER ONLY: no order code. Book file: <data>/bot-farm.json. An unreadable file is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicRename.js';
import { takerFee } from './core/fees.js';
import { KALSHI_DEFAULTS, pickWeather, pickBtc, paced } from './kalshiBots.js';

const SCHEMA = 'mpo.bot-farm.v1';
export const FARM_START_USD = KALSHI_DEFAULTS.weather.startUsd; // same bankroll as the live bots
export const FARM_SLIPPAGE = 0.01;
export const MIN_SETTLED = 20;
// Labels say what differs from the live bot's defaults (weather: calibrated, edge ≥ 7¢, σ × 1.1, gap ≤ 20¢;
// btc: vol × 1.25, edge ≥ 6¢).
export const FARM_VARIANTS = Object.freeze([
  { id: 'wx-cal-e04', kind: 'weather', label: 'Weather · calibrated · edge ≥ 4¢', over: { minEdge: 0.04 } },
  { id: 'wx-cal-e07', kind: 'weather', label: 'Weather · calibrated · live settings', over: {} },
  { id: 'wx-cal-e10', kind: 'weather', label: 'Weather · calibrated · edge ≥ 10¢', over: { minEdge: 0.10 } },
  { id: 'wx-cal-wide', kind: 'weather', label: 'Weather · calibrated · σ × 1.4', over: { calibrationSafety: 1.4 } },
  { id: 'wx-cal-tight', kind: 'weather', label: 'Weather · calibrated · model gap ≤ 10¢', over: { maxDisagreement: 0.10 } },
  { id: 'wx-nws-e04', kind: 'weather', label: 'Weather · NWS only · edge ≥ 4¢', over: { useCalibration: false, minEdge: 0.04 } },
  { id: 'wx-nws-e10', kind: 'weather', label: 'Weather · NWS only · edge ≥ 10¢', over: { useCalibration: false, minEdge: 0.10 } },
  { id: 'btc-v100', kind: 'btc', label: 'BTC · vol × 1.0', over: { volMultiple: 1.0 } },
  { id: 'btc-v125-e04', kind: 'btc', label: 'BTC · vol × 1.25 · edge ≥ 4¢', over: { minEdge: 0.04 } },
  { id: 'btc-v150', kind: 'btc', label: 'BTC · vol × 1.5', over: { volMultiple: 1.5 } },
  { id: 'btc-v200', kind: 'btc', label: 'BTC · vol × 2.0', over: { volMultiple: 2.0 } },
]);
// The Evolution Lab's Research Workbench may propose up to four extra variants (lab-link/farm-proposals.json),
// only from calibrations that beat the current settings on held-out data. Each is checked here: a known kind,
// an id 'lab-…', and only these settings, inside these bounds. Anything else is ignored.
const LAB_OVER = { volMultiple: [0.5, 4], minEdge: [0.02, 0.3], calibrationSafety: [0.8, 3], maxDisagreement: [0.05, 0.5], sigmaBaseF: [0.5, 8], sigmaPerDayF: [0, 5], biasF: [-10, 10] };
export function labVariants(doc) {
  const out = [];
  for (const v of Array.isArray(doc?.variants) ? doc.variants.slice(0, 4) : []) {
    if (!/^lab-[a-z0-9-]{3,40}$/.test(String(v?.id)) || !['weather', 'btc'].includes(v.kind) || !v.over || typeof v.over !== 'object') continue;
    const over = {}; let ok = true;
    for (const [k, x] of Object.entries(v.over)) { const n = Number(x), lim = LAB_OVER[k]; if (!lim || !Number.isFinite(n) || n < lim[0] || n > lim[1]) { ok = false; break; } over[k] = n; }
    if (ok && Object.keys(over).length) out.push({ id: v.id, kind: v.kind, label: String(v.label || v.id).slice(0, 60), over, lab: true, reason: String(v.reason || '').slice(0, 200) });
  }
  return out;
}
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const localDay = t => new Date(t).toLocaleDateString('en-CA');

function emptyBook(v) { return { id: v.id, kind: v.kind, label: v.label, startUsd: FARM_START_USD, cashUsd: FARM_START_USD, open: [], history: [], entered: 0, skippedSlippage: 0 }; }
export function variantSettings(v) { return { ...(v.kind === 'weather' ? KALSHI_DEFAULTS.weather : KALSHI_DEFAULTS.btc), ...v.over, enabled: true }; }

// Per-bet P/L t-statistic and a plain verdict.
export function verdict(pnls) {
  const n = pnls.length; if (n < MIN_SETTLED) return { t: null, text: `too early (${n}/${MIN_SETTLED} settled)` };
  const m = pnls.reduce((a, x) => a + x, 0) / n, sd = Math.sqrt(pnls.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)), t = sd > 0 ? m / sd * Math.sqrt(n) : Math.sign(m) * Infinity || 0;
  const shown = Number.isFinite(t) ? t.toFixed(1) : t > 0 ? '∞' : '−∞';
  return { t: Number.isFinite(t) ? round(t, 2) : null, text: t >= 2 ? `making money (t ${shown})` : t <= -2 ? `losing money (t ${shown})` : `no clear edge yet (t ${shown})` };
}

export class BotFarm {
  constructor({ dataDir, bots, now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'bot-farm.json'); this.bots = bots; this.now = now; this.busy = new Set(); this.recoveryError = null;
    this.labFile = path.join(dataDir, 'lab-link', 'farm-proposals.json');
    this.state = this.load(); this.last = {};
  }
  load() {
    let s;
    try {
      s = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { schema: SCHEMA, startedAt: this.now(), books: {} };
      if (s.schema !== SCHEMA || !s.books) throw new Error('unknown schema');
    } catch (e) {
      this.recoveryError = `Farm book unreadable (${e.message}); the file was kept. Reset the farm to start over.`;
      s = { schema: SCHEMA, startedAt: this.now(), books: {} };
    }
    for (const v of FARM_VARIANTS) s.books[v.id] ||= emptyBook(v);
    return s;
  }
  // The fixed variants plus the Lab's current proposals. A proposal that the Lab withdraws keeps its book (history
  // stays visible) but makes no new bets.
  variants() {
    let lab = []; try { lab = labVariants(JSON.parse(fs.readFileSync(this.labFile, 'utf8'))); } catch {}
    for (const v of lab) this.state.books[v.id] ||= emptyBook(v);
    const active = new Set(lab.map(v => v.id)), retired = Object.values(this.state.books).filter(b => /^lab-/.test(b.id) && !active.has(b.id)).map(b => ({ id: b.id, kind: b.kind, label: b.label || b.id, over: {}, lab: true, withdrawn: true }));
    return [...FARM_VARIANTS, ...lab, ...retired];
  }
  save() { if (this.recoveryError) return; fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeFileAtomicSync(this.file, JSON.stringify(this.state)); }
  reset({ confirmation } = {}) {
    if (confirmation !== 'RESET BOT') throw new Error('Type RESET BOT to confirm');
    this.recoveryError = null; this.state = { schema: SCHEMA, startedAt: this.now(), books: Object.fromEntries(FARM_VARIANTS.map(v => [v.id, emptyBook(v)])) }; this.save(); return this.snapshot();
  }

  async run(kind) {
    if (this.recoveryError) throw new Error(this.recoveryError);
    if (this.busy.has(kind)) return this.snapshot(); this.busy.add(kind);
    const last = this.last[kind] = { at: this.now(), error: null, entered: 0 };
    try {
      const k = this.bots.kalshi(); if (!k) throw new Error('Kalshi provider unavailable');
      const frame = kind === 'weather' ? await this.bots.weatherFrame() : await this.bots.btcFrame(k);
      const now = this.now(), books = this.variants().filter(v => v.kind === kind).map(v => [v, this.state.books[v.id]]);
      await this.settle(books.map(([, b]) => b), k, now);
      const marks = markIndex(kind, frame);
      for (const [v, b] of books) {
        const s = variantSettings(v), held = new Set(b.open.map(p => p.eventTicker));
        if (v.withdrawn) continue; // settled above; no new bets
        const { cands } = kind === 'weather' ? pickWeather(frame, s, held, now) : pickBtc(frame, s, held, now);
        for (const x of cands) {
          if (x.edge < s.minEdge) continue;
          if (b.open.length >= s.maxOpen) break;
          if (this.enter(b, s, x, now)) last.entered++;
        }
        for (const p of b.open) { const bid = marks.get(p.ticker)?.[p.side]; if (bid != null) p.markUsd = round(bid * p.qty, 4); }
      }
    } catch (e) { last.error = String(e.message || e).slice(0, 300); }
    finally { this.busy.delete(kind); this.save(); }
    return this.snapshot();
  }
  // Fill at the quoted ask + slippage; the edge must still clear minEdge at that price, after the fee.
  enter(b, s, x, now) {
    const price = round(Math.min(0.99, x.ask + FARM_SLIPPAGE), 4), qty = Math.floor(s.stakeUsd / price);
    if (qty < 1) return false;
    const fee = takerFee(x.feeModel, [{ price, quantity: qty }]); if (fee == null) return false;
    const pModel = x.pModel, edge = pModel - price - fee / qty;
    if (edge < s.minEdge) { b.skippedSlippage++; return false; }
    const cost = price * qty; if (cost + fee > b.cashUsd) return false;
    b.cashUsd = round(b.cashUsd - cost - fee, 6); b.entered++;
    b.open.push({ ticker: x.ticker, eventTicker: x.eventTicker, label: x.label, side: x.side, qty, price, costUsd: round(cost, 4), feeUsd: round(fee, 4), pModel: round(pModel, 4), marketPrice: x.ask, openedAt: now, closeAt: x.closeAt, markUsd: round(cost, 4) });
    return true;
  }
  // Settle positions whose market has closed, asking Kalshi once per ticker across all variants.
  async settle(books, k, now) {
    const due = new Set(books.flatMap(b => b.open.filter(p => p.closeAt <= now).map(p => p.ticker))), results = new Map();
    for (const t of due) { try { const m = await paced(() => k.market(t)); results.set(t, m.data); } catch {} }
    for (const b of books) {
      const keep = [];
      for (const p of b.open) {
        const d = results.get(p.ticker), outcome = d?.settlementOutcome;
        if (outcome !== 'YES' && outcome !== 'NO') { keep.push(p); continue; }
        this.bots.tapeSettlement?.(p.ticker, p.eventTicker, d);
        const won = outcome === p.side, payout = won ? p.qty : 0;
        b.cashUsd = round(b.cashUsd + payout, 6);
        b.history.unshift({ ...p, outcome, won, payoutUsd: payout, pnlUsd: round(payout - p.costUsd - p.feeUsd, 4), settledAt: now, brierModel: round((p.pModel - (won ? 1 : 0)) ** 2, 4), brierMarket: round((p.marketPrice - (won ? 1 : 0)) ** 2, 4) });
      }
      b.open = keep; b.history.length = Math.min(b.history.length, 2000);
    }
  }

  snapshot() {
    const today = localDay(this.now()), days = Array.from({ length: 7 }, (_, i) => localDay(this.now() - i * 86400e3));
    const variants = this.variants().map(v => {
      const b = this.state.books[v.id], h = b.history, n = h.length, open = b.open.reduce((a, p) => a + (p.markUsd ?? p.costUsd), 0), equity = b.cashUsd + open;
      const byDay = Object.fromEntries(days.map(d => [d, 0])); for (const x of h) { const d = localDay(x.settledAt); if (d in byDay) byDay[d] = round(byDay[d] + x.pnlUsd, 2); }
      const mean = k => n ? round(h.reduce((a, x) => a + x[k], 0) / n, 4) : null;
      return { id: v.id, kind: v.kind, label: v.label, over: v.over, lab: !!v.lab, withdrawn: !!v.withdrawn, equityUsd: round(equity, 2), returnPct: round((equity - b.startUsd) / b.startUsd * 100, 2), open: b.open.length, entered: b.entered, skippedSlippage: b.skippedSlippage,
        settled: n, wins: h.filter(x => x.won).length, hitRate: n ? round(h.filter(x => x.won).length / n, 3) : null, pnlUsd: round(h.reduce((a, x) => a + x.pnlUsd, 0), 2), feesUsd: round(h.reduce((a, x) => a + x.feeUsd, 0), 2),
        today: byDay[today], week: round(Object.values(byDay).reduce((a, x) => a + x, 0), 2), byDay, brierModel: mean('brierModel'), brierMarket: mean('brierMarket'), verdict: verdict(h.map(x => x.pnlUsd)) };
    });
    return { mode: 'PAPER', startedAt: this.state.startedAt, startUsd: FARM_START_USD, slippage: FARM_SLIPPAGE, minSettled: MIN_SETTLED, days, variants, last: this.last, error: this.recoveryError, running: [...this.busy] };
  }
}
// ticker → { YES: bid, NO: bid } from a frame, to mark open variant bets without extra calls.
function markIndex(kind, frame) {
  const out = new Map();
  if (kind === 'weather') for (const { m } of frame.events) for (const b of m.buckets || []) out.set(b.sourceId, { YES: b.yesBid ?? null, NO: b.noBid ?? null });
  else for (const { markets } of frame.events) for (const m of markets) out.set(m.sourceId, { YES: m.data.yesBid ?? null, NO: m.data.noBid ?? null });
  return out;
}
