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
      (`test:robinhood` alone is 207; 947 after P1.5 adds its own test).
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

## P1 status: complete (P1.1–P1.5)

Done, one commit each, on top of the P0 workstream (`a01f6b7`, `133f05a`, `758d459`, `0f504e4`,
`831058d`). Not one of the five changed a money-moving number by accident: P1.1 derives a claim that
was a literal, P1.2 moves live samples off a cached endpoint, P1.3 adds a readout over the existing
sizing arithmetic, P1.4 fixes test wiring, P1.5 counts what was already happening.

Three things a reader of the audit should know:

- **V7 was inverted, and P1.3 says so in the code**: at the default profile `tradeSizeSol` binds
  (0.052 SOL) while `riskPerTradePct` would allow 0.125 SOL, and risk sizing only takes over below
  0.4 SOL of equity. The readout reports the crossover for whatever profile is running, so the same
  statement stays true when the profile changes (SPRINT: it never takes over).
- **P1.1 can refuse a claim the platform used to make unconditionally.** `coverage.legacyBooks` was the
  literal `MIRRORED_AND_RECONCILED_WHERE_POSSIBLE`; it is now derived from a five-field comparison per
  book and flips to `MIRRORED_WITH_UNRECONCILED_DIFFERENCE` with the disagreeing fields named when the
  mirror and the book disagree. On real data that can happen; it is not a regression, it is the item.
- **P1.4's root cause was a line ending, not a missing panel.** `sync-robinhood-panel.mjs --check`
  searched for a marker with `\n` in a CRLF checkout, so `test:all` (which chains with `&&`) silently
  skipped six targets and hid two real failures plus two suites that no target ran at all.

Regression sweep after P1.5 (`npm run test:all`, exit 0, this machine — every target, none skipped):

| Target | Result | Target | Result |
|---|---|---|---|
| test:wiring | 4 pass | test:research | 46 pass |
| test:recovery | 40 pass | test:evidence | 60 pass |
| test:discovery | 7 pass | test:poly-research-eval | 14 pass |
| test:solana | 28 pass | test:evolution | 15 pass |
| test:turnover | 8 pass | test:lab-link | 28 pass |
| test:updater | 24 pass | test:visual | 71 pass |
| test:execution | 16 pass | test:release-gate | 7 pass |
| test:unit-economics | 14 pass | test:latency | 7 pass |
| test:product-economics | 13 pass | test:robinhood | 207 pass |
| test:settlement | 18 pass | test:robinhood-equities | 15 pass |
| test:polymarket-us | 18 pass | test:lane-contracts | 103 pass |
| test:combos | 73 pass | test:fitness | 22 pass |
| test:edge-robustness | 5 pass | test:unattended | 16 pass |
| test:accounting | 14 pass | test:upgrade | 21 pass |
| test:replay | 24 pass | test:experiments | 9 pass |

**30 targets, 947 tests, 0 failures.** Before P1.4 the same command died at `test:robinhood` and the
five targets after it never ran.

## P2 status: 3 of 4 done (P2.1, P2.2, P2.3)

P2.1 — done — — research-state.json backup/validate parity, with the one asymmetry documented
      Measured first, on a temp data dir: `state.json` listing `research.externalized`, the sections in
      `research-state.json`, the file on disk torn. `loadState()` came back with `learner.outcomes []`
      and `universe {}` and **no marker anywhere**, and the next `saveState()` published those
      rebuilt-empty sections over the only copy of the dataset — no `research-state.backup.json`
      existed. That is silent data loss, not an asymmetry worth documenting.
      `src/store.js`: `validateResearch()` + `RESEARCH_SECTIONS` (the container each reader expects,
      with a drift test against `RESEARCH_HEAVY`), `readResearchFile()`, a
      `research-state.backup.json` published from validated bytes at the same bound as the account
      (`STATE_BACKUP_MS`, now one shared constant), and `externalizeResearch()` refusing publication
      while the file on disk cannot be read back — the sections then travel inline in `state.json`
      (no `research.externalized`) rather than replacing the last copy. The read-back check is cached
      per file stamp, so it costs one read per version of the file, not one per cycle.
      The asymmetry that remains is deliberate: a damaged account file pauses trading (`paused`,
      `killSwitch`, `system.recovery`), a damaged research file does not — research is not money. It is
      marked instead (`system.researchRecovery`: `RESEARCH_UNREADABLE` / `RESEARCH_BACKUP_RECOVERED` /
      `RESEARCH_UNPUBLISHABLE`, durable until a human clears it), refused rather than overwritten, and
      `doctor` prints it.
      `src/learner.js`: one real escalation found by the new tests — `learner: {}` (a section that
      parses, is correctly typed, and is empty) threw inside `ensureLearner`, so `loadState()` read a
      *research* problem as an unreadable *account* and paused trading on the backup path. Guarded.
      Tests: `tests/store-recovery.test.mjs`, 8 new (48 pass in `test:recovery`): the section map and
      backup bound cannot drift, a torn file is reported and left in place, a file that parses but is
      the wrong shape counts as damaged, a valid backup recovers and repairs it, sections that would
      not read back are refused, the preceding publication is the backup and an unreadable primary
      never becomes it, repair resumes publication, and the account-vs-research asymmetry in one
      assertion.
