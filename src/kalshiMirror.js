// Kalshi mirror of the Polymarket copy leaders (paper, 2026-10-03; bing: "work the strategy of copy trading into all
// of these platforms"). Kalshi trades are anonymous, so there is nobody on Kalshi to copy. This copies a followed
// Polymarket leader's buy onto the same bet on Kalshi.
//
// Only GAME_WINNER markets are mirrored. The sports board (src/core/sports.js) has already paired those across venues
// by game, day and team, so "this team wins this game" means the same thing on both. Spreads, totals and props are
// never mirrored: their terms differ too easily.
//
// Each mirror fills at Kalshi's live ask (book walk, $1 stake, the Kalshi bots' size) plus Kalshi's taker fee. It
// never fills at the leader's Polymarket price, and it is skipped if Kalshi's ask is more than maxChase above that
// price. It settles on Kalshi's own result.
// PAPER ONLY: no order code. Book file: <data>/kalshi-mirror-paper.json. An unreadable book is never overwritten.
import fs from 'node:fs';
import { copyAttribution } from './copyAttribution.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomicSync } from './atomicRename.js';
import { takerFee } from './core/fees.js';
import { sameName } from './core/contractTerms.js';
import { walkAsks, paced } from './kalshiBots.js';

const SCHEMA = 'mpo.kalshi-mirror-paper.v1';
export const MIRROR_DEFAULTS = Object.freeze({ enabled: true, startUsd: 12.5, stakeUsd: 1, maxOpen: 10, maxChase: 0.05, minPrice: 0.05, maxPrice: 0.95 });
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const norm = s => String(s || '').toLowerCase().replace(/^(will |who will win:? )/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const MAX_TRADE_AGE_MS = 30 * 60e3;
const validTrade = (q, now) => typeof q.key === 'string' && q.key && typeof q.title === 'string' && typeof q.outcome === 'string' && Number.isFinite(q.price) && q.price > 0 && q.price < 1 && Number.isSafeInteger(q.ts) && q.ts > 0 && q.ts <= now && now - q.ts <= MAX_TRADE_AGE_MS;
const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function validateState(s) {
  if (!s || s.schema !== SCHEMA || !Number.isSafeInteger(s.epoch) || s.epoch < 1 || !nonnegative(s.cashUsd) || !nonnegative(s.startUsd) || s.startUsd < 1 || !s.settings || typeof s.settings.enabled !== 'boolean') throw new Error('invalid mirror book or balance');
  const st = s.settings;
  if (!(nonnegative(st.startUsd) && st.startUsd >= 1 && st.startUsd <= 100000 && nonnegative(st.stakeUsd) && st.stakeUsd >= 1 && st.stakeUsd <= 250 && Number.isSafeInteger(st.maxOpen) && st.maxOpen >= 1 && st.maxOpen <= 100 && nonnegative(st.maxChase) && st.maxChase <= .2 && nonnegative(st.minPrice) && st.minPrice > 0 && st.minPrice <= st.maxPrice && nonnegative(st.maxPrice) && st.maxPrice < 1)) throw new Error('invalid mirror settings');
  for (const key of ['queue', 'open', 'history', 'decisions', 'seen']) if (!Array.isArray(s[key])) throw new Error(`invalid mirror ${key}`);
  if (s.queue.length > 50 || s.open.length > 100 || s.history.length > 500 || s.decisions.length > 60 || s.seen.length > 3000 || s.seen.some(x => typeof x !== 'string')) throw new Error('invalid mirror journal bounds');
  if (s.queue.some(q => !q || typeof q.key !== 'string' || !q.key || typeof q.title !== 'string' || typeof q.outcome !== 'string' || !Number.isFinite(q.price) || q.price <= 0 || q.price >= 1 || !Number.isSafeInteger(q.ts) || q.ts <= 0)) throw new Error('invalid queued trade');
  const tickers = new Set();
  for (const p of [...s.open, ...s.history]) {
    if (!p || typeof p.ticker !== 'string' || !p.ticker || !Number.isSafeInteger(p.qty) || p.qty < 1 || !nonnegative(p.costUsd) || !nonnegative(p.feeUsd) || p.markUsd != null && !nonnegative(p.markUsd)) throw new Error('invalid mirror position');
  }
  for (const p of s.open) { if (tickers.has(p.ticker)) throw new Error('duplicate open ticker'); tickers.add(p.ticker); }
  if (s.history.some(p => !Number.isFinite(p.pnlUsd) || !nonnegative(p.payoutUsd) || !['YES', 'NO'].includes(p.outcome))) throw new Error('invalid mirror settlement');
  return s;
}

// The Kalshi GAME_WINNER contract for the team a Polymarket leader bought, or null with the reason.
export function mirrorTarget(trade, events = []) {
  const title = norm(trade.title), outcome = norm(trade.outcome);
  const day = String(trade.day || trade.date || trade.eventSlug || trade.slug || trade.title || '').match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
  const listed = events.flatMap(e => (e.contracts || []).filter(c => c.venue === 'polymarket' && c.type === 'GAME_WINNER').map(pm => ({ e, pm })));
  const checks = c => [
    trade.asset && (c.tokenIds?.length || c.yesToken || c.noToken) ? [c.yesToken, c.noToken, ...(c.tokenIds || [])].some(x => String(x) === String(trade.asset)) : null,
    trade.conditionId && c.conditionId ? String(c.conditionId) === String(trade.conditionId) : null,
    trade.marketId && c.sourceId ? String(c.sourceId) === String(trade.marketId) : null,
  ].filter(v => v !== null);
  const hasIdentity = listed.some(({ pm }) => checks(pm).length);
  const matched = listed.filter(({ e, pm }) => (!day || e.day === day) && (hasIdentity ? checks(pm).length && checks(pm).every(Boolean) : title && norm(pm.title) === title));
  if (!matched.length) return { reason: 'not a game-winner market Kalshi also lists' };
  if (matched.length !== 1) return { reason: 'ambiguous game: market identity or game date is required' };
  const { e, pm } = matched[0];
  if (!Array.isArray(e.participants) || e.participants.length !== 2) return { reason: 'game participants are not established' };
  const teams = e.participants.filter(p => outcome && sameName(p, outcome));
  if (teams.length !== 1) return { reason: 'outcome is not exactly one of the two teams' };
  const team = teams[0];
  const candidates = (e.contracts || []).filter(c => c.venue === 'kalshi' && c.type === 'GAME_WINNER' && c.sourceId && c.side && sameName(team, c.side));
  if (candidates.length !== 1 || e.participants.filter(p => sameName(p, candidates[0]?.side)).length !== 1) return { reason: 'no unambiguous Kalshi game-winner contract for this game' };
  return { event: e, team, contract: candidates[0], polymarket: pm };
}

export class KalshiMirrorPaper {
  constructor({ dataDir, kalshi = () => null, sports = async () => null, now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'kalshi-mirror-paper.json'); this.kalshi = kalshi; this.sports = sports; this.now = now; this.busy = false; this.recoveryError = null; this.state = this.load();
  }
  fresh(start = MIRROR_DEFAULTS.startUsd, settings = MIRROR_DEFAULTS, epoch = 1) { return { schema: SCHEMA, epoch, startUsd: start, cashUsd: start, settings: { ...settings, startUsd: start }, queue: [], open: [], history: [], decisions: [], seen: [], lastRunAt: null, lastError: null, lastNote: null }; }
  load() {
    try { if (fs.statSync(this.file).size > 8 * 1024 * 1024) throw new Error('mirror book exceeds read budget'); const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); return validateState(s); }
    catch (e) { if (e.code === 'ENOENT') return this.fresh(); this.recoveryError = `Kalshi mirror book unreadable (${e.message}); the file was kept. Reset to start a new book.`; return this.fresh(); }
  }
  save() { if (this.recoveryError) throw new Error(this.recoveryError); try { validateState(this.state); writeFileAtomicSync(this.file, JSON.stringify(this.state)); } catch (e) { this.recoveryError = `Kalshi mirror persistence failed (${e.message}); recovery is required.`; throw new Error(this.recoveryError); } }
  decide(row) { this.state.decisions.unshift({ at: this.now(), ...row }); this.state.decisions.length = Math.min(this.state.decisions.length, 60); }
  reset({ confirmation, startUsd } = {}) {
    if (confirmation !== 'RESET BOT') throw new Error('Type RESET BOT to confirm');
    if (this.busy) throw new Error('Kalshi mirror is running; wait before resetting');
    const start = startUsd == null ? this.state.settings.startUsd : Number(startUsd); if (!(start >= 1 && start <= 100000)) throw new Error('startUsd must be between 1 and 100000');
    const next = this.fresh(start, this.state.settings, (this.state.epoch || 1) + 1);
    try { fs.copyFileSync(this.file, `${this.file}.pre-reset-${this.now()}-${randomUUID()}`, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    writeFileAtomicSync(this.file, JSON.stringify(next)); this.recoveryError = null; this.state = next; return this.snapshot();
  }
  // Called by the Polymarket copy bot for every new leader BUY made after it started following that leader.
  enqueue(leader, t) {
    if (this.recoveryError) throw new Error(this.recoveryError);
    const key = `${t.transactionHash}:${t.asset}`; if (this.state.seen.includes(key)) return;
    const q = { key, leader: String(leader?.name || ''), title: String(t.title || t.slug || ''), outcome: String(t.outcome || ''), price: Number(t.price), ts: Number(t.timestamp) * 1000,
      asset: t.asset, conditionId: t.conditionId, marketId: t.marketId, slug: t.slug, eventSlug: t.eventSlug, day: t.day || t.date };
    if (!t.transactionHash || !t.asset || !validTrade(q, this.now())) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'invalid, future or stale leader trade' }); this.save(); return; }
    this.state.seen.push(key); if (this.state.seen.length > 3000) this.state.seen.splice(0, this.state.seen.length - 3000);
    this.state.queue.push(q);
    if (this.state.queue.length > 50) { const dropped = this.state.queue.shift(); this.decide({ leader: dropped.leader, title: dropped.title, action: 'SKIP', reason: 'bounded mirror queue full' }); } this.save();
  }

  async run() {
    if (this.recoveryError) throw new Error(this.recoveryError);
    if (this.busy) return this.snapshot(); this.busy = true;
    const s = this.state, st = s.settings;
    try {
      const k = this.kalshi(); if (!k) throw new Error('Kalshi provider unavailable');
      await this.settle(k);
      const queue = s.queue.slice(); let entered = 0;
      if (st.enabled && queue.length) {
        const board = await this.sports();
        if (!Array.isArray(board?.events)) throw new Error('Sports board unavailable; queued trades retained');
        for (const q of queue) {
          const consume = () => { s.queue = s.queue.filter(x => x.key !== q.key); this.save(); };
          if (!validTrade(q, this.now())) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'invalid, future or stale leader trade' }); consume(); continue; }
          const m = mirrorTarget(q, board?.events || []);
          s.matcher ||= {since:this.now(),checked:0,matched:0,misses:{}};
          s.matcher.checked++;
          if(m.contract)s.matcher.matched++;else s.matcher.misses[m.reason||'unknown']=(s.matcher.misses[m.reason||'unknown']||0)+1;
          if (!m.contract) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: m.reason }); consume(); continue; }
          if (s.open.some(p => p.ticker === m.contract.sourceId)) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'already holding this team' }); consume(); continue; }
          if (s.open.length >= st.maxOpen) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'max open mirrors' }); consume(); continue; }
          if (await this.enter(k, q, m)) entered++;
          consume();
        }
      }
      s.lastNote = `${queue.length} leader buys checked · ${entered} mirrored on Kalshi`; s.lastError = null;
    } catch (e) { s.lastError = String(e.message || e).slice(0, 300); }
    finally { s.lastRunAt = this.now(); this.busy = false; if (!this.recoveryError) this.save(); }
    return this.snapshot();
  }
  async enter(k, q, m) {
    const s = this.state, st = s.settings, ticker = m.contract.sourceId;
    const market = await paced(() => k.market(ticker)), d = market?.data || {};
    if (!validTrade(q, this.now())) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'leader trade expired during lookup' }); return false; }
    if (!['ACTIVE', 'OPEN'].includes(d.status) || d.closeAt != null && d.closeAt <= this.now()) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: `Kalshi market ${String(d.status || 'unknown').toLowerCase()} or closed` }); return false; }
    const ask = d.yesAsk; if (!(ask >= st.minPrice && ask <= st.maxPrice)) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: `Kalshi ask ${ask ?? '—'} outside ${st.minPrice}–${st.maxPrice}` }); return false; }
    if (ask > q.price + st.maxChase) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: `Kalshi ask ${ask} is ${round(ask - q.price, 3)} above the leader's ${round(q.price, 3)}` }); return false; }
    const book = await paced(() => k.book(ticker)), budget = Math.min(st.stakeUsd, s.cashUsd);
    if (!validTrade(q, this.now())) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'leader trade expired during lookup' }); return false; }
    let fills = walkAsks(book, 'YES', Math.floor(budget / ask), Math.min(st.maxPrice, q.price + st.maxChase));
    if (fills.some(f => !Number.isFinite(f.price) || f.price < st.minPrice || !Number.isSafeInteger(f.quantity))) throw new Error('Invalid Kalshi book; queued trade retained');
    let qty = fills.reduce((a, f) => a + f.quantity, 0), cost = fills.reduce((a, f) => a + f.price * f.quantity, 0), fee = takerFee(d.feeModel, fills);
    if (fee != null && Number.isFinite(fee) && cost + fee > budget + 1e-9) {
      let lo = 0, hi = qty;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2), trial = walkAsks(book, 'YES', mid, Math.min(st.maxPrice, q.price + st.maxChase)); const charge = trial.reduce((a, f) => a + f.price * f.quantity, 0) + takerFee(d.feeModel, trial); if (charge <= budget + 1e-9) lo = mid; else hi = mid - 1; }
      fills = walkAsks(book, 'YES', lo, Math.min(st.maxPrice, q.price + st.maxChase)); qty = lo; cost = fills.reduce((a, f) => a + f.price * f.quantity, 0); fee = takerFee(d.feeModel, fills);
    }
    if (qty < 1) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'no Kalshi depth at the price' }); return false; }
    if (fee == null || !Number.isFinite(fee) || fee < 0) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'Kalshi fee model unavailable' }); return false; }
    if (cost + fee > s.cashUsd) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'not enough paper cash' }); return false; }
    s.cashUsd = round(s.cashUsd - cost - fee, 6);
    s.open.push({ ticker, team: m.team, game: m.event.participants.join(' vs '), sport: m.event.sport, leader: q.leader, leaderPrice: round(q.price, 4), qty, avgPrice: round(cost / qty, 4), costUsd: round(cost, 4), feeUsd: round(fee, 4), openedAt: this.now(), closeAt: m.contract.closeAt || null, markUsd: round(cost, 4) });
    this.decide({ leader: q.leader, title: q.title, team: m.team, action: 'MIRROR', price: round(cost / qty, 3), leaderPrice: round(q.price, 3) });
    return true;
  }
  async settle(k) {
    const s = this.state;
    for (const p of s.open.slice()) {
      let m = null; try { m = await paced(() => k.market(p.ticker)); } catch { continue; }
      const d = m?.data || {}, out = d.settlementOutcome;
      if (out === 'YES' || out === 'NO') {
        const won = out === 'YES', payout = won ? p.qty : 0; s.cashUsd = round(s.cashUsd + payout, 6);
        s.history.unshift({ ...p, outcome: out, won, payoutUsd: payout, pnlUsd: round(payout - p.costUsd - p.feeUsd, 4), settledAt: this.now() });
        s.open = s.open.filter(x => x !== p); s.history.length = Math.min(s.history.length, 500); this.save(); continue;
      }
      if (Number.isFinite(d.yesBid) && d.yesBid >= 0 && d.yesBid <= 1) p.markUsd = round(d.yesBid * p.qty, 4);
    }
  }
  snapshot() {
    if (this.recoveryError) return { id: 'kalshimirror', label: 'Kalshi mirror of Polymarket leaders', mode: 'PAPER', recoveryRequired: true, startUsd: null, cashUsd: null, equityUsd: null, returnPct: null, settings: this.state.settings, queued: 0, open: [], history: [], decisions: [], stats: { settled: null, wins: null, pnlUsd: null, feesUsd: null }, lastRunAt: null, lastError: this.recoveryError, lastNote: 'Existing book preserved; recovery required', running: this.busy };
    const s = this.state, h = s.history, n = h.length, open = s.open.reduce((a, p) => a + (p.markUsd ?? p.costUsd), 0), equity = s.cashUsd + open;
    return { id: 'kalshimirror', label: 'Kalshi mirror of Polymarket leaders', mode: 'PAPER', epoch: s.epoch, settings: s.settings, startUsd: s.startUsd, cashUsd: round(s.cashUsd, 2), equityUsd: round(equity, 2), returnPct: round((equity - s.startUsd) / s.startUsd * 100, 2),
      queued: s.queue.length, open: s.open, history: h.slice(0, 50), decisions: s.decisions.slice(0, 30), matcher:s.matcher||null,attribution:copyAttribution(h),
      stats: { settled: n, wins: h.filter(x => x.won).length, pnlUsd: round(h.reduce((a, x) => a + x.pnlUsd, 0), 2), feesUsd: round(h.reduce((a, x) => a + x.feeUsd, 0), 2) },
      lastRunAt: s.lastRunAt, lastError: this.recoveryError || s.lastError, lastNote: s.lastNote, running: this.busy };
  }
}
