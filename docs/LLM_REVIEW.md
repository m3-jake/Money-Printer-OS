# Money Printer OS and Evolution Lab review

Fresh follow-up: read `docs/audit-2026-10-03/README.md` and its `NEXT-BEST-STEPS.md` implementation prompt first. The October 3 evening audit includes fresh tests, current aggregate runtime evidence and reproducible accounting/admission/storage counterexamples. The current trader full command fails a documentation-count gate; all remaining wired groups pass when run separately. Lab's fresh full suite passes 365 tests. The historical release evidence below remains evidence of that release, not a claim that the current CI is green.

Review both repositories together:

- Trader: https://github.com/m3-jake/Money-Printer-OS
- Lab: https://github.com/m3-jake/Money-Printer-Evolution-Lab (private; reviewer needs access)

The completed request is `docs/prompts/CLAUDE-COORDINATED-DESKTOP-2026-10-03.md`. Start with `reports/coordinated-desktop-2026-10-03/README.md` for delivered behavior, measured limits, accounting preservation and each module's data/provider waits. This publication includes all current source and reachable tests, the prior unpushed trader work, the full Lab history, screenshots, full-suite logs, failed diagnostic logs and before/after runtime evidence. Temporary work copies, generated upload ZIPs, dependencies, credentials and live database files stay local.

## Installed source and evidence

Trader alpha.93: `89fa8d7764a315fae8503e20aac07261a62ffd6a`.
Lab alpha.28: `9cfaa899b4d6a95d7d753314652b481d7d12dd46`.
Both use MAX_RESEARCH. Later documentation/evidence commits do not alter the installed runtime source.

- `reports/coordinated-desktop-2026-10-03/installed-after.json`: independently checked paired receipt/hash/commit and 24-book retention results.
- `runtime-final.json` in the same directory: live coordinator receipts, actual process/GPU measurements, resource reservations, provider pacing and current research jobs.
- `trader-final-full-tests.log`: 1,399 pass, 20 intentional live-order skips, no failures. Final profile-label regression and wiring/parity checks have separate logs.
- Lab `reports/coordinated-resume-final-full-tests.log`: 365 pass, no failures/skips, including real CUDA checks. Prior concurrent-load failures are retained and explained.
- `bench-before.json`, `bench-after.json`, `bench-steady.json`: separate baseline, startup and settled runs. The startup timeout is a known limitation; do not erase it when evaluating settled improvements.
- `native-renderer-metrics.json`, `native-renderer-metrics-copy.png`, `ui/`: native installed UI and populated source screenshots at requested dimensions. Physical pointer/multi-monitor latency and comparable baseline event-loop/native-frame measurements were not established.

## Code review priorities

1. Durable coordination and receipt consumption: `src/core/coordinator.js`, `src/core/intelligence.js`, Lab `src/coordinatorRequests.js` and `src/workbenchDaemon.js`. Check leases, bounded requests, retries, evidence deduplication, fairness and genuine completion feedback.
2. Frozen evaluated provenance and admission: `src/core/labSync.js`, Lab `src/labProvenance.js` / `src/labPublish.js`, and cross-app tests. A verified historical proposal must still fail unchanged prospective gates; exploratory books remain independently funded and frozen.
3. Collector completeness under existing spend caps: `src/transactionIndexer.js`, `src/alphaDb.js`, `src/walletScorecard.js`, `src/copyFunnel.js`. Inspect durable cursors, partial progress, target-specific exits, multi-token identities, follower costs and retained loss pauses.
4. Timestamp-safe weather/BTC/equity research: trader `src/weatherProvenance.js`, `src/robinhoodEquitiesData.js`, Lab `src/weatherProspective.js` and `src/btcReplay.js`. Unknown provenance stays unknown; revisions cannot appear before receipt, settlement-date siblings cannot cross folds, and repaired bars cannot invent history.
5. Compact UI/history and reliability: `src/marketHistory.js`, `src/commandCenter.js`, `public/js/mpo-price-workspace.js`, `public/js/mpo-command-center.js`. Check source identity, early closes, gaps, lazy coverage, truthful counts, focus/scroll retention and startup event-loop contention.
6. Shared strategy adapters and paper authority: `shared-core.json`, trader `src/strategyChallengers.js`, Lab matching file/research wrapper. Twenty-one owned files must remain byte-identical; adapter capability must not confer automatic admission, funding or live authority.

Report concrete bugs with reproduction conditions and source locations. Distinguish observed defects, missing evidence, provider/account prerequisites and future enhancements. Passing suites or shipping code does not establish profitable strategies.

## Reproduce

Install locked dependencies in the trader, then run `npm run test:all`. In the Lab, install its declared dependencies and run `npm test`. Use an isolated temporary data directory and no production credentials for tests. Shared parity runs within the wired suites. Lab CUDA tests require the configured local GPU/Python runtime; record unavailable hardware rather than inventing a pass.

Read-only live measurements use `scripts/bench-endpoints.mjs`. Paired installer source is `scripts/update-local-install.ps1`; archive and runtime hashes in the evidence are the authority for installation claims.

## Explicit separate follow-ups

The newly queued policy-keyed Pump paper-study generation is not implemented by this completed desktop run. Its full brief and historical nomination artifacts are in `reports/queued-pump-policy-study/`; historical outcomes may nominate hypotheses but must never enter prospective validation. The older D2 shared HUD extraction remains a deferred refactor. These are open review/next-work items, not hidden completion claims. Data/credential waits and startup contention are listed in the completion report.
