import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P4.3 / AUDIT exec #5 — "the trade-path brain (src/index.js: cycle/enter/updatePositions) is a
// top-level script that exports nothing, so it cannot be imported by a test."
//
// Measured at HEAD (2026-09-28), the claim splits in two. The import half is FALSE and was false at
// the revision the audit was written against: main() has been behind the isMainModule guard since
// bbc8f4d, so importing src/index.js evaluates the module in ~0.55 s, starts nothing at all (the
// import probe found no timers, no sockets, no dashboard) and runs no cycle. The export half was
// TRUE: `export { main }` was the entire surface, so cycle/enter/updatePositions were unreachable.
// That is what this file fixes and pins — it is the first behavioural oracle the money-deciding
// code has had. The alternatives were worse and are measured: the suite's only other access to this
// file is **23 literal `src/index.js` references across 10 test files** (string and line matching —
// none of them executes a line of cycle/enter/updatePositions) plus **2 full-process spawns**
// (`live-gate.test.mjs:170,178`, a `--once` boot that costs ~1.9 s and a live network round trip
// each; the import probe's run took a 429 from api.mainnet-beta.solana.com).
//
// The stub below doubles as the coupling measurement: `hosts` records every hostname the trade path
// actually reaches, so a new hidden dependency shows up as a failing assertion instead of a surprise.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-trade-path-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
Object.assign(process.env, {
  MONEY_PRINTER_DATA_DIR: dataDir,
  MODE: 'paper',
  MPO_LAB_LINK: 'false',
  POLYMARKET_AUTOSTART: 'false',
  ROBINHOOD_AUTOSTART: 'false',
  DASHBOARD_PORT: '0',
});

// Each test opens its own pool. dexscreener.js caches held-pool reads for 5 s keyed by pair, so a
// test that reused one pair id would be handed the previous test's mark and silently assert nothing
// (measured: the stop-loss case failed for exactly that reason before this registry existed).
let poolSeq = 0;
let MINT = '';
let PAIR = '';
let marketPriceUsd = 1;
const pools = new Map();
const openPool = () => {
  const n = String(++poolSeq).padStart(4, '0');
  MINT = `MintTradePath${n}1111111111111111111111111111`;
  PAIR = `PairTradePath${n}1111111111111111111111111111`;
  marketPriceUsd = 1;
  pools.set(PAIR, { mint: MINT });
  return { mint: MINT, pair: PAIR };
};
const hosts = new Map();

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const u = new URL(url);
  hosts.set(u.hostname, (hosts.get(u.hostname) || 0) + 1);
  if (u.hostname === '127.0.0.1') return nativeFetch(url, ...rest);
  // The only market read on the exit path: one batched exact-pool refresh (dexscreener.js).
  if (u.pathname.startsWith('/latest/dex/pairs/solana/')) {
    const ids = decodeURIComponent(u.pathname.slice('/latest/dex/pairs/solana/'.length)).split(',');
    const pairs = ids.map(id => pools.has(id) && {
      chainId: 'solana', pairAddress: id, baseToken: { address: pools.get(id).mint },
      priceUsd: String(marketPriceUsd), liquidity: { usd: 250_000 }, priceChange: { m5: 0 },
    }).filter(Boolean);
    return Response.json({ pairs });
  }
  // Discovery, seeds and RPC: an empty, benign market is enough to drive one cycle.
  return Response.json({ pairs: [], data: [] });
};

const engine = await import('../src/index.js');
const store = await import('../src/store.js');
const runtime = await import('../src/runtime.js');
// The engine's cycle path builds the process-scoped market platform inside `root`; its own close seam is
// what lets this suite clean up on Windows (see the teardown comment below).
const { closeMarketPlatform } = await import('../src/core/platform.js');

