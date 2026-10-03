You are taking over Money Printer OS and Evolution Lab as their principal engineer, research architect and product designer. Work in both repositories until you have delivered a materially better integrated system, verified it and installed the local paired release. Do not stop at an audit, plan, mockup or another “maximum research” setting.

My priorities are: a beautiful, readable workstation; every module operating reliably; continuous research that produces useful evidence and better paper experiments; better copy-trader discovery and evaluation; and a Command Center that actually coordinates the system.

Repositories:
- Money Printer OS: W:/money-printer-os
- Evolution Lab: W:/money-printer-evolution-lab
- Live local APIs: http://127.0.0.1:8792 and http://127.0.0.1:8793

Use parallel agents where available, with clear file ownership. Continue across context compaction and leave a concise checkpoint. Make routine engineering decisions without repeatedly asking me for permission. Local edits, tests, builds and a verified paired installation are authorized. Do not enable real trading, buy services, increase paid API budgets, publish releases or push publicly.

## Establish current reality first

Read local instructions and recent Git history in both repos. Read docs/CONTINUOUS_RESEARCH.md, reports/continuous-research-2026-10-03/README.md, the recent paper-potential build records, shared-core.json and relevant .agent-state files. Older README/status/backlog documents contain stale versions and “Pump.fun parked” claims: reconcile them against code, installed PAIRED-RELEASE.json receipts and live APIs before acting. Preserve unrelated working changes.

The last verified installed pair was trader alpha.92 at 847109b and Lab alpha.27 at 1f252a9. Both already run MAX_RESEARCH. Fresh module evidence is checked every 500 ms with a one-second cooldown; ready standing batches hand off after 25 ms. Candidate discovery and minute-by-minute copy feedback already exist. Do not spend this run rebuilding those features.

The inspected system had roughly 166 Polymarket candidates, 12 watched wallets and 90 independent paper books, with none qualifying as beating baseline. Pump token discovery/trading is active; strict Pump wallet-copy still lacks qualifying wallet evidence, while separate exploratory cohorts exist. Counts change: measure again.

## 1. Rebuild the visual experience throughout both apps

The current Command Center fits largely by compressing text and shrinking its contents. Its atlas is mostly current prices, dense colored rectangles and tiny result cells, rather than readable price-history charts. Replace this with an intentional, polished dashboard.

Retain the Money Printer branding and clear-glass desktop character, with coherent styling across both apps. Use strong hierarchy, restrained color, clean chart surfaces, sensible spacing and consistent typography. Spend screen space on information rather than oversized headers, duplicate labels or decorative effects.

Command Center must open with:
- An organized price workspace spanning crypto, stocks/ETFs, Pump tokens and prediction markets: real timestamped line/sparkline/candle charts where data supports them, current values, meaningful change, source and freshness.
- A coordinated system view showing every module’s feed health, research activity, paper outcomes, blocker and next useful action.
- A compact strip for resources, connection state, actual running work, copy discovery and critical exceptions.
- Clear distinctions between market prices, research predictions, executable quotes and paper results.

Make every monitored instrument accounted for and accessible. Thousands of contracts cannot be readable as thousands of overlapping lines. Use grouped small multiples, category heatmaps, synchronized time controls, search, watchlists and virtualized detail. Show total coverage and omitted/unavailable history explicitly; never silently truncate to a convenient top-N. Keep USD, SOL and probability scales distinct; label normalized comparisons.

Create the missing bounded history API using existing crypto tapes, equity bars and stored contract observations/versions. Preserve observation and availability times, bid/ask, session and source provenance. Downsample responsibly; show gaps and missing history honestly. History should survive reopening the app. Do not simulate market motion or convert session closes into live quotes.

Apply the same design system to ALL existing windows and program tabs: suite home, Pump.fun, wallet/whale/copy views, Robinhood, stocks, Kalshi, Polymarket, Market Lab, arbitrage, weather, macro, EDGAR, sports, wire, journal, system, network, settings and Lab views. Inventory them rather than guessing the list.

