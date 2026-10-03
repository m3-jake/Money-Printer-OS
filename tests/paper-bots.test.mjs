// Kalshi weather/BTC paper bots and Polymarket copy paper bot (2026-10-02). Offline: fake providers and fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normCdf, bucketProbability, probAbove, btcContractProbability, realizedVol, scoreSides, walkAsks, KalshiPaperBots, modelGuard, MODEL_GUARD, KALSHI_DEFAULTS, BTC_MODEL_REV } from '../src/kalshiBots.js';
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
  assert.equal(s.startUsd, 12.5, 'half of the $25 Kalshi paper wallet'); assert.ok(s.cashUsd < 12.5 && s.cashUsd > 11.4, 'one $1 bet plus its fee');
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

test('the weather-nws control arm never uses the calibration, so the A/B compares only the forecast model', async () => {
  const dir = tmp(), now = Date.UTC(2026, 9, 3, 12), desk = weatherDesk(now + 10 * 3600e3); desk.cities[0].id = 'NYC';
  let asked = 0; const calibration = { model: async () => { asked++; return { mu: 75, sigma: 1, forecast: 75, lead: 1, source: 'open-meteo + calibration' }; } };
  const bots = new KalshiPaperBots({ dataDir: dir, calibration, kalshi: () => fakeKalshi({ value: null }), weather: async () => desk, now: () => now });
  bots.configure('weather-nws', { maxDisagreement: 0.6, minEdge: 0.03 });
  const s = await bots.run('weather-nws');
  // The shared frame carries the calibrated model (the calibrated bot and the farm use it); the control ignores it.
  assert.equal(asked, 1); assert.match(s.lastNote, /\(0 on the calibrated model\)/); assert.equal(s.label.includes('control'), true);
  for (const p of s.open) assert.equal(p.context.model, 'nws + default');
});

test('the bot tape appends one JSON line per row, gzips finished days and drops days past keepDays', async () => {
  const { BotTape } = await import('../src/botTape.js');
  const dir = tmp(); let now = Date.UTC(2026, 9, 1, 12);
  const tape = new BotTape({ dataDir: dir, now: () => now, keepDays: 1 });
  tape.append('kalshi-settle', { ticker: 'A' }); tape.append('kalshi-settle', { ticker: 'B' });
  assert.deepEqual(tape.read('kalshi-settle', '2026-10-01').map(r => r.ticker), ['A', 'B']);
  now += 86400e3; tape.append('kalshi-settle', { ticker: 'C' });
  const files = () => fs.readdirSync(path.join(dir, 'bot-tape', 'kalshi-settle')).sort();
  assert.deepEqual(files(), ['2026-10-01.jsonl.gz', '2026-10-02.jsonl'], 'the finished day is gzipped');
  assert.deepEqual(tape.read('kalshi-settle', '2026-10-01').map(r => r.ticker), ['A', 'B'], 'and still readable');
  now += 2 * 86400e3; const fresh = new BotTape({ dataDir: dir, now: () => now, keepDays: 1 }); fresh.append('kalshi-settle', { ticker: 'D' });
  assert.deepEqual(files(), ['2026-10-04.jsonl'], 'days past keepDays are deleted');
  assert.throws(() => tape.append('nope', {}), /Unknown tape stream/);
  assert.equal(fresh.stats().streams['kalshi-settle'].days, 1);
});

