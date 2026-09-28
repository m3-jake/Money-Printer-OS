// Recovery path for a cycle that threw.
//
// saveState() deliberately refuses to publish a state whose realized basis is violated or whose
// equity jumps discontinuously (store.js realizedBasisViolations / guardEquityJump). That refusal
// is correct, but it used to be called unguarded from the cycle catch block in index.js: the throw
// escaped main(), set exitCode = 1 and ended the loop, and the error counter the catch had just
// incremented was never written anywhere because the throw happened before the rename.
//
// The rule here is "strongest evidence first":
//   1. journal row - append-only ndjson, survives a refused save, a torn write and a SIGKILL
//   2. state.json  - best effort; the same violation may refuse it forever
//   3. memory      - read by /api/health while the process is alive
//
// Nothing in this module throws: the caller is already handling a failure, and a throwing
// recovery path is exactly the bug this file exists to remove.
import { compactError } from './utils.js';
import { loadState, saveState, appendJournal, readJournal } from './store.js';

// Rows that prove a cycle failed even when state.json never changed.
export const ERROR_JOURNAL_TYPES = Object.freeze(['error', 'error-persist-failed']);
const ERROR_TYPES = new Set(ERROR_JOURNAL_TYPES);

// In-memory, process-lifetime: the last recovery save that could not be written.
let saveFailure = null;

const codeOf = error => (error?.code ? String(error.code) : null);

function safeJournal(journal, row) {
  try { journal(row); return true; } catch { return false; }
}

// Records one failed cycle. Returns what actually survived, so the caller can log the truth
// instead of assuming the state was written.
export function recordCycleError({ error, load = loadState, save = saveState, journal = appendJournal, now = Date.now() } = {}) {
  const text = compactError(error);
  const code = codeOf(error);
  // 1. Journal first: this is the only write that cannot be refused by accounting validation.
  const journaled = safeJournal(journal, { type: 'error', error: text, code, at: now });

  // 2. Load the current state. A recovery-required state file (store.js STATE_RECOVERY_REQUIRED)
  //    must not turn into a second crash.
  let s = null;
  try { s = load(); }
  catch (loadError) {
    const failure = { stage: 'load', at: now, code: codeOf(loadError), message: compactError(loadError), cycleError: text };
    safeJournal(journal, { type: 'error-persist-failed', ...failure });
    saveFailure = failure;
    return { journaled, persisted: false, saveFailed: true, stage: 'load', message: text, code, failure };
  }

  s.stats ||= {};
  s.system ||= {};
  const previous = s.system.cycleErrors || {};
  s.stats.errors = Number(s.stats.errors || 0) + 1;
  s.system.lastError = text;
  s.system.lastErrorAt = now;
  const cycleErrors = {
    consecutive: Number(previous.consecutive || 0) + 1,
    total: Number(previous.total || 0) + 1,
    lastAt: now,
    lastMessage: text,
    lastCode: code,
  };
  s.system.cycleErrors = cycleErrors;

  // 3. Best-effort persist. A refusal is evidence, not a crash.
  try { save(s); }
  catch (saveError) {
    const failure = {
      stage: 'save', at: now, code: codeOf(saveError), message: compactError(saveError), cycleError: text,
      errors: s.stats.errors, consecutive: cycleErrors.consecutive,
      violations: Array.isArray(saveError?.violations) ? saveError.violations.length : null,
    };
    safeJournal(journal, { type: 'error-persist-failed', ...failure });
    saveFailure = failure;
    return { journaled, persisted: false, saveFailed: true, stage: 'save', message: text, code, errors: s.stats.errors, consecutive: cycleErrors.consecutive, failure };
  }

  saveFailure = null;
  return { journaled, persisted: true, saveFailed: false, message: text, code, errors: s.stats.errors, consecutive: cycleErrors.consecutive };
}

// Called after a cycle that did not throw. Kept here so /api/health has one place to ask.
export function cycleErrorStreak(state) {
  return Number(state?.system?.cycleErrors?.consecutive || 0);
}

export function resetRecoverySaveFailure() { saveFailure = null; }

// Live view for /api/health: memory plus the journal tail, so a refused save is visible even
// after a restart (the journal row outlives the process that could not persist the counter).
export function cycleRecoveryView({ journal = readJournal, limit = 200, now = Date.now(), windowMs = 10 * 60_000 } = {}) {
  let rows = [];
  try { rows = journal(limit) || []; } catch { rows = []; }
  const recent = rows.filter(row => ERROR_TYPES.has(row?.type) && now - Number(row?.ts || 0) <= windowMs);
  return {
    ok: !saveFailure,
    saveFailed: !!saveFailure,
    lastSaveFailure: saveFailure,
    pendingErrorRows: recent.length,
    lastErrorRow: recent.length ? recent[recent.length - 1] : null,
  };
}
