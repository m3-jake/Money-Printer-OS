# Continuous research and Command Center

The Command Center coordinates the trader and local Evolution Lab through their existing controls. “Use available capacity” sets both to MAX_RESEARCH. The Lab acknowledges its persisted setting before the trader setting enters the durable action queue; both applied profiles remain visible. An unavailable Lab is reported explicitly.

MAX_RESEARCH permits 32 concurrent lanes and a 95% CPU share, subject to two reserved logical processors, memory headroom, shared trader leases and measured demand from other applications. On a healthy 32-processor machine, the initial ceiling is 28 CPU slots. Eligible daily, equity, weather and BTC validation kernels request up to 32 slots and receive only the current shared allowance. Downloads do not block independent standing validation. Distinct validation searches have larger per-corpus budgets, retain all trial counts, and stop when unchanged evidence exhausts the budget. GPU diagnostics use 1,024 bootstrap rounds with a 512 MiB working budget; parity and measured-throughput checks still select the appropriate backend.

All six module pipelines remain independently scheduled. Research cannot manufacture absent market history, executable prices, independent holdouts or settled outcomes. Paid model calls remain disabled. Recurring work is performed by the installed applications while they run; this feature does not create a separate Codex automation.

## Copy trading

The trader scans daily, weekly, monthly, sports and crypto public leaderboards every 15 minutes. Its candidate catalogue records each source, observation time, rejections, errors and last successful refresh. A complete provider failure preserves the last real catalogue and reports ERROR. Candidate presence never establishes follower profitability.

Copy refills consume only weekly observations in the book's existing category, no more than 20 minutes old, then apply the existing volume, margin, eviction and follow limits. If no suitable source snapshot exists, the original direct provider read is used. Follow timestamps are recorded when selected; earlier source trades are not backfilled. Existing books, capital, holdings, frozen experiment policies and loss pauses are retained.

In MAX_RESEARCH the Lab checks copy receipts every minute, leaderboards every 15 minutes, tape integrity every minute and farm review every five minutes. Repeated leaderboard reads remain one independent snapshot day in historical replay. Candidate feedback records after-cost results separately per policy and counts completed positions rather than partial exit slices. It remains research only. The Command Center separates candidate discovery, watched leaders, open copies, realized outcomes, loss pauses, market-matching failures and Lab feedback, and includes Pump.fun copy status.

## Layout and verification

The overview refreshes every ten seconds while visible, coalesces pending requests and preserves the last real snapshot on errors. It uses readable scrolling instead of shrinking long content, with layouts that respond to the actual window width. Detailed account, risk, source and strategy controls remain available in the workstation.

Regression checks cover candidate rejection and deduplication, outage retention, source category/freshness, coordinated profile acknowledgement, unknown and escaped UI data, resource pressure, worker parity, expanded search budgets, concurrent downloads, and distinct-day replay semantics.
