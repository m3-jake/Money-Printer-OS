import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolymarketCopyPaper } from '../src/polymarketCopy.js';
import { KalshiMirrorPaper } from '../src/kalshiMirror.js';
import { fetchLeaderTrades, classifyCopyMarket, CopyMetadataCache, CopyReadCache, copyLatencySummary } from '../src/copyEvent.js';
const NOW = 1800000000000, wallet = '0x' + 'a'.repeat(40);
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-pipeline-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const trade = (patch = {}) => ({ transactionHash: 'buy', timestamp: NOW / 1000, asset: 'asset', side: 'BUY', size: 100, price: .5, title: 'Bitcoin above $100000?', outcome: 'Yes', outcomeIndex: 0, ...patch });
function setup(dir, overrides = {}) {
  const env = { now: NOW + 1000, trades: [trade()], offline: false, bids: [{ price: .49, size: 100 }], calls: [], ...overrides };
  const create = extra => new PolymarketCopyPaper({ dataDir: dir, now: () => env.now, fetchImpl: async url => { env.calls.push(url); if (url.includes('/trades')) return { ok: true, json: async () => env.trades }; if (url.includes('/book')) { if (env.offline) throw new Error('offline'); if (env.bookGate) await env.bookGate; return { ok: true, json: async () => ({ asks: [{ price: .51, size: 100 }], bids: env.bids }) }; } return { ok: true, json: async () => [{ feesEnabled: false, closed: env.closed || false, outcomePrices: '["1","0"]', tags: [{ label: 'Crypto' }] }] }; }, ...extra });
  const bot = create(); bot.state.follows = [{ wallet, name: 'leader', followedAt: NOW - 1000 }]; bot.state.settings.follows = 1; bot.state.settings.stakeUsd = 5; bot.state.settings.minLeaderTradeUsd = 1; return { env, bot, create };
}
test('transient entry intent survives restart and duplicate/out-of-order pages without duplicate exposure', async t => {
  const { env, bot, create } = setup(fixture(t), { offline: true });
  await bot.run({ settlement: false }); assert.equal(bot.snapshot().pendingIntents, 1); assert.equal(bot.state.open.length, 0);
  env.offline = false; env.trades = [trade(), trade()]; const restarted = create(); await restarted.run({ settlement: false });
  assert.equal(restarted.state.open.length, 1); assert.equal(restarted.snapshot().pendingIntents, 0); assert.equal(restarted.state.open[0].marketType, 'Crypto');
  const cash = restarted.state.cashUsd; await restarted.run({ settlement: false }); assert.equal(restarted.state.cashUsd, cash);
  assert.equal(restarted.state.receipts.at(-1).status, 'FILLED'); assert.ok(restarted.state.receipts.at(-1).quoteAt >= restarted.state.receipts.at(-1).firstObservedAt);
});
test('modeled processing latency defers quote capture; stale buys never spend', async t => {
  const { env, bot } = setup(fixture(t)); bot.state.settings.processingLatencyMs = 500;
  await bot.run({ settlement: false }); assert.equal(env.calls.filter(u => u.includes('/book')).length, 0);
  env.now += 500; await bot.run({ settlement: false }); assert.equal(bot.state.open.length, 1);
  env.trades = [trade({ transactionHash: 'stale', asset: 'old', timestamp: (NOW - 31 * 60000) / 1000 })];
  await bot.run({ settlement: false }); assert.equal(bot.state.open.length, 1);
});
test('evicted leaders free discovery slots and their positions retain partial exit supervision', async t => {
  const { env, bot } = setup(fixture(t)); await bot.run({ settlement: false }); const initial = bot.state.open[0].qty;
  bot.state.evicted = { [wallet]: { at: env.now } }; bot.state.settings.enabled = false;
  env.bids = []; env.trades = [trade({ transactionHash: 'sell', side: 'SELL', size: 50, timestamp: (NOW + 1) / 1000 })];
  await bot.run({ settlement: false }); assert.equal(bot.state.follows.length, 0); assert.equal(bot.state.exitLeaders.length, 1); assert.equal(bot.state.open[0].qty, initial); assert.ok(bot.state.open[0].pendingExitQty > 0);
  env.bids = [{ price: .49, size: 100 }]; await bot.run({ settlement: false });
  assert.ok(Math.abs(bot.state.open[0].qty - initial / 2) < .000002); assert.equal(bot.state.history.length, 1); assert.equal(bot.state.history[0].status, 'PARTIAL_SOLD');
  const cash = bot.state.cashUsd; await bot.run({ settlement: false }); assert.equal(bot.state.cashUsd, cash);
});
test('bounded pagination marks missing catch-up honestly and deduplicates overlapping pages', async () => {
  const urls = []; const r = await fetchLeaderTrades(async u => { urls.push(u); return [trade(), trade({ transactionHash: 'second' })]; }, wallet, { pageSize: 2, maxPages: 2 });
  assert.equal(r.complete, false); assert.equal(r.trades.length, 2); assert.match(urls[1], /offset=2/);
});
test('unreadable copy book exposes unknown cash and never overwrites evidence', async t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, 'polymarket-copy-paper.json'), '{broken'); const { bot } = setup(dir);
  assert.equal(bot.snapshot().cashUsd, null); await assert.rejects(bot.run(), /unreadable/); assert.equal(fs.readFileSync(bot.file, 'utf8'), '{broken');
});
test('separate funded exploratory policy preserves incumbent and immutable identity', t => {
  const dir = fixture(t), opts = { dataDir: dir, now: () => NOW, experiment: { id: 'cohort-a', policy: 'direct', exploratory: true, startUsd: 25, settings: { stakeUsd: 1 } } };
  const bot = new PolymarketCopyPaper(opts); assert.equal(bot.state.cashUsd, 25); assert.equal(bot.state.experiment.qualification, 'UNQUALIFIED_EXPLORATORY');
  assert.throws(() => new PolymarketCopyPaper({ ...opts, experiment: { ...opts.experiment, id: 'changed' } }), /immutable/);
  assert.equal(new PolymarketCopyPaper(opts).state.cashUsd, 25);
});
test('metadata cache never caches execution quotes and title inference is labeled', async () => {
  let count = 0; const cache = new CopyMetadataCache(); await cache.get('a', async () => ++count); await cache.get('a', async () => ++count); await cache.get('a', async () => ++count, true); assert.equal(count, 2);
  assert.equal(classifyCopyMarket({}, trade()), 'crypto (title inferred)');
});
test('shared discovery reads coalesce but every follower execution quote remains independent', async () => {
  const cache = new CopyReadCache(); let reads = 0;
  const loader = async () => { reads++; return []; };
  const url = 'https://data-api.polymarket.com/trades?user=wallet&limit=100';
  await Promise.all([cache.get(url, loader), cache.get(url, loader)]); assert.equal(reads, 1); assert.equal(cache.stats.coalesced, 1);
  await cache.get(url, loader); assert.equal(reads, 1);
  await cache.get('https://clob.polymarket.com/book?token_id=1', loader); await cache.get('https://clob.polymarket.com/book?token_id=1', loader); assert.equal(reads, 3);
});
test('Kalshi mirrored exits retain failed bids and persist wallet/timing attribution', async t => {
  const dir = fixture(t); let bids = [], now = NOW, marketCalls = 0;
  const feeModel = { venue: 'kalshi', rate: .07, rounding: 'CENT_PER_ORDER' };
  const k = { market: async () => { marketCalls++; return { data: { status: 'ACTIVE', yesAsk: .5, yesBid: .48, feeModel } }; }, book: async () => ({ yes: { asks: [{ price: .5, quantity: 100 }], bids } }) };
  const events = [{ day: '2027-01-01', participants: ['Broncos', '49ers'], contracts: [{ venue: 'kalshi', type: 'GAME_WINNER', sourceId: 'GAME-DEN', side: 'Broncos' }] }];
  let bot = new KalshiMirrorPaper({ dataDir: dir, kalshi: () => k, sports: async () => ({ events }), now: () => now });
  const buy = trade({ title: 'Broncos vs. 49ers', outcome: 'Broncos', eventSlug: 'nfl-2027-01-01' });
  bot.enqueue({ wallet, name: 'leader' }, buy); await bot.run({ settlement: false }); assert.equal(bot.state.open.length, 1); assert.equal(bot.state.open[0].leaderWallet, wallet); assert.equal(marketCalls, 1);
  now += 1000; bot.enqueue({ wallet, name: 'leader' }, { ...buy, transactionHash: 'exit', side: 'SELL', timestamp: now / 1000 }); await bot.run({ settlement: false }); assert.equal(bot.state.queue.length, 1);
  bids = [{ price: .6, quantity: 100 }]; bot = new KalshiMirrorPaper({ dataDir: dir, kalshi: () => k, sports: async () => ({ events }), now: () => now }); await bot.run({ settlement: false });
  assert.equal(bot.state.queue.length, 0); assert.equal(bot.state.open.length, 0); assert.equal(bot.state.history[0].status, 'LEADER_SOLD'); assert.equal(bot.state.history[0].exitSourceTradeId, 'exit');
});
test('multiple failed leader exits retain distinct quantities and never replay earlier partial requests', async t => {
  const { env, bot, create } = setup(fixture(t)); await bot.run({ settlement: false }); const qty = bot.state.open[0].qty;
  env.bids = []; env.trades = [trade({ transactionHash: 'exit-a', side: 'SELL', size: 40 }), trade({ transactionHash: 'exit-b', side: 'SELL', size: 10 })]; await bot.run({ settlement: false });
  assert.equal(Object.keys(bot.state.open[0].exitRequests).length, 2); assert.ok(Math.abs(bot.state.open[0].pendingExitQty - qty / 2) < .000002);
  env.bids = [{ price: .49, size: 100 }]; const restarted = create(); await restarted.run({ settlement: false }); const cash = restarted.state.cashUsd;
  assert.ok(Math.abs(restarted.state.open[0].qty - qty / 2) < .000002); await restarted.run({ settlement: false }); assert.equal(restarted.state.cashUsd, cash); assert.equal(restarted.state.history.length, 2);
});
test('settlement can complete during a failed exit lookup without double payout', async t => {
  const { env, bot } = setup(fixture(t)); await bot.run({ settlement: false }); const qty = bot.state.open[0].qty, cash = bot.state.cashUsd;
  let release; env.bookGate = new Promise(r => { release = r; }); env.trades = [trade({ transactionHash: 'exit', side: 'SELL', size: 100 })];
  const running = bot.run({ settlement: false }); await new Promise(r => setTimeout(r, 15)); env.closed = true; await bot.runSettlement(); release(); await running;
  assert.equal(bot.state.open.length, 0); assert.equal(bot.state.history.length, 1); assert.equal(bot.state.history[0].status, 'RESOLVED'); assert.ok(Math.abs(bot.state.cashUsd - cash - qty) < .000002);
});
test('source handoff retry remains durable after the follower entry has filled', async t => {
  const dir = fixture(t); let unavailable = true, handed = 0; const { bot, create } = setup(dir);
  const handoff = () => { if (unavailable) throw Error('mirror offline'); handed++; }; bot.onLeaderEvent = handoff;
  await bot.run({ settlement: false }); assert.equal(bot.state.open.length, 1); assert.equal(bot.snapshot().pendingHandoffs, 1);
  unavailable = false; const restarted = create({ onLeaderEvent: handoff }); await restarted.run({ settlement: false }); assert.equal(handed, 1); assert.equal(restarted.snapshot().pendingHandoffs, 0); assert.equal(restarted.state.open.length, 1);
});
test('category specialist uses documented category leaderboard and requires provider-labeled markets', async t => {
  const dir = fixture(t); let now = NOW, trades = [], category = 'Crypto', calls = [];
  const bot = new PolymarketCopyPaper({ dataDir: dir, now: () => now, experiment: { id: 'crypto-v1', policy: 'category-specialist', category: 'CRYPTO', exploratory: true, startUsd: 25, settings: { stakeUsd: 1, follows: 1, minLeaderTradeUsd: 1, minLeaderVolumeUsd: 0, minLeaderMargin: 0 } }, fetchImpl: async url => { calls.push(url); return { ok: true, json: async () => url.includes('leaderboard') ? [{ proxyWallet: wallet, pnl: 100, vol: 1000 }] : url.includes('/trades') ? trades : url.includes('/book') ? { asks: [{ price: .51, size: 100 }], bids: [] } : [{ feesEnabled: false, category }] }; } });
  await bot.run({ settlement: false }); assert.ok(calls.some(u => u.includes('category=CRYPTO')));
  now += 1000; trades = [trade({ timestamp: now / 1000 })]; await bot.run({ settlement: false }); assert.equal(bot.state.open.length, 1); assert.equal(bot.state.open[0].receipt.leaderSelection.leaderboardCategory, 'CRYPTO');
  category = 'Sports'; now += 1000; trades = [trade({ asset: 'other', transactionHash: 'sports', timestamp: now / 1000 })]; await bot.run({ settlement: false }); assert.equal(bot.state.open.length, 1); assert.match(bot.state.decisions[0].reason, /provider-labeled crypto/);
});
test('bounded latency summary excludes unknown timings and separates observation from fill', () => {
  const s = copyLatencySummary([{ eventAt: 1000, firstObservedAt: 2000, decisionAt: 2500, quoteAt: 2600, fillAt: 2700, status: 'FILLED', fills: [{ price: .5, quantity: 1 }] }, { status: 'SKIPPED', reason: 'missing source' }]);
  assert.deepEqual(s.sourceToObserve, { n: 1, p50Ms: 1000, p95Ms: 1000 }); assert.equal(s.observeToFill.p95Ms, 700); assert.equal(s.rejectionReasons['missing source'], 1);
});
test('four independent cohorts reuse discovery while retaining four fresh follower books', async t => {
  const root = fixture(t), readCache = new CopyReadCache(), metadataCache = new CopyMetadataCache(); let now = NOW, trades = [], discoveryReads = 0, books = 0;
  const bots = Array.from({ length: 4 }, (_, i) => new PolymarketCopyPaper({ dataDir: path.join(root, `cohort-${i}`), readCache, metadataCache, now: () => now, experiment: { id: `cohort-${i}`, policy: 'direct', exploratory: true, startUsd: 25, settings: { follows: 1, stakeUsd: 1, minLeaderTradeUsd: 1, minLeaderVolumeUsd: 0, minLeaderMargin: 0 } }, fetchImpl: async url => { if (url.includes('leaderboard') || url.includes('/trades')) discoveryReads++; if (url.includes('/book')) books++; return { ok: true, json: async () => url.includes('leaderboard') ? [{ proxyWallet: wallet, pnl: 100, vol: 1000 }] : url.includes('/trades') ? trades : url.includes('/book') ? { asks: [{ price: .51, size: 100 }], bids: [] } : [{ feesEnabled: false }] }; } }));
  await Promise.all(bots.map(b => b.run({ settlement: false }))); assert.equal(discoveryReads, 2);
  readCache.entries.clear(); now += 1000; trades = [trade({ timestamp: now / 1000 })]; await Promise.all(bots.map(b => b.run({ settlement: false })));
  assert.equal(discoveryReads, 3); assert.equal(books, 4); assert.ok(bots.every(b => b.state.open.length === 1)); assert.equal(new Set(bots.map(b => b.file)).size, 4);
});
test('restart completes receipt journaling for an already committed exposure', async t => {
  const { env, bot, create } = setup(fixture(t)); await bot.run({ settlement: false }); const i = Object.values(bot.state.intents).find(i => i.status === 'FILLED'); i.receiptLogged = false; bot.state.receipts = []; bot.save();
  const restarted = create(); await restarted.run({ settlement: false }); assert.equal(restarted.state.receipts.length, 1); assert.equal(restarted.state.receipts[0].status, 'FILLED'); assert.equal(restarted.state.open.length, 1);
});
