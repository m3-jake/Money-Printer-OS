# Evolution Lab audit — 2026-10-03

The Lab runs and its fresh full test suite passes, including real CUDA parity. It does not currently establish a qualified profitable strategy. The main remaining weakness is inconsistent scientific admission between research families: daily crypto can call historical results paper qualified, while the prospective intraday crypto gate can pass closed profits without evaluating open losses or a matched incumbent. Several stronger protections already work and should be preserved.

## Scope and evidence

- Audited checkout: `money-printer-evolution-lab` `4564b3094e21a639df3ed110faa18e5b079bc3af`, alpha.28; checkout clean.
- Installed `/api/health` reports a clean alpha.28 build at `9cfaa899b4d6a95d7d753314652b481d7d12dd46`, source fingerprint `5efebab84f39bb11038591633f3f311577166c421733654e1ac0f09d3a3af4a3`. A fresh diff confirms the subsequent checkout changes are `.gitignore`, README and evidence reports/logs, with no application source delta.
- `npm run test:all`: **365 passed, 0 failed, 0 skipped**, covering all 53 top-level test files. Seven groups: 137 + 17 + 93 + 17 + 24 + 68 + 9. Real persistent CUDA/full CPU interval parity ran, along with cancellation, shared-worker, unavailable-CUDA and bounded VRAM cases. Fresh log: [lab-tests.log](lab-tests.log).
- Four fresh synthetic invariant reproductions: [script](lab-audit-repros.mjs), [results](lab-audit-repros.json). These reproduce implementation defects; they are not return estimates or trading evidence.
- Read-only runtime observations: [module summary](lab-runtime-summary.json), [Workbench summary](lab-workbench-summary.json), taken around 2026-10-03 22:14–22:15 UTC. No credentials, account session or full private account snapshot was saved. Tests ran with production-related environment variables removed in their child shell and use isolated fixtures/data directories.
- No source repair, deployment, real trade, account change or GitHub push was performed by this audit.

## Verified findings

### LAB-01 — P1: historical daily crypto results can become an executable paper qualification

[robinhoodDaily.js:232](W:/money-printer-evolution-lab/src/robinhoodDaily.js:232) simulates every grid candidate across the entire history, including the named holdout. Selection scores remain sliced before the holdout, so this is not a claim that future prices directly alter past decisions. However, there is no durable freeze or access receipt, and [robinhoodDaily.js:334](W:/money-printer-evolution-lab/src/robinhoodDaily.js:334) returns `PAPER_REVIEW`, `state: PAPER`, `paperPromotionAllowed: true`, and `traderExecutable: true` based solely on those historical metrics. [moduleResearch.js:176](W:/money-printer-evolution-lab/src/moduleResearch.js:176) recomputes this result when a new candle, cost or code identity changes the fingerprint. The daily book is explicitly outside the fresh trader fitness publication gate in [moduleRegistry.js:108](W:/money-printer-evolution-lab/src/moduleRegistry.js:108).

The existing trending fixture and fresh audit reproduction produce an executable paper proposal using a 2023-03-20 through 2024-03-18 holdout. Repeating the call produces the same proposal without a freeze or consumed-window receipt. This bypasses the prospective evidence standard used elsewhere. Current real-data daily status is `NO_EDGE`, so this is a reachable policy inconsistency rather than a claim that a bad proposal is presently trading.

**Next step:** keep historical daily output `RESEARCH_ONLY`; give a chosen candidate a create-only freeze, disjoint prospective Robinhood quote/fill period and single-use evaluation receipt. Separate exploratory paper permission from strategy qualification in both applications. Verify trader daily adoption against the same experiment identity.

### LAB-02 — P1: prospective intraday crypto qualification omits outstanding losses, common capital and a prospective incumbent

[robinhoodEvolve.js:146](W:/money-printer-evolution-lab/src/robinhoodEvolve.js:146) creates `cash: startUsd` separately for every symbol. Eight symbols with `startUsd: 1000` therefore receive $8,000 of hypothetical starting cash. [robinhoodEvolve.js:187](W:/money-printer-evolution-lab/src/robinhoodEvolve.js:187) consumes the window after the close count reaches its threshold, even when another position or order remains open. The gate sums closed PnL/PF and never includes a liquidation equity mark, drawdown, unresolved exposure or independent opportunity groups. [moduleResearch.js:304](W:/money-printer-evolution-lab/src/moduleResearch.js:304) compares the candidate against the incumbent on pre-freeze search data; the fresh window contains only the candidate, not a frozen matched incumbent.

