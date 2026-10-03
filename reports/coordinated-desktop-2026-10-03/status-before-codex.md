# Money Printer OS: status ledger

## Paper-potential build entry point — 2026-10-03

Verified installed pair: MPOS alpha.89 @ `3fa7d3b` / Lab alpha.25 @ `258286f`, installed October 3 at 2:30 PM America/New_York. Matching paired receipts, archive hashes and running commits establish this installation. The starting runtime was alpha.88@72b7067 / alpha.24@3e9e6ad. Older installation claims below are historical.

Read `.agent-state/PAPER_POTENTIAL_RESUME.md` and `reports/paper-potential-2026-10-03/BUILD-RECORD.md` for the experiment manifest, module inventory, preserved incumbent losses, tests and concrete waits. `reports/paper-potential-2026-10-03/INSTALL-VERIFICATION.md` records final installation and after measurements. Both apps have persisted FAST_PAPER_STEADY; paper-only and recurring paid models disabled. Final source checks: trader 1,337 passed / 20 intentional skips; Lab 349 passed; zero failures. The startup scoreboard has 89 rows and zero marked as beating baseline; installation does not establish profitability.

## Current entry point — 2026-10-03 alpha.89 / Lab alpha.25 (installed); improvement run complete except D2

The installed pair is Money Printer OS `0.5.0-alpha.89` and Evolution Lab `0.1.0-alpha.25` (release R-89 below; exact
commits in `.agent-state/RELEASE_STATUS.md`). Run items A1–A8, B1–B5, C1–C5, D1 and D3 are done; D2 (HUD script split)
moved two windows out and continues next run. Batches are PF-9 onward, newest first; older history is in docs/history/.
The improvement run briefed in `docs/prompts/NEXT-RUN-2026-10-03.md` is under way; its batches are PF-9 onward
below, newest first. Source past the installed commit is not installed until the next paired release.
The paragraphs below describe the alpha.84 audit pair and stay true unless a later batch says otherwise.
This completes the interrupted Claude audit implementation in `W:/mpo-accounts-views` and
`W:/lab-workbench`. Installation is established by matching `PAIRED-RELEASE.json` receipts,
fresh archive hashes and the running apps' exact build commits. A package version alone is not
installation evidence. The paired installer retains clean-source, archive smoke, backup, rollback
and PAPER-only runtime checks. Existing user data, books, P/L, credentials and journals are preserved.

### Completed source behavior

- Module home pages lead with animated charts and observed numbers across the entire suite, coverage, separate books, research and
  operating state. Command Center brings the modules together, Money Printer OS explains its
  features and workflow, and explicit links open detailed desks. Visible overviews share bounded
  cache refreshes; unknown balances are not displayed as zero or combined across currencies.
- Robinhood samples a wider crypto universe, keeps exploration separate from qualification and
  studies multi-day strategies. Practice entries now require a move covering at least two modeled
  round-trip costs over a longer observed lookback. Daily paper sleeves conserve every starting
  cent, and qualification requires prospective venue entry/exit quotes. Candle and late fills
  remain diagnostic. The Simple view explains the cost wall and waiting conditions.
- The Lab uses bounded worker replay, forecast calibration, BTC study, weekly top-k momentum
  rotation research, farm review and proposal
  publication. Historical weather replay is diagnostic and negative; no candle result is promoted
  as forward executable evidence. Weather feedback requires fresh Lab timestamps, supported
  models, bounded parameters, an improved held-out score and complete ensemble forecasts.
  Rotation reports insufficient common history; BTC replay lacks settled validation events and
  executable depth/fill receipts. Those studies remain research-only.
- Pump.fun has a separate $25 scored-wallet copy paper book: prior profitable round trips, profit
  without the best trip, observed SOL/USD funding, exact-size native/Jupiter quotes, modeled
  slippage/network fees, reserve and exposure limits. Missing quotes never create fills or closes.
