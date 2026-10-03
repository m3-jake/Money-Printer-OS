# Coordinated desktop run — 2026-10-03 (Claude, completed by Codex)

## Codex completion checkpoint

The original brief authorizes the final verified local paired installation; earlier per-agent instructions to leave the installed apps alone applied during implementation. Source is now frozen for trader alpha.93 / Lab alpha.28. The completion record is `reports/coordinated-desktop-2026-10-03/README.md`, with UI evidence in its `ui/` subfolder. The Lab checkpoint is `W:/money-printer-evolution-lab/reports/COORDINATED-RESUME-2026-10-03.md`.

Completed source: bounded history/chart workspace and shared responsive styling; coordinator plus real Lab request consumer and immutable provenance/admission trace; full copy funnel/point-in-time membership/scored-wallet pagination; durable budget-bound Pump exit capture with multi-token dedupe; forecast revision availability and complete settlement binding; prospective weather scoring; whole-day BTC splits; authentic equity gap repair/history retention; byte-shared bounded challenger adapters. No live locks or qualification requirements were weakened.

Initial full trader suite: 1,391 passed / 20 intentional live-order skips, no failures. Final Lab suite: 365 passed, no failures or skips, including real CUDA checks. Final trader rerun, paired archive smoke checks, installation, and installed accounting/runtime verification are the remaining release steps. See the completion record for final results when written. Preserve unrelated `.claude/launch.json`, pre-existing user status content, older report outputs, upload ZIP and Lab `.workflow/`.

Brief: `docs/prompts/CLAUDE-COORDINATED-DESKTOP-2026-10-03.md`. This file is the checkpoint: ownership, contracts,
baseline and progress. Update your own section when you finish a step.

## Starting reality (measured 15:40 ET)

- Installed and running: trader 0.5.0-alpha.92 @ 847109b (8792), Lab 0.1.0-alpha.27 @ 1f252a9 (8793), both MAX_RESEARCH.
- `/api/command-center`: 2,370,148 bytes; 0.16–0.73 s warm. 1.95 MB is `markets.predictions` (6,637 contract rows:
  kalshi 3,779, polymarket 2,738, US 0 cached), 252 KB `lab.workbench.leaderReplay`, 77 KB copy candidates (164).
  123 asset rows (8 crypto BBO, 14 equity session closes / stock BBO, ~100 Pump watch tokens).
- History that exists: crypto tape `data/robinhood-tape/<SYM>.ndjson` ({t,bid,ask,src} with src coinbase-candles |
  robinhood; BTC 40k rows); equity daily bars `data/robinhood-equities/bars.json` (alpaca, from 2020); contract
  versions `mpos-core.sqlite` `entity_versions` (304,610 rows, observed_at/available_at/payload; entities 8,274);
  Pump per-mint ticks `state.json` `tickHistory[mint]` ({ts,price,liq,v5,flow,score,buys,sells}, 554 mints).
- Command Center UI: `public/js/mpo-command-center.js`, `mpo-command-graphs.js` (atlas = colored cells, no history),
  `public/css/mpo-command-center.css`; window fit uses CSS zoom (`fitWindow` in dashboard.html) — the brief says
  not to rely on it.
- Lab: `public/lab.html`, `public/lab-flow.js` (flow grid min-width 820 px), `desktop/main.cjs` (minWidth 900, minHeight 600).

## Shared infrastructure (done, Claude)

- `src/hudRoutes.js`: table of read-only GET routes, each in its own module, dispatched by the desktop server
  (`src/dashboard.js`, ctx.live has in-process objects) and by the preview server (ctx.live absent → read files
  under ctx.dataDir read-only). Add a route by appending one entry; never put new read routes inline in dashboard.js.
- `scripts/hud-preview-server.mjs` (launch config `hud-preview`, port 8860): serves source `public/`, runs HUD routes
  from source against the real data dir, forwards other GET /api to the running trader, refuses all mutations.
  Open the Command Center in the preview with `openApp('command')` after entering the desktop.

## Ownership (one owner per file; others ask the lead)

| Agent | Owns |
| --- | --- |
| history | `src/marketHistory.js` (new), `src/commandCenter.js`, the `/api/command-center` route line in dashboard.js, HUD_ROUTES entries for market routes, `tests/market-history*.test.mjs`, `tests/command-center*.test.mjs` |
| command-ui | `public/js/mpo-command-center.js`, `mpo-command-graphs.js`, new `public/js/mpo-price-workspace.js`, `public/js/mpo-chart-kit.js` (new), `public/css/mpo-command-center.css`, new `public/css/mpo-design.css` (design tokens for both apps) |
| coordinator | `src/core/intelligence.js`, new `src/core/coordinator.js`, `src/core/labSync.js`, `src/core/strategies.js` (no gate weakening), coordinator HUD route, tests |
| copy | copy discovery/qualification/pump-copy files, copy funnel HUD route, tests |
| windows | `public/dashboard.html`, `public/css/mpo-glass.css`, `mpo-workstation.css`, `mpo-shell.css`, `mpo-glance.css`, `mpo-overviews.css`, every other `public/js/mpo-*.js` window script |
| lab | everything in `W:/money-printer-evolution-lab` except shared-core copies |

