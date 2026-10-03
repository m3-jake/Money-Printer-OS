import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { createPumpfunCopyPaper, qualifiedPumpCopyWallets, PUMP_COPY_DEFAULTS } from '../src/pumpfunCopyPaper.js';
import { buildScoreboard } from '../src/scoreboard.js';

const NOW = Date.parse('2026-10-03T18:00:00Z'), wallet = Keypair.generate().publicKey.toBase58(), mint = Keypair.generate().publicKey.toBase58();
const cardAt = at => ({ asOf: at - 10, wallets: [{ wallet, lastTs: at - 100, roundTrips: 12, realizedPnlSol: .4, pnlWithoutBestSol: .2, shrunkReturnPct: 6 }] });
const signalAt = (at, extra = {}) => ({ ts: at, mint, wallet, source: `copy:${wallet}`, side: 'BUY', signature: 'leader-buy', ...extra });
const RAW_PER_SOL = 1_000_000_000_000_000_000n;
function fixture(t, settings = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-pump-copy-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const state = { at: NOW, multiplier: 1, calls: [], rows: [], fail: false, stale: false, source: 'pumpfun-native-curve' };
  const adapter = { quote: async input => {
    assert.equal(input.mode, 'paper'); state.calls.push(input);
    if (state.fail) throw new Error('No current executable route');
    const rawAmount = input.action === 'BUY' ? (BigInt(Math.round(input.sizeSol * 1e9)) * RAW_PER_SOL / 1_000_000_000n).toString() : input.rawAmount;
    const solAmount = input.action === 'BUY' ? input.sizeSol : Number(BigInt(rawAmount)) / Number(RAW_PER_SOL) * state.multiplier;
    const q = { rawAmount, solAmount, source: state.source, observedAt: state.stale ? NOW - 60_000 : state.at };
    const result = { ...q, plan: { mode: 'PAPER', action: input.action, mint: input.mint, quote: q, unsigned: true, orderSubmitted: false,
      signatureFeeLamports: 5000, priorityFeeLamports: 300, jito: { tipLamports: 1000, submitted: false }, ...state.planPatch } };
    state.onQuote?.(input, result); return result;
  } };
  const options = { dataDir, adapter, now: () => state.at, scorecard: () => cardAt(state.at), logger: row => state.rows.push(row), settings };
  const book = createPumpfunCopyPaper(options), context = () => ({ solUsd: 200, solUsdAt: state.at, card: cardAt(state.at) });
  return { book, state, dataDir, options, context };
}

test('qualification uses a prior fresh card and cannot be carried by the best winning trip', () => {
  const card = cardAt(NOW);
  assert.equal(qualifiedPumpCopyWallets(card, { asOf: NOW }).length, 1);
  for (const patch of [{ roundTrips: 2 }, { realizedPnlSol: -1 }, { pnlWithoutBestSol: 0 }, { lastTs: card.asOf }]) {
    assert.deepEqual(qualifiedPumpCopyWallets({ ...card, wallets: [{ ...card.wallets[0], ...patch }] }, { asOf: NOW }), []);
  }
  assert.deepEqual(qualifiedPumpCopyWallets({ ...card, asOf: NOW + 1 }, { asOf: NOW }), []);
  assert.deepEqual(qualifiedPumpCopyWallets(card, { asOf: NOW + PUMP_COPY_DEFAULTS.maxScorecardAgeMs }), []);
});

test('live mode and old signals make no quote calls; unqualified wallets remain waiting', async t => {
  const { book, state, context } = fixture(t);
  assert.equal((await book.onSignal(signalAt(NOW), { ...context(), mode: 'live' })).reason, 'paper-only');
  assert.equal((await book.maintain({ ...context(), mode: 'live' })).reason, 'paper-only');
  assert.equal(state.calls.length, 0); assert.equal(fs.existsSync(book.file), false);
  assert.equal((await book.onSignal(signalAt(NOW - 1), context())).reason, 'old-or-invalid-source-signal');
  assert.equal((await book.onSignal(signalAt(NOW, { signature: 'fresh' }), { ...context(), card: { asOf: NOW - 1, wallets: [] } })).reason, 'wallet-evidence-unqualified');
  assert.equal(state.calls.length, 0); assert.equal(book.view().open.length, 0);
});

