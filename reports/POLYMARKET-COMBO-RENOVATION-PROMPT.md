# Polymarket combo renovation

## Goal
Replace the three-module Polymarket Suite (`POLY_MODS=['combos','us','paper']` in `public/dashboard.html`) with one panel: live sports games about to end, sorted by minutes left, winning side priced from an adjustable floor (default 0.80, settable down to 0.60) up to 0.985. They tick up to three legs, confirm once, and one combo goes to Polymarket US. Nothing else.

## Non-goals
- Do not touch Robinhood, Solana, the research/evidence pipeline, `src/sportsTiming.js`, `desktop/release-gate.cjs`, or the `.poly-*` CSS tokens.
- Do not delete `src/polymarket.js` or `src/polymarketUS.js`; tests and other modules import them (grep before removing anything). Park them: remove their dashboard routes and UI, leave the files.
- No autopilot. Delete it, do not hide it.
- Do not loosen any money cap, typed phrase or fail-closed rule, and do not invent API payload shapes (`.agent-state/KNOWN_BUGS.md` item 5).

## Current state
- `src/polymarketUSCombos.js`: keep and slim. `PRICE_MIN=0.80`, `PRICE_MAX=0.985`, `NEAR_END_MIN=65` (line 35) are hard constants enforced in the candidate filter, in `buildUSCombo` and in the autopilot picker. This is why 60 to 80 percent games never appear. Autopilot (`usComboAutopilot`, `setUSComboAutopilot`, `runUSComboAutopilotOnce`, `runUSComboAutopilotPass`, `CONFIRM_AUTOPILOT`) goes.
- `src/polymarketUS.js`: keep `usReadiness`, `configurePolymarketUS`, `armPolymarketUS`, `noteUSAuthResult`, and `submitPolymarketUSOrder` (fallback only). Park the scanner and the other single-order routes.
- `src/dashboard.js`: keep `/api/polymarket-us/{readiness,config,arm,combos}` and `/api/polymarket-us/combos/{build,quote,place,cancel-rfq,settle,forget}`. Drop the `./polymarket.js` import, every `/api/polymarket/*` route, `paperOrderResult`, and the `/combos/autopilot` route.
- `public/dashboard.html`: the Polymarket window (the `POLY_MODS` render around lines 556-861 plus the two polls near line 1020) becomes one module. Keep `showDialog`, `trackComboProfitBurst` and `windowVisible('sportsbook')`.
- Tests: `tests/polymarket-us-combos.test.mjs` is the real-money guard suite and stays green (it reads `snap.suggested.legs`, so keep `suggested` in the snapshot). `tests/robinhood-hud.test.mjs:44` pins the `POLY_MODS` array and `tests/visual-contract.test.mjs` pins the confirmation phrases; update both in the same commit as the UI.

## Preflight (before editing anything)
1. `npm run test:all`; record which suites pass.
2. Confirm `open[]` is empty in the live journal `data/polymarket-us-combos.json` (packaged app: `%APPDATA%\Money Printer OS\data`).
3. Add `scripts/polymarket-us-preflight.mjs` using the exported `signedFetch`: signed `GET /v1/orders/open` (proves the key), then signed `POST /v1/combos` with two live `comboEnabled` legs (the only real beta probe; it creates an instrument, not an order). Write status codes and redacted bodies to `reports/polymarket-preflight-<date>.md`.
4. Branch on the result. 401: the owner regenerates the key at polymarket.us/developer; keep building, tests mock fetch. 403: build the singles fallback below and label Place "combos beta pending". 2xx: combos are primary.

