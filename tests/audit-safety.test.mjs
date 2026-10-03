import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KalshiMirrorPaper, mirrorTarget } from '../src/kalshiMirror.js';
import { WeatherCalibrator } from '../src/weatherCalibration.js';

const NOW = Date.UTC(2026, 9, 3, 16);
const fee = { venue: 'kalshi', kind: 'KALSHI_QUADRATIC_TAKER', rate: .07, rounding: 'CENT_PER_ORDER' };
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-audit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const event = (day = '2026-10-03', token = 'asset', ticker = 'KXMLBGAME-T-SD') => ({ day, sport: 'MLB', participants: ['San Diego Padres', 'Milwaukee Brewers'], contracts: [
  { venue: 'polymarket', sourceId: `pm-${day}`, conditionId: `condition-${day}`, tokenIds: [token, `other-${token}`], yesToken: token, noToken: `other-${token}`, type: 'GAME_WINNER', title: 'San Diego Padres vs. Milwaukee Brewers', side: 'San Diego Padres' },
  { venue: 'kalshi', sourceId: ticker, type: 'GAME_WINNER', side: 'San Diego', closeAt: NOW + 86400e3 },
] });
const trade = patch => ({ transactionHash: 'tx', asset: 'asset', title: 'San Diego Padres vs. Milwaukee Brewers', outcome: 'San Diego Padres', price: .5, timestamp: NOW / 1000, ...patch });
const provider = (patch = {}) => ({ market: async () => ({ data: { status: 'ACTIVE', closeAt: NOW + 86400e3, yesAsk: .5, yesBid: .48, feeModel: fee } }), book: async () => ({ yes: { asks: [{ price: .5, quantity: 100 }] } }), ...patch });
const mirror = (dir, opts = {}) => new KalshiMirrorPaper({ dataDir: dir, now: () => NOW, kalshi: () => provider(), sports: async () => ({ events: [event()] }), ...opts });

test('mirror binds repeated games to a token or day and refuses conflicting identity', () => {
  const events = [event(), event('2026-10-04', 'tomorrow', 'NEXT-GAME')];
  assert.equal(mirrorTarget(trade({ asset: 'tomorrow' }), events).contract.sourceId, 'NEXT-GAME');
  assert.equal(mirrorTarget(trade({ marketId: 'pm-2026-10-04', asset: 'tomorrow' }), events).event.day, '2026-10-04');
  assert.match(mirrorTarget(trade({ asset: 'missing' }), events).reason, /not a game-winner/);
  assert.match(mirrorTarget(trade({ asset: 'tomorrow', conditionId: 'condition-2026-10-03' }), events).reason, /not a game-winner/);
  const withoutTokens = events.map(e => ({ ...e, contracts: e.contracts.map(({ tokenIds, yesToken, noToken, conditionId, ...c }) => c) }));
  assert.match(mirrorTarget(trade(), withoutTokens).reason, /ambiguous game/);
  assert.equal(mirrorTarget(trade({ slug: 'mlb-sd-mil-2026-10-04' }), withoutTokens).contract.sourceId, 'NEXT-GAME');
});

test('mirror refuses a shortened team that names both participants or target sides', () => {
  const e = event(); e.participants = ['Los Angeles Dodgers', 'Los Angeles Angels'];
  e.contracts[0].title = 'Los Angeles Dodgers vs. Los Angeles Angels'; e.contracts[1].side = 'Los Angeles';
  assert.match(mirrorTarget(trade({ outcome: 'Los Angeles' }), [e]).reason, /exactly one/);
  assert.match(mirrorTarget(trade({ outcome: 'Los Angeles Dodgers' }), [e]).reason, /unambiguous/);
});

test('mirror rejects stale, future and malformed observations before queueing or spending', async t => {
  const m = mirror(fixture(t));
  for (const patch of [{ timestamp: (NOW + 1000) / 1000 }, { timestamp: (NOW - 1800e3 - 1000) / 1000 }, { timestamp: 'bad' }, { price: NaN }, { asset: '' }, { transactionHash: '' }]) m.enqueue({ name: 'leader' }, trade(patch));
  assert.equal(m.snapshot().queued, 0); assert.equal(m.snapshot().cashUsd, 12.5);
  assert.ok(m.snapshot().decisions.every(d => d.action === 'SKIP'));
});

