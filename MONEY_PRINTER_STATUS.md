# Money Printer OS: status ledger

**Read this first.** It is the entry point for each new session. Deeper history lives in `.agent-state/`
(`CURRENT_TASKS.md`, `KNOWN_BUGS.md`, `PROJECT_STATE.md`, `RELEASE_STATUS.md`) and in `reports/NEXT-STEPS-2026-09-25.md`.
Don't re-inventory the repo. Update this file at the end of every batch.

Last updated: 2026-09-26, batch L (Codex platform + sunny desktop finished, merged to `main`). Version `0.5.0-alpha.60`.

## Architecture (inventoried once)

- **Desktop shell:** `desktop/main.cjs` (Electron). It supervises child processes (engine `src/index.js`, `src/networkMesh.js`, and optionally `src/researchCollector.js`) and restarts them with backoff. Research services policy: `desktop/research-supervision.cjs` (`MPO_RESEARCH_COLLECTOR`, default on).
- **Engine / HUD:** `src/index.js` (Solana meme paper engine; has a realpath main-guard at `:702`, exports only `main`), `src/dashboard.js` (HTTP API + `public/dashboard.html`).
- **Books:** `src/store.js` holds paper state and its accounting invariants. Atomic writes go through `src/atomicRename.js`.
- **Polymarket:** one live-combo panel over `src/polymarketUSCombos.js` (see `docs/POLYMARKET-COMBOS.md`). `src/polymarketUS.js` serves only credentials and the session arm. `src/polymarket.js` (paper) is detached from the dashboard and kept for the collector and tests. Auth currently fails with `keyNotFound`.
- **Robinhood (this branch):** `src/robinhood*.js`, paper only. Real execution isn't installed. See `docs/ROBINHOOD-AUTO-TRADER.md` and `docs/ROBINHOOD-RECOVERY-2026-09-25.md`.
- **Research/evidence:** `src/researchCollector.js` writes the tape to `<data>/research-evidence/raw/*.ndjson`. Around it sit `researchEvidenceGate/Store`, `researchControlPlane` and `polymarketResearchEval`. The gate is intentionally not wired into the live app.
- **Evolution Lab** lives in a separate repo, `money-printer-evolution-lab`, and is the shared research brain for every module: Solana (labLoop/BEAST), plus parallel `module-robinhood` and `module-polymarket` workers (`src/moduleResearch.js`). Valid module ids come from its `src/researchModules.js`. It writes `<trader data>/lab-link/modules/<id>.json` and paper-only `<id>-champion.json`. It is NOT the dropped "agent lab" harness.
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

## Batch 11 (2026-09-26): slim the trader

- **Robinhood evolve:** the scheduled in-process search is now off by default. `ROBINHOOD_EVOLVE_ENABLED` must be exactly `true` to schedule it. "Run now" still works.
  - Files: `src/robinhoodEvolve.js`, `.env.example`, docs §13/§22.
- **Alpha worker (hypothesis-miner child):** `ALPHA_WORKER_ENABLED` now defaults to `false`. While it's off, the engine stops writing `alpha-queue.ndjson`, because nothing would drain it.
  - Files: `src/config.js`, `src/index.js`.
  - **Caveat:** an existing `.env` that sets `ALPHA_WORKER_ENABLED=true` still wins. bing should check the installed `.env`.
- **State caps:** learner outcomes 3000→1500 (the learner trains on the newest 1000), universe 5000→1500, postmortems 500→200 (`src/store.js`).
  - I did **not** split `research` into its own file. That touches the accounting, backup and recovery path; it's deferred.
- **Idle measurement:** isolated data dir, no `.env`, Robinhood/Polymarket autostart off, 60 s sample after 30 s warmup.
  - Engine: **0.9% CPU, 97 MB RSS (peak 103 MB), no node child process.**
  - A fresh `state.json` is 506 KB.
- **Tests:** `store-recovery` 19/0 (+1 cap test), `robinhood-*` 13 files all green, `lab-link` 8/0, `action-queue-rails` 7/0, `alpha-queue-rails` 5/0, SELFTEST PASS.

## Batch 12 (2026-09-26): Robinhood tape source and stats

- **Tape source:** each tape row now carries `src` (`robinhood` or `coinbase-public-paper`).
  - `tapeCoverage()` returns `sources` and is memoized on file size, so the HUD no longer re-parses a 45-day tape on every snapshot.
  - The HUD shows the quote split beside tape coverage.
  - Files: `src/robinhoodTape.js`, `src/robinhoodAutoTrader.js`, `public/assets/robinhood-panel.js` (synced into `public/dashboard.html`).
- **New CLI:** `npm run rh-tape-stats -- --data <dir>` (`scripts/rh-tape-stats.mjs`), read-only.
- **Live run (09-26):** BTC and ETH have 21 rows each, all `unknown` (written before this batch).
  - The BTC spread is 0 bps p50. That is the Coinbase book, which confirms the paper tape understates Robinhood's spread.
