# Evolution Lab implementation handoff

Lab baseline: clean `386bb13`, branch `codex/lab-evidence-20260925`, alpha.6. Shared Robinhood evaluator
correction already committed as `36fae5f`; alpha.7 source/build commit and archive hash are reported by
the parent after final packaging. Installed alpha.6 processes/data were never modified.

Implemented: corrected equities incumbent and equal-capital/charged-boundary accounting; durable
content/source/evaluator experiment identities; overlap-refusing holdout ledger; fixed candidate and
126-session prospective comparison; historical proposal invalidation/archives; bounded readiness/fairness
scheduler and shared trader/Solana/module CPU leases; resource profiles/visibility and API/polling guards;
Kalshi observed-offer fixed-policy evaluator/adapter; reproducible committed-source BUILD.json packaging.

Full suite: **254 passed** (93+78+83), followed by targeted extra lease-recovery tests. Reference/packed
CPU parity, GPU mock/fallback, corruption/recovery, no-live flags and cross-app contracts remain covered.
Final targeted counts and build hashes are appended below when complete.

Real installed ETF dataset was copied read-only. Three-run median evaluator time: **753ms→665ms**;
RSS approximately159MB→175MB. Accounting/window changes make this a corrected workload comparison,
not strict parity. Scheduler admissions1000→one evaluation (999duplicates removed).

Observed isolated soak: **30.004seconds**,20 CPU evaluator jobs completed,0failures,475local state API
responses,**p95 5.36ms**,max38.60ms. API RSS74.5→96.9MB. No renderer/GPU benchmark or 24-hour observation
is claimed; the resumable 24-hour script and pass/fail limits are documented.

Remaining limits: equities executable costs/data are uncertified and126future sessions cannot be
manufactured; Kalshi lacks complete fee/rule/settlement evidence and remains research-only; Solana
executable-price evidence gating retained; Robinhood authentic quote history/cost hurdles remain;
international Polymarket remains NO_EDGE/parked and US combo RFQ execution remains provisional.
Foreground/temperature scheduler inputs exist but only actual memory pressure is wired automatically.
Mac source compatibility is retained; Mac installation not exercised. No external provider paid call,
live order, install or restart occurred.

Detailed capability/issue/milestone/configuration/build/rollback record:
`W:/money-printer-evolution-lab/docs/UPGRADE-2026-09-26.md`.
Raw benchmarks: `W:/money-printer-evolution-lab/artifacts/upgrade-benchmark-2026-09-26.json` and
`W:/money-printer-evolution-lab/artifacts/upgrade-soak-2026-09-26.json`.

Final source: **abc16cec35bb8957d7fb6f7b8a4791c0bad0fbdb**, alpha.7, clean checkout. The earlier
Robinhood v2 correction remains in its parent history (`36fae5f`). Full suite passed 254 tests; later
ownerless-lock recovery/release-I/O/actual supervised-child regressions all passed (scheduler suite
11/11, environment+prior scheduler batch16/16). The supervised `--once` child smoke exposed and fixed
a retained stdin handle that otherwise prevented successful scheduler jobs from exiting.

Archive: `W:/upgrade-release-20260926/lab/app.asar`, 95 files, approximately0.7MB.
SHA256: **59f1fc61a2922bfb4a2079be5453f7ed9b267cabbdd4b55f4a873e7faa9b83de**.
A second archive build produced the identical hash. Both builds extracted and verified all95files.
`app.asar.build.json` records the pinned commit and per-file hashes; source fingerprint is
`6d3d3f82e91fa0b2a2aad7ee39bab7a717740315b3c77cee69197cd30abb59a3`.

An extracted-archive API smoke under isolated temporary data returned alpha.7, the exact commit above,
the expected schema metadata and `sourceDirty:false`. It used Nodev24.16.0 on Windowsx64; the installed
Electron process remains alpha.6. The repeat archive and build sidecars are retained beside the primary
artifact. Nothing was installed or restarted.

## Final trader integration review

The review reproduced a zero-unit withdrawal/redeposit path that reset marked drawdown. The parent
fixed it and the five marked-risk tests passed again, preserving the 20% drawdown throughout the
withdrawal and redeposit sequence.

Trader commit `c511661` strengthens the equities consumer. It now independently checks all seven
prospective gates, at least 126 sessions, six independent monthly groups, positive candidate net
return and improvement, bounded drawdown, the trial-adjusted positive confidence interval, frozen
policy and cost hashes, experiment/dataset fingerprints, fresh chronological evidence and explicit
paper-only safety flags. A previously accepted policy remains the applied incumbent when the Lab
withdraws or expires its proposal; retaining it requires a valid persisted acceptance receipt and
parameter hash. Fresh books still use defaults without a qualifying proposal.

The targeted trader equities suite passed **16/16**. It includes 25 bad-evidence mutations, withdrawal
persistence and a real producer-consumer integration: the sibling Lab creates a freeze, evaluates its
126-session prospective window, publishes through its production publisher, and the trader accepts
the emitted document. No integration test was skipped on this machine.

The shared prediction evaluator, Robinhood v2 backtest and compute lease files remain byte-identical
across the two repositories. The Lab archive and commit above did not change during this review.