- Kalshi mirrors identified Polymarket game-winner buys in a separate paper book. Market identity
  and game date disambiguate targets; stale/future observations and corrupt accounts refuse entry.
  Fees fit inside the stake, failed lookups retain queued work, settlements persist coherently, and
  a running book refuses reset. The existing Polymarket copy bot stays separate.
- The Lab opens on CPU/RAM/GPU history and six platform pipelines. Shared CPU leases adapt to
  memory and measured external CPU demand; independent jobs share paced downloads and cached
  corpora. Larger scoring batches use persistent workers, small batches stay serial, and eligible
  pre-holdout matrices can use parity-checked CUDA diagnostics. Qualification stays unchanged.
- Raw collection runs at furnace-free rates and only the focused window uses glass blur. All
  existing Simple program cards, web-demo assets and account integration are retained.

### Remaining prerequisites and evidence limits

Stocks/ETF quotes need Alpaca credentials. SEC insider/13F copy research remains unimplemented
and needs an operator-provided `SEC_USER_AGENT` plus usable equity data. Copy-leader walk-forward
research needs 14 actual daily leaderboard snapshots. The bangbowbing hub needs deployment to
enable website accounts. No profitable strategy, signed public updater release, Mac installation
or completed 24-hour observation is inferred from this source checkpoint.

Regression contracts are in `tests/audit-root.test.mjs`, `tests/audit-safety.test.mjs` and
`tests/pumpfun-copy-paper.test.mjs`; full source and paired package validation are separate release
gates. Historical measurements and earlier test totals below retain their dates.

**Read this first.** Current findings and completion are in `docs/APP-AUDIT-2026-10-03.md`.
Architecture, active work and release evidence live in `.agent-state/PROJECT_STATE.md`,
`.agent-state/CURRENT_TASKS.md` and `.agent-state/RELEASE_STATUS.md`; older history is in `docs/history/`. The earlier remediation
ledger is `AUDIT.md` and `docs/history/PROGRESS-remediation-2026-09.md`. Later sections below are historical unless dated
as the current release. Last updated: 2026-10-03.

## Release R-89 (2026-10-03, Claude): alpha.89 / Lab alpha.25 — the end of the improvement run

**What changed in how the books trade (whole run):** the Kalshi BTC bot runs model revision 2 (vol × 1.0, no
longshots under 15¢ without a 15¢ edge) and is judged only on its own bets; every Kalshi bot and farm variant stands
down to observe-only when its probabilities are worse than the market's; Robinhood exploration probes all 8 taped coins
on a schedule, practice watches all 8 with a 1×-cost entry, and the daily book has a walk-forward shadow; the Kalshi
mirror watches 16 sports-leaderboard wallets and matches Kalshi games directly; Pump.fun is parked at a 20 s cadence
with risk lookups off the cycle and unknown risk not tradable; the Lab explores on idle cores (validation only).

**Measured (live, same method before and after):**

| Measure | Before (09:20–10:53) | After (11:08–12:12) |
| --- | --- | --- |
| Pump.fun risk step / cycle | 2,122 ms / 3,240 ms | 4–5 ms / 1,987–4,424 ms |
| /api/health p50 / p95 | 325 / 1,354 ms | 65 / 355 ms |
| Collector / engine CPU (% of one core) | 31.9 / 40.1 | 20.8 / 24.0 |
| Lab processes / Lab CPU (% of machine) | 8 / 2.2% | 6 / 7.3% (234% of one core; 216 standing units, 86,400 weather variants tried, validation only) |
| Scoreboard | 15 rows, 1 "beating" (retired furnace row), Kalshi and copy books missing | 32 rows, every book once, 0 beating |
| Ledger | 218 KB | 22 KB |
| dashboard.html | 2,233 lines | 1,692 lines |
| Trader tests / Lab tests | 1,261 / 396 | 1,298 / 333 (14 furnace test files archived with the furnace) |

