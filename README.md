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
  `test:*` target).

## Paper mode

Everything ships in `mode: paper` by default: no real orders, no real funds. The paper bankroll
identity (`paperStartSol + realizedLifetimePnlSol + unrealized ≈ equity`) is asserted by
`src/accounting.js#paperIdentity` and guarded on load/save in `src/store.js`; `npm run doctor`
prints it as a `PAPER IDENTITY` line. Live user data (when the packaged app is installed) lives
under `~/Library/Application Support/Money Printer OS/` and is never touched by anything in this
source tree directly — only read-only copies are used for analysis.

## More

- `.agent-state/PROJECT_STATE.md` — authoritative architecture/version snapshot.
- `.agent-state/CURRENT_TASKS.md` — active work.
- `.agent-state/KNOWN_BUGS.md`, `.agent-state/RELEASE_STATUS.md` — open issues and packaging
  history.
- `docs/` — design notes, including `docs/EVOLUTION_LAB_SPLIT.md`.
- `EXECUTION_UPDATE.md` — historical (alpha.41); superseded by `.agent-state/`.
