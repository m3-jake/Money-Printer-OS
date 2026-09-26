# Money Printer OS: status ledger

**Read this first.** It is the entry point for each new session. Deeper history lives in `.agent-state/`
(`CURRENT_TASKS.md`, `KNOWN_BUGS.md`, `PROJECT_STATE.md`, `RELEASE_STATUS.md`) and in `reports/NEXT-STEPS-2026-09-25.md`.
Don't re-inventory the repo. Update this file at the end of every batch.

Last updated: 2026-09-26, batch 10 + Solana/Robinhood/Lab review (read-only). Branch `feature/polymarket-combo-only`, version `0.5.0-alpha.56`.

## Architecture (inventoried once)

- **Desktop shell:** `desktop/main.cjs` (Electron). It supervises child processes (engine `src/index.js`, `src/networkMesh.js`, and optionally `src/researchCollector.js`) and restarts them with backoff. Research services policy: `desktop/research-supervision.cjs` (`MPO_RESEARCH_COLLECTOR`, default on).
- **Engine / HUD:** `src/index.js` (Solana meme paper engine; has a realpath main-guard at `:702`, exports only `main`), `src/dashboard.js` (HTTP API + `public/dashboard.html`).
- **Books:** `src/store.js` holds paper state and its accounting invariants. Atomic writes go through `src/atomicRename.js`.
- **Polymarket:** one live-combo panel over `src/polymarketUSCombos.js` (see `docs/POLYMARKET-COMBOS.md`). `src/polymarketUS.js` serves only credentials and the session arm. `src/polymarket.js` (paper) is detached from the dashboard and kept for the collector and tests. Auth currently fails with `keyNotFound`.
- **Robinhood (this branch):** `src/robinhood*.js`, paper only. Real execution isn't installed. See `docs/ROBINHOOD-AUTO-TRADER.md` and `docs/ROBINHOOD-RECOVERY-2026-09-25.md`.
- **Research/evidence:** `src/researchCollector.js` writes the tape to `<data>/research-evidence/raw/*.ndjson`. Around it sit `researchEvidenceGate/Store`, `researchControlPlane` and `polymarketResearchEval`. The gate is intentionally not wired into the live app.
- **Evolution Lab** (BEAST/GPU furnace) lives in a separate repo, `money-printer-evolution-lab`. Codex was working there as of 2026-09-25. Don't touch it from here.
- **Tests:** 54 files in `tests/`, run by `npm run test:all`. Everything is mocked and uses temp dirs.

## Confirmed working (2026-09-25)

- Every test file passes when run one by one: **520 pass, 0 fail**. `node src/selftest.js` reports SELFTEST PASS with an isolated data dir.
- The collector was run end to end against live public Polymarket data in a temp dir: 179 depth rows, the lock yields to a second instance, and a stale lock is taken over.

## Broken / unfinished / open (details in `.agent-state/KNOWN_BUGS.md`)

- Polymarket US API key returns 401 `keyNotFound`. Only bing can fix it by regenerating the key.
- Combo/RFQ access is gated by a beta allow-list on Polymarket's side.
- The research evidence gate isn't wired in (deliberate). The Polymarket strategy family loses after fees (report section 1).
- `enter()` in `src/index.js` still has no direct end-to-end test. The main-guard exists; the blocker is that importing the engine pulls in config, store and network modules. F7/F8 are covered through `positionExecution.js`. Low priority.
- The alpha.54 build hasn't been installed. Signing and publishing are bing-only.
- The collector's cursor file can still be lost if it was already NUL-filled before this fix. The only effect is duplicate Solana ticks (bounded by `tickHistory`).

## Bugs fixed

