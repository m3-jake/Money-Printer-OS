# Money Printer OS — project state (2026-09-20, alpha53 integrated)

- **Authoritative source:** `/Users/bing/Desktop/Money Printer OS/Current/MPO-alpha53-release-src`
  (git; `93c8022` = "alpha53 source as received", fast-forwarded through `cb71d4c` = "fix: alpha53
  paper identity + equity jump guards", then through the five alpha53 work packages —
  `product` `2420d77`, `packaging` `eaee265`/`1813445`/`e611a75`, and the integrator's merges of
  `wf/ship-fixes` `971a168`, `wf/accounting` `52a6e74` and `wf/visual` `11d676a`. All five are
  now on `main`; see `.agent-state/INTEGRATION_LEDGER.md` for the merge record and
  `.agent-state/RELEASE_STATUS.md` for the packaged artifact). Older alphas (`MPO-alpha38/39/40/41/42-release-src`)
  are history only, under `../../Archive/` conventions from prior trees.
- **Version:** package.json `0.5.0-alpha.53`.
- **Headline (alpha53): the Evolution Lab split.** The strategy-search furnace (evolution
  daemon, BEAST/GPU scorer, robustness audit, research cluster) moved out of this trader into a
  separate Windows-only app, `money-printer-evolution-lab`. This tree keeps the network mesh,
  the evidence collector, the read-only research/evidence surfaces the HUD reads, and the new
  lab-link module `src/labLink.js` (schema `mpo.lab-*.v1`) plus action-queue rails in
  `src/store.js` (oversized-action refusal, queue quarantine, orphaned `.drain` sweep). See
  `docs/EVOLUTION_LAB_SPLIT.md` for the full design; verified on Windows (real cross-machine
  link) and separately on macOS (`npm run test:lab-link` 8/8, HUD `NOT LINKED` as expected with
  no lab configured on this Mac — that is not a fault).
- **Installed app:** `~/Applications/Money Printer OS.app` (Electron; `Contents/Resources/app.asar`;
  `app.asar.previous` = rollback). The Desktop `Money Printer OS.app` copy, if present, is a
  separate, older install. User data + `.env` live in
  `~/Library/Application Support/Money Printer OS/` (`data/` holds state,
  `polymarket-paper.json`, `polymarket-us-combos.json`); agents only ever read a **copy** of that
  data into `.workflow/scratch/data-ro/` for analysis and never write back to it, and never
  install into `~/Applications` or restart the installed app themselves.
- **Launch path**: `desktop/main.cjs` spawns `src/index.js` (dashboard on `127.0.0.1:8792`) and
  `src/networkMesh.js`; no `evolution`/`clusterHub`/`clusterWorker`/`researchAudit` children
  post-split. Updater pulls from this repository's GitHub Releases (`desktop/update-channel.cjs` +
  `desktop/update-fetch.cjs`; `MONEY_PRINTER_UPDATE_URL` overrides, `MONEY_PRINTER_UPDATE_TOKEN`
  while the repo is private; Ed25519-signed `manifest.json` release asset, public key
  `desktop/update-public-key.pem`) and auto-applies when `MODE != live`. The old
  `bangbowbing.net/downloads/...` directory never had a host. Flow, signing script and CI/release
  workflows: `docs/RELEASE-CHANNEL.md`.
- **Packaging**: alpha53 uses a staged-copy + `npx @electron/asar@4.3.0` pack driven by
  `scripts/release-alpha53.mjs` (`pack` | `test-record` | `promote`; `install`/`restart` exist
  only as a reference and hard-refuse under an agent). No `release-alpha41.py`-style script in
  this tree. The packaged artifact, its SHA-256 and the exact install/rollback commands for
  bing are in `.agent-state/RELEASE_STATUS.md`.
