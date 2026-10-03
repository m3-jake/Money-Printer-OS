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
import path from 'node:path';
import { writeFileAtomicSync } from './atomicRename.js';
import { takerFee } from './core/fees.js';
import { walkAsks, paced } from './kalshiBots.js';

const SCHEMA = 'mpo.kalshi-mirror-paper.v1';
export const MIRROR_DEFAULTS = Object.freeze({ enabled: true, startUsd: 12.5, stakeUsd: 1, maxOpen: 10, maxChase: 0.05, minPrice: 0.05, maxPrice: 0.95 });
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const norm = s => String(s || '').toLowerCase().replace(/^(will |who will win:? )/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// The Kalshi GAME_WINNER contract for the team a Polymarket leader bought, or null with the reason.
export function mirrorTarget(trade, events = []) {
  const title = norm(trade.title), outcome = norm(trade.outcome);
  for (const e of events) {
    const pm = (e.contracts || []).find(c => c.venue === 'polymarket' && c.type === 'GAME_WINNER' && norm(c.title) === title);
    if (!pm) continue;
    const team = e.participants.find(p => norm(p) === outcome) || e.participants.find(p => outcome && (norm(p).startsWith(outcome) || outcome.startsWith(norm(p))));
    if (!team) return { reason: 'outcome is not one of the two teams' };
    const k = (e.contracts || []).find(c => c.venue === 'kalshi' && c.type === 'GAME_WINNER' && c.side && (norm(team).startsWith(norm(c.side)) || norm(c.side).startsWith(norm(team))));
    return k ? { event: e, team, contract: k } : { reason: 'no Kalshi game-winner contract for this game' };
  }
  return { reason: 'not a game-winner market Kalshi also lists' };
}

export class KalshiMirrorPaper {
  constructor({ dataDir, kalshi = () => null, sports = async () => null, now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'kalshi-mirror-paper.json'); this.kalshi = kalshi; this.sports = sports; this.now = now; this.busy = false; this.recoveryError = null; this.state = this.load();
  }
  fresh(start = MIRROR_DEFAULTS.startUsd, settings = MIRROR_DEFAULTS, epoch = 1) { return { schema: SCHEMA, epoch, startUsd: start, cashUsd: start, settings: { ...settings, startUsd: start }, queue: [], open: [], history: [], decisions: [], seen: [], lastRunAt: null, lastError: null, lastNote: null }; }
  load() {
    try { if (!fs.existsSync(this.file)) return this.fresh(); const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (s.schema !== SCHEMA) throw new Error('unknown schema'); s.settings = { ...MIRROR_DEFAULTS, ...s.settings }; s.queue ||= []; return s; }
    catch (e) { this.recoveryError = `Kalshi mirror book unreadable (${e.message}); the file was kept. Reset to start a new book.`; return this.fresh(); }
  }
  save() { if (this.recoveryError) return; fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeFileAtomicSync(this.file, JSON.stringify(this.state)); }
  decide(row) { this.state.decisions.unshift({ at: this.now(), ...row }); this.state.decisions.length = Math.min(this.state.decisions.length, 60); }
  reset({ confirmation, startUsd } = {}) {
    if (confirmation !== 'RESET BOT') throw new Error('Type RESET BOT to confirm');
    const start = startUsd == null ? this.state.settings.startUsd : Number(startUsd); if (!(start >= 1 && start <= 100000)) throw new Error('startUsd must be between 1 and 100000');
    this.recoveryError = null; this.state = this.fresh(start, this.state.settings, (this.state.epoch || 1) + 1); this.save(); return this.snapshot();
  }
  // Called by the Polymarket copy bot for every new leader BUY made after it started following that leader.
  enqueue(leader, t) {
    const key = `${t.transactionHash}:${t.asset}`; if (this.state.seen.includes(key)) return;
    this.state.seen.push(key); if (this.state.seen.length > 3000) this.state.seen.splice(0, this.state.seen.length - 3000);
    this.state.queue.push({ key, leader: leader.name, title: t.title || t.slug || '', outcome: t.outcome || '', price: Number(t.price), ts: Number(t.timestamp) * 1000 });
    this.state.queue = this.state.queue.slice(-50); this.save();
  }

  async run() {
    if (this.recoveryError) throw new Error(this.recoveryError);
    if (this.busy) return this.snapshot(); this.busy = true;
    const s = this.state, st = s.settings;
    try {
      const k = this.kalshi(); if (!k) throw new Error('Kalshi provider unavailable');
      await this.settle(k);
      const queue = s.queue.splice(0); let entered = 0;
      if (st.enabled && queue.length) {
        const board = await this.sports();
        for (const q of queue) {
          if (this.now() - q.ts > 30 * 60e3) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'leader trade older than 30 minutes' }); continue; }
          const m = mirrorTarget(q, board?.events || []);
          if (!m.contract) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: m.reason }); continue; }
          if (s.open.some(p => p.ticker === m.contract.sourceId)) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'already holding this team' }); continue; }
          if (s.open.length >= st.maxOpen) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'max open mirrors' }); continue; }
          if (await this.enter(k, q, m)) entered++;
        }
      }
      s.lastNote = `${queue.length} leader buys checked · ${entered} mirrored on Kalshi`; s.lastError = null;
    } catch (e) { s.lastError = String(e.message || e).slice(0, 300); }
    finally { s.lastRunAt = this.now(); this.busy = false; this.save(); }
    return this.snapshot();
  }
  async enter(k, q, m) {
    const s = this.state, st = s.settings, ticker = m.contract.sourceId;
    const market = await paced(() => k.market(ticker)), d = market?.data || {};
    if (d.status && !['ACTIVE', 'OPEN'].includes(d.status)) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: `Kalshi market ${String(d.status).toLowerCase()}` }); return false; }
    const ask = d.yesAsk; if (!(ask >= st.minPrice && ask <= st.maxPrice)) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: `Kalshi ask ${ask ?? '—'} outside ${st.minPrice}–${st.maxPrice}` }); return false; }
    if (ask > q.price + st.maxChase) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: `Kalshi ask ${ask} is ${round(ask - q.price, 3)} above the leader's ${round(q.price, 3)}` }); return false; }
    const fills = walkAsks(await paced(() => k.book(ticker)), 'YES', Math.floor(st.stakeUsd / ask), q.price + st.maxChase), qty = fills.reduce((a, f) => a + f.quantity, 0);
    if (qty < 1) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'no Kalshi depth at the price' }); return false; }
    const cost = fills.reduce((a, f) => a + f.price * f.quantity, 0), fee = takerFee(d.feeModel, fills);
    if (fee == null) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'Kalshi fee model unavailable' }); return false; }
    if (cost + fee > s.cashUsd) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'not enough paper cash' }); return false; }
    s.cashUsd = round(s.cashUsd - cost - fee, 6);
    s.open.push({ ticker, team: m.team, game: m.event.participants.join(' vs '), sport: m.event.sport, leader: q.leader, leaderPrice: round(q.price, 4), qty, avgPrice: round(cost / qty, 4), costUsd: round(cost, 4), feeUsd: round(fee, 4), openedAt: this.now(), closeAt: m.contract.closeAt || null, markUsd: round(cost, 4) });
    this.decide({ leader: q.leader, title: q.title, team: m.team, action: 'MIRROR', price: round(cost / qty, 3), leaderPrice: round(q.price, 3) });
    return true;
  }
  async settle(k) {
    const s = this.state, keep = [];
    for (const p of s.open) {
      let m = null; try { m = await paced(() => k.market(p.ticker)); } catch { keep.push(p); continue; }
      const d = m?.data || {}, out = d.settlementOutcome;
      if (out === 'YES' || out === 'NO') {
        const won = out === 'YES', payout = won ? p.qty : 0; s.cashUsd = round(s.cashUsd + payout, 6);
        s.history.unshift({ ...p, outcome: out, won, payoutUsd: payout, pnlUsd: round(payout - p.costUsd - p.feeUsd, 4), settledAt: this.now() }); continue;
      }
      if (d.yesBid != null) p.markUsd = round(d.yesBid * p.qty, 4);
      keep.push(p);
    }
    s.open = keep; s.history.length = Math.min(s.history.length, 500);
  }
  snapshot() {
    const s = this.state, h = s.history, n = h.length, open = s.open.reduce((a, p) => a + (p.markUsd ?? p.costUsd), 0), equity = s.cashUsd + open;
    return { id: 'kalshimirror', label: 'Kalshi mirror of Polymarket leaders', mode: 'PAPER', epoch: s.epoch, settings: s.settings, startUsd: s.startUsd, cashUsd: round(s.cashUsd, 2), equityUsd: round(equity, 2), returnPct: round((equity - s.startUsd) / s.startUsd * 100, 2),
      queued: s.queue.length, open: s.open, history: h.slice(0, 50), decisions: s.decisions.slice(0, 30),
      stats: { settled: n, wins: h.filter(x => x.won).length, pnlUsd: round(h.reduce((a, x) => a + x.pnlUsd, 0), 2), feesUsd: round(h.reduce((a, x) => a + x.feeUsd, 0), 2) },
      lastRunAt: s.lastRunAt, lastError: this.recoveryError || s.lastError, lastNote: s.lastNote, running: this.busy };
  }
}
