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
import { writeFileAtomicSync } from './atomicRename.js';
import { takerFee, polymarketFeeModel } from './core/fees.js';
import { copyAttribution, copyRisk, COPY_EVICT_MIN_CLOSES } from './copyAttribution.js';

const SCHEMA = 'mpo.polymarket-copy-paper.v1';
const DATA = 'https://data-api.polymarket.com', CLOB = 'https://clob.polymarket.com', GAMMA = 'https://gamma-api.polymarket.com';
export const COPY_DEFAULTS = Object.freeze({ enabled: true, startUsd: 500, stakeUsd: 10, maxOpen: 25, follows: 6, minLeaderTradeUsd: 100, minPrice: 0.05, maxPrice: 0.95, maxChase: 0.03, minLeaderVolumeUsd: 100000, minLeaderMargin: 0.02, refollowDays: 7 });
const LIMITS = { stakeUsd: [1, 250], maxOpen: [1, 100], follows: [1, 20], minLeaderTradeUsd: [1, 100000], minPrice: [0.01, 0.5], maxPrice: [0.5, 0.99], maxChase: [0, 0.2], minLeaderVolumeUsd: [0, 1e9], minLeaderMargin: [0, 1], refollowDays: [1, 90], startUsd: [10, 100000] };
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
  constructor({ dataDir, tape = null, onLeaderBuy = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'polymarket-copy-paper.json'); this.tape = tape; this.onLeaderBuy = onLeaderBuy; this.fetch = fetchImpl; this.now = now; this.busy = false; this.recoveryError = null; this.state = this.load();
  }
  fresh(start = COPY_DEFAULTS.startUsd, settings = COPY_DEFAULTS, epoch = 1) { return { schema: SCHEMA, epoch, startUsd: start, cashUsd: start, settings: { ...settings, startUsd: start }, follows: [], open: [], history: [], decisions: [], seen: [], lastRunAt: null, lastError: null, lastNote: null }; }
  load() {
    try { if (!fs.existsSync(this.file)) return this.fresh(); const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (s.schema !== SCHEMA) throw new Error('unknown schema'); s.settings = { ...COPY_DEFAULTS, ...s.settings }; return s; }
    catch (e) { this.recoveryError = `Copy book unreadable (${e.message}); the file was kept. Reset to start a new book.`; return this.fresh(); }
  }
  save() { if (this.recoveryError) return; fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeFileAtomicSync(this.file, JSON.stringify(this.state)); }
  async get(url) { const r = await this.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'MoneyPrinterOS/0.5' }, signal: AbortSignal.timeout?.(15000) }); if (!r.ok) { const e = new Error(`HTTP ${r.status} from ${new URL(url).host}`); e.status = r.status; throw e; } return r.json(); }
  decide(row) { this.state.decisions.unshift({ at: this.now(), ...row }); this.state.decisions.length = Math.min(this.state.decisions.length, 60); }
  configure(patch = {}) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) { if (!(k in COPY_DEFAULTS)) continue; if (k === 'enabled') { out.enabled = !!v; continue; } const n = Number(v), [a, b] = LIMITS[k]; if (!Number.isFinite(n) || n < a || n > b) throw new Error(`${k} must be between ${a} and ${b}`); out[k] = n; }
    this.state.settings = { ...this.state.settings, ...out }; this.save(); return this.snapshot();
  }
  reset({ startUsd, confirmation } = {}) {
    if (confirmation !== 'RESET BOT') throw new Error('Type RESET BOT to confirm');
    const start = startUsd == null ? this.state.settings.startUsd : Number(startUsd); if (!(start >= 10 && start <= 100000)) throw new Error('startUsd must be between 10 and 100000');
    this.recoveryError = null; this.state = this.fresh(start, this.state.settings, (this.state.epoch || 1) + 1); this.save(); return this.snapshot();
  }
  unfollow(wallet) { this.state.follows = this.state.follows.filter(f => f.wallet !== String(wallet).toLowerCase()); this.save(); return this.snapshot(); }
  async market(asset) {
    for (const q of [`clob_token_ids=${asset}`, `clob_token_ids=${asset}&closed=true`]) { const r = await this.get(`${GAMMA}/markets?${q}`); if (Array.isArray(r) && r[0]) return r[0]; }
    return null;
  }

  async run() {
    if (this.recoveryError) throw new Error(this.recoveryError);
    if (this.busy) return this.snapshot(); this.busy = true;
    const s = this.state, st = s.settings;
    try {
      await this.settle();
      const risk=copyRisk(s);
      if(risk.active&&!s.drawdownPause?.active)this.decide({action:'PAUSE',reason:risk.reason});
      s.drawdownPause=s.drawdownPause?.active?s.drawdownPause:risk; // sticky; no automatic loss-hiding reset
      s.evicted ||= {};
      for(const f of s.follows){const h=s.history.filter(r=>r.leader===f.wallet&&Number.isFinite(r.pnlUsd));
        if(h.length>=COPY_EVICT_MIN_CLOSES&&h.reduce((t,r)=>t+r.pnlUsd,0)<0&&!s.evicted[f.wallet]){
          s.evicted[f.wallet]={at:this.now(),n:h.length,pnlUsd:h.reduce((t,r)=>t+r.pnlUsd,0)};
          this.decide({leader:f.name,action:'EVICT',reason:'our realized copies lost money after at least 5 closes; existing holdings keep exit monitoring'});
        }
      }
      if (st.enabled) {
        // Keep up to `follows` leaders; drop ones followed longer than refollowDays ago and refill from a fresh snapshot.
        const cutoff = this.now() - st.refollowDays * 86400e3;
        s.follows = s.follows.filter(f => f.followedAt >= cutoff || s.open.some(p => p.leader === f.wallet));
        if (s.follows.length < st.follows) {
          const rows = await this.get(`${DATA}/v1/leaderboard?timePeriod=WEEK&orderBy=PNL&limit=50`);
          s.follows.push(...pickLeaders(rows, { ...st, follows: st.follows - s.follows.length }, new Set([...s.follows.map(f => f.wallet),...Object.keys(s.evicted)]), this.now()));
        }
        // Every leader trade seen for the first time goes to the tape (botTape.js, stream polycopy-trades), copied or not:
        // [wallet, tradeTime, asset, side, price, size, outcome, title], so leader selection can be studied later.
        let copied = 0; const taped = [];
        for (const f of s.follows) {
          let trades = []; try { trades = await this.get(`${DATA}/trades?user=${f.wallet}&limit=25`); } catch (e) { this.decide({ leader: f.name, action: 'SKIP', reason: 'trades unavailable: ' + e.message }); continue; }
          for (const t of trades.slice().reverse()) {
            const key = `${t.transactionHash}:${t.asset}:${t.side}`; if (s.seen.includes(key)) continue;
            s.seen.push(key); if (s.seen.length > 3000) s.seen.splice(0, s.seen.length - 3000);
            taped.push([f.wallet, Number(t.timestamp) * 1000, t.asset, t.side, Number(t.price), Number(t.size), t.outcome ?? null, String(t.title || t.slug || '').slice(0, 80)]);
            if (Number(t.timestamp) * 1000 <= f.followedAt) continue; // only trades made after we started following
            if (t.side === 'BUY') { try { this.onLeaderBuy?.(f, t); } catch {} } // the Kalshi mirror (src/kalshiMirror.js) sees every new buy
            if (await this.copy(f, t)) copied++;
          }
        }
        if (taped.length) this.tape?.append('polycopy-trades', { trades: taped });
        s.lastNote = `${s.follows.length} leaders followed · ${copied} copies this run`;
      }
      s.lastError = null;
    } catch (e) { s.lastError = String(e.message || e).slice(0, 300); }
    finally { s.lastRunAt = this.now(); this.busy = false; this.save(); }
    return this.snapshot();
  }

  async copy(f, t) {
    const s = this.state, st = s.settings, leaderUsd = Number(t.size) * Number(t.price), title = t.title || t.slug || t.asset;
    if (t.side === 'SELL') {
      const pos = s.open.find(p => p.asset === t.asset && p.leader === f.wallet); if (!pos) return false;
      return this.close(pos, 'leader sold');
    }
    if (t.side !== 'BUY') return false;
    if(s.drawdownPause?.active||s.evicted?.[f.wallet]){this.decide({leader:f.name,title,action:'SKIP',reason:s.drawdownPause?.active?'drawdown pause':'leader evicted after our realized losses'});return false}
    if (leaderUsd < st.minLeaderTradeUsd) return false;
    if (s.open.some(p => p.asset === t.asset)) { this.decide({ leader: f.name, title, action: 'SKIP', reason: 'already holding this outcome' }); return false; }
    if (s.open.length >= st.maxOpen) { this.decide({ leader: f.name, title, action: 'SKIP', reason: 'max open copies' }); return false; }
    if (s.cashUsd < st.stakeUsd) { this.decide({ leader: f.name, title, action: 'SKIP', reason: 'not enough paper cash' }); return false; }
    let book, m; try { [book, m] = await Promise.all([this.get(`${CLOB}/book?token_id=${t.asset}`), this.market(t.asset)]); } catch (e) { this.decide({ leader: f.name, title, action: 'SKIP', reason: 'book unavailable' }); return false; }
    const { asks } = sortBook(book), best = Number(asks[0]?.price);
    if (!(best >= st.minPrice && best <= st.maxPrice)) { this.decide({ leader: f.name, title, action: 'SKIP', reason: `ask ${best || '—'} outside ${st.minPrice}–${st.maxPrice}` }); return false; }
    if (best > Number(t.price) + st.maxChase) { this.decide({ leader: f.name, title, action: 'SKIP', reason: `ask ${best} chased past leader ${round(Number(t.price), 3)}` }); return false; }
    const fee = polymarketFeeModel(m); if (!fee.model) { this.decide({ leader: f.name, title, action: 'SKIP', reason: fee.reason }); return false; }
    const fills = walkBuy(asks, st.stakeUsd, Number(t.price) + st.maxChase), qty = fills.reduce((a, x) => a + x.quantity, 0);
    if (qty <= 0) { this.decide({ leader: f.name, title, action: 'SKIP', reason: 'no depth' }); return false; }
    const cost = fills.reduce((a, x) => a + x.price * x.quantity, 0), feeUsd = takerFee(fee.model, fills);
    if(!Number.isFinite(feeUsd)||cost+feeUsd>s.cashUsd){this.decide({leader:f.name,title,action:'SKIP',reason:'fees unavailable or total exceeds paper cash'});return false}
    s.cashUsd = round(s.cashUsd - cost - feeUsd, 6);
    s.open.push({ id: `copy-${this.now()}-${String(t.asset).slice(-8)}`, asset: t.asset, conditionId: t.conditionId, title, outcome: t.outcome, outcomeIndex: t.outcomeIndex, leader: f.wallet, leaderName: f.name, leaderPrice: round(Number(t.price), 4), leaderUsd: round(leaderUsd, 2), leaderAt: Number(t.timestamp) * 1000, qty: round(qty, 6), avgPrice: round(cost / qty, 4), costUsd: round(cost, 4), feeUsd: round(feeUsd, 5), feeModel: fee.model, openedAt: this.now(), markUsd: round(cost, 4), endDate: m?.endDate || null, slug: t.eventSlug || t.slug || null });
    s.open.at(-1).marketType=typeof m?.category==='string'?m.category.slice(0,60):typeof t.marketType==='string'?t.marketType.slice(0,60):'unknown';
    this.decide({ leader: f.name, title, outcome: t.outcome, action: 'COPY', price: round(cost / qty, 3), leaderPrice: round(Number(t.price), 3), lagSec: Math.round((this.now() - Number(t.timestamp) * 1000) / 1000) });
    return true;
  }

  async close(pos, reason) {
    const s = this.state; let book; try { book = await this.get(`${CLOB}/book?token_id=${pos.asset}`); } catch { return false; }
    const fills = walkSell(sortBook(book).bids, pos.qty), sold = fills.reduce((a, x) => a + x.quantity, 0); if (sold < pos.qty * 0.999) { this.decide({ title: pos.title, action: 'HOLD', reason: 'not enough bids to exit' }); return false; }
    const proceeds = fills.reduce((a, x) => a + x.price * x.quantity, 0), fee = takerFee(pos.feeModel, fills) ?? 0, pnl = proceeds - fee - pos.costUsd - pos.feeUsd;
    s.cashUsd = round(s.cashUsd + proceeds - fee, 6); s.open = s.open.filter(p => p !== pos);
    s.history.unshift({ ...pos, status: 'SOLD', reason, exitPrice: round(proceeds / sold, 4), exitFeeUsd: round(fee, 5), pnlUsd: round(pnl, 4), closedAt: this.now() }); s.history.length = Math.min(s.history.length, 500);
    this.decide({ leader: pos.leaderName, title: pos.title, action: 'SELL', price: round(proceeds / sold, 3), reason, pnl: round(pnl, 2) });
    return true;
  }

  // Resolved markets pay 1 or 0 per share from Gamma outcomePrices; open ones are marked at the best bid.
  async settle() {
    const s = this.state;
    for (const pos of s.open.slice()) {
      let m = null; try { m = await this.market(pos.asset); } catch { continue; }
      if (m?.closed) {
        let prices = []; try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch {}
        const px = prices[Number(pos.outcomeIndex)]; if (!(px === 0 || px === 1)) continue; // wait for a clean 0/1 resolution
        const payout = px * pos.qty, pnl = payout - pos.costUsd - pos.feeUsd;
        s.cashUsd = round(s.cashUsd + payout, 6); s.open = s.open.filter(p => p !== pos);
        s.history.unshift({ ...pos, status: 'RESOLVED', won: px === 1, payoutUsd: round(payout, 4), pnlUsd: round(pnl, 4), closedAt: this.now() }); s.history.length = Math.min(s.history.length, 500);
        continue;
      }
      try { const { bids } = sortBook(await this.get(`${CLOB}/book?token_id=${pos.asset}`)); if (bids[0]) pos.markUsd = round(Number(bids[0].price) * pos.qty, 4); } catch {}
    }
  }

  snapshot() {
    const s = this.state, h = s.history, n = h.length, wins = h.filter(x => x.pnlUsd > 0).length, open = s.open.reduce((a, p) => a + (p.markUsd ?? p.costUsd), 0), equity = s.cashUsd + open;
    const byLeader = {}; for (const x of [...h, ...s.open]) { const k = x.leaderName || short(x.leader); byLeader[k] ||= { leader: k, copies: 0, settled: 0, pnlUsd: 0 }; byLeader[k].copies++; if (x.pnlUsd != null) { byLeader[k].settled++; byLeader[k].pnlUsd = round(byLeader[k].pnlUsd + x.pnlUsd, 2); } }
    let run = s.startUsd; const curve = [{ at: null, equityUsd: s.startUsd }]; for (const x of h.slice().reverse()) { run += x.pnlUsd; curve.push({ at: x.closedAt, equityUsd: round(run, 2) }); }
    return { id: 'polycopy', label: 'Polymarket copy bot', mode: 'PAPER', venue: 'polymarket.com (global), not Polymarket US', epoch: s.epoch, settings: s.settings, startUsd: s.startUsd, cashUsd: round(s.cashUsd, 2), equityUsd: round(equity, 2), returnPct: round((equity - s.startUsd) / s.startUsd * 100, 2),
      follows: s.follows, open: s.open.map(({ feeModel, ...p }) => p), history: h.slice(0, 50).map(({ feeModel, ...p }) => p), decisions: s.decisions.slice(0, 30), curve: curve.slice(-200), byLeader: Object.values(byLeader).sort((a, b) => b.pnlUsd - a.pnlUsd),
      attribution:copyAttribution(h),drawdownPause:s.drawdownPause||copyRisk(s),evicted:s.evicted||{},
      stats: { closed: n, wins, hitRate: n ? round(wins / n, 3) : null, pnlUsd: round(h.reduce((a, x) => a + x.pnlUsd, 0), 2), feesUsd: round(h.reduce((a, x) => a + x.feeUsd + (x.exitFeeUsd || 0), 0), 2) },
      lastRunAt: s.lastRunAt, lastError: this.recoveryError || s.lastError, lastNote: s.lastNote, running: this.busy };
  }
}
