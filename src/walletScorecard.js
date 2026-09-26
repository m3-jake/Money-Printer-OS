// Copy-trading step 3: grade wallets by what they actually made, not by how often they hold top-10 bags.
// Input is tx_events (alpha-lab.sqlite): per swap, wallet, side, token_delta and sol_delta (negative when the
// wallet spent SOL). Buys and sells are matched FIFO per wallet and mint into round trips. Pool vaults and
// program authorities are excluded. Research only: nothing here copies a trade.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const SCORECARD_SCHEMA = 'mpo.wallet-scorecard.v1';
// Known AMM / launchpad authorities that show up as a "wallet" on one side of every swap.
export const PROGRAM_WALLETS = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4 authority
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM authority
  'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', // Raydium LaunchLab authority
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', // Pump.fun fee / global
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', // Pump.fun fee recipient
]);
const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// A wallet that makes up a large share of one mint's events on BOTH sides is that mint's pool, not a trader.
export function poolWallets(events, { share = 0.3, minEvents = 8 } = {}) {
  const byMint = new Map();
  for (const e of events) { let m = byMint.get(e.mint); if (!m) byMint.set(e.mint, m = { total: 0, w: new Map() }); m.total++; const x = m.w.get(e.wallet) || { n: 0, buy: 0, sell: 0 }; x.n++; e.side === 'BUY' ? x.buy++ : x.sell++; m.w.set(e.wallet, x); }
  const pools = new Set(), perMint = new Map();
  for (const [mint, m] of byMint) {
    if (m.total < minEvents) continue;
    for (const [wallet, x] of m.w) if (x.buy && x.sell && x.n / m.total >= share) { pools.add(wallet); perMint.set(mint, (perMint.get(mint) || 0) + 1); }
  }
  return pools;
}