The fresh reproduction has 20 profitable closes totalling $20, $995 cash and an outstanding $25 position. The gate returns `pass: true` without drawdown or exposure fields; a conservative $0.05 liquidation value leaves total net PnL **-$4.95**. It also confirms the eightfold capital allocation. This is a Lab evaluator defect. It does not establish a bypass of the trader's additional current provenance/admission checks or live authority. Current real holdout has zero closes and has not passed.

**Next step:** replay a candidate, frozen incumbent and cash on one timestamp-ordered opportunity stream with the same starting capital; include bid/fee liquidation marks and drawdown; keep any unresolved exposure explicit and block sealed admission until its declared treatment is complete. Count independent event/time groups rather than merely 20 closes.

### LAB-03 — P2, latent: generic sealed-window registry permits candidate reuse and reopening through a dataset change

[labResearchEvidenceStore.js:81](W:/money-printer-evolution-lab/src/labResearchEvidenceStore.js:81) keys access by module, dataset hash and exact start/end. An already recorded key returns the original receipt without checking candidate identity. A different dataset hash or partially overlapping window creates a new allowed entry. [polymarketEvidence.js:258](W:/money-printer-evolution-lab/src/polymarketEvidence.js:258) evaluates before consulting the registry; [labResearchEvidenceStore.js:142](W:/money-printer-evolution-lab/src/labResearchEvidenceStore.js:142) carries only `auditCount` and `consumed` into the evidence gate, without binding the receipt to the evaluated candidate.

The fresh reproduction asks for candidate B after candidate A and receives A's consumed receipt with `auditCount: 1`; changing only dataset hash reopens the same dates. This is weaker than the chronological-overlap protection already implemented in `experimentContracts.claimHoldout`. **Current Polymarket cannot reach sealed admission because observed latency coverage remains false**, so treat this as a latent correctness fix before any new execution evidence unlocks that path.

**Next step:** atomically reserve disjoint chronological scope before reading sealed outcomes. Bind candidate/incumbent/evaluator identities and the dataset content; return a cached verdict only for the identical experiment. Changed bytes must never grant a second statistical look at the same dates.

### LAB-04 — P2: daily walk-forward slices are not executable transitions between winners

[robinhoodDaily.js:263](W:/money-printer-evolution-lab/src/robinhoodDaily.js:263) selects each fold winner and slices its return series from a full-history simulation. That simulation may already own inventory opened before the fold. Switching to a different winner on the next fold splices in that other candidate's existing position without charging the actual strategy switch. The holdout similarly inherits pre-holdout inventory, while buy-and-hold pays a fresh entry. Terminal holdout liquidation is charged, but fold entry/switch/liquidation costs are not.

[robinhoodDaily.js:171](W:/money-printer-evolution-lab/src/robinhoodDaily.js:171) also pools symbols by averaging their daily returns while explicitly ignoring basket rebalance costs. This is a useful diagnostic, but it is not one deployable portfolio. Equities `replayEquitiesWindow` and weekly crypto rotation already implement separate-window cash starts and boundary costs more carefully.

**Next step:** evaluate fold winners from common cash with prior-close indicator context, next-open entry and terminal liquidation, or simulate one continuously funded strategy with real winner transitions. Use the same boundary convention and portfolio capital for its benchmark. Recompute evidence after fixing the evaluator; archive historical claims under the old version.

### LAB-05 — P2: standing freezes lack a supported recovery/retirement path; unchanged frozen search is repeatedly rescored

[moduleResearch.js:503](W:/money-printer-evolution-lab/src/moduleResearch.js:503) routes equities into prospective evaluation whenever a standing freeze exists. [equitiesProspective.js:5](W:/money-printer-evolution-lab/src/equitiesProspective.js:5) freezes any result carrying a leader, incumbent and holdout end, including a losing historical leader or the incumbent itself. Changes to incumbent parameters or cost assumptions then return a permanent waiting reason at lines 15–16, without a reviewed retirement/rebase operation in the current API. The prospective path also skips the initial evaluator's full bar order/alignment validation; it should validate repaired/appended input before consuming its fresh window.

For intraday crypto, [moduleResearch.js:275](W:/money-printer-evolution-lab/src/moduleResearch.js:275) fixes search at the freeze timestamp but still calls `searchGeneration` on every admitted fresh tape/fitness fingerprint at line 290 and increments lifetime trials at line 314. Those fresh rows advance the holdout but do not change the searched historical tape. The runtime snapshot shows **65,902 trials** while the frozen prospective window has **11,730 rows and zero closes**. This is primarily an efficiency and experiment lifecycle problem; it makes the bar more conservative, not an optimistic return claim.

**Next step:** freeze the candidate and selection trial count once, preserve that manifest, and advance only the fresh evaluator while its study is open. Key historical rescoring to changed training inputs/incumbent assumptions. Provide explicit audited retirement/rebase and crash recovery that retain old windows and losses. Do not refreeze losing candidates automatically or discard a consumed study to obtain a new look.

