# Polymarket US combos (live games about to end, manual, real money)

Status (2026-09-26): built on `feature/polymarket-combo-only`. The stored API key returns
401 `keyNotFound`, so no real combo has been placed yet, and the combos beta has not been probed.
See section 12.

## 1. Purpose

One Polymarket window that does one thing. It lists live sports games that are close to ending,
soonest first, and shows each game's winning side when that side is priced from an adjustable floor
(default 80%, down to 60%) up to 98.5%. The operator ticks two or three of them, reviews one quote,
types the confirmation phrase, and one combo goes to Polymarket US.

A combo pays only if every leg wins. One lost leg loses the whole stake, which is why the money caps
in section 7 are fixed server-side and cannot be raised from the UI.

## 2. What ships / what does not

Ships:
- `src/polymarketUSCombos.js`: the live feed, the candidate filter, combo math, RFQ quote and place,
  the journal, reconcile, settlement and the owner settings.
- `src/polymarketUS.js`, credentials and the session arm only: `usReadiness`, `configurePolymarketUS`,
  `armPolymarketUS`, `noteUSAuthResult`.
- The Polymarket US window in `public/dashboard.html` (one `.poly-mod`, `POLY_MODS=['combos']`).
- `scripts/polymarket-us-preflight.mjs`, which proves the key and optionally the combos beta.

Removed on 2026-09-25/26:
- The paper sports lab (UI and `/api/polymarket/*` routes). `src/polymarket.js` stays because the
  research collector and tests import it.
- The US market scanner and single-order routes (`/api/polymarket-us`, `/preview`, `/order`, `/close`,
  `/cancel`, `/cancel-all`). The functions stay in `src/polymarketUS.js`, parked.
- The combo autopilot, deleted rather than hidden. The only background loop settles journalled combos
  and never quotes or places anything.

Not built:
- The singles fallback, which places each leg as its own order. It is built only after preflight
  observes a 403 on `POST /v1/combos`, and its order body must first be proven with one $1 order that
  the owner places.

## 3. Credentials

- Create a key at https://polymarket.us/developer.
- Paste the Key ID and secret into the key form in the Polymarket window. The form also appears when the
  stored key is rejected.
- They are written to `<user root>/.env` as `POLYMARKET_KEY_ID` / `POLYMARKET_SECRET_KEY`, with
  restricted permissions. The secret is never rendered back into the UI.
- Signing: `X-PM-Access-Key`, `X-PM-Timestamp`, and `X-PM-Signature` =
  Ed25519(`timestamp + method + path`), using the first 32 bytes of the base64 secret
  (`signedFetch` in `src/polymarketUSCombos.js`).

## 4. Preflight

```
node scripts/polymarket-us-preflight.mjs [--probe-combo]
```

- The script sends a signed `GET /v1/orders/open`, which only reads, to prove the key.
- With `--probe-combo`, and only after that returns 2xx, it also sends a signed `POST /v1/combos` with
  two live `comboEnabled` legs. That creates a combo instrument, not an order.
- The script uses a temp data dir, so it never writes the live journal.
- The report goes to `reports/polymarket-preflight-<local date>.md`, with IDs redacted.

| Result | Meaning |
| --- | --- |
| 401 | Regenerate the key. |
| 403 on combos | Beta pending; the singles fallback becomes the next build. |
| 2xx | Combos are primary. |

## 5. Data file

`<data>/polymarket-us-combos.json`. In the packaged app this is `%APPDATA%\Money Printer OS\data`.

| Key | Contents |
| --- | --- |
| `settings` | `{priceMin, maxMinutesLeft, maxLegs}` (section 6). |
| `open[]` | Journal entries: `SUBMITTED` → `OPEN` (`fillVerified:true`) → moved to `history[]` as `WON`, `LOST`, `CANCELLED` or `FORGOTTEN`. Each carries its legs, the estimated and fill price, quantity, stake, `rfqId`/`quoteId`/`orderId`, and `pnlUsd`, which stays null until settled with a verified fill. Optional flags: `acceptUncertain`, `acceptError`, `confirmError`. |
| `history[]` | Last 200 closed entries. |
| `combos{}` | Combo symbols created on the exchange, keyed by symbol, with their exact legs. The quote/leg binding check uses them. |
| `cooldowns{}` | Event slug → settlement time (3-minute cooldown). |
| `stats` | `placed`, `won`, `lost`, `pnlUsd`, `hitRate`. |

- Writes are atomic: temp file, then a rename with retry.
- A corrupt file sets `recoveryRequired`. That blocks every signed call and every settings write, and the
  file is never overwritten.
- A journal from an older build that still carries an `autopilot` key loads normally, and the key is
  dropped on the next save.

## 6. Owner settings

Settings are stored in `journal.settings`, changed with `POST /api/polymarket-us/combos/settings`, and
enforced in the feed filter, the BBO refresh, leg resolution (so in build, quote and place), and the
snapshot suggestion.

| Setting | Range | Default | Effect |
| --- | --- | --- | --- |
| `priceMin` | 0.60 to 0.985 | 0.80 | The lowest win price a leg may have. The 0.985 ceiling is fixed. |
| `maxMinutesLeft` | 1 to 30 | 15 | The latest estimated minutes to the end of the game. |
| `maxLegs` | 2 to 3 | 3 | The most legs in one combo. |

- An out-of-range value is rejected with `settingsInvalid`.
- A bad stored value falls back to the default, never to a wider band.