test('mirror includes fees within its stake budget, persists settlement once, and survives restart', async t => {
  const dir = fixture(t); let result = null;
  const k = provider({ market: async () => ({ data: { status: 'ACTIVE', closeAt: NOW + 86400e3, yesAsk: .5, yesBid: .48, feeModel: fee, settlementOutcome: result } }) });
  let m = mirror(dir, { kalshi: () => k }); m.enqueue({ name: 'leader' }, trade());
  let s = await m.run(); assert.equal(s.lastError, null); assert.equal(s.open.length, 1);
  assert.equal(s.open[0].qty, 1, 'two 50-cent contracts plus fees exceed the $1 stake');
  assert.ok(s.open[0].costUsd + s.open[0].feeUsd <= 1);
  result = 'YES'; s = await m.run(); assert.equal(s.stats.settled, 1); assert.equal(s.cashUsd, 12.98);
  m = mirror(dir, { kalshi: () => k }); s = await m.run(); assert.equal(s.stats.settled, 1); assert.equal(s.cashUsd, 12.98);
});

test('transient board and provider errors retain a queued buy for the next run', async t => {
  let unavailable = true; const m = mirror(fixture(t), { sports: async () => { if (unavailable) throw new Error('offline'); return { events: [event()] }; } });
  m.enqueue({ name: 'leader' }, trade()); let s = await m.run(); assert.match(s.lastError, /offline/); assert.equal(s.queued, 1);
  unavailable = false; s = await m.run(); assert.equal(s.queued, 0); assert.equal(s.open.length, 1);
});

test('reset refuses an in-flight run and preserves the queued generation', async t => {
  let release, notify; const reached = new Promise(r => { notify = r; }), waiting = new Promise(r => { release = r; });
  const m = mirror(fixture(t), { sports: async () => { notify(); await waiting; return { events: [event()] }; } });
  m.enqueue({ name: 'leader' }, trade()); const running = m.run(); await reached;
  assert.throws(() => m.reset({ confirmation: 'RESET BOT' }), /running/); assert.equal(m.snapshot().epoch, 1);
  release(); await running; assert.equal(m.snapshot().open.length, 1);
});

test('an enqueue during settlement never persists both a payout and its old open position', async t => {
  const dir = fixture(t); let release, notify; const reached = new Promise(r => { notify = r; }), waiting = new Promise(r => { release = r; });
  const k = provider({ market: async ticker => { if (ticker === 'SECOND') { notify(); await waiting; } return { data: { settlementOutcome: ticker === 'FIRST' ? 'YES' : null } }; } });
  const m = mirror(dir, { kalshi: () => k });
  const p = ticker => ({ ticker, qty: 1, costUsd: .5, feeUsd: .02, markUsd: .5 });
  m.state.open = [p('FIRST'), p('SECOND')]; m.state.cashUsd = 11.46; m.save();
  const running = m.run(); await reached; m.enqueue({ name: 'leader' }, trade());
  const saved = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  assert.equal(saved.cashUsd, 12.46); assert.equal(saved.history.length, 1); assert.deepEqual(saved.open.map(p => p.ticker), ['SECOND']);
  release(); await running;
});

test('malformed persisted books expose unknown balances, refuse new work and archive evidence on reset', async t => {
  const dir = fixture(t), m = mirror(dir), fresh = m.fresh();
  for (const invalid of [{ ...fresh, cashUsd: -1 }, { ...fresh, open: null }, { ...fresh, settings: { ...fresh.settings, stakeUsd: Infinity } }, { ...fresh, open: [{ ticker: 'X', qty: -1, costUsd: .5, feeUsd: 0 }] }]) {
    const bytes = JSON.stringify(invalid); fs.writeFileSync(m.file, bytes);
    const broken = mirror(dir), s = broken.snapshot(); assert.equal(s.recoveryRequired, true); assert.equal(s.cashUsd, null); assert.equal(s.equityUsd, null);
    assert.throws(() => broken.enqueue({ name: 'leader' }, trade()), /unreadable/); await assert.rejects(broken.run(), /unreadable/); assert.equal(fs.readFileSync(m.file, 'utf8'), bytes);
  }
  const broken = mirror(dir), old = fs.readFileSync(m.file, 'utf8'); broken.reset({ confirmation: 'RESET BOT' });
  const backup = fs.readdirSync(dir).find(n => n.includes('.pre-reset-'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), old); assert.equal(broken.snapshot().cashUsd, 12.5);
});

