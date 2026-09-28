import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendShadowRow, compareShadowFill, shadowFill } from '../src/shadowLive.js';
import { readShadowRows, shadowDivergenceReport } from '../src/shadowReport.js';

test('shadow live computes fill divergence and writes a separate row tagged without orders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-shadow-'));
  try {
    const trade = { id: 't1', mint: 'M', side: 'BUY', price: 100, slippageBps: 20 }, row = shadowFill({ trade, liveBook: { bid: 101, ask: 102 }, latency: { p50Ms: 40 }, feesBps: 10, data: { bid: 101, ask: 102, observedAt: 1 } });
    assert.equal(row.shadow, true); assert.equal(row.orderPlaced, false); assert.equal(row.estimatedFillAt, 41);
    assert.equal(compareShadowFill(trade, row, { maxDivergenceBps: 100 }).flagged, true);
    const file = path.join(dir, 'shadow.ndjson'); appendShadowRow(row, { file });
    const rows = await readShadowRows(file), report = shadowDivergenceReport(rows, 100);
    assert.equal(report.shadowTrades, 1); assert.equal(report.flagged, 1); assert.equal(report.rows[0].tradeId, 't1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shadow sources cannot call trading endpoints', () => {
  const source = fs.readFileSync(new URL('../src/shadowLive.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\s*\(|orders\.create|placeOrder|submit.*Order/i);
});
