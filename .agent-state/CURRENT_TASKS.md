# Current recovery source - September 28, 2026

Money Printer OS 0.5.0-alpha.72 / Evolution Lab 0.1.0-alpha.14 supersedes the historical source records below. See reports/ZERO-CREDIT-RECOVERY-2026-09-28.md for recovered work and test evidence. Runtime acceptance is recorded by the paired installer in PAIRED-RELEASE.json at both installation roots, with exact commits and archive hashes. Do not infer installed status from package versions alone. Both archive engines must pass smoke tests; paid model execution and real-money execution must remain disabled.

---

# Current tasks — 2026-09-27 alpha.67 / Lab alpha.11

The final Windows release pair for this repair is alpha.67 / Lab alpha.11. Internal completion means
both full source suites pass, both packaged builds identify their exact clean commits, the paired
updater or equivalent verified install proves those exact builds are running, PAPER/live locks stay
intact, and the post-install soak records no invariant failures. The five Lab research adapters stay
active; `polymarket-combo` and other lanes may legitimately remain `NO_EDGE`/blocked when the
after-cost evidence does not justify paper promotion.

Remaining external/time boundaries are unchanged: publish/sign a real GitHub updater release (and
configure a read-only update token if the repo remains private), verify/install the canonical
release on the Mac when it is online, accumulate a literal 24-hour observation window, and collect
authentic executable-price/tape evidence rather than weakening qualification gates. Small custom
paper-bankroll resets and the requested desktop/logo polish are part of this release, not follow-up
tasks.

## Profit Lab queue — 2026-09-27

Highest-leverage unfinished profitability task: Research Pro monetization v1. Revenue/funnel instrumentation already exists; do not duplicate it. Implement only on the isolated Profit Lab branch and keep monetization disabled by default. Gate read-only research detail, never trading/risk/execution. Exact scope: `docs/PROFIT-LAB-MONETIZATION-2026-09-27.md`. Acceptance requires the focused monetization suite plus the full `npm run test:all` before merge.

Implementation and verification of the September 26 upgrade remain recorded in
`reports/UPGRADE-IMPLEMENTATION-2026-09-26.md`; current operator documentation is
`docs/UPGRADE-OPERATIONS.md`. The alpha.67/alpha.11 paired Windows release supersedes the old prepared
alpha.61/alpha.7 review archives and the intermediate alpha.64/alpha.8 repair. No module is newly claimed profitable. No speculative chain
connector or unbenchmarked GPU path was activated. Physical multi-monitor transitions, Mac
installation, signed updater publication and the full 24-hour observation remain unverified.
Earlier tasks below are historical context; they do not override the current entry above.

# Historical tasks — 2026-09-20 (alpha.53, integrated + packaged)

- 2026-09-25 (Robinhood Auto Trader, `feature/robinhood-auto-trader`): package F leftovers closed (HUD contract test, visual-contract backend assertions, doctor/health-check readiness, release-gate exposure test, spec section 9 loss-cap wording) and the paper-only **Robinhood Evolution** loop landed (`src/robinhoodTape.js`, `src/robinhoodBacktest.js`, `src/robinhoodEvolve.js`, routes `GET /api/robinhood/evolve`, `POST .../evolve/run`, `POST .../evolve/apply`, HUD EVOLUTION fieldset, spec section 22, `.env.example` `ROBINHOOD_EVOLVE_*`). Champions are proposed only; APPLY changes paper params (qualification resets, real autopilot disables with `paramsChanged`); real autopilot is never a promotion target. **Still bing:** connect read-only keys, let the tape accumulate >= 3 days on BTC-USD before the first generation, review proposals before APPLY; do not set `ROBINHOOD_EVOLVE_AUTOPROMOTE=true` or `ROBINHOOD_REAL_ENABLED=true` without reading section 16. Uncommitted on the branch at the time of writing.
- 2026-09-24: unified build script `scripts/build-unified.mjs` landed; mac arm64 + Windows x64 packages built from 3ba4959 (see RELEASE_STATUS.md). Still pending bing: Authenticode signing, Windows boot test, updater manifest signing, install.
- 2026-09-24 (GitHub setup / release channel): the updater now reads this repository's GitHub Releases instead of the never-hosted `bangbowbing.net/downloads/...` directory — `desktop/update-channel.cjs` (one resolver for `desktop/main.cjs` and the HUD's `/api/update`, `MONEY_PRINTER_UPDATE_URL` override), `desktop/update-fetch.cjs` (redirect-aware, Releases API, `MONEY_PRINTER_UPDATE_TOKEN` while the repo is private, token never forwarded off api.github.com), `scripts/sign-manifest.mjs` (`stage` / `sign` / `verify`), `.github/workflows/ci.yml` (Node 22 + 24: test:all, selftest, doctor --offline) and `.github/workflows/release.yml` (macOS arm64 runner → `build-unified.mjs` → **draft** release with `manifest.unsigned.json`; never signs, never publishes). `package-lock.json` repaired (nested `utf-8-validate@5.0.10` was missing and the lock was still stamped alpha.52, so `npm ci` refused). `npm run test:updater` added to `test:all`. Docs: `docs/RELEASE-CHANNEL.md`, `docs/UPDATER-MANIFEST.md`. **Still bing:** sign + publish each release, put the read-only token in the installed app's `.env`, and the earlier items above.

