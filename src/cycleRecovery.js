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
import { cfg } from './config.js';
import { CYCLE_BUDGET_CODE } from './cycleBudget.js';
import { loadState, saveState, appendJournal, readJournal } from './store.js';

// Rows that prove a cycle failed even when state.json never changed.
export const ERROR_JOURNAL_TYPES = Object.freeze(['error', 'error-persist-failed']);
const ERROR_TYPES = new Set(ERROR_JOURNAL_TYPES);
// The diagnostic that carries a failing streak into s.system.health, which supervisorTick derives
// from diagnostics (ERROR -> DEGRADED, WARN -> CAUTION) and /api/health reports as ok: false.
export const CYCLE_ERROR_CODE = 'CYCLE_ERROR_STREAK';

// In-memory, process-lifetime: the last recovery save that could not be written.
let saveFailure = null;

const codeOf = error => (error?.code ? String(error.code) : null);

function safeJournal(journal, row) {
  try { journal(row); return true; } catch { return false; }
}

// Records one failed cycle. Returns what actually survived, so the caller can log the truth
// instead of assuming the state was written.
// Mirrors supervisorTick's own derivation so a cleared streak cannot leave a stale DEGRADED behind.
const healthFromDiagnostics = diagnostics => (diagnostics.some(d => d?.level === 'ERROR') ? 'DEGRADED' : diagnostics.some(d => d?.level === 'WARN') ? 'CAUTION' : 'HEALTHY');

export function recordCycleError({ error, degradeAfter = cfg.cycleErrorDegradeAfter, load = loadState, save = saveState, journal = appendJournal, now = Date.now() } = {}) {
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

  // Consecutive failures are a different animal from one bad cycle: after `degradeAfter` in a row the
  // engine is not scanning, so /api/health must stop saying ok. supervisorTick rebuilds health from
  // diagnostics every cycle, so the diagnostic (not just the flag) is what keeps this honest.
  const degraded = cycleErrors.consecutive >= degradeAfter;
  if (degraded) {
    s.system.diagnostics ||= [];
    if (!s.system.diagnostics.some(d => d?.code === CYCLE_ERROR_CODE)) {
      s.system.diagnostics.push({ level: 'ERROR', code: CYCLE_ERROR_CODE, message: `${cycleErrors.consecutive} consecutive cycle errors (last: ${text})` });
    }
    s.system.health = healthFromDiagnostics(s.system.diagnostics);
  }

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
    return { journaled, persisted: false, saveFailed: true, stage: 'save', message: text, code, errors: s.stats.errors, consecutive: cycleErrors.consecutive, degraded, failure };
  }

  saveFailure = null;
  return { journaled, persisted: true, saveFailed: false, message: text, code, errors: s.stats.errors, consecutive: cycleErrors.consecutive, degraded };
}

// P0.4: a cycle that ran past its budget was abandoned, not broken. It gets its own journal type, its
// own counter and its own health treatment, so a slow provider cannot masquerade as an engine error -
// while repeated aborts still degrade, because either way the engine is not scanning.
export function recordCycleBudgetAbort({ error, stage = null, budgetMs = null, now = Date.now(), degradeAfter = cfg.cycleErrorDegradeAfter, load = loadState, save = saveState, journal = appendJournal } = {}) {
  const text = compactError(error);
  const where = stage || error?.stage || 'cycle';
  const limit = budgetMs ?? error?.budgetMs ?? cfg.cycleBudgetMs;
  const journaled = safeJournal(journal, { type: 'cycle-budget', error: text, stage: where, budgetMs: limit, elapsedMs: error?.elapsedMs ?? null, at: now });

  let s = null;
  try { s = load(); }
  catch (loadError) {
    const failure = { stage: 'load', at: now, code: codeOf(loadError), message: compactError(loadError), cycleError: text };
    safeJournal(journal, { type: 'error-persist-failed', ...failure });
    saveFailure = failure;
    return { journaled, persisted: false, saveFailed: true, stage: 'load', message: text, failure };
  }

  s.stats ||= {};
  s.system ||= {};
  const previous = s.system.cycleBudget || {};
  const abortStreak = Number(previous.abortStreak || 0) + 1;
  s.system.cycleBudget = {
    aborts: Number(previous.aborts || 0) + 1, abortStreak, budgetMs: limit,
    lastAbortAt: now, lastStage: where, lastElapsedMs: error?.elapsedMs ?? null, lastError: text,
  };
  s.system.lastError = text;
  s.system.lastErrorAt = now;

  const degraded = abortStreak >= degradeAfter;
  s.system.diagnostics ||= [];
  const existing = s.system.diagnostics.find(d => d?.code === CYCLE_BUDGET_CODE);
  const diagnostic = { level: degraded ? 'ERROR' : 'WARN', code: CYCLE_BUDGET_CODE, message: `${abortStreak} cycle(s) abandoned at ${where}: ${text}` };
  if (existing) Object.assign(existing, diagnostic);
  else s.system.diagnostics.push(diagnostic);
  s.system.health = healthFromDiagnostics(s.system.diagnostics);

  try { save(s); }
  catch (saveError) {
    const failure = { stage: 'save', at: now, code: codeOf(saveError), message: compactError(saveError), cycleError: text, aborts: s.system.cycleBudget.aborts };
    safeJournal(journal, { type: 'error-persist-failed', ...failure });
    saveFailure = failure;
    return { journaled, persisted: false, saveFailed: true, stage: 'save', message: text, aborts: s.system.cycleBudget.aborts, abortStreak, degraded, failure };
  }

  saveFailure = null;
  return { journaled, persisted: true, saveFailed: false, message: text, aborts: s.system.cycleBudget.aborts, abortStreak, degraded };
}

