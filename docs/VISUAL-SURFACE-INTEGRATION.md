# Application-surface polish — integration points

This lane raises laggard Money Printer OS panes to the Polymarket Suite glance language. It does **not** own shell chrome extraction, glass tokens, typed-confirm, or profit/loss FX.

## Consume (do not fork)

| Owner | What this lane uses |
|---|---|
| Shared visual (`mpo-shell.css`, `mpo-workstation.css`) | `--mpo-*` tokens, `.mpo-surface-*` glass, `.mpo-status` / `.mpo-metrics` / `.mpo-badge` / `.mpo-table` / `.mpo-empty` / `.mpo-error` / `.mpo-fieldset` |
| Motion FX lane | `#moneyRain` / `#horizonFire` / `#bottomFire`, `updateDesktopEffects` polarity (profit rain, loss fire). CSS-drawn `.bill` / `.flame` stay as the fallback; `.fire-sprite` / `.smoke-sprite` are unused hooks |
| Polymarket Suite | Frozen. No `.mpo-surface-*` on `#body-sportsbook`. `.poly-strip` / `.poly-bar` / `.poly-mod` / `.metric-grid { repeat(4,1fr) }` unchanged except shared `.mpo-error` on module/API failures. Fast Combos / US / Paper Lab already satisfy the 3-tier glance path |

## Glance recipes added by this lane (laggard panes only)

| Class | Used by |
|---|---|
| `.mpo-sysrow` + `.sysbar.warn` / `.hot` | System Monitor CPU/RAM/scanner bars |
| `.mpo-peer` | Network/Hive peer cards |
| `.mpo-log-pane` + `.mpo-dot` | Live Log + Archive status strip |
| `.mpo-spark` | Wallet Intel score bar |
| `.mpo-gauge` | Risk Radar daily-loss budget (display only) |
| chart fill `rgba(57,255,104,.14)` under stroke `#39ff68` | Trading Terminal equity chart |

## Surface opt-in

| Renderer | Surface |
|---|---|
| Trade, Evolution, Risk, Log, System, Network, Archive | `.mpo-surface-dark` |
| Wallet, Controls, Settings, About, Updater | `.mpo-surface-light` |
| Sportsbook / Fast Combos / US / Paper Lab | none |

## Left to other lanes

- In-OS `typedConfirm` for `FORGET` / `CLOSE REAL POSITION` / `CANCEL REAL ORDER(S)` (still `window.prompt` here)
- WebP bill/fire/smoke sprites and settlement money bursts
- File/View/Tools/Help wiring (decorative; `pointer-events:none`)

## Load path

`dashboard.html` links `/css/mpo-shell.css` + `/css/mpo-workstation.css`. `src/dashboard.js` serves `GET /css/` (`text/css`, `no-store`, `nosniff`) immediately after `/assets/`.