test('the variant farm prices the live bots\' frame, fills at ask + slippage, settles once per ticker and tapes it', async () => {
  const { BotTape } = await import('../src/botTape.js'); const { BotFarm, verdict, MIN_SETTLED } = await import('../src/botFarm.js');
  const dir = tmp(), result = { value: null }; let now = Date.UTC(2026, 9, 3, 12); const closeAt = now + 10 * 3600e3, desk = weatherDesk(closeAt); desk.cities[0].id = 'NYC';
  let deskCalls = 0, marketCalls = 0;
  const calibration = { model: async () => ({ mu: 71, sigma: 1.6, forecast: 71, lead: 1, source: 'open-meteo + calibration' }) };
  const k = { ...fakeKalshi(result), market: async () => { marketCalls++; return { data: { settlementOutcome: result.value, yesBid: 0.35, noBid: 0.64 } }; } };
  const tape = new BotTape({ dataDir: dir, now: () => now });
  const bots = new KalshiPaperBots({ dataDir: dir, calibration, tape, kalshi: () => k, weather: async () => { deskCalls++; return desk; }, now: () => now });
  const farm = new BotFarm({ dataDir: dir, bots, now: () => now });
  await bots.run('weather'); let f = await farm.run('weather');
  assert.equal(deskCalls, 1, 'bot and farm share one frame'); assert.equal(f.last.weather.error, null);
  const v = id => f.variants.find(x => x.id === id);
  assert.equal(v('wx-cal-e04').open, 1); assert.equal(v('wx-cal-e07').open, 1); assert.equal(v('wx-cal-e10').open, 0, 'edge after slippage < 10¢');
  assert.equal(v('wx-cal-tight').open, 0, 'model–market gap > 10¢ is refused'); assert.equal(v('btc-v150').open, 0, 'BTC variants wait for a BTC frame');
  const book = JSON.parse(fs.readFileSync(path.join(dir, 'bot-farm.json'), 'utf8')).books['wx-cal-e04'];
  assert.equal(book.open[0].price, 0.31, 'quoted ask 0.30 + 1¢ slippage');
  assert.equal(tape.read('kalshi-weather', '2026-10-03').length, 1, 'the frame is taped once');
  result.value = 'YES'; now += 11 * 3600e3; marketCalls = 0;
  f = await farm.run('weather');
  assert.equal(marketCalls, 1, 'one settlement lookup for the ticker every variant holds');
  assert.equal(v('wx-cal-e04').settled, 1); assert.ok(v('wx-cal-e04').pnlUsd > 0); assert.match(v('wx-cal-e04').verdict.text, /too early \(1\/30/);
  await bots.run('weather');
  assert.deepEqual(tape.read('kalshi-settle', '2026-10-03').concat(tape.read('kalshi-settle', '2026-10-04')).map(r => r.ticker), ['KXHIGHNY-X-B70.5'], 'a settlement is taped once');
  assert.equal(new BotFarm({ dataDir: dir, bots }).snapshot().variants.find(x => x.id === 'wx-cal-e04').settled, 1, 'the farm book persists');
  assert.equal(verdict(Array(MIN_SETTLED).fill(1)).text, 'making money (t ∞)');
  assert.match(verdict(Array.from({ length: 40 }, (_, i) => i % 2 ? 1 : -1.2)).text, /no clear edge yet/);
});

test('Kalshi books on the old $500 defaults move once to the $25 wallet ($12.50 per bot); the old file is kept', () => {
  const dir = tmp(), file = path.join(dir, 'kalshi-paper-bots.json');
  const old = id => ({ id, startUsd: 500, cashUsd: 480, open: [], history: [{ pnlUsd: 3 }], decisions: [], settings: { enabled: id !== 'btc', startUsd: 500, stakeUsd: 10 }, epoch: 1 });
  fs.writeFileSync(file, JSON.stringify({ schema: 'mpo.kalshi-paper-bots.v1', bots: { weather: old('weather'), 'weather-nws': old('weather-nws'), btc: old('btc') } }));
  const bots = new KalshiPaperBots({ dataDir: dir });
  const w = bots.snapshot('weather'), b = bots.snapshot('btc');
  assert.equal(w.startUsd, 12.5); assert.equal(w.cashUsd, 12.5); assert.equal(w.epoch, 2); assert.equal(w.stats.settled, 0); assert.equal(w.settings.stakeUsd, 1);
  assert.equal(b.settings.enabled, false, 'a paused bot stays paused');
  assert.equal(fs.readdirSync(dir).filter(n => n.startsWith('kalshi-paper-bots.pre-25usd-')).length, 1);
  bots.reset('weather', { confirmation: 'RESET BOT', startUsd: 500 }); 
  assert.equal(new KalshiPaperBots({ dataDir: dir }).snapshot('weather').startUsd, 500, 'a $500 book chosen after the move is left alone');
});

test('the farm runs Evolution Lab proposals only when they are well formed and inside the bounds; a withdrawn one keeps its book', async () => {
  const { BotFarm, labVariants } = await import('../src/botFarm.js');
  const now = Date.now();
  const proof = { at: now, paperPromotionAllowed: true, evidence: { executionVerified: true, availabilityVerified: true, holdoutConsumedOnce: true, holdout: { n: 40, meanPerBet: .1, ciLo: .02, ciHi: .18 } } };
  const document = variants => ({ schema: 'mpo.lab-farm-proposals.v1', at: now, variants: variants.map(v => ({ ...proof, ...v })) });
  assert.deepEqual(labVariants(document([
    { id: 'lab-btc-v16', kind: 'btc', label: 'BTC · vol × 1.6 (Lab fit)', over: { volMultiple: 1.6 } },
    { id: 'btc-v999', kind: 'btc', over: { volMultiple: 1.6 } },          // not a lab- id
    { id: 'lab-btc-huge', kind: 'btc', over: { volMultiple: 40 } },        // out of bounds
    { id: 'lab-wx-stake', kind: 'weather', over: { stakeUsd: 500 } },      // a setting the Lab may not touch
    { id: 'lab-news', kind: 'news', over: { minEdge: 0.05 } },             // unknown kind
  ]), now).map(v => v.id), ['lab-btc-v16']);
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'lab-link'));
  const file = path.join(dir, 'lab-link', 'farm-proposals.json');
  fs.writeFileSync(file, JSON.stringify(document([{ id: 'lab-btc-v16', kind: 'btc', label: 'BTC · vol × 1.6 (Lab fit)', over: { volMultiple: 1.6 } }])));
  const farm = new BotFarm({ dataDir: dir, bots: { kalshi: () => null } });
  const v = farm.snapshot().variants.find(x => x.id === 'lab-btc-v16');
  assert.equal(v.lab, true); assert.equal(v.withdrawn, false); assert.equal(v.equityUsd, 12.5);
  fs.rmSync(file);
  assert.equal(farm.snapshot().variants.find(x => x.id === 'lab-btc-v16').withdrawn, true, 'withdrawn, history kept');
});

