# PROGRESS — Money-Printer-OS remediation pass

Format: `P<n>.<m> — done|partial|blocked — <sha> — <note>` (one line per item).
The `<sha>` column is deliberately empty: each item's commit subject is the key
(`P0.1: …`, `P0.2: …`), and `git log --oneline main` resolves them. A commit cannot print its own
hash, and a ledger that guesses one is worse than one that points at `git log`.
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
P0.5 — done — — documented panic path
      `docs/RUNBOOK-PANIC.md`: the kill switch is documented as an *entry* gate (not a stop button),
      the process stop paths (desktop supervisor stdin, SIGINT/SIGTERM → `shutdown()` → exit 0), how
      to read `/api/health` during an incident (every field of P0.1–P0.4 plus `ok`/`health`/
      `lastCycle`/`diagnostics`), what a refused save leaves behind versus backup recovery versus
      `STATE_RECOVERY_REQUIRED` (exit 1), the reset/clear-error actions, the switches, and the exit
      codes. `tests/panic-runbook.test.mjs` is a drift test: it fails if the runbook names an
      endpoint, action, diagnostic code, journal row, exit code or default that the source no longer
      has (it already caught two of my own doc gaps). Wired into `test:unattended` (16 pass).
      README "More" now links both the runbook and this ledger.

## P0 status: complete (P0.1–P0.5)

All five items are done, one commit each, on top of `5ff94a0` (verification) — `d034c69`, `d3cf886`,
`7f141ef`, `dc30bfa`, and the P0.5 commit. Verified per item by the targets named above plus a real
one-cycle run (`--once`, temp data dir, paper mode): exit 0, `HEALTHY`, 0 errors, 0 aborts,
`budgetRejects` 0, fan-out 3 batches instead of 32.

Two things to know before P1:

- **V7 was disproven**, so P1.3's premise changes: `tradeSizeSol` — not `riskPerTradePct` — is the
  binding constraint at the default profile. The fix (a sizing readout) is still worth doing; the
  *comment* must state the measured truth.
- **The `test:all` baseline still fails on `test:robinhood`** (pre-existing, `sync-robinhood-panel
  --check` cannot find the panel markers in `public/dashboard.html`), which skips the five targets
  chained after it. P1.4 is the item that addresses test wiring; it should either fix the panel
  markers or make that target's failure not hide the rest.

## Regression sweep after P0.5 (every target, this machine)

All green except the one pre-existing failure, which reports the *same* error as the pre-P0 baseline
(`Error: Robinhood panel boundaries not found`), so it is not a regression:

| Target | Result | Target | Result |
|---|---|---|---|
| test:recovery | 40 pass | test:research | 46 pass |
| test:discovery | 7 pass | test:evidence | 60 pass |
| test:solana | 28 pass | test:poly-research-eval | 14 pass |
| test:turnover | 8 pass | test:visual | 66 pass |
| test:updater | 24 pass | test:release-gate | 7 pass |
| test:execution | 11 pass | test:latency | 7 pass |
| test:unit-economics | 14 pass | **test:robinhood** | **exit 1 — pre-existing** |
| test:product-economics | 13 pass | test:robinhood-equities | 15 pass |
| test:settlement | 18 pass | test:lane-contracts | 90 pass |
| test:polymarket-us | 18 pass | test:fitness | 22 pass |
| test:combos | 73 pass | test:unattended | 16 pass |
| test:edge-robustness | 5 pass | test:upgrade | 21 pass |
| test:accounting | 13 pass | test:evolution | 15 pass |
| test:replay | 24 pass | test:lab-link | 28 pass |
| test:experiments | 9 pass | | |