- **Tests:** `test:robinhood` 161/0, including the new `rh-tape-stats` test (4) and a tape source test. `visual-contract` 17/0.
- **Still open:** items 1 and 4 (bing's credentialed tape run, then the 7-day verdict).

## Batch 13 (2026-09-26): lab-link tape v1 and Lab champions

- **Tape sealing:** new `src/labTape.js` (`publishTape`) seals complete UTC days of Robinhood tape into immutable, sha256-listed segments under `<data>/lab-link/tape/`.
  - Manifest `mpo.lab-tape-manifest.v1`, at most 256 KB.
  - Caps: 16 MB per segment, 8 seals per call, 1 GB quota.
  - Pruning: acked segments go after 7 days, everything goes at 45 days, and the oldest go first over quota.
  - Bridge copy: 1 segment per call, 64 MB per day, sha256 re-checked before copying.
  - All writes are tmp + fsync + rename. Documented in `docs/EVOLUTION_LAB_SPLIT.md`.
- **Lab champions:** `readFamilyChampion()` in `src/labLink.js` reads a champion file per family, capped at 64 KB.
  - It is ignored if it claims live authority, has a bad signature, or has the wrong family or schema.
- **Robinhood hook:** `labSync` and `offerLabChampion` in `src/robinhoodAutoTrader.js`, called from the tick at most every 5 min.
  - A champion needs Robinhood-sourced evidence and at least 100 test closes. It must pass a Lab hash integrity check.
  - Only the 12 search keys are taken; everything else is inherited locally, so APPLY reproduces the local hash. The keys must be within bounds.
  - At most one champion per hour. It is proposed only; APPLY or autopromote puts it on paper.
  - The test caught one bug along the way: merging the Lab's full params made APPLY's hash mismatch.
- **Deleted:** `src/alphaLab.js`, which only the selftest used, plus its selftest block.
- **Not done:** moving `replayLab`, `polymarketResearchEval`, `executableReplay*` and the Robinhood evolve to the Lab. It waits for Lab parity, and the Lab repo is off-limits from here.
- **Tests:** new `lab-link-tape` 5/0, evolve 10/0 (+1 Lab champion test). **`npm run test:all`: 555 pass, 0 fail** (the baseline was 520). SELFTEST PASS.

## Batch 14 (2026-09-26): the Evolution Lab is retired, and the trader owns its search

- **Decision (bing, 2026-09-26):** "Don't wait for the lab. We're not using the agent lab anymore."
- **Lab code removed or gated:**
  - The batch 13 code that fed the Lab is reverted: `src/labTape.js`, `readFamilyChampion`, the Robinhood `labSync`/`offerLabChampion`, and their tests. The `alphaLab` deletion from batch 13 stays.
  - The engine's lab link (`syncLabLink` and the per-minute dataset export) now runs only with `MPO_LAB_LINK=true` (`src/index.js`). By default, `s.labLink.source` is `'disabled'`.
- **Robinhood evolve: sealed holdout** (`holdoutSplit`/`holdoutGate` in `src/robinhoodEvolve.js`, wired in `runRobinhoodEvolveOnce`).
  - The search sees only the older 80% of the tape.
  - The generation's best must also pass the newest 20% (warmed by 720 context samples): ≥ 20 closes, profit factor ≥ 1.2, P/L > 0, and ≥ 90% Robinhood-sourced quotes.
  - A second look at the same holdout is refused until a new day of tape arrives.
  - Tape defaults: min 7 days (was 3), max 30 (was 14).
  - This fixes the review's overfitting points: the test slice was reused, and anything beat a 0-scoring incumbent.
- **Installed `.env`:** it had `ALPHA_WORKER_ENABLED=true`, copied from the old example. That one line is now `false`. Nothing else in the file was read or changed.
- **Tests:** evolve 10/0 (+1 holdout test; the trader fixtures now use a sane drift, because the old one compounded to 1e12 and couldn't trade). `test:all` **550 pass, 0 fail**. SELFTEST PASS.

## Batch 15 (2026-09-26): state.research split

- **What moved:** `src/store.js` now writes the heavy research sections to `<data>/research-state.json`, atomically and at most once every 60 s.
  - The moved sections: learner, universe, postmortems, wallet/deployer profiles, alpha, improvementLoop, daily, experiments, lessons, challengers.
  - `state.json` keeps the account and the small research fields, plus `research.externalized` (the list of moved keys).
- **Load:** reattaches the moved sections. A missing or torn research file never blocks the account, and doesn't trigger backup recovery.
- **Failure handling:** if the research write fails, the save stays inline, so nothing is referenced that was never written.
- **Migration:** an old inline file converts on its first save.
- **On a copy of the live data:**
  - `state.json` 9.6 MB → **2.3 MB**, most of the rest being the bounded 1.9 MB `tickHistory`.
  - `research-state.json` 4.9 MB.
  - Save took 182 ms; the reload was intact.
- **Trade-off:** a crash can lose up to a minute of research, never account data.
- **Tests:** `store-recovery` 23/0 (+4: split, migration, torn file, throttle). `test:all` **554 pass, 0 fail**. SELFTEST PASS, and doctor still reads `autonomyLevel`.

## Batch 16 (2026-09-26): Solana, a fair test instead of a guaranteed loser

- **Cost gate** (`src/solanaEconomics.js`, wired into `enter()` in `src/index.js` before the SPRINT gates):
  - An entry is refused unless tp1 ≥ 3 × the modeled round trip for that pick at that size. The round trip is 2 × fee bps plus entry and exit simulated slippage, with exit modeled at the take-profit notional.
  - A refusal is recorded as `stats.skipReasons.costGate`, `stats.lastCostGate` and journal `entry-skip` / `costGate`.
  - The floor round trip is 2.1 %, so SPRINT (tp1 4 %) is refused on every entry. That is intended.
- **FAIR:** new exit preset `fair` (tp1 12, tp2 30, stop 8, trail 7, maxHold 90) and profile FAIR. It is the default for new installs; existing installs keep their saved profile.
- **HUD Solana card:**
  - Shows trades, hit rate, profit factor, net P/L after costs, the break-even hit rate for the active preset, and costGate skips.
  - One-click FAIR / SPRINT switch; FAIR also added to the Control Bay list.
  - A SPRINT warning shows its break-even rate.
- **Break-even (tp1 vs stop, cost both legs):**
  - FAIR: **50.5 %** at the 2.1 % floor, 52.5 % at 2.5 %, and ≤ 60 % at the worst cost the gate admits.
  - SPRINT: 79–83 %.
- **Tests:** new `solana-fair` 6/0 (`npm run test:solana`, in `test:all`).

## Batch 17 (2026-09-26): Robinhood paper that runs and shows its reasoning

- **Always-on quotes:**
  - The tick samples quotes every 15 s while the app runs, even with both autopilots off. Without keys it uses the public Coinbase book; tape rows keep `src`.
  - `ROBINHOOD_AUTOSTART` no longer falls back to `POLYMARKET_AUTOSTART`, which had silently stopped Robinhood whenever Polymarket autostart was off. The collector child never imports the module.
  - `ROBINHOOD_COLLECT_QUOTES=false` restores the idle tick.
- **Warm start** (`src/robinhoodWarmStart.js`, `warmStartRobinhood`):
  - On boot the tape is refilled from `robinhood-tape/`, then holes (a short tape or restart gaps) are filled from public 1-minute candles. The candles are expanded to the 15 s grid and tagged `src:'coinbase-candles'`.
  - Live check (isolated data dir, no keys): **720/120 samples per symbol within ~6 s of boot.**
  - `rh-tape-stats` keeps candle rows out of the spread quantiles.
- **Exploration book:**
  - `robinhood-paper-explore.json`: $1,000, costMultiple 0.5, lookback 40, maxHold 120, and the same fees, spread and fills.
  - `placedBy:'explore-autopilot'`, which qualification never counts. It is not passed to evolve or apply, and the HUD labels it EXPLORATION (NOT A STRATEGY).
  - The strict book is unchanged; its autopilot is still off by default.
- **Gauge:** `snapshot.gauges.{strict,explore}[symbol]` gives warm-up, spread vs cap, expected vs required move (bar with a required-move tick), breakout distance, trend and the blocking reason.
- **Live reading (isolated run, 02:13):** every symbol was blocked by "expected move below required move". Examples: BTC 0.45 % vs 2.70 % (strict) and vs 0.90 % (exploration); SOL 1.33 % vs 2.71 % / 0.90 %, then "no Donchian breakout". The vol gate is the binding constraint, as batch 12 predicted.
- **Tests:** new `robinhood-explore` 8/0. Existing tests were updated for the new contract: snapshot keys gain `explore` and `gauges`, and the idle tick only happens with collection off.

## Batch 18 (2026-09-26): charts

- **Route:** `GET /api/robinhood/chart?symbol=&range=1h|6h|24h` (`src/robinhoodChart.js`) is read-only (no network, no writes). It reads the tape tail (`loadTapeSince`), not the 45-day file.
  - Points: at most 800, keeping each bucket's bid/ask envelope.
  - Indicators: the strategy's own Donchian and EMA 12/48.
  - Markers for both books (at most 400), stop/take/trail lines, equity per book (net and before-fee), and trades (at most 100: entry, exit, reason, hold, gross, fees, net).
- **Panel:** inline SVG with a 1h / 6h / 24h toggle. Strict markers are filled triangles; exploration markers are hollow circles and squares. The fee drag is shaded, and narrow screens get a narrower viewBox. There are no libraries.
- **Checked in the running app** (browser pane plus headless renders at 1440 px and 375 px): no page-level horizontal scroll at 375 px.
  - No markers yet, because neither book traded during the short run.
  - The 6 h view is half empty, because the warm start fills 3 h (the 720-sample cap).
- **Tests:** new `robinhood-chart` 6/0, plus a HUD render test.
- **Housekeeping:** the unpushed batch commits were rewritten to fix line endings. Python on this machine had written several LF files as CRLF.

**Build (not installed; bing installs):** `DesktopMoney Printer OSWindows-9269231-20260926app.asar`, sha256 `4fada4703a2a44a3581415cc2853c8503c6695a4419651d249107e39efde77e8`, 30,354,382 bytes. `smoke:windows` passed: dashboard 200, health 200, isolated data dir.

**Batches 16–18 totals:** `npm run test:all` **576 pass, 0 fail** (was 554). SELFTEST PASS.

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

Batches 11–14 are built. The Evolution Lab is retired, so nothing waits on it. What remains:

1. **bing:** install the newest build over the installed app. The permission check blocks this for Claude as a production deploy.
2. **bing:** after installing the batch 16–18 build, click **FAIR** on the Solana card (the installed state keeps SPRINT; the cost gate now refuses SPRINT's entries anyway). Watch hit rate against the 50.5 % break-even.
2a. **bing:** leave the app running. The exploration book generates Robinhood trades; judge it only as data, never as a strategy. After about 7 days, compare the exploration book's net after fees with the gauge's lowVol share.
3. **bing:** run the Robinhood paper loop continuously with read-only credentials, so the tape is Robinhood's own quotes. Done when `npm run rh-tape-stats` shows at least 7 days of `robinhood` rows.
4. After 7 days, record the verdict here: can the strategy trade at all at Robinhood's costs (vol gate open %, trades per day)? Only then consider `ROBINHOOD_EVOLVE_ENABLED=true`.
5. (done in batch 15) `state.research` split.

## Install record (2026-09-26, 01:43 local)

- **Installed build:** `Windows-e2f2219-20260926\app.asar` (sha256 `6943aef5…`, 30,287,707 bytes). bing ran the copy command; Claude launched and verified.
- **Verified live:**
  - `/api/health` returned 200 `HEALTHY` within 5 s.
  - `state.json` 1.9 MB plus `research-state.json` 4.9 MB (the batch 15 split is active).
  - `labLink.source: disabled`.
  - Children: `index.js`, `networkMesh.js`, `researchCollector.js`. No alpha worker.
- **Rollback caveat:** `resources\app.asar.cd667a0-backup-20260926` holds the *new* build (the command ran twice). The real previous build is `Desktop\Money Printer OS\Windows-cd667a0-20260926\app.asar` (`a524f7b8…`).


## Batch 19 (2026-09-26): Evolution Lab owns Robinhood research

- Lab: central module whitelist `src/researchModules.js` (solana, robinhood, polymarket) replaces the "any safe string" check in lifecycle, evidence store and experiment registry. Fixed a `__proto__`/`constructor` lookup hole in the module registry. Adapter dispatch table `MODULE_RUNNERS`. New fixture tests for both workers, supervisor args, `/api/state.modules`, lab.html lanes. Lab suite 153/153.
- Trader: `evolveDue()` stands down while the Lab Robinhood lane reported within 30 min and is not ERROR (`labRobinhoodResearchActive`). Manual evolve/run and operator apply-to-paper (Lab or local champion) still work. Money feed is lower-right (`right:18px`, covered by visual-contract). MPO suite 579/579.
- Robinhood-native validation is blocked by 401 `keyNotFound`: tape is `coinbase-public-paper`, so the `>=90%` Robinhood-quote holdout gate cannot pass until bing regenerates the key.

## Batch 20 (2026-09-26): Polymarket combo plan, batch 1 of 6 (connection truth)

Plan (from bing): 1 connection truth, 2 page every live game, 3 strategy windows as settings, 4 evidence capture + shadow auto + Lab module, 5 opt-in real AUTO COMBO (reverses the old no-autopilot rule; guarded, bankroll-capped), 6 ship.

- Preflight `node scripts/polymarket-us-preflight.mjs` (signed read-only GET /v1/orders/open): **FAIL, 401 keyNotFound**. The combo-beta probe was not run (it needs a 2xx first). betaAccess is still unknown. The report file `reports/polymarket-preflight-2026-09-26.md` is left untracked.
- The KEY tile is now CONNECTED only when a signed call has succeeded (`authCode==='ok'`). Otherwise it shows KEY NOT VERIFIED, or KEY REJECTED (regenerate at polymarket.us/developer). Saving a new key resets verification.
- New `GET /api/polymarket-us/account` (`polymarketUSAccount` in `src/polymarketUS.js`): SDK `account.balances()` + `orders.list()`, read-only, cached 15 s. It returns currentBalance/buyingPower/currency, the open-order count and the names of unknown balance fields. The shapes come from the polymarket-us SDK typings. The panel shows a BALANCE tile.
- Tests: polymarket-us-safety 5/0 (+2), visual-contract 18/0 (+1), polymarket-us-combos 41/0.
- Commit 57334d9 (code); ledger in the following commit.

## Batch 21 (2026-09-26): Polymarket combo plan, batch 2 of 6 (every live game)

- **Key status (after bing replaced the key):** preflight signed GET /v1/orders/open **passes**. Combo-beta probe `POST /v1/combos` (creates an instrument, not an order) returned **403 betaNotEnabled**. Real combo quote/place stays blocked until Polymarket allow-lists the account. Discovery and shadow work are unaffected.
- `usLiveEvents` pages `/v1/events` by `offset` (300 per page) until a short page, hard cap 3000, dedupes by id. The feed reports `total`, `live`, `comboLive`, `pages` and `capped`. Live on 2026-09-26: 901 events over 4 pages, 49 live, 47 combo-enabled live.
- `usCandidatesFromEvents` also returns `board`: every live combo-enabled game (best market per event) with `eligible` / `reason` / `addable` / `outsideWindow`. Window rejections are addable by hand; price-band and spread rejections are not. Games with no priceable market show their structural reason. The snapshot serves `board` (cap 400). Manual legs enter the build pool via `withManualRows`. `buildUSCombo` tags `outsideWindow` per leg and combo.
- Sports: esports gets its own bucket (tags cs2/lol/dota/valorant/...), and it and `other` are **manual only** (explicit reason, `TIMED_SPORTS`). The league comes from tags (kbo/npb/mlb baseball, khl/nhl hockey, wnba/ncaab basketball...) instead of a blanket mlb/nba/nhl. Tennis keeps its tour (tennis atp/wta/itf) and table tennis is `table-tennis`.
- Panel: board grouped by sport (live/eligible counts per sport) with clock/score, side price, spread, left, and status (eligible, or "outside strategy window · reason", or the reason). Feed totals line, a `suggested` combo with "Use these legs", an OUTSIDE STRATEGY WINDOW flag on the build line. The key box is now also shown (collapsed) while the key is unverified (the old build hid it).
- Tests: polymarket-us-combos 46/0 (+5: paging, cap, board reasons, manual add, labels), visual-contract 19/0 (+1), safety 5/0, sports-turnover 5/0.
- Queued (bing, mid-batch): richer animated visuals for Polymarket, Robinhood and pump.fun panels.

## Batch 22 (2026-09-26): Polymarket combo plan, batch 3 of 6 (strategy windows as settings)

- `src/sportsTiming.js`: `windowEstimate(window, market, live, {maxMinutesLeft, nearEndMin})` plus `STRATEGY_WINDOWS` / `WINDOW_RULES`. **NEAR_END** is today's rules (default). **LATE** is soccer 2H, baseball 7th inning+, basketball Q3+/2H/OT, football Q3+, hockey P3/OT, or tennis/table tennis in a potential closing set, plus anything NEAR_END admits. **ANY_LIVE** is any live game, including esports. Esports/other are "manual only" in NEAR_END and LATE. ETAs are rough estimates.
- Settings now carry `window` and `rankWeights`, and `maxLegs` is 2-4 (the price band is unchanged). Invalid window/weights are refused, and garbage stored values fall back to defaults.
- Rank is `rankBreakdown()`: the sum of weight × named components (`RANK_COMPONENTS`: nearEnd, priceFit, liquidity, eta, priority, spread; weights 0-3, default 1 reproduces the old formula exactly, as tested). Candidates carry `rankParts` and `window`.
- Journal entries record `window` and `outsideWindow`. `stats.byWindow` holds open/won/lost/pnl/staked/hit rate/ROI per window, and hand-built outside-window combos count as MANUAL.
- Panel: Window selector (with a rule tooltip), legs 2/3/4, the window rule line and "Record by window".
- Live 2026-09-26: 54 combo-enabled live games. Eligible: NEAR_END 0, LATE 6, ANY_LIVE 19 (the rest fail price band/spread).
- Tests: polymarket-us-combos 50/0 (+4; 3 settings asserts updated for the new window/weights/4-leg contract), visual-contract 20/0 (+1), safety 5/0, sports-turnover 5/0.
- Next per plan: batch 4 (evidence capture, shadow auto, Lab module). Queued: visuals batch (Polymarket, Robinhood, pump.fun).

## Batch 23 (2026-09-26): Polymarket combo plan, batch 4 of 6 (evidence capture, shadow auto, Lab module)

- Observed public shapes (2026-09-26): `GET /v1/markets?slug=a&slug=b` returns `markets[]` with `status` and `marketSides[].price`. A resolved market is `MARKET_STATUS_RESOLVED` with side prices 1/0. `GET /v1/markets/{slug}/settlement` returns `{slug,settlement}` and gives **0.5 for unresolved markets**, so it is never trusted alone. The gateway returns 429 after a few rapid calls.
- **Open bug (not fixed here; blocks real-combo P/L once beta is on):** the existing signed settlement path (`fetchSettlement` in `polymarketUSCombos.js`) expects the SDK shape (`settledAt`, `settlementPrice`), which the endpoint does not return. Real combos would stay open (fail-closed, no bad P/L). Fix in batch 5 using the markets-list rule.
- `src/polymarketUSEvidence.js` (public GETs only), driven by the research collector every `MPO_POLY_US_CAPTURE_MS` (15 s) under its lock. Disable with `MPO_POLY_US_EVIDENCE=false`.
  - Legs tape `raw/polymarket-us-legs-YYYY-MM-DD.ndjson`: every board leg with bid/ask/price/spread/clock/score/sport/league/fee, and per-window verdict/eta/rank/rankParts. Deduped by change with a 60 s heartbeat. Per-window combo-estimate rows carry the ask product and fee.
  - Settlement tracker: each (leg, window) is tracked at its first qualifying price. Once off the live board it is resolved via one batched markets lookup (20 slugs per call, at most 3 calls per minute, stops on 429). A leg counts only when RESOLVED with price exactly 0 or 1; void or 72 h unresolved is UNKNOWN (never a win). Outcomes go to `raw/polymarket-us-outcomes-*.ndjson`, plus a calibration table (price bucket × sport × window: win rate vs implied price, edge after the modelled fee).
  - RFQ log `raw/polymarket-us-rfq-*.ndjson`: every quote attempt, with the quote vs ask product (markup), noQuote, timeout, or error code.
  - SHADOW auto: runs `chooseUSCombo` per window. It "places" $2 at ceil(ask product) + markup (0.03 until 5 real quotes, then the median), max 2 open per window, no reused events, 3 min cooldown. It settles on tracked outcomes (any LOST → lost; any UNKNOWN → void, not counted). Per-window record: settled, win rate, P/L, ROI after fees and markup, last decision (repeated skips collapsed).
- `appendNdjson` now fsyncs.
- Routes: `GET /api/polymarket-us/evidence` (summary plus the Lab proposal and status), `POST /api/polymarket-us/combos/apply-lab` (server reads the champion file and applies it via `setUSComboSettings`, so the trader's bounds apply; a live-claiming proposal is refused).
- Panel: research fieldset with the shadow table, markup line, top calibration rows, and the Lab proposal with "Apply to shadow + auto settings".
- Lab repo (`codex/lab-evidence-20260925`): new `polymarket-combo` worker module (`src/polymarketComboResearch.js`). It reads the outcomes and RFQ tapes, builds the calibration, and replays the shadow over resolved legs (10-min slots, distinct events, weighted rank). It grid-searches 3 windows × 4 price floors × 2/3 legs × 5 weight sets (120 trials) on the first 75% and re-scores the top 5 on the 25% holdout. It publishes a paper-only `lab-link/polymarket-combo-champion.json` once a config has 20 or more replayed combos (stage PROVISIONAL only if train and holdout ROI > 0). Default `MPO_LAB_MODULES` now includes it.
- Live smoke (temp dir, 2026-09-26): one tick wrote 56 leg rows and 2 estimates, tracked 34 legs, and the shadow placed in LATE and ANY_LIVE (NEAR_END: 1 eligible leg). No evidence of positive EV yet; outcomes will accumulate once the collector runs in the installed app.
- Tests: trader polymarket-us-evidence 9/0 (new), polymarket-us-combos 50/0 (RFQ log asserts added), visual-contract 21/0 (+1), research-collector 7/0, safety 5/0, lab* 35/0. Lab: polymarket-combo-research 6/0 (new), module-research 6/0, lab-supervision 3/0.

## Batch 24 (2026-09-26): live visuals for Polymarket, Robinhood and Pump.fun (bing request)

- `public/js/mpo-viz.js` (new, served by a `/js/` route that serves only `.js` from `public/js`, with traversal guard, no-store and nosniff). Panels emit `<canvas data-viz=key>` and call `MPOViz.set(key,type,data)`. One rAF loop (~30 fps) draws visible canvases. Eased state and particles are kept per key so motion survives the innerHTML re-renders. It skips hidden windows and background tabs, and prefers-reduced-motion drops it to ~2 fps with no jitter. Types: lanes, hist, lines, scatter, pulse (heartbeat trace), bubbles, funnel (with flowing particles), gauge (live needle), edge, ticker.
- **Polymarket:** feed-scan heartbeat; "live games · how far along" lanes by sport on a game-progress axis with the strategy zone shaded (eligible dots pulse, outside-window amber, rejected grey, ticked legs ringed, scan sweep); side-price histogram against the floor. Research: evidence-tick heartbeat, shadow P/L curve per window (new `curve` in `shadowRecord`), and a won-vs-implied calibration scatter.
- `sportsTiming.gameProgress(live)` (display only, never used to qualify) covers soccer, baseball, basketball/football, hockey, tennis/table tennis and esports. Board rows carry `progress`.
- **Robinhood:** a new `live` part in the Paper and Why views with a quote/signal ticker, a sampling-loop heartbeat, and an edge meter (sparkline plus expected move vs required move per pair). Edited in `public/assets/robinhood-panel.js` and synced into the HTML.
- **Pump.fun:** launch ticker, scan-cycle heartbeat, meme-market gauge, opportunity map (rug risk vs edge, bubble = liquidity, auto-scaled axes, open positions white and glowing) and entry funnel.
- Default window heights: trade 520→690, robinhood 620→720. `LAYOUT_VERSION` is now `2026-09-26-alpha58-live-visuals` (resets saved window layouts once). Tests updated.
- Verified in the isolated preview engine at 1440×900: all three panels render and animate, with no console errors.
- Tests: full trader sweep `node --test tests/*.mjs tests/*.cjs` **595 pass / 0 fail**.
- Next per plan: batch 5 (opt-in real AUTO COMBO; also fix the signed settlement shape bug from batch 23).

## Side batch (2026-09-26, parallel session): Evolution Lab stuck window + module audit

- **Stuck `Starting lab…` window, fixed in Lab `893b6b7`, NOT installed.**
  - Cause: the Lab outlives its window. On relaunch, `second-instance` opened a new splash window, but `showing` was still true from the first window, so nothing navigated it.
  - Fix: the flag resets on create and close, a reopened window checks health immediately, a renderer crash clears the flag, and loads have an in-flight guard.
  - Test: `tests/lab-window.test.cjs` (added to `test:lab`) fails without the fix.
  - Workaround until installed: press Alt, then Evolution Lab > Exit, and relaunch. Or open http://127.0.0.1:8793.
  - Version not bumped (still alpha.4), and Lab HEAD now also carries `c65b06a` (polymarket-combo). Bump before packaging.
- **Audit: `reports/EVOLUTION-LAB-AUDIT-2026-09-26.md`.** Serves all three modules: yes. Improves: no.
  - Solana is PARTIAL (display-only): RESEARCH_ONLY is hard-coded, and the scorer never simulates exits, so the champion sits at stop 1.5 / take 100 / hold 2.
  - Robinhood is NO: every candidate scores 0, the holdout needs 90 % Robinhood quotes but has 0 % (key 401), and the champion is overwritten every 5 min.
  - Polymarket is NO: the lane researches the international CLOB, nothing reads its champion, and its gates can't pass.
  - **Hazard:** the MacBook alpha.53 trader applies any bridge champion to paper with no gate. It has been silent 23 h.
- **Correction to batch 14:** `MPO_LAB_LINK` defaults to **true** again since `99faef0` (`src/index.js:33`).
- **Env gotcha:** Claude-desktop processes see a stale MSIX overlay of the Lab data dir (Sep 20, gen 53549). Read the Lab through its API or the trader-side `lab-link/` mirror, and never launch the Lab from a Claude session.
- **Installed MPO:** its `BUILD-INFO.json` still says alpha.56, but the asar is alpha.57 = `a244ffb`.
- Tests: Lab `lab-window` 1/1 and `lab-supervision` 3/3. No MPO code changed.

## Batch 25 (2026-09-26): AUTO COMBO written, then the combo module was PARKED

**Status: PARKED by bing (2026-09-26): "We don't have access. Forget about it for now."** Polymarket returns 403 `betaNotEnabled` on `/v1/combos` for this account. Do not continue combo work (batch 6 ship of the combo plan, Lab tuning, auto) until Polymarket enables combos and bing asks to resume.

What was finished and committed before parking (all tested; nothing can place without combo access):
- AUTO COMBO in `src/polymarketUSCombos.js`. Enable is in memory only (OFF after every restart; a persisted `enabled` flag is ignored). It needs the typed `ENABLE REAL AUTOPILOT`, an armed session, a key verified by a signed call, beta not denied, and the shadow gate (≥20 settled shadow combos in the selected window with ROI > 0 after fees and markup). Config is persisted in the journal `autopilot` (window/legs 2-4/stake mode, auto = min(stakeCap $2, 20% of balance), fixed stake, max open 2, $3 daily loss, $4 balance floor), bounded by `usComboLimits()`.
- The pass runs through the normal `placeUSCombo` path (`placedBy:'autopilot'`), uses only window-eligible legs, and never reuses an event in an open combo (plus the existing cooldown and one leg per event).
- Self-disable triggers: disarm, 401, 403/beta denied, daily loss cap, balance floor, 3 consecutive no-quote RFQs, an unverified auto fill (accept uncertain, confirm error, or unverified after 120 s), a quote above tolerance, and the shadow gate failing.
- Every decision (enabled/placed/skipped/rejected/disabled) goes to `journal.autopilot.decisions` (repeated skips collapsed) and to the HUD Live Log (`market.ndjson`, type `polymarket-auto`).
- Routes and UI: `POST /api/polymarket-us/combos/autopilot`. The panel's AUTO COMBO fieldset greys the Enable button with the blocker list and asks for the phrase the server supplies (the phrase is not in the HTML).
- **Settlement shape fix (from batch 23):** the signed settlement path now also accepts the observed `{slug,settlement}` shape, but only when the public markets list says `MARKET_STATUS_RESOLVED`. 0.5 on an open market stays pending; a resolved non-0/1 leg makes the combo UNKNOWN with no P/L.
- Tests: the deletion-pinning tests were replaced with 14 guard tests plus 1 settlement-shape test. Full trader sweep `node --test tests/*.mjs tests/*.cjs` **609 pass / 0 fail**.
- Still running while parked: the research collector's public-data evidence tick (legs tape, outcomes, shadow). Turn it off with `MPO_POLY_US_EVIDENCE=false` if unwanted. The Lab `polymarket-combo` worker (default in `MPO_LAB_MODULES`) only reads those tapes.
- Not done (was batch 6): version bump, Windows build/install, live verification.

## Batch 26 (2026-09-26): alpha.58 build, install and live verification

- Tests: trader `npm run test:all` **609 pass / 0 fail**.
- Lab `npm run test:all`: 1 failure, `tests/lab-server.test.mjs` roster pin (`['polymarket','robinhood']`), broken by my Lab commit `c65b06a` registering `polymarket-combo`. **Not fixed here:** a parallel session ("Money Printer Evolution Lab startup issue") owns the Lab repo and its install (commits 893b6b7, 44f4e0d). It was asked to fix the roster test and to leave `polymarket-combo` out of the default `MPO_LAB_MODULES` (parked). The Lab was not built or installed by this session.
- Version `0.5.0-alpha.58` (`6dd3a70`: package.json, package-lock.json, robinhoodTransport.js).
- **Build** from the clean tested commit: `Desktop\Money Printer OS\Windows-6dd3a70-20260926\app.asar`, release `0.5.0-alpha.58+windows.6dd3a70`, sha256 `f7e18a3053abecd57f6bc81afde2fa7dab376d5d2fd7e0cdee82eff6df10e0cd`, 30,464,332 bytes, 2,639 entries. Contains `public/js/mpo-viz.js` and `src/polymarketUSEvidence.js`; no `.env` or tests.
- The installed app was closed gracefully (taskkill without /F), freeing 8792. `smoke:windows` on 8792 passed (dashboard 200, health 200, isolated temp data dir).
- **Install:** the previous `resources\app.asar` (alpha.57, sha `635DD4A3…`, 30,366,811 bytes) was backed up as `resources\app.asar.alpha57-a244ffb-backup-20260926`. The new archive was copied in and its hash matches the build. Relaunched from `%LOCALAPPDATA%\Programs\money-printer-os`.
- **Verified live (8792):**
  - `/api/state`: alpha.58, mode paper, HEALTHY.
  - `/api/polymarket-us/account`: keyStatus **VERIFIED** (signed call OK), balance $10.10 USD, buying power $10.10, 0 open orders. Unknown balance fields (names only): depositReservation, bonusReservation, displayedBonus, displayedAvailableSoon, displayedCash, availableToWithdraw, bonusHold.
  - Feed: 905 events over 4 pages, 66 live, 64 combo-enabled, all 64 on the board, 2 eligible (NEAR_END).
  - Auto combo: OFF. Blockers: session not armed, and shadow NEAR_END 0/20 settled. betaAccess shows `unknown` after the restart; the 403 returns on the first combo call.
  - Evidence collector running (2 scans, 82 leg rows, 61 legs tracked).
  - `/js/mpo-viz.js` 200; a `/js/..%2Fdashboard.html` traversal attempt returns 404.
- **Rollback:** quit the app, then copy `resources\app.asar.alpha57-a244ffb-backup-20260926` over `resources\app.asar`.
- **Update (Lab session):** the roster-test fix and the parked default are in Lab `cb3c389` (`codex/lab-evidence-20260925`). Default `MPO_LAB_MODULES` is `robinhood,polymarket` again, and the Lab page shows parked workers as OFF (`MPO_LAB_MODULES_ACTIVE`). Full Lab suite 163/163. The Lab session owns the Lab build and install.

## Side batch 2 (2026-09-26, Lab session): Lab alpha.5 installed; Lab proposals made honest

- **Installed Lab 0.1.0-alpha.5** (`2acc91f`, asar sha256 `8a26a68e…`, built from a clean worktree).
  - bing did the stop, swap and relaunch. The permission classifier blocks Claude from stopping the running Lab, and Claude-launched processes see the stale MSIX overlay.
  - Backup: `resources\app.asar.alpha4-backup-20260926`.
  - Verified live: `/api/health` reports alpha.5 and generation 80,475, continuing from real data.
- **Window fix** (`893b6b7`): closing and reopening no longer sticks on "Starting lab…".
- **Solana** (`44f4e0d`):
  - Every published champion now has stage `RESEARCH_ONLY`; `labStage` keeps the Lab's own stage.
  - Pre-3d9090d traders (the MacBook alpha.53) therefore fall back to BASE instead of paper-trading stop 1.5 / take 100 / hold 2 champions.
  - Bridge `champion.json` was rewritten at 09:35Z. The MacBook still reports PAPER_CANARY because it has been silent for 23 h; it drops to BASE once it reads the new file. Upgrading it is the real fix.
- **Robinhood** (`44f4e0d`):
  - `robinhood-champion.json` is written only for a paper-review candidate, and it survives later passes that find nothing.
  - Provisional proposals are withdrawn; the live score-0 tie-break file is gone.
  - The status lists blockers. Live: "BTC-USD tape spans 0.26 of 7 days; 0% of recent quotes come from Robinhood; the holdout needs 90%; no tested setting makes a trade on this tape".
- **Polymarket CLOB lane** (`44f4e0d`):
  - A candidate must beat cash before it can be proposed; the -4.3 % proposal was withdrawn.
  - Renamed "Polymarket CLOB sandbox"; live phase is NO_EDGE.
- **Combo lane parked** (`cb3c389`, agreed with the Polymarket session): off by default, and the Lab page shows it as OFF instead of STARTING.
- **Tests:** Lab 163/163. The three new behaviour tests fail on the old code.
- **Review:** an adversarial review of `44f4e0d` found nothing high or medium. Confirmed low-severity points, all latent until a Robinhood proposal is ready (not before ~10-02, and only with Robinhood quotes):
  1. After apply, the champion file keeps `paperPromotionAllowed:true`, so alpha.57/58 panels keep showing PAPER REVIEW READY. Fix: mark the doc applied or retract it, and have MPO require `proposed`.
  2. A failed retract (Windows EPERM) is silent while the status says "withdrawn". Fix: check the return value and overwrite the file with a withdrawn doc.
  3. The blocker text reads the incumbent's trade count, not the candidates'. It also misses the time-budget case and shows negative gains as 0 %.
  4. Early-return passes skip the standing-proposal check.
  5. A standing proposal is never re-scored or aged out. Add a max age and re-score it each pass.
- **Next Lab batch:** fix 1–5 above. Then the Solana scorer: freeze stop/take/hold until exits are simulated, and score MPO's real SPRINT policy as the incumbent. See `reports/EVOLUTION-LAB-AUDIT-2026-09-26.md`.

## Batch 27 (2026-09-26): Robinhood live quotes unblocked; HUD fit-to-window

- **Robinhood (`9ef08a9`).** After bing added real keys, every Robinhood quote was rejected and both paper books froze on "quote stale" (`lastError` "Robinhood returned no valid current quotes").
  - Live v2 `best_bid_ask` crosses by up to ~2 bps (−1.6 to +0.7 bps over 8 samples), and its timestamps run ~1.1 s ahead of this PC. `fresh()` needs `ask>=bid` and `at<=now`.
  - Fix: uncross when the cross is ≤ 5 bps; stamp a timestamp ≤ 5 s ahead with the receipt time. Wider crosses and far-future quotes are still rejected.
  - "No valid quotes" is now code `badQuotes` (added to `RH_CODES`; unknown codes were becoming `unknown`). It falls back to the public paper book.
  - Tape rows from the Robinhood API were tagged `v1`/`v2`, so the holdout's ≥ 90 % Robinhood-share gate could never pass. They are now tagged `robinhood`.
  - Robinhood's real cost: v1 shows ~0.94 % spread per side; v2 is near-mid, with account `feeRatio` 0.0095 per side. The strict book needs a ≥ 3 % expected move; expect very few trades.
  - The `badQuotes` fallback, the tape tag and the uncrossing have NOT been checked against the live app yet. That needs a build and install.
- **HUD (`400e54e`), bing request: "no scrolling, things get smaller so it all fits".**
  - `fitWindow` zooms the visible pane (50–100 %) to fit the window. It refits on resize (ResizeObserver), DOM changes (MutationObserver), tab switch and maximize.
  - Each window has a title-bar toggle, stored in `mpo-fit-off`, and a zoom-% badge.
  - Panes are container-query roots. `.mpo-split` gives Pump.fun and Polymarket two columns at ≥ 820 px layout width. Robinhood views are an auto-fit card grid (minmax 360 px). A maximized Pump.fun chart fills the left column.
  - The taskbar **Tile** button puts trade/robinhood/sportsbook in the top 64 % and the rest below.
  - Polymarket AUTO COMBO and research are `<details data-keep>` folds (open state in `mpo-open-details`).
  - Preview (isolated, 1440×900, six windows tiled): Pump.fun 75 %, Robinhood 61 %, Money 67 %, System 60 %; all fit. Polymarket fits only at the 50 % floor and scrolls because the isolated engine shows the key form; it is parked.
  - The dashboard server caches `dashboard.html` at startup: restart it to see edits.
- **Evolution Lab "can't start":** the Lab backend is healthy (RUNNING, gen ~79.8 k), but the installed Lab asar (04:02) predates the window fix `893b6b7` (04:48). Relaunching opens a splash that never loads.
  - Workaround: open http://127.0.0.1:8793, or end the Lab in Task Manager and relaunch it.
  - The Lab session was told; it owns the build and install of `cb3c389`.
- **Tests:** `npm run test:all` **612 pass / 0 fail** (+3).
- **Not built or installed.** bing's app is still alpha.58 without these changes.
- **Pending:** a read-only workflow is inventorying the paper-wallet settings for Robinhood and Pump.fun, to propose a settings batch.

## Planning pass (2026-09-26, read-only): self-improving loop prompt

- New `reports/SELF-IMPROVING-LOOP-PROMPT-2026-09-26.md`: six ordered batches (A stop bleeding + evidence flow, B measure, C fitness ledger, D Lab honesty, E closed Robinhood paper loop with revert, F unattended ops), park rules, owner actions and a definition of done. **Start the next session with its Batch A.**
- Corrections found while planning: the Solana cost gate does not shrink the Lab feed (the learner samples the top 30 every cycle); the 1 GB lab-link tape quota was reverted in batch 14 and does not exist; Lab alpha.5 publishes every Solana champion as RESEARCH_ONLY, so the MacBook alpha.53 falls back to BASE on its next read.
- No code changed by this pass. The Robinhood quote fix landed separately in 9ef08a9 (alpha.59); Batch A item 1 is now just confirming it is installed.

## Side batch 3 (2026-09-26, Lab session): Robinhood proposal lifecycle (Lab alpha.6)

- Lab `5f2357f` fixes the five review follow-ups from side batch 2:
  - An applied proposal is withdrawn, so the MPO panel no longer shows PAPER REVIEW READY forever.
  - A standing proposal is re-scored every pass and withdrawn when it no longer beats the current settings by minGain, or after 48 h (`MPO_LAB_ROBINHOOD_PROPOSAL_MAX_H`).
  - Warm-up passes review it too.
  - A failed delete falls back to a WITHDRAWN record; if that also fails, it shows as a blocker.
  - The status has `lastWithdrawn`.
  - The blocker wording is corrected (trades seen on any candidate, search timeout, negative gain).
- The test uses real scoring on a fee-free trending tape. Lab suite 163/163.
- Version bump `f67b02e` (0.1.0-alpha.6). Asar built and verified: sha256 `6c181523…`, in the Lab session scratchpad `build6\app.asar`.
- **Not installed yet:** bing ends the Lab task, copies the asar over `resources\app.asar` (backing up alpha.5 as `app.asar.alpha5-backup-20260926`), and relaunches from the Start menu.
- **Next Lab work:** the Solana scorer (freeze stop/take/hold until exits are simulated, drop maxHoldMin from velocity, score MPO's real SPRINT policy as the incumbent). This overlaps Batch D of `reports/SELF-IMPROVING-LOOP-PROMPT-2026-09-26.md`, so follow that plan's order.

## Batch A (2026-09-26): stop the bleeding, make evidence flow (self-improving loop plan)

- **Robinhood quote fix is live.** Installed alpha.59 shows `/api/robinhood` `readiness.paperQuoteSource:'robinhood'`, `lastError:null`. New test: a 6 bps cross stays crossed, is rejected by `fresh()` and never reaches the tape as robinhood (the v2 → `src:'robinhood'` test already existed).
- **Paper SPRINT auto-demote.** `paperProfileDemotion()` in `src/solanaEconomics.js`, called at cycle start in `src/index.js`. In paper mode, a profile whose preset tp1 fails the cost gate at the config-floor round trip (SPRINT: tp1 4 vs required 6.3) switches to FAIR the same way the profile action does. It is journaled as `profile-auto-demote`. It never promotes, never touches live, and does nothing if FAIR would fail too.
- **Robinhood outbound audit.** `rhCallStats()` in `src/robinhoodTransport.js` counts GET, POST and refused POSTs per process. Snapshot field `outbound`. `rhRequest` refuses any POST outside `/api/v[12]/crypto/trading/orders/[<id>/cancel/]`. Test: paper ticks plus a paper order make 0 POSTs.
- **Champion gate pins** in `tests/lab-link.test.mjs`: a PAPER_CANARY champion with promotion false, a missing `paperPromotionAllowed`, a foreign labNodeId, and a stale bridge (disconnected) all give a null policy.
- **Kill switches, read-only.** Trader `/api/health` `switches` (`src/killSwitches.js`: labLink, robinhoodAutostart, paperOnlyBuild, realEnabled, sessionArmed). Lab `/api/health` `switches` (paused, beast, gpu, workers, modulesActive, bridge). Lab commit on `codex/lab-evidence-20260925`.
- **Tests:** trader **619 / 0** (+7). Lab **158 / 158** (+1). The plan's "163" Lab baseline does not match the three current `test:all` scripts (30 + 53 + 75).
- **Owner-only:** build and install the trader (for auto-demote, the outbound audit and health switches) and the Lab (for health switches). Until then, clicking FAIR by hand has the same effect as the auto-demote.
- **Next:** Batch B (measure before searching).

## Batch C (2026-09-26): champion lifecycle state (MPO side)

- New `src/championState.js`: INCUBATOR -> SHADOW -> PAPER -> LIVE (`stateSchema: mpo.champion-state.v1`). Missing, unknown or newer-schema state reads as SHADOW. LIVE is treated as PAPER (never real money).
- Paper now requires state >= PAPER **and** `paperPromotionAllowed`. Wired into `labLink.js` (Solana policy), `robinhoodAutoTrader.js` (view + apply-lab), `polymarketUSEvidence.js` + `dashboard.js` apply-lab (409 when not cleared).
- **Consequence:** until the Lab writes `state`, every Lab champion reads as SHADOW and nothing paper-promotes. Lab batch (writer + seeded slippage + trial count + DSR-style promotion gate) is next.
- Tests: new `tests/champion-state.test.mjs`; `lab-link` fixture now carries state PAPER. Full per-file sweep green except `robinhood-evidence` (untracked, pre-existing, fails without these changes too).
- Robinhood mute: no code; `ROBINHOOD_AUTOSTART=false` already stops the loops. The 401 is Polymarket's, not Robinhood's.

## Batch D (2026-09-26): editable Controls (Pump.fun)

- The three readonly Controls boxes showed env caps that paper mode never used (open limit came from aggression, stop from the exit preset). Replaced with real knobs: entry frequency, candidates scanned, max-open override (blank = auto), exit preset, and custom tp1/tp2/stop/trail/max-hold (editing switches to custom). Env caps are now shown as live-mode hard limits text.
- Engine: `runtime.js` gains `sanitizeCustomExit`/`customExitPolicy`/`openLimitFor` (hard bounds); `index.js` `preset()` and `blockStatus` use them; the `runtime` action accepts `customExit` and `maxOpenPositions`. `/api/state` exposes `effectiveControls` (incl. a note when a Lab paper champion overrides exits).
- Verified end-to-end in an isolated engine (`engine-controls` launch config, port 8811). New `tests/runtime-controls.test.mjs`. Sweep green except pre-existing `robinhood-evidence`.

## Batch E (2026-09-26): Lab Crucible (Lab commit cd02376 on codex/lab-evidence-20260925)

- Scorer: the stop/take clamp filled every stop exactly at the stop. Now `exitFill` (gap-through stops realize half the overshoot + stress slippage; takes fill under the limit). Deterministic; mirrored in packed JS, Python reference and Torch scorer. Beast baseline fingerprints regenerated. **Python/Torch parity not run here (no numpy/torch on this machine).**
- `src/deflatedSharpe.js` (real Bailey/Lopez de Prado DSR, lifetime trials). Solana: computed per generation on walk-forward folds and published (state stays SHADOW). Robinhood: proposal now also needs DSR >= 0.95 on holdout closes; lifetime `trialsTotal` in module status. **This part lives in `moduleResearch.js` and is NOT committed** (file also holds another session's unfinished Batch B).
- Module/Solana champion records carry `stateSchema: mpo.champion-state.v1` + `state`, so MPO batch C now reads real states.
- Blockers from the other session (not this batch): Lab `moduleResearch.js` imports `./robinhoodEvidence.js` which is missing in the Lab repo (breaks `module-research` and `polymarket-combo-research` tests); with MPO's copy supplied, its `realisticSpreads` breaks the RH-LAB-G9-win fixture. MPO batches C/D are uncommitted because the same files carry that session's hunks.

### Next recommended batches

1. ~~Walk-forward~~ done in batch F.
2. ~~Stress replay~~ done in batch G.
3. ~~Always-on data~~ done in batch H.
4. ~~Shadow vs backtest~~ done in batch I.

## Batch F (2026-09-26): walk-forward promotion (Lab commit fdc852b)

- `src/walkForward.js`: 12 rolling windows; pass = >=6 active windows (>=5 trades), >=60% positive, positive median.
- `selectChampion()` in `evolutionEngine.js`: the top 32 gate-passing challengers (`MPO_LAB_WALK_FORWARD_TOP_K`) are replayed; the best consistent one is promoted, lucky top scorers are skipped (event logged). Ranking scorer untouched, so GPU parity is unaffected. Published as `walkForward` in lab status.
- Tests: new `tests/walk-forward.test.mjs` (4), `test:evolution` 53/0. The only failures in the Lab sweep are the two from the other session's Batch B.
- MPO batches C/D are still uncommitted, waiting on a/b/c (other session's Batch B overlap).

## Batch G (2026-09-26): stress replay (Lab)

- `src/stressReplay.js`: 1000 seeded scenarios (friction 1-2.5x, stop slip 0.5-3%, gap share 30-90%, take shortfall, latency drag, adverse-selection misses). Pass = p10 scenario avg trade > 0.
- `selectChampion` now needs gates + walk-forward + stress replay; rejections logged; summary in status `walkForward.stress`. ~0.8 s per challenger at 50k trades.
- Tests: `tests/stress-replay.test.mjs` (4) + selection veto test; `test:evolution` green.

## Batch H (2026-09-26): always-on data + coverage (MPO, uncommitted)

- Solana ticks and the Robinhood tape are produced by the engine, so data stopped whenever the window closed (`window-all-closed` quit the app). `desktop/main.cjs`: closing the window now hides to a tray icon (Open / Quit) when `runInBackground` (default on); `startWithWindows` (default off) sets a login item launched `--hidden` into the tray. Prefs live in `<data>/desktop-prefs.json`, polled every 1.5 s.
- `src/dataCoverage.js` + `GET /api/data-coverage`: per source (Solana path, Polymarket depth, each Robinhood symbol) status LIVE/STALE/DOWN/NO_DATA, last-row age, 7-day per-day rows, largest gap. `GET/POST /api/desktop-prefs`. Settings window gets a Background & data panel.
- Verified in the isolated engine (panel, toggles persist). **Tray/login-item behavior not exercised: needs the packaged Electron app.** Test: `tests/data-coverage.test.mjs`.
- Still uncommitted with C/D: `dashboard.js` also carries C's apply-lab 409 which depends on the entangled `polymarketUSEvidence.js`.

## Commits (2026-09-26)

- MPO `d4d029f`: batches C, D, H plus the other session's unfinished Batch B (labelled; `robinhood-evidence` test has 2 failures from that work).
- Lab `695e789`: Robinhood DSR gate + Batch B; `robinhoodEvidence.js` copied from MPO so its import resolves. Known failure: RH-LAB-G9-win fixture in `module-research` (Batch B realisticSpreads).

## Batch I (2026-09-26): shadow vs backtest (Lab commit, see git log)

- `src/shadowValidation.js`: champion picks on outcomes after `promotedAt` = shadow trades; two-sample KS vs its backtest. Solana champion record becomes `state: PAPER` + `paperPromotionAllowed` + `PAPER_REVIEW` only when: crucible-promoted (walk-forward + stress), DSR >= 0.95, >= 30 shadow trades, KS p > 0.05, shadow avg > 0. `champion.stage` stays RESEARCH_ONLY (alpha.53 safety). Republished when qualification flips.
- **This is the first path by which a Solana Lab champion can reach MPO paper trading.** Verified cross-repo: MPO `championState` reads the record as PAPER/SHADOW correctly.
- Tests: `tests/shadow-validation.test.mjs` (3). Lab sweep: only the known Batch B fixture failure.

### Next recommended
- Build/install the Lab and MPO (signing is bing-only) and check the tray/login-item behavior in the packaged app.
- Fix Batch B: robinhood-evidence tests (MPO) and the RH-LAB-G9-win fixture (Lab).
- GPU box: run `research/gpu-furnace` pytest to confirm Torch/Python parity for exitFill.

## Robinhood search: batch 1 in progress (2026-09-26)

- Done: Lab `src/robinhoodHistory.js` (Coinbase 1m candles -> four 15 s samples, src coinbase-history, per-day cache, bounded backfill) + test. MPO `7280714`: PAUSED/KILL SWITCH badge + Resume on Pump.fun.
- **Next (not done):** wire into `runRobinhoodResearch` in Lab `moduleResearch.js`: syncHistory each pass; search = history (before the first live row) + live search split; holdout = live-tape holdoutSplit only (keeps the 90% Robinhood-quote gate); enoughTape from search span; status fields historyDays/historyRows. Then batch 2 (longer-hold strategy families) and batch 3 (worker pool, no 15 s cap).

## Wallet Intel / copy-trading scoping (2026-09-26, read-only, no code changed)

- **Wallet Intel is empty and has never worked on this install.** `walletProfiles` is 0 in the live `/api/state` and in `research-state.json`, and all 829,465 `token_observations` since Sep 10 carry the default `holder_quality=50`. Cause: `getTokenLargestAccounts` on the free public RPC (`SOLANA_RPC_URL=api.mainnet-beta.solana.com`, no backup) returns 429 "Too many requests for a specific RPC call" every time. `mintRisk` (`src/rpc.js:13`) swallows the error silently, so `riskMs` sits at ~1.1 s (the timeout). **Side effect: the top1/top10 holder-concentration rug checks are also blind** (the `holder-data-unavailable` warning is the only trace).
- Even when it works, the design isn't copy trading: the score counts how many tokens a wallet is a top-10 holder in (`src/research.js:29`), with no profit measure. Raydium's authority `5Q544f...` already shows up in our tx data as a "wallet".
- Better raw material is `alpha-lab.sqlite` `tx_events` (`src/transactionIndexer.js`): 93,787 buy/sell events, 33,029 wallets, 4,561 tokens. It is **too thin to grade wallets**: 52% of events have `sol_delta=0` (no SOL amount), a median of 12 events per token (last 40 signatures per pull), bursty days (35k on Sep 11, about 20 on Sep 22 and 24), only 31 wallets with 3 or more round trips, and `wallet_funding` is 0 because `HELIUS_API_KEY` is empty. The Helius path also hard-codes `solDelta:0`.
- First out-of-sample copy test (grade on data before Sep 19, test after; buy 15 s after the wallet; before fees): all captured buys had a median of -0.2% at 5 m and -3.5% at 60 m. The 5 "profitable" wallets from the grading period did worse than average in the test period (n=25). No signal, and the sample is far too small to conclude anything. Scripts are in the session scratchpad (not in the repo).
- **Proposed copy-trading batch 1 (not started; needs bing's go-ahead plus a Helius or other paid RPC key):** (1) a real RPC for holder lookups, logging 429/timeouts to feed health instead of swallowing them; (2) record SOL spent/received per swap in both indexer paths; (3) a wallet scorecard (realized PnL, win rate, hold time, how early it buys) that excludes pool/program accounts, replacing `recurrenceScore`; (4) a Lab paper-only "follow wallet" family, graded walk-forward like everything else. Real-money copying stays out of scope.

## Batch J (2026-09-26): holder lookups fixed (copy-trading step 1), branch `fix/holder-rpc-helius` from alpha.60 main

- `src/rpc.js`: optional `HOLDER_RPC_URL` used **only** for `getTokenLargestAccounts` + owner resolve (`getMultipleAccounts`), 2 calls per token checked. Everything else stays on `SOLANA_RPC_URL`, so the tx indexer's 40-call bursts don't hit Helius. `HOLDER_RPC_DAILY_CALLS` (default 25000, 0 = no cap; Helius free = 1M credits/mo, 1 credit per standard call). Per-UTC-day counters ok/429/timeout/error/cap, `[holder-rpc] <STATUS>` log line on status change, API key redacted and never reported. `holderRpcHealth()` goes to `/api/state` as `walletIntel.holderRpc`.
- HUD Wallet Intel: a "Holder data" badge (OK / RATE LIMITED / TIMING OUT / ERROR / DAILY CAP HIT / WAITING), provider and calls today; the empty state says why.
- **Do not set `HELIUS_API_KEY` yet:** `HELIUS_REQUESTS_PER_MINUTE` defaults to 0 = unlimited, and the enhanced path costs 100 credits a call and also fires per-wallet funding lookups. That is step 2 work.
- Tests: `tests/holder-rpc.test.mjs` (4, local mock JSON-RPC: 429 visible and key not leaked, OK path with owners, cap stops calls, no-URL fallback), in `test:solana`. `test:all` **639 pass / 0 fail**. Isolated engine (8813, no holder URL) showed RATE_LIMITED from the public RPC and the badge rendered.
- Build: `Desktop\Money Printer OS\Windows-140e923-holder-rpc\app.asar`, release `0.5.0-alpha.60+windows.140e923`, sha256 `d02b72147e7affcd2a13c3e4985ba013ef51ab065145be4ed2689d32a1549e42`; `smoke:windows` on 18792 passed. **Not installed yet**: waiting for bing to add `HOLDER_RPC_URL=<Helius mainnet RPC URL>` to `%APPDATA%\Money Printer OS\.env`, then swap + relaunch + check `walletIntel.holderRpc.status == OK` and wallets filling.

## Icon refresh (2026-09-26)

- The user supplied new art. Pump.fun (`icons/trade.png`) is the pill, Polymarket US (`icons/sportsbook.png`) is the Polymarket mark, and Robinhood has a new feather icon (`icons/robinhood.png`, now in `ICON_PNG`; it used to fall back to the `RH` glyph). The Money Printer OS cash stack replaces `icons/money.png` (desktop icon and Start button), `money-printer-logo.png` (1024), `app-icon.png` (256, window/tray) and `build/icon.icns` (11 PNG reps, 16-1024).
- The logo source had a flat white background, so it was cut out with a border flood fill plus color-to-alpha on a 3 px edge band. There's no numpy here, so this used Pillow only. The script is in the session scratchpad, not the repo.
- `tests/visual-assets.test.mjs` now also checks `robinhood.png`. Visual tests: 26/0. Checked in the isolated engine: every icon loads at 96 px.
- **Pending:** new Journal and Settings icons, and the "MONEY PRINTER OS" wordmark image for the top-right corner `.brand` (currently CSS text). They were sent mid-turn and never reached disk, so they need to be re-attached.
- **Installed and verified (2026-09-26 13:08Z):** bing added `HOLDER_RPC_URL` (Helius mainnet; `HELIUS_API_KEY` left empty). A direct `getTokenLargestAccounts` test returned 200 with 20 holders in 178 ms. App stopped (polite close, then force, same as the update script); backup `resources\app.asar.alpha60-backup-20260926-090805`; new asar hash verified `D02B7214...`; relaunched. `/api/state`: alpha.60, paper, `holderRpc` **OK via mainnet.helius-rpc.com**, 0 errors, ~66 ms, Wallet Intel populated for the first time. First-minute rate ~14 calls/min (about 20.7k/day projected, under the 25k cap). Recheck the day's `calls` / `budgetSkips` later and tune `HOLDER_RPC_DAILY_CALLS` if the cap gets hit.
- Rollback: quit the app, copy the backup over `resources\app.asar`.

## Kalshi module scoping (2026-09-26, read-only, no code changed)

bing asked how hard a Kalshi module would be and what it adds. Findings were web-researched against docs.kalshi.com, the rulebook and CFTC filings, and Kalshi's live public API (no key). Each critical claim was checked by a second agent.
- **Adds that we don't have:**
  - Combos without a beta gate. Rulebook 5.3 lets any direct member RFQ, and the spec has no allowlist. Not tested end to end with a Basic account. It needs a direct Kalshi account, not Robinhood (FCM customers aren't members).
  - A demo exchange with mock funds, for testing order paths only. Demo prices are not evidence.
  - Keyless REST for markets, orderbook, trades, candlesticks and `/live_data/*` (game_stats may supply the sports clock; unconfirmed). The WebSocket needs a key.
  - Non-sports markets: CPI/Fed, weather, 15-minute/hourly crypto ranges. They are legal in every state.
  - A second price on the same US games.
  - Volume about 8x Polymarket US, but only about 2x in straight sports. 53% of September's volume is combos.
- **Doesn't fix:**
  - Taker fee is the same: 0.07·P(1−P) vs PM US 0.0695. Makers are worse off: Kalshi charges 0.0175 on major sports, PM US pays a 0.0125 rebate. Combo maker fee 0.035 since 08-20.
  - Retail parlay takers lost about 15% (Jan–Apr 2026). Our PM US evidence shows no edge: 465 legs, −1.3 to −4.5 pp after fees; shadow combos −18% to −37%.
- **Legal:** sports are blocked or geofenced in NV, WA, MI and some CA tribal land. UT, OH, TN, CT and IA can now enforce. MD and MA are pending. Non-sports markets are available everywhere.
- **RFQ rule 5.3(b)(h):** RFQs must be bona fide. A paper lane must not fire production RFQs to harvest prices.
- **Effort:**
  - Keyless evidence lane (collector tick, the same calibration, a Lab `kalshi` lane): S–M, 1–2 batches.
  - Paper/demo singles trader plus a HUD window: L, about Robinhood's size. Wait until after the HUD declutter.
  - Real-money combos: L, and they need a policy change.
  - Signing is easy: Ed25519 is accepted since 09-24, the same scheme as PM US. RSA PEM would break `rewriteEnv` (strips newlines).
- **Recommendation given:** don't build the full module now. Optional next step: the keyless evidence lane only, to test major-league calibration, cross-venue gaps after both fees, and BTC ranges vs the Robinhood volatility model.
- **Found in passing:** the `/api/polymarket-us/*` POST routes (`src/dashboard.js:493-506`, including `/arm` and `/combos/autopilot`) lack the localhost/Origin/JSON/sec-fetch-site guard in `src/robinhoodHttp.js:11-26`. `body()` parses any content type.

### Next recommended
- **HUD declutter (bing, 2026-09-26):** "too much clutter when you open a window; the full detail should be an option; keep it sleek; text too small." Measured on the live HUD at 1280x720: 3 windows open stacked on launch, 793 visible text elements, most at 10-12 px. Proposal in chat: bigger base text plus a size setting, one window on launch, a summary-first view per window with a Details toggle, empty/idle sections hidden.
- Copy-trading step 2 (SOL amounts per swap, capped Helius indexer) once the holder data has been flowing for a day or so.

## Batch K (2026-09-26): HUD declutter, Simple / Advanced (branch `feature/hud-declutter`, on top of `fix/holder-rpc-helius`)

- bing's direction, in order: too much clutter, text too small; think like an art director; keep the Windows 98 theme ("slightly higher-tech Win98"); don't gut the graphs; add a switch between simple and advanced for every window so nothing is lost.
- **Simple mode (default):** each window opens as one card: sunken LCD hero number, three LCD readouts, the window's live graphs in sunken panels, and a sunken status bar. Pump.fun: tape ticker, Task Manager-style equity graph, meme gauge, opportunity map, entry funnel. Polymarket: live-games lanes, price vs floor, top picks. Robinhood: tape ticker, LCD price tiles, edge meter. System: CPU/memory history graph (client-side, about 6 min) and a service list with LEDs. Journal: latest 14. About: module status list. `public/css/mpo-glance.css`; `glance()` / `GLANCE` registry / `taskGraph()` in `dashboard.html`.
- **Advanced mode:** the previous workstations, unchanged. There is a taskbar `Simple | Advanced` switch (all windows) and a per-window title-bar button; opening a specific tab switches that window to Advanced. Settings > Display: text size S/M/L (the fit-zoom ceiling, default 1.25), Advanced everywhere, reopen every window at launch.
- Launch opens only the last-used window, centred. `LAYOUT_VERSION` is now `2026-09-26-glance` and `DEFAULT_OPEN=['trade']` (test pins updated in visual-contract, robinhood-hud, robinhood-http). Visible text elements at launch went from 793 to about 60.
- Data for glances keeps flowing: `windowShown()` gates fetches, and `windowVisible()` (detail renderers) is false for glance windows.
- Fixed: Settings > Reset window layout never worked (the beforeunload `persist()` wrote the old layout back); `layoutResetting` guard.
- Tests: `test:all` **640 pass / 0 fail** (new glance contract test). Previewed in an isolated engine on 8813 at 1440x900: every glance, the switch both ways, and the Settings display section.
- Build: `Desktop\Money Printer OS\Windows-68c1a40-glance\app.asar`, `0.5.0-alpha.60+windows.68c1a40`, sha256 `e93aa4b6b2822acfc4fc73bd73eb642f97efbc9899c57a8e592d7cc23ed9d445`, smoke on 18792 passed. Includes batch J. **Not installed yet**: waiting on bing's OK.
- Untracked `artifacts/sky-refs/` and `artifacts/money-fx-refs/` belong to another session; left alone.
- **Installed (2026-09-26 13:32Z) on bing's go:** backup `resources\app.asar.holder-rpc-140e923-backup-20260926-093252`, new asar hash verified `E93AA4B6...`, relaunched. Live check on 8792: alpha.60 paper, holder data OK, the page serves `mpo-glance.css` (200) and the mode switch, no console errors; the Pump.fun glance rendered with live data (1.3777 SOL, +0.3380 today, 8 open, 37% hit rate, lab gen 87,390). Rollback: quit, copy that backup over `resources\app.asar`.

### Next recommended
- bing's feedback on the installed glances (tune per window).
- Push `fix/holder-rpc-helius` and `feature/hud-declutter` and open PRs to main (not done; ask first).
- Copy-trading step 2 once holder data has flowed for a day (SOL per swap, capped Helius indexer). Check the day's holder `calls` / `budgetSkips` against the 25k cap.

## Batch L (2026-09-26): Codex's unfinished work finished and merged to main

bing: "Codex got halfway through some work… finish it, push everything to main, get it started on Windows and Mac."
- **Found two pieces of Codex work.**
  1. Uncommitted here: the MPOS core platform (`src/core/`, `docs/MPOS-UNIFICATION.md`). It has a common SQLite ledger `<data>/mpos-core.sqlite`, a Risk Governor with a persistent STOP, Kalshi + global Polymarket public providers, paper proposals/fills against observed depth, and HUD windows Command Center, KALSHI.EXE, ARBITRAGE.EXE and Polymarket Markets (`public/js/mpo-platform.js`). Also the Robinhood practice book, the lane registry and the money-physics module.
  2. Committed on `feature/sunny-desktop` (Codex worktree `~/.codex/worktrees/sunny-release`): sunny sky, cloud sprites, 3D corner logo, window layouts restored across restarts (`desktop/window-state.cjs`).
- **Policy change carried by (1):** `src/core/executionBoundary.js` makes every live transport refuse while accounts are unreconciled: Jupiter/Jito sends, Polymarket US orders and RFQ accept/confirm, Robinhood order POSTs. Cancels and reads still work. There is no switch to bypass it. This matches the standing "no real-money execution" decision.
- **Bugs fixed in Codex's code:**
  - The platform's SQLite handle stayed open after the dashboard closed, so Windows couldn't delete the data dir (EPERM in product-economics-http, which stopped `test:all` at suite 7). `closeMarketPlatform()` now runs on server close.
  - Robinhood practice never got a quote in the real app. It passed `now` as a number to `fetchPublicPaperMarket`, which calls `now()` ("now is not a function", loop BLOCKED). An adapter fixes it; pair metadata is no longer fetched.
  - The practice entry signal compared each quote with the tape point it had just appended: momentum could never fire, and mean reversion fired on the spread every tick. It now compares mid with the previous tick's mid.
  - A practice error stuck in `blockingReason`/`lastError` forever after one failure. It clears on the next good fetch.
  - Kalshi's first page was all multivariate (MVE) parlays with empty books. `mve_filter=exclude` added (checked live).
  - Platform tables broke "Inspect"/"Watch" mid-word.
- **Tests:** new `tests/robinhood-practice.test.mjs` (7). `test:lane-contracts` now also runs `market-core` plus orphaned files no script ran (`champion-state`, `data-coverage`, `runtime-controls`); `window-state` joined `test:visual`. **`npm run test:all`: 695 pass, 0 fail.** SELFTEST PASS.
- **Browser check (isolated engine, no keys):**
  - Command Center, Kalshi (100 live markets with depth), Polymarket Markets (100), Arbitrage (correctly NOT EQUIVALENT for unrelated contracts).
  - Paper flow: a $100 simulated deposit, then 5 YES at 14¢ filled at $0.70 plus the 1% modeled fee, recorded in the ledger.
  - STOP ALL LIVE TRADING → HALTED → resume → GREEN.
  - Practice loop IDLE with live Coinbase quotes.
- **Merge:** `feature/sunny-desktop` merged (its other 3 commits were rebased copies of ones already here). Conflicts: package.json scripts, dashboard.js wiring, brand subtitle colour (kept white/outlined; readable on the new sky). `artifacts/sky-refs/` committed as design references.
- **Left as-is (parked):** `src/polymarketPaperCombos.js` has no route, UI or test, and overlaps the shadow auto-combo lane. `src/moneyPhysics.js` and `src/researchLaneRegistry.js` are tested but not wired. The Robinhood practice book has API routes but no HUD panel yet.

### Next recommended
- A Robinhood practice panel in the Robinhood window (the routes exist: `/api/robinhood/practice`, `practice/config|run|order|close|reset`).
- Decide whether to wire or delete `polymarketPaperCombos.js`.
- MacBook: still alpha.53 until it's updated (see the Batch L install record).

### Batch L install record (2026-09-26, 14:40 local)
- **Pushed:** `origin/main` fast-forwarded `8ae2795 → 6b24708`; `feature/hud-declutter` pushed; local `main` fast-forwarded (it was a strict ancestor). GitHub renamed the repo, so `origin` now points at `https://github.com/m3-jake/Money-Printer-OS.git`. CI result not checked (no `gh` on this machine).
- **Windows:** `npm run release:windows-asar` → `Desktop\Money Printer OS\Windows-6b24708-20260926\app.asar`, release `0.5.0-alpha.60+windows.6b24708`, sha256 `1af4d2e9e13d1ba34687ab1b1605a2656187b631065f6c4da021f4a5b01e017c`. `smoke:windows` on 18792 passed. The app wasn't running; backup `resources\app.asar.pre-6b24708-backup-20260926-144040` (that was the sunny build installed 13:19); new hash verified; launched. Live on 8792: paper, HEALTHY, holder RPC OK, `/api/platform/status` GREEN, practice loop IDLE with 2 fresh quotes, sunny assets served. Rollback: quit, copy the backup over `resources\app.asar`.
- **Mac: not done from here.** No reachable session or SSH, `build-unified.mjs` must run on macOS arm64, and the updater only takes releases signed with bing's key. bing runs on the MacBook: clone/pull `main`, `npm ci`, `npm run release:unified`, then swap the `.app` per the build's `START-HERE.txt`. The MacBook is still alpha.53 (the ungated-champion hazard from the Lab audit) until then.

## Batch M (2026-09-26): unification plan, Risk Governor hardening (Phase 1)

bing pasted the full MPOS unification brief (35 sections, phases 0–7). Phase 0 and most of Phase 1 already exist from Codex's `src/core/` work (batch L), so this batch hardens it rather than rebuilding it.
- **Bug fixed:** `evaluateRisk` applied the daily loss, drawdown and unknown-loss-state limits to SELLs too. Once the book hit its daily loss limit, it could not close losing positions. Loss limits now block new BUYs only. GLOBAL_HALT still blocks everything.
- **Risk states:** the governor only ever reported GREEN or HALTED. `portfolioRiskState()` now derives GREEN / YELLOW (50% of a loss limit used) / RED (limit reached or loss state unknown) from the PAPER ledger. `state()` returns `stateReasons` and `metrics`. Command Center shows the state light in yellow/red plus the reasons.
- **Tests:** 2 regression tests in `tests/market-core.test.mjs` (18 pass). `npm run test:all`: **700 pass, 0 fail**. No browser check this batch (small CSS/label change).

### Next recommended (unification brief, in dependency order)
1. ~~Strategy lifecycle~~ done in batch N.
2. Phase 1: read-only import of legacy books (Solana, Robinhood practice, US combos) into the core ledger as `LEGACY` coverage, so Command Center totals stop excluding them.
3. Phase 2: POLYMARKET.EXE consolidation (Markets / Live / Sports / Positions / History / Combo Engine), and decide on `polymarketPaperCombos.js`.
4. Phase 2: contract-term extraction for Kalshi/Polymarket so ARBITRAGE.EXE can reach STRONG/EXACT for real pairs (today every pair lacks verified terms).

## Batch N (2026-09-26): strategy registry and lifecycle (Phase 1 / Phase 6 foundation)

- **New `src/core/strategies.js`:** the `strategies` table holds the common metadata (id, name, version, markets, params, allocation, state, execution mode, evidence). `strategy_transitions` is append-only, enforced by UPDATE and DELETE triggers. States are DRAFT / BACKTESTING / PAPER / CANDIDATE / LIVE / PAUSED / RETIRED, with explicit allowed edges. RETIRED is terminal.
- **Promotion gate (`promotionCheck`):** moving to PAPER or CANDIDATE needs all of these: sample size, fees and slippage modeled, out-of-sample net profit after costs, max drawdown, and share of positive walk-forward folds. CANDIDATE also needs Brier calibration for probabilistic strategies. Missing values fail closed. LIVE is refused outright, in line with the no-real-money policy.
- **Lab mapping:** `labChampionLifecycle()` reads a Lab champion's INCUBATOR/SHADOW/PAPER/LIVE state as DRAFT/BACKTESTING/PAPER/PAPER. It is a read-only mapping and does not change the Lab's own lifecycle. Syncing Lab champions into the registry isn't wired yet.
- **API and UI:** `GET /api/platform/strategies`, `GET /api/platform/strategies/history?id=`, `POST /api/platform/strategies/register` and `POST /api/platform/strategies/transition`. Transitions write a project-journal milestone. Command Center has a Strategies table.
- **Tests:** 2 new tests in `market-core` (20 pass). `npm run test:all`: **703 pass, 0 fail**. Browser check on an isolated engine (`engine-core`, :8851): register → BACKTESTING worked; PAPER without evidence was refused with all five blockers named; the table rendered.

### Next recommended
1. ~~Legacy books~~ done in batch O (as a read-only view, not ledger rows).
2. Sync Lab champions (`lab-link/modules/*-champion.json`) into the strategy registry, using `labChampionLifecycle` and the champions' walk-forward evidence.
3. POLYMARKET.EXE consolidation; contract-term extraction for ARBITRAGE.EXE.

## Batch O (2026-09-26): legacy books visible in Command Center (read-only)

- **Decision:** the Solana, Robinhood practice and US combo books are shown **next to** the core ledger, not imported into it. None of them has a reconciled import, and copying them in would double-count them once one exists. Currencies are never converted: SOL stays SOL, and no SOL price is invented.
- **New `src/core/legacyBooks.js`:** pure views (`solanaLegacy`, `robinhoodPracticeLegacy`, `usCombosLegacy`, `legacyTotals`, `legacyCoverage`). A missing value stays null ("unavailable"). A failing reader shows UNAVAILABLE with the reason instead of breaking the snapshot. US combos are labelled `LIVE_UNRECONCILED` and count unverified fills. Solana realized P/L covers only the retained history (last 1500 closes), and the table says so.
- **Wiring:** `MarketPlatform.setLegacyReaders()`; the dashboard passes `loadStateCached`, `practiceSnapshot` and the new `usComboJournalView()` (a read-only journal copy with no feed or signed calls). `/api/platform/status` has `legacy`. Command Center has a Legacy books table.
- **Tests:** 1 new test in `market-core` (21 pass). `npm run test:all`: **714 pass, 0 fail**. Browser check on the isolated engine (:8851): Solana 0.83 SOL cash / 3 open / -0.0146 SOL realized; Robinhood practice 500 USD; US combos cash "unavailable".

### Next recommended
1. ~~Lab champion sync~~ done in batch P.
2. ~~Polymarket consolidation~~ first pass done in batch Q.
3. Contract-term extraction for Kalshi and Polymarket, so ARBITRAGE.EXE can rate real pairs above RELATED.

## Batch P (2026-09-26): no more ".EXE" names; Lab champions in the strategy registry

- **bing: "lose the .exe on all of these. It looks bad."** The window, taskbar and desktop names are now Polymarket / Kalshi / Arbitrage (`public/dashboard.html` app registry). In-window headings are KALSHI / ARBITRAGE, and the Command Center buttons were renamed too. **Rule for new modules:** plain names, never NAME.EXE, even where the unification brief suggests them.
- **New `src/core/labSync.js`:** five Lab champion files (`lab-link/champion.json` for Solana, plus `robinhood`, `robinhood-equities`, `polymarket` and `polymarket-combo` `-champion.json`) are mirrored into the registry as `lab-*` strategies.
  - The Lab state maps through `labChampionLifecycle`. A Lab PAPER champion without `paperPromotionAllowed` targets BACKTESTING, and WITHDRAWN targets DRAFT.
  - Moving up goes one step at a time through the **common** promotion gate, so a Lab PAPER champion stays at BACKTESTING with named blockers until the common criteria pass too. Demotions follow the Lab.
  - PAUSED and RETIRED (user decisions) are never overridden. A new champion id records a version revision (`StrategyRegistry.revise`, which appends a history row).
  - Records that claim live authority are ignored. The mapping uses only fields the Lab states explicitly; percent returns go to `outOfSampleNetPct` (the gate now accepts USD or pct), and `costsModeled` is true only if the Lab says fees or markup were modeled.
- **Wiring:** the dashboard syncs on start and every 60 s (the timer is cleared on server close, so tests don't reopen SQLite). There is also `POST /api/platform/strategies/sync-lab`, and `labSync` is in `/api/platform/status`. The Command Center strategies table shows Lab state and gate blockers.
- **Tests:** 1 new test in `market-core` (22 pass). `npm run test:all`: **730 pass, 0 fail**. Browser check (isolated engine; copied the installed app's Solana `champion.json`, which may be the stale MSIX copy): `lab-solana` BACKTESTING (Lab SHADOW), version = champion id; no ".EXE" anywhere on the page.
- **Known gap:** the Solana champion record has no fold-share and no fee flag, and module champions have no fold-share. So no Lab champion can reach PAPER in the registry yet. That is intentional (fail closed). The fix belongs in the Lab: publish `positiveFoldShare` and `feesModeled`.

## Batch Q (2026-09-26): Robinhood daily bars (trader side of Lab 0fa2673)

- **Daily crypto paper book** (`src/robinhoodDailyBook.js`): a new book inside the Robinhood module, with a "Daily bars" HUD tab, `GET /api/robinhood/daily`, `POST daily/run` and `daily/reset` (typed `RESET DAILY`), and `snapshot.daily`.
  - Data: Coinbase public daily candles, one request per symbol per closed UTC day.
  - One decision per closed bar, persisted before any fill, so a restart never repeats it. Missed days are counted and never decided afterwards.
  - Fills at the next open: a Robinhood quote if one arrives within 30 min of the open, otherwise the Coinbase open. Holds last as many days as the signal says.
  - Costs: max(0.95%, account fee) per side plus 5 bps slippage. The signal code is the Lab's own, and a parity test checks it against the Lab replay.
  - Paper only: the book imports no transport, signer or journal, and `liveEligible` is always false.
- **Which strategy it runs:** `daily.proposal`, but only when `championPaperAllowed` clears it, it claims no live flags and its params are in bounds. Otherwise it runs the Lab default `trend` SMA200 with a 2% band, labelled "LAB DEFAULT DAILY FAMILY · NOT A QUALIFIED STRATEGY". **Gap:** the Lab publishes `daily.proposal` without `state`/`stateSchema`, so today it reads SHADOW and is never cleared. The Lab needs to add `state: 'PAPER'` when it passes.
- **Qualification** (paper evidence only; it never unlocks live). All of these must hold inside a 365-day window, counting only trades under the current params:
  - at least 10 closed round trips and at least 180 paper days;
  - return above cash and above buy-and-hold (the same sleeves with the same costs);
  - drawdown no deeper than buy-and-hold;
  - profit factor at least 1.2.
- **Lab pass-through:** `robinhoodEvolveView` passes `lab.daily` through (null otherwise), and the Evolution panel shows a daily-verdict line. `labModuleStatuses` includes `robinhood-equities`.
- **Equities:**
  - `robinhoodEquities.js` applies `lab-link/robinhood-equities-champion.json` only when `championPaperAllowed` clears it and all of these hold: strategy `tactical-a`, bounded params in range (never clamped), every other param equal to its default, and the trader's own hash. Otherwise the defaults run. `snapshot.strategy.lab` says which.
  - Alpaca history now goes back 7 years (`ROBINHOOD_EQUITIES_LOOKBACK_DAYS`, minimum 6 years), and weekday bars from before the NYSE table are kept. A store from before this change refetches once. Before 2024, month-ends come from the data.
  - A successful fetch also writes `lab-link/robinhood-equities-bars.json`. Lab parity still holds: its equities-research test passes 7/7 against this tree.
- **Tests:** new `tests/robinhood-daily-book.test.mjs` (9) in `test:robinhood` and `tests/robinhood-equities-lab.test.mjs` (5) in `test:robinhood-equities`. Snapshot key pins now include `daily`. `npm run test:all`: **746 pass, 0 fail**.

## Session summary (2026-09-26 afternoon): audit + "use everything" batches (M–Q)

Audit first (read-only, verified): the Lab was installed and current, but it helped no module.
- **Solana:** the champion score was mostly an unsimulated hold time, friction was modelled at 0.64% vs a real 2.1%, and the stage handshake meant nothing could reach the trader.
- **Robinhood crypto:** the 0.95%/side fee versus a 4 h horizon meant it could never trade.
- **Polymarket Lab lane:** it studied the international CLOB, not PM US. A shadow settlement bug also left wins stuck OPEN.
- **Pump.fun:** gains came from SPRINT→FAIR. One trade (Support) was ~92% of the +0.30 SOL.
- **PM US balance:** read $0.09 (bing to check the app).

The owner then asked to use everything Robinhood and Polymarket offer (memory: robinhood-whole-platform) and to add copy trading.

Trader commits:
- `287f740` crypto fee fallback 0.95%.
- `1d146c4` Robinhood stocks/ETF paper lane: Alpaca IEX daily bars, key needed, otherwise NO_DATA. Strategy "tactical-a" = 200-day SPY trend sleeve plus dual-momentum rotation. `GET /api/robinhood-equities`. Docs §25.
- `da12894` Polymarket: durable outcome store (settlement fix), cross-venue gap log `raw/polymarket-cross-venue-*.ndjson` (strict slug match), singles calibration.
- `9f4627d` Robinhood window becomes a multi-asset suite (Stocks & ETFs tab, Practice tab, honest readiness).
- `e462f21` `/api/scoreboard` plus a Command Center SCOREBOARD card. YES only when a book still beats its baseline without its best trade and has at least 20 closes.
- `918f740` Pump.fun copy trading step 2: capped standard-RPC indexer in the collector (SOL incl. WSOL per swap, signers only, `wallet-indexer-budget.json`, default 7,258 credits/day) and a point-in-time wallet PnL scorecard (graded at ≥10 round trips).
- `9717223` Robinhood daily crypto paper book (one decision per closed UTC bar), equities Lab champion apply, 7-year equities history plus `lab-link/robinhood-equities-bars.json` (batch Q above).

Lab commits (`codex/lab-evidence-20260925`):
- `d97003c` honesty: stage PAPER only when shadow-qualified, 2.1% friction, velocity ignores maxHoldMin, search-bound blocker, syntheticSpreadPct implemented, 0.95% fee.
- `0fa2673` daily-bar Robinhood crypto research plus a new `robinhood-equities` lane.
- `6a76b8b` a passing daily proposal carries `state: PAPER`, so the trader book can use it.

Tests: trader `test:all` green, Lab `test:all` 65/69/75 green. Nothing built or installed from this work yet.

**Owner actions:**
1. Free Alpaca key in `.env` (`ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`).
2. Check the PM US balance.
3. Check in the Helius dashboard whether standard calls cost 1 or 10 credits (`INDEXER_CREDITS_PER_CALL`).
4. Decide whether the MacBook alpha.53 keeps reading the bridge; PAPER-stage Lab champions can now reach it.
5. Build and install both apps.

Kalshi and Robinhood event contracts are already covered by the MPOS core platform (Batch L), so they weren't rebuilt.

## Batch Q (2026-09-26): one Polymarket window with Positions / History / Performance tabs

- **Polymarket is now one tabbed window:** Live combos (the old host tab, relabelled), Markets, **Positions**, **History** and **Performance**. The three new tabs live in `public/js/mpo-polymarket.js` and redraw only when their data changes.
  - **Positions:** open US combos (real venue orders, unreconciled; unverified fills are shown in bold) and core paper positions on Polymarket, labelled separately and never summed.
  - **History:** settled US combos (up to 500) and core ledger entries for Polymarket.
  - **Performance:** net P/L, ROI on cost, won/lost, win rate with its **Wilson 95% interval**, average implied probability (fill price), realized minus implied, open cost; a cumulative P/L chart and a won-vs-implied chart; a calibration table by fill-price bucket. With fewer than 30 settled combos it shows a "not yet meaningful" note. An empty journal reads as unknown, never 0%.
- **Server:** new `src/core/comboPerformance.js` (pure; `comboPerformance`, `wilson`), and `GET /api/polymarket-us/combos/journal` returns `usComboJournalView({historyLimit:500})` plus `performance`.
- **Deleted `src/polymarketPaperCombos.js`:** nothing imported it, and it had no route, UI or test. It overlapped the shadow auto-combo lane. It's still in git history.
- **Tests:** 1 new test (`market-core`, 23 pass). `npm run test:all`: **747 pass, 0 fail**. Browser check on the isolated engine with a **fake** 13-combo journal seeded in the scratch data dir (deleted afterwards): all five tabs render, and the numbers match the API.
- **Not done yet (brief §6):** a Sports tab (needs the canonical SportsEvent engine, Phase 4) and a Strategy Lab tab. For now the Lab's combo proposal stays in the Live combos evidence section.

## Batch R (2026-09-26): contract-term extraction, so Arbitrage can match real Kalshi/Polymarket pairs

- **New `src/core/contractTerms.js`:** `extractTerms` turns venue text into a proposition: GAME_WINNER, SPREAD (side wins by more than a line) or TOTAL (combined score over a line). It captures participants, side, line, stat, game day, scope (regulation / including OT / period), cancellation (50-50, resolves No, fair price), resolution-source domain, and YES meaning. `matchTerms` classifies a pair as STRONG MATCH / RELATED / NOT EQUIVALENT and gives an orientation (SAME, or INVERTED when YES on one venue = NO on the other). Unresolved differences are listed as residual risks: scope, cancellation, resolution source, integer-line push. `candidatePairs` scans already-loaded contracts.
- **EXACT MATCH is human-only:** `POST /api/platform/compare/verify` needs the typed phrase "I READ BOTH RULE TEXTS AND THEY SETTLE IDENTICALLY" and only works on a STRONG MATCH. It stores a `SETTLEMENT_VERIFIED` relationship bound to a fingerprint of both contracts' rule text and the orientation. **Any venue edit voids it** (it shows "no longer valid" and drops back to STRONG). A locked return is still only computed for EXACT MATCH, with known fees and fresh depth; `riskFree` stays false.
- **Platform:** `compare` uses the structured match and swaps B's YES/NO books for INVERTED pairs. `GET /api/platform/arbitrage/candidates`. Arbitrage UI: "Scan loaded contracts" → candidates table → Compare → extracted terms side by side, residual risks, attestation status, and a Verify panel with links to both markets. Markets detail shows named outcomes (e.g. "Chiefs (YES)").
- **Provider fixes:** Polymarket two-outcome markets ("Ole Miss"/"Florida", "Over"/"Under") are now binary, with the first outcome carried as YES and `yesLabel`/`noLabel` on the contract. Before this, their books were unsupported. Markets list by 24h volume (it used to be id order, mostly stale long-dated markets). `market(id)` uses `/markets?id=`, because `/markets/{id}` omits the parent event and so dropped the participants.
- **Known limits (fail safe):** different naming (Kalshi "Kansas City" vs Polymarket "Chiefs") → not matched. "Miami" matches "Miami (OH)" by name, so a match also needs the same opponent and date. Soccer 3-way markets, player props, and non-sports markets (Fed, CPI, politics) are OTHER → RELATED at best. Fee schedules are still unavailable, so the locked return stays blocked even for EXACT pairs until fees are modeled.
- **Tests:** 5 new tests (fixtures copied from live rule text), `market-core` 28 pass; `npm run test:all` **752 pass, 0 fail**. Live check (isolated engine): 252 Kalshi (MLB game/total, NFL spread) × 1000 Polymarket → 78 candidates, 13 STRONG MATCH (NFL spreads, MLB winners/totals). The live check caught two bugs, both fixed with regression tests: the refetch dropped participants, and the name regex swallowed "Pro Football".

### Next recommended
1. ~~Venue fee schedules~~ done in batch S.
2. Team-alias table (city ↔ nickname per league) to raise match recall; keep it fail-safe.
3. Phase 3: STOCKS window through a `BrokerProvider` adapter (paper-first), then Market Lab replay.

## Batch S (2026-09-26): venue fee schedules in Arbitrage

- **New `src/core/fees.js`:** taker-fee models taken from the venues' published docs (checked 2026-09-26), priced on each direction's **actual book fills**:
  - **Kalshi:** per series `fee_type` + `fee_multiplier` (Get Series). Taker = 0.07 × multiplier × C × P(1−P). Non-direct accounts settle to the cent per order, modelled as `ceil_cent(cost+fee) − cost`, which reproduces the docs' worked example exactly. `flat` fee type → unavailable. Event-level fee overrides are **not** checked yet (the description says so).
  - **Polymarket:** per market `feesEnabled` / `feeSchedule` (rate, exponent). Fee = C × rate × p(1−p), rounded up to 5 decimals, takers only. Only exponent 1 is documented, so any other exponent → unavailable. `feesEnabled:false` → $0.
- **Providers:** Kalshi contracts look up their series once per hour (cached; sequential, so the 4-request concurrency cap never trips). That adds `feeModel`, `seriesTicker` and `resolutionSource` (the series' settlement source). A failed series lookup leaves fees unavailable with a reason instead of failing the market list. Polymarket contracts carry `feeModel` from the market.
- **Arbitrage:** `arbitrageQuote` takes `feeModels`, per-direction `feeA`/`feeB`, and after-fee spread. The locked return is still only shown for EXACT MATCH and fresh depth, and is blocked with `FEES_UNAVAILABLE` if either model is missing. The UI shows each venue's fee model and a Fees A / B column.
- **Live check (isolated engine, 10 contracts):** fees resolve for all 13 STRONG pairs. Kalshi NFL spread 10 @ $0.48 → $0.18; Kalshi MLB multiplier 0.5; that Polymarket market is `zero_fees`. **Every live pair is negative after fees** (−0.8 to −4.8 pts), the expected efficient-market result. It also surfaced a real settlement difference: Kalshi's MLB series settles from **ESPN**, Polymarket's from **mlb.com**.
- **Tests:** 3 new tests (docs examples for both venues, per-fill pricing, series caching and failure) → `market-core` 31 pass; `npm run test:all` **755 pass, 0 fail**.
- **Not changed:** core paper proposals in the Markets tabs still take a user-entered fee (bps). Switching them to the venue model is a small follow-up.

## Batch T (2026-09-26): paper fills use venue fees; team aliases dropped

- bing: "continue until we complete everything, you don't have to ask for permission." Batches now run back to back (each is still tested, committed and logged here).
- Core paper proposals (the Kalshi and Polymarket Markets tabs): the fee field is now optional. Left blank, the fill is charged the venue's published taker fee on the actual fills (`fees.js`), recorded as `feeModel {kind:'VENUE_SCHEDULE', model, rate, source}` and named in the ledger reference. A typed bps still overrides it. No schedule and no typed fee → refused with the reason.
- **Team-alias table: not built.** On live data Kalshi's NFL/MLB rule text already uses matching names ("KC Chiefs", "Atlanta"), and trailing-letter abbreviations ("Chicago C") are handled, so an alias table would add little. Revisit if NBA/NHL pairs show misses.
- Tests: +1 (`market-core` 32). `test:all` green (count below).

## Batch U (2026-09-26): Stocks window over a BrokerProvider paper broker (Phase 3)

- **New `src/core/brokers.js`:** `PaperBroker` implements the existing `BROKER_METHODS` contract (account, positions, instruments, quotes, preview, submit, orderStatus, cancel, history) and passes `validateBroker`.
  - **Order flow:** preview → `risk.propose` → `executePaper` (the governor re-checks at fill time, including quote age) → unified ledger, venue `stocks-paper`.
  - **Orders:** market or marketable-limit only; nothing rests. NYSE regular session only (`robinhoodEquitiesCalendar.marketState`). Fractional shares to 1e-6, $1 minimum. Buys fill at the ask, sells at the bid.
  - **Fees:** $0 commission, with SEC §31 and FINRA TAF on sells, reusing `robinhoodEquitiesBook.sellFees` (same source and date).
  - **Liquidity:** the displayed IEX size feeds the governor's liquidity check.
  - **Quotes:** `AlpacaQuotes` (snapshots, IEX feed) when `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` are set. No key → NOT CONFIGURED and every order is refused. AUTH ERROR / DEGRADED / DISCONNECTED are tracked.
  - **No real brokerage:** Robinhood is listed as not live (no official equities order API for this app; policy forbids real money).
- **Platform/API:** `GET /api/platform/stocks/status?symbols=`, `GET /stocks/bars?symbol=` (daily bars from the equities-lane store, otherwise "no stored bars"), `POST /stocks/fund|preview|submit|cancel`. Orders can be cancelled (`CANCELLED`) while PROPOSED or AWAITING_APPROVAL.
- **Stocks window** (`public/js/mpo-stocks.js`, desktop icon STK), in both Simple and Advanced panes: session and data-source line, account tiles, watchlist (kept in this browser) with Chart/Trade, daily-close chart, order ticket with the risk decision shown, positions with allocation bars, orders with cancel, paper funding.
- **Bug found in the browser and fixed:** the status refresh after an action cleared the action's error, so "Market is closed" never showed. Load and action errors are now separate.
- **This machine:** no Alpaca key, so quotes are unavailable and orders are refused. Correct, not a bug. Add a free Alpaca market-data key to `%APPDATA%Money Printer OS.env` to enable it.
- **Tests:** 4 new (fills and ledger, SEC/TAF, oversell, cancel; closed market, no key, one-sided quote, non-marketable limit, LIVE refused; stale quote at fill; Alpaca parsing and auth labels). `market-core` 36; `test:all` green.

### Install record (2026-09-26, 17:11 local): trader 793c736 + Lab build
- **Trader:**
  - Built from a clean worktree merge of `feature/hud-declutter` (256c36a) and `origin/main` (69b368d). Only the ledger conflicted (union merge). The merge commit is local only, not pushed.
  - `test:all` passed (27 groups).
  - Archive: `Desktop\Money Printer OS\Windows-793c736-20260926\app.asar`, sha256 `9cc6f273…`. `smoke:windows` on 18792 passed.
- **Installed:**
  - Backup: `resources\app.asar.pre-793c736-backup-20260926-171110`. A polite close was refused, so the app was force-closed.
  - Live on 8792: HEALTHY. Bing's Alpaca key works: `/api/robinhood-equities` data **FRESH** (bars through 2026-09-25); the next session is 2026-09-28.
- **Lab:** `Desktop\Money Printer OS\Lab-2ee5e46.asar` (master 2ee5e46, sha256 `6892935e…`). **Not installed**: bing double-clicks `Install Lab 2ee5e46.cmd` in the same folder (it stops the Lab, backs up, swaps and relaunches).
- **Mac:** bing runs `bash scripts/mac-install-latest.sh` once on the MacBook (it is on main). alpha.53 predates the GitHub update channel, so this first hop has to be manual.
- **Auto-update status:** the updater (GitHub Releases, signed manifest, 10 min checks) exists but has never been used. No release or tag has been published, the repo is private (API 404) and no `MONEY_PRINTER_UPDATE_TOKEN` is set.

## Batch V (2026-09-26): Market Lab, historical replay without look-ahead, experiment records (Phase 3 + part of Phase 6)

- **New `src/core/replay.js`:** `ReplaySession` reveals records strictly by `availableAt`, and the clock never goes back. `runReplay` is a sequential backtest: a decision at t fills on the first quote available **after** t (ask to buy, bid to sell, fee bps). `lookAheadViolations` must be 0 and is tested. Built-in strategies: buy-and-hold, momentum, mean reversion, with validated params.
- **Availability rules, and a hazard found:** the crypto tape's `coinbase-candles` rows are one 1-minute candle expanded into four 15 s samples (open, extremes, close), stamped from the candle **start**. Replayed at their stamps, they leak the minute's high/low/close up to 60 s early. Replay now releases them only at the candle close and flags them synthetic (no spread). **Lab follow-up:** check whether the Evolution Lab's Robinhood replay reads candle rows at their stamps. The evidence gate's `maxSyntheticShare 0.1` limits the damage but doesn't remove it.
  - Alpaca minute bars → available at bar start + 60 s.
  - Core order-book history → its stored `availableAt`.
- **Sources:** recorded crypto tape (`<data>/robinhood-tape`), recorded Kalshi/Polymarket order books (core `entity_versions`), and Alpaca minute bars for stocks (key required). The brief's "AAPL, June 10 2025, 9:30" example works once `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` are set.
- **Experiments are reproducible:** the append-only `lab_runs` table records source, instrument, window, strategy, params, a **dataset fingerprint** (hash of every revealed record), code version (package version + hash of `replay.js`), machine and seed (none; deterministic), plus the result. Same inputs give the same fingerprint and result (tested).
- **Market Lab window** (`public/js/mpo-marketlab.js`, desktop icon RPL): source/instrument/start/duration/strategy form; "Run backtest" shows return vs buy-and-hold, max drawdown, trades, synthetic share, look-ahead violations, equity and price charts, and a warning above 10% synthetic; "Start replay" plays with Play/Pause/Step at 10–1800× and reveals the chart progressively; experiment history table.
- **Engine bug caught by the new test:** fills searched only not-yet-revealed records, so a decision never filled. Fixed (binary search over revealed records per key).
- **Charts:** `MPOViz` lines take `zero:false` for price series. Before, a $0 baseline flattened every price chart (Stocks and Market Lab).
- **Isolated live check:** BTC-USD tape (1151 records, 99% candle-derived in this scratch dir), momentum run 0 look-ahead violations, replay playing. Tests: 3 new (`market-core` 39).

## Batch W (2026-09-26): Macro window: FRED indicators plus Kalshi release ladders (Phase 4)

- **New `src/core/macro.js`:** 17 indicators: CPI/core/YoY, PCE, unemployment, payrolls, claims, GDP, Fed funds upper bound, 2y/10y/curve, retail sales, industrial production, housing starts, Michigan sentiment, M2.
  - **Observation date vs publication time:** with `FRED_API_KEY`, `FredSource.vintages` reads ALFRED vintages (`realtime_start`). A value counts as available only at the **end of its publication day, US/Eastern** (FRED gives dates, not times, so this is late, never early), and `asOf()` returns what was published by a moment. A revision replaces the first print only after it was published (tested).
  - **Without a key:** the public `fredgraph.csv` gives the latest revised values, labelled "context only". As-of queries are **refused**, so revisions can't leak into backtests.
  - **Kalshi ladders:** `impliedLadder()` turns an event's "above strike" markets into a market-implied distribution and median. One-sided and non-"greater" rungs are dropped, and the result is labelled as prices, not a model. Kalshi trading closes minutes before each release, so the earliest close is the release calendar (labelled "Kalshi close").
  - **Units:** payroll strikes are in jobs, FRED in thousands (`kalshiScale`).
- **Kalshi provider:** contracts carry `strike` / `strikeType`; new `events({series,status})`. The Macro loader paces calls (150 ms) and waits once for the venue's backoff on a 429. The first version was rate-limited by Kalshi, caught in the live check.
- **API/UI:** `GET /api/platform/macro` (10-minute cache), `GET /macro/asof?id=&asOf=` (key only). **Macro window** (MAC icon): upcoming-release table, one card per indicator (last value, change, 3-year sparkline, Kalshi ladder bars and implied median), as-of explorer when keyed.
- **Live (2026-09-26, keyless):** jobs report Oct 2 (unemployment 4.07%, payrolls +95.9k implied), CPI Oct 14 (MoM 0.506%, core 0.176%, YoY 3.574%), Fed Oct 28 (upper bound 4.05%), GDP Oct 30 (3.67%). Claims and retail had no two-sided ladder open.
- Tests: 3 new (vintage as-of, ET end-of-day across DST, transforms, CSV, ladder, per-indicator failure isolation). `market-core` 42.
- **Polish noted:** with 12 desktop icons the column runs past the bottom at 720 px (System is cut off). Phase 7.

## Batch X (2026-09-26): EDGAR window, SEC filings as facts with labelled rule-based analysis (Phase 4)

- **New `src/core/edgar.js`.** SEC blocks any automated client that doesn't declare a contact; a generic User-Agent was refused live with 403 "Undeclared Automated Tool". MPOS will not send bing's email on its own, so EDGAR needs `SEC_USER_AGENT="Name you@example.com"` in `%APPDATA%\Money Printer OS\.env`. Until then it reports NOT CONFIGURED.
  - **Facts** (what the filer declared):
    - from data.sec.gov submissions JSON: form, company, CIK, ticker, accession, **acceptance time**, 8-K item numbers named from the official item list, links;
    - from the latest-filings Atom feed (`getcurrent`);
    - Form 4 XML: owner, roles, transaction code/shares/price/after.
    - Forms: 8-K, 10-Q, 10-K, 4, 13D/13G.
  - **Analysis** is a separate `RULE_BASED_ANALYSIS` object and is never merged into the facts: catalyst labels mapped from item numbers (2.02 EARNINGS, 5.02 EXECUTIVE_CHANGE, 3.02 DILUTION, 1.01 MATERIAL_AGREEMENT, …), related assets (the ticker), related markets (loaded Kalshi/Polymarket titles that mention the company or ticker). **No language model is used.** The brief's "AI-assisted summaries" aren't built, because no LLM integration exists in MPOS; adding one would need a key and a decision from bing.
  - **Fair access:** at most one SEC request every 150 ms (SEC allows 10/s); responses cached.
- **Storage/events:** filings become `Filing` entities (new entity kind; `WeatherAlert` was added too) with **availableAt = SEC acceptance time**, so backtests only see a filing once it was public. A new filing publishes `SEC_FILING_RECEIVED` once, for Wire.
- **UI:** EDGAR window (SEC icon). Load latest by form, company lookup by ticker, table (accepted, form, company, items, Form 4 transactions button, analysis column, links), with the not-configured notice.
- **Tests:** 2 new (fixtures of the documented formats: submissions JSON, Atom, Form 4 XML; analysis separation; User-Agent required and sent; stored availableAt; event published once). `market-core` 44. **Not checked against live SEC**, since no declared contact is configured.
- **Tooling note:** heredoc-fed node scripts on this machine lose backslashes in regex literals, which broke `edgar.js` once and was caught at import. Use the Edit/Write tools for code with regexes.

## Batch Y (2026-09-26): Weather desk: NWS forecast vs Kalshi daily-high markets, alerts, NHC storms (Phase 4)

- **New `src/core/weather.js`:**
  - `bucketLadder` turns Kalshi's mutually exclusive temperature buckets (between / ≤ / ≥) into a distribution: the sum of quoted mids is shown as is; median bucket and expected high come from the normalized distribution.
  - NWS point forecasts become daytime highs by date.
  - NWS Severe/Extreme alerts are stored as `WeatherAlert` entities available at their **sent** time, and publish `NEWS_RECEIVED` once.
  - NHC `CurrentStorms.json` for active tropical systems.
  - `weatherLinks` gives **SPECULATIVE_ANALYSIS** links (sector ETFs by hazard type, and loaded weather/storm market titles).
- **Finding:** Kalshi's daily-high series now settle on **The Weather Company** (series settlement source), not NWS. The desk says so: the NWS forecast is an input to compare against the market, never the settlement value.
- **10 cities** (NYC, Chicago, Miami, LA, Austin, Denver, Philadelphia, Atlanta, Seattle, Dallas), today and tomorrow. Kalshi calls are paced like Macro; each city fails on its own.
- **Bug found by the new test:** an alert missing an optional field (e.g. `urgency`) made storage throw "Non-JSON value" and dropped **every** alert in the batch. Optional fields are now null, and each alert is stored independently.
- **Live check:** all 10 cities matched, e.g. Philadelphia today NWS 63°F vs market 67–68°F (gap −4.4); LA +3.5; Denver −0.1. 80 alerts; storms Fay (TD), Gonzalo (PTC), Odalys/Polo/Nolo (HU). First load about 9 s (≈30 Kalshi calls, paced), then 10-minute cache.
- **UI:** Weather window (WX icon): forecast-vs-market table with distribution bars, tropical systems, alert list with ALL/HEAT/FLOOD/TROPICAL/WINTER/FIRE filters, speculative-exposure column.
- Tests: 3 new (buckets, NWS/NHC parsing, links labelled, snapshot joins forecast and ladder by date, per-city failures). `market-core` 47.

## Batch Z (2026-09-26): Sports: canonical SportsEvent across venues plus official live feeds (Phase 4)

- **New `src/core/sports.js`:**
  - **Sport per contract:** Kalshi series prefix (KXMLB, KXNFL, KXNCAAF, KXNBA/WNBA, KXNHL, KXATP/WTA, KXTT (table tennis), soccer leagues, UFC, esports), or the Polymarket resolution-source domain (mlb.com, nfl.com, ncaa.com, atptour.com, uefa.com, hltv.org, …).
  - **Clustering:** `buildSportsEvents` groups contracts from every venue into **one event per game**: same sport family (college leagues share "NCAA"), same game day, same participants (`sameName`, abbreviation-aware). Names take the most descriptive form ("Atlanta Braves" over "Atlanta"). Each event lists all its contracts (winner, spread, total) and the **winner price per venue**; a Polymarket named-outcome market's other side is shown as its complement (marked *).
  - **Live state only from official public feeds:** MLB Stats API and NHL web API (`mlbLive` / `nhlLive` / `attachLive`, with orientation when home/away order differs). Other sports show prices only; nothing about the score is inferred from prices.
- **Platform:** `sportsSnapshot()` loads 13 Kalshi sports series plus the top 500 Polymarket markets (paced), builds the events, stores each as a `SportsEvent` entity (**fact=false**, MPOS-derived) with `PRICES` relationships from its contracts (heuristic, labelled), and publishes `SPORT_EVENT_UPDATED` only when live state changes. 60-second cache. `GET /api/platform/sports`.
- **Live:** 1285 contracts → 417 events (ATP, WTA, table tennis, MLB, NFL, NCAAF, soccer, esports, UFC, WNBA, NBA); 13 on both venues; MLB 13 games and NHL 14 connected. E.g. Dodgers–Giants in progress 3–1, top 5, with Kalshi and Polymarket prices side by side. The first load in the running app took about 50 s because other windows had just triggered Kalshi's 429 backoff; warm reloads take about 6 s.
- **UI:** Sports window (SPT icon): sport filters, both-venues / live / fast-settling toggles, event table (live score/period, winner prices K/P, venue gap, contract count). Tennis and table tennis are flagged FAST (the brief's fast-settlement focus).
- Tests: 3 new (sport mapping, cross-venue clustering and complements, MLB/NHL parsing and attach, snapshot storage/relationships, live change announced once). `market-core` 50.
- **Next in Phase 4:** Wire (the event feed consuming SEC/weather/sports/macro/market events); Whale Watch on top of the existing wallet intelligence.

## Batch AA (2026-09-26): Wire, the global event terminal (Phase 4)

- **New `src/core/wire.js`**, plus `wireSnapshot()` in the platform. One feed over:
  - official RSS: **Federal Reserve** press releases, **BEA** releases, **CFTC** press releases (BLS returns 403 to automated clients and is left out; SEC press needs SEC_USER_AGENT);
  - stored SEC `Filing`s, NWS `WeatherAlert`s, live `SportsEvent` changes;
  - the Kalshi macro calendar (upcoming releases within 7 days);
  - core events: risk state changes, paper fills, pair attestations, strategy promotions/demotions, cancels.
  - RSS items are stored as `NewsEvent` entities available at **min(published, received)** and publish `NEWS_RECEIVED` once.
- **Rule-based analysis per item** (labelled `RULE_BASED`):
  - **entities:** crypto (BTC/ETH/SOL/crypto), macro indicators from keywords (FOMC → Fed funds, GDP, CPI, payrolls…), tickers (from filings, `$TSLA` / `(TSLA)`), team names from loaded sports events;
  - **related markets:** macro → that indicator's Kalshi series; crypto, teams and tickers → contract titles;
  - **my positions:** related contract held in the core ledger, or a crypto/stock symbol held in core stocks or the Robinhood practice book;
  - **importance 0–100:** e.g. FOMC 90, GDP/PCE/CPI 75, earnings/M&A 8-K 70, Extreme weather 70, fast-settling sports +10, held exposure +25, related markets +10.
- **Filters:** ALL / MARKETS / CRYPTO / MACRO / CORPORATE / SPORTS / WEATHER / MY POSITIONS (with counts), search, newest or importance sort.
- **Bug found by the new test:** held-position matching never matched, because instrument IDs URL-encode the `:YES` suffix. The ID is now decoded and rebuilt through `stableId`.
- **Live:** fed 20, BEA 48, CFTC 10 items; 173 total with weather/sports/macro calendar. Top items: FOMC statement/minutes (100, linked to 8 Fed-rate ladders) and GDP estimates (85).
- **UI:** Wire window (WIR icon; next to Command Center on the desktop).
- Tests: 2 new (RSS variants incl. CDATA/attributes, entities, related markets, importance, categories; snapshot stores NewsEvents at publish time, 5-min feed cache, my-positions flag via a real paper fill). `market-core` 52.

## Batch AB (2026-09-26): Whale Watch (Solana wallet intelligence, Phase 4)

- **New `src/core/whales.js`**, built on data the engine already records. It adds no new collection: research `universe` (tokens), `walletProfiles` (on-curve top holders per mint), `deployerProfiles` (**mint authority** → mints, labelled as mint authority because it is not always the deployer), alphaDb `tx_events` (signer swaps from the capped Helius indexer), and the wallet PnL scorecard.
  - `tokenGraph(mint)`: token → mint authority → its other tokens; token → top holders → holders that also hold sibling tokens (overlap); first N buyers; buyers who were also early in sibling tokens; large swaps. Also returns a node/edge list for the graph.
  - **Rule-based flags:** SERIAL_MINT_AUTHORITY (≥5 tokens), MINT_AUTHORITY_PRESENT, HOLDER_OVERLAP, REPEAT_EARLY_BUYERS. Each says explicitly that it isn't proof of coordination or identity. Exchange inflows/outflows are **UNAVAILABLE** (MPOS has no exchange wallet attribution).
  - `whaleFlow` lists large swaps; new ones publish `WALLET_ACTIVITY`. `walletView` shows everything observed about one address.
- **Wallet labels** are user notes: `wallet_labels` holds the current value, and `wallet_label_events` is an append-only history.
- **Readers** come from the dashboard (research state, tx_events query, scorecard). Reader failures show in the window instead of turning into empty data. The first draft had a missing `alphaDb` import that would have looked like "no swaps"; that is now visible and tested.
- **UI:** **Whale Watch is a tab of the Pump.fun window** (it extends the Solana terminal rather than being a separate app). It has: availability line, token/wallet lookup, radial relationship graph (SVG), flags, authority/siblings, early buyers, large swaps, whale-flow table with a min-SOL setting, top mint authorities, recurring holders, recently scanned tokens, and a wallet pane with a label form.
- **Live (isolated):** research loaded, 60 recently scanned tokens; no holder, authority or swap data here (no Helius key). The installed app has holder RPC running and will show more.
- Tests: 2 new (graph, overlap, repeat-early, flags; flow; wallet view; label history; reader failure reported). `market-core` 54.
- **Phase 4 complete** (FRED/Macro, EDGAR, Wire, Sports, Weather, Whale Watch). Next: Phase 5 event correlation / Command Center event pages.

## Batch AC (2026-09-26): Phase 5, event correlation and Command Center event pages

- **New `src/core/correlation.js`:** `buildEventPages()` makes **one page per upcoming event** (Fed decision, CPI/core/YoY, jobs report, unemployment, GDP, claims, retail) from what the desks already load. Each page has:
  - **Macro:** the template's FRED values (e.g. Fed page: Fed funds, 2y, 10y, curve, CPI YoY).
  - **Kalshi:** the event's ladder and implied median (link = **same Kalshi event**, a fact).
  - **Polymarket:** markets matching the topic **and** ending within 5 days of the Kalshi close (rule-based; a December Fed market doesn't attach to October).
  - **Markets:** SPY/QQQ/TLT (Alpaca, or "unavailable"), BTC/SOL from the tape with source label.
  - **MPOS exposure:** core-ledger positions in linked contracts, with cost basis.
  - **Signals:** Wire items tagged with the event's macro entities.
  - **Provenance:** every page says which links are facts and which are rule-based.
- **Polymarket provider:** new `search(q)` via gamma `public-search`; each market carries its parent event. Top-by-volume listing alone found no macro markets because it is mostly sports.
- **Platform:** `eventPages()` (5-min cache) runs macro, Polymarket topic searches, Wire, held positions and asset prices. It stores an `Event` entity (fact=false) and `MARKET_FOR_EVENT` relationships (fact=true for the same Kalshi event, false for keyword matches). `GET /api/platform/events`.
- **Command Center:** new **Events** section (loaded in the background every 5 minutes, Refresh forces it). Cards show when, Kalshi median, number of Polymarket links, exposure and signals; clicking one expands macro values, ladder bars, Polymarket table, assets, exposure and signal links.
- **Bug fixed:** expanding a card went through the busy-guarded action wrapper, so clicks during a refresh were dropped. Now local UI state.
- **Live:** 7 event pages. **FED DECISION — OCTOBER** (Kalshi closes Oct 28): Kalshi 65% above 4.00% (implied median 4.058%) and Polymarket "increase 25 bps" 64.5%, so the venues agree. Also shown: 2y 4.87%, 10y 5.18%, BTC 84,144 / SOL 121 (tape), 6 Fed Wire items. CPI pages link 12 Polymarket September-CPI markets each. First load ≈60 s (macro ladders plus searches), cached after.
- Tests: 1 new (page assembly, window filter, exposure, signals, provenance, past events dropped). `market-core` 55.
- **Not yet:** event pages for sports, weather and corporate events. Those live in the Sports/Weather/EDGAR windows and the Wire, but have no Command Center pages yet.

## Batch AD (2026-09-26): Phase 6, walk-forward validation, seeded Monte Carlo, evidence into the promotion gate

- **`src/core/replay.js`:**
  - **`walkForward`:** the window is cut into K consecutive folds. For each fold after the first, every parameter set in the grid (≤64) runs on the **previous fold only**, the best by return is chosen, and only that set runs on the current fold. Test data never influences the choice. A test proves it: two datasets that differ only in the last fold pick identical parameters for it.
  - **Evidence** comes out in exactly the shape the promotion gate reads: test trades, compounded out-of-sample net %, costs modeled (fee > 0), worst fold drawdown, share of positive folds, plus look-ahead violations and synthetic share.
  - **`monteCarlo`:** seeded (mulberry32) bootstrap of per-trade returns → p5/p50/p95 and P(loss); the seed is stored. The replay engine now records `ret` per closed trade.
- **Strategy registry:** `attachEvidence(id, evidence, reason)` replaces a strategy's evidence and appends a same-state history row. It **never promotes**; promotion is still a separate transition through the gate. Retired strategies are refused.
- **Platform:** `labWalkForward()` stores the run in `lab_runs` (strategy `walkforward:<id>`, grid/folds/fee, dataset fingerprint, code version, machine, **seed**), optionally attaches the evidence to a registry strategy, and returns the gate preview for PAPER and CANDIDATE. `POST /api/platform/lab/walkforward`.
- **Market Lab UI:** a Walk-forward panel (folds, lookback and threshold lists, seed, "attach evidence to" a registry strategy) with evidence tiles, Monte Carlo, a per-fold table (chosen params, train/test return, test buy & hold, trades, DD), and a gate preview naming the blockers.
- **Live (isolated tape, 1301 BTC records ≈5.5 h):** momentum 4 folds, 0 look-ahead violations, 6 test trades, −0.41% on the last fold. Gate: SAMPLE_SIZE, OUT_OF_SAMPLE_NOT_PROFITABLE_AFTER_COSTS, UNSTABLE_ACROSS_FOLDS, as expected for 5 hours of data.
- Tests: 2 new (fold isolation, grid limits, seeded MC reproducibility, evidence attached without promotion, experiment row with seed). `market-core` 57.
- **Phase 6 status:** common strategy metadata/lifecycle (N), Lab champions (P), reproducible experiments (V), walk-forward/MC evidence (AD). **Not done:** a GPU/Windows distributed sweep worker for Market Lab. The existing Evolution Lab/Furnace does the heavy search; Market Lab stays in-process with capped grids so the desktop stays responsive.

## Batch AE (2026-09-26): Phase 7 polish: desktop icons, strategy actions, system diagnostics

- **Desktop icons** wrap into further columns (CSS grid, column flow) instead of running under the taskbar. With 16 apps it's 2 columns at 720 px.
- **Command Center → Strategies:** each row shows its stored evidence (n, out-of-sample net, positive-fold share, DD, costs) and a **Move to** form (state + reason). The server enforces allowed edges and the promotion gate, and LIVE is unavailable. Checked in the browser: BACKTESTING → PAPER without evidence was refused with all five blockers.
- **System diagnostics** (`GET /api/platform/diagnostics`, shown in Command Center, opened automatically when something needs attention):
  - every source (Kalshi, Polymarket, Alpaca, FRED, NWS, SEC, MLB/NHL live, 3 RSS feeds) with state, last success, last error, latency;
  - event bus published/delivered/dropped/queue/listener errors;
  - database size and row counts;
  - cache ages and open replays;
  - engine process RSS/heap/uptime/CPU count. Load average is **"unavailable (not provided on Windows)"** and GPU is **"unavailable (not measured by MPOS core)"**, per the no-fake-metrics rule.
- **Source states:** every source reports **IDLE** until first contact instead of a misleading DISCONNECTED.
- Tests unchanged in count (57 core); `test:all` green.

## Batch AF (2026-09-26): integration milestones in the Journal; architecture doc

- The first time each source connects in a data folder, the core writes a project-journal milestone ("Integration connected: fred", …) once (`integration_milestones` table). Risk halts, strategy moves and paper funding already journal.
- `docs/MPOS-UNIFICATION.md` now has the as-built architecture map (core / providers / engines / apps), the facts-vs-analysis, availability-time, unknown-stays-unknown and no-real-money rules, the optional keys and what they unlock, and the remaining work.

## Unification brief: where it stands (after batches M–AF)

- **Phases 0–1:** done (Codex's core, plus risk-state and sell-trap fixes, strategy registry, legacy coverage, Lab sync).
- **Phase 2:** Kalshi, Polymarket suite and Arbitrage with structured terms, human-attested EXACT and venue fees.
- **Phase 3:** Stocks (BrokerProvider paper broker) and Market Lab replay.
- **Phase 4:** Macro, EDGAR, Wire, Sports, Weather, Whale Watch.
- **Phase 5:** event pages.
- **Phase 6:** walk-forward, Monte Carlo, evidence to the gate.
- **Phase 7:** icons, diagnostics, strategy actions, docs.
- **Needs bing** (optional keys): Alpaca, FRED, SEC_USER_AGENT; and the Evolution Lab candle look-ahead fix (side task offered). Real-money execution stays off by policy.

## Batch AG (2026-09-26): legacy books mirrored into the unified ledger and reconciled

- bing: "do all of it" (the remaining list). **Real-money order code is still not written:** there are no working venue credentials to certify against (Kalshi has no keys, Polymarket US returns keyNotFound), and real-money actions need bing's explicit go-ahead at the time they're used. The read-only reconciliation that live trading would depend on now exists for the paper books; venue account reconciliation needs the credentials.
- **New `src/core/legacyImport.js` + `syncLegacyLedger()`** (runs on start and every minute; `POST /api/platform/legacy/sync`):
  - **Solana paper book → ledger venue `solana-paper`, currency SOL.** The cash identity was verified on real data: `cashSol = start + Σ closed pnlSol − Σ open remainingSol + Σ open realizedSol`. Each trade is mirrored in units of entry SOL: BUY size; SELL for sold units at gross proceeds (sold + realized + fees); FEE entries for fees. Partial exits and later closes post **deltas** against what the ledger already holds, so syncs are idempotent.
  - **Robinhood practice book → `robinhood-practice`, USD:** deposit = budget; BUY cost at open; SELL proceeds at close.
  - **Reconciliation after each sync:** ledger cash vs the book's own cash → RECONCILED / DIFFERENCE / FAILED, with the difference and reason. **Nothing is booked to hide a difference.**
  - **Book reset:** an empty book at its start balance starts a new mirror account (`legacy-2`); the old one is kept.
  - **Polymarket US combos:** NOT_MIRRORED (real orders, no readable balance), with the reason shown.
- **Effect:** the mirrored accounts are now inside the Risk Governor's view (USD accounts count toward totals/drawdown), as the brief asks ("sees all exposure").
- **UI:** Command Center ledger accounts show currency (SOL is no longer printed as dollars) and mark mirrored legacy accounts. The Legacy books section adds a Ledger mirror table (status, book vs ledger cash, difference, last sync, notes) and "Sync legacy books now".
- **Live (isolated data):** Solana 111 entries, RECONCILED (ledger 0.641811 vs book 0.641820 SOL, a −0.000009 rounding difference across 111 entries); 6 open positions match; second sync appends 0. Robinhood practice RECONCILED at $500.
- Tests: 2 new (partial exit → close by deltas, reset → new epoch, unreconcilable book reported and never adjusted, unreadable book, practice plan). `market-core` 59.

## Batch AH (2026-09-26): event pages for sports, weather and corporate events

- `correlation.js` has three new page builders that share one generic shape (headline metrics + detail sections + exposure + provenance):
  - **sportsPages:** live and cross-venue games first. Winner prices per venue, live state, venue gap, every contract on the game, Wire items for the teams, held exposure.
  - **weatherPages:** hurricanes and tropical systems (NHC), plus Extreme NWS alerts. Wind, pressure, position, speculative sector/market exposure, NHC advisory link.
  - **corporatePages:** filings with material catalysts (earnings, M&A, change of control, bankruptcy, restatement, dilution, executive change, material agreement). Item facts, filing link, price when Alpaca is keyed, rule-based related markets, ticker Wire items.
- `eventPages()` adds them from the Sports/Weather/EDGAR desks and reports counts per kind. Command Center Events has an ALL/MACRO/SPORTS/WEATHER/CORPORATE filter with counts and colour-coded cards; generic cards expand into sections.
- **Bug found in the live check:** `sameName` failed when both names had the same word count ("Los Angeles A" vs "Los Angeles Angels"), so the Angels' Kalshi price was dropped from the event. The abbreviated name is now always the short side (regression test added).
- **Live:** 19 pages (7 macro, 8 sports, 4 weather: Gonzalo, Odalys, Polo, Nolo; corporate 0 until SEC_USER_AGENT is set). First load ≈60–90 s (all desks); cached 5 minutes.
- Tests: 1 new (+ sameName regression). `market-core` 60.

## Batch AI (2026-09-26): Kalshi event-level fee overrides

- **Finding:** Kalshi schedules event fee overrides (`GET /events/fee_changes`), e.g. **MLB game events move from multiplier 0.5 to 1 at first pitch**. The public list holds only **pending** changes (242 live, all future); a change vanishes once it takes effect.
- **Provider:** `refreshFeeChanges()` (10-min cache, ≤5 pages) keeps every change it has seen. `feeOverride(event, series, now)` returns:
  - **PENDING:** series fee now, next change shown;
  - **APPLIED:** a change we saw whose time has passed; it is the fee even after it leaves the list;
  - **UNVERIFIED:** the series uses overrides but this event has none pending (probably already started), so the **higher multiplier seen for the series** is used and costs are never understated;
  - **NONE.**
  - Markets and single-market lookups attach it to the fee model. `describeFeeModel` says which case applies, e.g. "changes to × 1 at 2026-09-27T19:05Z".
- **Live:** KXMLBGAME: 44 markets PENDING (× 0.5 until first pitch), 4 in-progress games UNVERIFIED at × 1.
- Tests: 1 new (the four states, including a change dropping off the list). `market-core` 61.

## Batch AJ (2026-09-26): Market Lab compute in worker threads

- **New `src/core/labWorker.js`:** `LabPool` (worker_threads; at most half the CPUs, capped at 4; jobs queue when all are busy) and `computeTask` (the same pure replay/walk-forward functions). The app's platform instance runs Market Lab backtests and walk-forward sweeps in the pool, so the HTTP server and desktop stay responsive. Tests and scripts run inline. Diagnostics show pool size, busy/queued/done/failed.
- **Test:** pool results equal inline results, and the main event loop keeps ticking during a 6000-record × 16-parameter walk-forward. **Live:** walk-forward via the app pool returned in 58 ms while 92 diagnostics requests were served concurrently.
- **Cross-machine distribution: not built, on purpose.** The existing mesh (`src/networkMesh.js`) is presence/chat over unauthenticated LAN UDP, and accepting compute jobs over it would let any LAN host run work on this machine. Heavy cross-machine search already goes through the Evolution Lab and its HMAC-signed bridge. If bing wants Market Lab jobs on the Windows box specifically, the safe route is a signed job endpoint on that bridge.
- `market-core` 62.

## Batch AK (2026-09-26): AI-assisted SEC filing summaries, cited and labelled

- **New dependency `@anthropic-ai/sdk`** (official SDK; the Claude API guidance says to use it rather than raw HTTP). **New `src/core/aiSummary.js`:**
  - SEC filing HTML → text → `claude-opus-5` (effort medium) with the **server-side refusal fallback** (`fallbacks: "default"`).
  - The filing is attached as a **document with citations enabled**, so every summary sentence carries the exact filing passages it came from (`cited_text` + character range). `citedShare` reports how many claim sentences are backed.
  - Fixed sections: what happened / numbers / people and deals / risks. "State only what the filing says", no predictions or advice.
  - Refusals come back as REFUSED with category. Filings over 1.5M characters are **refused, never cut short**; SDK errors map to typed codes (auth, rate limit, API).
- **Platform:**
  - `edgarSummary({accession, force})` runs **on request only** (it costs API usage) and stores results in `ai_summaries`, **separate from the Filing facts**, which are never modified. A second request returns the stored copy (not billed again).
  - Without `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` it reports NOT CONFIGURED.
  - `POST /api/platform/edgar/summary`; the diagnostics list the "anthropic" source.
- **EDGAR window:** an "AI summary" button per filing opens a panel labelled **AI-GENERATED ANALYSIS** with the model name, stored flag and cited share. Hovering a sentence shows its filing quote; uncited sentences are dimmed; a footer says it is not the filing and not advice.
- **Not exercised against the live API** (no Anthropic key and no SEC contact on this machine). Tests use a fake client and check the exact request shape (model, fallback beta, document citations, full text), the refusal path, the no-truncation rule, caching and facts isolation.
- `market-core` 63.

## Batch AL (2026-09-26): Evolution Lab candle look-ahead fixed (Lab commit 386bb13)

- **Lab repo** (`W:\money-printer-evolution-lab`), branch `codex/lab-evidence-20260925`, fast-forwarded to `386bb13`. Made in a separate worktree so the other session's `W:/lab-claude` (`claude/lab-loop-20260926`) was untouched; that branch will need this commit when it merges.
- `moduleResearch.loadQuoteTape` → `withoutCandleLookAhead()`: for `coinbase-candles` rows only each minute's **close** survives, stamped at the **minute end**. The synthetic open/extremes are dropped: releasing them late would still let a simulated stop fill at a price that had already passed. Live quote rows are unchanged and win timestamp ties.
- `robinhoodHistory.js` minute samples use the same expansion, but that path is documented as **not wired**. If it is ever wired, it needs the same rule. Daily bars are complete UTC days and unaffected.
- **Effect:** Robinhood lane search/holdout results computed on candle-heavy tape before this fix may have been optimistic. The evidence gate's 10% synthetic cap limited it for promotion.
- Tests: new `tests/candle-lookahead.test.mjs` (2); **all 231 Lab tests pass** (per-file run).
