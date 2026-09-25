# Money Printer OS: status ledger

**Read this first.** It is the entry point for each new session. Deeper history lives in `.agent-state/`
(`CURRENT_TASKS.md`, `KNOWN_BUGS.md`, `PROJECT_STATE.md`, `RELEASE_STATUS.md`) and in `reports/NEXT-STEPS-2026-09-25.md`.
Don't re-inventory the repo. Update this file at the end of every batch.

Last updated: 2026-09-25, batch 3. Branch `feature/robinhood-auto-trader`, version `0.5.0-alpha.56`.

## Architecture (inventoried once)

- **Desktop shell:** `desktop/main.cjs` (Electron). It supervises child processes (engine `src/index.js`, `src/networkMesh.js`, and optionally `src/researchCollector.js`) and restarts them with backoff. Research services policy: `desktop/research-supervision.cjs` (`MPO_RESEARCH_COLLECTOR`, default on).
- **Engine / HUD:** `src/index.js` (Solana meme paper engine; has a realpath main-guard at `:702`, exports only `main`), `src/dashboard.js` (HTTP API + `public/dashboard.html`).
- **Books:** `src/store.js` holds paper state and its accounting invariants. Atomic writes go through `src/atomicRename.js`.
- **Polymarket:** `src/polymarket.js` (global, paper), `src/polymarketUS.js` and `src/polymarketUSCombos.js` (US and RFQ; auth currently fails with `keyNotFound`).
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

## Next recommended batch (priority order)

1. **bing:** run the two merge commands (batch 2), then say whether to push. Schedule `npm run collector -- --data "%APPDATA%\Money Printer OS\data"` at logon, and disable `MoneyPrinterReplayWorkhorse`.
2. Re-run the Lab's three Polymarket sandbox searches with the committed fee model (report section 2.3: `node scripts/polymarket-research.mjs --mode search ...` in the Lab repo, read-only against `W:/mpo-polymarket-research`). Record the verdict here.
3. Refresh or retire the stale admin scripts (report section 2.8). They live outside this repo, so ask bing where first.
4. Design work (not compute): a second Polymarket strategy family. Options are fee-free NFL-only markets or maker/limit posting with a queue model (report section 2.5).
5. Optional: an end-to-end `enter()` test harness, which needs dependency injection for config, store and network.