test.after(() => {
  globalThis.fetch = nativeFetch;
  // Why the close comes first: the cycle path builds the process-scoped market platform (SQLite
  // `CoreDatabase`) and the Pump.fun SDK under `root`, and on Windows those handles keep the directory
  // undeletable for the life of the process. Measured, not assumed: 20 x 250 ms of rmSync retries did not
  // clear them, and the same directories delete cleanly the moment the process is gone. The engine already
  // exposes the seam for exactly this — `closeMarketPlatform()` in src/core/platform.js — so the teardown
  // uses it instead of pretending the handles are not there; the retries then absorb whatever transient
  // lock is left. Same class of failure as MONEY_PRINTER_STATUS.md (EPERM in product-economics-http).
  try { closeMarketPlatform(); } catch {}
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    console.log(`trade-path: ${path.basename(root)} left under ${os.tmpdir()} — ${e.code} (a handle outside the platform's close seam survived)`);
  }
});

// A real cycle's empty-book state, from the engine's own load path (not a hand-built stub).
const freshState = () => {
  const s = store.loadState();
  s.market = { ...s.market, solUsd: 150 };
  return s;
};

const pick = () => ({
  mint: MINT, symbol: 'TP', name: 'Trade Path', priceUsd: 1, priceObservedAt: Date.now(),
  pairAddress: PAIR, liq: 250_000, score: 80, executionScore: 80, fastEdgeScore: 80,
});

const enteredState = async () => {
  const s = freshState();
  await engine.enter(s, pick());
  assert.equal(s.positions.length, 1, 'fixture precondition: the entry opened a position');
  return s;
};

test('exec #5: the trade path is reachable from a test — cycle, enter and updatePositions are exported', () => {
  for (const fn of ['cycle', 'enter', 'updatePositions']) {
    assert.equal(typeof engine[fn], 'function', `src/index.js must export ${fn} so it can be imported and driven`);
  }
  assert.equal(typeof engine.main, 'function', 'main is still exported');
});

test('a paper entry driven in-process debits cash by basis + fee and books the entry fee as realized loss', async () => {
  openPool();
  const s = freshState();
  const cashBefore = s.cashSol;
  await engine.enter(s, pick());

  assert.equal(s.positions.length, 1, 'the entry opens a paper position');
  const p = s.positions[0];
  const fee = Number(p.feesSol || 0);
  assert.ok(p.sizeSol > 0, 'a positive filled basis');
  assert.equal(p.remainingSol, p.sizeSol, 'nothing is sold at entry');
  assert.equal(p.mode, 'PAPER');
  assert.equal(p.pairAddress, PAIR, 'F7: the position is bound to the exact pool it was priced from');
  assert.equal(p.realizedSol, -fee, 'the entry fee is a realized loss the moment the fill lands');
  assert.ok(Math.abs((cashBefore - s.cashSol) - (p.sizeSol + fee)) < 1e-12, 'cash debited = filled basis + entry fee');
  assert.equal(s.stats.signals, 1);
  assert.ok(store.readJournal(500).some(r => r.type === 'trade-open' && r.mint === MINT), 'trade-open journalled');
});

test('a duplicate entry for the same mint is refused by the brain, not only by the caller', async () => {
  openPool();
  const s = await enteredState();
  const cash = s.cashSol;
  await engine.enter(s, pick());
  assert.equal(s.positions.length, 1, 'one position per mint');
  assert.equal(s.cashSol, cash, 'a refused entry moves no cash');
  assert.deepEqual(s.stats.entryRejectReasons,{'already-open':1});
});

