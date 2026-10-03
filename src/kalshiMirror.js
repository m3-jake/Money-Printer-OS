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
import { fetchLeaderTrades, tradeKey, boundedCopyMap } from './copyEvent.js';

const SCHEMA = 'mpo.kalshi-mirror-paper.v1';
// Its own leaders (2026-10-03, run follow-up): the copy bot's six followed leaders mostly bet spreads, totals and
// props, so the mirror found nothing to copy (0 of 30 leader buys were Kalshi-listed game winners). It also watches
// the top Polymarket SPORTS-leaderboard wallets of the week, whose buys are largely game winners. Public GETs only,
// about 3 a minute; only buys made after the mirror started watching a wallet are copied.
const DATA = 'https://data-api.polymarket.com';
export const MIRROR_SOURCE = Object.freeze({ leaders: 16, everyMs: 60e3, minVolUsd: 100_000, repickMs: 7 * 86400e3 });
export function pickSportsLeaders(rows, now, { leaders = MIRROR_SOURCE.leaders, minVolUsd = MIRROR_SOURCE.minVolUsd, overlap = {} } = {}) {
  return (Array.isArray(rows) ? rows : []).filter(r => /^0x[0-9a-fA-F]{40}$/.test(String(r?.proxyWallet)) && Number(r.pnl) > 0 && Number(r.vol) >= minVolUsd)
    .sort((a, b) => { const score = r => { const x = overlap[String(r.proxyWallet).toLowerCase()]; return x?.checked >= 5 ? (x.matched || 0) / x.checked : 0; }; return score(b) - score(a); })
    .slice(0, leaders).map(r => ({ wallet: String(r.proxyWallet).toLowerCase(), name: String(r.userName || String(r.proxyWallet).slice(0, 8)).slice(0, 40), since: now, source: 'sports-leaderboard; observed target overlap ranked when available' }));
}
export const MIRROR_DEFAULTS = Object.freeze({ enabled: true, startUsd: 12.5, stakeUsd: 1, maxOpen: 10, maxChase: 0.05, minPrice: 0.05, maxPrice: 0.95 });
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const norm = s => String(s || '').toLowerCase().replace(/^(will |who will win:? )/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const MAX_TRADE_AGE_MS = 30 * 60e3;
const validTrade = (q, now) => ['BUY', 'SELL'].includes(q.side || 'BUY') && typeof q.key === 'string' && q.key && typeof q.title === 'string' && typeof q.outcome === 'string' && Number.isFinite(q.price) && q.price > 0 && q.price < 1 && Number.isSafeInteger(q.ts) && q.ts > 0 && q.ts <= now && (q.side === 'SELL' || now - q.ts <= MAX_TRADE_AGE_MS);
const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function validateState(s) {
  if (!s || s.schema !== SCHEMA || !Number.isSafeInteger(s.epoch) || s.epoch < 1 || !nonnegative(s.cashUsd) || !nonnegative(s.startUsd) || s.startUsd < 1 || !s.settings || typeof s.settings.enabled !== 'boolean') throw new Error('invalid mirror book or balance');
  const st = s.settings;
  if (!(nonnegative(st.startUsd) && st.startUsd >= 1 && st.startUsd <= 100000 && nonnegative(st.stakeUsd) && st.stakeUsd >= 1 && st.stakeUsd <= 250 && Number.isSafeInteger(st.maxOpen) && st.maxOpen >= 1 && st.maxOpen <= 100 && nonnegative(st.maxChase) && st.maxChase <= .2 && nonnegative(st.minPrice) && st.minPrice > 0 && st.minPrice <= st.maxPrice && nonnegative(st.maxPrice) && st.maxPrice < 1)) throw new Error('invalid mirror settings');
  for (const key of ['queue', 'open', 'history', 'decisions', 'seen']) if (!Array.isArray(s[key])) throw new Error(`invalid mirror ${key}`);
  if (s.queue.length > 50 || s.open.length > 100 || s.decisions.length > 60 || s.seen.length > 3000 || s.seen.some(x => typeof x !== 'string')) throw new Error('invalid mirror journal bounds');
  if (s.queue.some(q => !q || typeof q.key !== 'string' || !q.key || typeof q.title !== 'string' || typeof q.outcome !== 'string' || !Number.isFinite(q.price) || q.price <= 0 || q.price >= 1 || !Number.isSafeInteger(q.ts) || q.ts <= 0)) throw new Error('invalid queued trade');
  const tickers = new Set();
  for (const p of [...s.open, ...s.history]) {
    if (!p || typeof p.ticker !== 'string' || !p.ticker || !Number.isSafeInteger(p.qty) || p.qty < 1 || !nonnegative(p.costUsd) || !nonnegative(p.feeUsd) || p.markUsd != null && !nonnegative(p.markUsd)) throw new Error('invalid mirror position');
  }
  for (const p of s.open) { if (tickers.has(p.ticker)) throw new Error('duplicate open ticker'); tickers.add(p.ticker); }
  if (s.history.some(p => !Number.isFinite(p.pnlUsd) || !nonnegative(p.payoutUsd) || !['YES', 'NO'].includes(p.outcome))) throw new Error('invalid mirror settlement');
  return s;
}

// A board participant like "DEN Broncos" is Kalshi's side "Denver": the names differ, the ticker suffix (-DEN) does not.
export function sideMatches(participant, c) {
  if (sameName(participant, c.side)) return true;
  const code = String(participant || '').trim().split(/\s+/)[0];
  return /^[A-Z]{2,4}$/.test(code) && String(c.sourceId || '').split('-').pop() === code;
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
  if (!matched.length) return kalshiOnlyTarget(trade, events, day);
  if (matched.length !== 1) return { reason: 'ambiguous game: market identity or game date is required' };
  const { e, pm } = matched[0];
  if (!Array.isArray(e.participants) || e.participants.length !== 2) return { reason: 'game participants are not established' };
  const teams = e.participants.filter(p => outcome && sameName(p, outcome));
  if (teams.length !== 1) return { reason: 'outcome is not exactly one of the two teams' };
  const team = teams[0];
  const candidates = (e.contracts || []).filter(c => c.venue === 'kalshi' && c.type === 'GAME_WINNER' && c.sourceId && c.side && sideMatches(team, c));
  if (candidates.length !== 1 || e.participants.filter(p => sideMatches(p, candidates[0])).length !== 1) return { reason: 'no unambiguous Kalshi game-winner contract for this game' };
  return { event: e, team, contract: candidates[0], polymarket: pm };
}

// When the sports board has no Polymarket contract for the game (it carries few; mostly tennis), match the Kalshi game
// directly: a dated game (from the trade's event slug) whose two participants are exactly the two teams in a
// "Team A vs. Team B" title, with the bought outcome one of them; or "Will Team win on YYYY-MM-DD?" bought YES.
// Spreads, totals, props and draws never match ("vs." titles with a colon or "draw" are refused).
export function kalshiOnlyTarget(trade, events = [], day = null) {
  const raw = String(trade.title || '').trim(), out = String(trade.outcome || '').trim();
  let teams = null, team = null;
  const vs = raw.match(/^(.+?)\s+vs\.?\s+(.+?)$/i), win = raw.match(/^will (.+?) win on (20\d{2}-\d{2}-\d{2})\??$/i);
  if (vs && !/[:?]/.test(raw) && !/draw/i.test(raw)) { teams = [vs[1], vs[2]]; team = teams.find(t => sameName(t, out)) || null; }
  else if (win && /^yes$/i.test(out)) { team = win[1]; day ||= win[2]; }
  if (!team || !day) return { reason: 'not a game-winner market Kalshi also lists' };
  const games = events.filter(e => e.day === day && Array.isArray(e.participants) && e.participants.length === 2
    && e.participants.some(p => sameName(p, team)) && (!teams || teams.every(t => e.participants.some(p => sameName(p, t))))
    && (e.contracts || []).some(c => c.venue === 'kalshi' && c.type === 'GAME_WINNER'));
  if (!games.length) return { reason: 'not a game-winner market Kalshi also lists' };
  if (games.length !== 1) return { reason: 'ambiguous game: market identity or game date is required' };
  const e = games[0], side = e.participants.filter(p => sameName(p, team));
  if (side.length !== 1) return { reason: 'outcome is not exactly one of the two teams' };
  const candidates = (e.contracts || []).filter(c => c.venue === 'kalshi' && c.type === 'GAME_WINNER' && c.sourceId && c.side && sideMatches(side[0], c));
  if (candidates.length !== 1) return { reason: 'no unambiguous Kalshi game-winner contract for this game' };
  return { event: e, team: side[0], contract: candidates[0], polymarket: null, matchedBy: 'kalshi-only (date + both teams)' };
}

export class KalshiMirrorPaper {
  constructor({ dataDir, kalshi = () => null, sports = async () => null, fetchImpl = null, readCache = null, now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'kalshi-mirror-paper.json'); this.kalshi = kalshi; this.sports = sports; this.fetch = fetchImpl; this.now = now; this.busy = false; this.recoveryError = null; this.state = this.load();
    this.readCache = readCache;
  }
  fresh(start = MIRROR_DEFAULTS.startUsd, settings = MIRROR_DEFAULTS, epoch = 1) { return { schema: SCHEMA, epoch, startUsd: start, cashUsd: start, settings: { ...settings, startUsd: start }, queue: [], open: [], history: [], decisions: [], seen: [], lastRunAt: null, lastError: null, lastNote: null }; }
  load() {
    try { if (fs.statSync(this.file).size > 64 * 1024 * 1024) throw new Error('mirror book exceeds read budget'); const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); return validateState(s); }
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
    const key = tradeKey(leader?.wallet || leader?.name, { ...t, side: t.side || 'BUY' }); if (this.state.seen.includes(key) || this.state.seen.includes(`${t.transactionHash}:${t.asset}`)) return;
    const q = { key, leader: String(leader?.name || ''), title: String(t.title || t.slug || ''), outcome: String(t.outcome || ''), price: Number(t.price), ts: Number(t.timestamp) * 1000,
      asset: t.asset, conditionId: t.conditionId, marketId: t.marketId, slug: t.slug, eventSlug: t.eventSlug, day: t.day || t.date,
      wallet: leader?.wallet || null, side: t.side || 'BUY', sourceTradeId: t.transactionHash, sourceQuantity: Number(t.size) || null, sourceAt: Number(t.timestamp) * 1000, firstObservedAt: this.now(), leaderSelection: { ...leader }, attempts: 0 };
    if (!t.transactionHash || !t.asset || !validTrade(q, this.now())) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'invalid, future or stale leader trade' }); this.save(); return; }
    this.state.seen.push(key); if (this.state.seen.length > 3000) this.state.seen.splice(0, this.state.seen.length - 3000);
    this.state.queue.push(q); let queueError = null;
    if (this.state.queue.length > 50) {
      const droppedIndex = this.state.queue.findIndex(x => x.side !== 'SELL');
      if (droppedIndex >= 0) { const [dropped] = this.state.queue.splice(droppedIndex, 1); this.decide({ leader: dropped.leader, title: dropped.title, action: 'SKIP', reason: 'bounded mirror entry queue full; exits prioritized' }); }
      else {
        this.state.queue.pop(); this.state.seen = this.state.seen.filter(k => k !== key); queueError = 'mirror exit queue full; source handoff left retryable'; this.decide({ action: 'WAIT', reason: queueError });
      }
    } this.save(); if (queueError) throw new Error(queueError);
  }

  async get(url) { const loader = async () => { const r = await this.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'MoneyPrinterOS/0.5' }, signal: AbortSignal.timeout?.(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }; return this.readCache ? this.readCache.get(url, loader) : loader(); }
  // Watch the week's top sports-leaderboard wallets and queue their new BUYs (see MIRROR_SOURCE).
  async pollSportsLeaders() {
    const s = this.state; if (!this.fetch || !s.settings.enabled && !s.open.length) return 0;
    s.sports ||= { leaders: [], pickedAt: 0, lastAt: 0, queued: 0 };
    if (this.now() - s.sports.lastAt < MIRROR_SOURCE.everyMs) return 0;
    s.sports.lastAt = this.now();
    if (s.sports.leaders.length < MIRROR_SOURCE.leaders || this.now() - s.sports.pickedAt > MIRROR_SOURCE.repickMs) { // kept leaders keep their watch-start
      const rows = await this.get(`${DATA}/v1/leaderboard?category=SPORTS&timePeriod=WEEK&orderBy=PNL&limit=50`);
      let board = null; try { board = await this.sports(); } catch {}
      const overlap = { ...(s.leaderOverlap || {}) };
      if (Array.isArray(board?.events) && board.events.length) {
        // Historical previews only rank capability overlap. They never enter the forward book.
        const eligible = pickSportsLeaders(rows, this.now(), { leaders: 24 });
        const previews = await boundedCopyMap(eligible, async leader => {
          try { const trades = await this.get(`${DATA}/trades?user=${leader.wallet}&limit=50&offset=0&takerOnly=false`); const buys = (Array.isArray(trades) ? trades : []).filter(t => t.side === 'BUY'); return { wallet: leader.wallet, checked: buys.length, matched: buys.filter(t => mirrorTarget(t, board.events).contract).length, at: this.now(), historicalOnly: true, pages: 1 }; } catch { return { wallet: leader.wallet, checked: 0, matched: 0, at: this.now(), unavailable: true, historicalOnly: true }; }
        });
        s.sports.selectionOverlap = previews; for (const p of previews) if (!overlap[p.wallet]?.checked) overlap[p.wallet] = p;
      }
      const picked = pickSportsLeaders(rows, this.now(), { overlap });
      const kept = new Map(s.sports.leaders.map(l => [l.wallet, l]));
      s.sports.exitLeaders ||= [];
      s.sports.exitLeaders.push(...s.sports.leaders.filter(l => !picked.some(p => p.wallet === l.wallet) && s.open.some(p => p.leaderWallet === l.wallet)));
      s.sports.leaders = picked.map(l => kept.get(l.wallet) || l); s.sports.pickedAt = this.now();
    }
    let queued = 0;
    const watched = [...new Map([...s.sports.leaders, ...(s.sports.exitLeaders || [])].filter(l => s.settings.enabled && s.sports.leaders.includes(l) || s.open.some(p => p.leaderWallet === l.wallet)).map(l => [l.wallet, l])).values()];
    for (const L of watched) {
      let trades = []; try { const page = await fetchLeaderTrades(u => this.get(u), L.wallet, { boundaryAt: Math.max(L.since, this.now() - MAX_TRADE_AGE_MS) }); trades = page.trades; L.catchup = { at: this.now(), pages: page.pages, complete: page.complete }; } catch { continue; }
      for (const t of (Array.isArray(trades) ? trades : []).slice().reverse()) {
        if (!['BUY', 'SELL'].includes(t?.side) || !(Number(t.timestamp) * 1000 > L.since)) continue;
        const before = s.queue.length; this.enqueue(L, t); if (s.queue.length > before) queued++;
      }
    }
    s.sports.queued += queued; return queued;
  }

  async run({ settlement = true } = {}) {
    if (this.recoveryError) throw new Error(this.recoveryError);
    if (this.busy) return this.snapshot(); this.busy = true;
    const s = this.state, st = s.settings;
    try {
      const k = this.kalshi(); if (!k) throw new Error('Kalshi provider unavailable');
      try { await this.pollSportsLeaders(); } catch (e) { this.decide({ action: 'SKIP', reason: 'sports leaderboard unavailable: ' + String(e.message || e).slice(0, 120) }); }
      const queue = s.queue.slice(); let entered = 0;
      if (queue.length) {
        // Source exits need the target book, never a fresh sports discovery board.
        for (const q of queue.filter(q => q.side === 'SELL')) {
          const p = s.open.find(p => p.sourceAsset === q.asset && (q.wallet ? p.leaderWallet === q.wallet : p.leader === q.leader));
          if (!p || await this.exit(k, q, p)) { s.queue = s.queue.filter(x => x.key !== q.key); this.save(); }
        }
        const board = st.enabled && queue.some(q => q.side !== 'SELL') ? await this.sports() : { events: [] };
        if (!Array.isArray(board?.events)) throw new Error('Sports board unavailable; queued trades retained');
        s.capabilities = { at: this.now(), supportedTypes: ['GAME_WINNER'], listedGames: board.events.filter(e => e.contracts?.some(c => c.venue === 'kalshi' && c.type === 'GAME_WINNER')).length, listedContracts: board.events.flatMap(e => e.contracts || []).filter(c => c.venue === 'kalshi' && c.type === 'GAME_WINNER').length, unsupportedTypes: ['SPREAD', 'TOTAL', 'PROP', 'WEATHER', 'CRYPTO', 'MACRO'], note: 'Unsupported or nonidentical settlement rules supply research features only; never mirror fills' };
        for (const q of queue) {
          const consume = () => { s.queue = s.queue.filter(x => x.key !== q.key); this.save(); };
          if (!validTrade(q, this.now())) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'invalid, future or stale leader trade' }); consume(); continue; }
          q.attempts = (q.attempts || 0) + 1; q.decisionAt = this.now();
          if (q.side === 'SELL') continue;
          if (!st.enabled) continue;
          const m = mirrorTarget(q, board?.events || []);
          s.matcher ||= {since:this.now(),checked:0,matched:0,misses:{}};
          if (!q.matcherCounted) {
          s.matcher.checked++;
          if(m.contract)s.matcher.matched++;else s.matcher.misses[m.reason||'unknown']=(s.matcher.misses[m.reason||'unknown']||0)+1;
          s.leaderOverlap ||= {}; const overlap = s.leaderOverlap[q.wallet || q.leader] ||= { checked: 0, matched: 0, filled: 0 }; overlap.checked++; if (m.contract) overlap.matched++; q.matcherCounted = true;
          }
          if (!m.contract) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: m.reason }); consume(); continue; }
          if (s.open.some(p => p.ticker === m.contract.sourceId)) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'already holding this team' }); consume(); continue; }
          if (s.open.length >= st.maxOpen) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'max open mirrors' }); consume(); continue; }
          this.retryReason = null;
          if (await this.enter(k, q, m)) { entered++; s.matcher.filled = (s.matcher.filled || 0) + 1; s.leaderOverlap[q.wallet || q.leader].filled++; consume(); }
          else if (!this.retryReason) consume();
        }
      }
      if (settlement) await this.settle(k);
      s.lastNote = `${queue.length} leader events checked · ${entered} mirrored on Kalshi`; s.lastError = null;
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
    q.quoteAt = this.now();
    if (!validTrade(q, this.now())) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'leader trade expired during lookup' }); return false; }
    let fills = walkAsks(book, 'YES', Math.floor(budget / ask), Math.min(st.maxPrice, q.price + st.maxChase));
    if (fills.some(f => !Number.isFinite(f.price) || f.price < st.minPrice || !Number.isSafeInteger(f.quantity))) throw new Error('Invalid Kalshi book; queued trade retained');
    let qty = fills.reduce((a, f) => a + f.quantity, 0), cost = fills.reduce((a, f) => a + f.price * f.quantity, 0), fee = takerFee(d.feeModel, fills);
    if (fee != null && Number.isFinite(fee) && cost + fee > budget + 1e-9) {
      let lo = 0, hi = qty;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2), trial = walkAsks(book, 'YES', mid, Math.min(st.maxPrice, q.price + st.maxChase)); const charge = trial.reduce((a, f) => a + f.price * f.quantity, 0) + takerFee(d.feeModel, trial); if (charge <= budget + 1e-9) lo = mid; else hi = mid - 1; }
      fills = walkAsks(book, 'YES', lo, Math.min(st.maxPrice, q.price + st.maxChase)); qty = lo; cost = fills.reduce((a, f) => a + f.price * f.quantity, 0); fee = takerFee(d.feeModel, fills);
    }
    if (qty < 1) { this.retryReason = 'no Kalshi depth at the price'; this.decide({ leader: q.leader, title: q.title, action: 'WAIT', reason: this.retryReason }); return false; }
    if (fee == null || !Number.isFinite(fee) || fee < 0) { this.retryReason = 'Kalshi fee model unavailable'; this.decide({ leader: q.leader, title: q.title, action: 'WAIT', reason: this.retryReason }); return false; }
    if (cost + fee > s.cashUsd) { this.decide({ leader: q.leader, title: q.title, action: 'SKIP', reason: 'not enough paper cash' }); return false; }
    s.cashUsd = round(s.cashUsd - cost - fee, 6);
    s.open.push({ ticker, team: m.team, game: m.event.participants.join(' vs '), sport: m.event.sport, leader: q.leader, leaderPrice: round(q.price, 4), qty, avgPrice: round(cost / qty, 4), costUsd: round(cost, 4), feeUsd: round(fee, 4), openedAt: this.now(), closeAt: m.contract.closeAt || null, markUsd: round(cost, 4) });
    Object.assign(s.open.at(-1), { leaderWallet: q.wallet, sourceAsset: q.asset, sourceTradeId: q.sourceTradeId, sourceEntryQty: q.sourceQuantity, leaderAt: q.sourceAt || q.ts, firstObservedAt: q.firstObservedAt, decisionAt: q.decisionAt, quoteAt: q.quoteAt, leaderSelection: q.leaderSelection, marketType: 'GAME_WINNER', exitPolicy: 'entry-relative leader exit where quantity known; otherwise leader full-exit; authoritative Kalshi settlement', matching: { method: m.matchedBy || 'exact source contract', eventDay: m.event.day, team: m.team, type: m.contract.type, rules: m.contract.rules || m.contract.settlementRules || null }, feeModel: d.feeModel, fills });
    s.queue = s.queue.filter(x => x.key !== q.key); this.save();
    this.decide({ leader: q.leader, title: q.title, team: m.team, action: 'MIRROR', price: round(cost / qty, 3), leaderPrice: round(q.price, 3) });
    return true;
  }
  async settle(k) {
    const s = this.state;
    for (const p of s.open.slice()) {
      let m = null; try { m = await paced(() => k.market(p.ticker)); } catch { continue; }
      if (!s.open.includes(p)) continue;
      const d = m?.data || {}, out = d.settlementOutcome;
      if (out === 'YES' || out === 'NO') {
        const won = out === 'YES', payout = won ? p.qty : 0; s.cashUsd = round(s.cashUsd + payout, 6);
        s.history.unshift({ ...p, outcome: out, won, payoutUsd: payout, pnlUsd: round(payout - p.costUsd - p.feeUsd, 4), settledAt: this.now() });
        s.open = s.open.filter(x => x !== p); this.save(); continue;
      }
      if (Number.isFinite(d.yesBid) && d.yesBid >= 0 && d.yesBid <= 1) p.markUsd = round(d.yesBid * p.qty, 4);
    }
  }
  async exit(k, q, p) {
    const s = this.state;
    if (q.remainingExitQty == null) {
      const ratio = p.sourceEntryQty > 0 && q.sourceQuantity > 0 ? Math.min(1, q.sourceQuantity / p.sourceEntryQty) : 1;
      q.remainingExitQty = Math.min(p.qty, Math.max(1, Math.floor(p.qty * ratio))); this.save();
    }
    const book = await paced(() => k.book(p.ticker)); if (!s.open.includes(p)) return true;
    let left = Math.min(p.qty, q.remainingExitQty); const fills = [];
    for (const level of (book?.yes?.bids || []).slice().sort((a, b) => b.price - a.price)) {
      const price = Number(level.price), quantity = Math.min(left, Math.floor(Number(level.quantity)));
      if (!(price >= 0 && price <= 1) || !Number.isSafeInteger(quantity) || quantity <= 0) continue;
      fills.push({ price, quantity }); left -= quantity; if (!left) break;
    }
    const sold = fills.reduce((n, f) => n + f.quantity, 0), fee = takerFee(p.feeModel, fills);
    if (!sold || !Number.isFinite(fee) || fee < 0) { this.decide({ leader: q.leader, action: 'WAIT', reason: 'leader exit retained: executable bids or fee model unavailable' }); return false; }
    const fraction = sold / p.qty, cost = p.costUsd * fraction, entryFee = p.feeUsd * fraction, proceeds = fills.reduce((n, f) => n + f.price * f.quantity, 0);
    const h = { ...p, qty: sold, costUsd: cost, feeUsd: entryFee, outcome: 'YES', won: proceeds - fee - cost - entryFee > 0, payoutUsd: proceeds, pnlUsd: round(proceeds - fee - cost - entryFee, 4), exitFeeUsd: fee, status: 'LEADER_SOLD', exitQuoteAt: this.now(), exitSourceTradeId: q.sourceTradeId, exitFills: fills, settledAt: this.now() };
    s.cashUsd = round(s.cashUsd + proceeds - fee, 6); q.remainingExitQty -= sold;
    if (sold === p.qty) s.open = s.open.filter(x => x !== p);
    else { p.qty -= sold; p.costUsd = round(p.costUsd - cost, 6); p.feeUsd = round(p.feeUsd - entryFee, 6); p.markUsd *= 1 - fraction; if (p.sourceEntryQty > 0) p.sourceEntryQty *= 1 - fraction; }
    s.history.unshift(h);
    if (!q.remainingExitQty || !s.open.includes(p)) s.queue = s.queue.filter(x => x.key !== q.key);
    this.save(); return !q.remainingExitQty || !s.open.includes(p);
  }
  async runSettlement() { if (this.recoveryError) throw new Error(this.recoveryError); if (this.settlementBusy) return this.snapshot(); const k = this.kalshi(); if (!k) return this.snapshot(); this.settlementBusy = true; try { await this.settle(k); } finally { this.settlementBusy = false; this.save(); } return this.snapshot(); }
  snapshot() {
    if (this.recoveryError) return { id: 'kalshimirror', label: 'Kalshi mirror of Polymarket leaders', mode: 'PAPER', recoveryRequired: true, startUsd: null, cashUsd: null, equityUsd: null, returnPct: null, settings: this.state.settings, queued: 0, open: [], history: [], decisions: [], stats: { settled: null, wins: null, pnlUsd: null, feesUsd: null }, lastRunAt: null, lastError: this.recoveryError, lastNote: 'Existing book preserved; recovery required', running: this.busy };
    const s = this.state, h = s.history, n = h.length, open = s.open.reduce((a, p) => a + (p.markUsd ?? p.costUsd), 0), equity = s.cashUsd + open;
    return { id: 'kalshimirror', label: 'Kalshi mirror of Polymarket leaders', mode: 'PAPER', epoch: s.epoch, settings: s.settings, startUsd: s.startUsd, cashUsd: round(s.cashUsd, 2), equityUsd: round(equity, 2), returnPct: round((equity - s.startUsd) / s.startUsd * 100, 2),
      queued: s.queue.length, open: s.open, history: h.slice(0, 50), decisions: s.decisions.slice(0, 30), matcher:s.matcher||null, capabilities: s.capabilities || null, leaderOverlap: s.leaderOverlap || {}, exitPolicy: 'leader exit when attributable; legacy source-unknown positions hold to settlement', sportsLeaders:s.sports?{watching:s.sports.leaders.length,pickedAt:s.sports.pickedAt,lastAt:s.sports.lastAt,queued:s.sports.queued,names:s.sports.leaders.map(l=>l.name),selectionOverlap:s.sports.selectionOverlap||[]}:null,attribution:copyAttribution(h),
      stats: { settled: n, wins: h.filter(x => x.won).length, pnlUsd: round(h.reduce((a, x) => a + x.pnlUsd, 0), 2), feesUsd: round(h.reduce((a, x) => a + x.feeUsd + (x.exitFeeUsd || 0), 0), 2) },
      lastRunAt: s.lastRunAt, lastError: this.recoveryError || s.lastError, lastNote: s.lastNote, running: this.busy };
  }
}
