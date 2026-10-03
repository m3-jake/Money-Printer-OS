import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolymarketCopyPaper } from '../src/polymarketCopy.js';
import { KalshiMirrorPaper } from '../src/kalshiMirror.js';
import { fetchLeaderTrades, classifyCopyMarket, CopyMetadataCache, CopyReadCache } from '../src/copyEvent.js';
const NOW = 1800000000000, wallet = '0x' + 'a'.repeat(40);
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-pipeline-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const trade = (patch = {}) => ({ transactionHash: 'buy', timestamp: NOW / 1000, asset: 'asset', side: 'BUY', size: 100, price: .5, title: 'Bitcoin above $100000?', outcome: 'Yes', outcomeIndex: 0, ...patch });
function setup(dir, overrides = {}) {
  const env = { now: NOW + 1000, trades: [trade()], offline: false, bids: [{ price: .49, size: 100 }], calls: [], ...overrides };
  const create = extra => new PolymarketCopyPaper({ dataDir: dir, now: () => env.now, fetchImpl: async url => { env.calls.push(url); if (url.includes('/trades')) return { ok: true, json: async () => env.trades }; if (url.includes('/book')) { if (env.offline) throw new Error('offline'); return { ok: true, json: async () => ({ asks: [{ price: .51, size: 100 }], bids: env.bids }) }; } return { ok: true, json: async () => [{ feesEnabled: false, closed: false, tags: [{ label: 'Crypto' }] }] }; }, ...extra });
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