## Target design
One module, one 5-second poll of `GET /api/polymarket-us/combos` while the sportsbook window is visible.
1. Status row: key state, beta state, Arm toggle, key form when `credentialsReady` is false.
2. Settings stored in `journal.settings` via a new `POST /api/polymarket-us/combos/settings`: `priceMin` (default 0.80, range 0.60 to 0.985, shown as win %), `maxMinutesLeft` (default 15), `maxLegs` (default 3). Every enforcement point reads these instead of the constants.
3. Candidate table sorted by `etaMinutes` ascending: event, clock/score, side, win %, minutes left, checkbox. Nothing pre-ticked. Show `feed.rejections` under the table so an empty list explains itself.
4. Stake input and a live "3 legs · pays $X" line from `POST /combos/build`.
5. One Place button: `quoteUSCombo`, then an in-page confirm dialog (legs, stake, quoted payout, expiry countdown, `PLACE REAL COMBO` field, never auto-filled), then `placeUSCombo`. At countdown zero the confirm disables and offers one-click re-quote (`cancelUSRfq` then `quoteUSCombo`, same legs and stake).
6. Fallback when `betaAccess==='denied'`: the same button submits each ticked leg as a single order through `submitPolymarketUSOrder`, stake split evenly, same armed session and phrase, journaled as `fillVerified:false` until `GET /v1/order/{id}` confirms. Say clearly in the dialog that singles pay each leg separately, not multiplied. Prove the order body shape with one $1 order before enabling it.
7. Open combos with `fillVerified` and P/L, a Check settlement button, an in-page `FORGET` dialog (Electron has no `window.prompt`), and history.

## Guardrails to keep (server side)
`requireArmed`; exact `CONFIRM_PLACE`; `placeBusy`; `usComboLimits` (stake 25, open 5, daily loss 50, tolerance 0.02); distinct events; `FRESH_LIMIT_SEC` 90; quote bound to the exact legs and stake; `betaAccess='denied'` on 403; `keyNotFound`/`betaNotEnabled` abort reconcile without dropping entries; no P/L for unverified fills; `recoveryRequired` blocks signed calls. Add one: write the journal entry before the RFQ accept call, remove it if accept throws, keep it if confirm throws. One lost leg wipes many small wins; the caps are the only thing that bounds that.

## Steps (one commit each, `test:all` green after every one, branch `feature/polymarket-combo-only`)
1. Preflight script and report.
2. Detach the paper lab: the dashboard import, `/api/polymarket/*` routes, `paperOrderResult`, the paper-single probe in `tests/product-economics-http.test.mjs` (retarget activation to the first successful `/combos/build` and note it in `docs/PRODUCT-ECONOMICS.md`), and the paper poll in the UI.
3. Settings plumbing, route and enforcement points, with tests: 0.65 passes at floor 0.60 and fails at 0.80; a fourth leg is rejected at `maxLegs` 3.
4. Journal-before-accept, with tests for both failure orders.
5. Delete autopilot and its route; the loop keeps only `settleUSCombos`; `normalizeJournal` tolerates old `autopilot` keys; fix the pinned tests.
6. Singles fallback (only if preflight said 403), with a test that a 403 never creates a combo.
7. Single-panel UI plus the `POLY_MODS` and phrase tests.
8. Docs: `.env.example`, new `docs/POLYMARKET-COMBOS.md` (model it on `docs/ROBINHOOD-AUTO-TRADER.md`), `.agent-state/KNOWN_BUGS.md`, `MONEY_PRINTER_STATUS.md`.

## Acceptance criteria
- `npm run test:all` green, including `test:combos`, `test:polymarket-us`, `test:visual`, `test:robinhood`, `test:product-economics`, `test:release-gate`.
- `grep -n "'./polymarket.js'" src/dashboard.js` returns nothing; exactly one `.poly-mod` in `public/dashboard.html`.
- Owner check under 30 seconds: Connect, Arm, set floor 60%, tick three, Place, one dialog, phrase, confirm. The journal entry goes `SUBMITTED`, then `OPEN` with `fillVerified:true`, later `WON` or `LOST` with `pnlUsd`. The redacted journal entry is the proof, not screenshots.

## Deliverables
Eight commits, the preflight report, the docs above, and a final message listing preflight status codes, lines deleted per file, tests changed, and open blockers.
