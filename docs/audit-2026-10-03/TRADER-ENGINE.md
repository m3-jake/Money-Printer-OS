# Trader engine audit — 2026-10-03

Reviewed source HEAD `b36527bc0b3dac00dcb630cd75873176bdffc142` (alpha.93; installed engine source is separately recorded as `89fa8d7`). This is a fresh source review, with isolated reproductions, rather than a restatement of the earlier release report. No running app, settings, bankroll, books, credentials, provider budget, or application source was changed.

The installed main runtime remains paper-only. Several exported legacy paths and paper-research adoption paths are weaker than the common registry and the broad documentation claims. There is no demonstrated profitable qualified strategy in this review. Missing market evidence should not be repaired by reducing gates or inventing observations.

## Findings

### T1 — P1: the live boundary permits standalone dispatch when the common database is absent

Evidence: `src/core/executionBoundary.js:5`, `:22`, `:28`; Jupiter dispatch `src/jupiter.js:14` and exported buys/sells `:15`; Jito `src/providers.js:4`; Polymarket US manual order `src/polymarketUS.js:160`, signed combo transport `src/polymarketUSCombos.js:115`. The guard refuses only if this module instance has been activated or the selected data directory contains `mpos-core.sqlite`. The code explicitly retains legacy standalone compatibility. A new standalone process pointing at a fresh directory passes the live guard. Jupiter/Jito rely on the guard and credentials; these helpers do not independently enforce the main engine's paper mode or entry flag.

Fresh reproduction: the saved no-network probe calls `assertLiveDispatchAllowed` with a nonexistent directory beneath a temporary directory and receives `ALLOWED_WITH_NO_LEDGER`. No signer, order, or provider call was used. This proves the guard gap, not an observed live transaction.

Impact: an exported helper or future tool entry point can submit real transactions outside main runtime initialization, contrary to README's build-wide lock claim. Normal main startup activates the boundary, and an already initialized runtime directory provides a durable refusal. Existing live-gate tests prove those two cases, but not refusal in a fresh standalone directory.

Next step: make real submission unconditionally unavailable in the distributed paper build; preserve read-only quotes, unsigned plans, cancellation, and reconciliation. Test every exported order transport in a fresh process and a fresh directory, with fake credentials and a fail-on-network mock. Do not reinterpret this finding as authorization to implement live execution.

### T2 — P1: a corrupted wallet credit ledger silently replenishes the daily cap

Evidence: `src/transactionIndexer.js:102`, `:103`, `:107`, `:111`, `:116`. `readJson(file,{})` converts malformed or unreadable existing budget bytes into an empty object. `load()` then creates a fresh zero-credit day. `writeJson` falls back to copying over the destination after a failed rename and suppresses errors from that fallback. A charged request can therefore be admitted without a reliable durable receipt. The read-modify-write also has no cross-process exclusion, despite the comment saying the ledger is shared across paths/processes.

Fresh reproduction: isolated cap 5; `charge(5)` succeeds; overwrite only that temporary ledger with malformed JSON; a second `charge(5)` succeeds. Ten credits were admitted; the retained counter reports five. The saved probe reproduces it without a network call.

Impact: storage corruption/write failure, and potentially concurrent writers, weaken the explicitly configured credit cap. This is a cap-enforcement defect, not a recommendation to purchase capacity. The collector lock and disabled default alpha worker reduce ordinary concurrency, but do not protect other exported indexing paths or storage corruption.

Next step: a transactional durable reservation ledger (or strict cross-process lock plus atomic fsynced writes), typed state validation, and a recovery refusal for an initialized unreadable ledger. Missing-new and missing-after-initialization must differ. Test restart, corruption, unwritable destination, concurrent reservations, UTC rollover, and exact cap boundaries. Preserve consumed credits and present recovery status.

Related scope limit: `src/apiUnitEconomics.js:25`, `:40`, `:101`, `:254` keeps the configured USD spend-cap counter in process memory; role files are reporting snapshots, not hydration or a global reservation ledger. A positive configured cap is therefore per process lifetime rather than durable across restarts/processes. Define the cap scope explicitly and share the durable reservation mechanism where a global daily cap is promised; preserve default/unpriced semantics.

### T3 — P1: Robinhood crypto legacy admission trusts the Lab's incomplete prospective summary

Evidence: `src/robinhoodLab.js:171`, `:179`, `:181`, `:194`. Admission checks evaluator version, a syntactically valid dataset hash, `beatsIncumbent`, holdout pass, 20 closes, PF at least 1.2, positive closed P/L, genuine Robinhood share, and a recent `through`. It does not bind and independently verify the frozen prospective portfolio, aggregate capital, outstanding positions, liquidation costs/marks, or an incumbent evaluated on the same future observations. The companion Lab audit identifies those deficiencies in its prospective evaluator and promotion path.