test('the weather calibrator uses the Evolution Lab\'s best model when it beats this calibration on held-out days', async () => {
  const { WeatherCalibrator } = await import('../src/weatherCalibration.js');
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'lab-link'));
  const now = Date.UTC(2026, 9, 3, 16), today = '2026-10-03', tomorrow = '2026-10-04';
  fs.writeFileSync(path.join(dir, 'lab-link', 'workbench.json'), JSON.stringify({ schema: 'mpo.lab-workbench.v1', updatedAt: now, weather: { at: now, models: ['gfs_seamless', 'ecmwf_ifs025'], best: { NYC: [{ model: 'mean', bias: 1.5, sd: 1.2, use: true, heldOut: -1.6, default: -2.0 }, { model: 'gfs_seamless', bias: 0, sd: 2, use: false, heldOut: -2.4 }] } } }));
  let asked = '';
  const fetchImpl = async url => { asked = String(url); const time = [`${today}T12:00`, `${today}T15:00`, `${tomorrow}T15:00`]; return { ok: true, json: async () => ({ hourly: { time, temperature_2m_gfs_seamless: [70, 74, 80], temperature_2m_ecmwf_ifs025: [71, 76, 81] } }) }; };
  const cal = new WeatherCalibrator({ dataDir: dir, fetchImpl, now: () => now });
  cal.state = { cities: { NYC: { leads: { 0: { use: true, params: { bias: 0.5, sd: 1.5 }, heldOut: { calibrated: -1.9 } }, 1: { use: false } } } } };
  const m = await cal.model('NYC', today);
  assert.equal(m.source, 'lab mean + calibration'); assert.equal(m.forecast, 75); assert.equal(m.mu, 76.5, 'mean of 74 and 76, + 1.5 bias'); assert.equal(m.sigma, 1.2);
  assert.match(asked, /models=gfs_seamless,ecmwf_ifs025/);
  assert.equal(await cal.model('NYC', tomorrow), null, 'lead 1: the Lab model does not beat the default and this calibration has none');
});