P1.1 — done — — reconciliation of the legacy float books vs the core ledger + claim refusal
      `src/core/bookReconcile.js` (new): one verdict per book, per currency — cash (the mirror's own
      verdict, authoritative), open cost basis, open position count, realized and fees — with a
      tolerance of one 6-dp rounding step per compared row. `coverage.legacyBooks` in
      `platform.snapshot()` was a literal string (`MIRRORED_AND_RECONCILED_WHERE_POSSIBLE`); it is now
      derived, and a book that disagrees makes the platform publish
      `MIRRORED_WITH_UNRECONCILED_DIFFERENCE` and name the fields it disagrees on
      (`coverage.legacyReconcile.{promotionAllowed,checked,refused,unverified}`, `legacy.reconciliation`).
      Nothing is repaired to make it pass: the re-sync of a book that went backwards appends no entry.
      Cash alone was the gap (a book whose basis, count, realized or fees drifted still showed the same
      cash). The like-for-like expectations were verified against the mirror's own arithmetic rather
      than assumed: `solanaPlan` grosses a sell's proceeds up by its fees and books the fees separately,
      so the ledger's realized is (history pnl + open-position realized) and its fee total spans open
      and closed trades — `legacyBooks.js` now exposes exactly those two fields (`openRealized`,
      `fees`) instead of applying a fudge factor. The module also refuses to compare across books
      (currency or venue), which is the mistake it exists to prevent.
      Tests: `tests/book-reconcile.test.mjs` (6 tests) added to `test:lane-contracts` — 96 pass.
      Honesty note: on real data the derived claim can refuse where the old literal could not; the
      `refused` entry names the source and the fields, which is the P1.1 (V5) point.
P1.2 — done — — /api/state split: persisted state with an honest ETag, live readings in /api/telemetry
      `src/store.js`: `researchStamp()` + `stateSourcesStamp()` cover state.json **and**
      research-state.json, because `loadState()` merges the latter — a state.json-only stamp changes
      while the state it describes does not, and misses a research write. `loadStateCached()` caches on
      that same pair now, so the reader cannot hand back a state that predates a research write.
      `src/dashboard.js`: the snapshot carries persisted state only (`system.metrics` is persisted
      metrics, `system.resources` / `walletIntel.holderRpc` / `walletIntel.scorecard` are null, each
      with a comment saying where it went). `/api/state` tags on the state sources plus every file in
      `controlPlaneFiles` (the one list that owns those files, so adding one extends the tag), keeps
      the serialized payload under that tag and answers 304 on a matching If-None-Match — no rebuild
      and no serialization, which is the CPU the audit measured. The per-second timestamp is gone from
      the tag. `/api/telemetry` serves the live half (`no-store`, no ETag).
      HUD: `/api/state` is fetched with `cache:'no-cache'` (no-store would forbid the 304 now on
      offer), `/api/telemetry` is merged on top, a telemetry failure keeps the last readings and says
      `LIVE READINGS STALE` in the banner; `perf.stateCache` exposes HIT/MISS.
      Docs: RUNBOOK-UNATTENDED (endpoint table), RUNBOOK-PANIC (304 + where live readings went),
      EVOLUTION_LAB_SPLIT. Tests: `tests/api-state-split.test.mjs` (5 tests) in `test:visual` —
      71 pass — including that a research-state.json write alone invalidates the tag (the case the old
      stamp served stale) and that `/api/health` keeps the live sample it always had.
P1.3 — done — — sizing dial readout (V7 premise corrected by measurement)
      `src/positionExecution.js`: `sizingReadout()` — every dial (trade size, risk per trade, position
      cap, exposure headroom), which of them bound the size, the risk-versus-aggression growth rates,
      and the equity at which risk sizing takes over (`crossoverEquitySol`, null when the aggression
      ramp always sizes smaller). It wraps `entrySizing` and changes no number: the same call, the same
      size. The comment states the measured fact, not the audit's premise: at 1 SOL equity with the
      default profile `riskPerTradePct` 1 / stop 8 allows 0.125 SOL while the trade size dial asks for
      max(0.05 × sizeFactor, 0.012 + aggression/1800) = 0.052 SOL, so **`tradeSizeSol` is the binding
      dial** and `riskPerTradePct` becomes the structural limit only below 0.4 SOL of equity.
      Surfaced as `effectiveControls.sizing` in `/api/state` and as a *Trade size* row (with the binding
      dial, full statement in the tooltip) in the HUD's "Effective right now" panel.
      Tests: `tests/accounting-integrity.test.mjs` asserts the default-profile numbers (0.125 / 0.052 /
      crossover 0.4), the inversion below the crossover (0.3 SOL → 0.0375 SOL), the limp-ramp and SPRINT
      cases, live sizing (flat target, no mark), and that the snapshot publishes the readout —
      `test:accounting` 14 pass, `test:visual` 71, `test:lane-contracts` 96.
