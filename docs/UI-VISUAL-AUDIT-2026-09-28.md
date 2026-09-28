# UI / Visualization Audit — 2026-09-28

Scope: Money Printer OS alpha.72 desktop and Advanced workstations.

## Rendering policy
- Simple mode is a calm glance surface; it does not render full market tables, research history, Events joins, or hidden desk charts.
- Command Center child desks render and poll only while their own Advanced tab is visible.
- Static canvases draw when data or layout changes; they do not own a permanent animation loop.
- Motion canvases (pulse, ticker, edge, bubbles) are visible-only and capped at roughly 15 fps; reduced-motion is slower/static.
- Hidden/minimized windows keep only data continuity required by the service. UI rendering is suspended.
- Market Lab history is capped to the newest 80 rows in the DOM; source history is not deleted.
- Fit/layout observation ignores hidden windows and research surfaces that manage their own scrolling.

## Visualization decisions
| Surface | Visual | Question answered | State communicated | Update policy |
| --- | --- | --- | --- | --- |
| Pump.fun | opportunity map/funnel | Where are candidates entering and being rejected? | opportunity quality and gate attrition | state refresh; visible only |
| Pump.fun | ticker/pulse | Is paper activity receiving fresh market flow? | activity and freshness | visible motion, capped |
| Polymarket | lanes/histogram | What is the opportunity distribution? | candidate quality and concentration | new research data |
| Polymarket | P/L / calibration | Is shadow performance profitable and calibrated? | cumulative result and won-vs-implied accuracy | settlement/evidence change |
| Robinhood | edge meter | Does expected move exceed modeled friction/required edge? | executable paper readiness | signal update |
| Robinhood | ticker/pulse | Is data and paper activity fresh? | flow/freshness | visible motion, capped |
| Market Lab | equity vs price | Did the replay strategy add value versus the market path? | replay performance and drawdown context | run/replay step |
| Market Lab | replay price | What had been revealed at the simulated time? | no-look-ahead replay state | replay step only |
| Stocks | daily close line | What is the recent selected-symbol path? | context for paper decisions | symbol/data change |
| Macro | indicator history | What direction/regime is each published series in? | regime and release context | macro refresh |
| Command Center | scoreboard | Which modules beat their own after-cost baselines? | cross-module paper performance | scoreboard refresh |
| System | HUD timings | Is renderer/layout/input performance degrading? | render/frame/feedback p95 and long tasks | rolling telemetry |

## Reduced work
- Market Lab is no longer a top-level desktop program; it is a Command Center desk.
- Command Center research desks do not update while another tab is active.
- Heavy Events aggregation is not fetched from Simple mode.
- The prior always-awake ~30 fps canvas loop is removed for static visuals.
- Mutation-driven fit work ignores hidden and self-scrolling research panes.
- Repetitive Events are coalesced; ambient events expire sooner than risk, canary, promotion, or major P/L events.

## Environmental visuals
Clouds, falling money, grass sway, and cloud shadows share one prevailing left-to-right breeze model. Foreground grass sways more than its distant layer, cloud shadows stay faint and hill-local, and reduced-motion disables the extra environmental motion. These effects do not fabricate market data.
