# PROGRESS — Money-Printer-OS remediation pass

Format: `P<n>.<m> — done|partial|blocked — <sha> — <note>` (one line per item).
Mode: **paper-only**. Live gates untouched. `src/executionSim.js` never modified.

## Baseline (before any change)

- HEAD `416ded8` (tag `v0.5.0-alpha.71`), clean tree except untracked `AUDIT.md`.
- `npm ci` run in this pass (node_modules was absent → every test failed at import).
- Full suite `npm run test:all` fails at **one** pre-existing target: `test:robinhood`
  → its first step `node scripts/sync-robinhood-panel.mjs --check` throws
  `Error: Robinhood panel boundaries not found` (`scripts/sync-robinhood-panel.mjs`, `indexOf('// BEGIN ROBINHOOD PAPER PANEL') < 0`).
  Because `test:all` chains with `&&`, `test:robinhood-equities`, `test:lane-contracts`,
  `test:fitness`, `test:unattended`, `test:upgrade` do **not** run in a plain `test:all` run.
  All other targets reached report `fail 0`.
- Baseline evidence log: `%TEMP%\mpo-baseline.log` (this machine).

## VERIFY-FIRST verdicts (details + evidence in AUDIT.md § Verifications)

- V1 saveState-in-catch crash + lost error counter — CONFIRMED
- V2 discovery fan-out over rate cap — CONFIRMED (cap is per host, 60 s window)
- V3 Solana kill switch gates entries only — CONFIRMED
- V4 no per-cycle abort signal — CONFIRMED
- V5 legacy float book vs core BigInt ledger not reconciled — CONFIRMED (legacyBooks.js reports side-by-side, never sums)
- V6 `/api/state` ETag volatile by design — CONFIRMED
- V7 "tradeSizeSol is not binding" — **DISPROVEN** (tradeSizeSol *is* binding at defaults; riskPerTradePct binds only below ≈0.4 SOL equity)
- V8 tick band one-sided, ratio 5 — CONFIRMED

## Items

P0.1 — done — — cycle catch-path crash + lost error counter
      `src/cycleRecovery.js` (new): journal row first, then state.json best effort, then an in-memory flag.
      `index.js` catch no longer calls `saveState` unguarded, so a refused save can no longer end the loop.
      `/api/health` exposes `cycleRecovery`. Tests: `tests/cycle-recovery.test.mjs` (+ helper
      `tests/helpers/cycle-error-crash.mjs`) added to `test:recovery` — 27 pass, including a SIGKILL
      mid-save-loop case that proves state.json is never torn and the journal row survives the restart.
      Fixed while writing it: `now = Date.now` (function, not timestamp) made timestamps vanish from
      journal rows via `JSON.stringify`.
P0.2 — done — — /api/health escalation after N consecutive cycle errors
      `CYCLE_ERROR_DEGRADE_AFTER` (default 3) in config; `recordCycleError` pushes a level `ERROR`
      diagnostic `CYCLE_ERROR_STREAK` at the threshold, which is the input supervisorTick already
      derives `DEGRADED` from, and `/api/health` now reports health/streak/lastError/degraded under
      `cycleRecovery`. `markCleanCycle({state})` resets the streak on the first cycle that does not
      throw — reusing the state the loop already loads, and writing nothing when no streak is set.
      4 tests added; `test:recovery` 31 pass.
P0.3 — done — — discovery rate budget reconciliation
      `discoveryBatchBudget`/`discoveryAddressLimit` size the fan-out from the per-cycle share of
      `MARKET_REQUESTS_PER_MINUTE` and what the window has already spent; `marketRequests.health()`
      now reports per-host `windowCalls`; `discoveryFanout()` exposes what was allowed. The funnel
      gets `s.system.marketBudget` (incl. `rejectsDelta`) and a `MARKET_BUDGET_REJECTED` WARN, and
      `/api/health` reports `marketRequests` + `marketBudget`. Default fan-out drops from 32 batches
      (960 addresses, 240 req/min against a 120 budget) to 8 (240 addresses) — the honest maximum;
      more breadth now requires raising `MARKET_REQUESTS_PER_MINUTE`, which is the documented lever.
      New target `test:discovery` (7 pass) wired into `test:all`; the simulation reproduces the old
      overrun so the fix cannot silently regress.
P0.4 — done — — per-cycle abort signal
      `CYCLE_BUDGET_MS` (default 45000) + `src/cycleBudget.js`: each loop iteration builds a budget
      whose `AbortSignal` reaches every dex/gecko read through `dexscreener.setCycleSignal` and the
      new `signal` option on `marketRequests.get` (a caller abort is a cancellation, not a provider
      timeout, so it does not inflate `timeouts`/`failures`). `cycle(budget)` asserts the deadline at
      five phase boundaries; the loop records an abandoned cycle with its own journal type
      (`cycle-budget`), counter and health treatment, degrades only on a *streak*, and clears on a
      clean cycle; `shutdown()` aborts the live budget so a fetch cannot hold the process open.
      Live smoke: one real cycle (`--once`, temp data dir) → exit 0, health HEALTHY, 0 errors, no
      aborts; `fanoutBatches` 3 vs the old 32 and `budgetRejects` 0 (see below).
P0.5 — pending — — documented panic path
P1.1 — pending — — reconciliation check (legacy float vs core ledger) + promotion refusal
P1.2 — pending — — split /api/state (keep ETag pure state, add /api/telemetry)
P1.3 — pending — — sizing dial readout (premise corrected by V7)
P1.4 — pending — — test hygiene (`npm test`, wire 2 suites, skip-safe visual test, coverage telemetry)
P1.5 — pending — — rejected-by-band counter in the funnel
P2.1 — pending — — research-state.json backup/validate parity or documented asymmetry
P2.2 — pending — — async batched journal appends (state.json semantics byte-for-byte)
P2.3 — pending — — split robinhoodAutoTrader.js by seam (behavior-preserving)
P2.4 — pending — — split core/platform.js by seam if clean, else skip + note
P3.1 — pending — — recompress public logo PNG → webp if no code path needs PNG
P3.2 — pending — — stateVersion field + migration stub
P3.3 — pending — — npm audit in CI as non-blocking telemetry
P3.4 — pending — — review @anthropic-ai/sdk (aiSummary) off the cycle hot path
