import test from 'node:test';
import assert from 'node:assert/strict';
import { clearFlowCache, cachedFlowSnapshot, deriveFlowSignals } from '../src/onchainFlow.js';

test('net exchange flow and whale accumulation produce signed paper research signals', () => {
  const now = 10_000_000;
  const rows = [
    { ts: now - 1000, asset: 'SOL', side: 'BUY', amountSol: 12 },
    { ts: now - 500, asset: 'SOL', side: 'SELL', amountSol: 3 },
    { ts: now - 200, asset: 'BONK', side: 'SELL', amountSol: 2 },
    { ts: now - 10, asset: 'OLD', side: 'SELL', amountSol: 90 },
  ];
  const sol = deriveFlowSignals(rows, { now, windowMs: 60_000, whaleSol: 10 }).find(x => x.asset === 'SOL');
  assert.equal(sol.netflowSol, 9); assert.deepEqual(sol.signals.map(x => [x.source, x.bias]), [['onchain:netflow', 'BEARISH'], ['onchain:whale', 'BULLISH']]);
  assert.equal(deriveFlowSignals(rows, { now, windowMs: 60_000 }).find(x => x.asset === 'BONK').signals[0].bias, 'BULLISH');
  assert.equal(deriveFlowSignals(rows, { now, windowMs: 60_000 }).some(x => x.asset === 'OLD'), true, 'within the declared one-minute window');
  assert.equal(deriveFlowSignals(rows, { now, windowMs: 5 }).some(x => x.asset === 'OLD'), false, 'outside a shorter window');
});

test('snapshot cache reuses RPC result inside TTL and refreshes after expiry', async () => {
  clearFlowCache(); let calls = 0;
  const load = async () => ++calls;
  assert.equal((await cachedFlowSnapshot('SOL', load, { now: 100, ttlMs: 50 })).value, 1);
  assert.equal((await cachedFlowSnapshot('SOL', load, { now: 120, ttlMs: 50 })).cached, true);
  assert.equal((await cachedFlowSnapshot('SOL', load, { now: 151, ttlMs: 50 })).value, 2);
  assert.equal(calls, 2);
});