## 7. Real-money gates (server-side, in order)

1. `requireArmed`: credentials are present, `POLYMARKET_US_REAL_ENABLED` is not false, the session is
   armed from the window, and the journal is not in recovery.
2. Placing needs the exact phrase `PLACE REAL COMBO`, typed by the operator. The UI never pre-fills it.
3. `placeBusy`: one placement at a time.
4. `usComboLimits()`:

   | Limit | Default |
   | --- | --- |
   | Stake per combo, fees included | $25 |
   | Open combos | 5 |
   | Realized daily loss | $50 |
   | Quote above estimate | 0.02 |

5. Legs:
   - Each leg must still be a live candidate.
   - No two legs may share an event.
   - Each leg's data must be at most 90 s old (`FRESH_LIMIT_SEC`).
   - Each leg must be inside the price band.
   - No leg may already be in an open combo or in a post-settlement cooldown.
6. The quote is re-read from the exchange before accepting, never taken from the client. It must be
   active, bound to the canonical combo of exactly these legs, and its quantity × price plus fees must
   fit the stake.
7. **Journal before accept.** The entry is written `SUBMITTED` and unverified before `PUT …/accept`.
   - A definite 4xx rejection removes it.
   - A timeout, network error or 5xx keeps it, flagged `acceptUncertain`, because the accept may have
     landed.
   - A confirm failure keeps it with `confirmError`.
8. A 401 is classified `keyNotFound`. A 403 is classified `betaNotEnabled` and sets
   `betaAccess='denied'`. Either one aborts reconcile without dropping entries.

## 8. Reconcile and P/L

- Reconcile reads the real order: `GET /v1/rfqs/quotes` to find `rfqCreatorOrderId`, then
  `GET /v1/order/{id}`.
  - A filled quantity marks the entry `OPEN` with `fillVerified:true`.
  - A terminal order with nothing filled marks it `CANCELLED`.
  - A quote that died without ever being accepted is cancelled.
  - Unknown shapes stay `SUBMITTED`.
- Settlement reads `/v1/markets/{slug}/settlement` per leg and books `WON` or `LOST` with `pnlUsd`,
  **only for verified fills**.
- "Forget…" drops an entry locally after the `FORGET` phrase. It makes no exchange call and books no P/L.

## 9. HTTP routes (all under `/api/polymarket-us`)

| Route | Purpose |
| --- | --- |
| `GET /readiness` | Credentials and arm state |
| `POST /config` | Save the key |
| `POST /arm` | `{armed}` for this session |
| `GET /combos` | Snapshot: readiness, feed with rejections, candidates soonest-first, `suggested`, quote, journal, limits, `settings`, `settingsBounds`, `betaAccess` |
| `POST /combos/build` | Pure math: `{legKeys, stakeUsd}` → price, quantity, fees, payout. The first success records product activation. |
| `POST /combos/quote` | Create the combo, send the RFQ and poll for the best active quote |
| `POST /combos/place` | `{legKeys, stakeUsd, mode:'rfq', rfqId, quoteId, confirmation}` |
| `POST /combos/cancel-rfq` | Cancel an RFQ |
| `POST /combos/settings` | Change the owner settings |
| `POST /combos/settle` | Force a reconcile and settlement pass |
| `POST /combos/forget` | `{id, confirmation:'FORGET'}` |

## 10. The window

1. **Status row:** key state, combos beta, the Arm button and feed health. The key form appears when
   the key is missing or rejected.
2. **Settings row:** win-% floor, minutes left, max legs, Save.
3. **Live games,** sorted by minutes left: event, clock and score, side, win %, minutes left, and a
   checkbox. Nothing is pre-ticked, and extra ticks are disabled at max legs. Filter reasons are listed
   underneath.
4. **Stake** and a live "N legs · pays $X" line.
5. **Place combo…** gets a quote, then opens an in-page dialog (`#polyConfirm`):
   - It shows the legs, the stake, the quoted price and payout, and an expiry countdown.
   - The phrase field is typed by the operator.
   - At zero, Confirm locks and **Re-quote** cancels the RFQ and quotes the same legs and stake again.
   - Dismissing the dialog cancels the RFQ.
   - With `betaAccess==='denied'` the button reads "combos beta pending" and is disabled.
6. **Open combos** show fill verified or unverified, the flags and P/L, plus Check settlement and
   Forget…. **History** and stats sit alongside.

## 11. Owner check (under 30 seconds)

1. Connect the key, then Arm.
2. Set the floor to 60% and save.
3. Tick three games, then Place.
4. Review the one dialog, type the phrase and confirm.

The proof is the redacted journal entry, not screenshots. It goes `SUBMITTED`, then `OPEN` with
`fillVerified:true`, and later `WON` or `LOST` with `pnlUsd`.

## 12. Unverified until observed live

- The key currently returns 401 (`.agent-state/KNOWN_BUGS.md`, product item 2).
- Combos beta access (product item 3).
- The `/v1/order/{id}` and settlement payload shapes are implemented from the docs (product item 5).
  The first real combo must confirm them. Do not fabricate a payload to close this.

## 13. Tests

- `npm run test:combos` (`tests/polymarket-us-combos.test.mjs`) is the real-money guard suite: gates,
  quote binding, stake cap, serialization, reconcile, settlement, settings, journal-before-accept, and
  the removal of autopilot.
- `test:visual` pins the phrases and the single panel. `test:robinhood` pins `POLY_MODS`.
- `test:product-economics` covers activation on the first combo build.