Folded forward from the 2026-09-16 (alpha.42-era) table below and the undotted
`agent-state/CURRENT_TASKS.md` snapshot (2026-09-19), which is now deleted — this file is the
single, current record. Restamped by the integrator after all five alpha53 work packages
(`ship-fixes`, `accounting`, `product`, `visual`, `packaging`) landed on `main`.

Integrated-HEAD verification (logs under `.workflow/scratch/integration/`): `npm run test:all`
**302/302, 0 fail**; `npm run test:visual` **26/26**; `node --test tests/release-gate.test.cjs`
**6/6**; `node src/selftest.js` **SELFTEST PASS**; `node src/doctor.js --offline` **exit 0**
(`PAPER IDENTITY ... holeExact 0 okExact true`). Zero merge conflicts — the plan's exclusive
file ownership held.

| Task | Status |
| --- | --- |
| Replay-lab main-module path (spaces in the checkout path) | **Done** — `tests/replay-lab.test.mjs:28` uses `fileURLToPath`; 24/24 at `cb71d4c`. |
| Paper bankroll identity helpers + tests (ledger M3) | **Done** — base `paperIdentity`/guards at `cb71d4c`; F1/F2/F3/F4/F6/F7/F8 from `ACCOUNTING-AUDIT.md` landed at `52a6e74` and merged. Re-proved at integrated HEAD: every read-only snapshot loads through `loadState()` with `holeExact=0.000000000`, `okExact=true` (`.workflow/scratch/integration/recon-loadstate.log`). New suites: `tests/accounting-integrity.test.mjs`, `tests/store-recovery.test.mjs`. |
| Impossible SOL jump guard (ledger M4) | **Done** — `guardEquityJump` + merge alerts at `cb71d4c`; the actual close is the save-time `REALIZED_WITHOUT_BASIS` / `REALIZED_EXCEEDS_MARK` invariant plus the F7 tick band and F8 sizing ceiling, landed at `52a6e74`. Replaying the real 2026-09-10 PEG rewrite at integrated HEAD is **REFUSED** and `state.json` stays byte-identical (`.workflow/scratch/integration/guards-proof.log`); `guardEquityJump` alone would have allowed it. Root-cause doc: `.agent-state/DATA_DECISION_MEMO.md`, `.workflow/scratch/sol-jump-rootcause.md`. |
| `test:visual` wired into `npm run test:all` | **Done** (this package) — `tests/renderer-alpha52.test.mjs`, `tests/visual-assets.test.mjs`, `tests/visual-contract.test.mjs` (25/25) now run in `test:all` via `package.json`'s `test:visual` script. |
| `doctor` reports paper identity + honours `MONEY_PRINTER_DATA_DIR` + `--offline` | **Done** (this package) — `src/doctor.js` prints a `PAPER IDENTITY` line and resolves state/journal paths the same way `src/store.js` does; `--offline` / `DOCTOR_OFFLINE=1` skips the RPC benchmark. |
| Doc contradictions (stale `PROJECT_STATE.md`/`CURRENT_TASKS.md`, missing README) | **Done** (this package) — both `.agent-state` files restamped to alpha.53, undotted twins folded in and deleted; new root `README.md` added; `EXECUTION_UPDATE.md` marked historical; `docs/EVOLUTION_LAB_SPLIT.md` gained a macOS verification line. |
| Visual OS-wide pass to Polymarket Suite standard (ledger M5) | **Done** — landed at `11d676a` and merged. Additive tokens + `.mpo-module`/`.mpo-meter`/`.mpo-brand-title`/`.mpo-danger-fieldset` in `public/css/mpo-workstation.css`; System Monitor, Research Monitor, Control Bay, Risk, Wallet, Money, Updater migrated in `public/dashboard.html`. `test:visual` 26/26. **Honest gap:** no screenshot *files* exist — the headless browser pane has no save-to-disk action; DOM dumps (`.workflow/scratch/visual/dom-dumps.json`) are the durable evidence. |
| `icon.icns` / dock packaging asset | **Done** — `build/icon.icns` landed at `cb71d4c` (2,110,888 bytes, 10 representations up to 1024x1024, two >= 512x512); the visual package verified the representations and the packaging manifest shows exactly one `build/icon.icns` inside the `.asar` (contract C5 closed). |
| Packaged alpha.53 asar + `RELEASE_STATUS.md` SHA-256 (ledger M7) | **Done (packaged, NOT installed)** — repacked by the integrator from the fully-merged `main`; artifact path, byte size, SHA-256, gate refusal and rollback path in `.agent-state/RELEASE_STATUS.md`. **bing does the install/restart click**; `install`/`restart` hard-refuse under an agent. |
| Windows signed build / `promote tested` | **Blocked, documented, not faked** — no Windows build, signing or CI exists in this repo (`docs/WINDOWS-RELEASE.md`). `promote tested` refuses with the real missing list; the release stays at stage `main`. **Needs bing + a Windows machine.** |
| Updater manifest signing | **Tooling landed, still not signed** — `node scripts/sign-manifest.mjs sign --asar app.asar --key <path>` then `verify`, on the key-holding machine (`docs/UPDATER-MANIFEST.md`, `docs/RELEASE-CHANNEL.md`); the release workflow only stages `manifest.unsigned.json`. No agent read or looked for key material; `sign` refuses under an agent session. **Needs bing.** |
| Release channel / GitHub setup | **Done** (2026-09-24) — GitHub Releases is the update channel, CI + release workflows exist, see the dated line above. Pending bing: first tagged release, sign + publish, `MONEY_PRINTER_UPDATE_TOKEN` in the installed app's `.env` while the repo is private. |
| Polymarket US key regeneration | Pending bing; still `keyNotFound` historically. |
| Windows Evolution Lab link | Verified on Windows already (see `docs/EVOLUTION_LAB_SPLIT.md`); pending bing for any further cross-machine testing. |
| Real-money execution / risk loosening | **Forbidden.** `liveExecution:'manual'`, `automaticLivePromotionAllowed:false`, `liveActivationAllowed:false` stay as-is. |

## Superseded (alpha.42-era, kept for history)

| Task | Status |
| --- | --- |
| Data-first evidence audit (`20260916-103902-e69ba`) | Complete; `.agent-state/DATA_DECISION_MEMO.md`. No deploy/orders. |
| Polymarket settlement-bias (`20260916-103902-02a6c`) | Reviewed at `ee8077a` / `125126e`; re-verified green on this alpha.53 tree via `tests/polymarket-settlement.test.mjs`. |
| Isolated latency instrumentation | Integrated at `125126e` (`src/latencyStats.js` + `alphaDb` wait_ms). |
| Meme alpha + latency (`20260916-103902-e8029` / `1d954bc`) | Not wholesale-merged; see `INTEGRATION_LEDGER.md`. |
| Prove positive forward returns after costs | **Unproven.** Edge INCONCLUSIVE; do not tune criteria to force it true (`productionLearningUnlocked` stays `false`). |
| BEAST furnace final benchmark (`20260916-180029-34473`) | Complete; superseded architecturally by the alpha.53 Evolution Lab split — the furnace itself now lives in `money-printer-evolution-lab`. |