const weatherEvidence = (patch = {}) => ({ schema: 'mpo.lab-workbench.v1', updatedAt: NOW, weather: { at: NOW, models: ['gfs_seamless', 'ecmwf_ifs025'], best: { NYC: [{ model: 'mean', bias: 1.5, sd: 1.2, use: true, heldOut: -1.6, default: -2.3 }, null] } }, ...patch });
const weather = (dir, doc, fetchImpl = async () => { throw new Error('unexpected fetch'); }) => {
  fs.mkdirSync(path.join(dir, 'lab-link'), { recursive: true }); fs.writeFileSync(path.join(dir, 'lab-link', 'workbench.json'), JSON.stringify(doc));
  return new WeatherCalibrator({ dataDir: dir, fetchImpl, now: () => NOW });
};

test('Lab weather accepts fresh, bounded, improved evidence and all ensemble constituents', async t => {
  const dir = fixture(t), cal = weather(dir, weatherEvidence(), async () => ({ ok: true, json: async () => ({ hourly: { time: ['2026-10-03T12:00'], temperature_2m_gfs_seamless: [74], temperature_2m_ecmwf_ifs025: [76] } }) }));
  const m = await cal.model('NYC', '2026-10-03'); assert.equal(m.forecast, 75); assert.equal(m.mu, 76.5); assert.equal(m.sigma, 1.2);
  assert.equal(await cal.model('NYC', '2026-10-05'), null, 'lead-one evidence does not apply to later days');
  assert.equal(await cal.model('NYC', '2026-10-02'), null);
});

test('Lab weather rejects stale/future times, unknown models, unsafe parameters and unimproved scores', async t => {
  const dir = fixture(t);
  const cases = [d => { delete d.updatedAt; }, d => { d.weather.at = NOW - 49 * 3600e3; }, d => { d.updatedAt = NOW + 1; }, d => { d.weather.at = NOW + 1; }, d => { d.weather.models.push('unexpected'); }, d => { d.weather.best.NYC[0].model = 'unexpected'; }, d => { d.weather.best.NYC[0].sd = 0; }, d => { d.weather.best.NYC[0].sd = -1; }, d => { d.weather.best.NYC[0].bias = 1000; }, d => { d.weather.best.NYC[0].heldOut = -3; }, d => { delete d.weather.best.NYC[0].default; }];
  for (const mutate of cases) { const d = weatherEvidence(); mutate(d); assert.equal(await weather(dir, d).model('NYC', '2026-10-03'), null); }
});

test('Lab weather ensemble refuses partial forecasts instead of silently changing the calibrated model', async t => {
  const dir = fixture(t), cal = weather(dir, weatherEvidence(), async () => ({ ok: true, json: async () => ({ hourly: { time: ['2026-10-03T12:00'], temperature_2m_gfs_seamless: [74] } }) }));
  assert.equal(await cal.model('NYC', '2026-10-03'), null);
});

test('weather truth never turns absent settlement values into a zero-degree high', async t => {
  const cal = new WeatherCalibrator({ dataDir: fixture(t), now: () => NOW, fetchImpl: async () => ({ ok: true, json: async () => ({ events: [
    { event_ticker: 'KXHIGHNY-26OCT01', markets: [{ expiration_value: null }, { expiration_value: '74' }] },
    { event_ticker: 'KXHIGHNY-26OCT02', markets: [{ expiration_value: '' }, { expiration_value: null }] },
  ] }) }) });
  assert.deepEqual(await cal.actuals('KXHIGHNY'), { '2026-10-01': 74 });
});