// Exercise the actual downstream entry gates rather than merely searching for reason strings.
const rejectionCases = [
  ['strategy-regime-route', (s,p) => { p.routeDecision={decision:'BLOCK',reason:'strategy-regime-mismatch'}; }],
  ['blacklist', (s,p) => { s.runtime.blacklist.push(p.mint); }],
  ['price-stale-or-invalid', (s,p) => { p.priceObservedAt=Date.now()-31000; }],
  ['size-too-small', s => { s.cashSol=0; }],
  ['cost-gate', s => { Object.assign(s.runtime,runtime.operatingProfiles.SPRINT,{profile:'SPRINT'}); }],
  ['portfolio-risk', s => { s.runtime.profile='AGGRESSIVE_PAPER';s.portfolio={equitySol:1};s.portfolioPeakSol=2; }],
  // Custom exits allow the original cost gate to pass so the later SPRINT gates are reached.
  ['sprint-liquidity', (s,p) => { s.runtime.profile='SPRINT';s.runtime.exitPreset='custom';s.runtime.customExit={tp1:100};p.liq=14000; }],
  ['sprint-execution', (s,p) => { s.runtime.profile='SPRINT';s.runtime.exitPreset='custom';s.runtime.customExit={tp1:100};p.executionScore=39; }],
  ['sprint-friction', (s,p) => { s.runtime.profile='SPRINT';s.runtime.exitPreset='custom';s.runtime.customExit={tp1:100};p.micro={p10:100}; }],
  ['paper-routing', (s,p) => { p.assetClass='unknown-asset'; }],
  ['paper-integrity', (s,p) => { delete p.pairAddress; }],
];
for (const [reason,prepare] of rejectionCases) test(`entry diagnostic: ${reason} is recorded once without a fill or cash movement`,async () => {
  openPool();const s=freshState(),p=pick();prepare(s,p);
  const cash=s.cashSol,positions=structuredClone(s.positions),signals=s.stats.signals;
  await engine.enter(s,p);
  assert.deepEqual(s.stats.entryRejectReasons,{[reason]:1});
  assert.equal(s.stats.lastEntryReject.reason,reason);assert.equal(s.stats.lastEntryReject.mint,p.mint);
  assert.equal(s.stats.lastEntryReject.mode,'PAPER');
  assert.equal(s.cashSol,cash);assert.equal(s.stats.signals,signals);assert.deepEqual(s.positions,positions);
  if(reason==='cost-gate'){
    assert.equal(s.stats.skipReasons.costGate,1,'legacy cost counter is not double-counted');
    assert.equal(s.stats.skipped,1,'legacy skipped count retained');
    assert.ok(s.stats.lastEntryReject.requiredTp1Pct>s.stats.lastEntryReject.tp1);
  }
  if(reason==='paper-integrity')assert.equal(s.stats.lastEntryReject.detail,'missing-pair-address');
  if(reason==='portfolio-risk')assert.deepEqual(s.stats.lastEntryReject.details,['drawdown-flatten']);
});

test('simulator no-fill retains the precise cause, and a subsequent success creates no rejection',async () => {
  openPool();const s=freshState(),cash=s.cashSol;
  const saved=process.env.MPO_PAPER_PUMPFUN_REJECT_PROBABILITY;
  try {
    process.env.MPO_PAPER_PUMPFUN_REJECT_PROBABILITY='1';
    await engine.enter(s,pick());
    assert.deepEqual(s.stats.entryRejectReasons,{'simulated-fill-failure':1});
    assert.equal(s.stats.lastEntryReject.detail,'simulated-no-fill');
    assert.equal(s.cashSol,cash);assert.equal(s.positions.length,0);
    assert.equal(s.proposals[0].status,'REJECTED');
    const last=s.stats.lastEntryReject;
    process.env.MPO_PAPER_PUMPFUN_REJECT_PROBABILITY='0';
    await engine.enter(s,pick());
    assert.equal(s.positions.length,1);assert.equal(s.stats.signals,1);
    assert.equal(s.stats.lastEntryReject,last,'last historical rejection remains explicitly historical');
    assert.deepEqual(s.stats.entryRejectReasons,{'simulated-fill-failure':1});
  } finally { if(saved===undefined)delete process.env.MPO_PAPER_PUMPFUN_REJECT_PROBABILITY;else process.env.MPO_PAPER_PUMPFUN_REJECT_PROBABILITY=saved; }
});

