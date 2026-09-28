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

## P2 status: complete (P2.1–P2.4; P2.4 measured and skipped, see its ledger entry)

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
P2.4 — skipped on measurement — — split core/platform.js by seam: no clean seam (597 lines, 71,350 bytes, 53 members)
      Measured first, with a member/field parser over the file and a call probe over `src/`, against the rule P2.3
      used: a module may move only if it owns no live loop state and no real order path, and only behind an
      injected-deps seam, so callers see no change. `core/platform.js` turns out to be a *facade*, not a tangle:
      `store` is read by 33 of its 53 members, `bus` and `providers` by 11, `ledger` and `dataDir` by 10,
      `legacyReaders` by 9. 43 of the 53 are called from `src/` outside the class — `src/core/http.js`, the
      `/api/platform/*` dispatcher, reaches all of them except `publishPredictionHandoff` and `setLegacyReaders`
      (wired from `dashboard.js:448,458`), `src/scoreboard.js` drives the same instance — and 37 members have no
      internal caller at all. The file's size is the breadth of a public surface, so any split has to be judged by
      what it actually de-couples, not by the line count.
      The money-adjacent part cannot move at all: `src/core/brokers.js` and `src/core/paperTrading.js` hold the
      platform and re-enter it as fields and calls (`platform.store` ×6, `platform.risk` ×6, `platform.strategies`
      ×3, `platform.deposit` ×2, `platform.executePaper` ×2, plus `.ledger`, `.propose`, `.snapshot`), i.e. the paper
      order path runs *through* those fields; a seam there would change callers by definition.
      Sized by cluster: trading core (book/propose/execute/pairs) 120 lines/22 %, Market Lab + prediction 88/14 %,
      legacy accounting + strategies 77/11 %, stocks adapters 15/2 %, diagnostics + close 38/7 %, research/event
      pages 219/**40 %**. The 40 % cluster is the one worth moving and the one the rule forbids: it owns six mutable
      caches (`macroCache`, `weatherCache`, `sportsCache`, `wireFeeds`, `whaleSeenTs`, `eventsCache`) whose ages
      `diagnostics` reports, and its fetchers are per-instance injection points that *tests* assign —
      `p.macroPaceMs=0` (tests/market-core.test.mjs:541,582), `p.sportsFetch=…` (:588), `p.wireFetch=…` (:617),
      `p.edgar={…}` + `p.summarize=…` (:796). `strategies` has to stay a field regardless, whatever is extracted
      (`platform.strategies`, src/core/http.js:20,21,54; `p.strategies.register/transition/history`,
      tests/market-core.test.mjs:699,704). Extracting that cluster means moving the caches' owner and rewriting the
      tests' injection points — a refactor of the injection contract, not a seam.
      The one cluster that does pass the rule is Market Lab + prediction: 88 lines / 9,991 bytes (14.0 %), owning its
      own state (`replays`, `labPool`, touched nowhere outside the class), needing only `{store, dataDir, strategies}`
      as deps, holding no order path, and acyclic (platform → platformLab → replay.js / labWorker.js /
      predictionExperiment.js). Declined as a lateral move rather than a de-coupling: 597 → ≈520 lines and 71,350 →
      ≈62 KB (still fourth in the largest-module table, AUDIT.md:40) while still on `store`/`strategies`, at the cost
      of a second facade layer (`http.js → platform.labRun → platformLab.labRun → replay.js`, against today's one),
      eleven delegating wrappers, `CODE_VERSION` through the deps bag, and two extra seam calls from
      `diagnostics`/`close`. Recorded as the first extraction if the file grows a fourth surface group, or once the
      research cluster's fetchers and caches stop being per-instance injection points.
      Why nothing tests this: no file in `tests/` or `scripts/` reads `core/platform.js` as source text or pins its
      layout — the only `readFileSync` of a `platform.js` in the suite is the HUD panel, `public/js/mpo-platform.js`
      (tests/hud-resilience.test.mjs:57,64) — so the file's shape is not a contract, and the decision was made on
      the coupling measurements above rather than on a gate. `PROGRESS.md` is read by no target.
Regression sweep after P2.4: `npm run test:all` exit 0 — 30 targets, 961 pass, 0 fail, 0 cancelled, every target ran
      (963 tests, of which the only two not passing are the standing `# SKIP` integration placeholders — the Jupiter
      sibling-freeze pair in `test:robinhood-equities` and the trader→Lab Kalshi handoff in `test:upgrade` — both
      untouched here); counts identical to the P2.3 baseline. This entry is docs-only and no target reads `PROGRESS.md`.

## P3 status: complete (P3.1, P3.2 and P3.3 skipped on measurement, P3.4 done as a lazy SDK load, P3.5 done)
P3.1 — skipped on measurement — — logo PNG → webp: refused by the PNG/colorType-6 contract, and recompression has 0 bytes of headroom
      Both halves of the item were measured against the file and its consumers. `public/assets/money-printer-logo.png`
      is 1024×1024 RGBA, 1,290,441 bytes, 9.85 bpp (30.8 % of raw), 348,696 unique RGBA colors, alpha 0–255, and has
      no ancillary chunks — there is no metadata to strip.
      "No code path needs PNG" is false, so the conversion is out. `public/dashboard.html` loads this PNG in five
      slots — :52 boot mark (64 px), :816 the stacked-bill FX sprite (`stack` → w = 120), :1509 updater brand mark
      (72 px), :1518 money-surface brand mark (108 px), :1679 glance brand mark — and `tests/visual-assets.test.mjs`
      :57–59 reads it *as a PNG* and asserts `colorType === 6` (8-bit RGBA) with ≥512×512. The same family is on the
      packaging path: `desktop/main.cjs:62,295` loads `app-icon.png` for tray and window, and `build/icon.icns`
      (2,290,233 bytes) is copied into the macOS bundle at `scripts/build-unified.mjs:217–223`. None of that is a
      webp-capable path. Counterfactual, measured: webp would have saved 34.7 % lossless (842,166 B) or 84.1 % at q90
      (205,264 B) — real weight, but it would cost the RGBA contract the visual test pins.
      "Recompress" has nothing left to give: a Pillow re-save with `optimize=True`, and with `compress_level=9`
      added, returns **1,290,441 bytes — the same size, pixels identical** (RGBA sha256 unchanged, `985a5d00…`), while
      `compress_level=9` without `optimize` is 6,014 bytes *worse*. No external optimizer is installed (no
      oxipng/zopfli/pngcrush/optipng/pngquant, and no zopfli in the Python env). The IDAT layout (19 × 65,536 B +
      1 × 44,972 B) plus the zero headroom say the file was already written by an optimal encoder. The only way down
      from here is palette quantization, which changes `colorType` from 6 and drops the soft alpha.
      So the weight is a *placement* problem, not a compression one, and it is queued as P3.5 rather than done under
      a compression item: a 1024 px RGBA render is drawn in 64–120 px slots. Derivatives measured from the same
      pixels, RGBA, `optimize=True`: 512 px 370,015 B (−71.3 %), 256 px 103,916 B (−91.9 %), 128 px 29,954 B
      (−97.7 %) — a 256 px derivative still covers the widest slot (108 px) at ≥2× and would take ≈1.19 MB off the
      boot path. That is one new asset plus five reference edits and an art check, so it is a separate item. P3.5
      revisited that size after measuring every drawn box (the widest is the 120 px stacked-bill sprite, so the item
      shipped 512 px — see P3.5 below); this paragraph keeps the numbers as measured at the time.

Regression sweep after P3.1: `npm run test:all` exit 0 — 30 targets, 961 pass, 0 fail, 0 cancelled, every target ran
      (963 tests, of which the only two not passing are the standing `# SKIP` integration placeholders — the Jupiter
      sibling-freeze pair in `test:robinhood-equities` and the trader→Lab Kalshi handoff in `test:upgrade` — both
      untouched here); counts identical to the P2.4 baseline, and `test:visual` — the target that pins the logo PNG —
      passed, so `public/assets/` was left byte-for-byte as found.
P3.5 — done — 1,290,441 → 369,134 bytes (−71.4 % / 921,307 B) off every drawn slot — sized logo derivative (512 px RGBA PNG) for the ≤120 px dashboard slots, 1024 px master kept
      Queued by P3.1 as "a 256 px derivative"; measuring the boxes first moved it to 512 px. The five places the
      desktop draws the master are all smaller than the queue-time note assumed, and the widest is 120 px, not 108:
      `public/dashboard.html` :52 boot mark (64 px via `mpo-shell.css:749 .bootmark`), :816 the stacked-bill FX sprite
      (`stack` → w = 120, h = w/ar = 120), :1509 updater brand mark (72 px), :1518 money-surface brand mark (108 px),
      :1679 glance brand mark (80 px via `mpo-glance.css:238 .g-brand img`). Nothing scales those boxes up, so the
      largest device box is 120 px × DPR, and the repo already has a sizing rule for assets: `scripts/make-logo-cutout.py`
      sizes the 3D logo "~320 CSS px at DPR 1.5-3", i.e. 3 × the slot. 3 × 120 = 360 px, which 256 px does not reach
      (2.13×) but 512 px does (4.3×) — so the 256 px figure from P3.1 would have gone soft on the widest slots above
      DPR 2.1 and was revised rather than shipped. Straight-RGBA 512 measured 370,015 B in P3.1; the shipped
      premultiplied file is 369,134 B (0.286 of the master, 900 KiB off the boot path, P3.1's ≈1.19 MB figure assumed
      the smaller derivative).
      `scripts/make-logo-derivative.py` generates it: LANCZOS resize, then assert 8-bit RGBA / 512×512 / under a
      420,000 B budget, and it refuses a non-RGBA or non-square master. It filters *premultiplied* (colour × alpha →
      resize → divide back out) because the artwork's transparent pixels are black, so a straight-RGBA resize drags
      that black into the glow rim: measured, the naive resize differs on the rim by up to 255 levels (mean 0.076 over
      the soft-alpha rim, 0 at p99, i.e. only the rim moves — and it is the wrong direction there).
      Art check, measured two ways. (a) The file on disk is bit-exact the alpha-correct 512 downscale of the master —
      max delta 0 on the alpha channel and 0 on premultiplied RGB — so this is the same artwork, resampled once, not a
      re-render. (b) What the GPU draws per slot at DPR 1 / 1.5 / 2, master→device-box vs derivative→device-box,
      composited over the black boot terminal, a light window surface and the sky: mean ≤ 0.21/255, max ≤ 18/255 on
      single pixels, alpha mean ≤ 0.037 and max ≤ 7; the derivative's own smooth-downscale error is 0.36–0.41 RMS.
      The one non-standard path is the boot mark: `.bootmark` sets `image-rendering: pixelated` (`mpo-shell.css:755`,
      nothing later overrides it — the other `image-rendering: auto` rules target different selectors), so it is a
      nearest sample and its aliasing pattern does change (mean 5.5/255 vs today's). That is not a downgrade: against
      the ideal alpha-correct render the 512 source is *closer* than the 1024 master at every device box (RMS 31.46 vs
      33.85 at 64 px, 28.28 vs 26.70 at 96 px, 23.13 vs 25.06 at 128 px), because a nearest sample of the derivative
      lands on an already-prefiltered pixel. So each slot either draws the exact same pixels (smooth path) or a truer
      sample (pixelated path) — nothing was traded for the 900 KiB.
      Contract: the master stays where it was — it is the packaging source (`desktop/main.cjs:62,295` tray + window
      icon, `build/icon.icns`) and what the screenshots reference — and `tests/visual-assets.test.mjs` now pins the
      derivative as well: colorType 6, exactly 512×512, ≥ 3 × 120 px, under a third of the master's bytes, all five
      references pointing at it, and the bare `money-printer-logo.png` regex absent from `public/dashboard.html`, so a
      sixth drawn slot cannot quietly reintroduce the 1.29 MB file. Files touched: `public/dashboard.html` (5 src
      strings), `public/assets/money-printer-logo-512.png` (new), `scripts/make-logo-derivative.py` (new),
      `tests/visual-assets.test.mjs` (+1 test). The generator is deterministic — two runs give the same sha256
      (`4f4f0ae99180d19a…`) — and the output has no ancillary chunks (IHDR/IDAT/IEND only).

Regression sweep after P3.5: `npm run test:all` exit 0 — 30 targets, 962 pass, 0 fail, 0 cancelled, every target ran
      (964 tests, of which the only two not passing are the standing `# SKIP` placeholders — the Jupiter sibling-freeze
      pair in `test:robinhood-equities` and the trader→Lab Kalshi handoff in `test:upgrade` — both untouched here);
      that is the P3.1 baseline (963 tests, 961 pass) plus exactly the one new `visual-assets` test. `test:visual` — the
      target that pins the logo contract — ran 72/72.

P3.2 — skipped on measurement — — stateVersion field + migration stub: the load path has no version to dispatch on, and the one capability a counter adds is the wrong answer on this document
      `stateVersion` appears exactly once in the tree — in this file, as the queue line — so nothing was half-built and
      nothing is waiting for the field. `src/store.js:304` is the whole load path: `merge(validateAccount(
      attachResearch(JSON.parse(...))))`, with no version dispatch anywhere, and `fresh()` writes no version either.
      Measured, that is the field's behaviour: a state.json carrying `stateVersion: 99` loads as 99, saves back as 99,
      and changes nothing.
      The stub has nothing to dispatch on, because this document already migrates on *field presence*, which is
      finer-grained than one integer. Seven legacy shapes were run through the real store (probes kept outside the
      tree; none of them carries a version field):
        • `{cashSol, paperStartSol, positions, history}` — the pre-everything shape `tests/store-recovery.test.mjs:21`
          already uses: cash kept, `pnlLedger` rebuilt `[]`, `realizedLifetimePnlSol` 0 (correct for no history),
          research backfilled to 16 sections.
        • pre-`pnlLedger` with 3 closed trades: ledger rebuilt with exactly 3 rows, `realizedLifetimePnlSol` = 3 (the
          exact sum) and `pnlLedgerTruncatedBefore` = 1000 — the F1/F3 reconstruction, keyed on
          `!Array.isArray(s.pnlLedger)` (`store.js:102`) and already pinned by `tests/accounting-integrity.test.mjs:66`.
        • pre-split inline research (heavy sections inside state.json, no research-state.json): loads with
          lessons/universe/outcomes intact, and the next save externalizes all 11 `RESEARCH_HEAVY` keys — state.json
          gets `research.externalized` and research-state.json carries the same counts. `store.js:18` claims this; it
          is now measured rather than asserted.
        • `research: null`: no throw, 16 sections backfilled — every writer in the tree uses `|| {}` / `|| []`.
        • wrong-typed sections (`learner: []`): tolerated — not repaired into an object, but nothing throws and no
          pause or recovery fires. A counter would not catch it either: an array-valued section has no version to read.
        • an `externalized` list whose research file was deleted: inline fields kept, the heavy sections rebuilt empty
          by design (`store.js:238` — a missing file is a fresh install, a pre-split file or a reset).
      The one capability a counter uniquely adds — refusing an unknown version — is the wrong response on this
      document. `loadState()` is the engine's load path (`src/index.js:489`, `:809`, `src/optimizer.js:3`), and it
      refuses only *impossible* state (`validateAccount`: non-finite or negative cash, missing arrays), throwing
      `STATE_RECOVERY_REQUIRED` with both files preserved for repair (`store.js:320–325`). A `stateVersion > CURRENT →
      throw` gate would turn a shape question into a hard boot failure on the money path — a new failure mode with no
      measured need, against the tree's own rule (load the account, record the anomaly, never zero or refuse it: F1/F2/F3,
      `system.recovery`, `system.researchRecovery`). The field can also rot silently: with no second source of truth, a
      forgotten bump asserts a false invariant, and no test can detect a forgotten bump.
      What the item was really reaching for is downgrade safety — an older build must not lose what a newer build
      wrote — and that already holds, structurally. Measured by handing this build a newer build's files: an unknown
      field (`stateVersion: 7`), an unknown top-level key (`futureTopLevel`) and an unknown *heavy* section
      (`futureSection`) listed in the newer `externalized` list all survived load → save → reload. The section
      reattaches because `attachResearch` (`store.js:275–281`) takes the wanted list **from the file it is reading**
      rather than from a hardcoded one; on republish this build re-derives the list from its own keys (`store.js:501`)
      and writes the unknown section inline instead of leaving it dangling, so it changes address, it is not lost.
      Nothing was invented and nothing dropped, in either direction.
      So the residue of this item is a guard, not a field: that property rested on two rules and nothing pinned either.
      `tests/store-recovery.test.mjs` (+1 test, no production change) now asserts the newer build's unknown field, key
      and section across a full load → save → reload, plus the list behaviour that makes the move safe. Files touched:
      `tests/store-recovery.test.mjs` (+1 test); `src/store.js` byte-for-byte unchanged.

Regression sweep after P3.2: `npm run test:all` exit 0 — 30 targets, 963 pass, 0 fail, 0 cancelled, every target ran
      (965 tests, of which the only two not passing are the standing `# SKIP` placeholders — the Jupiter sibling-freeze
      pair in `test:robinhood-equities` and the trader→Lab Kalshi handoff in `test:upgrade` — both untouched here); that
      is the P3.5 baseline (964 tests, 962 pass, 2 `# SKIP`) plus exactly the one new `store-recovery` test, which makes
      `test:recovery` 55/55. No `src/` file was touched, so no target's runtime behaviour could move.

P3.3 — skipped on measurement — — npm audit in CI as non-blocking telemetry: the four advisories cannot be reached from any path this app loads, and npm can offer no fix to act on
      Measured on the installed tree: `npm audit --json` and `npm audit --omit=dev --json` are **byte-identical**
      (same SHA-256) because this package has no devDependencies at all — **4 moderate, 0 high, 0 critical**, and all
      four come from one chain under `@solana/web3.js@1.99.0` → `jayson@4.3.0` → `stream-json@1.9.1` + `uuid@8.3.2`.
      `@solana/web3.js` and `jayson` carry no advisory of their own; npm lists them only as `effects` of the two below.
      Reachability was traced rather than reasoned about, twice and independently: a `Module._load` hook around the CJS
      build, and `NODE_DEBUG=module` (649 load lines) over the ESM loader while importing the app's own Solana modules —
      `src/rpc.js`, `src/jupiter.js`, `src/walletScorecard.js`, `src/transactionIndexer.js`.
        • `stream-json` — **0 load lines, ever**, in either trace. Its only importer in the whole tree is
          `jayson/lib/utils.js:3-4`; the only jayson entry point `@solana/web3.js` touches is
          `jayson/lib/client/browser` (all six `node_modules/@solana/web3.js/lib/*.js` bundles: that one path, no
          other), and the browser client pulls `jayson/lib/generateRequest.js` plus `uuid` — not `utils.js`. So the
          O(depth²)-filter DoS advisory, the only one in the set with an impact story that matters, is on no path this
          repo can take; the filters it concerns (`pick`/`ignore`/`filter`/`replace`) appear nowhere in the tree either.
        • `uuid@8.3.2` — loads, from exactly three parents: `jayson/lib/client/browser/index.js`,
          `jayson/lib/generateRequest.js`, `rpc-websockets/dist/index.cjs`. The advisory is a missing buffer bounds
          check in v3/v5/v6 **when `buf` is provided**; jayson's two call sites are `require('uuid').v4`
          (`client/browser/index.js:3`, `utils.js:6`), and v4 takes no `buf`. Nothing in `src/`, `scripts/`, `tests/`,
          `desktop/` or `public/` imports `uuid` — nor `jayson` nor `stream-json`; every `uuid` hit in the tree is
          `node:crypto.randomUUID` (`store.js:2`, `core/platform.js:2`, `robinhoodJournal.js:8`, …).
          `rpc-websockets` ships its own `uuid@14.0.2`, past the `<11.1.1` range and not in the report.
        • Weight, for the record: `jayson` 1,111,467 B + `stream-json` 90,323 B + `uuid` 116,098 B under an
          `@solana/web3.js` of 11,520,649 B — a package whose weight already has an owner and a plan
          (`reports/SOLANA-ROBINHOOD-LAB-REVIEW-2026-09-26.md:84`, "Keep; lazy-load it once Solana is parked").
      Nothing in the report can be acted on, which is what makes a permanent line the wrong surface. `fixAvailable`
      for all four is `@solana/web3.js@0.0.3` (`isSemVerMajor: true`) — npm's own proposed remedy is a **downgrade
      from 1.99.0 to a pre-release** — so `npm audit fix` has no move to make and the step can never be cleared by
      acting on it. A non-blocking line that is permanently yellow and un-actionable is a line people learn to skip,
      and "telemetry we look at" was the item's whole value proposition.
      The consumer is the other half of the measurement. `ci.yml` has no artifact upload and no notification step, so a
      non-blocking audit line would be read by nobody unless a human opens the run page. The repo's telemetry idiom is
      exactly that — a line a human reads: `$GITHUB_STEP_SUMMARY` (`release.yml:91-101`), and its in-test sibling
      `test-wiring.test.mjs:48-60`, titled "the coverage map is complete and printed (telemetry, not a guess)". Both
      earn their readers because they change when the repo changes. An audit line does not: advisories are published
      against the registry on the registry's schedule, so a push that touched no dependency can turn it yellow. The
      only change that can *introduce* an advisory is a `package.json`/`package-lock.json` bump — which is precisely
      the diff of the PR that makes it, since everything else is frozen by `npm ci` (lockfile 18,878 B). The repo also
      settled the adjacent question twice and symmetrically: both workflows install with **`--no-audit`**
      (`ci.yml:53`, `release.yml:69`), i.e. audit output is deliberately kept out of build logs, and `ci.yml`'s header
      states the job's purpose as "Same checks a contributor runs locally" — an audit step is not in README's
      `## Running it` list (`npm ci`, `selftest`, `doctor`, `test:all`, `test:updater`), so adding one would silently
      divorce CI from the documented local check list. Nothing pins those two together either: no test or script reads
      either workflow file.
      One variant is not pure noise, and it is not this item. A *gate* at `--audit-level=high` (measured: exit 0 today,
      `0 high`, `0 critical`; same for `--audit-level=critical`) would be green now and would speak up on a future
      high/critical in a runtime dependency. It was declined with the CI step because the queued item is non-blocking
      by definition, and because a registry-drift gate reddens CI on a push that changed nothing — the same defect with
      a worse failure mode attached to a green baseline. If it is ever wanted, build the causal trigger instead:
      diff the lockfile in the PR, not the registry on every push.
      Residue: the reachability analysis is the part that cost something to establish and that nothing in the tree
      recorded, so it is recorded with its reproduce command in `AUDIT.md` §0 beside the existing "Runtime deps" row
      (whose companion "Installed state" row was corrected too: `node_modules/` is present now and was absent when §0
      was written). No test and no script were added, unlike P3.2 — here no invariant rests on an unpinned rule in this
      repo's own source. The reachability lives in `node_modules/`, and a test that asserted a dependency's internal
      import graph would be pinning a coincidence that any `@solana/web3.js` bump invalidates: the same reasoning P2.4
      used to decline a split that existed only because of test injection. Files touched: `AUDIT.md` (one new snapshot
      row, one corrected); no code, no test.

Regression sweep after P3.3: `npm run test:all` exit 0 — 30 targets, 963 pass, 0 fail, 0 cancelled, every target ran
      (965 tests, of which the only two not passing are the standing `# SKIP` placeholders — the Jupiter sibling-freeze
      pair in `test:robinhood-equities` and the trader→Lab Kalshi handoff in `test:upgrade` — both untouched here);
      stderr was empty and the counts are identical to the P3.2 baseline, which is the expected result for a docs-only
      item. Checked before editing that no test or script in `tests/` or `scripts/` reads `AUDIT.md` or `PROGRESS.md`,
      so the edit could not change any target's inputs.

P3.4 — done — ~180 ms and a 9.4 MB module graph off every process that boots the platform — @anthropic-ai/sdk moved off the import path (dynamic, cached, first request) with the resolution pinned by a spawned boot probe
      The item asked for the SDK off the cycle hot path. Measured, it was never *on* the cycle — a summary is reachable
      only by request (`http.js:68` `/edgar/summary` → `platform.js:576` `edgarSummary` → `this.summarize` → `aiSummary.js:42`)
      — but it *was* on the process **boot** path: `src/index.js:14` imports `marketPlatform` from `core/platform.js`, line 29
      of which imports `./aiSummary.js`, line 1 of which was `import Anthropic from '@anthropic-ai/sdk'`. So every process that
      boots the engine, and every test target that touches `platform.js`, paid for a feature that only runs on request.
      What it cost, measured (medians of 5 cold runs, Windows, warm FS, whole process): an empty ESM process 49 ms,
      `import '@anthropic-ai/sdk'` 226 ms, `import src/core/aiSummary.js` **241 ms**, `import src/core/platform.js` **442 ms**.
      The SDK is 9,378,760 B on disk and `module.register` sees it as **445 module resolutions** — a whole package graph, not
      a file. After the change: `aiSummary.js` **58 ms** (an empty process), `platform.js` **267 ms**, and a spawned boot probe
      resolves **0** SDK modules while still resolving `platform.js` and `aiSummary.js`.
      The change is in `src/core/aiSummary.js` only: the static import is replaced by a cached dynamic one
      (`const anthropicSdk = async () => (sdk ||= (await import('@anthropic-ai/sdk')).default)`), `client` defaults to null and
      the SDK client is constructed where the old default parameter built it, and the call moved from `client.beta…` to `api.beta…`.
      The load sits **after** the two validation throws (a too-short/empty body, and text over `MAX_FILING_CHARS`), so a refused filing never pays it;
      the error mapping still uses the SDK's own classes, because they come from the same resolved module. Callers, routes and
      the stored-result shape are untouched: `platform.edgarSummary` and the `this.summarize` injection point are unchanged.
      Behaviour was reproduced rather than assumed. Directly: status `OK`, `citedShare` 1, the citation quote, `usage`, the two
      refusals (`too short`, `TOO_LONG`), the `REFUSED` mapping, `htmlToText`, `aiConfigured({})`, `SUMMARY_MODEL` — all identical
      to the pre-change values, and the SDK-typed error mapping was exercised with a client-less call against a dead port
      (`ANTHROPIC_BASE_URL=127.0.0.1:9`, no external request): `API_ERROR: Anthropic API error undefined: Connection error.`
      Through the suite: the market-core target passes (exit 0) and its assertions are unchanged.
      Measurement correction worth recording: `NODE_DEBUG=module`, which carried the P3.3 reachability trace, only logs **CJS**
      resolution — it was blind to this package, which ships ESM (`index.mjs`). Proving the negative needed a `module.register`
      resolve hook, which sees every module: importing `aiSummary.js` + `platform.js` resolves 108 paths, `platform.js` and
      `aiSummary.js` among them, and 0 under `node_modules/@anthropic-ai/sdk`; the client-less call resolves exactly the 445.
      The residue is pinned, because nothing else in the suite can see this regression: a static import restored would leave
      every target passing while every process paid ~180 ms again. `tests/market-core.test.mjs` gains one test that spawns the
      boot module under the ESM loader's own debug channel (`NODE_DEBUG=esm`, which logs every stored module URL) and asserts
      that nothing under `@anthropic-ai/sdk` was resolved — with `platform.js` and `aiSummary.js` asserted **present** as the
      control, so if that channel ever goes quiet the test fails rather than quietly passing on an empty trace. Proven to bite:
      with only `src/core/aiSummary.js` reverted to the static import, the new test fails on exactly that assertion (exit 1);
      with the change in place it passes in 313 ms. Cost of the pin: one spawned node per suite run (~0.3 s, 1.2 MB of captured
      trace, `maxBuffer` set explicitly).
      Two variants were rejected. Making the load conditional on `client` being absent would put the SDK's error classes out of
      reach for a caller that injects a real client — the classification would silently stop applying to the errors it exists
      for, a behavioural change hiding inside a performance fix. And a source-text assertion alone would pin the mechanism
      rather than the outcome (this file might legitimately move the loader elsewhere), so the test measures the boot, and the
      reason is recorded in the source comment where the next reader will meet it.
      Effect on the suite, since every target imports `platform.js` somewhere: the market-core target went from **5,289.98 ms**
      with the static import to **4,579.36 ms** with the change (and 4,258.44 ms on the first post-change run) — ~0.7–1.0 s per
      process, the same import the engine pays once at boot and the dashboard pays with it. Files touched: `src/core/aiSummary.js`
      (the load) and `tests/market-core.test.mjs` (the pin); no route, no storage, no other module.
      Sweep after P3.4: **30 targets, 964 pass, 0 fail, 2 `# SKIP`** (stderr file empty) — the P3.2/P3.3 baseline of 963
      plus exactly the one new test, so the pin is counted by the suite and nothing else moved.