test('the Kalshi mirror copies a leader\'s game-winner buy onto Kalshi at Kalshi\'s price, and refuses anything else', async () => {
  const { KalshiMirrorPaper, mirrorTarget } = await import('../src/kalshiMirror.js');
  const events = [{ sport: 'MLB', participants: ['San Diego Padres', 'Milwaukee Brewers'], contracts: [
    { venue: 'kalshi', type: 'GAME_WINNER', side: 'San Diego', sourceId: 'KXMLBGAME-X-SD', closeAt: 2e12 },
    { venue: 'kalshi', type: 'GAME_WINNER', side: 'Milwaukee', sourceId: 'KXMLBGAME-X-MIL', closeAt: 2e12 },
    { venue: 'polymarket', type: 'GAME_WINNER', title: 'San Diego Padres vs. Milwaukee Brewers', side: 'San Diego Padres' },
    { venue: 'polymarket', type: 'SPREAD', title: 'Spread: Milwaukee Brewers (-1.5)', side: 'Milwaukee Brewers' }] }];
  assert.equal(mirrorTarget({ title: 'San Diego Padres vs. Milwaukee Brewers', outcome: 'Milwaukee Brewers' }, events).contract.sourceId, 'KXMLBGAME-X-MIL');
  assert.match(mirrorTarget({ title: 'Spread: Milwaukee Brewers (-1.5)', outcome: 'Milwaukee Brewers' }, events).reason, /not a game-winner/);
  assert.match(mirrorTarget({ title: 'Will it rain in Paris?', outcome: 'Yes' }, events).reason, /not a game-winner/);
  const dir = tmp(); let now = 1_800_000_000_000, result = null;
  const k = { market: async () => ({ data: { status: 'ACTIVE', yesAsk: 0.62, yesBid: 0.6, feeModel: fee, settlementOutcome: result } }), book: async () => ({ yes: { asks: [{ price: 0.62, quantity: 100 }] }, no: { asks: [] } }) };
  const m = new KalshiMirrorPaper({ dataDir: dir, kalshi: () => k, sports: async () => ({ events }), now: () => now });
  m.enqueue({ name: 'lead' }, { transactionHash: 'h1', asset: 'a', title: 'San Diego Padres vs. Milwaukee Brewers', outcome: 'Milwaukee Brewers', price: 0.6, timestamp: Math.floor(now / 1000) });
  m.enqueue({ name: 'lead' }, { transactionHash: 'h1', asset: 'a', title: 'dupe', outcome: 'x', price: 0.6, timestamp: Math.floor(now / 1000) });
  let s = await m.run();
  assert.equal(s.lastError, null); assert.equal(s.open.length, 1); assert.equal(s.open[0].ticker, 'KXMLBGAME-X-MIL'); assert.equal(s.open[0].avgPrice, 0.62, 'Kalshi ask, not the leader\'s 0.60'); assert.equal(s.queued, 0);
  m.enqueue({ name: 'lead' }, { transactionHash: 'h2', asset: 'b', title: 'Spread: Milwaukee Brewers (-1.5)', outcome: 'Milwaukee Brewers', price: 0.5, timestamp: Math.floor(now / 1000) });
  s = await m.run(); assert.equal(s.open.length, 1); assert.match(s.decisions[0].reason, /not a game-winner/);
  result = 'YES'; now += 3600e3; s = await m.run();
  assert.equal(s.open.length, 0); assert.equal(s.stats.settled, 1); assert.ok(s.stats.pnlUsd > 0);
});

// ---- run A2: the model must beat the market; longshot guard; BTC model revision 2 ------------------------------
const settledBet = (i, { model, market, won = false, observed = false, t0 = Date.UTC(2026, 9, 3) } = {}) => ({ ticker: 'T' + i, eventTicker: 'E' + i, side: 'YES', qty: 5, pModel: model, marketPrice: market, won, observed, pnlUsd: won ? 0.5 : -1, feeUsd: 0.01, settledAt: t0 + i * 60e3, brierModel: (model - (won ? 1 : 0)) ** 2, brierMarket: (market - (won ? 1 : 0)) ** 2 });

