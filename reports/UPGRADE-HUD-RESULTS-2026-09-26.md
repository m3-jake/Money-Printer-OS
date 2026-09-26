# HUD and paper-trial verification — 2026-09-26

## Implemented

- `public/js/mpo-hud-runtime.js` guards preference access, parsing, shapes, and quota failures; usable values survive field-level geometry repair. Memory fallback keeps the current session usable when storage is blocked.
- All local API GET reads share a bounded transport: four active requests, at most 32 queued, per-route single flight, a 12-second whole-response deadline, cancellation, and retry backoff. POST mutations remain distinct. Visibility/page lifecycle and window close cancel scoped reads. Refresh handlers also avoid duplicate application of one slow response.
- Service health displays retain the last successful snapshot time. Failure stays visibly stale across unrelated renders. Startup describes the actual connection attempt; decorative readiness timers and invented research utilization were removed.
- Tile/Restore preserves free geometry, including reload while tiled. Drag, resize, maximize, close, keyboard reopen, responsive clipping, and low-motion settings were exercised. Closing the last focused window no longer reopens it solely because its focus preference survived.
- Rendering measurements cover every registered renderer, charts, state parsing, layout/fit, frame times, long tasks, and interaction feedback. Unchanged platform HTML is not rebuilt. Dense Command Center content scrolls at readable text size.
- Command Center renders module capability decisions, applied hashes, unknown marked risk values, excluded currencies, and valuation limitations. Arbitrage displays conditional matched payoff and each direction's failed-hedge capital/unwind scenarios. Separate venue execution is explicitly non-atomic.
- Robinhood chart responses cannot overwrite a newly selected pair/range. Market Lab stepping is single flight and stops on close, hidden page, or unload.

## Interactive checks

The read-only fixture `tests/helpers/hud-fixture-server.mjs` served source UI at `127.0.0.1:18767`. It imports no trader modules and returns 405 for mutations. It uses synthetic state, an 800-point series, and no credentials, production book, or venue order transport.

The Codex in-app browser verified damaged JSON, valid JSON with wrong types, a denied storage getter, quota errors, a failed state feed, recovery labels, retained geometry, 24 repeated tile/restore clicks, pointer drag/resize, maximize/restore, keyboard open, focus after close, reload while tiled, and 1280×800 / 1536 / 1920×1080 viewport layouts. Reduced-motion preference paused cloud animations. The closed-System reload regression was checked after the final fix. The test tab was closed, viewport override reset, and the fixture server stopped.

Artifacts:

- [Before](upgrade-hud-before-2026-09-26.jpg)
- [After at 1536](upgrade-hud-after-1536-2026-09-26.jpg)
- [Final source at 1920](upgrade-hud-after-1920-2026-09-26.jpg)
- [Disconnected service](upgrade-hud-stale-2026-09-26.jpg)

### Browser measurements

| Metric | Before | After under four CPU workers |
| --- | ---: | ---: |
| Frame sample count | 10,000 | 2,777 |
| Frame p50 / p95 / p99, ms | 12.4 / 18.7 / 25.1 | 12.5 / 18.9 / 31.1 |
| Frames over 50 ms | 9 | 2 |
| Whole render callback p95, ms | 5.2 | 1.0 |
| Render samples | 272 | 42 |
| Click feedback p95, ms | 9.2 (one click) | 27.7 (24 clicks) |
| Long tasks | 15 | 1 |
| Renderer errors | 0 | 0 |

Raw [before](upgrade-hud-before-metrics-2026-09-26.json) and [after](upgrade-hud-after-metrics-2026-09-26.json). The load helper ran for 120.071 seconds, starting at 23:33:23 UTC, with four workers doing 25 ms compute / 10 ms wait cycles. The recorded after sample was collected during that load.

These samples differ in duration and surrounding workload, and the baseline has only one interaction. They show the observed renderer cost and exercise the under-load path; they do not establish a controlled performance speedup. The browser fixture's frame p95 exceeded 16.7 ms, so that run does not certify smooth 60 Hz. Cached production API latency and a long-duration memory soak were not measured here.

### Native Electron follow-up (integration owner)

The integration owner separately ran a visible Electron 38.8.6 source fixture at device pixel ratio 1.5 with four CPU workers. [Native report](upgrade-electron-hud-2026-09-26.json) records 72 programmatic interactions across corrupt-storage, quota, and disconnected-feed phases:

| Phase | Feedback p95, ms | Frame p95, ms | Frame p99, ms | Long tasks | Renderer errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| Corrupt | 75.3 | 6.4 | 12.6 | 2 | 0 |
| Quota | 22.1 | 6.4 | 18.8 | 1 | 0 |
| Disconnect | 6.2 | 6.3 | 6.4 | 1 | 0 |

This bounded native sample met the 100 ms interaction target. The stale display read `STALE · service snapshot 12s old`. Renderer working set rose during the three short phases (about 193–281 MiB overall, peak about 324 MiB); this is not enough elapsed time to classify memory stability. End-of-run renderer CPU was reported as 0.53%, with 10.95 cumulative CPU seconds. The report's GPU adapter fields do not establish hardware rendering cost. The hidden-window control was throttled near 1 Hz and is not valid evidence for visible interaction performance. Physical multi-monitor transitions, human input latency, packaged installation, and authentic live-feed load were not certified by this fixture.

## Independent review and subsequent fixes

Read-only review covered core valuation, risk, contract payoff, and Robinhood trial integration. Three reproduced trial failures were reported to the integration owner, who delegated their fixes here:

1. Manual Lab apply accepted a 30-day-old, wrong-incumbent, research-only proposal with unsafe safety flags and created no trial.
2. An active trial lacking its epoch accepted 20 historical outcomes as a successful prospective trial.
3. Inconsistent rollback parameters produced a different policy while the ledger claimed the incumbent had been restored.

Both Lab and local legacy apply now use common admission and a persisted paper trial. Required evidence includes the current `robinhood-backtest.v2` evaluator, a SHA-256 dataset fingerprint, a passing positive holdout with at least 20 closes and 90% Robinhood quotes, a fresh publication/holdout, the current incumbent hash, executable policy-hash agreement, and current trader evidence. A trial starts only with a flat portfolio and positive cash equity. Legacy champions missing provenance must be recomputed.

Trial authority validates its epoch, starting equity, phase, incumbent record, and rollback parameter hash. Missing or corrupt authority is retained and blocks new automated trial risk. PREPARING state reconciles whether the candidate was actually applied. Rollback stays ROLLBACK_PENDING until the persisted running hash matches the incumbent; a disk failure cannot claim success. Future, invalid, and duplicate outcomes cannot count toward trial progress. KEEP waits for the portfolio to become flat. The existing marked-loss budget and idle timeout continue to apply; all promotion remains paper only.

The independent reviewer did not change core valuation/risk/contracts. Review found no additional demonstrated financial invariant failure in those three files within this bounded pass. This is not a proof of all possible accounting behavior.

## Automated verification

- Focused HUD, layout, chart, visual, and synchronized panel suite: **71 passed**.
- Focused Robinhood evolution and paper-trial suite after hardening: **26 passed**.
- `npm run test:robinhood`: **205 passed**; mock transports and isolated books only.
- `git diff --check`: clean at handoff.

The source fixture and screenshots identify themselves as synthetic. These changes do not by themselves assert that the installed application was replaced, that macOS was installed/tested, or that any strategy has demonstrated profitability. Installation provenance, full integration gates, and the resumable soak belong to the main upgrade report.
