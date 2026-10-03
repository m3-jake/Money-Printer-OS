// Kalshi weather/BTC paper bots and Polymarket copy paper bot (2026-10-02). Offline: fake providers and fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normCdf, bucketProbability, probAbove, btcContractProbability, realizedVol, scoreSides, walkAsks, KalshiPaperBots } from '../src/kalshiBots.js';
import { PolymarketCopyPaper, pickLeaders, walkBuy } from '../src/polymarketCopy.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-bots-'));
const fee = { venue: 'kalshi', kind: 'KALSHI_QUADRATIC_TAKER', rate: 0.07, rounding: 'CENT_PER_ORDER' };

test('probability models are calibrated distributions', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7); assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  const ladder = [[-Infinity, 67], [68, 69], [70, 71], [72, 73], [74, Infinity]];
  const sum = ladder.reduce((s, [lo, hi]) => s + bucketProbability(lo, hi, 70.6, 2), 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, 'whole-degree buckets cover the line exactly once');
  assert.ok(bucketProbability(70, 71, 70.5, 2) > bucketProbability(74, 75, 70.5, 2));
  assert.ok(Math.abs(probAbove(100, 100, 3600, 0.0001) - 0.5) < 0.01);
  const between = btcContractProbability({ strikeType: 'between', floorStrike: 99, capStrike: 101 }, 100, 3600, 0.0001);
  const above = btcContractProbability({ strikeType: 'greater', floorStrike: 101 }, 100, 3600, 0.0001), below = btcContractProbability({ strikeType: 'less', capStrike: 99 }, 100, 3600, 0.0001);
  assert.ok(Math.abs(between + above + below - 1) < 1e-9);
  const candles = Array.from({ length: 100 }, (_, i) => [i * 300, 0, 0, 0, 100 * (1 + 0.001 * Math.sin(i)), 0]);
  assert.ok(realizedVol(candles) > 0); assert.equal(realizedVol(candles.slice(0, 10)), null, 'too few candles is unknown, not zero');
});

test('sides are scored after the taker fee, and large model/market gaps are refused', () => {
  const s = scoreSides({ pYes: 0.6, yesAsk: 0.45, noAsk: 0.57, yesBid: 0.43, feeModel: fee, stakeUsd: 10, minPrice: 0.05, maxPrice: 0.92, maxDisagreement: 0.3 });
  assert.equal(s.side, 'YES'); assert.equal(s.qty, 22); assert.ok(s.fee > 0); assert.ok(s.edge < 0.15 && s.edge > 0.1, 'edge = p − ask − fee/contract');
  assert.equal(scoreSides({ pYes: 0.6, yesAsk: 0.45, noAsk: 0.57, feeModel: null, stakeUsd: 10, minPrice: 0.05, maxPrice: 0.92 }), null, 'no fee model, no trade');
  assert.equal(scoreSides({ pYes: 0.9, yesAsk: 0.3, noAsk: 0.72, yesBid: 0.28, feeModel: fee, stakeUsd: 10, minPrice: 0.05, maxPrice: 0.92, maxDisagreement: 0.2 }).disagree, true);
  assert.deepEqual(walkAsks({ yes: { asks: [{ price: 0.4, quantity: 5 }, { price: 0.41, quantity: 5 }, { price: 0.5, quantity: 50 }] } }, 'YES', 20, 0.42), [{ price: 0.4, quantity: 5 }, { price: 0.41, quantity: 5 }]);
});

function fakeKalshi(result = null) {
  const book = { yes: { asks: [{ price: 0.3, quantity: 500 }] }, no: { asks: [{ price: 0.72, quantity: 500 }] } };
  return { book: async () => book, market: async () => ({ data: { settlementOutcome: result.value, yesBid: 0.35, noBid: 0.64 } }) };
}
const weatherDesk = closeAt => ({ cities: [{ label: 'New York City', markets: [{ eventTicker: 'KXHIGHNY-X', date: '2026-10-03', title: 'NY high', nwsHigh: 71, expectedHigh: 70.8, closeAt,
  buckets: [{ lo: 70, hi: 71, yesBid: 0.28, yesAsk: 0.3, noBid: 0.7, noAsk: 0.72, feeModel: fee, sourceId: 'KXHIGHNY-X-B70.5', closeAt }, { lo: 72, hi: 73, yesBid: 0.3, yesAsk: 0.32, noBid: 0.68, noAsk: 0.7, feeModel: fee, sourceId: 'KXHIGHNY-X-B72.5', closeAt }] }] }] });