test('model guard: no verdict under 10 settled bets; stands down when the model is worse than the market; window is the latest 20', () => {
  assert.equal(MODEL_GUARD.minSettled, 10);
  const worse = [...Array(12)].map((_, i) => settledBet(i, { model: 0.25, market: 0.1 }));
  assert.equal(modelGuard(worse.slice(0, 9)).active, false);
  assert.match(modelGuard(worse.slice(0, 9)).reason, /9 of 10/);
  const g = modelGuard(worse);
  assert.equal(g.active, true); assert.equal(g.n, 12); assert.ok(g.brierModel > g.brierMarket);
  assert.match(g.reason, /observe-only/); assert.match(g.reason, /worse than the market/);
  // 20 newer observed bets where the model beats the market push the old ones out of the window.
  const better = [...Array(20)].map((_, i) => settledBet(100 + i, { model: 0.1, market: 0.3, observed: true }));
  const back = modelGuard([...worse, ...better]);
  assert.equal(back.active, false); assert.equal(back.n, 20); assert.equal(back.observed, 20);
});

test('model guard compares unrounded scores even when the displayed scores tie', () => {
  const rows = Array.from({length:10}, (_,i)=>({...settledBet(i,{model:0.2,market:0.1}), brierModel:0.10001,brierMarket:0.1}));
  const g = modelGuard(rows);
  assert.equal(g.brierModel,g.brierMarket);
  assert.equal(g.active,true);
});

test('longshot guard: a side under 15 cents needs a 15-cent edge; dearer sides are unaffected', () => {
  const base = { feeModel: fee, stakeUsd: 1, minPrice: 0.05, maxPrice: 0.92 };
  const cheap = scoreSides({ ...base, pYes: 0.22, yesAsk: 0.1, noAsk: 0.92, longshotPrice: 0.15, longshotMinEdge: 0.15 });
  assert.notEqual(cheap?.side, 'YES', 'a 10-cent YES with about an 11-cent edge is refused');
  assert.equal(scoreSides({ ...base, pYes: 0.22, yesAsk: 0.1, noAsk: 0.92 }).side, 'YES', 'without the guard it would be bought');
  assert.equal(scoreSides({ ...base, pYes: 0.32, yesAsk: 0.1, noAsk: 0.92, longshotPrice: 0.15, longshotMinEdge: 0.15 }).side, 'YES', 'a large edge still passes');
  assert.equal(scoreSides({ ...base, pYes: 0.45, yesAsk: 0.3, noAsk: 0.72, longshotPrice: 0.15, longshotMinEdge: 0.15 }).side, 'YES');
  assert.equal(KALSHI_DEFAULTS.btc.volMultiple, 1.0); assert.equal(KALSHI_DEFAULTS.btc.longshotPrice, 0.15);
});

test('a saved BTC book moves to model revision 2 once: settings change, history stays, the change is logged', () => {
  const dir = tmp(), file = path.join(dir, 'kalshi-paper-bots.json');
  const btc = { id: 'btc', startUsd: 12.5, cashUsd: 1.07, open: [], history: [settledBet(1, { model: 0.2, market: 0.1 })], decisions: [], settings: { ...KALSHI_DEFAULTS.btc, volMultiple: 1.25, longshotPrice: undefined, longshotMinEdge: undefined }, epoch: 2 };
  delete btc.settings.longshotPrice; delete btc.settings.longshotMinEdge;
  fs.writeFileSync(file, JSON.stringify({ schema: 'mpo.kalshi-paper-bots.v1', wallet25: true, bots: { btc } }));
  const bots = new KalshiPaperBots({ dataDir: dir, kalshi: () => null, weather: async () => null });
  const s = bots.snapshot('btc');
  assert.equal(s.settings.volMultiple, 1.0); assert.equal(s.settings.longshotPrice, 0.15); assert.equal(s.cashUsd, 1.07);
  assert.equal(s.stats.settled, 1, 'history is never touched');
  assert.equal(bots.state.bots.btc.modelRev, BTC_MODEL_REV);
  assert.match(s.decisions[0].reason, /vol × 1.25 → × 1/);
  bots.save();
  const again = new KalshiPaperBots({ dataDir: dir, kalshi: () => null, weather: async () => null });
  assert.equal(again.snapshot('btc').decisions.filter(d => d.action === 'SETTINGS').length, 1, 'migrates once');
});

