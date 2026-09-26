import test from 'node:test';
import assert from 'node:assert/strict';
import {loopPersistenceCheck, collectorCaptureCheck, generationAdvanceCheck, diskFreeCheck, orderPostsCheck, switchesCheck, rawRetentionCheck } from '../src/labHealth.js';
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

test('a RUNNING lab whose generation stops advancing goes RED after 30 minutes', () => {
  const t0 = 1_000_000;
  const first = generationAdvanceCheck(null, { status: 'RUNNING', generation: 10 }, { now: t0 });
  assert.equal(first.level, 'OK'); assert.deepEqual(first.state, { generation: 10, changedAt: t0 });
  const moving = generationAdvanceCheck(first.state, { status: 'RUNNING', generation: 12 }, { now: t0 + 40 * 60000 });
  assert.equal(moving.level, 'OK'); assert.match(moving.detail, /\+2/);
  const stuck = generationAdvanceCheck(moving.state, { status: 'RUNNING', generation: 12 }, { now: t0 + 80 * 60000 + 1 });
  assert.equal(stuck.level, 'RED'); assert.equal(stuck.state.changedAt, t0 + 40 * 60000);
  assert.equal(generationAdvanceCheck(moving.state, { status: 'PAUSED', generation: 12 }, { now: t0 + 999 * 60000 }).level, 'OK', 'paused is not stuck');
});

test('disk, order POSTs, live flags and raw retention', () => {
  assert.equal(diskFreeCheck(1 * 1073741824).level, 'RED'); assert.equal(diskFreeCheck(5 * 1073741824).level, 'WARN'); assert.equal(diskFreeCheck(80 * 1073741824).level, 'OK');
  assert.equal(orderPostsCheck({ get: 5, post: 0 }).level, 'OK'); assert.equal(orderPostsCheck({ post: 1 }).level, 'RED'); assert.equal(orderPostsCheck(null).level, 'WARN');
  assert.equal(switchesCheck({ liveExecution: 'manual', paperOnlyBuild: true, realEnabled: false }).level, 'OK');
  assert.match(switchesCheck({ liveExecution: 'auto', sessionArmed: true }).detail, /liveExecution=auto, sessionArmed/);
  const now = 10 * 3600000;
  assert.equal(rawRetentionCheck({}).level, 'WARN');
  assert.equal(rawRetentionCheck({ retention: { at: now - 60000, totalBytes: 2 ** 30, budgetBytes: 20 * 2 ** 30, files: 9, keepDays: 45 } }, { now }).level, 'OK');
  assert.equal(rawRetentionCheck({ retention: { at: now - 60000, totalBytes: 2 ** 30, budgetBytes: 2 ** 20, files: 9, keepDays: 45, overBudget: true } }, { now }).level, 'WARN');
  assert.equal(rawRetentionCheck({ retention: { at: now - 5 * 3600000, totalBytes: 1, budgetBytes: 2, files: 1, keepDays: 45 } }, { now }).level, 'WARN', 'retention pass overdue');
});
