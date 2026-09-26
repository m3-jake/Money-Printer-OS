// scripts/rh-tape-stats.mjs: read-only tape statistics (batch 12).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tapeStats, __file } from '../scripts/rh-tape-stats.mjs';

const STEP = 15000, t0 = 1_800_000_000_000;
// A deterministic random walk with a 10 bps spread.
function walk(n, vol, src = 'robinhood') {
  let seed = 7, mid = 60000; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, (_, i) => { mid *= Math.exp((rnd() - 0.5) * 2 * vol); const bid = mid * (1 - 0.0005), ask = mid * (1 + 0.0005); return { t: t0 + i * STEP, bid, ask, mid: (bid + ask) / 2, src }; });
}
test('stats: spread quantiles, source counts, and a calm tape never opens the volatility gate', () => {
  const s = tapeStats(walk(2000, 0.00002));
  assert.equal(s.rows, 2000);
  assert.deepEqual(s.sources, { robinhood: 2000 });
  assert.ok(Math.abs(s.spreadBps.p50 - 10) < 0.01, JSON.stringify(s.spreadBps));
  assert.ok(s.gateChecks > 0);
  assert.equal(s.volGateOpenPct, 0, 'a 0.2 bps/sample walk cannot clear 1.5x a 1.8% round trip');
  assert.equal(s.replay.closes, 0);
});
test('stats: a volatile tape opens the gate', () => {
  const s = tapeStats(walk(2000, 0.004));
  assert.ok(s.volGateOpenPct > 50, JSON.stringify(s));
});
test('stats: empty tape and short tape are safe', () => {
  const e = tapeStats([]);
  assert.equal(e.rows, 0); assert.equal(e.gateChecks, 0); assert.equal(e.roundTripCostPct.p50, null); assert.equal(e.expectedMovePct.p50, null); assert.equal(e.volGateOpenPct, null); assert.equal(e.replay, null);
});
test('CLI prints one line per symbol from a data dir and never writes to it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-rh-stats-')), dir = path.join(root, 'robinhood-tape');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const sym of ['BTC-USD', 'ETH-USD']) fs.writeFileSync(path.join(dir, sym + '.ndjson'), walk(300, 0.0005).map(({ t, bid, ask, src }) => JSON.stringify({ t, bid, ask, src })).join('\n') + '\n');
    const before = fs.readdirSync(dir).map(f => f + ':' + fs.statSync(path.join(dir, f)).size).join();
    const out = execFileSync(process.execPath, [__file, '--data', root], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(out.length, 2); assert.match(out[0], /^BTC-USD 300 rows .*\[robinhood:300\]/); assert.match(out[1], /^ETH-USD /);
    assert.equal(fs.readdirSync(dir).map(f => f + ':' + fs.statSync(path.join(dir, f)).size).join(), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('stats: warm-start candle rows count as a source but never drag the spread quantiles to zero', () => {
  const rows = walk(400, 0.00002).concat(walk(1600, 0.00002, 'coinbase-candles').map((r, i) => ({ ...r, t: t0 + (400 + i) * STEP, bid: r.mid, ask: r.mid })));
  const s = tapeStats(rows);
  assert.deepEqual(s.sources, { robinhood: 400, 'coinbase-candles': 1600 });
  assert.ok(Math.abs(s.spreadBps.p50 - 10) < 0.01 && Math.abs(s.spreadBps.p90 - 10) < 0.01, JSON.stringify(s.spreadBps));
});