- **Sportsbook architecture**:
  - `src/polymarket.js` + `src/sportsTiming.js`: paper "fast-turnover" lab on **global**
    Polymarket (gamma + CLOB + sports WS). Paper only; real execution intentionally locked.
    Settlement-bias repair (closed-market fetch + any-lost-leg combo booking, `keep=false`) is
    paper/research-only; re-verified green on this alpha.53 tree via
    `tests/polymarket-settlement.test.mjs` as part of the `test:all` baseline. See
    `.agent-state/SETTLEMENT_BIAS_AUDIT.md` for the original audit.
  - `src/polymarketUS.js`: **Polymarket US** retail API via `polymarket-us` SDK 0.1.1
    (single-market orders; arm + typed confirmation).
  - `src/polymarketUSCombos.js`: live in-play scanner on Polymarket US, near-settlement 2-3 leg
    **combos** (`POST /v1/combos` → RFQ → accept/confirm, or limit order on the `caoc-` symbol),
    journal, safety gates, optional double-opt-in autopilot.
- **Polymarket US facts**: Retail Combos/RFQ API is beta-gated per key (403 until allow-listed —
  documented as expected, not a bug); fees `Θ·C·p·(1−p)`; public gateway BBO needs a
  browser-like User-Agent; `/book` and `/events/slug/*` need signed headers.
- **Accounting (this tree):** `src/accounting.js#paperIdentity` / `assertPaperIdentity` and
  `src/store.js`'s load/save guards (`guardEquityJump`, teleport refusal) landed at `cb71d4c`;
  the accounting package's F1–F4/F6–F8 hardening landed at `52a6e74` and is now on `main`:
  `loadState()` reconstructs a lifetime ledger for legacy (pre-ledger) snapshots, `saveState()`
  refuses `REALIZED_WITHOUT_BASIS` and `REALIZED_EXCEEDS_MARK` writes, ticks outside a
  median-anchored upper band are quarantined, and paper entry sizing is levered off
  cash + cost basis instead of the mark (`src/positionExecution.js`). `node src/doctor.js
  --offline` prints a `PAPER IDENTITY` line (start/life/unreal/openRz/equity/holeExact/okExact).
  Re-proved at integrated HEAD: all five read-only snapshots load through `loadState()` with
  `holeExact = 0.000000000` and `okExact = true`, and the real 2026-09-10 PEG rewrite that
  created the 70 SOL equity is **refused** with `REALIZED_WITHOUT_BASIS` while `state.json` on
  disk stays byte-identical (`.workflow/scratch/integration/recon-loadstate.log`,
  `guards-proof.log`). The historical spike itself is still root-caused as open-realized + mark
  inflation (`.agent-state/DATA_DECISION_MEMO.md`); the guard prevents creation, it does not
  rewrite history already on disk.
- **Visual (this tree):** the OS-wide pass to the Polymarket Suite benchmark landed at
  `11d676a` — two additive tokens and four shared components (`.mpo-module`, `.mpo-meter`,
  `.mpo-brand-title`, `.mpo-danger-fieldset`) in `public/css/mpo-workstation.css`, with System
  Monitor, Research Monitor, Control Bay, Risk, Wallet, Money and Updater migrated onto them in
  `public/dashboard.html`. No trading, wallet or API semantics changed; `npm run test:visual`
  26/26. Evidence (including the honest note that the headless browser pane cannot write
  screenshot files, so DOM dumps stand in): `.workflow/scratch/visual/VISUAL-PASS.md`.
- **Real-money execution stays locked**: `liveExecution: 'manual'`,
  `automaticLivePromotionAllowed: false`, `liveActivationAllowed: false` enforced at multiple
  points (`src/dashboard.js`, `src/index.js`, `src/experimentRegistry.js`, `src/labLink.js`,
  `src/researchLifecycle.js`, `src/researchControlPlane.js`). Do not loosen. Do not rewrite
  `~/Library/Application Support/Money Printer OS/`. Agents do not install or restart the app —
  bing does.
- **Prior (alpha.41-.42) execution/settlement work**: see `EXECUTION_UPDATE.md` (now marked
  historical) and `.agent-state/INTEGRATION_LEDGER.md` for the alpha.42-era integration record
  this tree descends from.
