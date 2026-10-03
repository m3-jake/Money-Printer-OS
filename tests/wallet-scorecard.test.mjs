// Pump.fun copy-trading step 2: lean capped indexer (2a) and point-in-time wallet scorecard (2b). No network:
// every RPC answer comes from an injected fetcher or a stubbed globalThis.fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-wallet-scorecard-'));
process.env.MONEY_PRINTER_DATA_DIR = dataDir;
const savedFetch = globalThis.fetch;
globalThis.fetch = async url => { throw new Error(`unexpected network call ${url}`); };

const { cfg } = await import('../src/config.js');
const ti = await import('../src/transactionIndexer.js');
const { scoreWallets, isWalletAddress, walletScorecardView } = await import('../src/walletScorecard.js');
const { recordUniverse, ensureResearch } = await import('../src/research.js');
const { alphaDb, closeAlphaDb } = await import('../src/alphaDb.js');

test.after(() => { globalThis.fetch = savedFetch; closeAlphaDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUc5c4Xhu5AmvWc', WSOL = ti.WSOL_MINT, RENT = 2039280, FEE = 5000;
const key = () => Keypair.generate().publicKey.toBase58();
const pda = (seed, mint) => PublicKey.findProgramAddressSync([Buffer.from(seed), new PublicKey(mint).toBuffer()], new PublicKey(PUMP))[0].toBase58();
const tb = (accountIndex, mint, owner, amount, decimals = 6) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount), decimals, uiAmountString: String(amount / 10 ** decimals) } });
// accounts: [{key, signer, pre, post}] in account-key order; index 0 pays the fee.
function tx({ accounts, preTok = [], postTok = [], programs = [PUMP], blockTime = 1_790_000_000, err = null }) {
  return { blockTime, slot: blockTime, transaction: { signatures: ['sig'], message: { accountKeys: accounts.map(a => ({ pubkey: a.key, signer: !!a.signer, writable: true, source: 'transaction' })), instructions: programs.map(p => ({ programId: p })) } },
    meta: { err, fee: FEE, preBalances: accounts.map(a => a.pre), postBalances: accounts.map(a => a.post), preTokenBalances: preTok, postTokenBalances: postTok, innerInstructions: [] } };
}
// Pump.fun bonding-curve buy: 1 SOL to the curve, 0.01 SOL protocol fee, new ATA rent, network fee.
function curveBuy({ wallet, mint, tokens = 35_000e6, sol = 1e9, blockTime }) {
  const curve = pda('bonding-curve', mint), curveAta = key(), ata = key(), feeRecipient = key();
  return tx({ blockTime, accounts: [
    { key: wallet, signer: true, pre: 5e9, post: 5e9 - sol - 1e7 - RENT - FEE }, { key: ata, pre: 0, post: RENT },
    { key: curve, pre: 30e9, post: 30e9 + sol }, { key: curveAta, pre: RENT, post: RENT }, { key: feeRecipient, pre: 1e9, post: 1e9 + 1e7 }, { key: mint, pre: 1461600, post: 1461600 } ],
    preTok: [tb(3, mint, curve, 1e15)], postTok: [tb(1, mint, wallet, tokens), tb(3, mint, curve, 1e15 - tokens)] });
}
// PumpSwap sell paid out in WSOL into the wallet's persistent WSOL account.
function wsolSell({ wallet, mint, tokens = 35_000e6, sol = 0.8e9, blockTime }) {
  const pool = pda('pool', mint), ata = key(), wsolAcct = key(), poolBase = key(), poolQuote = key();
  return tx({ blockTime, programs: [PUMPSWAP], accounts: [
    { key: wallet, signer: true, pre: 1e9, post: 1e9 - FEE }, { key: ata, pre: RENT, post: RENT }, { key: wsolAcct, pre: RENT + 0.5e9, post: RENT + 0.5e9 + sol },
    { key: pool, pre: 1e7, post: 1e7 }, { key: poolBase, pre: RENT, post: RENT }, { key: poolQuote, pre: RENT + 50e9, post: RENT + 50e9 - sol } ],
    preTok: [tb(1, mint, wallet, tokens), tb(2, WSOL, wallet, 0.5e9, 9), tb(4, mint, pool, 1e12), tb(5, WSOL, pool, 50e9, 9)],
    postTok: [tb(1, mint, wallet, 0), tb(2, WSOL, wallet, 0.5e9 + sol, 9), tb(4, mint, pool, 1e12 + tokens), tb(5, WSOL, pool, 50e9 - sol, 9)] });
}

