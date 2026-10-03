# Evolution Lab audit (2026-10-02)

bing asked: is the Evolution Lab the best use of this PC's power (Ryzen 9 5900XT 16-core, RTX 5070), or should it be
rebuilt from scratch? This is read-only; nothing in the Lab was changed. Its numbers come from `GET /api/state` on the
running Lab (`0.1.0-alpha.17`, commit 1a3755b) and from `<trader data>/lab-link/modules/*.json`.

## What it is doing

| Area | What the Lab reports |
| --- | --- |
| Pump.fun search | Generation 102,682 and **1,355,285,034 variants tested**, all on **1,827 recorded samples** (322 sealed). The champion's held-out t-stat is **0.89**, where 6.51 is required after correcting for that many trials. Deflated Sharpe ≈ 0.000006, "pass: false". |
| Pump.fun live paper | Trader fitness says **PARK**. After 512 closes, the upper 95% bound on hit rate is 0.418, while break-even is 0.505. The strategy family cannot break even at these costs. |
| Robinhood crypto | "No tested setting scores above zero"; expected moves (1.3–2.2%) are below the 3% the fees require. |
| Robinhood equities | Blocked: missing session prices (BIL, DBC). |
| Polymarket / combos | "No candidate beats … holding cash after executable costs" / "No config is positive after fees". |
| Kalshi | Waiting for data: 0 independent settled outcomes. |
| Compute | Throttled because "nothing is promotable": 1 worker, 50% CPU cap. It used about 64 CPU-seconds in its first 45 minutes, against about 1,900 for the Money Printer OS app. |

The Lab is honest: its gates refuse to promote anything that hasn't earned it. But its core method is a huge
parameter search over a small dataset. That method can't find a real edge here. With a billion trials on about
2,000 samples, the best score is almost guaranteed to be luck, and the Lab's own multiple-testing math says exactly
that. More compute makes this worse, not better.

**The bottleneck is data and forward evidence, not compute.**

## Recommendation: rebuild it as a "Research Workbench"

Keep the parts that are right: the honesty gates, walk-forward, deflated Sharpe, sealed holdouts, signed lab-link
and paper-only authority. Retire the billion-variant furnace/BEAST/GPU search, and put the machine on three jobs that
actually move results.

1. **Recorder (always on, cheap).** Point-in-time history for every bot:
   - Kalshi order books and settlements (weather and BTC series);
   - NWS plus Open-Meteo multi-model forecasts (GFS, ECMWF, HRRR) and the observed daily highs;
   - Coinbase 1-minute BTC;
   - Polymarket leaderboard snapshots and leader trade histories.

   Every result later depends on this data, and today it mostly isn't kept.
2. **Calibrators (CPU/GPU, few trials, held-out).** Fit a handful of parameters with real validation instead of
   searching billions:
   - per-city forecast bias and sigma for the weather bot, from historical forecasts versus observed highs;
   - a short-horizon BTC volatility model, checked against Kalshi outcomes;
   - leader-selection rules for copy trading, replayed walk-forward on months of point-in-time Polymarket history
     ("follow last week's top N" judged only on the following week).
3. **Forward-test farm (uses the 16 cores).** Run dozens of paper-bot variants in parallel on live data. Rank them only
   on forward results with proper confidence intervals, and promote at most a few per month.

Optional GPU job: a local model that classifies news headlines into market-moving events, feeding a paper "news bot"
on Kalshi/Polymarket event markets. This is the "bet on the news" idea. It needs the recorder first, so its
accuracy can be scored.

## Order of work

1. Stop the Pump.fun furnace search, or leave it throttled; it costs little but produces nothing.
2. Build the recorder for the three new paper bots (weather, BTC, copy).
3. Build the weather calibrator first. It has the most public history and the clearest edge story (forecast
   skill versus crowd pricing).
4. Then the forward-test farm, then copy-leader replay.
