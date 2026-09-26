# Money Printer OS

Version `0.5.0-alpha.53`. A native, retro-styled trading workstation: continuous research,
paper-mode strategy evaluation, monitoring, and desktop supervision, launched from
`desktop/main.cjs`.

## Status

**Real-money execution is locked.** `liveExecution: 'manual'`,
`automaticLivePromotionAllowed: false`, and `liveActivationAllowed: false` are enforced at
multiple points (`src/dashboard.js`, `src/index.js`, `src/experimentRegistry.js`,
`src/labLink.js`, `src/researchLifecycle.js`, `src/researchControlPlane.js`). Nothing in this
tree loosens those gates automatically; live trading requires an explicit, manual step outside
of research/evolution code paths.

Alpha.53's headline change is the **Evolution Lab split**: the strategy-search furnace
(evolution engine, BEAST/GPU scorer, research cluster) has moved to a separate app,
`money-printer-evolution-lab` (Windows-only). This trader keeps the network mesh, the
read-only research/evidence surfaces the HUD reads, and a small link module
(`src/labLink.js`, action-queue rails in `src/store.js`) that syncs with the lab when one is
configured. On a machine with no lab configured (e.g. this Mac), the HUD correctly reports the
Evolution panel as `NOT LINKED` — that is the expected state, not a bug. See
`docs/EVOLUTION_LAB_SPLIT.md` for the full design and its cross-platform verification notes.

## Running it

- `npm ci` — install dependencies (`node >=22`; developed against Node 24).
- `npm run selftest` — fast in-process smoke check (`src/selftest.js`).
- `npm run doctor` — environment/config/paper-bankroll report (`src/doctor.js`); pass
  `--offline` (or set `DOCTOR_OFFLINE=1`) to skip the live RPC benchmark, e.g. for CI or any
  run with network providers disabled/mocked.
- `node src/index.js --dashboard-only` — start just the dashboard server without the trading
  loop.
- `npm run test:all` — the full test suite (see `package.json` `scripts` for every individual
  `test:*` target). `tests/visual-assets.test.mjs` shells out to `python3` with Pillow installed.
- `npm run test:updater` — the release-channel resolver, the GitHub Releases/redirect fetch path
  and `scripts/sign-manifest.mjs`, all against local mock servers and a throwaway key.

## Releases and updates

CI (`.github/workflows/ci.yml`) runs the suite, the self-test and the offline doctor on every push
to `main` and every pull request. A `v*` tag runs `.github/workflows/release.yml`, which builds the
unified macOS arm64 + Windows x64 packages on a macOS runner (`scripts/build-unified.mjs`) and
attaches them to a **draft** GitHub Release together with an unsigned updater manifest.

Installed copies update from this repository's GitHub Releases: `desktop/main.cjs` fetches the
newest published release's `manifest.json` and `app.asar` (`desktop/update-channel.cjs`,
`desktop/update-fetch.cjs`), verifies the Ed25519 signature with `desktop/update-public-key.pem`,
then the archive's SHA-256 and size. A release becomes visible to the updater only once bing has
signed the manifest by hand (`node scripts/sign-manifest.mjs sign`) and published the draft.
While the repository is private the installed app needs `MONEY_PRINTER_UPDATE_TOKEN` in its
`.env`. Everything, including `MONEY_PRINTER_UPDATE_URL` for other channels, is in
`docs/RELEASE-CHANNEL.md`.

## Paper mode

Everything ships in `mode: paper` by default: no real orders, no real funds. The paper bankroll
identity (`paperStartSol + realizedLifetimePnlSol + unrealized ≈ equity`) is asserted by
`src/accounting.js#paperIdentity` and guarded on load/save in `src/store.js`; `npm run doctor`
prints it as a `PAPER IDENTITY` line. Live user data (when the packaged app is installed) lives
under `~/Library/Application Support/Money Printer OS/` and is never touched by anything in this
source tree directly — only read-only copies are used for analysis.

## Robinhood Auto Trader

A self-contained crypto venue module (`src/robinhoodAutoTrader.js`, spec in `docs/ROBINHOOD-AUTO-TRADER.md`)
that trades spot crypto through Robinhood's official Crypto Trading API. It is paper-first and
Bitcoin-primary: live quotes feed a local price tape and a fee-aware paper book, `BTC-USD` is sampled
first and weighted in candidate ranking (`ROBINHOOD_PRIMARY_*`), and other `*-USD` pairs trade by the
same rules. Real money is off by default (`ROBINHOOD_REAL_ENABLED=false`); real orders need an armed
session plus a typed phrase, and the real autopilot additionally needs the paper book to qualify the
strategy. A paper-only evolution loop (`src/robinhoodTape.js`, `src/robinhoodBacktest.js`,
`src/robinhoodEvolve.js`, spec section 22) replays the recorded price tape walk-forward and proposes
better strategy parameters in the HUD; they are applied to the paper book only (never to real autopilot)
and only on APPLY unless `ROBINHOOD_EVOLVE_AUTOPROMOTE=true`. Run `npm run test:robinhood`; nothing in
the suite touches the network.

## More

- `.agent-state/PROJECT_STATE.md` — authoritative architecture/version snapshot.
- `.agent-state/CURRENT_TASKS.md` — active work.
- `.agent-state/KNOWN_BUGS.md`, `.agent-state/RELEASE_STATUS.md` — open issues and packaging
  history.
- `docs/` — design notes, including `docs/EVOLUTION_LAB_SPLIT.md`.
- `EXECUTION_UPDATE.md` — historical (alpha.41); superseded by `.agent-state/`.
