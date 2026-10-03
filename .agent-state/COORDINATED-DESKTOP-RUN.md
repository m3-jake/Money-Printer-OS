# Coordinated desktop run — 2026-10-03 (Claude)

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
