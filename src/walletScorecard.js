// Point-in-time wallet PnL scorecard for Pump.fun copy-trading research (paper only; nothing here trades).
// Input: signer swap events from the lean indexer (tx_events rows whose raw has signer:true). Output: per-wallet
// realized SOL PnL (FIFO, fees charged), round trips, win rate, hold time and earliness, using ONLY events with
// ts < asOf. A later event can never change a score computed for an earlier asOf.
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';

export const MIN_GRADED_ROUND_TRIPS = Math.max(1, Number(process.env.WALLET_SCORECARD_MIN_TRIPS) || 10);
export const SOL_DUST = 1e-6;          // a leg smaller than this has no SOL side (transfer, token-to-token route)
const SHRINK_K = 10;                   // shrink the mean trip return toward 0 with 10 pseudo-trips
const TRIP_RETURN_CAP_PCT = 200;       // concentration cap: one moonshot trip counts at most +200% in the score
const CLOSE_DUST = 0.01;               // a trip closes when under 1% of the tokens bought in it remain

// Wallets are ed25519 keys and lie on the curve. Pools, bonding curves, vaults and program authorities are PDAs,
// which are off the curve by construction, so this check excludes them without any RPC call.
const curveMemo = new Map();
export function isWalletAddress(a) {
  const k = String(a || ''); if (!k) return false;
  let v = curveMemo.get(k);
  if (v === undefined) { try { v = PublicKey.isOnCurve(new PublicKey(k).toBytes()); } catch { v = false; } if (curveMemo.size > 50000) curveMemo.clear(); curveMemo.set(k, v); }
  return v;
}

const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r4 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4;