// Grades wallets from events (any order). Only priced legs (sol_delta != 0) form round trips.
export function computeWalletScorecards(rawEvents = [], { minRoundTrips = 3, limit = 50, now = Date.now() } = {}) {
  const events = rawEvents.map(e => ({ wallet: String(e.wallet || ''), mint: String(e.mint || ''), side: e.side === 'SELL' ? 'SELL' : 'BUY', ts: n(e.ts), tokens: Math.abs(n(e.token_delta ?? e.tokenDelta)), sol: n(e.sol_delta ?? e.solDelta) }))
    .filter(e => e.wallet && e.mint && e.tokens > 0).sort((a, b) => a.ts - b.ts);
  const pools = poolWallets(events), excluded = new Set([...PROGRAM_WALLETS, ...pools]);
  const firstBuy = new Map(); for (const e of events) if (e.side === 'BUY' && !excluded.has(e.wallet) && !firstBuy.has(e.mint)) firstBuy.set(e.mint, e.ts);
  const wallets = new Map(); let priced = 0, unpriced = 0;
  for (const e of events) {
    if (excluded.has(e.wallet)) continue;
    const isPriced = e.side === 'BUY' ? e.sol < 0 : e.sol > 0; isPriced ? priced++ : unpriced++;
    let w = wallets.get(e.wallet); if (!w) wallets.set(e.wallet, w = { wallet: e.wallet, mints: new Map(), trips: [], early: [], unpriced: 0, lastTs: 0 });
    w.lastTs = Math.max(w.lastTs, e.ts);
    let m = w.mints.get(e.mint); if (!m) { w.mints.set(e.mint, m = { lots: [] }); if (e.side === 'BUY') w.early.push((e.ts - (firstBuy.get(e.mint) ?? e.ts)) / 60000); }
    if (!isPriced) { w.unpriced++; if (e.side === 'BUY') m.lots.push({ qty: e.tokens, costPerToken: null, ts: e.ts }); else consume(m, e.tokens); continue; }
    if (e.side === 'BUY') { m.lots.push({ qty: e.tokens, costPerToken: -e.sol / e.tokens, ts: e.ts }); continue; }
    // SELL: match FIFO against priced lots; unpriced lots break the trip (counted, not graded).
    let left = e.tokens, cost = 0, matched = 0, heldMs = 0, broken = false;
    while (left > 1e-12 && m.lots.length) {
      const lot = m.lots[0], q = Math.min(lot.qty, left);
      if (lot.costPerToken === null) broken = true; else { cost += q * lot.costPerToken; matched += q; heldMs += q * (e.ts - lot.ts); }
      lot.qty -= q; left -= q; if (lot.qty <= 1e-12) m.lots.shift();
    }
    if (broken || matched <= 0) continue;
    const proceeds = e.sol * (matched / e.tokens), pnl = proceeds - cost;
    w.trips.push({ pnl, holdMin: heldMs / matched / 60000, costSol: cost });
  }
  const graded = [];
  for (const w of wallets.values()) {
    const k = w.trips.length; if (!k) continue;
    const wins = w.trips.filter(t => t.pnl > 0).length, realized = w.trips.reduce((a, t) => a + t.pnl, 0), spent = w.trips.reduce((a, t) => a + t.costSol, 0);
    const perTrip = realized / k, shrink = k / (k + 10);
    // Ranking heuristic, not a signal: 50 = no edge; moves toward 0/100 only with many round trips.
    const score = Math.round((50 + 50 * Math.tanh(perTrip / 0.05) * shrink) * 10) / 10;
    graded.push({ wallet: w.wallet, roundTrips: k, wins, winRate: Math.round(wins / k * 1000) / 1000, realizedSol: Math.round(realized * 1e6) / 1e6, returnPct: spent > 0 ? Math.round(realized / spent * 10000) / 100 : null,
      medianHoldMin: Math.round((median(w.trips.map(t => t.holdMin)) ?? 0) * 10) / 10, medianEntryAfterFirstBuyMin: median(w.early) === null ? null : Math.round(median(w.early) * 10) / 10,
      mints: w.mints.size, unpricedEvents: w.unpriced, lastTs: w.lastTs, score, graded: k >= minRoundTrips });
  }
  graded.sort((a, b) => Number(b.graded) - Number(a.graded) || b.score - a.score || b.roundTrips - a.roundTrips);
  return { schema: SCORECARD_SCHEMA, at: now, events: events.length, pricedShare: priced + unpriced ? Math.round(priced / (priced + unpriced) * 1000) / 1000 : null,
    excludedPools: pools.size, walletsWithTrips: graded.length, graded: graded.filter(x => x.graded).length, minRoundTrips, wallets: graded.slice(0, limit), researchOnly: true };
}
function consume(m, qty) { let left = qty; while (left > 1e-12 && m.lots.length) { const lot = m.lots[0], q = Math.min(lot.qty, left); lot.qty -= q; left -= q; if (lot.qty <= 1e-12) m.lots.shift(); } }

// Reads the last `days` of tx_events (capped) from alpha-lab.sqlite, opened read-only and closed right away
// (a lingering handle would lock the file on Windows). A missing DB is an empty scorecard. Cached; never throws.
let cache = { at: 0, value: null };
export function walletScorecardSnapshot({ file, days = 14, maxRows = 200000, ttlMs = 10 * 60000, now = Date.now(), force = false } = {}) {
  if (!force && cache.value && now - cache.at < ttlMs) return cache.value;
  let db = null;
  try {
    if (!file || !fs.existsSync(file)) { cache = { at: now, value: { ...computeWalletScorecards([], { now }), days, note: 'no swap events indexed yet' } }; return cache.value; }
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT wallet,mint,side,ts,token_delta,sol_delta FROM tx_events WHERE ts>=? ORDER BY ts DESC LIMIT ?').all(now - days * 864e5, maxRows);
    const last = db.prepare('SELECT MAX(ts) mx FROM tx_events').get()?.mx ?? null;
    cache = { at: now, value: { ...computeWalletScorecards(rows, { now }), days, truncated: rows.length >= maxRows, lastEventAt: last } };
  } catch (e) { cache = { at: now, value: { schema: SCORECARD_SCHEMA, at: now, error: String(e?.message || e).slice(0, 200), wallets: [] } }; }
  finally { try { db?.close(); } catch {} }
  return cache.value;
}
// wallet -> score for graded wallets only (used as holder quality; ungraded wallets keep the old default).
export function gradedScores(snapshot) { return new Map((snapshot?.wallets || []).filter(w => w.graded).map(w => [w.wallet, w.score])); }
export const __testing = { resetCache() { cache = { at: 0, value: null }; } };