Use container-aware layouts and progressive detail. At 800×600, primary charts and key status must be visible together; test 900×650 and a 1280×720 desktop with several windows open. At 640×480, preserve a useful compact overview and accessible detail. Aim for 12–14 px normal body text and readable chart labels. Do not solve layout primarily with global zoom, 8 px text, hidden important graphs or window-wide horizontal scrolling. Revisit Lab Electron minimum dimensions and its 820 px flow-grid minimum.

Preserve keyboard navigation, focus, selection, scroll and user layout during refreshes. Respect reduced motion; pause offscreen/background rendering. Build and inspect the actual UI, not just screenshots of a mockup.

Useful starting files: trader public/dashboard.html, public/js/mpo-platform.js, mpo-command-center.js, mpo-command-graphs.js, mpo-viz.js and public/css/mpo-glass.css; Lab public/lab.html, public/lab-flow.js and desktop/main.cjs.

## 2. Make Command Center the actual coordinated brain

The current Command Center aggregates snapshots and changes profiles. Existing src/core/intelligence.js already provides evidence triage and persistent recommendations; src/core/eventBus.js provides notifications. Extend and connect those foundations instead of creating a second disconnected “brain.”

Implement a durable, explainable coordination loop:
observe → identify bottleneck → prioritize collection/repair → dispatch useful research → freeze an eligible exploratory candidate → obtain trader admission → evaluate prospective paper outcomes → retain, revise or reject.

Give each module explicit objectives, required evidence, dependencies, priorities, freshness limits, bounded resource requests, next action, retry reason and completion receipts. Prevent duplicate jobs and starvation. Use measurable readiness, evidence gain and after-cost outcome improvement to prioritize work.

Connect weather, macro, filings, sports, market identity, wallet flows, leader discovery and price research where appropriate. Cross-module relationships need explicit instrument/event mapping, timestamps, expiration and prospective ablation against simpler baselines. Correlation or a plausible narrative is not an established edge.

Show “what the system is doing, why, what it needs, what happens next, and what changed after the last experiment” in plain language. A deterministic evidence-driven planner is useful; do not add a cosmetic thinking animation or recurring paid model calls.

Trace at least one candidate end to end through the real Lab → trader contract. Inspect src/core/labSync.js and src/core/strategies.js: summary metrics alone cannot satisfy evaluator/provenance requirements. Transport verified strategy identities, evaluator outputs, dataset/code hashes and evidence receipts without weakening admission gates. The Lab remains advisory and never directly edits trader books or places orders.

## 3. Put research effort into the actual bottlenecks

Improve data quality and prospective coverage before throwing more trials at exhausted datasets.

Copy trading:
- Keep broad discovery, but expose the complete candidate → rejected/observed → eligible → followed → copied → exited → evaluated funnel and reasons per platform/policy.
- Rank on achievable follower outcomes after latency, depth, fees, slippage, missed entries/exits and concentration, rather than leaderboard profit alone.
- Maintain point-in-time membership, first-observed timestamps and reproducible attribution. Compare against no-trade and appropriate control policies.
- Separate historical leaderboard replay’s independent-day requirements from prospective experiments that can collect valid new receipts now.
- Audit Pump’s partial mint-based transaction coverage, unmatched sells and wallet follow-up collection. Improve adaptive sampling, durable cursors/backlog and cost attribution within existing RPC budgets. Do not loosen strict qualification merely to populate the screen.
- Preserve losing incumbents and their pauses. Use separately funded, frozen exploratory books; do not silently rewrite their policies.

Weather/Kalshi:
- The Lab already compares multiple weather models, but forecast availability and exact settlement-station/rules binding need stronger prospective evidence.
- Archive model/run, first receipt/publication time, forecast horizon, station/location, timezone, units, revisions and exact contract settlement criteria.
- Compare calibrated forecasts to market probabilities and settled truth by horizon, season/location and uncertainty; evaluate net after executable costs.
- Audit duplicated sequential city/event downloads and share in-flight forecast requests, caches and provider budgets.
- The weather corpus has exhausted its current distinct-trial budget. Acquire new independent evidence rather than re-searching it endlessly.
- BTC currently lacks independent validation dates despite some settled events. Diagnose collection/date splits and wake research on new settlements; never count one day as several independent folds.

