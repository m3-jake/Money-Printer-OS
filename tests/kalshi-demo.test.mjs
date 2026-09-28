import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { KalshiClient, KALSHI_DEMO_BASE, kalshiSeries, signKalshiRequest } from '../src/kalshi.js';
import { KALSHI_PAPER_BOUNDS, placeKalshiPaperOrder } from '../src/kalshiPaper.js';

test('paper client refuses non-demo Kalshi hosts and defaults to official demo host', () => {
  assert.equal(new KalshiClient({ fetchImpl: async () => {} }).baseUrl, KALSHI_DEMO_BASE);
  assert.throws(() => new KalshiClient({ baseUrl: 'https://external-api.kalshi.com/trade-api/v2', mode: 'paper' }), /demo-api.kalshi.co/);
  assert.throws(() => new KalshiClient({ baseUrl: 'https://demo-api.kalshi.co.attacker.invalid/trade-api/v2', mode: 'paper' }), /demo-api.kalshi.co/);
  assert.deepEqual(kalshiSeries('weather'), ['KXHIGH', 'KXLOW']); assert.deepEqual(kalshiSeries('sports'), ['KXNFL', 'KXNBA', 'KXMLB']);
});

test('signing and request functions cover authenticated Kalshi operations', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }); const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.ok(signKalshiRequest({ privateKey: pem, timestamp: '1', method: 'GET', path: '/portfolio/balance' }).length > 30);
  const calls = [], client = new KalshiClient({ apiKey: 'key-id', privateKey: pem, fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, json: async () => ({ markets: [], market: {}, order: {}, balance: {}, settlements: [] }) }; } });
  await client.listMarkets({ series: 'KXNFL' }); await client.getMarket('T-1'); await client.placeOrder({ ticker: 'T-1' }); await client.getPortfolio(); await client.getSettlements();
  assert.deepEqual(calls.map(x => new URL(x.url).pathname), ['/trade-api/v2/markets', '/trade-api/v2/markets/T-1', '/trade-api/v2/portfolio/orders', '/trade-api/v2/portfolio/balance', '/trade-api/v2/portfolio/settlements']);
  assert.ok(calls.slice(2).every(x => x.init.headers['KALSHI-ACCESS-SIGNATURE']));
});

test('Kalshi paper book enforces stake and open bounds without network calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-kalshi-'));
  try { assert.deepEqual(KALSHI_PAPER_BOUNDS, { stakeUsd: { min: 1, max: 500 }, maxOpen: { min: 1, max: 25 } });
    const file = path.join(dir, 'book.json'), row = placeKalshiPaperOrder({ ticker: 'KXNFL-1', side: 'yes', stakeUsd: 10 }, { file, now: 2 });
    assert.equal(row.mode, 'PAPER'); assert.equal(JSON.parse(fs.readFileSync(file)).cashUsd, 990);
    assert.throws(() => placeKalshiPaperOrder({ ticker: 'T', stakeUsd: 501 }, { file }), /stake/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