### LAB-06 — P2, diagnostic-only: historical weather replay can exceed its declared $1 stake

[weatherReplay.js:155](W:/money-printer-evolution-lab/src/weatherReplay.js:155) floors `$1 / price` to determine quantity and adds the taker fee afterwards. Unlike BTC and prospective weather evaluators, it does not decrement quantity until price plus fee fits the stake. The fresh reproduction fills four contracts at $0.25 plus $0.06 fee: **$1.06** spent for a declared $1 stake. This distorts comparisons with current paper sizing, especially near integer-quantity boundaries. Its output remains honestly `RESEARCH_ONLY` and cannot publish a qualified farm proposal.

**Next step:** use the shared exact-size, fee-inclusive stake routine for historical and forward evaluators; include quantity and total spend in diagnostic receipts. Keep unknown forecast publication/depth/fill provenance blocked.

### LAB-07 — P2: source-checkout experiment fingerprints omit active dependencies

[experimentContracts.js:11](W:/money-printer-evolution-lab/src/experimentContracts.js:11) fingerprints only top-level `src/*.js`, excluding nested `src/core` fee/accounting dependencies and the Python diagnostic kernel. `buildProvenance` in [labProvenance.js:97](W:/money-printer-evolution-lab/src/labProvenance.js:97) binds one evaluator source file; its imported strategy/fee dependencies are not part of that code hash. This limits reproduction of source-checkout experiment receipts after a dependent file changes. Installed packaging is stronger: [package-windows.mjs:71](W:/money-printer-evolution-lab/scripts/package-windows.mjs:71) hashes all staged files into BUILD provenance, and that complete fingerprint is used for packaged experiment manifests.

**Next step:** use one recursively hashed evaluator/dependency manifest for source and packaged runs, preserve dirty status and exact evaluated datasets, and make the trader verify the relevant transitive code identity. Do not describe a single-file hash as proof of every dependency.

## Current research state and useful next work

| Area | Fresh observation | Interpretation / next evidence |
| --- | --- | --- |
| Robinhood intraday | Frozen window 11,730 quote rows, 0/20 closes; all eight symbols' p95 expected move below approximately 3% required move; BTC ratio 0.429, ETH 0.525 | Connected and collecting. Short-horizon cost economics block entries; more random search on unchanged data is not the missing evidence. Complete paired prospective evaluator, then test a declared longer horizon with actual account costs. |
| Robinhood daily / rotation | Daily `NO_EDGE`; rotation remains research-only | Repair fold economics and qualification distinction before treating slow historical families as candidates. Preserve real fees and venue/proxy provenance. |
| Stocks/ETFs | `NO_EDGE`; 129 candidates; walk-forward Sharpe 1.44 vs incumbent 1.80; DSR 0.312; execution costs unverified | Incumbent remains preferable on current evidence. Initial historical replay trims a complete suffix after actual provider gaps without inventing prices. Verify costs and freeze/rebase lifecycle, then collect truly new sessions. |
| Kalshi episodes | 0 complete settled outcomes; 100 refused episodes in current handoff | Improve complete executable-offer-to-settlement coverage. Repeated unfinished contracts do not add independent observations. |
| Weather prospective | 11 provenance rows, 0 settled samples, 20 unsettled event/horizon observations | Collection is new. Retain forecast availability, station/date/rule binding and exact settlement evidence; wait for settled dates rather than fabricate a return conclusion. |
| Weather standing search | Current corpus 20,000/20,000 trials; lifetime 478,000 diagnostic trials | Budget backoff is working; best validation result is not qualified evidence. New receipts are more valuable than more variants on this corpus. |
| BTC replay | 1 independent settlement date; validation requires at least 3 | Daily clustering correctly prevents one day from becoming many folds. Current data cannot support its historical validation/holdout. |
| Polymarket global | Candidate historical net return -1.102%; no paper proposal | Current search loses after modeled costs. Observed order timing remains absent. Preserve the latency coverage block and repair latent sealed registry before future admission. |
| Polymarket US combos | `NO_EDGE`, 120 trials; trader says combo beta parked/non-executable | Historical sports combination scores do not establish executable RFQ/fill/cost evidence. Keep them provisional. |
| Copy leader replay | 42 executable receipts, 10 closed outcomes, 1 distinct dated selection snapshot | Current follower receipts are useful. Alternate leader policies cannot borrow observed fills; 14 dated snapshots are required for historical policy comparisons. |
| Wallet crowd | `WAITING_SHARED_COMPUTE_BUDGET` in snapshot; evaluator/ablations remain blocked | CPU headroom was shared with the simultaneous audit test workloads. Do not infer production starvation from this point sample. Study needs copy costs, delayed-quote stress and held-out wallets/assets/regimes. |
| Pump sizing/exits | `SEALED_REVIEW`, `qualified: false`; all qualification checks blocked | Existing experiment is not an admitted winner. The separately queued policy-keyed prospective study remains required; generic furnace scores cannot validate sizing/exit policies. |