export function scoreWallets(events, { asOf = Date.now(), mintMeta = {}, minTrips = MIN_GRADED_ROUND_TRIPS, shrinkK = SHRINK_K } = {}) {
  const rows = (events || []).filter(e => Number(e?.ts) > 0 && Number(e.ts) < asOf)
    .sort((a, b) => a.ts - b.ts || (a.slot || 0) - (b.slot || 0) || String(a.signature).localeCompare(String(b.signature)) || (a.eventIndex || 0) - (b.eventIndex || 0));
  const excluded = { notSigner: 0, notWallet: 0, noSolLeg: 0, unmatchedSell: 0 };
  const mintFirst = new Map(), buyers = new Map(), wallets = new Map();
  let swaps = 0, signerRows = 0;
  for (const e of rows) {
    if (!mintFirst.has(e.mint)) mintFirst.set(e.mint, e.ts);
    if (e.signer !== true) { excluded.notSigner++; continue; }
    if (!isWalletAddress(e.wallet)) { excluded.notWallet++; continue; }
    signerRows++;
    // Buy rank counts every signer that bought, SOL leg or not, in on-chain order.
    let rank = null;
    if (e.side === 'BUY') { const b = buyers.get(e.mint) || new Map(); if (!b.has(e.wallet)) b.set(e.wallet, b.size + 1); buyers.set(e.mint, b); rank = b.get(e.wallet); }
    const tok = Math.abs(Number(e.tokenDelta) || 0), sol = Number(e.solDelta) || 0, fee = Math.max(0, Number(e.feeSol) || 0);
    const isSwap = tok > 0 && (e.side === 'BUY' ? sol < -SOL_DUST : e.side === 'SELL' ? sol > SOL_DUST : false);
    if (!isSwap) { excluded.noSolLeg++; continue; }
    swaps++;
    const w = wallets.get(e.wallet) || { wallet: e.wallet, trips: [], realizedPnlSol: 0, positions: new Map(), entries: [], firstTs: e.ts, lastTs: e.ts, unmatchedSells: 0 };
    wallets.set(e.wallet, w); w.lastTs = e.ts;
    const p = w.positions.get(e.mint) || { lots: [], openTs: 0, bought: 0, cost: 0, pnl: 0, seen: false };
    w.positions.set(e.mint, p);
    if (e.side === 'BUY') {
      if (!p.lots.length) Object.assign(p, { openTs: e.ts, bought: 0, cost: 0, pnl: 0 });
      p.lots.push({ qty: tok, cost: -sol + fee }); p.bought += tok; p.cost += -sol + fee;
      if (!p.seen) {
        p.seen = true;
        const meta = mintMeta[e.mint] || {}, valid = !!meta.historyComplete && !(meta.firstGapTs && e.ts >= meta.firstGapTs);
        if (valid) w.entries.push({ sec: (e.ts - mintFirst.get(e.mint)) / 1000, rank });
      }
      continue;
    }
    // SELL: FIFO against lots. Tokens sold that were bought before coverage began have no cost basis, so the
    // proceeds for that fraction are ignored rather than booked as free profit.
    let q = tok, mQty = 0, mCost = 0;
    while (q > 1e-12 && p.lots.length) { const l = p.lots[0], take = Math.min(q, l.qty), c = l.cost * take / l.qty; mQty += take; mCost += c; l.qty -= take; l.cost -= c; q -= take; if (l.qty <= 1e-12) p.lots.shift(); }
    if (mQty <= 0) { w.unmatchedSells++; excluded.unmatchedSell++; continue; }
    const pnl = (sol - fee) * (mQty / tok) - mCost;
    w.realizedPnlSol += pnl; p.pnl += pnl;
    const left = p.lots.reduce((s, l) => s + l.qty, 0);
    if (left <= CLOSE_DUST * p.bought) {
      const dust = p.lots.reduce((s, l) => s + l.cost, 0); // abandoned remainder is written off
      w.realizedPnlSol -= dust; p.pnl -= dust; p.lots = [];
      w.trips.push({ mint: e.mint, pnlSol: p.pnl, costSol: p.cost, returnPct: p.cost > 0 ? p.pnl / p.cost * 100 : 0, holdSec: (e.ts - p.openTs) / 1000, closedTs: e.ts });
    }
  }
  const out = [];
  for (const w of wallets.values()) {
    const n = w.trips.length, wins = w.trips.filter(t => t.pnlSol > 0).length;
    const capped = w.trips.map(t => Math.min(TRIP_RETURN_CAP_PCT, t.returnPct)), meanRet = n ? capped.reduce((s, x) => s + x, 0) / n : 0;
    const best = n ? Math.max(...w.trips.map(t => t.pnlSol)) : 0, gains = w.trips.filter(t => t.pnlSol > 0).reduce((s, t) => s + t.pnlSol, 0);
    out.push({
      wallet: w.wallet, roundTrips: n, wins, winRate: n ? r4(wins / n) : null,
      realizedPnlSol: r4(w.realizedPnlSol), pnlWithoutBestSol: r4(n ? w.trips.reduce((s, t) => s + t.pnlSol, 0) - Math.max(0, best) : 0),
      topTripShare: gains > 0 ? r4(Math.max(0, best) / gains) : null,
      meanReturnPct: n ? r4(meanRet) : null, shrunkReturnPct: r4(n * meanRet / (n + shrinkK)),
      medianHoldSec: r4(median(w.trips.map(t => t.holdSec))),
      medianEntrySec: r4(median(w.entries.map(x => x.sec))), medianBuyRank: median(w.entries.map(x => x.rank).filter(Number.isFinite)), earlyMintsMeasured: w.entries.length,
      openPositions: [...w.positions.values()].filter(p => p.lots.length).length, unmatchedSells: w.unmatchedSells,
      graded: n >= minTrips, firstTs: w.firstTs, lastTs: w.lastTs,
    });
  }
  out.sort((a, b) => (b.graded - a.graded) || (a.graded ? (b.shrunkReturnPct - a.shrunkReturnPct) || (b.realizedPnlSol - a.realizedPnlSol) : (b.roundTrips - a.roundTrips) || (b.realizedPnlSol - a.realizedPnlSol)));
  const summary = {
    asOf, events: rows.length, signerEvents: signerRows, swaps, solLegPct: signerRows ? r4(swaps / signerRows * 100) : null,
    wallets: out.length, withRoundTrip: out.filter(x => x.roundTrips >= 1).length, withAtLeast3: out.filter(x => x.roundTrips >= 3).length,
    graded: out.filter(x => x.graded).length, minTrips, mints: mintFirst.size, excluded,
  };
  return { summary, wallets: out };
}

// Dashboard view: read what the collector's indexer wrote. Cached briefly; never throws.
let viewCache = { at: 0, dir: '', value: null };
export function walletScorecardView({ dir = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data'), now = Date.now() } = {}) {
  if (viewCache.value && viewCache.dir === dir && now - viewCache.at < 5000) return viewCache.value;
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const card = read('wallet-scorecard.json'), st = read('wallet-indexer-state.json'), led = read('wallet-indexer-budget.json');
  const h = st?.health || null, day = new Date(now).toISOString().slice(0, 10);
  let status = h?.status || 'NOT RUNNING';
  if (h && status !== 'OFF' && now - Number(h.updatedAt || 0) > 10 * 60_000) status = 'STALE';
  const indexer = h ? { ...h, status, credits: led?.day === day ? Number(led.credits || 0) : 0, calls: led?.day === day ? Number(led.calls || 0) : 0 } : { status };
  const value = { indexer, asOf: card?.asOf || null, summary: card?.summary || null, wallets: (card?.wallets || []).slice(0, 16), minTrips: card?.summary?.minTrips ?? MIN_GRADED_ROUND_TRIPS };
  viewCache = { at: now, dir, value };
  return value;
}