**Books at 12:10:** Kalshi weather and NWS bots 10 open each and the 7 weather farm variants 12–17 open each (they
settle on tomorrow's report); BTC bot trading again (2 open, skipping edges under 6¢); BTC farm v100 +$1.05 over 12;
Robinhood exploration 3 probes open (close within 4 h), practice waiting for a 1% move, strategy book held by its
qualification vol gate; daily book 1 mark (decides at 00:00 UTC); Polymarket copy −$156.98 over 65 closes, new copies
paused since it fell 15% from peak (now 38%); Kalshi mirror 0 so far (every leader buy since the change was on markets
Kalshi does not list); Polymarket US shadows 205–362 settled.

**Pump.fun FAIR book reset at 11:17:41 (not by this run):** a `paper-reset` action with 0.25 SOL came through the
action queue (the HUD/API reset path) and replaced the FAIR book (222 closes, −0.17 SOL at 11:20). The earlier books
remain in the core ledger as `solana-paper` epochs (legacy-4: 1,107 ledger closes, realized −0.26 SOL). Nothing was
restored; listed under Needs bing.

**D2 (partial):** the Robinhood window (`public/js/mpo-robinhood-panel.js`, which replaced the inline copy and its sync
gate) and the Polymarket window (`public/js/mpo-polymarket-window.js`) load as classic scripts at the exact position
their code used to occupy, so execution order and scope are unchanged. Verified in the browser against recorded
signatures (ids, headings, buttons, global function count) in Simple and Advanced, no console errors. The rest of the
inline script is shared glance/overview helpers used by several windows; split those next run.

**Mirror (follow-up to PF-20):** watches 16 sports leaders instead of 8 and tops up when fewer are watched. In its first
25 minutes it checked 265 leader buys and matched none: all were on markets Kalshi does not list (Spanish second
division, Uruguayan soccer, ATP challengers), correctly refused.

**Needs bing:** whether to keep or undo the 11:17 Pump.fun reset; the Polymarket copy bot's sticky drawdown pause and
its $500 bank (vs $25); approval for the retention dry run (`reports/RETENTION-DRY-RUN-2026-10-03.json`); a phone
alert channel; an Alpaca key; `SEC_USER_AGENT`; the bangbowbing hub deploy; a new Polymarket US API key.

## Batch PF-22 (2026-10-03, Claude): the Lab's phase B and C5 (Lab repo, logged here)

- **B1, one pipeline** (Lab `0fd6b3f`): `src/workbenchDaemon.js` now also runs the module research scheduler
  in-process and publishes the lab-link heartbeat (`src/labHeartbeat.js`, status RETIRED, last champion unchanged).
  The supervisor starts two processes, `labServer` and the Workbench; `labLoop` and the separate
  `module-scheduler` process are gone. Both schedulers already took slots from one shared compute lease, so this is
  one scheduler and one budget. Before: 8 Lab processes at 2.2% of the machine (70.5% of one core, 60 s, 12:05).
- **B2, furnace archived** (Lab `0fd6b3f`, tag `furnace-final` = `66535ad`): an import walk from the Lab's entry
  points found 22 unreachable files. 21 moved to `archive/src` (evolution engine, GPU furnace, BEAST, cluster
  hub/worker/client/store, labLoop, computeThrottle, shadow validation, the 4 dead files and the furnace's analysis
  helpers) with 14 furnace-only tests and 2 benchmark scripts; `resourcePolicy.js` stays (shared core).
  `researchBench.js` became a test fixture. Furnace/BEAST controls and `POST /api/profile` removed (nothing read
  those profiles any more). `tests/src-reachability.test.mjs` keeps `src/` to what runs, exempting shared-core
  copies. Lab `src/`: 69 files / 616 KB; `archive/`: 37 files / 230 KB.
- **C5** (Lab `3da066b`): the six same-named files that differed (experimentRegistry, learner, projectJournal,
  researchControlPlane, researchEvidenceStore, researchLifecycle) each keep their own app's records and have grown
  apart (registered research modules, NUL-tail repair), so they are app-specific: renamed in the Lab with a `lab`
  prefix (`labLearner.js` …). The trader's names now mean only the trader's files.
- **B4, weather model shared** (trader `src/kalshiModel.js` + `src/core/fees.js` in `shared-core.json`, 20 files):
  normCdf, bucketProbability, weatherMuSigma, probAbove, btcContractProbability, realizedVol and scoreSides are
  one copy. The Lab's weather replay now prices with them and fills like a farm variant (pick on the quoted book,
  fill at ask + 1¢, re-check the edge after the fee); a Lab test reproduces one replayed bet by hand.
