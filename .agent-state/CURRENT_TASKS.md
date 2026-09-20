# Current tasks — 2026-09-19 (alpha.53)

Folded forward from the 2026-09-16 (alpha.42-era) table below and the undotted
`agent-state/CURRENT_TASKS.md` snapshot (2026-09-19), which is now deleted — this file is the
single, current record.

| Task | Status |
| --- | --- |
| Replay-lab main-module path (spaces in the checkout path) | **Done** — `tests/replay-lab.test.mjs:28` uses `fileURLToPath`; 24/24 at `cb71d4c`. |
| Paper bankroll identity helpers + tests | **Done** (base) — `paperIdentity` / save+load guards landed at `cb71d4c`; further hardening (F1/F2/F3/F4/F6/F7/F8 from `ACCOUNTING-AUDIT.md`) is the accounting package's own work-in-progress — see that package's evidence for current status. |
| Impossible SOL jump guard | **Done** (base) — `guardEquityJump` + merge alerts landed at `cb71d4c`; root-cause doc for `state.bad-70sol-*` in `.agent-state/DATA_DECISION_MEMO.md`. |
| `test:visual` wired into `npm run test:all` | **Done** (this package) — `tests/renderer-alpha52.test.mjs`, `tests/visual-assets.test.mjs`, `tests/visual-contract.test.mjs` (25/25) now run in `test:all` via `package.json`'s `test:visual` script. |
| `doctor` reports paper identity + honours `MONEY_PRINTER_DATA_DIR` + `--offline` | **Done** (this package) — `src/doctor.js` prints a `PAPER IDENTITY` line and resolves state/journal paths the same way `src/store.js` does; `--offline` / `DOCTOR_OFFLINE=1` skips the RPC benchmark. |
| Doc contradictions (stale `PROJECT_STATE.md`/`CURRENT_TASKS.md`, missing README) | **Done** (this package) — both `.agent-state` files restamped to alpha.53, undotted twins folded in and deleted; new root `README.md` added; `EXECUTION_UPDATE.md` marked historical; `docs/EVOLUTION_LAB_SPLIT.md` gained a macOS verification line. |
| Visual OS-wide pass to Polymarket Suite standard | Open — audit in `.workflow/scratch/VISUAL-AUDIT.md`; owned by the visual package. |
| `icon.icns` / dock packaging asset | Landed at `cb71d4c` (`build/icon.icns`); packaging package verifies it lands in the `.asar`. |
| Packaged alpha.53 asar + `RELEASE_STATUS.md` SHA-256 | Open — owned by the packaging package; **bing does the install/restart click**, agents do not. |
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
