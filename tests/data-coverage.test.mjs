import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataCoverage } from '../src/dataCoverage.js';

test('coverage reports live/down status, per-day rows and the largest gap per source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-cov-'));
  const now = Date.UTC(2026, 8, 26, 12), raw = path.join(dir, 'research-evidence', 'raw'), rh = path.join(dir, 'robinhood-tape');
  fs.mkdirSync(raw, { recursive: true }); fs.mkdirSync(rh, { recursive: true });
  // Solana: steady until 3 h ago -> DOWN with a 3 h trailing gap.
  const sol = []; for (let t = now - 2 * 864e5; t < now - 3 * 3600e3; t += 60e3) sol.push(JSON.stringify({ ts: t, mint: 'm' }));
  fs.writeFileSync(path.join(raw, 'solana-path-2026-09-26.ndjson'), sol.join('\n') + '\n');
  // Robinhood: live, but with a 6 h hole yesterday.
  const hole = [now - 30 * 3600e3, now - 24 * 3600e3], btc = [];
  for (let t = now - 2 * 864e5; t <= now - 30e3; t += 15e3) if (t < hole[0] || t > hole[1]) btc.push(JSON.stringify({ t, bid: 1, ask: 1 }));
  fs.writeFileSync(path.join(rh, 'BTC-USD.ndjson'), btc.join('\n') + '\n');
  const c = dataCoverage(dir, { now, force: true }), by = Object.fromEntries(c.sources.map(s => [s.source, s]));
  assert.equal(by['Solana path ticks'].status, 'DOWN'); assert.ok(Math.abs(by['Solana path ticks'].maxGapMs - 3 * 3600e3) < 120e3);
  assert.equal(by['Robinhood BTC-USD'].status, 'LIVE'); assert.ok(by['Robinhood BTC-USD'].maxGapMs >= 6 * 3600e3 - 30e3);
  assert.equal(by['Polymarket depth'].status, 'NO_DATA');
  assert.equal(by['Robinhood BTC-USD'].perDay.length, 7); assert.equal(by['Robinhood BTC-USD'].perDay[0].rows, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