test('bonding-curve buy: SOL spent excludes rent and fee, the curve PDA is dropped', () => {
  const wallet = key(), mint = key(), ev = ti.parseSwapEvents(curveBuy({ wallet, mint }), mint, { signature: 's1' });
  assert.equal(ev.length, 1, 'only the signer, not the bonding curve');
  assert.equal(ev[0].wallet, wallet); assert.equal(ev[0].side, 'BUY'); assert.equal(ev[0].tokenDelta, 35_000);
  assert.ok(Math.abs(ev[0].solDelta - -1.01) < 1e-9, `1 SOL + 0.01 protocol fee, got ${ev[0].solDelta}`);
  assert.equal(ev[0].raw.signer, true); assert.equal(ev[0].raw.program, 'pump'); assert.equal(ev[0].raw.feeSol, FEE / 1e9);
  assert.ok(Math.abs(ev[0].raw.rentSol - RENT / 1e9) < 1e-12);
});

test('PumpSwap sell paid in WSOL: SOL received counts the WSOL leg, pool rows are dropped', () => {
  const wallet = key(), mint = key(), ev = ti.parseSwapEvents(wsolSell({ wallet, mint }), mint);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].side, 'SELL'); assert.ok(Math.abs(ev[0].solDelta - 0.8) < 1e-9, `got ${ev[0].solDelta}`);
  assert.ok(Math.abs(ev[0].raw.wsolDelta - 0.8) < 1e-9); assert.equal(ev[0].raw.program, 'pumpswap');
});

test('router swap where the owner signs but a relayer pays the fee', () => {
  const relayer = key(), owner = key(), mint = key(), ata = key(), poolAta = key(), pool = pda('pool', mint);
  const t = tx({ programs: [JUP, PUMP], accounts: [
    { key: relayer, signer: true, pre: 1e9, post: 1e9 - FEE }, { key: owner, signer: true, pre: 2e9, post: 1.5e9 }, { key: ata, pre: RENT, post: RENT }, { key: poolAta, pre: RENT, post: RENT } ],
    preTok: [tb(2, mint, owner, 0), tb(3, mint, pool, 1e9)], postTok: [tb(2, mint, owner, 1000e6), tb(3, mint, pool, 1e9 - 1000e6)] });
  const ev = ti.parseSwapEvents(t, mint);
  assert.deepEqual(ev.map(e => e.wallet), [owner]);
  assert.equal(ev[0].solDelta, -0.5); assert.equal(ev[0].raw.feePayer, false); assert.equal(ev[0].raw.feeSol, 0);
  assert.equal(ev[0].raw.router, 'jupiter'); assert.equal(ev[0].raw.program, 'pump');
});

test('temporary WSOL wrapped and closed inside the tx, non-signer recipients and failed txs', () => {
  const wallet = key(), mint = key(), ata = key(), tmp = key(), stranger = key(), strangerAta = key(), pool = pda('pool', mint), poolAta = key();
  const t = tx({ accounts: [
    { key: wallet, signer: true, pre: 3e9, post: 3e9 - 0.3e9 - FEE }, { key: ata, pre: RENT, post: RENT }, { key: tmp, pre: 0, post: 0 },
    { key: stranger, pre: 1e9, post: 1e9 }, { key: strangerAta, pre: RENT, post: RENT }, { key: poolAta, pre: RENT, post: RENT } ],
    preTok: [tb(1, mint, wallet, 0), tb(4, mint, stranger, 0), tb(5, mint, pool, 1e9)], postTok: [tb(1, mint, wallet, 500e6), tb(4, mint, stranger, 7e6), tb(5, mint, pool, 1e9 - 507e6)] });
  const ev = ti.parseSwapEvents(t, mint);
  assert.deepEqual(ev.map(e => e.wallet), [wallet], 'a non-signer that received tokens is not a trader');
  assert.ok(Math.abs(ev[0].solDelta - -0.3) < 1e-9);
  assert.deepEqual(ti.parseSwapEvents({ ...t, meta: { ...t.meta, err: { InstructionError: [0, 'Custom'] } } }, mint), []);
});

