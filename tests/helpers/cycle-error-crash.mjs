// Crash fixture for tests/cycle-recovery.test.mjs.
//
// Records one cycle error whose recovery save is refused by accounting validation (the exact shape
// store.js throws), then keeps saving valid state in a tight loop until the parent SIGKILLs it.
// Nothing here is defensive on purpose: the parent picks an arbitrary moment to kill it, which is
// how a torn state.json would be produced if the write were not atomic.
import { loadState, saveState } from '../../src/store.js';
import { recordCycleError } from '../../src/cycleRecovery.js';

const refusal = Object.assign(new Error('refusing to save: REALIZED_BASIS on position p-crash'), { code: 'REALIZED_BASIS' });
const first = recordCycleError({ error: new Error('crash-cycle: injected accounting refusal'), save: () => { throw refusal; } });
process.stdout.write(`recorded ${JSON.stringify({ saveFailed: first.saveFailed, stage: first.stage, errors: first.errors })}\n`);

let i = 0;
setInterval(() => {
  try {
    const s = loadState();
    s.cashSol = Math.max(0, Number(s.cashSol || 0));
    saveState(s);
    process.stdout.write(`save ${++i}\n`);
  } catch (error) {
    process.stdout.write(`save-error ${error.message}\n`);
  }
}, 5);
