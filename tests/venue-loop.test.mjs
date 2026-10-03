// Run C2: every paper venue has its own timer, budget and stall watchdog; one hung venue never holds up another.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createVenueLoops } from '../src/venueLoop.js';

// Manual clock and timers, so the test is exact and instant.
function fakeClock() {
  let t = 0; const jobs = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const j = { at: t + ms, fn, every: null }; jobs.push(j); return j; },
    setRepeat: (fn, ms) => { const j = { at: t + ms, fn, every: ms }; jobs.push(j); return j; },
    clear: j => { j.dead = true; },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = jobs.filter(j => !j.dead && j.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at; if (due.every) due.at += due.every; else due.dead = true;
        due.fn(); for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      t = end;
    },
  };
}

test('a hung venue is reported STALLED, is not run on top of itself, and the other venues keep their cadence', async () => {
  const c = fakeClock();
  const loops = createVenueLoops({ now: c.now, setTimer: c.setTimer, setRepeat: c.setRepeat, clearTimer: c.clear, clearRepeat: c.clear });
  let hungCalls = 0, okCalls = 0; let release;
  loops.add('kalshi-btc', { everyMs: 60_000, stallMs: 120_000, run: () => { hungCalls++; return new Promise(r => { release = r; }); } });
  loops.add('polymarket-copy', { everyMs: 60_000, run: async () => { okCalls++; } });
  await c.advance(10 * 60_000);
  const st = loops.status();
  assert.equal(hungCalls, 1, 'never a second run racing the first over the same book');
  assert.equal(st['kalshi-btc'].state, 'STALLED'); assert.equal(st['kalshi-btc'].stalls, 1);
  assert.match(st['kalshi-btc'].lastError, /the others keep running/);
  assert.ok(st['kalshi-btc'].runningForMs >= 9 * 60_000);
  assert.deepEqual(loops.stalled(), ['kalshi-btc']);
  assert.equal(okCalls, 11, 'the copy bot ran every minute throughout');
  assert.equal(st['polymarket-copy'].state, 'OK');
  release(); for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(loops.status()['kalshi-btc'].state, 'OK', 'a stalled venue recovers once its run finishes'); assert.deepEqual(loops.stalled(), []);
  await c.advance(60_000); assert.equal(hungCalls, 2, 'and runs again on its own cadence');
  loops.stop();
});

test('errors are per venue and stop() clears every timer', async () => {
  const c = fakeClock();
  const loops = createVenueLoops({ now: c.now, setTimer: c.setTimer, setRepeat: c.setRepeat, clearTimer: c.clear, clearRepeat: c.clear });
  let n = 0;
  loops.add('kalshi-mirror', { everyMs: 1000, run: async () => { throw new Error('provider down'); } });
  loops.add('kalshi-weather', { everyMs: 1000, run: async () => { n++; } });
  await c.advance(3000);
  assert.equal(loops.status()['kalshi-mirror'].state, 'ERROR'); assert.equal(loops.status()['kalshi-mirror'].errors, 4);
  assert.equal(loops.status()['kalshi-weather'].state, 'OK');
  loops.stop(); const before = n; await c.advance(5000); assert.equal(n, before);
  assert.throws(() => loops.add('kalshi-weather', { everyMs: 1, run: async () => {} }), /duplicate/);
});

test('the dashboard runs the paper bots through venue loops and health reads cached state', () => {
  const src = fs.readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  for (const name of ['kalshi-weather', 'kalshi-weather-nws', 'kalshi-btc', 'kalshi-farm-weather', 'kalshi-farm-btc', 'polymarket-copy', 'kalshi-mirror', 'weather-calibration'])
    assert.match(src, new RegExp(`v\\.add\\('${name}'`), name);
  assert.match(src, /venues: venueLoops\.status\(\), stalledVenues: venueLoops\.stalled\(\)/);
  const health = src.slice(src.indexOf("u.pathname === '/api/health'"), src.indexOf("u.pathname === '/api/health'") + 400);
  assert.match(health, /loadStateCached\(\)/); assert.doesNotMatch(health, /= loadState\(\)/);
});