- **B5, faster weather replay** (Lab `9593845`): the premise was wrong. The 1,004 s run was the one-time 90-day history
  download; the replay itself took 883 ms on 12 workers. The download was paced twice (the Workbench's paced fetch,
  300 ms, plus 220 ms sleeps); it is now paced once, about 40% less waiting, same data and same results.
- **B3, standing replay queue** (Lab `18b6d83`, `src/standingQueue.js`): between scheduled jobs, when the shared
  lease has free slots (never waiting for them), the Workbench explores 400 weather or 200 BTC variants at a time
  from wider, reproducibly sampled spaces, on the **validation window only**. Every variant counts toward its
  family's trial total (`workbench/standing.json`); the holdout is never read and nothing is proposed, so no gate
  can pass because of it. The Control room's "variants tried" cells add the idle-core trials. CPU after: measured
  after the release.
- **Verified:** Lab `npm run test:all` 329/329 + `test:resources` 49/49 (4 new standing-queue tests, 3 B4/B5
  tests, reachability, heartbeat). Trader `npm run test:all`: 1,298 tests, 1,278 pass, 0 fail (20 skipped).

## Batch PF-21 (2026-10-03, Codex + Claude): Lab predictions checked against forward paper (run item A8)

Codex wrote the scorecard before 10:18 and left it uncommitted; after bing asked for the whole run, Claude finished,
tested and committed it.

- **`src/core/forwardScorecard.js` (shared core):** for a candidate that went to forward paper, the predicted
  after-cost return per bet (with its n, CI and CI unit, captured when it was admitted) against the realized forward
  return per bet (n and a bootstrap CI), and their ratio ("shrinkage", realized / predicted). Observed (no-cash) bets
  never count. Missing predictions stay unknown; there is no ratio against a zero prediction; it never affects
  qualification.
- **Capture at admission:** a Lab farm proposal's held-out evidence becomes the book's `prediction` when its farm
  book is created (`labVariants`, `emptyBook` in `src/botFarm.js`), never backfilled later. The fixed farm variants
  and the live bots have no Lab prediction, so theirs is unknown.
- **Shown:** every bot row on `/api/scoreboard` carries `forwardScorecard`; the Advanced scoreboard shows it for Lab
  rows or rows with a prediction. In the Lab, the farm review rows carry it and the Control room flow graph's "To the
  trader" column counts admission predictions and lists predicted vs forward per variant.
- **No proposal is in forward paper yet** (the Lab has proposed none that cleared its gates), so every ratio is
  unknown today. It fills in as soon as one is admitted.
- **Verified:** `tests/forward-scorecard.test.mjs` (4, in `test:paper-bots`); Lab `tests/workbench.test.mjs` (1
  new). Trader `npm run test:all`: 1,297 tests, 1,277 pass, 0 fail (20 skipped).

## Batch PF-20 (2026-10-03, Claude): unstick the books that were not moving

bing: "all but Pump.fun are seemingly dead in the water". Survey at 11:20 of every paper book (scoreboard closes,
open, last close):

