# Money Printer OS

Source version `0.5.0-alpha.83`, paired with Evolution Lab `0.1.0-alpha.20` (installation is tracked separately). A native, retro-styled trading workstation: continuous research,
paper-mode strategy evaluation, monitoring, and desktop supervision, launched from
`desktop/main.cjs`.

## Status

**Real-money execution is locked.** `liveExecution: 'manual'`,
`automaticLivePromotionAllowed: false`, and `liveActivationAllowed: false` are enforced at
multiple points (`src/dashboard.js`, `src/index.js`, `src/experimentRegistry.js`,
`src/labLink.js`, `src/researchLifecycle.js`, `src/researchControlPlane.js`). Nothing in this
tree loosens those gates automatically. This build cannot enable real trading through runtime flags.

The **Evolution Lab split** remains the current architecture. The separate Windows app,
`money-printer-evolution-lab`, now defaults to a Research Workbench: forecast calibration,
bounded worker replay, farm review and evidence collection. The old furnace is retired by
default. This trader keeps the network mesh, the
read-only research/evidence surfaces the HUD reads, and a small link module
(`src/labLink.js`, action-queue rails in `src/store.js`) that syncs with the lab when one is
configured. On a machine with no lab configured, the HUD correctly reports the
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
prints it as a `PAPER IDENTITY` line. Installed runtime data is resolved separately from the archive
through the app's data-directory settings, including `MONEY_PRINTER_DATA_DIR`. Builds do not bundle
operator books or credentials; the paired installer preserves them.

## AGGRESSIVE_PAPER research

Set the paper profile to `AGGRESSIVE_PAPER` to enable its paper-only overrides. Reports read
`data/market.ndjson`; shadow measurements write to `data/shadow-live.ndjson`. Kalshi demo credentials
use `KALSHI_API_KEY` and `KALSHI_PRIVATE_KEY`, with the demo host enforced in paper mode.

**LIVE IS STILL LOCKED.** Live execution remains manual and automatic promotion remains disabled.
Task checkpoints and limitations are tracked in [`PROGRESS.md`](PROGRESS.md).

## Current paper research

Robinhood starts new paper books at $25. Its wider crypto universe and multi-day research give
the Lab more useful observations; the strategy still refuses moves that cannot cover modeled
costs. Exploration remains separate from qualification. Practice uses a cost-aware entry threshold
and a longer observed lookback. Daily-book qualification requires prospective venue entry and exit
quotes; historical candle fills remain diagnostic.
Weekly top-k momentum rotation is implemented as research, currently blocked by insufficient
common daily history. BTC tape replay also awaits settled validation events and execution evidence.

Kalshi weather and BTC bots, their forward variant farm, and the Polymarket leader copy bot keep
separate paper books. The new Kalshi mirror binds game-winner copies to market identity and game
date, includes fees within its stake, and refuses ambiguous targets. Pump.fun now has a separate
$25 scored-wallet copy book, using prior wallet evidence and exact-size native/Jupiter quotes
after modeled slippage and network fees. Missing quotes never become fills or closes.

The trader accepts fresh, bounded Lab weather-model evidence and complete ensemble forecasts.
Historical weather replay remains diagnostic; its negative results do not authorize paper
promotion. Copy-leader walk-forward research needs at least 14 recorded daily leaderboard snapshots.
Stocks/ETF data still needs Alpaca credentials. SEC insider/13F copy research remains unimplemented
and needs an operator-provided `SEC_USER_AGENT`; supplying that setting alone does not create a bot.
See [`docs/APP-AUDIT-2026-10-03.md`](docs/APP-AUDIT-2026-10-03.md).

## Robinhood Auto Trader

A self-contained crypto venue module (`src/robinhoodAutoTrader.js`, spec in `docs/ROBINHOOD-AUTO-TRADER.md`)
that evaluates spot crypto using Robinhood's official Crypto Trading API and public paper quotes. It is paper-only and
Bitcoin-primary: live quotes feed a local price tape and a fee-aware paper book, `BTC-USD` is sampled
first and weighted in candidate ranking (`ROBINHOOD_PRIMARY_*`), and other `*-USD` pairs trade by the
same rules. Real execution is locked in this build; changing runtime configuration cannot enable it.
A paper-only evolution loop (`src/robinhoodTape.js`, `src/robinhoodBacktest.js`,
`src/robinhoodEvolve.js`, spec section 22) replays the recorded price tape walk-forward and proposes
better strategy parameters in the HUD; they are applied to the paper book only (never to real autopilot)
and only on APPLY unless `ROBINHOOD_EVOLVE_AUTOPROMOTE=true`. Run `npm run test:robinhood`; nothing in
the suite touches the network.

## More

- Quant research library: open the link in Research Monitor to search 5,907 pinned strategy
  documents and review ten candidate mappings. All entries remain unvalidated research inputs.
  See `docs/QUANT-RESEARCH-INTEGRATION-2026-09-28.md` for source findings and implementation priorities.
- `.agent-state/PROJECT_STATE.md` — authoritative architecture/version snapshot.
- `.agent-state/CURRENT_TASKS.md` — active work.
- `.agent-state/KNOWN_BUGS.md`, `.agent-state/RELEASE_STATUS.md` — open issues and packaging
  history.
- `docs/` — design notes, including `docs/EVOLUTION_LAB_SPLIT.md`.
- `docs/RUNBOOK-PANIC.md` — stop / verify / recover: the kill switch only gates entries, how to read
  `/api/health` during an incident, what a refused state save leaves behind, and the reset actions.
- `PROGRESS.md` — remediation ledger: one line per audit item, with the evidence for each fix.
- `EXECUTION_UPDATE.md` — historical (alpha.41); superseded by `.agent-state/`.