test('a bot whose model is worse than the market stands down: no cash is used, bets are observed and settle, and it can earn its way back', async () => {
  const dir = tmp(), result = { value: null }; let now = Date.UTC(2026, 9, 3, 12); const closeAt = now + 10 * 3600e3;
  const bots = new KalshiPaperBots({ dataDir: dir, kalshi: () => fakeKalshi(result), weather: async () => weatherDesk(closeAt), now: () => now });
  bots.configure('weather', { maxDisagreement: 0.5, minEdge: 0.03 });
  bots.state.bots.weather.history = [...Array(12)].map((_, i) => settledBet(i, { model: 0.4, market: 0.1, t0: now - 86400e3 }));
  const cash = bots.state.bots.weather.cashUsd;
  let s = await bots.run('weather');
  assert.equal(s.standDown.active, true); assert.equal(s.open.length, 0); assert.equal(s.cashUsd, cash, 'observe-only uses no paper cash');
  assert.equal(s.observed.open, 1);
  assert.ok(s.decisions.some(d => d.action === 'STAND DOWN')); assert.ok(s.decisions.some(d => d.action === 'OBSERVE'));
  assert.match(s.lastNote, /OBSERVE-ONLY/);
  s = await bots.run('weather'); assert.equal(s.observed.open, 1, 'one observed bet per event');
  result.value = 'YES'; now += 11 * 3600e3; s = await bots.run('weather');
  assert.equal(s.observed.settled, 1); assert.equal(s.observed.recent[0].won, true); assert.equal(s.stats.settled, 12, 'observed bets never enter the real book');
  // Enough observed winners where the model beat the market: the bot trades again.
  bots.state.bots.weather.observedHistory.push(...[...Array(20)].map((_, i) => settledBet(200 + i, { model: 0.3, market: 0.2, won: true, observed: true, t0: now })));
  result.value = null; s = await bots.run('weather');
  assert.equal(s.standDown.active, false); assert.ok(s.decisions.some(d => d.action === 'RESUME'));
});

test('farm variants started on the revision-1 BTC model keep it; the live r2 model runs as its own variant', async () => {
  const { FARM_VARIANTS, variantSettings } = await import('../src/botFarm.js');
  const by = Object.fromEntries(FARM_VARIANTS.map(v => [v.id, variantSettings(v)]));
  assert.equal(by['btc-v125-e04'].volMultiple, 1.25); assert.equal(by['btc-v125-e04'].longshotPrice, 0);
  assert.equal(by['btc-v150'].longshotPrice, 0);
  assert.equal(by['btc-live-r2'].volMultiple, 1.0); assert.equal(by['btc-live-r2'].longshotPrice, 0.15);
  assert.equal(by['wx-cal-e07'].minEdge, KALSHI_DEFAULTS.weather.minEdge);
});