test('weather bot enters at the live book, settles from the market result and scores model vs market', async () => {
  const dir = tmp(), result = { value: null }; let now = Date.UTC(2026, 9, 3, 12); const closeAt = now + 10 * 3600e3;
  const bots = new KalshiPaperBots({ dataDir: dir, kalshi: () => fakeKalshi(result), weather: async () => weatherDesk(closeAt), now: () => now });
  bots.configure('weather', { maxDisagreement: 0.5, minEdge: 0.03 });
  let s = await bots.run('weather');
  assert.equal(s.lastError, null); assert.equal(s.open.length, 1);
  const pos = s.open[0]; assert.equal(pos.ticker, 'KXHIGHNY-X-B70.5'); assert.equal(pos.side, 'YES'); assert.equal(pos.avgPrice, 0.3);
  assert.ok(s.cashUsd < 500 && s.cashUsd > 489);
  s = await bots.run('weather'); assert.equal(s.open.length, 1, 'one bet per event');
  result.value = 'YES'; now += 11 * 3600e3; s = await bots.run('weather');
  assert.equal(s.open.length, 0); assert.equal(s.stats.settled, 1); assert.equal(s.history[0].won, true);
  assert.ok(s.stats.pnlUsd > 0); assert.ok(s.stats.brierModel < s.stats.brierMarket, 'the model gave the winner a higher probability than the price');
  const reread = new KalshiPaperBots({ dataDir: dir, kalshi: () => null, weather: async () => null });
  assert.equal(reread.snapshot('weather').stats.settled, 1, 'the book persists');
});

test('an unreadable book is never overwritten; reset needs the typed phrase', async () => {
  const dir = tmp(), file = path.join(dir, 'kalshi-paper-bots.json'); fs.writeFileSync(file, '{broken');
  const bots = new KalshiPaperBots({ dataDir: dir, kalshi: () => fakeKalshi({ value: null }), weather: async () => weatherDesk(Date.now() + 36e5) });
  await assert.rejects(bots.run('weather'), /unreadable/); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.throws(() => bots.reset('weather', { confirmation: 'yes' }), /RESET BOT/);
  assert.equal(bots.reset('weather', { confirmation: 'RESET BOT', startUsd: 100 }).equityUsd, 100);
  assert.throws(() => bots.configure('btc', { stakeUsd: 9999 }), /between/);
});

test('copy bot follows a point-in-time leaderboard and copies only trades made after following', async () => {
  const dir = tmp(); let now = 1_800_000_000_000; const sec = ms => Math.floor(ms / 1000);
  const lb = [{ rank: '1', proxyWallet: '0xAAA', userName: 'mm', pnl: 1000, vol: 10_000_000 }, { rank: '2', proxyWallet: '0xBBB', userName: 'lead', pnl: 50_000, vol: 500_000 }];
  assert.deepEqual(pickLeaders(lb, { follows: 5, minLeaderVolumeUsd: 100000, minLeaderMargin: 0.02 }).map(f => f.wallet), ['0xbbb'], 'thin-margin market makers are not followed');
  let trades = [{ transactionHash: 'old', asset: 'T1', side: 'BUY', size: 500, price: 0.4, timestamp: sec(now - 60000), outcome: 'Yes', outcomeIndex: 0, title: 'Old' }];
  let closed = false;
  const fetchImpl = async url => {
    const u = String(url), body = u.includes('/leaderboard') ? lb : u.includes('/trades') ? trades : u.includes('/book') ? { asks: [{ price: '0.42', size: '1000' }], bids: [{ price: '0.41', size: '1000' }] }
      : u.includes('gamma') ? [{ feesEnabled: true, feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true }, closed, outcomePrices: closed ? '["1","0"]' : '["0.4","0.6"]', endDate: null }] : null;
    return { ok: true, json: async () => body };
  };
  const bot = new PolymarketCopyPaper({ dataDir: dir, fetchImpl, now: () => now });
  let s = await bot.run(); assert.equal(s.follows.length, 1); assert.equal(s.open.length, 0, 'a trade from before the follow is never copied');
  trades = [{ transactionHash: 'new', asset: 'T2', side: 'BUY', size: 500, price: 0.41, timestamp: sec(now + 1000), outcome: 'Yes', outcomeIndex: 0, title: 'New' }, ...trades];
  now += 60000; s = await bot.run();
  assert.equal(s.open.length, 1); assert.equal(s.open[0].avgPrice, 0.42, 'filled at the live ask, not the leader price'); assert.ok(s.open[0].feeUsd > 0);
  s = await bot.run(); assert.equal(s.open.length, 1, 'the same trade is copied once');
  closed = true; now += 60000; s = await bot.run();
  assert.equal(s.open.length, 0); assert.equal(s.history[0].status, 'RESOLVED'); assert.ok(s.stats.pnlUsd > 0);
  assert.deepEqual(walkBuy([{ price: '0.5', size: '4' }, { price: '0.6', size: '100' }], 5, 0.55), [{ price: 0.5, quantity: 4 }]);
});

