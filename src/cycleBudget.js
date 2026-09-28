// P0.4: bound a cycle in wall-clock time so a slow provider cannot stall the loop indefinitely.
//
// Verified defect: individual fetches have timeouts (marketRequests 6.5 s, peers 9-30 s) but nothing
// bounded the cycle as a whole, so the loop's cadence was whatever the slowest phase decided. A cycle
// now carries a deadline and an AbortSignal: the signal is handed to the market requester (every
// dex/gecko read goes through it, so in-flight fetches are cancelled) and phase boundaries call
// assertAlive(), which throws a typed error the loop records without counting it as a cycle error.
import { cfg } from './config.js';

export const CYCLE_BUDGET_CODE = 'CYCLE_BUDGET_EXCEEDED';

export function cycleBudgetError(stage, budgetMs, elapsedMs) {
  const error = new Error(`${stage} exceeded the ${budgetMs}ms cycle budget (${elapsedMs}ms elapsed)`);
  error.code = CYCLE_BUDGET_CODE;
  error.stage = stage;
  error.budgetMs = budgetMs;
  error.elapsedMs = elapsedMs;
  return error;
}

export function isCycleBudgetError(error) {
  return error?.code === CYCLE_BUDGET_CODE;
}

export function createCycleBudget({ budgetMs = cfg.cycleBudgetMs, now = Date.now, label = 'cycle' } = {}) {
  const startedAt = now();
  const limit = Math.max(0, Number(budgetMs) || 0);
  const deadline = startedAt + limit;
  const controller = new AbortController();
  let abortedStage = null;
  const elapsed = () => Math.max(0, now() - startedAt);
  // A zero budget means "no deadline" (the switch is off), not "expire immediately".
  const expired = () => limit > 0 && elapsed() >= limit;
  const fail = stage => {
    const error = cycleBudgetError(stage, limit, elapsed());
    if (!abortedStage) {
      abortedStage = stage;
      controller.abort(error);
    }
    return error;
  };
  return {
    label,
    budgetMs: limit,
    startedAt,
    deadline,
    signal: controller.signal,
    elapsedMs: elapsed,
    expired,
    remainingMs: () => Math.max(0, deadline - now()),
    // Call this at a phase boundary. Over budget means: stop now, with a reason the caller can log.
    assertAlive(stage = label) {
      if (abortedStage) throw fail(abortedStage);
      if (limit > 0 && expired()) throw fail(stage);
    },
    // Call this when the process is going down: cancel in-flight work without throwing.
    abort(stage = 'shutdown') {
      if (!abortedStage) fail(stage);
    },
    view() {
      return { label, budgetMs: limit, elapsedMs: elapsed(), remainingMs: Math.max(0, deadline - now()), aborted: !!abortedStage, abortedStage, expired: limit > 0 && expired() };
    },
  };
}
