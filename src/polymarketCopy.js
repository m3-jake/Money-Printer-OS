// Polymarket copy trading, PAPER ONLY (2026-10-02). Public data only: the data-api leaderboard and per-wallet
// trades, the CLOB order book for fills and Gamma for fees and resolution. No order code exists here.
//
// Honesty rules, because copy-trading backtests are where survivorship bias lives:
//  - Wallets are chosen from the leaderboard at a recorded point in time (followedAt, rank, pnl, volume).
//  - Only trades the leader makes AFTER followedAt are copied. Nothing before that counts.
//  - A copy fills at the live book when we notice the trade (up to a minute late), walking the asks/bids,
//    never at the leader's price. A copy whose ask is more than maxChase above the leader's price is skipped.
//  - Taker fees use the market's own fee schedule (fee = C × rate × p × (1 − p)).
// Prices here are global Polymarket (polymarket.com), not Polymarket US, and the window says so.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomicSync } from './atomicRename.js';
import { takerFee, polymarketFeeModel } from './core/fees.js';
import { copyAttribution, copyRisk, COPY_EVICT_MIN_CLOSES } from './copyAttribution.js';
import { copyEvent, tradeKey, validCopyTrade, fetchLeaderTrades, classifyCopyMarket, CopyMetadataCache, boundedCopyMap, copyLatencySummary } from './copyEvent.js';

const SCHEMA = 'mpo.polymarket-copy-paper.v1';
const DATA = 'https://data-api.polymarket.com', CLOB = 'https://clob.polymarket.com', GAMMA = 'https://gamma-api.polymarket.com';
export const COPY_DEFAULTS = Object.freeze({ enabled: true, startUsd: 500, stakeUsd: 10, maxOpen: 25, follows: 6, minLeaderTradeUsd: 100, minPrice: 0.05, maxPrice: 0.95, maxChase: 0.03, minLeaderVolumeUsd: 100000, minLeaderMargin: 0.02, refollowDays: 7, maxTradeAgeMs: 30 * 60000, processingLatencyMs: 0 });
const LIMITS = { stakeUsd: [1, 250], maxOpen: [1, 100], follows: [1, 20], minLeaderTradeUsd: [1, 100000], minPrice: [0.01, 0.5], maxPrice: [0.5, 0.99], maxChase: [0, 0.2], minLeaderVolumeUsd: [0, 1e9], minLeaderMargin: [0, 1], refollowDays: [1, 90], startUsd: [10, 100000], maxTradeAgeMs: [1000, 86400000], processingLatencyMs: [0, 60000] };
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const short = w => `${String(w).slice(0, 6)}…${String(w).slice(-4)}`;

// Pick wallets to follow from a leaderboard snapshot: real volume, a profit margin that is not just market
// making, and not already followed. Returns follow records stamped with the snapshot time.
export function pickLeaders(rows, settings, already = new Set(), at = Date.now()) {
  return (rows || []).filter(r => r.proxyWallet && !already.has(r.proxyWallet.toLowerCase()) && Number(r.vol) >= settings.minLeaderVolumeUsd && Number(r.pnl) > 0 && Number(r.pnl) / Math.max(1, Number(r.vol)) >= settings.minLeaderMargin)
    .slice(0, settings.follows).map(r => ({ wallet: r.proxyWallet.toLowerCase(), name: r.userName && !/^0x[0-9a-f]{20,}/i.test(r.userName) ? r.userName : short(r.proxyWallet), followedAt: at, rank: Number(r.rank), pnlAtFollow: round(Number(r.pnl), 0), volAtFollow: round(Number(r.vol), 0), source: 'leaderboard WEEK by PnL' }));
}
// Walk one side of a CLOB book. asks ascending for buys (spend up to usd), bids descending for sells (sell qty).
export function walkBuy(asks, usd, limitPrice) {
  let left = usd; const fills = [];
  for (const l of asks) { const p = Number(l.price), size = Number(l.size); if (left <= 1e-9 || p > limitPrice) break; const q = Math.min(size, left / p); if (q > 0) { fills.push({ price: p, quantity: q }); left -= q * p; } }
  return fills;
}
export function walkSell(bids, qty) {
  let left = qty; const fills = [];
  for (const l of bids) { const p = Number(l.price), size = Number(l.size); if (left <= 1e-9) break; const q = Math.min(size, left); if (q > 0) { fills.push({ price: p, quantity: q }); left -= q; } }
  return fills;
}
const sortBook = b => ({ asks: (b?.asks || []).slice().sort((x, y) => x.price - y.price), bids: (b?.bids || []).slice().sort((x, y) => y.price - x.price) });