Robinhood crypto/stocks:
- Improve genuine quote coverage, fee/slippage modeling, horizons and forward observations. Do not relabel candle-derived history to cross a source-quality gate.
- Existing ATR/trend/mean-reversion challengers need matching bounded trader adapters before they can produce meaningful prospective comparisons.
- Diagnose provider-backed equity history gaps before changing validation requirements. Missing BIL/DBC dates currently discard useful early history; recover authentic data with provenance rather than inventing bars or shortening the protocol.
- Research weather/sector, macro, public filings and wallet-flow links only with timestamp-safe features and suitable independent baselines. External SOL flows are not Robinhood customer trades.
- Use the existing pinned research library selectively: turn relevant hypotheses into declared, executable, testable families instead of importing thousands of strategies indiscriminately.

Polymarket and other desks:
- Keep global CLOB strategies, global copy, US singles/combos and Kalshi mirrors distinct.
- Improve exact market/event identity, date, resolution and executable quote coverage. Unsupported account/beta capabilities remain visibly unavailable.
- Audit each registered module for a working collection → evaluation → prospective feedback path and a concrete next action.

Verify new provider integrations against current official documentation. Use already configured, authorized capabilities without exposing credentials; record genuine external prerequisites and continue independent work.

## 4. Maximize useful throughput and reliability

Benchmark before and after: endpoint p50/p95, payload size, event-loop delay, renderer responsiveness, CPU/GPU/RAM, useful jobs completed, feed limits, evidence freshness and validated experiment throughput.

The Command Center endpoint recently returned about 2.37 MB in 2.4 seconds because it bundles thousands of contracts and rich research details. Split compact summaries from lazy/versioned quote, history and detail requests. Share caches and in-flight work. Do not make every window repeatedly scan large files or replace its whole DOM.

Use available CPU, GPU, memory, disk and cached data where they improve measured throughput. Preserve desktop headroom and shared leases. Reservations are not actual utilization; fix incomplete process accounting and allocate phase-specific leases to genuinely parallel work. Keep CPU/GPU parity and measured break-even checks. A millisecond loop over unchanged prices creates no evidence.

Address slow/blocking venue work, stalled jobs, startup load, disk growth and excessive polling. Keep one failing feed from freezing the desktop or other modules. Prefer changed-evidence wakeups with bounded backoff, not overlapping providers or endless identical searches.

The system drive recently filled during installation. Add space-aware preflight and verified backup handling, using W: when appropriate. Never delete paper history or unrelated files to make room.

## 5. Make status truthful and ship the complete improvement

Fix Lab flow labels that confuse global CLOB research with copy trading, mark active Pump trading as parked, count recently completed jobs as “live now,” or present any proposal as having passed gates. Distinguish running, waiting, backoff, stale, unqualified, exploratory, admitted and qualified. Keep retired furnace counters historical.

Preserve all existing capital, currencies, books, losses, journals, experiment identities, cost assumptions, loss pauses, single-use holdouts and multiplicity-aware trial accounting. Never fabricate fills, forecasts, timestamps, settlements, returns or confidence. Keep real-money activation and automatic live promotion locked, and recurring paid models disabled. Edit shared strategy files in the trader owner, synchronize through scripts/sync-shared-core.mjs and prove parity.

Deliver in sensible batches without stopping after each one:
1. A current baseline and reconciled backlog.
2. The working chart/layout redesign.
3. The connected coordination/evidence improvements.
4. Measured performance and research pipeline fixes.
5. Meaningful focused tests, full suites in both repos, shared-core/release checks, UI checks at the stated sizes, paired startup/archive smoke checks and local installation.

Re-verify running versions, both applied profiles, matching paired receipts/archive hashes, preserved accounting and live job/feedback behavior after installation. Keep concise screenshots, measurements and a current handoff record. Report what improved, what evidence proves it, remaining external/data waits and the next automatic action for every module.

Success is a visibly better, faster, more coordinated system that gathers better evidence and runs useful prospective experiments. Do not claim profitable strategies merely because the code ships, trials increased or a chart turned green.