test('Helius enhanced path records SOL from accountData instead of a hard-coded 0, fee payer only', () => {
  const w = key(), mint = key(), curve = pda('bonding-curve', mint), wAta = key(), cAta = key();
  const ev = ti.parseEnhancedSwapEvents({ signature: 'h1', timestamp: 1000, slot: 5, fee: FEE, feePayer: w, type: 'SWAP', source: 'PUMP_FUN', accountData: [
    { account: w, nativeBalanceChange: -(1e9 + RENT + FEE), tokenBalanceChanges: [] },
    { account: wAta, nativeBalanceChange: RENT, tokenBalanceChanges: [{ userAccount: w, tokenAccount: wAta, mint, rawTokenAmount: { tokenAmount: '35000000000', decimals: 6 } }] },
    { account: curve, nativeBalanceChange: 1e9, tokenBalanceChanges: [{ userAccount: curve, tokenAccount: cAta, mint, rawTokenAmount: { tokenAmount: '-35000000000', decimals: 6 } }] } ] }, mint);
  assert.equal(ev.length, 1); assert.equal(ev[0].wallet, w); assert.equal(ev[0].side, 'BUY'); assert.equal(ev[0].solDelta, -1);
  assert.deepEqual(ti.parseEnhancedSwapEvents({ feePayer: w, tokenTransfers: [] }, mint), [], 'no accountData: no guessed SOL');
});

// ---------- scorecard ----------
const T0 = Date.parse('2026-09-01T00:00:00Z');
const ev = (wallet, mint, side, tokens, sol, tsSec, extra = {}) => ({ signature: `${wallet}-${mint}-${tsSec}-${side}`, eventIndex: 0, ts: T0 + tsSec * 1000, slot: tsSec, mint, wallet, side, tokenDelta: side === 'BUY' ? tokens : -tokens, solDelta: sol, signer: true, feeSol: 0, ...extra });

test('FIFO realized PnL with partial sells, fees charged, hold time, one round trip', () => {
  const w = key(), m = key();
  const { wallets, summary } = scoreWallets([
    ev(w, m, 'BUY', 100, -1, 0, { feeSol: 0.01 }), ev(w, m, 'SELL', 50, 0.8, 60), ev(w, m, 'SELL', 50, 0.4, 300, { feeSol: 0.01 }),
  ], { asOf: T0 + 3600_000 });
  const x = wallets[0];
  assert.equal(x.roundTrips, 1); assert.equal(x.wins, 1); assert.equal(x.winRate, 1);
  assert.equal(x.realizedPnlSol, 0.18, '0.8+0.39-1.01'); assert.equal(x.medianHoldSec, 300); assert.equal(x.graded, false);
  assert.equal(summary.withRoundTrip, 1); assert.equal(summary.graded, 0);
});

test('no lookahead: events at or after asOf never change the score, an open trip is not a win', () => {
  const w = key(), m = key(), asOf = T0 + 100_000;
  const past = [ev(w, m, 'BUY', 100, -1, 0), ev(w, m, 'SELL', 100, 1.5, 50), ev(w, m, 'BUY', 100, -1, 90)];
  const future = [ev(w, m, 'SELL', 100, 9, 100), ev(w, m, 'SELL', 1, 9, 200), ev(w, key(), 'BUY', 5, -1, 150)];
  const a = scoreWallets(past, { asOf }), b = scoreWallets([...future, ...past], { asOf });
  assert.deepEqual(b, a);
  assert.equal(a.wallets[0].roundTrips, 1); assert.equal(a.wallets[0].realizedPnlSol, 0.5); assert.equal(a.wallets[0].openPositions, 1);
  assert.equal(scoreWallets([...past, ...future], { asOf: T0 + 1_000_000 }).wallets[0].roundTrips, 2, 'the later sell counts once it is in the past');
});

