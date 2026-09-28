// P0.3: the discovery fan-out must fit the per-host request budget instead of tripping it.
//
// Verified defect: discoverCandidates sliced 960 addresses (32 batch calls) once per cycle, while
// marketRequests.js refuses anything past MARKET_REQUESTS_PER_MINUTE (120) inside a rolling 60 s
// window shared by every call on api.dexscreener.com. At the 8 s default that is 240/min, so the
// tail of each cycle was refused and the catch turned the refusals into empty batches - a silently
// shrinking universe. The simulation below fails against the old, unclamped fan-out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMarketRequester } from '../src/marketRequests.js';
import { cfg } from '../src/config.js';
import { discoveryBatchBudget, discoveryAddressLimit, DISCOVERY_BATCH_SIZE } from '../src/dexscreener.js';

test('the fan-out is sized from the configured budget and interval', () => {
  // 120 requests/min over an 8 s cycle is 16 calls; discovery may spend half of that (8 batches),
  // leaving the rest of the window to seeds, held pools and follow-up prices.
  assert.equal(discoveryBatchBudget({ requestsPerMinute: 120, intervalSec: 8 }), 8);
  assert.equal(discoveryAddressLimit(240, 8), 240);
  assert.ok(discoveryAddressLimit(240, 8) < 960, 'the historic 4x oversample of a 240 cap does not fit the budget');
});

test('a wider budget or a slower cycle widens the fan-out', () => {
  assert.ok(discoveryBatchBudget({ requestsPerMinute: 300, intervalSec: 8 }) > discoveryBatchBudget({ requestsPerMinute: 120, intervalSec: 8 }));
  assert.ok(discoveryBatchBudget({ requestsPerMinute: 120, intervalSec: 30 }) > discoveryBatchBudget({ requestsPerMinute: 120, intervalSec: 8 }));
  assert.equal(discoveryAddressLimit(600, 40), 1200, 'the 4x oversample of a 600 cap (2400) is still trimmed to the budget');
  assert.ok(discoveryAddressLimit(600, 40) <= 600 * 4);
});

test('the fan-out never exceeds what is left of the window', () => {
  assert.equal(discoveryBatchBudget({ requestsPerMinute: 120, intervalSec: 8, usedInWindow: 118 }), 2);
  assert.equal(discoveryBatchBudget({ requestsPerMinute: 120, intervalSec: 8, usedInWindow: 200 }), 1, 'a starved window keeps one batch instead of none');
  assert.ok(discoveryBatchBudget({ requestsPerMinute: 120, intervalSec: 8, usedInWindow: 0 }) <= 8);
});

test('an unlimited budget leaves the fan-out alone', () => {
  assert.equal(discoveryBatchBudget({ requestsPerMinute: 0, intervalSec: 8 }), Infinity);
  assert.equal(discoveryAddressLimit(240, Infinity), 960);
});

test('the address limit is always at least one batch', () => {
  assert.equal(discoveryAddressLimit(30, 1), DISCOVERY_BATCH_SIZE);
  assert.equal(discoveryAddressLimit(240, 1), DISCOVERY_BATCH_SIZE);
  assert.equal(discoveryAddressLimit(0, 2), DISCOVERY_BATCH_SIZE * 2);
});



// One cycle in the engine is the discovery fan-out plus the other calls that share the same host
// window: one held-pool batch and a few single-pool refreshes (index.js refreshPositionPairs).
const OTHER_DEX_CALLS_PER_CYCLE = 4;

const windowCalls = requester => {
  const row = (requester.health().hosts || []).find(h => h.host === 'api.dexscreener.com');
  return Number(row?.windowCalls || 0);
};

async function runCycles(clamp) {
  let now = 1_700_000_000_000;
  let attempts = 0;
  let maxWindowCalls = 0;
  const requester = createMarketRequester({
    now: () => now,
    requestsPerMinute: 120,
    fetcher: async () => Response.json([]),
  });
  for (let cycle = 0; cycle < 9; cycle++) {
    const batches = clamp
      ? discoveryBatchBudget({ requestsPerMinute: 120, intervalSec: 8, usedInWindow: windowCalls(requester) })
      : 32; // the pre-fix fan-out: 960 addresses, no budget awareness
    for (let i = 0; i < batches; i++) {
      attempts++;
      try { await requester.get('https://api.dexscreener.com/tokens/v1/solana/b' + i, 'dex:token-batch', { ttlMs: 0 }); } catch {}
    }
    for (let i = 0; i < OTHER_DEX_CALLS_PER_CYCLE; i++) {
      attempts++;
      try { await requester.get('https://api.dexscreener.com/latest/dex/pairs/solana/held' + i, 'dex:held-pools', { ttlMs: 0 }); } catch {}
    }
    maxWindowCalls = Math.max(maxWindowCalls, windowCalls(requester));
    now += 8000;
  }
  return { ...requester.health(), attempts, maxWindowCalls };
}

test('a budget-sized fan-out is never refused, while the old 960-address fan-out is', async () => {
  const clamped = await runCycles(true);
  assert.equal(clamped.budgetRejects, 0, 'sizing the fan-out to the window means nothing is refused');
  assert.equal(clamped.requests, clamped.attempts, 'every call the cycle wanted to make was admitted');
  assert.ok(clamped.attempts > 60, 'cycles still do real work (' + clamped.attempts + ' requests)');
  assert.ok(clamped.maxWindowCalls <= 120, 'no 60s window exceeded the 120/min budget (' + clamped.maxWindowCalls + ')');

  const unclamped = await runCycles(false);
  assert.ok(unclamped.budgetRejects > 0, 'the pre-fix fan-out is refused; P0.3 exists because those refusals were invisible');
  assert.ok(unclamped.requests < unclamped.attempts - 100, 'most of the pre-fix fan-out never reached the provider (' + unclamped.requests + '/' + unclamped.attempts + ')');
});

test('discoverCandidates sizes its slice from the budget, not from a fixed oversample', () => {
  const source = fs.readFileSync(new URL('../src/dexscreener.js', import.meta.url), 'utf8');
  assert.match(source, /slice\(0, addressLimit\)/);
  assert.equal(/slice\(0, Math\.max\(max \* 4, 240\)\)/.test(source), false, 'the unclamped slice must be gone');
  assert.equal(cfg.marketRequestsPerMinute > 0, true, 'the default engine runs with a budget, so the clamp is live');
});
