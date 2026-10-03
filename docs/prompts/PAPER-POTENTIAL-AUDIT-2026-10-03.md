# Evidence behind the paper-potential prompt

Read-only review on October 3, 2026, approximately 12:40–12:50 EDT. Reviewed both source trees, recent commits, the current/historical project ledgers, prior task summaries, strategy and copy implementations, and local runtime API snapshots. Targeted source review is not an exhaustive correctness audit of every line. No trading settings, runtime books, credentials or installed builds were changed. Tests were inspected, not executed for this prompt-writing task.

The implementation prompt is PAPER-POTENTIAL-BUILD-2026-10-03.md. Recheck all counts and versions when executing it.

1. Verified starting point

- Trader checkout: HEAD 4875c52, package alpha.88. Running /api/state build provenance: alpha.88 at 72b7067, packaged and clean.
- Lab checkout: HEAD 3564df2. Running /api/health: alpha.24 at 3e9e6ad, packaged and clean.
- The modified MONEY_PRINTER_STATUS.md claimed installed alpha.89 / alpha.25. Runtime and .agent-state/RELEASE_STATUS.md instead showed alpha.88 / alpha.24. Several latest source changes were therefore ahead of the running installation.
- Existing dirty files at review start: .claude/launch.json, MONEY_PRINTER_STATUS.md, untracked src/paperBookStore.js and web-demo/money-printer-upload.zip. Left intact.
- Live trader healthy and paper-only; Lab connected. Lab's RETIRED status describes the old furnace heartbeat, not proof the Workbench is stopped. The Workbench was actively running searches.

2. Live paper results at about 12:40 EDT

| Book or system | Observed result | Interpretation |
| --- | --- | --- |
| Scoreboard | 32 rows; 0 beating, 6 not beating, 26 insufficient data | Useful snapshot, not proof the registry covers every persisted book |
| Global Polymarket copy | 68 closes, -$152.816 realized, $353.22 equity on $500 start | Drawdown pause active; recorded peak-to-pause drawdown about 38.5% |
| Copy delay buckets | 13 closes delayed over five minutes accounted for about -$105.08 | Association warrants investigation; does not prove delay caused those losses |
| Copy market categories | All 68 closes classified unknown | Attribution/data normalization gap |
| Kalshi mirror | 567 leader buys checked, 0 matched | 466 unsupported-family misses, 58 unambiguous-contract misses, 43 outcome/team misses |
| Kalshi BTC bot | 13 closes, -$10.64 realized, 2 open | Old and current model results require revision-aware interpretation |
| BTC vol-1.0 farm | 12 closes, +$1.05 realized | Small positive hypothesis, below 30-close farm threshold |
| Weather/NWS bots | 10 open each, 0 settled | Awaiting settlement rather than necessarily stalled |
| Pump scored-wallet copy | 0 closes | Strict prior-wallet evidence is not yet available |
| Robinhood strategy/exploration/practice | 0 closes at snapshot | Probes/new books need lifecycle observation; zero closes alone does not diagnose failure |
| Polymarket US shadow combos | NEAR_END -$32.55/207; LATE -$38.17/362; ANY_LIVE -$1.23/206 | Modeled combo research has not demonstrated an edge |
| Lab standing queue | More than 200,000 weather variants; best validation mean +$0.434/bet on 30 bets | Adaptive validation search, no forward candidate qualification |
| Copy snapshots | 1 daily leaderboard snapshot | More distinct days and executable observation coverage needed |

3. Concrete remaining work found in source

