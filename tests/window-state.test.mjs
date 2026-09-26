import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ws = require('../desktop/window-state.cjs');

const primary = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1400 }, scaleFactor: 1.5 };
const second = { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const both = [primary, second];
const centredDefault = { x: 512, y: 188, width: 1536, height: 1024 };

test('a rect on the second monitor at x=-1800 is kept', () => {
  const st = ws.validateState({ x: -1800, y: 40, width: 1200, height: 800, displayId: 2 }, both, primary);
  assert.deepEqual([st.x, st.y, st.width, st.height, st.displayId], [-1800, 40, 1200, 800, 2]);
});

test('x=5000 centres on primary', () => {
  const st = ws.validateState({ x: 5000, y: 40, width: 1200, height: 800 }, both, primary);
  assert.deepEqual({ x: st.x, y: st.y, width: st.width, height: st.height }, centredDefault);
});

test('second monitor unplugged centres on primary and keeps maximized', () => {
  const st = ws.validateState({ x: -1800, y: 40, width: 1200, height: 800, maximized: true, displayId: 2 }, [primary], primary);
  assert.deepEqual({ x: st.x, y: st.y, width: st.width, height: st.height }, centredDefault);
  assert.equal(st.maximized, true);
});

test('oversize rect is clamped to the work area and min size is enforced', () => {
  const big = ws.validateState({ x: 0, y: 0, width: 9000, height: 9000 }, both, primary);
  assert.equal(big.width, 2560); assert.equal(big.height, 1400);
  const tiny = ws.validateState({ x: 100, y: 100, width: 200, height: 100 }, both, primary);
  assert.equal(tiny.width, 900); assert.equal(tiny.height, 620);
});

test('the minimized -32000 rect is rejected', () => {
  const st = ws.validateState({ x: -32000, y: -32000, width: 160, height: 28 }, both, primary);
  assert.deepEqual({ x: st.x, y: st.y, width: st.width, height: st.height }, centredDefault);
});

test('corrupt JSON loads as null, which validates to the default', () => {
  const fs = { readFileSync: () => '{not json' };
  const loaded = ws.loadState('x.json', fs);
  assert.equal(loaded, null);
  const st = ws.validateState(loaded, both, primary);
  assert.deepEqual({ x: st.x, y: st.y, width: st.width, height: st.height }, centredDefault);
});

test('captureState uses getNormalBounds', () => {
  const win = { getNormalBounds: () => ({ x: 10, y: 20, width: 1000, height: 700 }), getBounds: () => { throw Error('must not use getBounds'); }, isMaximized: () => true, isFullScreen: () => false };
  const screen = { getDisplayMatching: b => (b.x === 10 ? { id: 1 } : { id: 9 }) };
  assert.deepEqual(ws.captureState(win, screen), { x: 10, y: 20, width: 1000, height: 700, maximized: true, fullScreen: false, displayId: 1 });
});

test('debounced saver coalesces and flush runs immediately', () => {
  let calls = 0, pending = new Map(), id = 0;
  const timers = { setTimeout: (fn) => { pending.set(++id, fn); return id; }, clearTimeout: t => pending.delete(t) };
  const s = ws.makeDebouncedSaver(() => calls++, 400, timers);
  s.schedule(); s.schedule(); s.schedule();
  assert.equal(pending.size, 1); assert.equal(calls, 0);
  const [[tid, fire]] = [...pending]; pending.delete(tid); fire(); assert.equal(calls, 1);
  s.schedule(); s.flush();
  assert.equal(calls, 2); assert.equal(pending.size, 0);
});

test('saveState writes a tmp file then renames it', () => {
  const ops = [];
  const fs = { writeFileSync: (f, d) => ops.push(['write', f, JSON.parse(d)]), renameSync: (a, b) => ops.push(['rename', a, b]) };
  ws.saveState('w.json', { x: 1, y: 2, width: 3, height: 4 }, fs);
  assert.equal(ops[0][0], 'write'); assert.equal(ops[0][1], 'w.json.tmp'); assert.equal(ops[0][2].v, 1);
  assert.deepEqual(ops[1], ['rename', 'w.json.tmp', 'w.json']);
});
