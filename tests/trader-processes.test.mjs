import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessRows, familyUsage, createTraderProcessSampler } from '../src/traderProcesses.js';

test('process rows are validated and a single object reply is accepted', () => {
  assert.deepEqual(parseProcessRows('{"pid":5,"name":"x","cpuSeconds":1.5,"workingSetBytes":1048576,"startedAt":1}').map(r => r.pid), [5]);
  assert.deepEqual(parseProcessRows('[{"pid":0,"cpuSeconds":1,"workingSetBytes":1},{"pid":7,"cpuSeconds":null,"workingSetBytes":1}]'), []);
  assert.deepEqual(parseProcessRows(''), []);
});

test('family CPU comes from counter deltas; reused PIDs and the first sample are not counted', () => {
  const a = { at: 0, rows: [{ pid: 1, cpuSeconds: 10, workingSetBytes: 100 * 1048576, startedAt: 1 }, { pid: 2, cpuSeconds: 5, workingSetBytes: 50 * 1048576, startedAt: 2 }] };
  const b = { at: 10_000, rows: [{ pid: 1, cpuSeconds: 15, workingSetBytes: 100 * 1048576, startedAt: 1 }, { pid: 2, cpuSeconds: 1, workingSetBytes: 50 * 1048576, startedAt: 99 }] };
  assert.equal(familyUsage(null, a, 32).cpuPctOfOneCore, null);
  const u = familyUsage(a, b, 32);
  assert.equal(u.cpuPctOfOneCore, 50);          // 5 CPU-seconds over 10 s on the PID that persisted
  assert.equal(u.cpuPctOfMachine, 1.6);
  assert.equal(u.measuredProcesses, 1);
  assert.equal(u.workingSetMiB, 150);
});

test('sampler probes only when read, reports errors without inventing numbers, and is Windows-only', async () => {
  let calls = 0, t = 0;
  const execute = async () => { calls++; return { stdout: JSON.stringify([{ pid: 9, name: 'Money Printer OS', cpuSeconds: calls, workingSetBytes: 1048576, startedAt: 1 }]) }; };
  const s = createTraderProcessSampler({ execute, clock: () => (t += 1000), platform: 'win32', everyMs: 60_000 });
  assert.equal(calls, 0);
  const r = await s.read();
  assert.ok(calls >= 2 && r.status === 'SAMPLED' && r.cpuPctOfOneCore > 0);
  const failing = createTraderProcessSampler({ execute: async () => { throw Object.assign(new Error('x'), { killed: true }); }, platform: 'win32', everyMs: 60_000 });
  const e = await failing.read();
  assert.equal(e.status, 'ERROR'); assert.equal(e.cpuPctOfOneCore, undefined);
  assert.equal((await createTraderProcessSampler({ platform: 'linux' }).read()).status, 'UNSUPPORTED');
});