| Book | Why it looked dead | Change |
| --- | --- | --- |
| Kalshi weather, NWS control, 7 weather farm variants | 10–17 open bets each on today's markets; they settle on tomorrow's NWS report | none (working) |
| Kalshi BTC bot | observe-only since R-87: the guard judged the new revision-2 model on the 13 revision-1 bets that caused the change, so it could only come back after 20 newer observed bets | the guard counts only bets placed under the current model revision; every bet now records `modelRev` (`src/kalshiBots.js`) |
| Kalshi mirror | 0 mirrors ever. The six copy-bot leaders' buys were spreads, totals and props (28 of the last 30). And the matcher required the Polymarket contract on the sports board, which carries 71 Polymarket game-winner contracts (mostly tennis) against 622 Kalshi ones, so NFL and soccer never matched; board names like "DEN Broncos" also never equalled Kalshi's side "Denver" | the mirror also watches the week's top 8 SPORTS-leaderboard wallets (public GETs, every 5 min, only buys made after it started watching); a Kalshi-only match by date + both teams ("A vs. B" with the bought team, or "Will X win on DATE?" bought YES); Kalshi sides also match by ticker team code (`-DEN`). Dry run on 395 real leader buys: draws, spreads, totals and props still refused; Broncos vs. 49ers (Sunday) now maps to `KXNFLGAME-26OCT04DENSF-DEN` |
| Robinhood practice | entry needed a 24 h move of 2 × the 2.06% round trip (≈4%) on BTC/ETH only; BTC moved ≈0.4% today | practice settings (data, through its own config API): all 8 taped coins, entry cost multiple 0.5 (≈1% move). Practice never counts toward qualification or Lab promotion |
| Robinhood exploration | was refused by the vol gate | none: A3 probes opened SOL, XRP and BTC at 11:14; they close within 4 h |
| Robinhood strategy | `lowVol`: expected move 0.21% vs 0.40% required | none: that is the qualification gate, unchanged by rule |
| Robinhood daily + walk-forward shadow | one decision per closed UTC day; the shadow started 10:49 | none: first shadow decision after 00:00 UTC |
| Pump.fun copy | WAITING_FOR_WALLET_EVIDENCE: of 9,607 indexed wallets only 2 have the 10 graded round trips and none is profitable without its best trip | none (Pump.fun is parked; the gate stays) |
| BTC farm r2 variant | no edge has cleared its stricter rule yet (1 slippage skip); vol × 1.0 variant trades | none |

- **Verified:** `tests/paper-bots.test.mjs` 26/26 (3 new: revision-scoped guard; Kalshi-only match + team codes;
  sports-leader polling with the watch-start rule and pacing). Trader `npm run test:all`: 1,293 tests, 1,273 pass,
  0 fail (20 skipped).

## Release R-87 (2026-10-03, Claude): alpha.87 / Lab alpha.23 installed

- **Pair:** MPOS `0.5.0-alpha.87` @ `1524483` + Lab `0.1.0-alpha.23` @ `b81b655`, installed 11:08 with
  `scripts/update-local-install.ps1` (backups `app.asar.backup-20261003-110803`, restore both as a pair). Both
  health endpoints verified; shared core in parity.
- **Contents:** run items A1–A7 (PF-9 to PF-15), C1–C4 (PF-16 to PF-18), D3 (PF-19). bing chose to release before
  A8: Codex's uncommitted A8 files (forward scorecard) were stashed for the install and restored afterwards in
  both repos, unchanged.
- **Tests:** trader `test:all` 1,290 tests, 1,270 pass, 0 fail (20 skipped); Lab `test:all` 396/396.
- **Measured after install vs before (same method, live app):**
  - `riskMs` 2,122 → 4; `cycleMs` 3,240 → 1,987 (FAIR profile).
  - `/api/health` over 30 probes: p50 325 → 65 ms, p95 1,354 → 355 ms, max 1,797 → 709 ms.
  - CPU over 60 s, % of one core: collector 31.9 → 20.8; engine/HUD/bots process 40.1 → 24.0.
  - Venue loops: kalshi-weather, weather-nws, btc, farm weather, farm btc, mirror OK; copy running; calibration
    waiting for its daily slot; none stalled.
  - Scoreboard: 32 rows, all unique (30 paper books + 2 research rows); 0 beating, 5 not, 25 not enough data. The
    Kalshi BTC bot is observe-only (model Brier worse than the market). The Polymarket copy bot is at −$126.31 over
    62 closes (−$85.33 at 09:20).