test('PDAs, non-signers and legs without SOL are excluded; unmatched sells are not free profit', () => {
  const w = key(), m = key(), curve = pda('bonding-curve', m);
  assert.equal(isWalletAddress(w), true); assert.equal(isWalletAddress(curve), false); assert.equal(isWalletAddress('not-a-key'), false);
  const { wallets, summary } = scoreWallets([
    ev(curve, m, 'BUY', 100, -1, 0), ev(key(), m, 'BUY', 100, -1, 1, { signer: false }), ev(w, m, 'SELL', 100, 2, 2), ev(w, m, 'BUY', 100, 0, 3), ev(w, m, 'SELL', 50, 0, 4),
  ], { asOf: T0 + 10_000 });
  assert.deepEqual(summary.excluded, { notSigner: 1, notWallet: 1, noSolLeg: 2, unmatchedSell: 1 });
  assert.equal(wallets[0].realizedPnlSol, 0); assert.equal(wallets[0].roundTrips, 0);
});

test('earliness only on mints with complete history; grading needs 10 round trips with shrinkage', () => {
  const early = key(), late = key(), m = key(), rows = [ev(early, m, 'BUY', 10, -0.1, 5), ev(late, m, 'BUY', 10, -0.1, 65)];
  for (let i = 0; i < 10; i++) { const mi = key(); rows.push(ev(early, mi, 'BUY', 10, -1, 1000 + i * 10), ev(early, mi, 'SELL', 10, 1.2, 1005 + i * 10)); }
  const opt = { asOf: T0 + 10_000_000 }, x = scoreWallets(rows, { ...opt, mintMeta: { [m]: { historyComplete: true } } }).wallets;
  const e = x.find(r => r.wallet === early), l = x.find(r => r.wallet === late);
  assert.equal(e.graded, true); assert.equal(e.roundTrips, 10); assert.equal(e.winRate, 1);
  assert.equal(e.meanReturnPct, 20); assert.equal(e.shrunkReturnPct, 10, '10 trips shrunk with k=10 halves the mean');
  assert.equal(e.medianEntrySec, 0); assert.equal(e.medianBuyRank, 1); assert.equal(l.medianEntrySec, 60); assert.equal(l.medianBuyRank, 2);
  assert.equal(x[0].wallet, early, 'graded wallets rank first');
  const noMeta = scoreWallets(rows, opt).wallets.find(r => r.wallet === late);
  assert.equal(noMeta.medianEntrySec, null, 'unknown mint start: earliness is not guessed');
  const gap = scoreWallets(rows, { ...opt, mintMeta: { [m]: { historyComplete: true, firstGapTs: T0 + 60_000 } } }).wallets.find(r => r.wallet === late);
  assert.equal(gap.medianEntrySec, null, 'a buy after a coverage gap has no trustworthy rank');
});

test('Wallet Intel ingestion keeps only on-curve owners and prunes legacy pool/program profiles', () => {
  const s = { positions: [], history: [] }; ensureResearch(s);
  const mint = key(), wallet = key(), curve = pda('bonding-curve', mint), legacy = pda('pool', mint);
  s.research.walletProfiles[legacy] = { address: legacy, seen: 2, tokens: {}, recurrenceScore: 52.86 };
  recordUniverse(s, { mint, symbol: 'X', priceUsd: 1, risk: { largest: [{ address: key(), owner: wallet }, { address: key(), owner: curve }, { address: key(), owner: null }] } });
  assert.deepEqual(Object.keys(s.research.walletProfiles), [wallet]);
});

