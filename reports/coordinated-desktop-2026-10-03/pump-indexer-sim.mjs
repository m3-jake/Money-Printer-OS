#!/usr/bin/env node
// Deterministic before/after simulation of the lean Pump wallet indexer under the SAME paced daily credit cap.
// Synthetic chain only (no network, no live data dir): 12 tracked mints with busy and quiet trade rates; every
// trader buys and later sells through one token account. Compares the committed indexer with a prior revision.
//   node reports/coordinated-desktop-2026-10-03/pump-indexer-sim.mjs <module-path> [minutes]
// Prints JSON: credits by method, transactions fetched, swap events captured, round trips and unmatched sells.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';

const modulePath = path.resolve(process.argv[2] || 'src/transactionIndexer.js'), minutes = Number(process.argv[3] || 120);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-indexer-sim-'));
process.env.MONEY_PRINTER_DATA_DIR = dir;
globalThis.fetch = async url => { throw new Error(`unexpected network call ${url}`); };
const ti = await import(pathToFileURL(modulePath).href);
const { scoreWallets } = await import(pathToFileURL(path.resolve('src/walletScorecard.js')).href);
const { alphaDb, closeAlphaDb } = await import(pathToFileURL(path.resolve('src/alphaDb.js')).href);

// Deterministic PRNG and keys.
let seed = 42; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let keyN = 0; const key = () => { const b = Buffer.alloc(32); b.writeUInt32LE(++keyN, 0); b.writeUInt32LE(0x5eed, 4); return Keypair.fromSeed(b).publicKey.toBase58(); };
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', FEE = 5000, RENT = 2039280;
const DAY0 = Date.parse('2026-10-03T12:00:00Z'), START = DAY0 - 30 * 60_000;
// Rates: trades per minute per mint (busy launches and quiet tokens), like the observed 3,000-signature windows.
const RATES = [600, 400, 250, 120, 60, 30, 15, 8, 4, 2, 1, 0.5];
const mints = RATES.map(rate => ({ mint: key(), rate, curve: key(), trades: [] }));
const sigs = new Map(), byAddress = new Map(); let sigN = 0;
const addSig = (addr, s) => { if (!byAddress.has(addr)) byAddress.set(addr, []); byAddress.get(addr).push(s); };
for (const m of mints) {
  const traders = Array.from({ length: Math.max(20, Math.round(m.rate * 30)) }, () => ({ wallet: key(), ata: key() }));
  for (let t = START; t < DAY0 + minutes * 60_000; t += 60_000) {
    const n = Math.floor(m.rate) + (rand() < m.rate % 1 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const tr = traders[Math.floor(rand() * traders.length)], at = t + Math.floor(rand() * 60_000), hold = 60_000 + Math.floor(rand() * 45 * 60_000);
      for (const [side, ts] of [['BUY', at], ['SELL', at + hold]]) {
        const sig = `s${++sigN}`.padEnd(64, 'x'), row = { signature: sig, blockTime: Math.floor(ts / 1000), ts, err: null };
        sigs.set(sig, { side, ts, mint: m, tr }); addSig(m.mint, row); addSig(tr.ata, row);
      }
    }
  }
}
for (const rows of byAddress.values()) rows.sort((a, b) => b.ts - a.ts || b.signature.localeCompare(a.signature));
const tb = (accountIndex, mint, owner, amount) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount), decimals: 6, uiAmountString: String(amount / 1e6) } });
function buildTx(sig) {
  const { side, ts, mint: m, tr } = sigs.get(sig), tokens = 35_000e6, sol = side === 'BUY' ? -1e9 : 0.9e9;
  const accounts = [{ key: tr.wallet, signer: true, pre: 5e9, post: 5e9 + sol - FEE }, { key: tr.ata, pre: RENT, post: RENT }, { key: m.curve, pre: 30e9, post: 30e9 - sol }, { key: m.mint, pre: 1461600, post: 1461600 }];
  const [pre, post] = side === 'BUY' ? [0, tokens] : [tokens, 0];
  return { blockTime: Math.floor(ts / 1000), slot: Math.floor(ts / 400), version: 0, transaction: { signatures: [sig], message: { accountKeys: accounts.map(a => ({ pubkey: a.key, signer: !!a.signer })), instructions: [{ programId: PUMP }] } },
    meta: { err: null, fee: FEE, preBalances: accounts.map(a => a.pre), postBalances: accounts.map(a => a.post), preTokenBalances: [tb(1, m.mint, tr.wallet, pre), tb(2, m.mint, m.curve, 1e15)], postTokenBalances: [tb(1, m.mint, tr.wallet, post), tb(2, m.mint, m.curve, 1e15 - (post - pre))], innerInstructions: [] } };
}
let clock = DAY0; const calls = {};
const fetcher = async (url, init) => {
  const { id, method, params } = JSON.parse(init.body); calls[method] = (calls[method] || 0) + 1;
  let result;
  if (method === 'getSignaturesForAddress') {
    const [addr, o] = params, rows = (byAddress.get(addr) || []).filter(r => r.ts <= clock - 15_000); // finalized lag
    let i = 0; if (o.before) i = rows.findIndex(r => r.signature === o.before) + 1;
    const out = []; for (; i < rows.length && out.length < o.limit; i++) { if (rows[i].signature === o.until) break; out.push({ signature: rows[i].signature, blockTime: rows[i].blockTime, err: null, slot: 0 }); }
    result = out;
  } else if (method === 'getTransaction') result = buildTx(params[0]);
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) };
};
const env = { INDEXER_RPC_URL: 'http://rpc.sim/', INDEXER_REQUESTS_PER_MINUTE: '600000', INDEXER_MIN_EDGE: '0', INDEXER_SCORE_MIN: '100000', INDEXER_DAILY_CREDITS: '7258' };
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ watchlist: mints.map((m, i) => ({ mint: m.mint, fastEdgeScore: 100 - i })) }));
// Start exactly on the paced line at 12:00 UTC: 7258 x 13/24 credits already spent today (about 5 credits/minute after).
fs.writeFileSync(path.join(dir, 'wallet-indexer-budget.json'), JSON.stringify({ day: '2026-10-03', credits: Math.floor(7258 * 13 / 24), calls: 0, byPath: {}, budgetSkips: 0, paceSkips: 0 }));
const spent0 = Math.floor(7258 * 13 / 24);
for (; clock < DAY0 + minutes * 60_000; clock += 15_000) await ti.walletIndexerTick({ dir, env, now: () => clock, fetcher, wait: async () => {} });
const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'wallet-indexer-budget.json'), 'utf8'));
const rows = alphaDb().prepare('SELECT signature,event_index eventIndex,ts,slot,mint,wallet,side,token_delta tokenDelta,sol_delta solDelta,raw_json FROM tx_events').all()
  .map(r => { const raw = JSON.parse(r.raw_json || '{}'); return { ...r, signer: raw.signer === true, feeSol: Number(raw.feeSol || 0) }; });
const card = scoreWallets(rows, { asOf: clock, minTrips: 10 });
const out = { module: path.relative(process.cwd(), modulePath), minutes, synthetic: true, creditsSpent: ledger.credits - spent0, callsByMethod: calls, byDetail: ledger.byDetail || null,
  txFetched: calls.getTransaction || 0, swapEvents: card.summary.swaps, wallets: card.summary.wallets, roundTrips: card.wallets.reduce((n, w) => n + w.roundTrips, 0),
  walletsWithRoundTrip: card.summary.withRoundTrip, unmatchedSells: card.summary.excluded.unmatchedSell, eventsPerCredit: +(card.summary.swaps / Math.max(1, ledger.credits - spent0)).toFixed(3),
  roundTripsPer100Credits: +(100 * card.wallets.reduce((n, w) => n + w.roundTrips, 0) / Math.max(1, ledger.credits - spent0)).toFixed(2) };
console.log(JSON.stringify(out));
closeAlphaDb(); fs.rmSync(dir, { recursive: true, force: true });