// A cycle that finished without throwing resets the streak, which is what un-degrades the engine.
// The caller already has the state in hand (index.js loads it right after the cycle), so this costs
// no extra read, and it writes nothing unless a streak is actually set.
export function markCleanCycle({ state = null, load = loadState, save = saveState, now = Date.now() } = {}) {
  let s = state;
  try { s ||= load(); }
  catch { return { changed: false, cleared: false, consecutive: 0 }; }
  const previous = Number(s?.system?.cycleErrors?.consecutive || 0);
  const abortStreak = Number(s?.system?.cycleBudget?.abortStreak || 0);
  if (!previous && !abortStreak) return { changed: false, cleared: false, consecutive: 0 };
  s.system.cycleErrors = { ...s.system.cycleErrors, consecutive: 0, clearedAt: now };
  if (s.system.cycleBudget) s.system.cycleBudget = { ...s.system.cycleBudget, abortStreak: 0, clearedAt: now };
  s.system.diagnostics = (s.system.diagnostics || []).filter(d => d?.code !== CYCLE_ERROR_CODE && d?.code !== CYCLE_BUDGET_CODE);
  // Only the streak's own degradation is cleared: any other ERROR diagnostic keeps the engine DEGRADED.
  if (s.system.health === 'DEGRADED') s.system.health = healthFromDiagnostics(s.system.diagnostics);
  try { save(s); }
  catch (saveError) {
    return { changed: true, cleared: false, consecutive: previous, clearedStreak: true, saveFailed: true, message: compactError(saveError) };
  }
  return { changed: true, cleared: true, consecutive: 0, previous, health: s.system.health };
}

// Called after a cycle that did not throw. Kept here so /api/health has one place to ask.
export function cycleErrorStreak(state) {
  return Number(state?.system?.cycleErrors?.consecutive || 0);
}

export function resetRecoverySaveFailure() { saveFailure = null; }

// Live view for /api/health: memory plus the journal tail, so a refused save is visible even
// after a restart (the journal row outlives the process that could not persist the counter).
// Pass the state in and it also reports the streak that /api/health turns into ok: false.
export function cycleRecoveryView({ state = null, degradeAfter = cfg.cycleErrorDegradeAfter, journal = readJournal, limit = 200, now = Date.now(), windowMs = 10 * 60_000 } = {}) {
  let rows = [];
  try { rows = journal(limit) || []; } catch { rows = []; }
  const recent = rows.filter(row => ERROR_TYPES.has(row?.type) && now - Number(row?.ts || 0) <= windowMs);
  const consecutive = cycleErrorStreak(state);
  const health = state?.system?.health || null;
  return {
    ok: !saveFailure,
    saveFailed: !!saveFailure,
    lastSaveFailure: saveFailure,
    pendingErrorRows: recent.length,
    lastErrorRow: recent.length ? recent[recent.length - 1] : null,
    health: health || 'UNKNOWN',
    consecutive,
    degradeAfter,
    // P0.4: aborts are counted apart from errors - a cycle abandoned at its budget is not a crash.
    aborts: Number(state?.system?.cycleBudget?.aborts || 0),
    abortStreak: Number(state?.system?.cycleBudget?.abortStreak || 0),
    lastAbort: state?.system?.cycleBudget || null,
    lastError: state?.system?.lastError || null,
    lastErrorAt: state?.system?.lastErrorAt || null,
    // What /api/health's own ok:false is about, stated once so the HUD does not have to infer it.
    degraded: health === 'DEGRADED' || consecutive >= degradeAfter,
  };
}