// ---------- lean indexer tick ----------
const NOW = Date.parse('2026-09-26T23:30:00Z');
function fakeRpc(handlers) {
  const seen = [];
  const fetcher = async (url, init) => { const { id, method, params } = JSON.parse(init.body); seen.push({ url, method, params }); const result = await handlers[method](params); return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) }; };
  return { fetcher, seen };
}
function tickDir(watch) { const d = fs.mkdtempSync(path.join(dataDir, 'tick-')); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ watchlist: watch })); return d; }
const ENV = { INDEXER_RPC_URL: 'http://rpc.test/?api-key=SECRET', INDEXER_REQUESTS_PER_MINUTE: '600000', INDEXER_MIN_EDGE: '40', INDEXER_SCORE_MIN: '0' };
const nowAt = t => () => t, noWait = async () => {};

test('indexer tick: oldest-first pull, signer swaps with SOL stored, scorecard and health written', async () => {
  const wallet = key(), mint = key(), bt = Math.floor(NOW / 1000) - 3600;
  const txs = { sigA: curveBuy({ wallet, mint, blockTime: bt }), sigB: wsolSell({ wallet, mint, blockTime: bt + 60 }) };
  const rpc = fakeRpc({ getSignaturesForAddress: ([, o]) => o.until ? [] : [{ signature: 'sigB', blockTime: bt + 60, err: null }, { signature: 'sigA', blockTime: bt, err: null }], getTransaction: ([sig]) => txs[sig] });
  const dir = tickDir([{ mint, symbol: 'CT', fastEdgeScore: 70 }, { mint: key(), fastEdgeScore: 10 }]);
  const h = await ti.walletIndexerTick({ dir, env: { ...ENV }, now: nowAt(NOW), fetcher: rpc.fetcher, wait: noWait });
  assert.equal(h.status, 'OK'); assert.equal(h.credits, 3); assert.equal(h.trackedMints, 1, 'low-edge mint is not tracked');
  assert.deepEqual(rpc.seen.map(x => x.method), ['getSignaturesForAddress', 'getTransaction', 'getTransaction']);
  assert.deepEqual(rpc.seen.slice(1).map(x => x.params[0]), ['sigA', 'sigB'], 'oldest first');
  const rows = alphaDb().prepare(`SELECT side,sol_delta,source,raw_json FROM tx_events WHERE mint=? ORDER BY ts`).all(mint);
  assert.deepEqual(rows.map(r => r.side), ['BUY', 'SELL']); assert.ok(rows.every(r => r.sol_delta !== 0 && r.source === 'indexer-rpc' && JSON.parse(r.raw_json).signer === true));
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'wallet-indexer-state.json'), 'utf8')).mints[mint];
  assert.equal(st.cursorSig, 'sigB'); assert.equal(st.historyComplete, true); assert.equal(st.firstTs, bt * 1000);
  const card = JSON.parse(fs.readFileSync(path.join(dir, 'wallet-scorecard.json'), 'utf8')), mine = card.wallets.find(x => x.wallet === wallet);
  assert.equal(mine.roundTrips, 1); assert.ok(Math.abs(mine.realizedPnlSol - (0.799995 - 1.010005)) < 1e-4); assert.equal(mine.medianBuyRank, 1);
  assert.equal(card.summary.solLegPct, 100); assert.equal(card.summary.graded, 0);
  const view = walletScorecardView({ dir, now: NOW });
  assert.equal(view.indexer.status, 'OK'); assert.equal(view.indexer.credits, 3); assert.equal(view.summary.withRoundTrip, card.summary.withRoundTrip); assert.equal(view.minTrips, 10);
  const later = NOW + 6 * 60_000; rpc.seen.length = 0;
  await ti.walletIndexerTick({ dir, env: { ...ENV }, now: nowAt(later), fetcher: rpc.fetcher, wait: noWait });
  assert.equal(rpc.seen.length, 1); assert.equal(rpc.seen[0].params[1].until, 'sigB', 'the next pull only asks for newer signatures');
});

