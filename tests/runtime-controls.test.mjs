import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCustomExit, customExitPolicy, openLimitFor, aggressionParams } from '../src/runtime.js';

test('custom exits are clamped to hard bounds and junk is dropped', () => {
  assert.deepEqual(sanitizeCustomExit({ stop: 99, tp1: 0, maxHold: 12.6, trail: 'x', tp2: '', evil: 5 }), { stop: 50, tp1: 1, maxHold: 13 });
  assert.equal(customExitPolicy({ customExit: { stop: 12 } }).stop, 12);
  assert.ok(Number.isFinite(customExitPolicy({}).tp1), 'unset fields fall back to config');
});

test('max-open override replaces the aggression default; live still capped by env; SPRINT floor kept', () => {
  assert.equal(openLimitFor({ aggression: 72 }, 'paper'), aggressionParams(72).maxOpenPositions);
  assert.equal(openLimitFor({ aggression: 72, maxOpenPositions: 4 }, 'paper'), 4);
  assert.equal(openLimitFor({ aggression: 72, maxOpenPositions: 99 }, 'paper'), aggressionParams(72).maxOpenPositions, 'out-of-range override ignored');
  assert.ok(openLimitFor({ aggression: 72, maxOpenPositions: 30 }, 'live') <= 30);
  assert.equal(openLimitFor({ aggression: 72, maxOpenPositions: 4, profile: 'SPRINT' }, 'paper'), 16);
});
