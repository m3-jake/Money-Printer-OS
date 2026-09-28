# Wallet & Crowd — first paired paper-research slice

Date: 2026-09-28. Contract: `mpo.wallet-crowd.v1`.

## Scope and ownership

Money Printer OS observes events, keeps immutable first-observed evidence, makes governed **isolated paper** decisions, manages existing experimental exits and exposes Command Center controls. Evolution Lab builds the point-in-time observational model and publishes evaluation through `lab-link`. Its bounded worker runs outside the Lab UI thread and acquires the existing shared CPU lease. There are no model/API-generation calls and no live-order transport in this feature.

This first slice implements direct-copy comparison, crowd-aware entry filtering/timing, WAIT reassessment, AVOID and NO_TRADE. EXIT_ADJUSTMENT and CONFIRMED_REVERSAL are explicit unsupported actions, not fabricated spot shorting or silent changes to incumbent positions. No existing strategy, paper cash balance, historical loss, open-position exit policy, Agent Lab worktree or account configuration is replaced.

## Official API capability review

Reviewed 2026-09-28. Product boundaries matter; documented availability is not the same as a configured collector.

| Integration | Public identity and activity | This release's actual scope |
| --- | --- | --- |
| Solana/Pump.fun | JSON-parsed finalized signer transactions; legacy, v0 and v1 transaction versions | Existing bounded mint-reference RPC indexer only. Complete coverage is asserted only for an explicitly completed recorded interval. This is not a whole-market feed. |
| PumpPortal | Account-trade and token-trade streams can expose wallet activity | No new subscriptions. The provider documents metered token/account trade streams; leader-only subscriptions cannot establish follower coverage. |
| Polymarket international | Data API trades expose proxy-wallet identifiers; public books are separate aggregate evidence | Capability documented; no new wallet/crowd adapter implemented. Existing anonymous book collection is not reclassified as identified traders. |
| Polymarket US | Separate product and integration | Public follower/account identity was not established; international proxy-wallet assumptions are not imported. |
| Kalshi | Public trades/order book; own-account records are distinct | Public trade response has no other-trader identity field. No individual follower inference. Existing paper module unchanged. |
| Robinhood | Existing paper quote/own-account integrations | No public other-account identity collector verified or added. Existing code-level live barrier remains intact. |
| Jupiter quotes | Exact-input route/minimum-output evidence | Reuses the existing keyless Metis V1 collector and its existing caps. Current documentation supersedes Metis V1 with Swap V2 and shows authenticated `api.jup.ag` examples; this release does not add credentials or assert permanent support for the legacy keyless endpoint. Failed or stale routes cannot become fills. |

Primary documentation:
- https://solana.com/developers/guides/advanced/versions
- https://solana.com/docs/rpc/http/gettransaction
- https://solana.com/docs/rpc/websocket/logssubscribe
- https://pumpportal.fun/fees/
- https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets
- https://docs.polymarket.us/
- https://docs.kalshi.com/api-reference/market/get-trades
- https://docs.robinhood.com/crypto/trading/
- https://developers.jup.ag/docs/swap/v1/get-quote

## Evidence and policy

The indexer now requests finalized v1-compatible parsed transactions, retains earlier successful receipts when a later RPC fails, retries unavailable transactions without advancing their cursor and explicitly records quarantine after three unavailable reads. Existing daily/provider quota accounting is retained. Successful asset intervals and incomplete/backlogged intervals remain different.

`crowdContract.js` rejects missing/future observation clocks, failed or nonfinal observations for trading, ambiguous multi-asset cost basis, unknown swap programs and create/transfer-like records. Net signer balance deltas remain explicitly **not verified fills**. Duplicate receipts retain their original first-observed time. Conflicting economics invalidate evidence rather than rewriting it.

A fixed first-observed candidate universe prevents choosing today's winners and retrospectively copying their history. Candidates are evaluated by forward copy-realizable outcomes, not reported wallet profit. The model groups overlapping asset episodes, compares signed post-event flow with mirrored pre-event activity, excludes supplied common-signal/related-account confounds, records repeated cross-asset follower delays and economic concentration, and produces deterministic clustered uncertainty intervals. Address counts are never people or subscribers. These controls do not establish causation or remove all news/shared-signal confounding.

The decision clock is the OS's actual observation/decision time. A BUY quote alone is not exit capacity: entry decisions require a valid whole-position SELL route as well. The policy considers current entry chase, measured historical copy outcomes, uncertainty, remaining signed follow-on flow after detection delay and observed exit capacity. Unknown transaction/failure/data costs prevent a quote-only history from qualifying a policy.

## Comparison and controls

Command Center exposes Observe Only, Shadow Comparison (default), and a typed-confirmation Opt-In Paper Experiment. Capital is 0.15 **paper** SOL per alternative by default and is frozen when the study starts. Existing study capital is never reset or resized through the control endpoint.