test('cash starts at $25 using fresh observed SOL FX, and never funds from stale FX', async t => {
  const { book, state, context } = fixture(t);
  assert.equal(book.view().cashSol, null); assert.equal(book.view().status, 'WAITING_FOR_SOL_PRICE');
  const d = await book.onSignal(signalAt(NOW), { ...context(), solUsdAt: NOW - 300_000 });
  assert.equal(d.reason, 'fresh-sol-price-required'); assert.equal(book.view().cashSol, null); assert.equal(state.calls.length, 0);
  await book.maintain(context());
  assert.equal(book.view().startUsd, 25); assert.equal(book.view().startSol, .125); assert.equal(book.view().cashSol, .125);
  assert.equal(book.view().equityUsd, 25);
});

test('new leader buys fill exact raw quantities, charge both quote costs, and persist duplicate protection', async t => {
  const { book, state, options, context } = fixture(t);
  const d = await book.onSignal(signalAt(NOW), context()); assert.equal(d.accepted, true);
  const p = d.position;
  assert.ok(BigInt(p.rawAmount) > BigInt(Number.MAX_SAFE_INTEGER), 'raw quantity is too large for a safe JS integer');
  assert.equal(p.rawAmount, (BigInt(p.quotedRawAmount) * 9900n / 10_000n).toString());
  assert.equal(state.calls[1].rawAmount, p.rawAmount, 'executable sell quotes use exactly the tokens actually filled');
  assert.equal(p.costSol, .0125 + .0000063);
  assert.equal(book.view().cashSol, .125 - p.costSol); assert.equal(book.view().open.length, 1);
  assert.equal(p.leaderAtEntry.scorecardAsOf, NOW - 10); assert.equal(p.orderSubmitted, false);
  assert.equal((await createPumpfunCopyPaper(options).onSignal(signalAt(NOW), context())).reason, 'duplicate-signal');
  assert.equal(state.calls.length, 2);
  state.multiplier = 1.5; state.at += 31_000;
  const result = await book.maintain(context()); assert.equal(result.closed, 1); assert.equal(result.ordersSubmitted, 0);
  const trade = book.view().history[0], credit = Number(BigInt(p.rawAmount)) / Number(RAW_PER_SOL) * 1.5 * .99 - .0000063;
  assert.equal(trade.proceedsSol, credit); assert.equal(trade.pnlSol, credit - p.costSol);
  assert.equal(book.view().cashSol, .125 - p.costSol + credit);
  assert.equal(trade.reason, 'take-profit'); assert.ok(state.rows.some(r => r.action === 'CLOSE'));
});

test('missing, stale, non-executable and expensive quotes never debit cash or create a fill', async t => {
  for (const variant of ['fail', 'stale', 'mid', 'expensive']) {
    const { book, state, context } = fixture(t);
    if (variant === 'mid') state.source = 'dexscreener-mid'; else if (variant === 'expensive') state.multiplier = .8; else state[variant] = true;
    const d = await book.onSignal(signalAt(NOW), context());
    assert.equal(d.accepted, false); assert.equal(book.view().open.length, 0); assert.equal(book.view().cashSol, .125);
    assert.equal(d.reason, variant === 'expensive' ? 'round-trip-cost-wall' : 'executable-quote-unavailable');
  }
});

test('unavailable exits preserve held tokens and cash even beyond max hold, then close at the next real quote', async t => {
  const { book, state, context } = fixture(t, { maxHoldMs: 30_000 });
  await book.onSignal(signalAt(NOW), context()); const cash = book.view().cashSol;
  state.at += 31_000; state.fail = true;
  assert.equal((await book.maintain(context())).closed, 0);
  assert.equal(book.view().cashSol, cash); assert.equal(book.view().history.length, 0); assert.equal(book.view().open.length, 1);
  assert.equal(book.view().equitySol, null); assert.equal(book.view().status, 'QUOTE_UNAVAILABLE');
  state.at += 31_000; state.fail = false;
  assert.equal((await book.maintain(context())).closed, 1); assert.equal(book.view().history[0].reason, 'max-hold');
});

test('serialized simultaneous buys obey the cap and preserve reserve cash', async t => {
  const { book, state, context } = fixture(t, { maxOpen: 1 });
  const other = Keypair.generate().publicKey.toBase58();
  const [a, b] = await Promise.all([book.onSignal(signalAt(NOW), context()), book.onSignal(signalAt(NOW, { mint: other, signature: 'second' }), context())]);
  assert.equal(a.accepted, true); assert.equal(b.reason, 'open-cap-or-mint-held');
  assert.equal(book.view().open.length, 1); assert.equal(state.calls.length, 2);
  assert.ok(book.view().cashSol >= book.view().startSol * .2);
});