test('hard daily cap: no call beyond it, progress kept, status BUDGET; the cap survives a restart', async () => {
  const wallet = key(), mint = key(), bt = Math.floor(NOW / 1000) - 600;
  const rpc = fakeRpc({ getSignaturesForAddress: () => [2, 1, 0].map(i => ({ signature: `c${i}`, blockTime: bt + i, err: null })), getTransaction: () => curveBuy({ wallet, mint, blockTime: bt }) });
  const dir = tickDir([{ mint, fastEdgeScore: 90 }]), env = { ...ENV, INDEXER_DAILY_CREDITS: '2' };
  const h = await ti.walletIndexerTick({ dir, env, now: nowAt(NOW), fetcher: rpc.fetcher, wait: noWait });
  assert.equal(rpc.seen.length, 2); assert.equal(h.status, 'BUDGET'); assert.equal(h.credits, 2); assert.equal(h.dailyCredits, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'wallet-indexer-state.json'), 'utf8')).mints[mint].cursorSig, 'c0');
  const h2 = await ti.walletIndexerTick({ dir, env, now: nowAt(NOW + 10 * 60_000), fetcher: rpc.fetcher, wait: noWait });
  assert.equal(rpc.seen.length, 2, 'same UTC day, ledger on disk: still capped'); assert.equal(h2.status, 'BUDGET');
});

test('spend is paced over the UTC day, the kill flag stops all calls, and keys never reach health', async () => {
  const mint = key(), rpc = fakeRpc({ getSignaturesForAddress: () => [{ signature: 'p1', blockTime: 1, err: null }, { signature: 'p0', blockTime: 1, err: null }], getTransaction: () => curveBuy({wallet:key(),mint,blockTime:1}) });
  const early = Date.parse('2026-09-27T00:30:00Z');
  const h = await ti.walletIndexerTick({ dir: tickDir([{ mint, fastEdgeScore: 90 }]), env: { ...ENV, INDEXER_DAILY_CREDITS: '32' }, now: nowAt(early), fetcher: rpc.fetcher, wait: noWait });
  assert.equal(h.status, 'PACING'); assert.equal(rpc.seen.length, 2, '32 x 1.5h/24h = 2 credits allowed at 00:30');
  const off = fakeRpc({});
  const h2 = await ti.walletIndexerTick({ dir: tickDir([{ mint, fastEdgeScore: 90 }]), env: { ...ENV, WALLET_INDEXER_ENABLED: 'false' }, now: nowAt(NOW), fetcher: off.fetcher, wait: noWait });
  assert.equal(h2.status, 'OFF'); assert.equal(off.seen.length, 0);
  const boom = async () => { throw new Error('connect ECONNREFUSED http://rpc.test/?api-key=SECRET'); };
  const h3 = await ti.walletIndexerTick({ dir: tickDir([{ mint, fastEdgeScore: 90 }]), env: { ...ENV }, now: nowAt(NOW), fetcher: boom, wait: noWait });
  assert.equal(h3.status, 'ERROR'); assert.doesNotMatch(JSON.stringify(h3), /SECRET/); assert.equal(h3.provider, 'rpc.test');
});

