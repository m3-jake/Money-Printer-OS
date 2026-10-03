# Coordinated desktop completion — October 3, 2026

This completes the interrupted brief in `docs/prompts/CLAUDE-COORDINATED-DESKTOP-2026-10-03.md`. The starting installed pair was trader alpha.92 / Lab alpha.27 with both profiles already MAX_RESEARCH. Installation results and measurements are recorded below only after verification.

## Delivered

- Real, bounded, persistent price history for crypto, equities, Pump ticks and stored prediction-market observations. History keeps sources, observed and available times, missing sides, gaps, session calendars/early closes, and IEX/SIP provenance. Candle closes and session bars remain distinguishable from executable quotes.
- A compact opening Command Center, lazy paginated contracts, category summaries, search, persistent watchlists and synchronized ranges. All monitored coverage and omitted history are accounted for. The shared design tokens apply throughout trader windows and Lab tabs. Automatic window shrinking is removed; primary charts and module status share the available space.
- A durable coordinator inside the existing Intelligence/event-bus system. It records objectives, evidence requirements, priorities, freshness, dependencies, bounded dispatch, retries, decisions and completion receipts. Its Lab request consumer uses existing worker lanes, leases and cooldowns. Unchanged evidence does not create duplicate work, active work emits bounded heartbeats, and priority aging avoids starvation.
- Frozen evaluated dataset snapshots, evaluator/source/output hashes and matching receipts bind Lab candidates to trader identities. Tests exercise both verified-but-rejected historical proposals and a real Lab exploratory proposal admitted to a separate frozen $25 paper book, plus its scoreboard/coordinator feedback path. No fabricated trades or qualification are needed for this trace.
- Copy funnel by platform and frozen policy: discovery, rejected observations, eligibility, followed leaders, copies, completed positions, after-cost outcomes and reasons. Point-in-time membership survives rediscovery. All scored Pump wallets remain available internally; public display and wallet-directory pagination report omissions. Losing incumbent books and pauses remain intact.
- Durable, adaptive mint backlogs and wallet-specific exit collection inside the existing paced credit cap, with separate method/cost attribution. Partial work survives budget stops. Target-specific deduplication and multi-token signature accounting prevent lost or duplicated events.
- Weather forecast request coalescing, durable receipt/revision availability and explicit station/date/unit/source binding. Missing or partial rules remain unknown. New prospective scoring binds decision-time forecasts to settlement truth, horizon, location, season and uncertainty; it rejects crossed books and over-late next quotes. Model runs remain unknown when providers do not state them.
- Whole settlement-date BTC splits and changed-settlement wakeups. Authentic equity SIP repair recovers early/interior IEX gaps and retains previous history on partial provider failure. The protocol and independent-day requirements remain unchanged.
- Trader-owned, byte-shared bounded ATR, volatility-scaled trend and mean-reversion adapters match the Lab research helpers. Capability is separate from frozen candidate admission and prospective qualification; incumbent/default policies are preserved.
- Space-aware paired installer preflight, verified backups/evidence store and actual process-family CPU/memory accounting are included in the release. Previously unwired installer/process tests now participate in the full suite.

## Evidence

| Check | Result |
|---|---|
| Initial completed trader full suite | 1,411 executions; 1,391 pass, 20 intentional live-order skips, 0 failures |
| Final trader full suite | 1419 executions; 1399 pass, 20 intentional live-order skips, 0 failures |
| Lab alpha.28 full suite | 365 pass, no failures or skips; real CUDA parity, persistent-worker and VRAM checks included |
| UI focused suite | 127 pass after final history/session review; final log is `ui-tests.log` |
| History/session focused checks | 11 pass, including early closes and per-bar SIP source |
| Collector regression checks | Budget-stop exit retention, deduplication, forecast restart/revisions, source binding and authentic gap repair |
| UI inspection | Actual source UI against read-only live-data previews; screenshots and dimension/interaction checks in `ui/` |

GPU checks initially timed out under simultaneous test/research load. The Lab resource test files now run sequentially while their actual concurrency checks remain active. Production deadlines, VRAM limits and CPU fallback are unchanged. Final real CUDA tests pass; the failed diagnostic logs are retained as evidence.

The deterministic indexer simulation uses a synthetic chain and the same paced cap, not market outcomes:

| 120-minute simulation | Before | After |
|---|---:|---:|
| Credits consumed | 593 | 603 |
| Swap events captured | 220 | 283 |
| Completed round trips captured | 4 | 70 |
| Unmatched sells | 103 | 0 |
| Round trips per 100 credits | 0.67 | 11.61 |

The extra 10 consumed credits fit the same cap; no provider budget was raised. `indexer-simulation-before.json` and `indexer-simulation-after.json` state their synthetic scope explicitly. These figures establish collection coverage, not profitable copying.

Provider behavior was checked against the official [Alpaca market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) and [Open-Meteo forecast documentation](https://open-meteo.com/en/docs). Historical SIP requests end at least 15 minutes before the request time; the operational forecast endpoint's stitched series is not relabelled as a known individual model run.

## Remaining evidence and external waits

| Area | Current constraint | Next automatic action |
|---|---|---|
| Pump strict wallet copy | Prior robust wallet outcomes and exact-size follower evidence | Capture buys/exits, refresh complete scorecard, admit only leaders passing the existing strict rule |
| Pump exploratory cohorts | Forward closes and costs | Continue their separately funded, frozen policies and retain all outcomes |
| Robinhood crypto | Genuine quote coverage, source-quality gates and after-cost prospective closes | Collect forward quotes; research wakes only on changed evidence |
| Equity research | Authentic long-history coverage and untouched validation windows | Repair provider gaps with labelled SIP observations; rerun only when evidence changes |
| Weather | New availability-bearing forecasts must settle under exact contract rules | Archive current receipts, collect actual settlements and evaluate independent dates |
| BTC ranges | Additional independent settlement dates | Wake replay on new settlement truth, keeping same-day siblings together |
| Global CLOB research | Completed depth days and executable costs | Collect depth/resolution evidence and validate eligible changed corpora |
| Global wallet copy | Completed follower positions and matched controls | Continue exit supervision and after-cost attribution; retain incumbent drawdown pause |
| Polymarket US / combos | Previously reported key rejection and provider beta capability | Remain visibly unavailable where unsupported; retry configured public collection within existing limits |
| Sports / Kalshi mirrors | Exact event identity, fresh prospective leader buys and costs | Continue date/team/outcome binding and record matching failures |
| Macro / weather / filings / wallet-flow links | Timestamp-safe mapping and prospective ablation | Collect explicit mapped observations; narratives and correlation never establish edge |
| New challenger families | Frozen candidate admission plus genuine prospective outcomes | Expose adapter capability, retain existing admission gates and wait for eligible evidence |

Actual per-module stage, blocker, dependency, receipt and next action after release are saved in `installed-after.json` under the coordinator endpoint. Trading remains paper only; live activation/automatic live promotion and recurring paid models remain disabled. Shipping code or passing tests does not establish profitability.

## Installation

Pending final release smoke checks and paired receipt verification. Before-install accounting and runtime evidence is saved in `installed-before.json`; the installer preserves data and writes matching paired receipts to both installed roots. Unrelated launch configuration, user status content, older report files, upload ZIP and Lab workflow files are preserved.