| Area | Finding | Source entry points |
| --- | --- | --- |
| Copy latency | Copy loop cadence is 60 seconds. Global copy settles positions before sequential leader polling and fetches only latest 25 trades per leader. | src/dashboard.js; src/polymarketCopy.js |
| Copy reliability | Source events become seen before processing. Any leader SELL attempts to close the entire follower position. Evicted leaders can continue occupying follow slots. | src/polymarketCopy.js |
| Kalshi mirror | Source selection favors profitable sports leaders without first optimizing target-venue overlap. Mirrored positions lack complete wallet/time provenance; there is no equivalent leader-SELL pipeline. Source now selects 16 sports leaders; installed runtime still showed 8. | src/kalshiMirror.js |
| Pump copy | Qualified wallets need at least 10 prior profitable round trips and profitability excluding their best trip. Fixed exits are 15% TP, 8% SL and one-hour hold; 30-second marks coexist with 10-second freshness. | src/pumpfunCopyPaper.js; src/index.js |
| Crowd research | Baseline/direct-copy/crowd/filter scaffolding already exists. Complete cost, latency, held-out-wallet and regime evidence remains unfinished. | docs/WALLET_CROWD.md; src/crowdContract.js; src/crowdResearch.js |
| Copy replay | Workbench records DAY/WEEK/MONTH top-50 leaderboard snapshots but has no follow-on leader-replay job. Snapshot count alone cannot supply historical follower prices. | Lab src/workbenchDaemon.js |
| Lab execution evidence | Observed Kalshi research refused all 100 audited episodes for NO_POST_DECISION_EXECUTABLE_OFFER. Historical weather replay explicitly lacks execution/availability/one-use holdout verification required by qualified farm admission. | src/botTape.js; src/botFarm.js; Lab src/weatherReplay.js; Lab module state |
| Standing searches | Validation-only weather/BTC search has no publication path. Repeated unchanged-corpus trials, candidate corpus binding and consolidated multiplicity accounting need attention before use. | Lab src/standingQueue.js; src/workbenchDaemon.js |
| Equities data | Lab reported missing BIL/DBC session prices. Daily rotation had 1,178 common days versus 1,823 required. | Lab module state; src/robinhoodRotation.js |
| Daily adapter drift | Trader has a daily executor and walk-forward shadow; Lab comments still say the trader has no daily executor. Verify contracts rather than implement a duplicate. | src/robinhoodDailyBook.js; Lab src/moduleResearch.js |
| US singles | Entry and marking exist, but no complete sell/settlement/autopilot lifecycle in the module. Catch-all read failure creates a fresh $100 default book. | src/polymarketUSSinglesPaper.js |
| Scoreboard coverage | Current reader does not explicitly load standalone singles/combos, native sniper or arbitrage books. Listed-ID uniqueness does not establish inventory completeness. | src/scoreboard.js; associated paper adapters |
| Scoreboard economics | Existing verdict is based on closed outcomes and excludes open marked losses. Keep this diagnostic but do not use it alone for allocating capital. | src/scoreboard.js |
| Remaining loop coupling | Arbitrage tick and native sniper maintenance are still awaited inside the Pump cycle; their activation is coupled to AGGRESSIVE_PAPER. | src/index.js; src/runtime.js |
| Disclosure copy | EDGAR Form 4 parsing exists; a paper disclosure-following strategy and 13F pipeline do not. | src/core/edgar.js; docs/APP-AUDIT-2026-10-03.md |
| Runtime AI budget | Paid application model calls are already build-locked off. Development-agent credits are a different budget. | src/core/localResearch.js; src/core/researchBudget.js |

4. Work already done

Do not repeat the prior improvement prompt wholesale. The source already includes the eight-coin Robinhood probe schedule, longer-horizon search seeds, sealed prospective holdout, daily walk-forward shadow, revision-scoped BTC guard, farm threshold alignment, forward prediction scorecard, shared weather pricing, shared CPU leases, standing validation queue, risk prefetch and venue watchdogs. The Lab has moved to a two-process Workbench architecture; the furnace is archived. See recent commits and status batches PF-9 through PF-22. Runtime may lag source.

The quant research library indexes 5,907 documents. Its metadata inventory is not 5,907 implemented or verified strategies. Existing integration notes identify relevant momentum, volatility, Donchian, ATR and mean-reversion hypotheses and warn about repainting, unavailable derivatives assumptions and uncertain source licensing. Reuse that screening rather than start another broad inventory.

5. External capability checks

Polymarket publishes wallet activity and category/time-period leaderboard APIs. Its documentation now also describes v2 equivalents; revalidate schema, pagination and freshness before changing an adapter. Sources: [wallet activity](https://docs.polymarket.com/api-reference/core/get-user-activity), [leaderboard](https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings), [v2 migration](https://docs.polymarket.com/migrate/data-api-v1-to-v2).

The documented Kalshi public trade response supplies market, price, quantity, side and time, without a trader identity field. That endpoint alone cannot support named-leader copying. Source: [Kalshi Get Trades](https://docs.kalshi.com/api-reference/market/get-trades).

Robinhood's official crypto documentation describes market data and the authenticated user's account/orders. A public other-customer leader feed was not established by this review; external signals should retain their actual source. Source: [Robinhood Crypto Trading API](https://docs.robinhood.com/crypto/trading/).

Form 13F holdings are delayed disclosures, generally due within 45 days after quarter end. Any experiment must use public filing availability rather than quarter-end holdings dates as its action time. Source: [SEC Form 13F instructions](https://www.sec.gov/pdf/form13f.pdf).

6. Recommended emphasis

Spend the intensive pass on complete copy-event capture and exits, achievable execution measurements, separate aggressive forward cohorts, an actual Lab-to-experiment feedback path, and missing paper-book lifecycles. Keep existing records and compare all experiments under explicit capital assumptions. Allocate compute toward distinct hypotheses and new independent observations. Afterwards, deterministic local services can keep trading paper quickly while expensive searches and agent involvement happen only when useful new evidence exists.