Shared-core files (`shared-core.json`) are edited only in the trader then `node scripts/sync-shared-core.mjs`; tell the lead.
Commit only your own paths (`git add <paths>`; retry if `.git/index.lock` exists). Never commit `MONEY_PRINTER_STATUS.md`,
`.claude/launch.json` or the untracked `reports/paper-potential-2026-10-03/*` / `web-demo/money-printer-upload.zip`
(pre-existing user changes). Never start/stop the installed apps, never POST to 8792/8793, never reset books.

## API contracts

`GET /api/command-center?view=summary` — compact (target < 150 KB): everything the opening view needs; no per-contract rows.
`markets.coverage[venue] = {total, quoted, stale, unknown, executable, withHistory}`; `markets.assets` stays; `markets.version`.
`view=full` keeps the old payload for compatibility.

`GET /api/market-quotes?venue=&group=&q=&offset=&limit=` — paged contract quotes + groups (event/series/category), ETag.

`GET /api/market-history?ids=a,b&from=&to=&points=` — per id:
`{id, unit:'USD'|'PROB'|'SOL', kind, sources:[...], points:[[t, bid, ask, mid, availableAt?]], gaps:[[from,to,reason]],
coverage:{first,last,raw,returned,downsample:'last-in-bucket'|'ohlc'}, session?:true, unavailable?:reason}`.
Never interpolates, never turns session closes into live quotes, keeps observation vs availability time.

`GET /api/market-groups?venue=&window=` — category/event heat summaries: count, quoted, median mid, change over window
(where history supports it), freshness, omitted count with reason.

`GET /api/coordinator` — module objectives, evidence requirements, freshness, bottleneck, next action, retry reason,
receipts, last experiment change; plain-language lines.

`GET /api/copy-funnel` — per platform/policy: candidate → rejected/observed → eligible → followed → copied → exited →
evaluated, with reasons and follower after-cost outcomes vs controls.

## History agent (done)

Files: `src/marketHistory.js` (new), `src/commandCenter.js` (summary + build cache), `/api/command-center` route in
`src/dashboard.js`, HUD_ROUTES entries, `tests/market-history.test.mjs` (8 tests).

- `GET /api/market-history?ids=&from=&to=&points=` — ids `crypto:BTC-USD`, `equity:SPY`, `contract:kalshi:<ticker>` /
  `contract:polymarket:<id>`, `pump:<mint>`; ≤ 64 ids, points default 240, max 2,000, ≤ 40,000 points per request
  (`query.budgetLimited`). Reply `{schema:'mpo.market-history.v1', fields:['t','bid','ask','mid','availableAt','src','lo','hi','n'], series:[...]}`;
  each series `{id, kind, unit:'USD'|'PROB', sources:[{id,label,quote,raw}], points, gaps:[[from,to,reason]], coverage:{first,last,raw,returned,downsample:'none'|'last-in-bucket'|'ohlc',bucketMs,typicalSpacingMs,gapThresholdMs}, session?, meta?, unavailable?}`.
  `src` is an index into `sources`; `quote:false` sources (candle closes, session bars, listing metadata, token ticks) must not be drawn as quotes.
  Candle warm-start rows: only the :45 close is kept, availableAt = minute end. Equity t = 16:00 New York close, bid/ask null.
  Gap reasons: `no-observation`, `missing-sessions`, `before-first-observation` (only with `from`), `no-recent-observation` (only with `to`).
  Omit `to` when polling: series are memoized per tape size / newest stored observation.
- `GET /api/market-groups?venue=&window=1h|6h|24h|7d&by=category|series|event&category=` — `accounting.total == grouped`
  (every contract placed; unmatched → `other`), per group count/quoted/twoSided/stale/unknown/executable/withHistory,
  series/events, statuses, medianMid, `change:{median,measured,omitted,omittedReason}`, freshest/oldest. Rule in `rule`.
- `GET /api/market-quotes?venue=&group=<category>|<venue>/<category>|series:<k>|event:<eventId>&q=&offset=&limit≤500` — paged rows
  (prediction fields + mid, availableAt, category, series, eventId, eventTitle, closeAt, versions, stale), `total`, weak ETag (304 on If-None-Match).
- `GET /api/command-center?view=summary` (desktop builds in-process; preview summarizes the running trader's full payload):
  no `markets.predictions`; `markets.coverage[venue]={total,quoted,twoSided,stale,unknown,executable,withHistory}`,
  `markets.predictionsOmitted`, `lab.workbench.leaderReplay` reduced (`summarized:true`, outcomes/leaders `{total,rows,omitted}`,
  candidateResearch keeps only candidates with follower closes + `omitted`), copy catalogue candidates compacted. Default stays full.
  Both views cached 2 s with shared in-flight builds.

Measured 16:00 ET against the live data dir (preview server, machine busy with other agents): 8 crypto + 10 equities
(+4 stock-BBO-only symbols → `NO_SESSION_BARS`) + 20 contracts + pump: 549 KB at 240 points (200 KB at points=120);
warm polling p50 30–67 ms / p95 42–96 ms; uncached rebuild p50 260–460 ms (sqlite reads of ~3 KB payloads dominate).
market-groups 8.5 KB, p50 1 ms cached / 120–930 ms cold; market-quotes page of 100 51 KB p50 1.4 ms. Summary 146 KB vs 2.38 MB full.
