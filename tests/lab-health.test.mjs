import test from 'node:test';
import assert from 'node:assert/strict';
import { loopPersistenceCheck } from '../src/labHealth.js';
test('a paused recovered checkpoint is healthy only when freshly read back at the expected generation', () => {
  const s = { status: 'PAUSED', generation: 53549, loopWrite: { lastWriteAt: 0, verified: true, verifiedGeneration: 53549, verifiedStaleMs: 20, errors: 0, verifyFailures: 0 } };
  assert.equal(loopPersistenceCheck(s).level, 'OK');
  assert.equal(loopPersistenceCheck({ ...s, generation: 53550 }).level, 'RED');
  assert.equal(loopPersistenceCheck({ ...s, loopWrite: { ...s.loopWrite, verified: false } }).level, 'RED');
  assert.equal(loopPersistenceCheck({ ...s, loopWrite: { ...s.loopWrite, verifiedStaleMs: 600001 } }).level, 'RED');
  assert.equal(loopPersistenceCheck({ generation: 53549 }).level, 'RED');
});