P2.2 — done — — journal appends measured (2 per cycle, ~1 ms) — the async-batched change declined on evidence
      Measured first, on a temp data dir with one real paper cycle (`node src/index.js --once`, default
      profile): the cycle appends **twice** — one `appendJournalBatch` carrying the whole cycle volume
      (30 scan-candidate rows + the scan-summary) and one `appendJournal` per event (that cycle: `trade-open`)
      — 28,529 bytes / 32 rows / ~1 ms of a 4,575 ms cycle (0.02%; `riskMs` 4,311 was 94% of it,
      `discoveryMs` 185, `saveMs` < 1). The micro-measurement explains the shape: one append
      (open+write+close) costs 0.29–0.37 ms, so the same rows appended one at a time cost ~70x the batch —
      and no code path does that. The 30 scan rows are one array handed to one call (`src/index.js:658–671`)
      and all 24 other call sites in the engine are per event, none inside a per-row loop (the Polymarket
      autopilot's `noteAuto` collapses identical consecutive skips and runs a few times per run).
      So the item's premise — per-row synchronous appends on the cycle path — is **false for the real
      volume**, and no source changed: the measurement is the deliverable. What the audit objected to about
      the journal is its *footprint* (~98% scan-candidate bytes, ~1 GB/day measured on the research machine),
      which rotation (3 × 128 MB) and `MPO_JOURNAL_SCAN_CANDIDATES=false` already bound — not append
      latency. Making the path async would trade that 1 ms for the one durability property P0.1 rests on
      (the row is on disk before the state save, so a cycle that dies mid-flight is still readable from the
      journal), which is the wrong trade at 0.02%.
      The item's own acceptance criterion is executable instead — `tests/journal-append-contract.test.mjs`,
      6 tests, `test:recovery` 48 → 54: the cycle volume is one append for 30 rows and one per event
      (syscall-counted, `fs.appendFileSync` patched — Node implements `appendFileSync` over `writeFileSync`,
      so the counter does not double-count the internal write); a batch writes byte-for-byte the bytes a run
      of single appends writes, with `ts` stamped once per row and a caller's `ts` never rewritten; journal
      activity cannot change `state.json` (no write/append/rename targets it during a 33-row burst, its bytes
      are unchanged, and a save after the burst is byte-identical to one before it — `saveMs` aside, the
      previous save's measured duration by design); per-row appends cost an order of magnitude more than the
      batch (relative bound, holds on a slow disk: 1000 rows, 1.6 ms batched vs 608 ms per-row, 388x, printed
      as telemetry); and the engine batches the cycle volume while appending one row per event (source-level
      wiring in the style of `cycle-budget.test.mjs`, verified by mutation: replacing the batch with a per-row
      loop fails the wiring test, and adding a field to the batched row shape fails both byte-equivalence
      tests).
      Regression sweep after P2.2: `npm run test:all` exit 0 — 30 targets, 961 pass, 0 fail, nothing skipped
      (per-target identical to the P2.1 baseline's 955 apart from `test:recovery`).
P2.3 — done — — split robinhoodAutoTrader.js by seam: 922 lines → 709 + 243 + 35, export surface byte-identical
      The split is the deliverable here (nothing to measure first), and what was extraction-safe was decided by
      *state*, not by topic: a module may move only if it owns no live loop state and no real order path. Two new
      modules resulted, both paper-only and both pure over the paper journal, the tape and the Lab/evolve files.
      `src/robinhoodPolicy.js` (35 lines) — the state-free primitives the loop and the Lab both need: the tick clock
      (`TICK_MS`, the injectable `now()` / `setRobinhoodClock`), the symbol grammar and universe, the §21 primary
      symbol weight/multiplier/order-cap policy, `robinhoodLimits`, `paper()`, `fresh()`, `safeMessage()`, the
      data-dir constants (`DATA_DIR` / `USER_ROOT` / `ENV_FILE`). Its only module state is the injected clock, which
      the loop still publishes unchanged as `__testing.setClock`.
      `src/robinhoodLab.js` (243 lines) — the §22 evolution policy and the §23a Lab paper trials: the proposal/pass/
      apply path, the trial ledger, the evolve view, `robinhoodFitnessParts`, the cached 7-day vol gate and the
      7-day quote-source cost evidence, the Lab status/champion link.
      `src/robinhoodAutoTrader.js` (709 lines, was 922 — 22 insertions / 235 deletions) — everything that owns live
      loop state or a real order path: the quote feed, the snapshot, qualification, the paper/real autopilot, the
      HTTP surface, the timers, the daily book.
      The seam is an injected-deps object, never an import back: the Lab cores take
      `d = { quotes, fee, note, applyPaperParams, realAutopilot }` *after* their own parameters and *before* any
      optional flag (`robinhoodVolGate(p,d,{force})`), and the loop's exported wrappers (`robinhoodVolGate`,
      `robinhoodFitnessParts`, `robinhoodEvolveView`, `runRobinhoodEvolveOnce`, `applyRobinhoodEvolution`,
      `labProposalPass`) keep their old signatures by closing over `labDeps()`. So the venue stays acyclic (the Lab
      never imports the loop), the policies stay testable without it, and callers see no change: the 10 names the loop
      re-exports (4 policy, 6 Lab) keep the same require surface.
      Verification, on the committed tree plus these edits: importing the previous revision and the new one side by
      side lists the **same 49 exported names, none added and none lost** (A/B probe, exit 0, empty diff both ways);
      `node scripts/sync-robinhood-panel.mjs --check` is clean and all three files are pure CRLF like the rest of
      `src/`. `tests/robinhood-evidence.test.mjs` is the one test that had to become seam-aware — it asserts wiring by
      reading source text, so the three moved substrings (`realisticSpreads(T.loadTape(s,since)`,
      `volGate:robinhoodVolGate(p,d)` ×2, now each fed the deps the loop injects, and `tapeDays,synthetic,`) are
      asserted against `src/robinhoodLab.js`, and the seam itself is asserted against the loop: the exported wrapper
      is still `(p=paper(),options)=>labVolGate(p,labDeps(),options)`, so `/api/robinhood` keeps serving the gate and
      its `?force` option. `tests/visual-contract.test.mjs` (and the panel gate) target loop-resident text and needed
      no change; the Lab-trial suite (`tests/robinhood-lab-trial.test.mjs`, 22 pass in `test:fitness`) drives the new
      module through the loop's wrappers and needed no change either.
      One defect introduced by the first cut of the split, caught by the suite before it could ship: the moved gate had
      taken the deps in the optional-flag slot, so the loop's `?force` refresh handed `{force:true}` where the Lab core
      expected deps and the gate failed at call time. Deps moved after the core's own parameters
      (`robinhoodVolGate(p=paper(),d,{force=false}={})`) and the wrapper is back to `labVolGate(p,labDeps(),options)`.
      Regression sweep after P2.3: `npm run test:all` exit 0 — 30 targets, 961 pass, 0 fail, every target ran
      (963 tests, of which the only two not passing are the standing `# SKIP` integration placeholders — the Jupiter
      sibling-freeze pair in `test:robinhood-equities` and the trader→Lab Kalshi handoff in `test:upgrade` — both
      untouched by this change; counts otherwise identical to the P2.2 baseline).
P2.4 — pending — — split core/platform.js by seam if clean, else skip + note
P3.1 — pending — — recompress public logo PNG → webp if no code path needs PNG
P3.2 — pending — — stateVersion field + migration stub
P3.3 — pending — — npm audit in CI as non-blocking telemetry
P3.4 — pending — — review @anthropic-ai/sdk (aiSummary) off the cycle hot path