P1.4 — done — — test hygiene: the suite actually runs now (the P0 blocker is fixed, not bypassed)
      Root cause of the P0-discovered failure: `scripts/sync-robinhood-panel.mjs --check` searched for
      `// BEGIN ROBINHOOD PAPER PANEL\n`, so a CRLF checkout (`core.autocrlf=true` here) reported
      "boundaries not found" for a panel that was embedded and byte-identical — the panel was never
      missing. Because `test:all` chains with `&&`, that threw away `test:robinhood`,
      `test:robinhood-equities`, `test:lane-contracts`, `test:fitness`, `test:unattended` and
      `test:upgrade`. The gate now matches and compares on LF-normalized text and writes back the file's
      own EOL.
      The same LF assumption hid **two real failures** in `tests/robinhood-http.test.mjs` and
      `tests/robinhood-hud.test.mjs` (`html.split('// BEGIN …\n')[1]` → `TypeError: … reading 'split'`
      on undefined); both normalize at the read boundary now and pass.
      Two suites had never been wired into any target: `tests/paper-trading-core.test.mjs` →
      `test:lane-contracts`, `tests/pump-paper-shared.test.mjs` → `test:execution` (both passed on the
      first run, so they were pure coverage loss).
      New drift test `tests/test-wiring.test.mjs` (`test:wiring`, first step of `test:all`): every
      `tests/*.test.*` on disk must be reachable from `test:all` through the `npm run` chain, every path
      a script names must exist, no target may name a file twice, the panel gate must normalize line
      endings — and it prints the coverage map (99 suites across 31 targets) as telemetry.
      `npm run test:all` is green end to end for the first time: **30 targets, 946 tests, 0 failures**
      (`test:robinhood` alone is 207).
P1.5 — done — — rejected-by-band counter in the funnel (V8 made observable, not changed)
      `src/positionExecution.js`: `emptyPriceReviewTally()` + `tallyPriceReview()` count every position
      price review — accepted/rejected per reason, plus `bandRejects` with the min/max
      `bandMedianRatio` seen and `lastBandAt`. Purely additive: `reviewPositionPrice` is untouched, so
      the band is exactly as asymmetric as V8 found it.
      `src/index.js`: the cycle creates one tally, passes it into `updatePositions(s, reviewTally)`
      (tallied beside the existing per-position `priceStatus` and journal writes, one call site) and
      publishes it as `system.opportunityFunnel.priceReviews`, so it lands in `funnelHistory` as well.
      HUD: the Pump.fun glance foot shows `price rejects N · band M` when anything was rejected.
      The counter is a measurement, not a fix: the minimum `bandMedianRatio` it can ever record stays
      above `TICK_BAND_MAX_RATIO`, which is the observable proof that the band never rejects downward;
      making it two-sided is a later decision with its own evidence.
      Tests: `tests/execution-turnover.test.mjs` — a band rejection is counted with its ratio, a crash far
      below the median is *not* counted as a band rejection but is counted by reason, accepted and stale
      reviews land in the same tally, a missing tally is created rather than thrown on, and the
      engine/HUD wiring is asserted (16 pass). One-cycle engine run: exit 0, HEALTHY, 0 errors, funnel
      carries `priceReviews`.
P2.1 — pending — — research-state.json backup/validate parity or documented asymmetry
P2.2 — pending — — async batched journal appends (state.json semantics byte-for-byte)
P2.3 — pending — — split robinhoodAutoTrader.js by seam (behavior-preserving)
P2.4 — pending — — split core/platform.js by seam if clean, else skip + note
P3.1 — pending — — recompress public logo PNG → webp if no code path needs PNG
P3.2 — pending — — stateVersion field + migration stub
P3.3 — pending — — npm audit in CI as non-blocking telemetry
P3.4 — pending — — review @anthropic-ai/sdk (aiSummary) off the cycle hot path
