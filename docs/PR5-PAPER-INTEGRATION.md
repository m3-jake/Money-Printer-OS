# PR #5 PAPER-only recovery

Source checkpoint: October 26, 2026. Branch: `fix/pr5-paper-evidence-20261026`.

## Inspected revisions and conflict resolution

- Latest fetched `main`: `2a1c541a1ab4a9b8f4e8038cafdae2fc03e411af`.
- PR #5 head: `ee049d329f12f12258572abc125f7a92b9ed01c3`.
- Merge base: `1733a51b87c345813857973d10e872a0aa0aec72`.
- Non-mutating `git merge-tree --write-tree` identified conflicts in `public/dashboard.html`,
  `public/js/mpo-polymarket.js`, `src/dashboard.js`, `src/index.js`, and `tests/solana-fair.test.mjs`.

The two requested fixes were selectively implemented on current main. Newer cash receipts, policy
provenance, fee-inclusive sizing, staged exposure, portfolio risk, routing, Jupiter friction, shared
simulation, price-review diagnostics, and the split dashboard remain in place. No unresolved merge
entries remain in this branch. PR #5 itself is not rewritten, merged or closed.

Excluded from the old PR: SPRINT cost-gate bypass, changes to profile demotion, and global Polymarket
dashboard autostart/control/reset routes. Those are separate policy and lifecycle changes, not needed
to recover the requested calibration gate and entry diagnostics.

## Polymarket bootstrap contract

`bootstrapExploration` is a global **PAPER** autopilot setting. Its default follows
`POLYMARKET_BOOTSTRAP_EXPLORATION` (default `true`, as in PR #5). A persisted boolean `false` wins over
the environment default. `setAutopilot({bootstrapExploration:false})` disables it; no active settings
were changed in this work. Global paper singles/combos mode is unrelated to live/paper execution mode.

The baseline EV gate and sample threshold are retained. The bootstrap gate may override only an
`ev-uncalibrated` result, in PAPER mode, with explicit exploration enabled:

- With zero observations, the current model uses the executable quote as its probability prior.
  Only a valid, explicitly tagged `QUOTE_PRIOR`, consistent with that quote and its fee arithmetic,
  may explore without positive estimated EV. Its negative fee drag remains visible in research data;
  it is not presented as a profitable prediction.
- Any other estimate, including one with only 1–11 observations, must still clear the existing
  edge and positive-ROI tests. Negative, thin, missing, nonfinite and invalid-price inputs stay blocked.
  This is deliberately more conservative than PR #5: collecting initial evidence does not guarantee
  that exploration continues through adverse or thin results to the 12-sample threshold.
- A measured combo must still meet the 2.5% joint ROI floor. Merely containing an exploratory leg
  cannot waive it. Only a combo with an admitted zero-outcome quote prior has unknown joint EV.
  Every leg must pass its own gate; a losing calibrated leg cannot hide behind an uncalibrated one.
- Live-state, market-type, timing, freshness, executable-price, spread, liquidity, depth, duplicate,
  cooldown, growth-slot, exposure, cash, settlement and simulator checks retain their existing paths.
- Entry legs persist `autopilotLane`, `evidenceQuality` and `evEvidence`; position research records
  persist `lane` and `evidenceQuality`. Settlement preserves these labels in history.

## BING PUMPO diagnostics

The actual downstream entry path is in `src/index.js`. `src/solanaEconomics.js` retains its current
cost model and profile-demotion policy byte for byte.

`stats.entryRejectReasons` and `stats.lastEntryReject` retain cumulative PAPER diagnostics.
`system.opportunityFunnel.entryRejectionReasons` contains deltas only for the current scanner entry
attempts. Its `lastEntryReject` is null when those attempts produced no rejection, so a stale cause
is not attributed to a later cycle. Existing `stats.skipped` and `skipReasons.costGate` semantics stay
unchanged; diagnostic recording does not double-count or add entry gates.

Recorded blockers include missing/duplicate/blacklisted candidates, strategy routing, stale or
invalid prices, sizing, portfolio risk, cost, SPRINT liquidity/execution/friction, paper routing,
pool-binding integrity, simulator no-fill, and execution budget/reserve/cash. Simulator and integrity
subreasons and relevant numeric bounds are preserved. The current Pump.fun overview displays
approved/opened counts and up to three downstream blockers, preserving its newer price-review row.

## Repository verification

Node 24.22.1; dependencies installed from the lockfile with install scripts disabled. All new tests
use temporary data directories, mocked market reads and PAPER simulation. No installed application
data, active configurations, bankrolls, positions, credentials or executors were changed.

| Check | Result |
| --- | --- |
| Focused bootstrap, trade-path and Solana regression run | 54 passed, zero failed |
| All `test:all` targets, completing the remaining targets separately after the missing-Lab failures | 1,427 passed, 6 failed, 24 skipped; 1,457 test executions including repeated suites |
| Six failed tests repeated on unchanged `main` | Same missing sibling Lab modules |
| `npm run selftest` | PASS |
| `npm run doctor -- --offline` | PASS; RPC benchmarking skipped as requested |
| `git diff --check`, JS syntax and existing inline HUD script parsing | PASS |
| Real-execution source comparison | Live entry/sell branches and global Polymarket readiness identical |

The six failing tests are two in `tests/coordinator.test.mjs` and four in
`tests/lab-provenance.test.mjs`. They import `exploratoryProposals.js`, `coordinatorRequests.js`, and
`labProvenance.js` from `../money-printer-evolution-lab`, which is absent from this environment.
No replacement Lab implementation or permissive stub was introduced. Existing skipped tests retain
their original conditions, including paper-build live-order skips and unavailable sibling-Lab checks.

The status ledger's existing target count was also stale (37 versus 36 reachable targets). It now
matches the test graph; the suite count is 168 after adding the bootstrap suite. Both are checked
by `test:wiring`. The baseline document-count failure was reproduced before that correction.

The CI workflow still refers to removed `src/doctor.js`; the supported package script points to
`tools/doctor.js` and passes. That pre-existing CI-path issue is recorded rather than mixed into this fix.

Safety comparison also confirmed no changes to `src/config.js`, `src/liveConfig.js`,
`src/core/executionBoundary.js`, `src/jupiter.js`, `src/providers.js`, `src/robinhoodSigner.js`,
`src/polymarketUS.js`, `src/polymarketUSCombos.js`, `src/solanaEconomics.js`, or
`src/core/paperTrading.js`. Relevant live-gate, Polymarket US, Robinhood safety, kill-switch and
execution tests ran as part of the targets above. No real order was submitted.

## Desktop verification still required

This is repository verification only. No Windows installation, release, restart, real feed session,
or paired Lab runtime test was performed. A newer local working tree on WITCHDOCTOR was not inspected.

Current main intentionally leaves the legacy global `src/polymarket.js` lane detached from the desktop
dashboard. This change preserves that architecture; it does not claim that the installed desktop
autopilot is running this lane. A separate lifecycle integration decision would be needed to expose
or start it from that dashboard. After a reviewed paired release, verify the installed commit and
Lab parity, then observe PAPER-only entries, persistent exploration labels, and the current Pump.fun
funnel in the installed UI without resetting existing books or enabling live execution.
