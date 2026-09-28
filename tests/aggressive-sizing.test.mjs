import test from 'node:test';
import assert from 'node:assert/strict';
import { halfKelly, sizeFromEdge, splitTranches } from '../src/sizing.js';
import fs from 'node:fs';

test('half Kelly uses expectancy over variance and obeys the configured caps', () => {
  const x = halfKelly({ expectancy: 0.02, variance: 0.04, equity: 10, floor: 0.1, ceiling: 0.4 });
  assert.equal(x.kelly, 0.5); assert.equal(x.halfKellyFraction, 0.25); assert.equal(x.finalSize, 0.4);
  assert.equal(halfKelly({ expectancy: -1, variance: 2, equity: 10 }).finalSize, 0);
});

test('aggressive sizing is a no-op outside aggressive paper and logs every active decision', () => {
  assert.deepEqual(sizeFromEdge({ runtime: { profile: 'AGGRESSIVE_PAPER' }, mode: 'live', expectancy: 1, variance: 2, equity: 4 }), { enabled: false, reason: 'aggressive-paper-required', finalSize: null });
  assert.equal(sizeFromEdge({ runtime: { profile: 'FAIR' }, mode: 'paper' }).enabled, false);
  const logs = [], d = sizeFromEdge({ runtime: { profile: 'AGGRESSIVE_PAPER' }, mode: 'paper', expectancy: 0.1, variance: 1, equity: 10, logger: x => logs.push(x) });
  assert.equal(d.enabled, true); assert.equal(logs[0].type, 'sizing-decision'); assert.equal(logs[0].finalSize, d.finalSize);
});

test('sizes above the threshold split into two to four time-staggered clips', () => {
  assert.deepEqual(splitTranches(0.2), [{ sizeSol: 0.2, delayMs: 0 }]);
  const clips = splitTranches(1, { threshold: 0.25, clips: 4, intervalMs: 100 });
  assert.equal(clips.length, 4); assert.ok(Math.abs(clips.reduce((s, x) => s + x.sizeSol, 0) - 1) < 1e-12); assert.deepEqual(clips.map(x => x.delayMs), [0, 100, 200, 300]);
});

test('aggressive paper engine derives size from closed returns and stages later clips',()=>{
 const source=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.match(source,/sizeFromEdge\(/);assert.match(source,/stagedTranches/);assert.match(source,/paper-tranche-fill/);
});

test('recent closed returns are chronological, finite, paper-only and independent of array order', async () => {
  const {recentClosedReturns}=await import('../src/sizing.js');
  const rows=Array.from({length:50},(_,i)=>({closedAt:i+1,returnPct:i,mode:'PAPER'})), original=JSON.stringify(rows);
  const expected=rows.slice(-3).reverse().map(x=>x.returnPct/100);
  assert.deepEqual(recentClosedReturns(rows,3,{now:100}),expected);
  assert.deepEqual(recentClosedReturns([...rows].reverse(),3,{now:100}),expected);
  assert.equal(JSON.stringify(rows),original);
  const invalid=[{closedAt:101,returnPct:999},{closedAt:90,returnPct:null},{closedAt:95,returnPct:999,mode:'LIVE'}];
  assert.deepEqual(recentClosedReturns([...rows,...invalid],3,{now:100}),expected);
});