- **Still to verify:** a desktop toast actually appearing (PF-19); Pump.fun paper entries with fail-closed risk
  (PF-16) over the next hours.

## Batch PF-19 (2026-10-03, Claude): local desktop alerts (run item D3)

- **What:** Windows toasts from the desktop supervisor through Electron's `Notification`; no external service, no
  account. `desktop/alerts.cjs` is pure; `desktop/main.cjs` polls once a minute (first poll 90 s after start) the
  trader's `/api/health`, `/api/scoreboard` and `/api/bots`, and the Lab's `/api/health`. Clicking a toast
  opens the window.
- **Alerts on:** a paper book's verdict turning YES (beats its baseline); an Evolution Lab farm proposal starting
  its forward test; the engine STALLED; a paper venue STALLED (PF-16); a Kalshi bot or farm variant going
  observe-only; the Polymarket copy bot's drawdown pause; a book's data stale for more than 30 min; the Lab not
  answering three checks in a row.
- **Behaviour:** only on a change of state, never for what was already true at startup (no toast storm after a
  restart); one alert per subject per 30 min; at most 6 an hour. Settings → Background & data has a "Desktop
  alerts" checkbox, on by default (`desktopAlerts` in `desktop-prefs.json`).
- **Not verified on screen yet:** the installed app has no Windows AppUserModelID or Start-menu shortcut id in
  this repo, and Windows can drop toasts from an unregistered desktop app. Check a toast after the next release;
  the supervisor logs every alert it raises (`alert: <key>` in `desktop.log`) either way.
- **Phone channel:** none; needs bing (for example an ntfy topic). Listed under Needs bing.
- **Verified:** `tests/desktop-alerts.test.cjs` (3) in `test:unattended`. Trader `npm run test:all`: 1,290 tests,
  1,270 pass, 0 fail (20 skipped).

## Architecture (inventoried once)