test('the exit ladder reaches stale-purge through the real close path: position gone, cash up, cooldown set', async () => {
  openPool();
  const s = await enteredState();
  const p = s.positions[0];
  // ret stays 0 and the tick is flat, so take-profit, stop, break-even and trailing cannot fire;
  // the only leg left is held >= maxHold. Age the position rather than faking the policy.
  p.openedAt = Date.now() - 10 * 24 * 3600_000;
  p.highPrice = p.entryPrice;
  p.lastPrice = p.entryPrice;
  marketPriceUsd = p.entryPrice * 0.999;
  const cashBefore = s.cashSol;

  await engine.updatePositions(s);

  assert.equal(s.positions.length, 0, 'the stale position is closed');
  const closed = s.history.at(-1);
  assert.equal(closed.reason, 'stale-purge');
  assert.ok(s.cashSol > cashBefore, 'sale proceeds land in cash');
  assert.ok(s.cooldowns[MINT] > Date.now(), 'the close arms the cooldown');
  assert.equal(closed.mode, 'PAPER');
  // trade-close rows carry the trade object rather than a flat mint (index.js:121).
  assert.ok(store.readJournal(500).some(r => r.type === 'trade-close' && r.trade?.mint === MINT), 'trade-close journalled');
  // Round-trip identity across both legs. Cash out at entry was (basis + fee) and cash in at exit is
  // proceeds = gross - exitFee, while pnlSol = proceeds - basis - entryFee. `feesSol` on the closed
  // trade accumulates entry *and* exit fees (index.js:108), so the exit fee has to come back out:
  // cashChange = pnlSol + basis + feesSol - exitFee.
  const exitFee = Number(closed.lastPaperExecution?.feeSol || 0);
  assert.ok(Math.abs((s.cashSol - cashBefore) - (closed.pnlSol + closed.sizeSol + closed.feesSol - exitFee)) < 1e-9,
    'cash change reconciles against the booked pnl, basis and fees');
});

test('a stop-loss fires when the mark collapses but the tick did not jump, and the loss is booked', async () => {
  openPool();
  const s = await enteredState();
  const p = s.positions[0];
  const pr = runtime.exitPresets[s.runtime.exitPreset] || runtime.customExitPolicy(s.runtime);
  assert.ok(pr.stop < 50, 'fixture precondition: the active preset stops out tighter than -50%');
  // The band judges the *tick* (price vs lastPrice); the ladder judges the *return* (price vs
  // entryPrice). Setting both anchors to half the entry price keeps the tick flat — so the price is
  // accepted — while the return sits below -stop: the exit is the ladder's decision, not the band's.
  p.lastPrice = p.entryPrice * 0.5;
  p.highPrice = p.entryPrice;
  marketPriceUsd = p.entryPrice * 0.5;

  await engine.updatePositions(s);

  assert.equal(s.positions.length, 0, 'the stopped position is closed');
  const closed = s.history.at(-1);
  assert.equal(closed.reason, 'stop-loss');
  assert.ok(closed.pnlSol < 0, 'a stopped-out paper trade books a loss');
});

test('one full cycle runs in-process against the stubbed market and persists its counters', async () => {
  openPool();
  const s = freshState();
  s.stats.entryRejectReasons={'cost-gate':7};
  s.stats.lastEntryReject={at:Date.now()-60000,reason:'cost-gate',mode:'PAPER'};
  store.saveState(s);
  assert.equal(store.loadState().stats.cycles, 0, 'fixture precondition');

  await engine.cycle(null);

  const after = store.loadState();
  assert.equal(after.stats.cycles, 1, 'cycle() runs the engine mutex and persists');
  assert.equal(after.system.lastError, null, 'a clean cycle leaves no error behind');
  assert.deepEqual(after.system.opportunityFunnel.entryRejectionReasons,{},'counts belong to this cycle, not cumulative history');
  assert.equal(after.system.opportunityFunnel.lastEntryReject,null,'old rejection must not be attributed to a new cycle');
  assert.deepEqual(after.stats.entryRejectReasons,{'cost-gate':7});
  assert.equal(after.stats.lastEntryReject.reason,'cost-gate');
});

test('the trade path reaches only the hosts this stub knows about (coupling is measured, not assumed)', () => {
  const allowed = new Set(['api.dexscreener.com', 'api.geckoterminal.com', 'api.mainnet-beta.solana.com', '127.0.0.1']);
  const unexpected = [...hosts.keys()].filter(h => !allowed.has(h));
  assert.deepEqual(unexpected, [], `unexpected hosts reached by the trade path: ${unexpected.join(', ')}`);
  assert.ok(hosts.size > 0, 'the driven calls did reach the stubbed market');
});