Impact: a false-ready Lab summary is accepted as the basis for a paper trial once the trader's separate prerequisites are satisfied. `src/core/labSync.js` does enforce verified frozen provenance and the stricter common promotion gate, but that registry mirror is not consulted by this legacy trial admission path. A strong mirror does not harden every adoption route.

Protections confirmed: auto-apply is off by default (`src/robinhoodLab.js:143`, `:239`); admission requires the running incumbent hash, known positive cash, a flat paper portfolio, and at least 20 genuine incumbent closes/elapsed venue evidence (`:183`–`:191`). Applied trials have persisted preparation and rollback phases, current marked loss monitoring, a 3% loss budget, and a 14-day idle rollback (`:141`, `:156`, `:210`). These mitigate paper losses; they do not correct biased qualification. Real orders remain locked.

Next step: fix the Lab evaluator first, then require the same receipt-bound verified evidence at the actual apply boundary. A candidate and frozen incumbent must consume the same future opportunities under equal aggregate capital and include open marked losses, failed/missing exits, fees, and drawdown. Test a positive-close summary containing a losing open position, per-symbol capital multiplication, and mismatched or fabricated summary hashes. Keep the current incumbent and all trial/history records.

### T4 — P1: daily Robinhood proposals can alter the incumbent from historical-only selection

Evidence: `src/robinhoodDailyBook.js:131`, `:139`, `:143`, `:333`, `:338`. `pickDailyStrategy` accepts an in-bounds proposal with the Lab's champion/paper flags. It requires no frozen prospective receipts, evaluator/data binding, age check, or incumbent basis. `runDailyOnce` replaces `book.source` every pass when a new accepted proposal arrives, while retaining the incumbent's cash, positions, and pending exits. It can also switch to defaults after withdrawal. The Lab's daily evaluator's historical selection defects are described in the companion audit.

Impact: historical selection may change a forward incumbent book; held positions can be managed by a different policy and marks relabelled under the new hash. This is a research lineage/admission flaw. Existing trade records are retained and entry/exit hashes differ explicitly when policies change; that honest history does not make an uncontrolled strategy switch a prospective comparison.

Protections confirmed: new forward fills require fresh supported Robinhood quotes after decision latency and exact-size evidence (`:251`, `:264`), missing exit quotes retain intents, and daily qualification requires observed execution evidence. The candle-open research shadow is explicitly unqualified. No real orders result.

Next step: preserve the incumbent, create a separately funded and frozen exploratory cohort for nominated daily policies, and require prospective binding at eventual adoption. Freeze policy on open positions and retain an accepted policy receipt after proposal expiry/withdrawal, as the equities lane already does. Do not suppress the fee/volatility gate to manufacture activity.

### T5 — P2: perfect correlation is accidentally discarded from aggressive portfolio risk

Evidence: `src/portfolioRisk.js:24`, `:26`; caller `src/index.js:209`; limited coverage `tests/portfolio-risk.test.mjs:19`. Off-diagonal correlation is selected with `value < 1`, which also removes perfectly correlated pairs. This excludes diagonal entries by value instead of by identity. Four holdings of 2 SOL with explicit correlations of 1 produce average correlation zero and effective exposure 2 SOL, below a 5 SOL cap despite total exposure 8 SOL.

Fresh reproduction: the saved probe returns `{totalExposureSol:8,effectiveExposureSol:2,averageCorrelation:0,allowed:true,capSol:5}`. Narrative caps are isolated to make the correlated-cap error visible. The helper is used for aggressive paper entries; main currently supplies default correlations, so explicit perfect-correlation input is not demonstrated in the current runtime.

Next step: exclude diagonal indices, retain off-diagonal 1, define and document effective exposure, and assess post-order risk including the proposed size and staged reservations. Test perfect, zero, negative, unequal-weight, and single-position correlations. Preserve independent hard position/total caps.

### T6 — P2: wallet scorecards call chain time point-in-time evidence without arrival-time gating

Evidence: `src/walletScorecard.js:28`–`:30`; `src/transactionIndexer.js:170`, `:284`, `:286`. The collector stamps `raw.firstObservedAt/ingestedAt`, but `scoreIndexedWallets` drops those fields, and `scoreWallets` filters only on-chain timestamps. A later backfilled transaction with an earlier chain timestamp can alter a score evaluated for a previous `asOf`.