test('farm shares its 30-bet standard and retires losing variants without erasing their evidence',async()=>{
 const {farmEarlyStop,FARM_MIN_SETTLED}=await import('../src/core/farmEvidence.js');
 const {BotFarm,MIN_SETTLED,variantSettings,FARM_VARIANTS}=await import('../src/botFarm.js');
 assert.equal(MIN_SETTLED,FARM_MIN_SETTLED);assert.equal(MIN_SETTLED,30);
 const h=Array.from({length:20},(_,i)=>({...settledBet(i,{model:0.1,market:0.2}),pnlUsd:-0.1}));
 assert.equal(farmEarlyStop(h.slice(0,19),12).retire,false);assert.equal(farmEarlyStop(h,12).retire,true);
 assert.equal(farmEarlyStop([...h,{pnlUsd:10}],12).retire,false);
 assert.equal(variantSettings(FARM_VARIANTS[0]).stakeUsd,0.5);
 const dir=tmp(),result={value:null},now=Date.UTC(2026,9,3,12),desk=weatherDesk(now+10*3600e3);
 const bots=new KalshiPaperBots({dataDir:dir,kalshi:()=>fakeKalshi(result),weather:async()=>desk,now:()=>now});
 const farm=new BotFarm({dataDir:dir,bots,now:()=>now});farm.state.books['wx-cal-e04'].history=h;
 const cash=farm.state.books['wx-cal-e04'].cashUsd;
 const snap=await farm.run('weather'),row=snap.variants.find(v=>v.id==='wx-cal-e04');
 assert.ok(row.retirement);assert.equal(row.open,0);assert.equal(row.settled,20);
 assert.equal(farm.state.books['wx-cal-e04'].cashUsd,cash);
 assert.ok(new BotFarm({dataDir:dir,bots}).state.books['wx-cal-e04'].retirement,'retirement persists');
});

test('copy drawdown pause stops new buys but preserves cash, history and exit monitoring',async()=>{
 const {copyRisk,copyAttribution}=await import('../src/copyAttribution.js');
 const s={startUsd:500,cashUsd:399,open:[],history:[{leader:'wallet',pnlUsd:-101,closedAt:100,marketType:'sports'}]};
 assert.equal(copyRisk(s).active,true);
 const attr=copyAttribution(s.history);assert.equal(attr.byLeader[0].pnlUsd,-101);assert.equal(attr.byDelay[0].group,'unknown');
 assert.equal(attr.byLeader[0].leaderNetProfitUsd,null);
 const bot=new PolymarketCopyPaper({dataDir:tmp(),fetchImpl:async()=>{throw Error('a paused buy must not fetch')}});
 Object.assign(bot.state,s,{drawdownPause:copyRisk(s)});
 assert.equal(await bot.copy({wallet:'wallet',name:'leader'},{side:'BUY',price:0.2,size:1000,asset:'a',title:'title'}),false);
 assert.equal(bot.state.cashUsd,399);assert.equal(bot.state.history.length,1);
});

test('a farm variant whose model is worse than the market records observe-only bets, without cash, until it earns its way back', async () => {
  const { BotFarm } = await import('../src/botFarm.js');
  const dir = tmp(), result = { value: null }; let now = Date.UTC(2026, 9, 3, 12); const closeAt = now + 10 * 3600e3, desk = weatherDesk(closeAt); desk.cities[0].id = 'NYC';
  const calibration = { model: async () => ({ mu: 71, sigma: 1.6, forecast: 71, lead: 1, source: 'open-meteo + calibration' }) };
  const bots = new KalshiPaperBots({ dataDir: dir, calibration, kalshi: () => fakeKalshi(result), weather: async () => desk, now: () => now });
  const farm = new BotFarm({ dataDir: dir, bots, now: () => now });
  farm.state.books['wx-cal-e04'].history = [...Array(12)].map((_, i) => settledBet(i, { model: 0.4, market: 0.1, t0: now - 86400e3 }));
  const cash = farm.state.books['wx-cal-e04'].cashUsd;
  let f = await farm.run('weather');
  const v = id => f.variants.find(x => x.id === id);
  assert.equal(v('wx-cal-e04').standDown.active, true); assert.equal(v('wx-cal-e04').open, 0); assert.equal(v('wx-cal-e04').observed.open, 1);
  assert.equal(farm.state.books['wx-cal-e04'].cashUsd, cash, 'no paper cash');
  assert.equal(v('wx-cal-e07').open, 1, 'other variants trade as before');
  result.value = 'YES'; now += 11 * 3600e3; f = await farm.run('weather');
  assert.equal(v('wx-cal-e04').observed.settled, 1); assert.equal(v('wx-cal-e04').settled, 12, 'observed bets never enter the real book');
});