- **Desktop shell:** `desktop/main.cjs` (Electron). It supervises child processes (engine `src/index.js`, `src/networkMesh.js`, and optionally `src/researchCollector.js`) and restarts them with backoff. Research services policy: `desktop/research-supervision.cjs` (`MPO_RESEARCH_COLLECTOR`, default on).
- **Engine / HUD:** `src/index.js` (Solana meme paper engine; `main()` sits behind the realpath `isMainModule` guard, so importing the file starts nothing; exports `main`, `cycle`, `enter`, `updatePositions`, `actions` for direct trade and durable-control tests), `src/dashboard.js` (HTTP API + `public/dashboard.html`; persisted state at `/api/state`, live readings at `/api/telemetry` — P1.2).
- **Books:** `src/store.js` holds paper state and its accounting invariants. Atomic writes go through `src/atomicRename.js`.
- **Polymarket:** one live-combo panel over `src/polymarketUSCombos.js` (see `docs/POLYMARKET-COMBOS.md`). `src/polymarketUS.js` serves only credentials and the session arm. `src/polymarket.js` (paper) is detached from the dashboard and kept for the collector and tests. Auth currently fails with `keyNotFound`.
- **Robinhood (this branch):** `src/robinhood*.js`, paper only. Real execution isn't installed. See `docs/ROBINHOOD-AUTO-TRADER.md` and `docs/ROBINHOOD-RECOVERY-2026-09-25.md`.
- **Research/evidence:** `src/researchCollector.js` writes the tape to `<data>/research-evidence/raw/*.ndjson`. Around it sit `researchEvidenceGate/Store`, `researchControlPlane` and `polymarketResearchEval`. The gate is intentionally not wired into the live app.
- **Evolution Lab** lives in a separate repo, `money-printer-evolution-lab`, and is the shared research brain for every module: Solana (labLoop/BEAST), plus parallel `module-robinhood` and `module-polymarket` workers (`src/moduleResearch.js`). Valid module ids come from its `src/researchModules.js`. It writes `<trader data>/lab-link/modules/<id>.json` and paper-only `<id>-champion.json`. It is NOT the dropped "agent lab" harness.
- **Web demo (2026-10-02):** `web-demo/` + `scripts/web-demo/` build a static, browser-only copy of the HUD for a website. `demo-shim.js` answers `/api/*` from a recorded PAPER session (sandboxed engine, scrubbed env, no keys or user data), and refuses every write. Each page load is a new session: a 1 SOL book run by the Lab champion copied in from `lab-link/` at recording time, played for ~30 min from its opening frame. Published to Cloudflare Pages (`money-printer`, moneyprinter.bangbowbing.net). See `web-demo/README.md`; covered by `test:web-demo`.
- **HUD boot and logo (2026-10-02):** the boot overlay is a Win98-style log-on over open sky. OK, Enter or 6 idle seconds pull the camera back to the hill and fire `mpo:logon`, which shows the welcome and the grabbable money shower (`welcomeShower()`). The corner logo (`initLogoStretch()`) stretches on drag, slingshots on release, glides to a stop and fades back home after 3.5 s idle; its shine lives in the same `.logo-skin`.
- **Tests:** 158 suites in `tests/` across 36 targets, run by `npm run test:all` (`test:wiring` fails first if a suite becomes unreachable). Alpha.84 adds observed-chart history, motion, and data-boundary regressions. The 20 Robinhood real-money order-path tests remain explicitly skipped because this paper-only build refuses that dispatch; active safety tests still pin the live boundary and outbound audit. Full-suite results are recorded separately from suite reachability.

## Confirmed working (2026-09-28, remediation pass P4.3)

- **The trade path is drivable by a test.** `tests/trade-path.test.mjs` (7 tests, ~0.6 s, in
  `test:recovery`) imports `src/index.js` in-process and calls `enter()`, `updatePositions()` and
  `cycle()` directly — a paper entry with its cash and fee reconciliation, a duplicate-entry refusal,
  a stale-purge close and a stop-loss close through the real exit ladder, and one full cycle that
  persists its counters. The engine had no behavioural oracle before this; the suite's only other
  access to the file was string/line matching plus two full-process spawns.
- **Importing the engine is side-effect-free.** `main()` has been behind the realpath `isMainModule`
  guard since `bbc8f4d`, so `import('../src/index.js')` costs ~0.55 s, starts no timers, sockets or
  dashboard, and runs no cycle. The engine's own comments claimed the opposite ("calls `main()` on
  import and exports nothing") until P4.3 disproved it.
- **Honest limits of that suite:** the stub owns the two market hosts the path reaches
  (`api.dexscreener.com`, `127.0.0.1`), so no real network read, RPC round trip or dashboard request
  is exercised there, and the F7/F8 entry arithmetic is still proven through
  `src/positionExecution.js` rather than through `enter()`.

## Broken / unfinished / open (details in `.agent-state/KNOWN_BUGS.md`)

- Polymarket US API key returns 401 `keyNotFound`. Only bing can fix it by regenerating the key.
- Combo/RFQ access is gated by a beta allow-list on Polymarket's side.
- The research evidence gate isn't wired in (deliberate). The Polymarket strategy family loses after fees (report section 1).
- Nothing is installed from a session in this tree: `install`/`restart` refuse under an agent session (`scripts/release-alpha53.mjs`), so the operator install plus signing and publishing stay bing-only — the pair and its status, including the alpha.54 Windows build that was never installed, are in `.agent-state/RELEASE_STATUS.md`.
- The collector's cursor file can still be lost if it was already NUL-filled before this fix. The only effect is duplicate Solana ticks (bounded by `tickHistory`).