Fresh reproduction: buy/sell at times 1000/2000, both first observed at 9000, evaluated as of 5000, count as one profitable trip. The saved probe uses a disposable random public identity and no RPC.

Impact: the pure scorecard is unsafe for historical point-in-time replay claims. Current-time scoring of already received historical transactions is legitimate discovery and is not itself a historical fill. The strict Pump copy lane additionally requires that the persisted scorecard already existed before the leader signal (`src/pumpfunCopyPaper.js:36`, `:176`); this protects the current live-observed paper copy path against retroactive leader selection. No Lab `scoreWallets` consumer was found in this review.

Next step: retain explicit received/available timestamps through the database adapter; gate point-in-time scoring on both chain and arrival times, with missing provenance unknown. Keep a distinct historical diagnostic mode if desired. Test delayed ingestion, later revisions/duplicates, same-signature multi-token events, and exact decision-time equality.

### T7 — P2: the fresh wired full suite stops on documentation drift

Parent verification: `npm run test:all` fails the first `test:wiring` group because the documented target count is 37 while the graph reaches 36. Evidence: `MONEY_PRINTER_STATUS.md:255`, `tests/doc-drift.test.mjs:67`. The fresh parent log is `docs/audit-2026-10-03/trader-tests.log`; subsequent groups are being run separately and are reported in the root audit.

Additional current-source drift: README opens at alpha.83/Lab alpha.20 while package.json is alpha.93 and the current release receipt is alpha.93/alpha.28. README also says insider/13F research is unimplemented although `src/disclosurePaper.js`, `src/disclosureEquityQuotes.js` and wired `tests/disclosure-equity-research.test.mjs` exist; credentials/complete forward history remain actual blockers. Some `.agent-state/KNOWN_BUGS.md` historical entries read as current limitations despite later repairs.

Next step: reconcile operator-facing current statements with HEAD, retain historical audit text in labelled history, and make the full suite green without weakening assertions. The historical passing release log is evidence of that release, not proof that today's full command passed.

### T8 — P1: Pump copy exit maintenance is stalled while the headline app reports healthy

Observed fresh evidence: the parent's sanitized `docs/audit-2026-10-03/runtime-snapshot.json` shows `health.venues['pumpfun-copy-exits']` STALLED, with a running duration about 610,567 ms, 81 runs, and 60 skipped invocations. A follow-up observation several minutes later still showed this stall and the two emerging-copy positions remained open. This is an observed operational block, not a failure inferred from one moment under test load. The specific provider/promise that stopped settling was not established.

Reachable code: `src/dashboard.js:542` registers one venue that awaits `Promise.allSettled` over the strict and two exploratory books' `maintain()` calls. Each book serializes its signals and maintenance in a queue (`src/pumpfunCopyPaper.js:107`, `:220`) and awaits `adapter.quote` with no whole-call/pass deadline (`:146`). A stuck previous signal also holds that queue. `src/venueLoop.js:13` detects a stall, but only reports it and skips later runs; it does not cancel or establish a recovery path. `src/pumpfunNativePaper.js:48` applies a six-second timer to individual RPC fetches, which does not guarantee a bounded queue or a settling downstream promise. `scheduleMaintain` exists but this dashboard venue does not use it; its single-flight behavior would not by itself cure a hung quote.

Impact: those open paper positions receive no new liquidation marks/exits, entry tasks may queue behind the hung work, and one nonsettling book suppresses recurring maintenance for the whole copy group. Other venues and the UI keep running, which is good isolation, but an overall healthy headline can mask this module's unresolved exit obligation. Do not infer an executable loss/profit from stale values or erase positions to recover.

Next step: isolate exit maintenance per book; add a whole-pass budget and a caller deadline that covers adapter/SDK reads, JSON parsing, fallback and queue wait; preserve exit intents and capital. Retain the old flight until it actually drains, discard late results before any book mutation, and retry using bounded backoff. Do not start overlapping writers or refund stuck positions. Add a targeted fault injection for a quote that ignores cancellation, a blocked earlier signal, two-book isolation, stale late results, queue saturation, and exactly-once close accounting. Present unresolved exit maintenance in overall health and the coordinator. Preserve the fresh runtime evidence before repair.

## Highest-value research work that remains

The policy-keyed Pump prospective study is a genuine open implementation, not a malfunction of the old frozen study. `src/pumpProfitRuntime.js:100`–`:103` correctly refuses new opportunities when the active policy hash differs from its immutable baseline. `reports/queued-pump-policy-study/TASK.md` specifies isolated new generations, future-only opportunities, untouched validation, equal-capital paired controls, independent outcomes, drawdown, best-trade robustness, multiple-testing gates, and preserved old bytes. Existing nominal capital, loss pauses, policy migration records, and historical trade outcomes must survive.

