// P0.4: a cycle is bounded in wall-clock time, and the bound reaches the network.
//
// Verified defect: every fetch had its own timeout but nothing bounded the cycle, so the loop's
// cadence was whatever the slowest phase decided. A budget now carries a deadline plus an
// AbortSignal that the market requester honours for every dex/gecko read, and phase boundaries
// assert that the cycle is still alive. A cycle abandoned this way is recorded separately from a
// cycle that threw (see the abort-accounting test in cycle-recovery.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCycleBudget, isCycleBudgetError, CYCLE_BUDGET_CODE } from '../src/cycleBudget.js';
import { createMarketRequester } from '../src/marketRequests.js';

const failure = promise => promise.then(() => null, error => error);

test('a fast cycle never trips its budget', () => {
  let now = 1000;
  const budget = createCycleBudget({ budgetMs: 5000, now: () => now });
  budget.assertAlive('discovery');
  now += 4999;
  assert.equal(budget.expired(), false);
  assert.equal(budget.remainingMs(), 1);
  budget.assertAlive('enrichment');
  assert.equal(budget.view().aborted, false);
  assert.equal(budget.signal.aborted, false);
});

test('past the deadline the next phase boundary abandons the cycle', () => {
  let now = 1000;
  const budget = createCycleBudget({ budgetMs: 5000, now: () => now });
  now += 5000;
  assert.equal(budget.expired(), true);
  const thrown = (() => { try { budget.assertAlive('discovery'); return null; } catch (error) { return error; } })();
  assert.ok(thrown, 'the boundary throws so the cycle ends instead of running on');
  assert.equal(isCycleBudgetError(thrown), true);
  assert.equal(thrown.code, CYCLE_BUDGET_CODE);
  assert.equal(thrown.stage, 'discovery');
  assert.equal(thrown.budgetMs, 5000);
  assert.equal(thrown.elapsedMs, 5000);
  assert.equal(budget.signal.aborted, true, 'the signal is what cancels in-flight market reads');
  assert.equal(isCycleBudgetError(budget.signal.reason), true);
  const later = (() => { try { budget.assertAlive('enrichment'); return null; } catch (error) { return error; } })();
  assert.equal(later.stage, 'discovery', 'later boundaries report the first cause, not a fresh one');
});

test('an explicit abort cancels work without throwing at the abort site', () => {
  const budget = createCycleBudget({ budgetMs: 60_000 });
  budget.abort('shutdown');
  assert.equal(budget.signal.aborted, true);
  assert.equal(budget.view().abortedStage, 'shutdown');
  assert.equal(isCycleBudgetError((() => { try { budget.assertAlive('execution'); return null; } catch (error) { return error; } })()), true);
});

test('a zero budget disables the deadline instead of expiring instantly', () => {
  let now = 0;
  const budget = createCycleBudget({ budgetMs: 0, now: () => now });
  now += 1_000_000_000;
  assert.equal(budget.expired(), false);
  budget.assertAlive('discovery');
  assert.equal(budget.signal.aborted, false);
});

test('the market requester cancels an in-flight read when the cycle signal aborts', async () => {
  let transportAborted = false;
  const requester = createMarketRequester({
    timeoutMs: 60_000,
    fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { transportAborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    }),
  });
  const budget = createCycleBudget({ budgetMs: 60_000 });
  const pending = requester.get('https://api.dexscreener.com/tokens/v1/solana/x', 'dex:token-batch', { ttlMs: 0, signal: budget.signal });
  budget.abort('discovery');
  const error = await failure(pending);
  assert.ok(error, 'the read rejects instead of waiting out its own 60s timeout');
  assert.equal(isCycleBudgetError(error), true, 'and it reports the cycle budget, not a provider timeout');
  assert.equal(transportAborted, true, 'the transport signal was aborted');
  assert.equal(requester.health().timeouts, 0, 'a cancellation is not a provider timeout');
});

test('an already-aborted signal rejects before the fetch is made', async () => {
  let calls = 0;
  const requester = createMarketRequester({ fetcher: async () => { calls++; return Response.json([]); } });
  const budget = createCycleBudget({ budgetMs: 1000 });
  budget.abort('shutdown');
  const error = await failure(requester.get('https://api.dexscreener.com/tokens/v1/solana/y', 'dex:token-batch', { ttlMs: 0, signal: budget.signal }));
  assert.equal(isCycleBudgetError(error), true);
  assert.equal(calls, 0);
  assert.equal(requester.health().requests, 0);
});

test('without a signal the requester behaves exactly as before', async () => {
  let calls = 0;
  const requester = createMarketRequester({ fetcher: async () => { calls++; return Response.json([]); } });
  const result = await requester.get('https://api.dexscreener.com/tokens/v1/solana/z', 'dex:token-batch', { ttlMs: 0 });
  assert.ok(Array.isArray(result.data));
  assert.equal(calls, 1);
});

test('the engine installs the budget signal for every market read and asserts per phase', () => {
  const engine = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(engine, /createCycleBudget\(\)/);
  assert.match(engine, /setCycleSignal\(budget\.signal\)/);
  assert.match(engine, /recordCycleBudgetAbort\(\{ error, budgetMs: budget\.budgetMs \}\)/);
  assert.ok((engine.match(/budget\?\.assertAlive\(/g) || []).length >= 4, 'phase boundaries assert the deadline');
  const dex = fs.readFileSync(new URL('../src/dexscreener.js', import.meta.url), 'utf8');
  assert.match(dex, /signal:cycleSignal/, 'the signal reaches every dex/gecko read through getJson');
});

// 2026-10-03: the engine sat inside one cycle for 100+ minutes (an await nothing could cancel) while health said HEALTHY.
test('a stalled cycle is abandoned: it records its last stage, aborts in-flight work and never saves', () => {
  let now = 0;
  const budget = createCycleBudget({ budgetMs: 45000, now: () => now });
  budget.assertAlive('positions'); budget.assertAlive('discovery');
  assert.equal(budget.lastStage, 'discovery'); assert.equal(budget.abandoned, false);
  budget.abandon();
  assert.equal(budget.abandoned, true); assert.equal(budget.signal.aborted, true);
  assert.throws(() => budget.assertAlive('enrichment'), e => isCycleBudgetError(e) && /stalled after discovery/.test(e.message));
});

test('the engine loop races each cycle against a stall timer, skips a late save, and health reports STALLED', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'), dash = fs.readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /await Promise\.race\(\[cycle\(budget\), new Promise\(/, 'a stalled cycle cannot block the loop');
  assert.match(src, /if \(budget\?\.abandoned\) return;[^\n]*\n\s*s\.system\.metrics\.saveMs = saveState\(s\)/, 'an abandoned cycle never overwrites newer state');
  assert.match(dash, /health: stalled \? 'STALLED'/); assert.match(dash, /engine = \{ lastCycle: lc, ageMs: age, stalled:/);
});

test('the desktop supervisor needs three missed health probes (5 s each) before it swaps the dashboard for recovery', () => {
  const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /health\(5000\)\.then\(h => \{\n\s*healthMisses = h \? 0 : healthMisses \+ 1;/);
  assert.match(main, /if \(!h && showingDashboard && healthMisses >= 3\)/, 'one slow answer never reloads the HUD');
});
