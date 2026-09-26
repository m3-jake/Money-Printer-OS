import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysics, throwVelocity } from '../src/moneyPhysics.js';

test('physics is deterministic, bounded, and floor-safe', () => {
  const a = createPhysics(7, { maxBodies: 2 }); const b = createPhysics(7, { maxBodies: 2 });
  for (const p of [{ id: 'a', x: 1, y: 1 }, { id: 'b', x: 3, y: 2 }, { id: 'c' }]) { assert.equal(a.add(p), p.id !== 'c'); assert.equal(b.add(p), p.id !== 'c'); }
  for (let i = 0; i < 20; i++) { a.step(0.016, 10, 100); b.step(0.016, 10, 100); }
  assert.deepEqual(a.bodies, b.bodies); assert.ok(a.bodies.every(x => x.y + x.h / 2 <= 100.0001));
});
test('wind and throw velocity are represented', () => {
  const p = createPhysics(1); p.add({ id: 'x', x: 0, y: 0, wind: 5 }); p.step(0.016, 10, 100);
  assert.ok(p.bodies[0].vx > 0); assert.deepEqual(throwVelocity({ x: 0, y: 0 }, { x: 20, y: -10 }, 100), { vx: 200, vy: -100 });
});