Fix T1/T2/T8 and the admission correctness defects before making larger automation or resource changes. Then implement that narrow generation task: it is more valuable than adding another strategy family, loosening costs, or increasing machine utilization. Start a fresh prospective timestamp; historical nominations cannot enter validation. Missing executable costs and adequate independent outcomes may still prevent qualification.

Other prerequisites remain evidence/provider issues: authentic forward Robinhood time and volatility above modeled costs; stock/ETF credentials and verified executable cost assumptions; exact Kalshi station/date/source binding and independent settled days; US authentication/RFQ account eligibility; complete copy exits and qualifying wallets. No private Robinhood Social API or web follower access is implemented. A manual mobile-profile research import would require user-provided observations and should remain distinct from a complete ledger or automatic copy system.

## Reviewed controls and limits

| Area | Freshly reviewed evidence | Assessment |
|---|---|---|
| Core accounting | `src/core/ledger.js`, `risk.js`, `valuation.js`, `src/accounting.js`, `store.js` | Fixed-point common ledger, append-only source keys, cash/oversell guards, paper/live partitioning and load/save identity checks are present. No new core cash identity bug was established. Legacy books and native-currency books retain separate scope. |
| Core admission/provenance | `src/core/strategies.js`, `labSync.js`, `championState.js` | Evaluator/strategy identity gates, immutable dataset binding, evidence invalidation and no LIVE transition are enforced. These controls are stronger than T3/T4 adoption paths. Hash consistency is not external proof of profitable fills. |
| Coordination | `src/core/coordinator.js`, `intelligence.js` | Durable bounded requests, open-request deduplication, aging priority, backoff, receipts and advisory authority are present. No agentic real execution or paid-model calls are introduced by this loop. |
| Pump research/execution | `pumpProfitPolicy.js`, `pumpProfitRuntime.js`, `pumpfunCopyPaper.js`, `pumpfunNativePaper.js`, `index.js` | Pinned policy, baseline mismatch refusal, exact-size copy quotes, quote freshness, fee-aware accounting and read-only native transport allowlist are present. Simulator/provisional quote outcomes must not become qualified executable evidence. |
| Indexer/copy | `transactionIndexer.js`, `walletScorecard.js`, `leaderDiscovery.js`, `copyFunnel.js`, `copyTrade.js` | Durable bounded backlog/follow-ups and collector credit attribution improve completeness. T2/T6 remain. Strict copy uses prior scorecards; leader returns remain discovery leads. |
| Robinhood | `robinhoodTransport.js`, `robinhoodBacktest.js`, `robinhoodLab.js`, `robinhoodDailyBook.js`, `robinhoodEquities.js` | Robinhood transport has a separate hard false live constant. Crypto trial rollback and executable daily quotes are positive controls. T3/T4 remain. Equities demands frozen 126-session prospective evidence and known unchanged costs. |
| Weather | `weatherProvenance.js` and Lab handoff call sites | Station/date/Fahrenheit/daily-max/source binding, persisted receipt/revision timestamps, coalescing and provider budgets are present. Partial or mismatched rules remain unknown/rejected. |
| Recovery/cancellation | `atomicRename.js`, `paperBookStore.js`, `copyWorkBudget.js`, `marketRequests.js`, collector loop | Most paper books refuse damaged primaries; atomic fsynced publication and bounded request cancellation are present. T2 is a weaker legacy persistence path. |

Pump-copy maintenance requires the targeted repair/soak in T8. A timer alone is insufficient: racing a deadline while allowing an old quote to mutate the book later would introduce duplicate exits or overwrite newer state. Recoverable exit obligations and writer ownership must be explicit.

This review sampled the safety-critical engine and research paths above, coordinated fresh full-suite execution with the parent, and ran four adversarial pure/temporary-file probes. It did not simulate real submission, alter native paper books, measure actual exchange fills, inspect secrets/raw Robinhood account files, exhaustively inspect every legacy/UI asset, or perform a new third-party dependency vulnerability scan. The root audit incorporates Lab, UI, runtime, and aggregate test evidence separately.

## Reproduce the additional probes

From the repository root, run `node docs/audit-2026-10-03/trader-engine-probes.mjs`. Expected observed defects are asserted and printed. It creates and deletes only a checked temporary directory, performs no fetch, and writes no app state. These are evidence probes for an audit, not tests added to the application suite.