test('corrupt saved accounts fail closed and retain their bytes', async t => {
  const { book, context } = fixture(t);
  fs.writeFileSync(book.file, '{bad account');
  const bytes = fs.readFileSync(book.file, 'utf8');
  assert.throws(() => book.view(), /JSON/); await assert.rejects(book.onSignal(signalAt(NOW), context()), /JSON/);
  assert.equal(fs.readFileSync(book.file, 'utf8'), bytes);
});

test('persisted risk, balances, duplicate positions and future marks cannot fabricate an account', async t => {
  const { book, context, state } = fixture(t); await book.onSignal(signalAt(NOW), context());
  const valid = fs.readFileSync(book.file, 'utf8');
  const mutations = [b => { b.settings.reservePct = 0; }, b => { b.cashSol = 10; }, b => { b.open[0].costSol = String(b.open[0].costSol); },
    b => { b.open.push(b.open[0]); }, b => { b.open[0].lastQuoteAt = state.at + 1; }, b => { b.fxAt = state.at + 1; },
    b => { b.startSol = null; }, b => { b.history = [{ pnlSol: 100 }]; }];
  for (const mutate of mutations) {
    const b = JSON.parse(valid); mutate(b); const bytes = JSON.stringify(b); fs.writeFileSync(book.file, bytes);
    assert.throws(() => book.view(), /Invalid Pump copy paper account/); assert.equal(fs.readFileSync(book.file,'utf8'),bytes);
  }
});

test('native quotes must match an unsigned unsubmitted paper plan for the requested asset and side', async t => {
  for (const patch of [{ unsigned: false }, { mint: Keypair.generate().publicKey.toBase58() }, { action: 'SELL' }, { mode: 'LIVE' }, { jito: { submitted: true, tipLamports: 1000 } }]) {
    const { book, state, context } = fixture(t); state.planPatch = patch;
    assert.equal((await book.onSignal(signalAt(NOW), context())).accepted, false); assert.equal(book.view().open.length,0); assert.equal(book.view().cashSol,.125);
  }
});

test('quote delays recheck source age and paused engines never fetch a quote', async t => {
  const { book, state, context } = fixture(t);
  assert.equal((await book.onSignal(signalAt(NOW), { ...context(), entriesAllowed: false })).reason,'engine-paused-or-killed'); assert.equal(state.calls.length,0);
  state.at += 119_000; const ctx = { ...context(), card: cardAt(NOW) };
  state.onQuote = () => { state.at += 1500; };
  assert.equal((await book.onSignal(signalAt(NOW),ctx)).reason,'signal-or-fx-expired-during-quote'); assert.equal(book.view().open.length,0);
});

test('journal failures cannot reverse a completed fill, while failed persistence never reports a fill', async t => {
  const { book, state, options, context } = fixture(t);
  const throwsJournal = createPumpfunCopyPaper({ ...options, logger: () => { throw Error('journal unavailable'); } });
  assert.equal((await throwsJournal.onSignal(signalAt(NOW), context())).accepted,true);
  state.multiplier = 1.5; state.at += 31_000;
  assert.equal((await throwsJournal.maintain(context())).closed,1); assert.equal(throwsJournal.view().history.length,1);
  const before = fs.readFileSync(book.file,'utf8'), rename = fs.renameSync;
  try {
    fs.renameSync = (from,to) => { if(to===book.file) throw Object.assign(Error('Disk full'),{code:'ENOSPC'}); return rename(from,to); };
    await assert.rejects(book.onSignal(signalAt(state.at,{signature:'new-buy'}), context()),/Disk full/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(book.file,'utf8'),before); assert.equal(book.view().open.length,0);
});

test('copy scoreboard uses only recorded after-cost closes and cash baseline', async t => {
  const { book, state, context } = fixture(t);
  await book.onSignal(signalAt(NOW), context()); state.multiplier = 1.5; state.at += 31_000; await book.maintain(context());
  const rows = buildScoreboard({ pumpfunCopy: book.view() }, { now: state.at }).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'pumpfun-copy'); assert.equal(rows[0].closes, 1);
  assert.equal(rows[0].unit, 'SOL'); assert.equal(rows[0].baseline.netPnl, 0); assert.equal(rows[0].beatsBaseline, 'NOT ENOUGH DATA');
  assert.ok(Math.abs(rows[0].netPnl - book.view().history[0].pnlSol) < .000001);
});