Baseline, direct-copy, crowd-aware, and baseline-plus-crowd-filter books are separate alternatives with the same starting capital, immutable incumbent exit policy and conservative shared sizing/quote primitives. Their profits must never be added together. Phase and operator-mode cohorts remain separate. The incumbent's paper book is not mutated.

A fixed common horizon includes deliberate NO_TRADE as zero exposure; missing/still-open exits remain unknown. Model-based marks are labeled, not presented as executable liquidation prices. Existing experimental positions continue to be managed after Observe Only, global entry refusal, phase transitions and entry-budget exhaustion. Pending buys are canceled when entries are disabled. Real dispatch is refused in code.

The fixed protocol uses 24-hour training, an embargo at least as long as the maximum holding window, 24-hour validation, another embargo, then a blinded 48-hour holdout. Prior assets are purged from holdout entry selection. The training model freezes; holdout observations cannot train it. One model configuration, 32 evaluated wallets, 512 eligible recorded decisions, and three accepted episodes per hour bound search/entry work. Raw capture, decisions, quote receipts, model hashes and replay-input frames remain inspectable.

## Qualification is deliberately incomplete until evidence exists

The evaluator computes common-horizon comparisons, baseline-filter effects and leave-largest-wallet/token/best-outcome diagnostics. Correlated follower transactions are not independent samples. Insufficient samples, negative incremental results and NO_EDGE are legitimate results.

**No edge has been demonstrated by this implementation.** Quote-only results have unknown network/priority/rent/failed-transaction/material-data costs and uncalibrated execution-latency risk. Doubled-latency reexecution, fully costed stress, independently held-out-wallet results and different-regime generalization are NOT marked passed. They remain explicit qualification blockers; this first slice does not implement a complete cross-regime/delayed-order reexecution research program. No favorable score or large variant count overrides those blockers. There is no automatic promotion, incumbent replacement or live activation.

## Bounded work and persistence

The original RPC credit and pacing ledger is unchanged. Existing Jupiter quote calls share the prior 4,096 total / 180 hourly / four-per-batch caps; changing protocol does not reset them. Existing market observation request caps also remain shared. Managed exits are prioritized over new entries. No new paid feed, API key or paid model service is activated.

Capture uses checksummed append-only frames plus atomic checkpoints, retaining source, observed and ingestion clocks. The hot event/window/model budgets are explicit; storage exhaustion blocks entries rather than deleting losses or claiming coverage. Replay inputs and the models referenced by decisions are size-bounded separately. Corrupt snapshots/journals are surfaced, not silently reset. Capture/quote work stays in the existing collector process; Lab inference is bounded to one leased worker with a deadline.

Runtime files under the OS's existing data directory:
- `wallet-crowd-capture.json`, `wallet-crowd-events.ndjson`
- `wallet-crowd-baseline.json`, `wallet-crowd-protocol.json`, `wallet-crowd-study.json`
- `wallet-crowd-control.json`, `wallet-crowd-view.json`, `wallet-crowd-requests.json`
- `wallet-crowd-inputs/`, `lab-link/wallet-crowd-model.json`, `lab-link/wallet-crowd-evaluation.json`

Both applications expose `GET /api/wallet-crowd`. OS control writes use the existing loopback/origin mutation guard at `POST /api/wallet-crowd/control`. Operator-facing status includes coverage, source freshness/backlog, quote errors, separate comparisons, selected actions and qualification blockers.

## Verification and rollback

Run `npm run test:wallet-crowd` and each application's `npm run test:all`. Deterministic fixtures cover profitable leader / losing delayed copy, early versus exhausted reactions, common signals, related addresses, a reversal that never arrives, stale/missing evidence, quote sizes/timing/partial-depth behavior, duplicate exposure, phase blinding, baseline integrity, journal recovery, real-order refusal and management after mode changes. UI markup is parsed and unsafe source text is escaped.

The installed Electron executable is also used as Node for complete suites, with `ELECTRON_RUN_AS_NODE=1` and `ELECTRON_NO_ASAR=1` only in raw-file unit-test processes. Packaged ASAR smoke checks run separately with normal ASAR support. This distinction is required for tests that intentionally write malformed `.asar` fixtures; no release safeguard is bypassed. Electron documents these switches at https://www.electronjs.org/docs/latest/api/environment-variables .

Pre-edit baseline pair: OS `5dbe1b75d2749e5ca660f11bbf279923f67219a8`; Lab `187f780cf1befa5bc0d165da18750ba4596f2772`.
Source/configuration and available authoritative JSON state backups: `W:/mpo-repair-backups/crowd-aware-20260928-1753`. This is not claimed to be a transactional snapshot of every SQLite database.

Paired local installation uses the existing `scripts/update-local-install.ps1 -NonInteractive` process only after both archives pass smoke tests. Its paired receipts and health APIs determine installed commits; a source version alone does not prove installation. Preserve both ASAR rollback artifacts. The Mac was offline during initial inspection; no remote installation is claimed without subsequent verification. OS has its existing GitHub origin; Lab initially has no configured Git remote.