export class PolymarketCopyPaper {
  constructor({ dataDir, tape = null, onLeaderBuy = null, onLeaderEvent = null, metadataCache = null, readCache = null, experiment = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'polymarket-copy-paper.json'); this.tape = tape; this.onLeaderBuy = onLeaderBuy; this.fetch = fetchImpl; this.now = now; this.busy = false; this.recoveryError = null; this.state = this.load();
    this.onLeaderEvent = onLeaderEvent; this.metadataCache = metadataCache || new CopyMetadataCache({ now }); this.readCache = readCache;
    this.state.intents ||= {}; this.state.cursors ||= {}; this.state.exitLeaders ||= []; this.state.sourceHoldings ||= {}; this.state.receipts ||= [];
    if (experiment && !this.recoveryError) {
      if (!experiment.id || !['direct', 'liquidity-scaled', 'no-trade', 'random-eligible', 'category-specialist'].includes(experiment.policy)) throw new Error('copy experiment requires id and executable policy');
      if (experiment.policy === 'category-specialist' && !['SPORTS', 'CRYPTO'].includes(experiment.category)) throw new Error('category-specialist requires supported SPORTS or CRYPTO scope');
      if (this.state.experiment && this.state.experiment.id !== experiment.id) throw new Error('immutable copy experiment identity mismatch');
      const identity = { id: experiment.id, policy: experiment.policy, ...(experiment.category ? { category: experiment.category } : {}), exploratory: experiment.exploratory === true, startUsd: experiment.startUsd ?? 25, settings: Object.fromEntries(Object.entries(experiment.settings || {}).sort(([a], [b]) => a.localeCompare(b))) };
      const strategyHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      if (this.state.experiment?.strategyHash && this.state.experiment.strategyHash !== strategyHash) throw new Error('immutable copy experiment parameters mismatch');
      if (!this.state.experiment && fs.existsSync(this.file)) throw new Error('existing incumbent cannot be relabeled as an experiment');
      if (!this.state.experiment) {
        const start = experiment.startUsd ?? 25; if (!(start >= 10 && start <= 100000)) throw new Error('invalid experiment funding');
        this.state.startUsd = this.state.cashUsd = start; this.state.settings = { ...COPY_DEFAULTS, ...experiment.settings, startUsd: start };
        for (const [key, [min, max]] of Object.entries(LIMITS)) if (!(Number.isFinite(this.state.settings[key]) && this.state.settings[key] >= min && this.state.settings[key] <= max)) throw new Error(`invalid experiment ${key}`);
        this.state.experiment = { ...experiment, strategyHash, startedAt: this.now(), qualification: 'UNQUALIFIED_EXPLORATORY', fundingUsd: start, leaderSelectionPolicy: experiment.policy === 'random-eligible' ? 'deterministic random eligible leaderboard control' : 'point-in-time public leaderboard; after-cost follower eviction' }; this.save();
      }
    }
  }
  fresh(start = COPY_DEFAULTS.startUsd, settings = COPY_DEFAULTS, epoch = 1) { return { schema: SCHEMA, epoch, startUsd: start, cashUsd: start, settings: { ...settings, startUsd: start }, follows: [], open: [], history: [], decisions: [], seen: [], lastRunAt: null, lastError: null, lastNote: null }; }
  load() {
    try { if (!fs.existsSync(this.file)) return this.fresh(); const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (s.schema !== SCHEMA) throw new Error('unknown schema'); if (!Number.isFinite(s.cashUsd) || s.cashUsd < 0 || !(s.startUsd > 0) || !['open', 'history', 'follows', 'seen', 'decisions'].every(k => Array.isArray(s[k])) || s.open.some(p => !(p.qty > 0) || !Number.isFinite(p.costUsd) || !Number.isFinite(p.feeUsd))) throw new Error('invalid copy balance or positions'); s.settings = { ...COPY_DEFAULTS, ...s.settings }; return s; }
    catch (e) { this.recoveryError = `Copy book unreadable (${e.message}); the file was kept. Reset to start a new book.`; return this.fresh(); }
  }
  save() { if (this.recoveryError) return; fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeFileAtomicSync(this.file, JSON.stringify(this.state)); }
  async get(url) { const loader = async () => { const r = await this.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'MoneyPrinterOS/0.5' }, signal: AbortSignal.timeout?.(15000) }); if (!r.ok) { const e = new Error(`HTTP ${r.status} from ${new URL(url).host}`); e.status = r.status; throw e; } return r.json(); }; return this.readCache ? this.readCache.get(url, loader) : loader(); }
  decide(row) { this.state.decisions.unshift({ at: this.now(), ...row }); this.state.decisions.length = Math.min(this.state.decisions.length, 60); }
  configure(patch = {}) {
    if (this.state.experiment && Object.entries(patch).some(([k, v]) => k !== 'enabled' && k in COPY_DEFAULTS && v !== this.state.settings[k])) throw new Error('Experiment parameters are immutable; create a separately funded cohort');
    const out = {};
    for (const [k, v] of Object.entries(patch)) { if (!(k in COPY_DEFAULTS)) continue; if (k === 'enabled') { out.enabled = !!v; continue; } const n = Number(v), [a, b] = LIMITS[k]; if (!Number.isFinite(n) || n < a || n > b) throw new Error(`${k} must be between ${a} and ${b}`); out[k] = n; }
    this.state.settings = { ...this.state.settings, ...out }; this.save(); return this.snapshot();
  }
  reset({ startUsd, confirmation } = {}) {
    if (confirmation !== 'RESET BOT') throw new Error('Type RESET BOT to confirm');
    if (this.busy) throw new Error('Copy bot is running; wait before resetting');
    const start = startUsd == null ? this.state.settings.startUsd : Number(startUsd); if (!(start >= 10 && start <= 100000)) throw new Error('startUsd must be between 10 and 100000');
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.pre-reset-${this.now()}`, fs.constants.COPYFILE_EXCL);
    this.recoveryError = null; this.state = { ...this.fresh(start, this.state.settings, (this.state.epoch || 1) + 1), intents: {}, cursors: {}, exitLeaders: [], sourceHoldings: {}, receipts: [] }; this.save(); return this.snapshot();
  }
  unfollow(wallet) { const w = String(wallet).toLowerCase(), f = this.state.follows.find(f => f.wallet === w); if (f && this.state.open.some(p => p.leader === w)) this.state.exitLeaders.push(f); this.state.follows = this.state.follows.filter(f => f.wallet !== w); this.save(); return this.snapshot(); }
  async market(asset, force = false) {
    return this.metadataCache.get(asset, async () => {
    for (const q of [`clob_token_ids=${asset}`, `clob_token_ids=${asset}&closed=true`]) { const r = await this.get(`${GAMMA}/markets?${q}`); if (Array.isArray(r) && r[0]) return r[0]; }
    return null;
    }, force);
  }

  async run({ settlement = true } = {}) {
    if (this.recoveryError) throw new Error(this.recoveryError);
    if (this.busy) return this.snapshot(); this.busy = true;
    const s = this.state, st = s.settings;
    try {
      const risk=copyRisk(s);
      if(risk.active&&!s.drawdownPause?.active&&!s.experiment?.exploratory)this.decide({action:'PAUSE',reason:risk.reason});
      s.drawdownPause = s.experiment?.exploratory ? { ...risk, active: false, observedDrawdown: risk.active, reason: 'Separate unqualified aggressive paper cohort; incumbent qualification and pause preserved' } : s.drawdownPause?.active?s.drawdownPause:risk;
      s.evicted ||= {};
      for(const f of s.follows){const h=s.history.filter(r=>r.leader===f.wallet&&Number.isFinite(r.pnlUsd));
        const closedPositions = new Set(h.filter(r => !s.open.some(p => p.id === (r.parentPositionId || r.id))).map(r => r.parentPositionId || r.id));
        if(closedPositions.size>=COPY_EVICT_MIN_CLOSES&&h.reduce((t,r)=>t+r.pnlUsd,0)<0&&!s.evicted[f.wallet]){
          s.evicted[f.wallet]={at:this.now(),n:closedPositions.size,pnlUsd:h.reduce((t,r)=>t+r.pnlUsd,0)};
          this.decide({leader:f.name,action:'EVICT',reason:'our realized copies lost money after at least 5 closes; existing holdings keep exit monitoring'});
        }
      }
      if (st.enabled || s.open.length || Object.values(s.intents).some(i => i.status === 'PENDING')) {
        // Keep up to `follows` leaders; drop ones followed longer than refollowDays ago and refill from a fresh snapshot.
        const cutoff = this.now() - st.refollowDays * 86400e3;
        const retired = s.follows.filter(f => f.followedAt < cutoff || s.evicted[f.wallet]);
        s.exitLeaders.push(...retired.filter(f => s.open.some(p => p.leader === f.wallet)));
        s.follows = s.follows.filter(f => f.followedAt >= cutoff && !s.evicted[f.wallet]);
        s.exitLeaders = [...new Map(s.exitLeaders.filter(f => s.open.some(p => p.leader === f.wallet)).map(f => [f.wallet, f])).values()];
        if (st.enabled && s.follows.length < st.follows) {
          const category = s.experiment?.policy === 'category-specialist' ? `&category=${s.experiment.category}` : '';
          let rows = await this.get(`${DATA}/v1/leaderboard?timePeriod=WEEK&orderBy=PNL&limit=50${category}`);
          if (s.experiment?.policy === 'random-eligible') rows = rows.slice().sort((a, b) => { const score = r => createHash('sha256').update(`${s.experiment.strategyHash}:${r.proxyWallet}`).digest('hex'); return score(a).localeCompare(score(b)); });
          s.follows.push(...pickLeaders(rows, { ...st, follows: st.follows - s.follows.length }, new Set([...s.follows.map(f => f.wallet),...Object.keys(s.evicted)]), this.now()));
          if (category) for (const f of s.follows) { f.leaderboardCategory = s.experiment.category; f.source = `leaderboard ${s.experiment.category} WEEK by PnL`; }
          this.tape?.append('polycopy-leaders', { at: this.now(), experimentId: s.experiment?.id || `polycopy-incumbent-${s.epoch}`, leaders: s.follows.map(f => ({ ...f })), selectionPolicy: s.experiment?.leaderSelectionPolicy || 'weekly pnl leaderboard with follower-loss eviction' });
        }
        // Every leader trade seen for the first time goes to the tape (botTape.js, stream polycopy-trades), copied or not:
        // [wallet, tradeTime, asset, side, price, size, outcome, title], so leader selection can be studied later.
        let copied = 0; const taped = [];
        const watched = [...new Map([...s.follows, ...s.exitLeaders].map(f => [f.wallet, f])).values()];
        // Fetch discovery pages concurrently, but apply book mutations serially.
        const discovered = await boundedCopyMap(watched, async f => {
          try { return { f, result: await fetchLeaderTrades(u => this.get(u), f.wallet, { boundaryAt: Math.max(f.followedAt, this.now() - st.maxTradeAgeMs) }) }; }
          catch (error) { return { f, error }; }
        });
        for (const { f, result, error } of discovered) {
          if (error) { this.decide({ leader: f.name, action: 'WAIT', reason: 'trades unavailable: ' + error.message }); continue; }
          s.cursors[f.wallet] = { ...s.cursors[f.wallet], at: this.now(), newestEventAt: Math.max(0, ...result.trades.map(t => Number(t.timestamp) * 1000)), pages: result.pages, complete: result.complete };
          if (!result.complete) this.decide({ leader: f.name, action: 'WAIT', reason: 'bounded catch-up incomplete; historical source holdings unknown' });
          for (const t of result.trades) {
            const key = tradeKey(f.wallet, t), legacyKey = `${t.transactionHash}:${t.asset}:${t.side}`;
            if (s.intents[key] || s.seen.includes(key) || s.seen.includes(legacyKey) || Number(t.timestamp) * 1000 <= (s.cursors[f.wallet].finalizedBeforeAt || 0) || !validCopyTrade(t, this.now())) continue;
            const receipt = copyEvent(f, t, this.now(), s.experiment?.id || `polycopy-incumbent-${s.epoch}`);
            s.intents[key] = { receipt, trade: t, leader: f, status: 'PENDING', attempts: 0, handoffPending: receipt.eventAt > f.followedAt && !!(this.onLeaderEvent || t.side === 'BUY' && this.onLeaderBuy) };
            this.save(); // observation durable before source callback or any follower execution
            taped.push([f.wallet, Number(t.timestamp) * 1000, t.asset, t.side, Number(t.price), Number(t.size), t.outcome ?? null, String(t.title || t.slug || '').slice(0, 80)]);
            if (receipt.eventAt > f.followedAt) {
              try { this.onLeaderEvent?.(f, t, receipt); if (t.side === 'BUY') this.onLeaderBuy?.(f, t, receipt); s.intents[key].handoffPending = false; } catch (e) { this.decide({ action: 'WAIT', reason: 'mirror source handoff: ' + e.message }); }
            }
          }
        }
        if (taped.length) this.tape?.append('polycopy-trades', { trades: taped });
        for (const intent of Object.values(s.intents).filter(i => i.handoffPending)) {
          try { this.onLeaderEvent?.(intent.leader, intent.trade, intent.receipt); if (intent.trade.side === 'BUY') this.onLeaderBuy?.(intent.leader, intent.trade, intent.receipt); intent.handoffPending = false; this.save(); } catch (e) { this.decide({ action: 'WAIT', reason: 'retryable mirror handoff: ' + e.message }); }
        }
        for (const intent of Object.values(s.intents).filter(i => i.status === 'PENDING').sort((a, b) => a.receipt.eventAt - b.receipt.eventAt)) {
          const r = intent.receipt, t = intent.trade, f = intent.leader;
          if (r.eventAt <= f.followedAt || t.side === 'BUY' && this.now() - r.eventAt > st.maxTradeAgeMs) { intent.status = 'SKIPPED'; r.reason = r.eventAt <= f.followedAt ? 'before leader selection' : 'stale leader trade'; }
          else if (this.now() >= r.firstObservedAt + st.processingLatencyMs) {
            r.decisionAt = this.now(); intent.attempts++; this.retryReason = null;
            try { const filled = await this.copy(f, t, r); if (filled) copied++; if (!this.retryReason) intent.status = filled ? 'FILLED' : 'SKIPPED'; else r.reason = this.retryReason; }
            catch (e) { r.reason = 'transient execution: ' + e.message; }
          }
          r.status = intent.status;
          if (intent.status !== 'PENDING') { s.receipts.push({ ...r }); intent.receiptLogged = true; this.tape?.append('polycopy-receipts', { receipts: [{ ...r }] }); }
          this.save();
        }
        // Recover receipts committed with an exposure/exit immediately before a process crash.
        for (const intent of Object.values(s.intents).filter(i => i.status !== 'PENDING' && !i.receiptLogged)) {
          intent.receipt.status = intent.status; s.receipts.push({ ...intent.receipt }); intent.receiptLogged = true;
          this.save(); this.tape?.append('polycopy-receipts', { receipts: [{ ...intent.receipt }] });
        }
        s.receipts = s.receipts.slice(-2000);
        // Terminal receipt identities remain durable. Catch-up only admits trades inside age policy.
        for (const [key, i] of Object.entries(s.intents)) if (i.status !== 'PENDING' && !i.handoffPending && this.now() - i.receipt.eventAt > Math.max(st.maxTradeAgeMs, 86400000)) { if (!s.seen.includes(key)) s.seen.push(key); s.cursors[i.leader.wallet].finalizedBeforeAt = Math.max(s.cursors[i.leader.wallet].finalizedBeforeAt || 0, this.now() - Math.max(st.maxTradeAgeMs, 86400000)); delete s.intents[key]; }
        s.seen = s.seen.slice(-10000);
        s.lastNote = `${s.follows.length} leaders followed · ${copied} copies this run`;
      }
      // Existing exits remain supervised while entries are disabled or leaders are retired.
      for (const p of s.open.slice()) if (p.pendingExitQty > 0) {
        const requests = Object.entries(p.exitRequests || {}).filter(([, r]) => r.remainingQty > 0);
        if (!requests.length) await this.close(p, p.pendingExitReason || 'retry leader exit', p.pendingExitQty);
        for (const [id, request] of requests) { if (!s.open.includes(p)) break; p.activeExitRequestId = id; p.exitReceipt = request.receipt; await this.close(p, request.reason, request.remainingQty); }
      }
      if (settlement) await this.settle();
      s.lastError = null;
    } catch (e) { s.lastError = String(e.message || e).slice(0, 300); }
    finally { s.lastRunAt = this.now(); this.busy = false; this.save(); }
    return this.snapshot();
  }

  async copy(f, t, receipt = null) {
    const s = this.state, st = s.settings, leaderUsd = Number(t.size) * Number(t.price), title = t.title || t.slug || t.asset;
    if (t.side === 'SELL') {
      const pos = s.open.find(p => p.asset === t.asset && p.leader === f.wallet); if (!pos) return false;
      const eventId = receipt?.id || `${t.transactionHash}:${t.timestamp}`;
      pos.exitRequests ||= {};
      if (pos.pendingExitQty > 0 && !Object.keys(pos.exitRequests).length && pos.pendingExitEvent) pos.exitRequests[pos.pendingExitEvent] = { remainingQty: pos.pendingExitQty, reason: pos.pendingExitReason, receipt: pos.exitReceipt };
      if (!pos.exitRequests[eventId]) {
        // Ratio is relative to the copied entry, not an invented leader portfolio balance.
        const ratio = pos.sourceEntryQty > 0 ? Math.min(1, Number(t.size) / pos.sourceEntryQty) : 1;
        const requested = Math.min(Math.max(0, pos.qty - (pos.pendingExitQty || 0)), pos.qty * ratio);
        pos.pendingExitReason = pos.sourceEntryQty > 0 ? 'leader entry-relative partial exit' : 'leader sold; source holdings unknown, full-exit policy';
        pos.exitRequests[eventId] = { remainingQty: requested, reason: pos.pendingExitReason, receipt };
        pos.pendingExitQty = Object.values(pos.exitRequests).reduce((n, r) => n + r.remainingQty, 0);
        pos.pendingExitEvent = eventId; this.save();
      }
      const request = pos.exitRequests[eventId]; if (!(request.remainingQty > 0)) return true;
      pos.activeExitRequestId = eventId; pos.exitReceipt = request.receipt;
      if (receipt) { receipt.exitPolicy = request.reason; receipt.exitRequestedQty = request.remainingQty; }
      const closed = await this.close(pos, request.reason, request.remainingQty);
      if (!closed || request.remainingQty > 0 && s.open.includes(pos)) this.retryReason = 'pending leader exit retained on position';
      return closed && !this.retryReason;
    }
    if (t.side !== 'BUY') return false;
    if (s.experiment?.policy === 'no-trade') { this.decide({ leader: f.name, title, action: 'CONTROL', reason: 'preregistered no-trade control' }); return false; }
    if (!st.enabled || !s.follows.some(x => x.wallet === f.wallet) && receipt) return false;
    if (receipt && s.open.some(p => p.receipt?.id === receipt.id)) return true;
    if(s.drawdownPause?.active||s.evicted?.[f.wallet]){this.decide({leader:f.name,title,action:'SKIP',reason:s.drawdownPause?.active?'drawdown pause':'leader evicted after our realized losses'});return false}
    if (leaderUsd < st.minLeaderTradeUsd) return false;
    if (s.open.some(p => p.asset === t.asset)) { this.decide({ leader: f.name, title, action: 'SKIP', reason: 'already holding this outcome' }); return false; }
    if (s.open.length >= st.maxOpen) { this.decide({ leader: f.name, title, action: 'SKIP', reason: 'max open copies' }); return false; }
    if (s.cashUsd < st.stakeUsd) { this.decide({ leader: f.name, title, action: 'SKIP', reason: 'not enough paper cash' }); return false; }
    let book, m; try { [book, m] = await Promise.all([this.get(`${CLOB}/book?token_id=${t.asset}`).then(b => { if (receipt) receipt.quoteAt = this.now(); return b; }), this.market(t.asset)]); } catch (e) { this.retryReason = 'book unavailable'; this.decide({ leader: f.name, title, action: 'WAIT', reason: this.retryReason }); return false; }
    if (s.experiment?.policy === 'category-specialist') {
      const classification = classifyCopyMarket(m, t), expected = s.experiment.category.toLowerCase();
      if (classification.toLowerCase() !== expected && !(expected === 'sports' && m?.sportsMarketType)) { this.decide({ leader: f.name, title, action: 'SKIP', reason: `category specialist requires provider-labeled ${expected} market; received ${classification}` }); return false; }
    }
    const { asks } = sortBook(book), best = Number(asks[0]?.price);
    if (!(best >= st.minPrice && best <= st.maxPrice)) { this.decide({ leader: f.name, title, action: 'SKIP', reason: `ask ${best || '—'} outside ${st.minPrice}–${st.maxPrice}` }); return false; }
    if (best > Number(t.price) + st.maxChase) { this.decide({ leader: f.name, title, action: 'SKIP', reason: `ask ${best} chased past leader ${round(Number(t.price), 3)}` }); return false; }
    const fee = polymarketFeeModel(m); if (!fee.model) { this.retryReason = fee.reason; this.decide({ leader: f.name, title, action: 'WAIT', reason: fee.reason }); return false; }
    const budget = s.experiment?.policy === 'liquidity-scaled' ? Math.min(st.stakeUsd, leaderUsd * .01) : st.stakeUsd;
    const fills = walkBuy(asks, budget, Math.min(st.maxPrice, Number(t.price) + st.maxChase)), qty = fills.reduce((a, x) => a + x.quantity, 0);
    if (qty <= 0) { this.retryReason = 'no executable depth'; this.decide({ leader: f.name, title, action: 'WAIT', reason: this.retryReason }); return false; }
    const cost = fills.reduce((a, x) => a + x.price * x.quantity, 0), feeUsd = takerFee(fee.model, fills);
    if(!Number.isFinite(feeUsd)||cost+feeUsd>s.cashUsd){this.decide({leader:f.name,title,action:'SKIP',reason:'fees unavailable or total exceeds paper cash'});return false}
    s.cashUsd = round(s.cashUsd - cost - feeUsd, 6);
    s.open.push({ id: `copy-${this.now()}-${String(t.asset).slice(-8)}`, asset: t.asset, conditionId: t.conditionId, title, outcome: t.outcome, outcomeIndex: t.outcomeIndex, leader: f.wallet, leaderName: f.name, leaderPrice: round(Number(t.price), 4), leaderUsd: round(leaderUsd, 2), leaderAt: Number(t.timestamp) * 1000, qty: round(qty, 6), avgPrice: round(cost / qty, 4), costUsd: round(cost, 4), feeUsd: round(feeUsd, 5), feeModel: fee.model, openedAt: this.now(), markUsd: round(cost, 4), endDate: m?.endDate || null, slug: t.eventSlug || t.slug || null });
    Object.assign(s.open.at(-1), { marketType: classifyCopyMarket(m, t), sourceEntryQty: Number(t.size), exitPolicy: 'entry-relative leader sells; full exit for legacy unknown holdings', receipt, firstObservedAt: receipt?.firstObservedAt ?? this.now(), quoteAt: receipt?.quoteAt ?? this.now(), experimentId: receipt?.experimentId || null });
    if (receipt) { receipt.fills = fills; receipt.positionId = s.open.at(-1).id; receipt.feeUsd = feeUsd; receipt.exitPolicy = s.open.at(-1).exitPolicy; receipt.fillAt = this.now(); }
    if (receipt && s.intents[receipt.id]) s.intents[receipt.id].status = 'FILLED';
    this.save(); // balance, position, intent receipt committed together by caller
    this.decide({ leader: f.name, title, outcome: t.outcome, action: 'COPY', price: round(cost / qty, 3), leaderPrice: round(Number(t.price), 3), lagSec: Math.round((this.now() - Number(t.timestamp) * 1000) / 1000) });
    return true;
  }

  async close(pos, reason, requestedQty = pos.qty) {
    const s = this.state; let book; try { book = await this.get(`${CLOB}/book?token_id=${pos.asset}`); } catch { return false; }
    if (!s.open.includes(pos)) return false;
    const fills = walkSell(sortBook(book).bids, Math.min(pos.qty, requestedQty)), sold = fills.reduce((a, x) => a + x.quantity, 0); if (!(sold > 0)) { this.decide({ title: pos.title, action: 'HOLD', reason: 'no executable exit bids; pending exit retained' }); return false; }
    const fraction = Math.min(1, sold / pos.qty), proceeds = fills.reduce((a, x) => a + x.price * x.quantity, 0), fee = takerFee(pos.feeModel, fills);
    if (!Number.isFinite(fee) || fee < 0) return false;
    const cost = pos.costUsd * fraction, entryFee = pos.feeUsd * fraction, pnl = proceeds - fee - cost - entryFee;
    const exit = { ...pos, id: `${pos.id}-exit-${this.now()}-${s.history.length}`, parentPositionId: pos.id, qty: sold, costUsd: cost, feeUsd: entryFee, status: fraction >= .999999 ? 'SOLD' : 'PARTIAL_SOLD', reason, exitPrice: round(proceeds / sold, 4), exitFeeUsd: round(fee, 5), pnlUsd: round(pnl, 4), closedAt: this.now(), exitQuoteAt: this.now(), exitFills: fills };
    if (pos.exitReceipt) { pos.exitReceipt.quoteAt = this.now(); pos.exitReceipt.fills = fills; pos.exitReceipt.positionId = pos.id; }
    s.cashUsd = round(s.cashUsd + proceeds - fee, 6);
    if (fraction >= .999999) s.open = s.open.filter(p => p !== pos);
    else { pos.qty = round(pos.qty - sold, 6); pos.costUsd = round(pos.costUsd - cost, 6); pos.feeUsd = round(pos.feeUsd - entryFee, 6); if (Number.isFinite(pos.markUsd)) pos.markUsd *= 1 - fraction; pos.sourceEntryQty = Number.isFinite(pos.sourceEntryQty) ? pos.sourceEntryQty * (1 - fraction) : null; }
    const request = pos.exitRequests?.[pos.activeExitRequestId];
    if (request) { request.remainingQty = round(Math.max(0, request.remainingQty - sold), 6); pos.pendingExitQty = round(Object.values(pos.exitRequests).reduce((n, r) => n + r.remainingQty, 0), 6); }
    else pos.pendingExitQty = round(Math.max(0, requestedQty - sold), 6);
    if (pos.exitReceipt && s.intents[pos.exitReceipt.id] && (!s.open.includes(pos) || request && !request.remainingQty || !pos.pendingExitQty)) s.intents[pos.exitReceipt.id].status = 'FILLED';
    s.history.unshift(exit); s.history.length = Math.min(s.history.length, 500); this.save();
    this.tape?.append('polycopy-receipts', { receipts: [{ ...pos.exitReceipt, status: exit.status, exitQuoteAt: exit.exitQuoteAt, fills, positionId: pos.id, pnlUsd: exit.pnlUsd }] });
    this.decide({ leader: pos.leaderName, title: pos.title, action: 'SELL', price: round(proceeds / sold, 3), reason, pnl: round(pnl, 2) });
    return true;
  }

  // Resolved markets pay 1 or 0 per share from Gamma outcomePrices; open ones are marked at the best bid.
  async settle() {
    const s = this.state;
    for (const pos of s.open.slice()) {
      let m = null; try { m = await this.market(pos.asset, true); } catch { continue; }
      if (!s.open.includes(pos)) continue; // a fast leader exit may finish while metadata is fetched
      if (m?.closed) {
        let prices = []; try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch {}
        const px = prices[Number(pos.outcomeIndex)]; if (!(px === 0 || px === 1)) continue; // wait for a clean 0/1 resolution
        const payout = px * pos.qty, pnl = payout - pos.costUsd - pos.feeUsd;
        s.cashUsd = round(s.cashUsd + payout, 6); s.open = s.open.filter(p => p !== pos);
        s.history.unshift({ ...pos, status: 'RESOLVED', won: px === 1, payoutUsd: round(payout, 4), pnlUsd: round(pnl, 4), closedAt: this.now() }); s.history.length = Math.min(s.history.length, 500);
        this.save(); this.tape?.append('polycopy-receipts', { receipts: [{ ...pos.receipt, status: 'RESOLVED', positionId: pos.id, closedAt: this.now(), payoutUsd: payout, pnlUsd: pnl, settlementSource: 'gamma-clean-binary-outcome' }] });
        continue;
      }
      try { const { bids } = sortBook(await this.get(`${CLOB}/book?token_id=${pos.asset}`)); if (!s.open.includes(pos)) continue; const fills = walkSell(bids, pos.qty), qty = fills.reduce((n, f) => n + f.quantity, 0), fee = takerFee(pos.feeModel, fills); pos.markAt = this.now(); pos.markExecutable = qty >= pos.qty * .999999 && Number.isFinite(fee); pos.markUsd = pos.markExecutable ? round(fills.reduce((n, f) => n + f.price * f.quantity, 0) - fee, 4) : null; pos.markUnavailableReason = pos.markExecutable ? null : 'insufficient exact-size bid depth or fees'; } catch { pos.markExecutable = false; pos.markUsd = null; pos.markUnavailableReason = 'follower quote unavailable'; }
    }
  }

  async runSettlement() { if (this.recoveryError) throw new Error(this.recoveryError); if (this.settlementBusy) return this.snapshot(); this.settlementBusy = true; try { await this.settle(); } finally { this.settlementBusy = false; this.save(); } return this.snapshot(); }

  snapshot() {
    if (this.recoveryError) return { id: 'polycopy', mode: 'PAPER', recoveryRequired: true, settings: this.state.settings, cashUsd: null, equityUsd: null, returnPct: null, open: [], history: [], follows: [], stats: {}, lastError: this.recoveryError, running: this.busy };
    const s = this.state, h = s.history, n = h.length, wins = h.filter(x => x.pnlUsd > 0).length, open = s.open.reduce((a, p) => a + (p.markUsd ?? p.costUsd), 0), equity = s.cashUsd + open;
    const byLeader = {}; for (const x of [...h, ...s.open]) { const k = x.leaderName || short(x.leader); byLeader[k] ||= { leader: k, copies: 0, settled: 0, pnlUsd: 0 }; byLeader[k].copies++; if (x.pnlUsd != null) { byLeader[k].settled++; byLeader[k].pnlUsd = round(byLeader[k].pnlUsd + x.pnlUsd, 2); } }
    let run = s.startUsd; const curve = [{ at: null, equityUsd: s.startUsd }]; for (const x of h.slice().reverse()) { run += x.pnlUsd; curve.push({ at: x.closedAt, equityUsd: round(run, 2) }); }
    return { id: 'polycopy', label: 'Polymarket copy bot', mode: 'PAPER', venue: 'polymarket.com (global), not Polymarket US', epoch: s.epoch, settings: s.settings, startUsd: s.startUsd, cashUsd: round(s.cashUsd, 2), equityUsd: round(equity, 2), returnPct: round((equity - s.startUsd) / s.startUsd * 100, 2),
      follows: s.follows, open: s.open.map(({ feeModel, ...p }) => p), history: h.slice(0, 50).map(({ feeModel, ...p }) => p), decisions: s.decisions.slice(0, 30), curve: curve.slice(-200), byLeader: Object.values(byLeader).sort((a, b) => b.pnlUsd - a.pnlUsd),
      attribution:copyAttribution(h),latency:copyLatencySummary(s.receipts || []),discoveryCache:this.readCache?.stats || null, drawdownPause:s.drawdownPause||copyRisk(s),evicted:s.evicted||{}, exitLeaders: s.exitLeaders, cursors: s.cursors, pendingIntents: Object.values(s.intents || {}).filter(i => i.status === 'PENDING').length,pendingHandoffs:Object.values(s.intents || {}).filter(i => i.handoffPending).length, receipts: (s.receipts || []).slice(-30), experiment: s.experiment || null,
      stats: { closed: n, wins, hitRate: n ? round(wins / n, 3) : null, pnlUsd: round(h.reduce((a, x) => a + x.pnlUsd, 0), 2), feesUsd: round(h.reduce((a, x) => a + x.feeUsd + (x.exitFeeUsd || 0), 0), 2) },
      lastRunAt: s.lastRunAt, lastError: this.recoveryError || s.lastError, lastNote: s.lastNote, running: this.busy };
  }
}