| Batch | Bug | Fix |
| --- | --- | --- |
| 1 | A transient Windows rename refusal (Dropbox/AV) on the status/cursor write threw out of the collector loop and killed it. | `renameSyncWithRetry`, wrapped in try. The error is recorded as `lastWriteError`. |
| 1 | Status/cursor JSON was written without fsync, so a power loss could leave NUL-filled files (same failure as the Lab's 09-22 loss). | `atomicJson` now fsyncs before the rename. |
| 1 | The standalone collector and the trader's child collector could both append the same day file. | Per-data-dir `collector.lock` (pid plus 60 s refresh, stale takeover). The loser exits 0, and a collector whose lock was taken over also exits. |
| 1 | An append after a torn or NUL tail glued the next record onto garbage. | `appendNdjson` starts a new line when the file doesn't end in `\n`. |
| 1 | The collector only ran as a child of the trader, so three days of tape were lost. | `scripts/run-collector.mjs` / `npm run collector -- --data <dir>` (self-restarting). |

## Files changed

- Batch 1: `src/researchCollector.js`, `scripts/run-collector.mjs` (new), `package.json` (`collector` script), `tests/research-collector.test.mjs` (+3 tests), `docs/RESEARCH_EVIDENCE_PIPELINE.md`, this file.

## Tests performed

- Batch 1: full per-file sweep (520/0) before the changes; `tests/research-collector.test.mjs` 6/6; `test:evidence` 55/0; `release-gate` 7/0; selftest pass. Live smoke tests of the collector lock, takeover and runner.

## Decisions

- Real-money execution stays forbidden: Robinhood is paper-only, and `liveExecution:'manual'` doesn't change.
- The collector yields (exit 0) rather than failing when another instance owns the data dir, so supervisors simply retry, which also gives failover.
- The untracked `reports/NEXT-STEPS-2026-09-25.md` and `reports/research/` were left untracked. They belong to an earlier read-only session.

## Batch 2 (2026-09-25): finish Codex's work and merge

- **Lab repo** (`W:\money-printer-evolution-lab`, branch `codex/lab-evidence-20260925`):
  - The fee-model work was already committed at `21ec97f`, and all 146 Lab tests pass (19 + 53 + 74).
  - The unfinished part was an uncommitted Desktop/Start Menu shortcut step in `scripts/package-windows.mjs` (the file had also been converted to CRLF), plus untracked `public/assets/lab-icon*.png`, which `desktop/main.cjs` already loads.
  - Committed as `c41d331` with line endings restored. `node --check` passes; the packager was not executed.
- **Trader branch audit:** everything is already in `feature/robinhood-auto-trader`.
  - `codex/complete-mpo-20260925`, `integrate-alpha54`, `origin/claude/amazing-pascal-e0274x` and `origin/profit-lab/...` are all ancestors of it.
  - `codex/product-economics-20260925` (the worktree at `W:\mpo-product-economics-20260925`) is the pre-rebase copy of `f2d1100`. Its files are identical to HEAD.
  - Local `main` has unrelated history (the old asar lineage). 9 of its 11 commits appear on HEAD with identical subjects; the other 2 are the alpha.52 baseline and the alpha.53 split, which HEAD supersedes.
- **Merge not done:** the permission classifier blocked both ref moves as "Git Destructive". bing runs them:
  - Lab: `git -C W:\money-printer-evolution-lab fetch . codex/lab-evidence-20260925:master` (fast-forward only).
  - Trader: `git -C W:\money-printer-os branch archive/main-asar-lineage-20260925 main`, then `git -C W:\money-printer-os branch -f main feature/robinhood-auto-trader`. `main` then equals `origin/main` plus 9 commits, a fast-forward for the remote.
  - Pushing is a separate step and hasn't been done.

## Batch 3 (2026-09-25): collector observability

- `src/labHealth.js` gained `collectorCaptureCheck`, and `npm run health` shows a `tape collector` line.
  - RED when the heartbeat is more than 5 min old.
  - WARN when Polymarket capture is more than 10 min old, when a Polymarket error is newer than the last capture, or when a write error happened in the last hour.
  - WARN when the collector has never run.
- `src/researchCollector.js` entry check now matches `src/index.js`: it resolves real paths and trusts `MONEY_PRINTER_SUPERVISED=1`. The old plain compare made the collector a silent no-op on symlinked or junctioned installs, or on macOS `/var` paths, so the app kept restarting it with exit 0.
- Batch 1 had left mixed CRLF lines in `tests/research-collector.test.mjs`. The repo is LF (`core.autocrlf=false`), and it's normalized now.
- **Checked and found no change needed:**
  - The Lab's `readTapeFile` (`src/polymarketTape.js:116`) already skips and counts malformed lines.
  - `src/index.js` already has a main-guard (the KNOWN_BUGS note was stale).
- Tests: `research-collector` 7/7, `lab-health` 2/2, full `npm run test:all` **533 pass / 0 fail**. Live smoke: collector start, then the health line reads OK with a 1 s heartbeat.
- The batch 2 merges are still pending bing. See the commands above.

## Batch 4 (2026-09-25): Polymarket combo renovation, preflight + step 1

- Plan: `reports/POLYMARKET-COMBO-RENOVATION-PROMPT.md` (8 steps, one commit each). Branch `feature/polymarket-combo-only`, cut from `feature/robinhood-auto-trader`.
- Baseline before edits: `npm run test:all` **533 pass / 0 fail**. Live journal `open: []`.
- New `scripts/polymarket-us-preflight.mjs`:
  - A signed `GET /v1/orders/open` proves the key.
  - The signed `POST /v1/combos` runs only with `--probe-combo` and a 2xx key probe, and it uses a temp data dir so it never writes the live journal.
  - The report goes to `reports/polymarket-preflight-<local date>.md`.
- **Result: 401 keyNotFound** (`reports/polymarket-preflight-2026-09-25.md`). The combo probe was skipped. Building continues with mocked fetch, and step 6 (singles fallback) stays unbuilt until a 403 is actually observed.
- **Owner-only (bing):**
  - Regenerate the key at polymarket.us/developer.
  - Run `node scripts/polymarket-us-preflight.mjs --probe-combo` during live games. It creates a combo instrument, not an order.
  - The spec's "$1 order to prove the singles body shape" is a real trade, so bing places it, not an agent.
- Next: step 2 (detach the paper lab).

## Batch 5 (2026-09-25): combo renovation step 2, paper lab detached

- `src/dashboard.js` no longer imports `./polymarket.js`. All 8 `/api/polymarket` and `/api/polymarket/*` routes are gone, and so is `paperOrderResult`. The file itself stays: the collector and tests still import it.
- Activation moved from the first paper order to the first successful `POST /api/polymarket-us/combos/build` with 2+ legs (`recordComboBuildActivation`, milestone `first-successful-combo-build`). Documented in `docs/PRODUCT-ECONOMICS.md`.
- The UI's Paper Lab module is removed: `renderPolyPaper`, the `/api/polymarket` poll, the paper state and handlers. The status strip now reads the US combo feed.
  - `POLY_MODS` is `['combos','us']`, and the pin in `tests/robinhood-hud.test.mjs` moved with it.
  - This lands in step 2 rather than step 7, because a leftover module would have posted to deleted routes.
- `tests/product-economics-http.test.mjs` now checks four things:
  - The paper route returns 404.
  - Rejected builds (one leg, or a negative stake) don't activate.
  - The first priced build activates.
  - A second build doesn't double-count.
  - The test mocks the gateway feed and refuses any other outbound call.
- Tests: `npm run test:all` **533 pass / 0 fail**. Not smoke-tested in the running app yet; step 7 replaces this window anyway.
- Next: step 3 (settings plumbing: `priceMin` / `maxMinutesLeft` / `maxLegs`).

## Batch 6 (2026-09-25): combo renovation step 3, owner settings

- **Desktop check:** the installed app (`%LOCALAPPDATA%\Programs\money-printer-os`, asar written 09-25 14:56) is alpha.56 from *before* this branch and still shows the 3-module suite. The renovation reaches the desktop only when bing builds and installs, ideally not before step 7.
- `journal.settings` = `{priceMin, maxMinutesLeft, maxLegs}` with fixed `SETTINGS_BOUNDS`:

  | Setting | Range | Default |
  | --- | --- | --- |
  | `priceMin` | 0.60 to 0.985 | 0.80 |
  | `maxMinutesLeft` | 1 to 30 | 15 |
  | `maxLegs` | 2 to 3 | 3 |

  - `maxLegs` 3 tightens the old hard limit of 10.
  - `setUSComboSettings` rejects out-of-range values (`settingsInvalid`) and refuses to write while `recoveryRequired`.
  - `normalizeJournal` resets bad stored values to defaults, never to a wider band.
- New route: `POST /api/polymarket-us/combos/settings`.
- Enforcement now reads the settings instead of `PRICE_MIN` and `TURNOVER_TARGET_MINUTES`:
  - the feed filter
  - `resolveLegs`, and through it build, quote and place
  - BBO enrichment
  - the snapshot suggestion
  - the autopilot picker, capped by `maxLegs`
- The snapshot adds `settings` and `settingsBounds`. `suggested` is kept.
- Tests: `test:combos` 37/0 (+6: defaults and persistence, bounds, 0.65 at floor 0.60 vs 0.80, the minutes gate, a 4th leg at `maxLegs` 3, a corrupt journal not overwritten). `test:all` **539 / 0**.
- Next: step 4 (write the journal entry before the RFQ accept).

## Batch 7 (2026-09-25): combo renovation step 4, journal before accept

- On the RFQ path, `placeUSComboLocked` now writes the entry (`SUBMITTED`, `fillVerified:false`) to disk *before* `PUT …/accept`.
  - If that write fails, nothing is accepted.
- **Accept throws:**
  - A definite 4xx rejection removes the entry, and `placed` is not counted.
  - A timeout, network error or 5xx keeps the entry with `acceptUncertain:true` and counts it. The accept may have landed. Reconcile then either finds the order or cancels the entry if the quote died unaccepted.
  - **This is stricter than the spec's "remove if accept throws", on purpose.** A lost leg is the risk the caps exist to bound.
- **Confirm throws:** the entry is kept with `confirmError`, and the thrown error carries `entryId`.
- `placed` is counted once, after accept.
- Limit mode (`POST /v1/orders`) still journals after the call. The spec scoped this to RFQ; revisit if limit mode stays in the new UI.
- Tests: `test:combos` 41/0 (+4: entry on disk at accept time, 4xx removes, network/502 keeps, confirm 500 keeps). `test:all` **543 / 0**.
- Next: step 5 (delete autopilot).

## Batch 8 (2026-09-25): combo renovation step 5, autopilot deleted

- **Removed from `src/polymarketUSCombos.js`:**
  - `usComboAutopilot`, `setUSComboAutopilot`, `runUSComboAutopilotOnce/Pass`, `noteAutopilot`, `apBusy`
  - `CONFIRM_AUTOPILOT`, `defaultAutopilot`
  - the `MANUAL_ORDER_INDICATOR_AUTOMATIC` branch: limit orders are always MANUAL now
- `startUSComboLoops` runs only `settleUSCombos`.
- The snapshot has no `autopilot` key. `suggested` is kept and priced at `min($5, maxStake)`.
- `normalizeJournal` drops an old `autopilot` key, so an older journal (even one with autopilot ON) loads, and the next save removes the key.
- The `/combos/autopilot` route and the HUD autopilot fieldset and handlers are gone. The builder's stake fallback is now a flat $5.
- Tests:
  - The old autopilot test was replaced by "autopilot is deleted": no exports, the loop only settles, and old journals load and are cleaned.
  - `visual-contract` now asserts `ENABLE REAL AUTOPILOT` and `combos/autopilot` are absent. The Robinhood crypto-autopilot phrases are untouched.
  - `test:all` **543 / 0**.
- Next: step 6 (singles fallback) is **skipped, because preflight saw 401, not 403**. So step 7 is next: the single-panel UI.

## Batch 9 (2026-09-26): combo renovation step 7, single Polymarket panel

- **The window** is now "Polymarket US" with one `.poly-mod` (`POLY_MODS=['combos']`). There's no module bar and no US suite. It has one 5 s poll of `/api/polymarket-us/combos`, and only while the window is visible.
- **The panel, top to bottom:**
  - Status row: key, combos beta, arm and feed. The key form shows whenever the key is missing **or rejected**.
  - Settings row: win-% floor, minutes left and max legs, saved via `/combos/settings`.
  - Candidate table: soonest-ending first, nothing pre-ticked, extra ticks disabled at `maxLegs`, and `feed.rejections` shown under it.
  - Stake input and a live "N legs · pays $X" line from `/combos/build`.
  - One **Place combo…** button. It gets a quote, then opens an in-page confirm dialog (`#polyConfirm`) showing the legs, the stake, the quoted price and payout, and an expiry countdown.
    - The `PLACE REAL COMBO` field is never pre-filled.
    - Confirm locks at zero, and Re-quote runs cancel-RFQ, then a fresh quote for the same legs and stake.
    - Dismissing the dialog cancels the RFQ.
    - When `betaAccess==='denied'`, the button reads "combos beta pending" and is disabled (step 6 not built).
  - Open combos with fill-verified / unverified status, the accept-unconfirmed and confirm-failed flags, and P/L. Check settlement, history, and an in-page `FORGET` dialog. `window.prompt` is gone from the Polymarket code.
- **Server:**
  - The routes are exactly the spec's keep-list. `GET /api/polymarket-us` (scanner) and preview/order/close/cancel/cancel-all are removed, and `polymarketUS.js` is otherwise parked.
  - The snapshot sorts candidates by `etaMinutes` (up to 20).
  - Limit mode still exists server-side but isn't offered in the UI.
- **Tests:**
  - `visual-contract`: `PLACE REAL COMBO` present; the single-order phrases absent from the HTML (the backend file still has them); the phrase field is never pre-filled.
  - `robinhood-hud` pins `POLY_MODS=['combos']`.
  - `test:all` **543 / 0**.
- **Live smoke** against a temp data dir with no keys, so there were no signed calls:
  - The real public feed showed 2 to 3 candidates. The build line read "2 legs · pays $5.69".
  - The confirm dialog passed: empty field, partial phrase keeps it disabled, lock at expiry, Re-quote re-enables.
  - A 60% floor saved and persisted. Removed routes return 404.
  - Fixed along the way: `.mpo-dialog .msg > div {flex:1}` stretched the dialog icon, so the icon is now a `<span>` and the quote text uses `<strong>`.
- Next: step 8 (docs).

## Batch 10 (2026-09-26): combo renovation step 8, docs, then a local build and install

- Docs:
  - `.env.example` has a Polymarket US combos section.
  - New `docs/POLYMARKET-COMBOS.md`, modeled on the Robinhood doc.
  - `KNOWN_BUGS` product items 2 and 3 updated: the preflight 401 is recorded, and the stale autopilot references are removed.
- Renovation steps 1-5, 7 and 8 are committed. Step 6 (singles fallback) is not built: it waits for an observed 403.
- A shell-quoting slip while editing this ledger ran `polymarket-us-preflight.mjs --probe-combo` once (04:43 UTC).
  - Only the signed read `GET /v1/orders/open` went out, and it got 401 again. The script's gate skipped the combo POST.
  - The accidental report was deleted.
- bing asked to build and launch on this Windows machine. The build and install record follows below.

### Build and install (2026-09-26, 00:45 local)

- **Packer fix (`cd667a0`):** `scripts/build-windows-asar.mjs` passed unquoted paths to `npx` with `shell:true`. The default output folder `Desktop\Money Printer OS` split at the space, the archive landed in a stray `Desktop\Money` file, and the pack step still exited 0. The paths are quoted now, and the stray file was deleted.
- **Build:** `npm run release:windows-asar`
  - Output: `Desktop\Money Printer OS\Windows-cd667a0-20260926\app.asar`
  - Release `0.5.0-alpha.56+windows.cd667a0`
  - sha256 `a524f7b88f8235c5839095394373f48a37fee745625ed978831bf05a7fb5f11b`, 30,288,942 bytes
  - Unsigned: a local build, not a published release.
- **Boot test:** `npm run smoke:windows` passed (dashboard 200, health 200, isolated data dir).
- **Install:**
  - Previous `resources\app.asar` (sha `879e8d1f…`) backed up as `app.asar.alpha56-pre-combo-backup-20260926-0045`.
  - The new archive was copied in, and the hash was verified.
  - Launched from `%LOCALAPPDATA%\Programs\money-printer-os`.
- **Verified in the running app (port 8792):**
  - Window "Polymarket US", `POLY_MODS=['combos']`, `#polyConfirm` present.
  - `/api/polymarket` returns 404.
  - Snapshot: 15 live games, settings at the defaults.
  - Live journal `open: []`. It still has the old `autopilot` key on disk, which is dropped on its next save.
- **Rollback:** quit the app, then copy the backup over `resources\app.asar`.
- **Found live:** the session showed `sessionArmed:true` seconds after launch.
  - Nothing server-side arms it; only the window's Arm button (`POST /arm`) does. It was left as found.
  - **Gap:** until a signed call happens, `authCode` is null, so a stored-but-rejected key shows "CONNECTED" and can be armed. Placing still fails closed on the 401 at the first signed call (quote).
  - A cheap signed readiness probe on connect or arm would surface "KEY REJECTED" earlier. Not built; it is a candidate follow-up.

## Next recommended batch (priority order)

0. **bing:**
   - Regenerate the Polymarket US key and paste it into the window's key form.
   - Run `node scripts/polymarket-us-preflight.mjs --probe-combo` during live games.
   - Do the owner check in `docs/POLYMARKET-COMBOS.md` section 11.
   - If the preflight reports 403, the singles fallback (step 6) is next.

1. **bing:** run the two merge commands (batch 2), then say whether to push. Schedule `npm run collector -- --data "%APPDATA%\Money Printer OS\data"` at logon, and disable `MoneyPrinterReplayWorkhorse`.
2. Re-run the Lab's three Polymarket sandbox searches with the committed fee model (report section 2.3: `node scripts/polymarket-research.mjs --mode search ...` in the Lab repo, read-only against `W:/mpo-polymarket-research`). Record the verdict here.
3. Refresh or retire the stale admin scripts (report section 2.8). They live outside this repo, so ask bing where first.
4. Design work (not compute): a second Polymarket strategy family. Options are fee-free NFL-only markets or maker/limit posting with a queue model (report section 2.5).
5. Optional: an end-to-end `enter()` test harness, which needs dependency injection for config, store and network.

### Solana / Robinhood / Lab track (from `reports/SOLANA-ROBINHOOD-LAB-REVIEW-2026-09-26.md`)

Verdicts:
- **Solana SPRINT: park it.** 124 paper closes, profit factor 0.85, −1.15% per trade. A 4% take-profit against about 2.5% round-trip cost needs a hit rate of about 83%.
- **Robinhood: no evidence yet.** There are 5 minutes of tape and 0 trades, and the paper quotes come from Coinbase, not Robinhood.

**Batch 11: slim the trader (no strategy change)**
1. **bing:** take the Solana profile off SPRINT and stop it in the HUD. Done when there are no new `history` rows for 24 h.
2. Default `ROBINHOOD_EVOLVE_ENABLED` to `false`; "Run now" keeps working.
   - Files: `src/robinhoodEvolve.js`, `docs/ROBINHOOD-AUTO-TRADER.md` §13/§22.
   - Tests: Robinhood evolve and auto-trader.
   - Done when the default tick never calls `runRobinhoodEvolveOnce`.
3. Gate the `alphaWorkerManager` start (`src/index.js:655`) behind `MPO_ALPHA_WORKER`, default off.
   - Tests: selftest plus a supervision assert.
   - Done when a default boot has 3 Node children.
4. Cap `state.research` and split it out to `<data>/learner.json`, written atomically.
   - Files: `src/learner.js`, `src/store.js`.
   - Tests: selftest and store.
   - Done when a copy of the live `state.json` (9.6 MB, 7 MB of it `research`) round-trips to under 2 MB.
5. Measure the engine's idle CPU/RSS with an isolated data dir, `ROBINHOOD_AUTOSTART=false` and no `.env`. Record the numbers here.

**Batch 12: Robinhood data before search**
1. **bing:** run the Robinhood paper loop continuously with read-only credentials, so the tape is Robinhood's own quotes. Done when there are at least 7 days of `robinhood-tape/BTC-USD.ndjson`.
2. Tag each tape row with `src` (`rh` or `cb`) and show the split in the HUD.
   - Files: `src/robinhoodTape.js`, `src/robinhoodAutoTrader.js`.
   - Tests: the tape tests.
3. Add `scripts/rh-tape-stats.mjs`, a read-only CLI that prints coverage, spread p50/p90, the share of time the expected move is ≥ 1.5×C, and projected trades per day.
   - Tests: a fixture test.
   - Done when it prints one line per symbol.
4. After 7 days, record the verdict here: can the strategy trade at all at Robinhood's costs?

**Batch 13: lab-link tape v1 and moving the search out**
1. `src/labLink.js` `publishTape()`: sealed daily segments, `mpo.lab-tape-manifest.v1`, a 1 GB quota, and pruning on `mpo.lab-ack.v1`.
   - Tests: new `tests/lab-link-tape.test.mjs` covering caps, atomicity, quota, Lab off and a torn tail.
2. Route `mpo.lab-champion.v1` by `family` into `applyRobinhoodEvolution`. Refuse a champion unless `quoteSource` is `robinhood` and it has ≥ 100 test closes.
   - Tests: lab-link and Robinhood HTTP.
3. **bing:** schedule a Lab-repo session after Codex's branch lands. It will ingest the tape and port the backtest and evolve with a sealed holdout and a deflated score.
4. Move `replayLab`, `polymarketResearchEval`, `executableReplay*` and the Robinhood evolve to the Lab, and delete `alphaLab`. Done when the trader's `src/` has no search, replay or scoring modules.
