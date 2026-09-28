import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePumpfunLaunch, pumpfunNativeCapability } from '../src/pumpfun.js';
import { createSniper } from '../src/pumpfunSniper.js';

const mint = 'So11111111111111111111111111111111111111112';

test('launch parser extracts a mint and native transaction capability fails closed', () => {
  assert.equal(parsePumpfunLaunch([`Program log: initialize mint ${mint}`], { signature: 's', ts: 4 }).mint, mint);
  assert.equal(parsePumpfunLaunch(['unrelated']), null);
  assert.equal(pumpfunNativeCapability().buy, false);
});

test('sniper is aggressive-paper gated, dedupes mints and rate-limits per block', () => {
  const decide = createSniper({ perBlockLimit: 1 }), runtime = { profile: 'AGGRESSIVE_PAPER', paperOverrides: { tradeSizeSol: 1, maxPositionSol: 3 } };
  assert.equal(decide({ mint, slot: 1 }, { mode: 'live', runtime }).reason, 'aggressive-paper-required');
  const first = decide({ mint, slot: 1, liq: 10_000, executionScore: 50 }, { mode: 'paper', runtime });
  assert.equal(first.accepted, true); assert.equal(first.shadowOnly, true); assert.equal(first.requestedSizeSol, 1); assert.equal(first.priorityFeeLamports, 0);
  assert.equal(decide({ mint, slot: 2 }, { mode: 'paper', runtime }).reason, 'duplicate-mint');
  assert.equal(decide({ mint: 'AnotherMint111111111111111111111111111111111', slot: 1 }, { mode: 'paper', runtime }).reason, 'block-rate-limit');
});
