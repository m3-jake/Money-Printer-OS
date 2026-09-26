import test from 'node:test';
import assert from 'node:assert/strict';
import { loopPersistenceCheck, collectorCaptureCheck } from '../src/labHealth.js';
test('a paused recovered checkpoint is healthy only when freshly read back at the expected generation', () => {
  const s = { status: 'PAUSED', generation: 53549, loopWrite: { lastWriteAt: 0, verified: true, verifiedGeneration: 53549, verifiedStaleMs: 20, errors: 0, verifyFailures: 0 } };
  assert.equal(loopPersistenceCheck(s).level, 'OK');
  assert.equal(loopPersistenceCheck({ ...s, generation: 53550 }).level, 'RED');
  assert.equal(loopPersistenceCheck({ ...s, loopWrite: { ...s.loopWrite, verified: false } }).level, 'RED');
  assert.equal(loopPersistenceCheck({ ...s, loopWrite: { ...s.loopWrite, verifiedStaleMs: 600001 } }).level, 'RED');
  assert.equal(loopPersistenceCheck({ generation: 53549 }).level, 'RED');
});

test('tape collector health goes RED on a stale heartbeat and WARN on capture or write problems', () => {
  const now = 10_000_000;
  const s = { updatedAt: now - 2000, pid: 42, polymarket: { lastAt: now - 4000, rowsTotal: 179 } };
  assert.equal(collectorCaptureCheck(s, { now }).level, 'OK');
  assert.equal(collectorCaptureCheck({}, { now }).level, 'WARN');
  assert.equal(collectorCaptureCheck({ ...s, updatedAt: now - 300001 }, { now }).level, 'RED');
  assert.equal(collectorCaptureCheck({ ...s, polymarket: { lastAt: now - 600001 } }, { now }).level, 'WARN');
  assert.equal(collectorCaptureCheck({ ...s, polymarket: { ...s.polymarket, error: 'fetch failed', lastErrorAt: now - 1000 } }, { now }).level, 'WARN');
  assert.equal(collectorCaptureCheck({ ...s, polymarket: { ...s.polymarket, error: 'old', lastErrorAt: now - 9000 } }, { now }).level, 'OK');
  assert.equal(collectorCaptureCheck({ ...s, lastWriteError: { message: 'EPERM', at: now - 60000 } }, { now }).level, 'WARN');
  assert.equal(collectorCaptureCheck({ ...s, lastWriteError: { message: 'EPERM', at: now - 3600001 } }, { now }).level, 'OK');
});