test('weather calibration: fitted bias/sigma are used only when they beat the default on held-out days', async () => {
  const { dailyMax, fit, calibrateCity, dateOfTicker } = await import('../src/weatherCalibration.js');
  assert.equal(dateOfTicker('KXHIGHNY-26OCT01'), '2026-10-01');
  assert.deepEqual(dailyMax(['2026-10-01T10:00', '2026-10-01T15:00', '2026-10-02T14:00'], [60, 71.5, null]), { '2026-10-01': 71.5 });
  assert.equal(fit([1, 2]), null, 'too little history is not a fit');
  // A forecast that runs 3 °F cold with ~1 °F noise: calibration must find +3 and win the held-out check.
  const noise = i => [0.8, -0.6, 0.3, -1.1, 0.9, -0.2, 0.5, -0.7][i % 8];
  const rows = Array.from({ length: 80 }, (_, i) => { const actual = 70 + (i % 9); return { date: `d${String(i).padStart(3, '0')}`, actual, f: [actual - 3 + noise(i), actual - 3 + noise(i + 3)] }; });
  const c = calibrateCity(rows);
  assert.equal(c[0].use, true); assert.ok(Math.abs(c[0].params.bias - 3) < 0.3); assert.ok(c[0].heldOut.calibrated > c[0].heldOut.default);
  // An unbiased, noisier forecast keeps the default when the fit does not help on held-out days.
  const flat = rows.map((r, i) => ({ ...r, f: [r.actual + (i % 2 ? 4 : -4), null] })), d = calibrateCity(flat);
  assert.equal(d[1].use, false); assert.match(d[1].reason, /not enough history/);
});

test('the weather bot prices with the calibrated model when one is available', async () => {
  const dir = tmp(), now = Date.UTC(2026, 9, 3, 12), closeAt = now + 10 * 3600e3, desk = weatherDesk(closeAt);
  desk.cities[0].id = 'NYC'; desk.cities[0].markets[0].nwsHigh = null; // no NWS forecast: only the calibrated model can price it
  const calibration = { model: async () => ({ mu: 70.6, sigma: 1.2, forecast: 69, lead: 1, source: 'open-meteo + calibration' }) };
  const bots = new KalshiPaperBots({ dataDir: dir, calibration, kalshi: () => fakeKalshi({ value: null }), weather: async () => desk, now: () => now });
  bots.configure('weather', { maxDisagreement: 0.6, minEdge: 0.03 });
  const s = await bots.run('weather');
  assert.equal(s.open.length, 1); assert.equal(s.open[0].context.model, 'open-meteo + calibration'); assert.equal(s.open[0].context.sigma, 1.32, 'sigma × calibrationSafety 1.1');
  assert.match(s.lastNote, /1 on the calibrated model/);
});