## Coverage and protections retained

| Reviewed path | Evidence / limit |
| --- | --- |
| `robinhoodBacktest`, strategy/evidence/evolution, daily/history/rotation/equities/prospective, proposals and module publication | Code and fresh tests checked next-quote or next-open fills, fees, synthetic tags, incumbent identity and current publication routes. Identified weaknesses above; no real order execution attempted. |
| `weatherReplay`, `weatherProspective`, `btcReplay`, shared `kalshiModel`, prediction episode evaluator | Historical calibration is chronological and explicitly model-based; prospective availability and station/date binding are enforced; settlement dates are clustered. Top-of-book historical results remain non-qualifying. Weather stake inconsistency is reproduced. |
| `polymarketTape`, evaluator/evidence/combo research, evidence store/gate/lifecycle/control plane | Global evaluator handles later-book delayed fills, partial depth, shared capital, bid/fee marks and stress. Latency is modeled and therefore blocks sealed qualification. Registry weakness is reproduced. US combos retain distinct module identity and no current promotion. |
| `researchScheduler`, `moduleScheduler`, resource policies/telemetry, compute leases, CPU pool/workers, candidate robustness broker/kernel | Full suite covers durable dedupe, failure backoff, fair grants, cancellation before lease release, restarts, CPU process scope and CUDA parity. Unknown thermal/foreground measurements stay unavailable. GPU diagnostics are explicitly descriptive and cannot select or qualify a strategy. No sustained performance/thermal soak was rerun. |
| Workbench/daemon, standing queue, tape corpus cache, challenger diagnostics, exploratory proposals, forward feedback, leader replay | Independent cadence and fresh-input backoff are tested; standing and challenger results retain `qualificationEffect: NONE`; exploratory books have fixed funding/window identities and unfinished results stay excluded from training. Real runtime collector coverage remains thin. |
| Lab feed, HMAC bridge, project journal, publish/provenance/archive, server/control, desktop supervision/build | Current tests reject foreign/stale inputs and bad signatures, validate exact frozen dataset bytes, prevent cross-site mutations and supervise child ownership. Complete package fingerprint matches reported installed source. Real bridge transport across a second machine and external APIs were not freshly exercised. |
| Wallet crowd and Pump contracts/evaluation | Shared contracts/isolated studies are tested; crowd causality is not asserted and missing cost/stress/generalization evidence remains blocked. Exact policy-keyed prospective Pump study is unfinished separate work. |
| Archived furnace/BEAST | Treated as retained history, not current qualification authority. Active scoring helpers may still support diagnostics. Archived distributed/GPU legacy suites were not rerun; current `test:all` covers all active top-level test files. |

There are no fresh strategy-profitability, live-trading or deployment conclusions in this report. Unit/integration tests establish implementation behavior, not market edge. Runtime observation is one point in time; installed Mac behavior, long-duration collector reliability, exchange authorization and private Robinhood Social access are outside this Lab audit.

## Ranked implementation order

1. **Repair qualification contracts before expanding search:** daily historical flags, executable fold transitions, prospective candidate/incumbent/cash replay with shared capital and open-loss accounting, then chronological single-use sealed reservations. Add regression cases corresponding to the reproductions and preserve invalidated evidence under old evaluator versions.
2. **Complete declared new-data studies:** policy-keyed Pump study, fresh weather/BTC settlements and copy follower receipts. Keep immutable incumbent/parameters/costs/feature/code/dataset identities, one trial ledger, fixed evaluation ends, losses and funding history. Unknown costs or unresolved positions must remain named blockers.
3. **Make experiment ownership economical:** stop rescoring unchanged frozen training, provide durable retirement/rebase/recovery without resetting trial counts or reopening old dates, and reuse one fee-inclusive stake routine plus transitive provenance manifests.
4. **Only then extend useful strategy families and UI explanations:** longer-horizon Robinhood studies with actual costs, explicit unavailable Social source status, simple evidence-progress cards and one build/freshness health view. Preserve CPU headroom and test fallback; device utilization alone is not progress.

Acceptance should include both full suites, shared-core parity, adversarial evidence regression tests, source and installed BUILD/receipt agreement, zero unauthorized live authority, preserved study histories and a concise proof of what new independent data was gained. A candidate that fails after costs is a valid research result.