test('default cap fits the Helius free plan next to the holder cap; enhanced calls cost 100 from the same ledger', async () => {
  assert.equal(ti.defaultIndexerDailyCredits(25000), 7258);
  assert.ok((ti.defaultIndexerDailyCredits(25000) + 25000) * 31 <= ti.HELIUS_FREE_MONTHLY_CREDITS);
  assert.equal(ti.indexerConfig({}).dailyCredits, ti.defaultIndexerDailyCredits(cfg.holderRpcDailyCalls));
  let calls = 0; globalThis.fetch = async url => { calls++; assert.match(String(url), /^https:\/\/api\.helius\.xyz\//); return Response.json([]); };
  const savedKey = cfg.heliusApiKey; cfg.heliusApiKey = 'test-key'; process.env.INDEXER_DAILY_CREDITS = '150';
  try {
    assert.deepEqual(await ti.indexWalletFunding(key()), []); assert.equal(calls, 1);
    assert.deepEqual(await ti.indexWalletFunding(key()), []); assert.equal(calls, 1, 'second 100-credit call refused before any request');
    const r = await ti.indexMintTransactions(key(), 50); assert.match(r.error, /credit cap/); assert.equal(calls, 1);
    const c = ti.creditLedger().health(); assert.equal(c.byPath['enhanced-funding'], 100); assert.equal(c.dailyCredits, 150);
  } finally { cfg.heliusApiKey = savedKey; delete process.env.INDEXER_DAILY_CREDITS; globalThis.fetch = async url => { throw new Error(`unexpected network call ${url}`); }; }
});

test('the research collector runs the lean indexer tick without the alpha worker', () => {
  const src = fs.readFileSync(new URL('../src/researchCollector.js', import.meta.url), 'utf8');
  assert.match(src, /import\('\.\/transactionIndexer\.js'\)\)\.then\(m=>m\.walletIndexerTick\(\{onEvents:/);
  assert.doesNotMatch(src, /alphaWorker/);
  assert.doesNotMatch(fs.readFileSync(new URL('../src/transactionIndexer.js', import.meta.url), 'utf8'), /process\.env\.HELIUS_API_KEY\s*=/);
});

test('wallet follow-up retains fetched exits when a later request exhausts the credit budget', async () => {
  const wallet = key(), mint = key(), bt = Math.floor(NOW / 1000) - 600;
  const dir = tickDir([]), follow = { wallet, mint, tokenAccount: key(), untilSig: 'buy', buyTs: NOW - 600000,
    boughtQty: 70000, soldQty: 0, priority: 0, createdAt: NOW - 600000, lastAt: 0, attempts: 0,
    pending: [['exit-kept', bt, 0], ['exit-retry', bt + 60, 0]], gaps: 0, sellsFound: 0, status: 'OPEN' };
  fs.writeFileSync(path.join(dir, 'wallet-indexer-state.json'), JSON.stringify({ mints: {}, health: {}, followups: { [`${wallet}:${mint}`]: follow } }));
  const rpc = fakeRpc({ getTransaction: () => wsolSell({ wallet, mint, blockTime: bt }) });
  const result = await ti.walletIndexerTick({ dir, env: { ...ENV, INDEXER_DAILY_CREDITS: '1', INDEXER_SCORE_MIN: '100000' }, now: nowAt(NOW), fetcher: rpc.fetcher, wait: noWait });
  assert.equal(result.status, 'BUDGET'); assert.equal(result.yieldToday.followupTx, 1); assert.equal(result.yieldToday.followupEvents, 1);
  assert.ok(alphaDb().prepare('SELECT 1 FROM tx_events WHERE signature=?').get('exit-kept'));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'wallet-indexer-state.json'))).followups[`${wallet}:${mint}`];
  assert.equal(saved.untilSig, 'exit-kept'); assert.deepEqual(saved.pending.map(x => x[0]), ['exit-retry']);
});

test('duplicate index paths do not add an event twice to wallet token positions', async () => {
  const { upsertTxEvent } = await import('../src/alphaDb.js'), wallet = key(), mint = key();
  const e = { signature: 'duplicate-paths', eventIndex: 0, ts: NOW, wallet, mint, side: 'BUY', tokenDelta: 10, solDelta: -1 };
  upsertTxEvent(e); upsertTxEvent(e);
  assert.equal(alphaDb().prepare('SELECT net_tokens FROM wallet_token_positions WHERE wallet=? AND mint=?').get(wallet, mint).net_tokens, 10);
});

test('multi-mint transaction aggregates coexist without repeating legacy position quantities',async()=>{
 const {upsertTxEvent}=await import('../src/alphaDb.js'),wallet=key(),a=key(),b=key(),signature='multi-mint-collision';
 const e={signature,eventIndex:0,ts:NOW,wallet,mint:a,side:'BUY',tokenDelta:10,solDelta:-1};
 assert.equal(upsertTxEvent(e),true);assert.equal(upsertTxEvent({...e,mint:b,tokenDelta:20}),true);
 assert.equal(upsertTxEvent(e),false);assert.equal(upsertTxEvent({...e,mint:b,tokenDelta:20}),false);
 assert.equal(alphaDb().prepare('SELECT COUNT(*) n FROM tx_events WHERE signature=?').get(signature).n,2);
 assert.equal(alphaDb().prepare('SELECT net_tokens FROM wallet_token_positions WHERE wallet=? AND mint=?').get(wallet,b).net_tokens,20);
 upsertTxEvent({...e,signature:'earlier-receipt',ts:NOW-1000,side:'SELL',tokenDelta:-2});
 assert.equal(alphaDb().prepare('SELECT last_ts FROM wallet_token_positions WHERE wallet=? AND mint=?').get(wallet,a).last_ts,NOW);
});

test('wallet follow-up does not skip its sell when another mint from that signature was indexed',async()=>{
 const {upsertTxEvent}=await import('../src/alphaDb.js'),wallet=key(),mint=key(),dir=tickDir([]),bt=Math.floor(NOW/1000)-600;
 upsertTxEvent({signature:'multi-mint-followup',eventIndex:0,ts:NOW-1000,wallet,mint:key(),side:'BUY',tokenDelta:10,solDelta:-1});
 const follow={wallet,mint,tokenAccount:key(),untilSig:'buy',buyTs:NOW-600000,boughtQty:70000,soldQty:0,priority:0,createdAt:NOW-600000,lastAt:0,attempts:0,pending:[['multi-mint-followup',bt,0]],gaps:0,sellsFound:0,status:'OPEN'};
 fs.writeFileSync(path.join(dir,'wallet-indexer-state.json'),JSON.stringify({mints:{},health:{},followups:{[`${wallet}:${mint}`]:follow}}));
 const rpc=fakeRpc({getTransaction:()=>wsolSell({wallet,mint,blockTime:bt})});
 await ti.walletIndexerTick({dir,env:{...ENV,INDEXER_SCORE_MIN:'100000'},now:nowAt(NOW),fetcher:rpc.fetcher,wait:noWait});
 assert.ok(alphaDb().prepare('SELECT 1 FROM tx_events WHERE signature=? AND wallet=? AND mint=?').get('multi-mint-followup',wallet,mint));
});

test('full scored wallet policy input remains available behind the public sixteen-row view',async()=>{
 const dir=tickDir([]),wallets=Array.from({length:80},(_,i)=>({wallet:key(),roundTrips:10,realizedPnlSol:i===79?2:-1,pnlWithoutBestSol:i===79?1:-2,lastTs:NOW-1,shrunkReturnPct:100-i}));
 fs.writeFileSync(path.join(dir,'wallet-scorecard.json'),JSON.stringify({asOf:NOW,summary:{wallets:80},wallets}));
 const view=walletScorecardView({dir,now:NOW});assert.equal(view.wallets.length,16);assert.equal(view.coverage.omittedFromView,64);
 const card=walletScorecardView({dir,now:NOW,full:true});assert.equal(card.wallets.length,80);assert.equal(card.coverage.persistenceOmissions,0);
 const {qualifiedPumpCopyWallets}=await import('../src/pumpfunCopyPaper.js');
 assert.equal(qualifiedPumpCopyWallets(view,{asOf:NOW}).length,0);
 assert.equal(qualifiedPumpCopyWallets(card,{asOf:NOW}).length,1,'a robust wallet behind rejected high-return rows still reaches strict qualification');
 const page=walletScorecardView({dir,now:NOW,offset:75,limit:10});assert.equal(page.wallets.length,5);assert.equal(page.wallets[4].wallet,wallets[79].wallet);
});

test('a newly observed buy can reopen a completed wallet follow-up slot without resetting its evidence counters',()=>{
 const wallet=key(),mint=key(),state={followups:{[`${wallet}:${mint}`]:{wallet,mint,buyTs:NOW-1000,status:'CLOSED',closedAt:NOW-500}},followupStats:{created:1,closed:1,expired:0,dropped:0,sellsFound:1}};
 ti.noteFollowupEvents(state,[{wallet,mint,side:'BUY',signature:'fresh-reentry',ts:NOW,tokenDelta:20,raw:{tokenAccount:key()}}],{followupQueue:128},{now:NOW});
 assert.equal(state.followups[`${wallet}:${mint}`].status,'OPEN');assert.equal(state.followups[`${wallet}:${mint}`].untilSig,'fresh-reentry');
 assert.equal(state.followupStats.closed,1);assert.equal(state.followupStats.created,2);
});
