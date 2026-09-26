# Robinhood Auto Trader (crypto, official API, paper-first)

Status: implemented in 0.5.0-alpha.56 — real execution wired, paper-first, Bitcoin-primary (section 21), paper-only evolution (section 22). Real money stays off until `ROBINHOOD_REAL_ENABLED=true`, an armed session and the typed phrases; real autopilot additionally needs paper qualification. Package F (section 19) is closed: HUD/backend contract tests, doctor and health-check readiness lines, release-gate and installer exposure checks all ship.

> **Implementation status - 2026-09-25:** alpha.56 is a paper-only recovery candidate. The paper controller, read-only monitoring, HTTP integration and desktop panel are implemented and tested. Live placement/cancellation, arming, real autopilot, reconciliation and browser credential saving are not installed. No environment flag activates real trading. See [the recovery report](ROBINHOOD-RECOVERY-2026-09-25.md) for delivered scope and verification. The design below describes the target architecture, not a claim that all live features ship today.

The Robinhood Auto Trader window and `GET /api/robinhood` report a self-contained venue module that trades spot crypto through Robinhood's official Crypto Trading API (`https://trading.robinhood.com`). It is built in the Polymarket US style (`src/polymarketUS.js` + `src/polymarketUSCombos.js`): its own signed transport, its own journal under `MONEY_PRINTER_DATA_DIR`, server-side fail-closed gates, a double-opt-in real autopilot and an unref'd loop started by `src/dashboard.js`. It never imports or is imported by the Solana scanner (`src/index.js`), `src/store.js` or `src/accounting.js`. Real money is off by default (`ROBINHOOD_REAL_ENABLED` defaults to `false`), and real autopilot cannot be enabled until the in-house paper book has qualified the strategy on live quotes.

This document is the specification for version 0.5.0-alpha.56. Section 19 lists the work packages, section 20 the interface contract that implementers build against, and section 22 the paper-only evolution loop.

## 1. Purpose

- Give the operator one window that connects official Robinhood crypto API keys, samples live quotes into a local price tape, runs a deterministic long-only strategy on a fee-aware paper book, shows honestly whether the strategy clears Robinhood's fee drag, and only then allows small, capped, typed-confirmation real orders and a qualified real autopilot.
- Keep every real-money invariant the house already relies on: disarmed at boot, typed phrases compared with strict equality server-side, env limits re-read on every call, journal written before any signed request, reconcile-before-book, terminal rows moved to `history[]` so the updater and installer can count `open[]` as real exposure.

## 2. What ships / what does not

Ships:

- Crypto spot trading (long only: buy, then sell to close) on `*-USD` pairs that Robinhood marks `is_api_tradable`.
- Official Crypto Trading API only, v2 endpoints first (`account_number`, fee tiers, `is_api_tradable`), documented v1 fallbacks where Robinhood publishes both shapes.
- In-house paper mode marked from live `best_bid_ask` / `estimated_price` quotes with Robinhood's `fee_ratio`, its own compact price tape (the API has no candles) and a qualification rule.
- A standalone HOST window "Robinhood Auto Trader" in the HUD.

Does not ship, by design:

- Equities or options automation. Robinhood has no public equities API. The only sanctioned agent route for stocks is Robinhood's official Agentic Trading MCP (`https://agent.robinhood.com/mcp/trading`, OAuth in the user's own browser, dedicated Agentic account). This app does not automate it. It will never use robin_stocks-style mobile-app impersonation (`api.robinhood.com/oauth2/token/`): that path is banned by Robinhood's terms and has broken repeatedly. The HUD and the readiness payload say so plainly.
- A sandbox. Robinhood has none; paper mode is entirely local.
- Exchange-side stop orders (v1 of this module reconciles only orders it placed itself; resting stops would be unreconciled exposure). Listed under open questions.
- Any new npm dependency. Signing uses `node:crypto` only.

## 3. Credentials

Robinhood API keys are created by the user at `https://robinhood.com/account/crypto` (desktop web, classic view). The flow the doc and HUD describe:

1. Generate an Ed25519 key pair locally. The app offers a CLI helper only, never a HUD button, so the private seed never transits HTTP or the DOM: `node -e "import('./src/robinhoodSigner.js').then(m=>console.log(JSON.stringify(m.generateRobinhoodKeyPair(),null,2)))"` prints `{privateKeyBase64, publicKeyBase64}` once.
2. Paste the **public** key into the Robinhood portal, choose scopes. Read scopes (accounts, trading pairs, holdings, best bid/ask, estimated price, orders read) are enough for quotes, the tape and paper mode. Real orders additionally need "Place crypto orders with fee tiers" (v2 orders scope).
3. Robinhood returns an API key `rh-api-<uuid>`. Paste API key and the base64 32-byte private seed into the HUD credentials inset (private key field is `type=password`) or set `ROBINHOOD_API_KEY` / `ROBINHOOD_PRIVATE_KEY` in the user `.env`.
4. The app writes both to `USER_ROOT/.env` (mode 0600, same `rewriteEnv` idiom as `src/polymarketUS.js`), disarms the session, and readiness shows the derived public key so the user can verify it matches the portal. The secret is never rendered back and never logged.

Key format: the seed is the 32-byte base64 value the docs example script prints. A 64-byte value (seed||public key) is rejected with the hint "you pasted seed||publicKey; keep the first 32 bytes" (the map's verified snippet rejects 64-byte inputs; silently truncating would sign with an unverified key). Any other length is rejected with code `badKey` (a local configuration error, deliberately distinct from the server-side `keyNotFound`).

## 4. Transport and signing

Files: `src/robinhoodErrors.js` (dependency-free error class + code list), `src/robinhoodSigner.js` (pure crypto), `src/robinhoodTransport.js` (env creds, fetch, classification, typed endpoint wrappers).

Signing (verified against the docs vector in the signer test, which is the only place the docs example seed appears):

- Message = `apiKey + timestamp + path + METHOD + body` where `timestamp` is unix **seconds** (30 s server window), `path` includes the query string and trailing slash, `METHOD` is uppercased, `body` is the exact `JSON.stringify(json)` string sent (`''` for GET and for cancel).
- Key: PKCS#8 DER = `302e020100300506032b657004220420` + seed; public key = last 32 bytes of the SPKI DER.
- Headers: `x-api-key`, `x-timestamp` (string), `x-signature` (base64 of the raw Ed25519 signature), plus `content-type: application/json`, `accept: application/json`, `user-agent: MoneyPrinterOS/<version>`.
- `JSON.stringify` runs exactly once per request; the signed bytes are the sent bytes.

Transport rules:

- Base URL `process.env.ROBINHOOD_API || 'https://trading.robinhood.com'`. Every request uses `AbortSignal.timeout(timeoutMs)` (default 15000).
- Client token bucket: capacity 60, refill 1/s (well under the published 100/min). A request with no token throws `rateLimited` locally without touching the network, so a tick can never pile up. On HTTP 429: `backoffUntil = now + min(60000, 2000 * 2^consecutive429)`; any request while `now < backoffUntil` throws `rateLimited` locally.
- Clock: `lastDateHeaderSec` is recorded from the `date` header of **every** response (2xx included) so readiness can show `clockSkewSec` before any 401. On a 401, if `retryOn401` and no retry has happened yet: recompute `skewSec = serverSec - localSec` from that response's `date` header; if `|skewSec| >= 5`, retry exactly once with the corrected timestamp. The retry reuses the identical body bytes and the same `client_order_id`, is attempted only after `sent:true` has been recorded on the error context, and is never applied when the first response was any non-401 status. A second 401 classifies as `keyNotFound`. A missing `date` header leaves `keyNotFound` as the operator-facing code and the doc says "check system time".
- Classification: 400 with `type:'validation_error'` -> `validation`; 401 -> `keyNotFound` (after the skew retry); 403 -> `notPermitted`; 404 -> `http` (wrappers use it for v1 fallback); 429 -> `rateLimited`; 5xx -> `http`; fetch/abort/timeout -> `network` (with `sent:true` when the socket was opened). Error message = `${type}: ${errors.map(e=>e.detail).join('; ')}`.slice(0,240); headers and bodies are never included in thrown messages.
- Every outcome is remembered in `lastAuth` (`{error, code, at}`) for readiness, like `polymarketUS.js:19-33`.
- No network at import. Credentials are read from `process.env` on every call, never cached; the `KeyObject` is memoised on `sha256(seed)`.

Endpoint wrappers (v2 first; v1 fallback on 404/`notPermitted` only where noted):

| Wrapper | Endpoint | Notes |
|---|---|---|
| `fetchAccount()` | `GET /api/v2/crypto/trading/accounts/` -> `results.find(is_api_tradable) || results[0]`; v1 `GET /api/v1/crypto/trading/accounts/` fallback | returns `{accountNumber, status, buyingPowerUsd, feeRatio|null, apiVersion}`; v1 has no fee fields |
| `fetchTradingPairs(symbols)` | `GET /api/v2/crypto/trading/trading_pairs/?symbol=..&symbol=..`; v1 fallback | Map symbol -> `{assetCode, assetIncrement, quoteIncrement, minOrderAmountUsd|null, maxOrderSize, status, isApiTradable}` |
| `fetchHoldings(accountNumber, assetCodes)` | `GET /api/v2/crypto/trading/holdings/?account_number=..&asset_code=..` | |
| `fetchBestBidAsk(symbols)` | `GET /api/v2/crypto/marketdata/best_bid_ask/?symbol=..` one call for all symbols; v1 fallback maps `bid_inclusive_of_sell_spread` / `ask_inclusive_of_buy_spread` | `[{symbol, bid, ask, at, source:'v2'|'v1'}]` |
| `fetchEstimatedPrice(symbol, side, quantities)` | `GET /api/v2/crypto/marketdata/estimated_price/?symbol=&side=&quantity=0.1,1` (commas unencoded, max 10) | `[{symbol, side, quantity, bid, ask, feeRatio|null, estFee|null, estTotalCost|null, estTotalCredit|null, at}]` |
| `listOrders(accountNumber, filters)` | `GET /api/v2/crypto/trading/orders/?account_number=&state=&symbol=&created_at_start=` paginated via `next` (base URL stripped, re-signed, max 5 pages) | `NormalizedOrder[]` |
| `getOrder(accountNumber, id)` | `GET /api/v2/crypto/trading/orders/{id}/?account_number=`; on 404/405 falls back to `listOrders` + id match (map open question) | `NormalizedOrder|null` |
| `placeOrder(accountNumber, body)` | `POST /api/v2/crypto/trading/orders/?account_number=` (v1 path only when `ROBINHOOD_ORDER_API=v1`, in which case `time_in_force` is omitted) | body serialised once |
| `cancelOrder(accountNumber, id)` | `POST /api/v2/crypto/trading/orders/{id}/cancel/` with empty body | `{submitted:true, order|null}` |

`normalizeOrder(raw)` -> `{id, clientOrderId, symbol, side, type, state:'open'|'pending'|'partially_filled'|'filled'|'canceled'|'failed', averagePrice|null, filledQty, feeCharged|null, executions:[{price, qty, at}], createdAt, updatedAt}` (quantities parsed from decimal strings; `raw` dropped). The response shapes are derived from the embedded OpenAPI schema and community clients, not observed live; the first real request must be a read (`accounts`) under a read-only key, and section 18 records this as unverified until then.

## 5. Data files and shapes

Two files, deliberately:

- `data/robinhood-auto-trader.json` — real exposure and real autopilot. Fail-closed: any non-ENOENT load error sets `recoveryRequired:true`, `recoveryError:'STATE RECOVERY REQUIRED: ...'`, forces `autopilot.enabled:false`, and every real mutation throws `stateRecovery`. Read by `desktop/release-gate.cjs` and `Install-Windows.ps1` on every update attempt, so it stays small and never carries the tape.
- `data/robinhood-paper.json` — paper book, price tape, paper autopilot, qualification. Corrupt -> `{...defaults, cashUsd:0, recoveryRequired:true, autopilot.enabled:false, qualification.qualified:false}`; this revokes qualification (and therefore real autopilot on its next pass) without putting the money file into recovery.

Why: paper-reset must be physically unable to rewrite real entries (different file, different save function); the tape is written every 30 s while the money file is written rarely; the names mirror `polymarket-paper.json` / `polymarket-us-combos.json`. Both saves are atomic (`.<name>.<pid>.<t36><rand>.tmp` + `rename`, tmp removed on failure). `sessionArmed` is never written to either file (the Windows installer refuses updates on a persisted `sessionArmed`).

Real journal (`version:1`):

```json
{
  "version": 1,
  "open": [ "<Entry>" ],
  "history": [ "<Entry> newest first, cap 200" ],
  "stats": { "placed": 0, "closed": 0, "won": 0, "lost": 0, "pnlUsd": 0, "feesUsd": 0, "hitRate": null, "profitFactor": null, "unverified": 0 },
  "autopilot": { "enabled": false, "orderUsd": 10, "maxOpen": 2, "dailyLossCapUsd": 25, "symbols": ["BTC-USD","ETH-USD"], "orderType": "market",
                 "lastRunAt": 0, "lastAction": null, "skipped": [], "disabledReason": null, "disabledAt": 0, "enabledAt": 0, "paramsHash": null },
  "cooldowns": { "BTC-USD": 0 },
  "account": { "accountNumber": null, "feeRatio": null, "buyingPowerUsd": null, "apiVersion": null, "at": 0 },
  "lastReconcileAt": 0,
  "lastError": null
}
```

Entry:

```json
{
  "id": "rh-<t36><rand4>", "kind": "real", "symbol": "BTC-USD", "side": "buy",
  "status": "PENDING_SUBMIT", "placedBy": "manual|autopilot",
  "clientOrderId": "<uuid v4, persisted before send>", "orderId": null,
  "orderType": "market|limit", "limitPrice": null, "timeInForce": "gtc",
  "requestedQty": 0.000153, "requestedUsd": 10, "refAsk": 65010.2, "refBid": 64990.5, "refAt": 0, "previewFeeUsd": 0.085,
  "fillVerified": false, "filledQty": 0, "avgPrice": null, "feeUsd": 0, "costUsd": null,
  "exit": null,
  "stopPct": 0.0185, "takePct": 0.074, "trailArmPct": 0.037, "trailPct": 0.0185, "peakBid": null, "trailStop": null,
  "markBid": null, "unrealizedUsd": null, "pnlUsd": null,
  "submittedAt": null, "openedAt": null, "closedAt": null, "at": 0,
  "reconcile": { "attempts": 0, "successfulListings": 0, "firstListingAt": 0, "lastAt": 0 },
  "paramsHash": null,
  "notes": [ { "at": 0, "text": "<=160 chars, never secrets" } ]
}
```

`exit` when closing: `{reason:'stop|take|trail|time|fade|manual|cancel', clientOrderId, orderId:null, orderType:'market', requestedAt, filledQty:0, avgPrice:null, feeUsd:0, proceedsUsd:null}`.

Statuses: open-side `PENDING_SUBMIT | SUBMITTED | SUBMITTED_UNCERTAIN | OPEN | CLOSING | CLOSING_UNCERTAIN`; terminal (history only) `CLOSED | CANCELLED | REJECTED | FAILED | FORGOTTEN`. Allowed transitions: `PENDING_SUBMIT -> SUBMITTED | SUBMITTED_UNCERTAIN | REJECTED | FAILED`; `SUBMITTED | SUBMITTED_UNCERTAIN -> OPEN | CANCELLED | FAILED | SUBMITTED`; `OPEN -> CLOSING`; `CLOSING -> CLOSING_UNCERTAIN | OPEN | CLOSED`; `CLOSING_UNCERTAIN -> CLOSED | OPEN | CLOSING`; any non-terminal `-> FORGOTTEN` (operator only). `CLOSED` requires `fillVerified && exit.filledQty > 0`. Terminal transitions move the row to `history[]` (unshift, cap 200); `open.length + history.length` never changes across reconcile. Illegal transitions throw code `unknown`.

Paper file (`version:1`):

```json
{
  "version": 1, "createdAt": 0, "cashUsd": 1000, "startUsd": 1000, "feeRatio": 0.0085,
  "positions": [ "<PaperPosition>" ], "history": [ "<PaperPosition> newest first, cap 500" ],
  "autopilot": { "enabled": false, "orderUsd": 25, "maxOpen": 3, "symbols": ["BTC-USD","ETH-USD"], "lastRunAt": 0, "lastAction": null, "skipped": [] },
  "params": { "...STRATEGY_DEFAULTS": true }, "paramsHash": "ab12cd34ef56",
  "cooldowns": {},
  "tape": { "BTC-USD": { "intervalMs": 15000, "quoteSource": "v2", "samples": [[1790000000000, 64990.5, 65010.2]] } },
  "tapeAt": 0,
  "stats": { "closes": 0, "won": 0, "lost": 0, "pnlUsd": 0, "grossWinUsd": 0, "grossLossUsd": 0, "feesUsd": 0, "hitRate": null, "profitFactor": null, "maxDrawdownUsd": 0 },
  "qualification": { "qualified": false, "paramsHash": "ab12cd34ef56", "closes": 0, "hitRate": null, "profitFactor": null, "pnlUsd": 0, "grossPnlUsd": 0, "feesUsd": 0, "feeDragPct": null, "maxDrawdownUsd": 0, "requiredHitRate": null, "lastCloseAt": null, "windowDays": 30, "reasons": ["closes 0 < 20"], "at": 0 }
}
```

`PaperPosition`: `{id:'rp-...', symbol, status:'OPEN'|'CLOSED', placedBy:'manual'|'paper-autopilot', qty, entryAsk, fillPrice, feeUsd, costUsd, at, stopPct, takePct, trailArmPct, trailPct, peakBid, trailStop, maxFavorablePct, maxAdversePct, paramsHash, quoteSource:'v2'|'v1'|'estimate', exit:null|{reason, bid, fillPrice, feeUsd, proceedsUsd, at, source:'model'|'estimate'}, pnlUsd:null|number, closedBy:null|'strategy'|'manual', closedAt:null|number}`.

Tape rows are `[t, bid, ask]` numbers, ring buffer of 720 samples per symbol (3 h at 15 s), deduped on `t`, ascending; the paper file is flushed at most every 30 s (`TAPE_FLUSH_MS`) or immediately on any paper trade or autopilot change.

## 6. Paper mode and price tape

- Quotes need credentials (read scope). Without keys, paper order/autopilot refuse with `noCredentials` and the message "Paper needs read-only API keys for live quotes".
- Sampling: one batched `best_bid_ask` call per tick for the union of paper and real symbols, appended to the tape. Sampling happens only when `needsQuotes()` is true: paper autopilot enabled, real autopilot enabled, any real `open[]` row, or any paper position. Enabling paper autopilot therefore starts the tape; the HUD shows "warming up n/120" until the first signal can fire (30 minutes at 15 s).
- Fee ratio for paper fills: account `fee_ratio` (v2) -> last `estimated_price.fee_ratio` -> `ROBINHOOD_FEE_RATIO_FALLBACK` (default 0.0085). Refreshed from the account every 10 minutes.
- Fill model (pure, `src/robinhoodStrategy.js`): when a v2 `estimated_price` result for the same symbol/side/quantity is <= 15 s old, buy cost = `estTotalCost`, sell proceeds = `estTotalCredit` (`source:'estimate'`). Otherwise buy fills at `ask * (1 + halfSpread + slipBps/1e4)` and sell at `bid * (1 - halfSpread - slipBps/1e4)` with `halfSpread = (ask - bid) / (2 * mid)`, fee = `qty * fillPrice * feeRatio`. Paper P/L is always net of both fees. Each position tracks `maxFavorablePct` / `maxAdversePct`.
- Manual paper orders (`paper-order`) fetch a fresh quote directly and are tagged `placedBy:'manual'`; they never count toward qualification. `paper-close` sells at the current bid, `closedBy:'manual'`.
- `paper-reset` starts a new book (cash clamped 50..100000), keeps the tape and autopilot settings, appends nothing to history, resets `qualification` to unqualified and, if real autopilot is enabled, disables it with `disabledReason:'paperReset'`.
- Paper autopilot needs no confirmation. `orderUsd` clamps to `[1, 5 * limits.maxOrderUsd]` (paper may be larger for statistics), `maxOpen` `[1, 10]`, symbols to `/^[A-Z0-9]{2,10}-USD$/` max 6. A `params` patch goes through `normalizeParams`; a changed `paramsHash` resets `qualification` (history kept, tagged by the old hash).

## 7. Strategy (deterministic rules)

Edge hypothesis, stated honestly: at the base fee tier a round trip costs `C = 2 * feeRatio + spread + 2 * slipBps/1e4` (about 1.85% at 0.85% per side). No scalping survives that. The only regime with plausible positive expectancy for a small long-only strategy on the majors is volatility clustering plus breakout continuation, so the strategy trades nothing unless the tape's realised-volatility expected move over the hold horizon is at least `costMultiple * C`, takes only Donchian breakouts confirmed by EMA alignment and a tight spread, and uses an asymmetric payoff so the break-even hit rate is 40%. In calm markets the HUD says `WAIT · expected move 0.9% < 1.5x cost 2.8%`. Nothing in this document claims the strategy is profitable; the paper qualification exists to find out.

`STRATEGY_DEFAULTS` (`src/robinhoodStrategy.js`, pure, no I/O):

```
sampleMs:15000, warmupSamples:120, lookbackSamples:90, volWindow:60, horizonSamples:960,
emaFast:12, emaSlow:48, emaSlopeSamples:6, costMultiple:1.5, breakoutBufferPct:0.0005,
maxSpreadBps:40, takeMult:4, stopMult:1, trailArmMult:2, trailMult:1,
maxHoldMin:240, fadeExit:true, cooldownWinMin:5, cooldownLossMin:30, maxGapRatio:0.1, slipBps:5, minSamples:120
```

`normalizeParams(p)` clamps every number into a sane range and drops unknown keys; `paramsHash(p)` = first 12 hex of sha256 of the canonical JSON of `normalizeParams(p)`.

Features (`computeFeatures(samples, params, now)` over ascending `[{t,bid,ask,mid}]`): `{ok:false, reason:'warmup'}` when `n < warmupSamples`; `'stale'` when `now - tLast > 3 * sampleMs`; `'gaps'` when more than `maxGapRatio` of the lookback intervals exceed `2 * sampleMs`. Otherwise `mid`, `bid`, `ask`, `spreadPct`, `spreadBps`, `sigma1 = stdev(ln(mid_i/mid_{i-1}))` over `volWindow`, `expectedMovePct = sigma1 * sqrt(horizonSamples)`, `donchianHigh/Low` over `lookbackSamples` excluding the current sample, `emaFast`, `emaSlow`, `emaSlowPrev` (evaluated `emaSlopeSamples` earlier).

Entry (`entrySignal(features, {costPct, params})`, checked in this order, first failing reason wins): `!features.ok -> features.reason`; `spreadBps > maxSpreadBps -> 'spread'`; `expectedMovePct < costMultiple * costPct -> 'lowVol'`; `mid <= donchianHigh * (1 + breakoutBufferPct) -> 'noBreakout'`; `!(emaFast > emaSlow && emaSlow > emaSlowPrev) -> 'noTrend'`; else `enter:true, reason:'breakout'` with `takePct = max(takeMult * C, expectedMovePct)`, `stopPct = max(stopMult * C, 0.5 * expectedMovePct)`, `trailArmPct = trailArmMult * C`, `trailPct = trailMult * C`. `requiredHitRate = (stopPct + C) / (takePct + stopPct)` (0.4 for the defaults).

Sizing (`sizeOrder`): `usd = min(orderUsd, maxOrderUsd)`; `qty = floor((usd / (1 + feeRatio)) / ask / assetIncrement) * assetIncrement` formatted with `formatIncrement` (never exponent notation); fails with `minOrder` (notional below `minOrderAmountUsd` or `qty < assetIncrement`), `increment`, `aboveMax` (clamped to `maxOrderSize`), `orderCap` (cost > maxOrderUsd), `buyingPower` (cost > 0.95 * buyingPowerUsd).

Exit (`exitSignal(position, {bid, features, now, feeRatio, params})`, evaluated on bid, priority stop > take > trail > time > fade): stop `bid <= fill * (1 - stopPct)`; take `bid >= fill * (1 + takePct)`; trail arms once `bid >= fill * (1 + trailArmPct)`, then `trailStop = max(trailStop, peakBid * (1 - trailPct))`, exits when `bid <= trailStop` (never decreases); time `now - openedAt >= maxHoldMin * 60000`; fade `fadeExit && features.ok && emaFast < emaSlow && bid * (1 - feeRatio) >= fill * (1 + feeRatio)` (exit flat-or-better once momentum is gone).

One strategy pass (identical for paper and real; only the executor differs; deterministic candidate order = highest `expectedMovePct / costPct` first, ties by symbol):

```
for symbol in ap.symbols ∩ tradablePairs:
  f = computeFeatures(tapeFor(symbol)); C = roundTripCost(feeRatio, f.spreadPct)
  for pos in executor.positions(symbol): x = exitSignal(pos, {bid:f.bid, features:f, now}); if x.exit: executor.close(pos, x.reason)
  if executor.openCount() >= min(ap.maxOpen, limits.maxOpen): skip('openCap'); continue
  if executor.positions(symbol).length: skip('duplicate'); continue
  if inCooldown(symbol): skip('cooldown'); continue
  if executor.realizedToday() <= -abs(ap.dailyLossCapUsd): skip('dailyLossCap'); break
  sig = entrySignal(f, {costPct:C}); if !sig.enter: skip(sig.reason); continue
  size = sizeOrder({orderUsd:min(ap.orderUsd, limits.maxOrderUsd), ask:f.ask, pair, buyingPowerUsd, feeRatio, maxOrderUsd:limits.maxOrderUsd})
  if !size.ok: skip(size.reason); continue
  executor.open(symbol, size, sig, f)
```

Cooldown after any close `cooldownWinMin`, after a loss `cooldownLossMin`. Long-only, one position per symbol per executor. Tick = `ROBINHOOD_TICK_MS` (15000, min 5000).

## 8. Real-money gates (ordered)

Every real mutation runs this chain server-side before any signed request. Tests assert that no request carrying `x-api-key` leaves the process while a gate fails.

1. `loadJournal().recoveryRequired` -> `stateRecovery`
2. `!credentialsReady` -> `noCredentials`
3. `String(process.env.ROBINHOOD_REAL_ENABLED || 'false').toLowerCase() !== 'true'` -> `realDisabled` (re-read every call; arming itself is refused with this code)
4. `!sessionArmed` -> `notArmed` (module-level `let`, never persisted, reset by `configureRobinhood`)
5. `confirmation !== CONFIRM_*` (strict `===`) -> `confirmation`
6. `limits = robinhoodLimits()` re-read from env: `costUsd > maxOrderUsd` -> `orderCap`; `open.length >= maxOpen` (buys) -> `openCap`; `realizedTodayUsd <= -dailyLossCapUsd` -> `dailyLossCap`
7. `inCooldown(symbol)` -> `cooldown` (manual may pass `overrideCooldown:true`, autopilot never); another open buy for the symbol -> `duplicate`; `placeBusy` -> `busy`
8. Fresh read-only preview: pair `isApiTradable`, account buying power, `estimated_price`; `|ask - refAsk| / refAsk > priceTolerance` against the entry's own preview taken <= 30 s ago -> `priceTolerance`; `buyingPower < cost` -> `buyingPower`; sizing failures -> `minOrder` / `increment` / `notTradable`
9. Journal write: entry `PENDING_SUBMIT` with `clientOrderId` persisted (`saveJournal`) — the durable idempotency record
10. Only now: the signed `placeOrder`

Real autopilot adds before step 5 (it supplies `CONFIRM_PLACE` internally, and the gate still executes): `ap.enabled`, `!apBusy`, `evaluateQualification(paper).qualified` (else self-disable with `qualificationLost`), `ap.paramsHash === paper.paramsHash`, `now >= backoffUntil`.

Cancel and cancel-all require credentials plus the typed phrase only (house pattern `polymarketUS.js:145-146`), not arm, so an operator can always cancel a resting real order after a restart. Forget requires the phrase only and no network. Preview requires credentials only.

Constants (literal in `src/robinhoodAutoTrader.js`, pinned by `tests/visual-contract.test.mjs` in the integration package): `CONFIRM_PLACE='PLACE REAL CRYPTO ORDER'`, `CONFIRM_CANCEL='CANCEL REAL CRYPTO ORDER'`, `CONFIRM_CANCEL_ALL='CANCEL REAL CRYPTO ORDERS'`, `CONFIRM_AUTOPILOT='ENABLE REAL CRYPTO AUTOPILOT'`, `CONFIRM_FORGET='FORGET'`; the source contains the literal `confirmation!=='FORGET'`.

Real order flow:

- Preview returns the sizing, `estimated_price` fee/total, the round-trip cost and a gate dry-run `gates:{stateRecovery, credentials, realEnabled, armed, orderCap, openCap, dailyLossCap, cooldown, duplicate, qualified}` with `wouldPass`, so the HUD can explain a disabled Place button without a failed POST. Cached per symbol/side/qty for 10 s. No journal write.
- Place: default `orderType:'market'` (`market_order_config:{asset_quantity}`; fee_ratio is the same for market and limit, and market removes the partial-fill/cancel branches). `orderType:'limit'` is an explicit option: `limit_order_config:{asset_quantity, limit_price: ceilIncrement(ask * (1 + min(priceTolerance, 0.002)), quoteIncrement), time_in_force:'gtc'}`; resting limit buys older than `ENTRY_TTL_MS` (90 s) are cancelled by reconcile and the entry stays `SUBMITTED` until the cancel is verified. Market fills whose `avgPrice` deviates from `refAsk` by more than `priceTolerance` are noted and set a loss cooldown (the fill cannot be undone; the note makes adverse routing visible).
- Outcome after the POST: 2xx -> `SUBMITTED {orderId, submittedAt}` then `applyOrderState` immediately (market orders often return `filled`). Any 4xx (400 validation, 401, 403, 429 from the server) -> `REJECTED` in history with the reason (a rejected request creates no order, so it is never open exposure); 401/403 also record `lastAuth` and disable real autopilot. `network`/timeout with `sent:true` -> `SUBMITTED_UNCERTAIN` and never resent; with `sent:false` -> `REJECTED('never sent')`.
- Sell (manual close or autopilot exit): entry must be `OPEN` with `fillVerified`; `qty = filledQty`; `entry.exit = {clientOrderId, reason, requestedAt, ...}` persisted before the POST; status `CLOSING`; same outcome mapping (`CLOSING_UNCERTAIN` on uncertain send; on a 4xx the exit is cleared, status returns to `OPEN`, and the failure is noted).

## 9. Autopilot and qualification

Qualification (`evaluateQualification(paper, now, thresholds, limits)`) counts only paper history rows with `placedBy === 'paper-autopilot' && closedBy === 'strategy' && paramsHash === paper.paramsHash && closedAt >= now - windowDays * 864e5`. Manual paper trades and closes never count, and a parameter change resets the count. Thresholds from env (`qualificationThresholds()`): `minCloses` 20, `minHitRate` 0.45, `minProfitFactor` 1.3, `windowDays` 30. Reasons appended: `closes n < minCloses`, `hitRate < minHitRate`, `profitFactor < minProfitFactor` (gross wins / gross losses, both net of fees; `Infinity` when no losses and wins > 0), `pnlUsd <= 0`, `maxDrawdownUsd > limits.dailyLossCapUsd`, `stale` when `lastCloseAt` is older than 72 h, `paperRecovery` when the paper file is in recovery. `qualified = reasons.length === 0`. The object also carries `grossPnlUsd`, `feesUsd`, `feeDragPct = feesUsd / max(1, grossPnlUsd)` and `requiredHitRate` (median of the closes' `(stop + C)/(take + stop)`) so the HUD shows required versus actual.

Paper autopilot: `setRobinhoodPaperAutopilot(patch)`, no confirmation, runs the strategy pass with the paper executor every tick.

Real autopilot (`setRobinhoodAutopilot(patch)`): turning on requires `patch.confirmation === CONFIRM_AUTOPILOT`, the gate chain through `notArmed`, and `qualified === true` (else `notQualified` with the reasons in the error); it stamps `ap.paramsHash = paper.paramsHash` and `enabledAt`. Clamps: `orderUsd [1, limits.maxOrderUsd]`, `maxOpen [1, limits.maxOpen]`, `dailyLossCapUsd [1, limits.dailyLossCapUsd]`, `orderType in {market, limit}`, symbols to the validated pattern max 6. Env values are ceilings re-applied on every pass, not only at save. Turning off never needs confirmation.

`runRobinhoodAutopilotOnce()` (`apBusy` lock): disabled -> `{ran:false, reason:'disabled'}`; not ready (credentials/realEnabled/armed) -> `{ran:false, reason:'notArmed'}` (stays enabled; arming is per session); `recoveryRequired` -> `{ran:false, reason:'stateRecovery', disabled:true}`; qualification lost or `paramsHash` drifted -> disable + persist `qualificationLost`; then `refreshFeed`, `reconcileRobinhood({force:true})`, the exit pass on every verified open real entry, and **the daily loss cap check**: when `realizedTodayUsd <= -min(ap.dailyLossCapUsd, limits.dailyLossCapUsd)` the real autopilot **disables itself** (`ap.enabled=false, disabledReason='dailyLossCap', disabledAt`, persisted) and returns `{ran:true, reason:'dailyLossCap', disabled:true}`; it does not merely skip entries, and the operator re-enables it with the phrase after review. Only then the entry pass with the real executor (open -> `placeRobinhoodOrder({placedBy:'autopilot', confirmation:CONFIRM_PLACE})`; close -> market sell with the persisted exit `clientOrderId`, same internal confirmation). Errors: `keyNotFound`/`notPermitted` -> `ap.enabled=false, disabledReason=code, disabledAt`, persisted, `{ran:false, reason:code, disabled:true}`; `rateLimited` -> skip until backoff; others noted in `skipped` (last 8) and `lastError`.

Parameter changes: `setRobinhoodPaperAutopilot({params})` recomputes `paper.paramsHash`; when the hash actually changes while real autopilot is enabled it is disabled immediately with `disabledReason:'paramsChanged'` (persisted), not at the next pass. This covers manual edits in the HUD and evolution APPLY / autopromote (section 22). A paper reset while real autopilot is enabled disables it with `disabledReason:'paperReset'`.

Loop (`startRobinhoodLoops()`): `if (loopTimer || !AUTOSTART()) return; loopTimer = setInterval(() => tick().catch(() => {}), TICK_MS); loopTimer.unref?.()` where `AUTOSTART = () => String(process.env.ROBINHOOD_AUTOSTART ?? process.env.POLYMARKET_AUTOSTART ?? 'true').toLowerCase() !== 'false'` (the existing suites and the collector child that set `POLYMARKET_AUTOSTART='false'` stay inert). `tick()`: return unless `needsQuotes() && credentialsReady`; one batched `best_bid_ask`; `appendTape`; account refresh every 10 min; `reconcileRobinhood()` when `open.length`; paper pass; real pass; tape flush when due. Every stage is try/caught into `lastError = {at, stage, code, message}`. `stopRobinhoodLoops()` clears the timer and flushes the tape. No network at import; an idle tick makes no request.

## 10. Reconcile and P/L rules

`reconcileRobinhood({force})` (`reconcileBusy` lock, 5 s throttle unless forced) walks `open[]`:

- `PENDING_SUBMIT`, `SUBMITTED_UNCERTAIN`, and `SUBMITTED` without `orderId`: `listOrders({symbol, created_at_start: entry.at - 60 s})` matched on `client_order_id`. Found -> adopt `orderId`, status `SUBMITTED`, then apply the order state. Not found -> stay, increment `reconcile.successfulListings` (only on a successful listing; auth/network errors never count and never transition), note, `lastError`. The row moves to history as `FAILED('never received')` only when `successfulListings >= 3` and `now - entry.at >= 10 min` and the row is still unmatched; a never-received order cannot fill later, so this bounded rule stops an unreceived order holding the updater until a manual FORGET while never dropping a live one on a lagging listing.
- `SUBMITTED` with `orderId`: `getOrder` -> `applyOrderState`: `filled`, or `canceled|failed` with `filledQty > 0` (partial) -> `OPEN {fillVerified:true, filledQty, avgPrice (average_price or execution VWAP), feeUsd (fee_charged ?? filledQty*avgPrice*feeRatio), costUsd = filledQty*avgPrice + feeUsd, openedAt, stopPct/takePct/... from the entry's signal}`; `canceled|failed` with zero fill -> `CANCELLED|FAILED` (history, no P/L); `open|pending|partially_filled` -> stay `SUBMITTED` (limit buys older than `ENTRY_TTL_MS` get `cancelOrder`; status still changes only when the cancel is verified).
- `CLOSING` / `CLOSING_UNCERTAIN`: verify the exit order (by id, else by `exit.clientOrderId` in `listOrders`). `filled` -> `proceedsUsd = exit.filledQty * exit.avgPrice - exit.feeUsd`, `pnlUsd = proceedsUsd - costUsd`, `CLOSED`, `closedAt`, `setCooldown`. `canceled|failed` with zero fill -> back to `OPEN`, `exit = null`, note. Partial -> book a `CLOSED` history row for the filled part and keep the remainder `OPEN` with reduced `filledQty`/`costUsd` (split), then resubmit the remainder as a new exit with a new `exit.clientOrderId` on the next autopilot pass.
- `OPEN`: mark-to-market from the latest quote (`markBid`, `unrealizedUsd = filledQty * markBid * (1 - feeRatio) - costUsd`, `peakBid`).
- `keyNotFound`/`notPermitted` anywhere: record `lastError`, disable real autopilot, change no row. Invariant asserted after every pass: `open.length + history.length` unchanged (the partial-sell split is the one documented exception: it adds exactly one history row and is asserted separately).

P/L rules: realized P/L is written only on a verified sell fill; unrealized is display-only; `recomputeStats` counts only `CLOSED` history rows with `fillVerified && exit.filledQty > 0`; `realizedTodayUsd` sums `pnlUsd` of history rows with `closedAt >= local startOfDay`. `FORGOTTEN` rows carry `pnlUsd:null`, set no cooldown, and are refused for `OPEN` verified rows unless `acknowledgeHolding:true` (the coin still sits in the account; the HUD prompt says so).

## 11. HTTP routes

All under `/api/robinhood` in `src/dashboard.js`. GETs go inside the GET block beside the `/api/polymarket-us/combos` line, before `if (req.method !== 'POST')`. The POST prefix block `if (u.pathname.startsWith('/api/robinhood/'))` is copied from the combos block and inserted immediately after it and before `/api/update/check` (`const mint`); the body is parsed once, `rhFail = e => json(res, {ok:false, error:String(e.message||e), code:e.code||'unknown'}, 400)`, trailing `404 not found`. Loop start `try { startRobinhoodLoops(); } catch { /* optional venue */ }` directly after `startUSComboLoops()`.

| Method | Path | Body | 200 | Error codes |
|---|---|---|---|---|
| GET | `/api/robinhood` | — | Snapshot (never errors; `lastError` inside) | — |
| GET | `/api/robinhood/readiness` | — | Readiness | — |
| POST | `/api/robinhood/config` | `{apiKey, privateKey, realEnabled?}` | `{ok, readiness}` | `badKey`, `validation` |
| POST | `/api/robinhood/arm` | `{armed}` | `{ok, readiness}` | `stateRecovery`, `noCredentials`, `realDisabled` |
| POST | `/api/robinhood/preview` | `{symbol, side?, usd?|qty?, orderType?, entryId?}` | `{ok, preview}` | `noCredentials`, `notTradable`, `minOrder`, `increment`, transport codes |
| POST | `/api/robinhood/order` | `{symbol, side?, usd?|qty?, orderType?, entryId?, confirmation, overrideCooldown?}` | `{ok, entry, journal:{open, unverified}}` | gate codes (section 8), `busy`, `validation`, `keyNotFound`, `notPermitted`, `rateLimited`, `network`, `uncertain` (entry kept) |
| POST | `/api/robinhood/cancel` | `{entryId, confirmation}` | `{ok, entry}` | `confirmation`, `noCredentials`, `notCancellable` |
| POST | `/api/robinhood/cancel-all` | `{confirmation}` | `{ok, cancelled:[ids], errors:[{entryId, error}]}` | `confirmation`, `noCredentials` |
| POST | `/api/robinhood/forget` | `{entryId, confirmation, acknowledgeHolding?}` | `{ok, entry}` | `confirmation`, `notFound`, `holding` |
| POST | `/api/robinhood/reconcile` | `{}` | `{ok, ran, checked, changed, lastReconcileAt, errors}` | `noCredentials` |
| POST | `/api/robinhood/autopilot` | `{enabled?, confirmation?, orderUsd?, maxOpen?, dailyLossCapUsd?, symbols?, orderType?}` | `{ok, autopilot}` (real) | `confirmation`, `stateRecovery`, `noCredentials`, `realDisabled`, `notArmed`, `notQualified` |
| POST | `/api/robinhood/autopilot/run` | `{}` | `{ok, ran, reason?, ...}` | never 4xx; 500 only on an unexpected throw |
| POST | `/api/robinhood/paper-order` | `{symbol, usd}` | `{ok, position, paper}` | `noCredentials`, `paperRecovery`, `minOrder`, `increment`, `paperCash`, `openCap`, `duplicate` |
| POST | `/api/robinhood/paper-close` | `{id}` | `{ok, position, paper}` | `notFound`, `noCredentials` |
| POST | `/api/robinhood/paper-reset` | `{amountUsd?}` | `{ok, paper}` | — |
| POST | `/api/robinhood/paper-autopilot` | `{enabled?, orderUsd?, maxOpen?, symbols?, params?}` | `{ok, autopilot, paramsHash}` | `paperRecovery` |
| POST | `/api/robinhood/paper-autopilot/run` | `{}` | `{ok, result:{ran, changed, open, skipped}}` | never 4xx |
| GET | `/api/robinhood/evolve` | — | Evolve view (section 22) | — |
| POST | `/api/robinhood/evolve/run` | `{}` | `{ok, result:{ran, generation, evaluated, incumbentScore, bestScore, gainPct, beats, proposed, promoted}}` or `{ran:false, reason:'insufficientTape'|'busy'|'paperRecovery'}` | never 4xx |
| POST | `/api/robinhood/evolve/apply` | `{paramsHash}` | `{ok, result:{applied, paramsHash, autopilot, realAutopilot}}` (paper only) | `notFound`, `validation`, `busy`, `paperRecovery` |

Bad or oversized bodies (32 KB cap from `body()`) return 400 `{ok:false, error}`; unknown sub-paths 404; the outer catch 500.

## 12. HUD

`public/dashboard.html`, standalone HOST window following the critic's recipe:

- `APPS`: append `['robinhood','Robinhood Auto Trader','RH','dark']` (no host -> HOST window; Start menu lists it). `defaultLayout.robinhood = {x:200, y:90, w:880, h:620}`. Not in `DEFAULT_OPEN`, `ICON_PNG` or `TAB_LABEL`; `'robinhood'` appended to `DESKTOP_ICONS` (glyph fallback, no PNG, so the visual-assets test is untouched). `LAYOUT_VERSION` unchanged.
- State beside line 31: `let robinhoodState = {readiness:{}, paper:{}, journal:{}}, rhSubmitting = false, rhPreview = null, rhDraft = {symbol:'BTC-USD', usd:'10', orderType:'market'};` and `const RH_FOCUS_IDS = ['rhApiKey','rhSecret','rhSymbol','rhUsd','rhType','rhConfirm','rhAutoConfirm','rhApOrderUsd','rhApMaxOpen','rhApLossCap','rhApSymbols','rhPaperUsd','rhPaperSymbol','rhPaperApOrderUsd','rhPaperApMaxOpen'];`
- `function renderRobinhood(){ const el = $('#body-robinhood'); if (!el) return; const ae = document.activeElement; if (rhSubmitting || (ae && el.contains(ae) && RH_FOCUS_IDS.includes(ae.id))) return; ... setBody('robinhood', html); bind }`. Surface `<div class="dark terminal mpo-surface-dark" style="padding:8px;min-height:100%">`.
- `renderAll`: `renderChanged('robinhood', [rhSig(robinhoodState)], renderRobinhood)` where `rhSig` strips `at`, `loop.lastTickAt`, `quotes[].at`, `tape[].ageMs`, `readiness.rateLimit`.
- `async function refreshRobinhood(){ try { const r = await fetch('/api/robinhood', {cache:'no-store', signal:AbortSignal.timeout(20000)}); robinhoodState = r.ok ? await r.json() : {...robinhoodState, error:'Robinhood API ' + r.status}; } catch (e) { robinhoodState = {...robinhoodState, error:e.message || 'Robinhood unavailable'}; } renderSig.delete('robinhood'); renderAll(); }`; boot call appended to the boot burst line; `setInterval(() => { if (!document.hidden && windowVisible('robinhood')) refreshRobinhood(); }, 15000);`
- Panel, top to bottom: (1) `.mpo-status` title `ROBINHOOD AUTO TRADER · CRYPTO`, badges API `CONNECTED` / `KEYS NEEDED` / auth code, REAL `ARMED` / `SAFE`, `RECOVERY` when needed, LOOP running/idle, muted `manual confirm only · official Crypto Trading API · no sandbox`, and the six-step flow strip `Keys -> Quotes -> Paper autopilot -> Qualified -> Armed -> Real autopilot` (each step green check or muted circle). (2) `.mpo-metrics`: buying power, fee tier % and round-trip cost %, paper equity and P/L, paper closes `n/minCloses · hit · PF`, real open / unverified (amber), realized today vs daily cap (`.mpo-meter` "Daily loss budget"), clock skew (red when `|skew| >= 20 s`), rate-limit backoff. (3) Credentials inset only while `!credentialsReady`: `rhApiKey`, `rhSecret` `type=password`, Paste buttons, Connect -> `config {apiKey, privateKey, realEnabled:false}`, the portal note and the CLI key-pair helper command; once connected the derived public key is shown. (4) Equities notice (`.mpo-module` STOCKS / OPTIONS): static text naming the Agentic Trading MCP as the only sanctioned route and stating this app never uses mobile-app impersonation. (5) Qualification meter `.mpo-meter` (closes progress, hit vs required hit rate, PF, fee drag, drawdown, reasons list, green `QUALIFIED under params <hash>` when true). (6) Tape table: symbol, bid, ask, spread bps, expected move % vs required %, signal badge `WARMUP n/120 | STALE | WAIT | SPREAD | NO-TREND | BREAKOUT | LONG` with the reason text, inline 60-point `<svg viewBox="0 0 120 24"><polyline>` sparkline from `spark` (no library). (7) PAPER LAB `.mpo-module`: positions table (`data-scroll="rh-paper-pos"`, mark, unrealized, stop/take, age, Close), manual paper order row (`rhPaperSymbol` select from pairs, `rhPaperUsd`, Buy paper), paper autopilot toggle + `rhPaperApOrderUsd` + `rhPaperApMaxOpen` + symbols, Reset (window.prompt amount), last 8 closes. (8) `<fieldset class="mpo-danger-fieldset"><legend>ROBINHOOD CRYPTO · REAL MONEY</legend>`: when `realEnabled === false` an `.mpo-empty` line "Real trading is disabled. Set ROBINHOOD_REAL_ENABLED=true in your .env and restart to enable arming." (no button); Arm/Disarm posting `{armed:!sessionArmed}`; staging `rhSymbol`, `rhUsd` (max `limits.maxOrderUsd`), `rhType`, Preview -> `#rhPreviewOut` (qty, est cost, fee, ref ask, gates dry-run with the failing gate named, expiry countdown), `rhConfirm` placeholder `Type PLACE REAL CRYPTO ORDER`, Place `disabled` unless `sessionArmed && preview fresh && preview.wouldPass && confirm === phrase` (re-evaluated on `input`; server re-checks); open entries table (`data-scroll="rh-open"`: symbol, status, qty, avg, mark, unrealized, age; Sell… prompt `PLACE REAL CRYPTO ORDER`, Cancel… prompt `CANCEL REAL CRYPTO ORDER`, Forget… prompt `FORGET` with the "does NOT cancel anything on Robinhood; the coin stays in your account" warning); Cancel all… (`CANCEL REAL CRYPTO ORDERS`), Reconcile now; history last 12 (`data-scroll="rh-hist"`); real autopilot block with settings inputs, `rhAutoConfirm` placeholder `Type ENABLE REAL CRYPTO AUTOPILOT`, enable button disabled unless `sessionArmed && qualification.qualified`, `disabledReason` in `.mpo-error`. (9) `.mpo-error` strip for `robinhoodState.error` / `lastError` / `lastAuthError` (401 shows the clock hint).
- Conventions: all strings through `polyEscape`, numbers through `fmt`/`money`; handlers use `post()` + `showDialog()` with `rhSubmitting = true` around real posts and `await refreshRobinhood()` after; `window.prompt` for phrases; no inline `#ff7a3d`/`#1a0e06`, no `mpo-brand-title`, no emoji, ES5-safe so the renderer `vm.Script` parse gate passes.
- `tests/visual-contract.test.mjs`: the HUD package appends only the four phrases `'PLACE REAL CRYPTO ORDER','CANCEL REAL CRYPTO ORDER','CANCEL REAL CRYPTO ORDERS','ENABLE REAL CRYPTO AUTOPILOT'` to the html phrase array. The backend-source assertions (`const rh = read('src/robinhoodAutoTrader.js'); assert.match(rh, /CONFIRM_PLACE='PLACE REAL CRYPTO ORDER'/); ... assert.match(rh, /confirmation!=='FORGET'/)`) are added by the integration package after the module exists, because `read()` is `fs.readFileSync` and would throw ENOENT.

## 13. Limits and env vars

All read at call time; `.env.example` ships every key commented out with its default.

| Key | Default | Meaning |
|---|---|---|
| `ROBINHOOD_API_KEY` | — | `rh-api-<uuid>`; written by `config` via `rewriteEnv` |
| `ROBINHOOD_PRIVATE_KEY` | — | base64 32-byte Ed25519 seed; 64-byte values rejected |
| `ROBINHOOD_REAL_ENABLED` | `false` | must be exactly `true` to arm or place real orders |
| `ROBINHOOD_AUTOSTART` | unset -> `POLYMARKET_AUTOSTART` -> `true` | `false` keeps the loop inert |
| `ROBINHOOD_API` | `https://trading.robinhood.com` | base URL override for tests |
| `ROBINHOOD_ORDER_API` | `v2` | `v1` only if the key lacks the fee-tier orders scope (no `time_in_force` sent) |
| `ROBINHOOD_MAX_ORDER_USD` | 25 | ceiling per real order |
| `ROBINHOOD_MAX_OPEN` | 5 | ceiling on real `open[]` rows |
| `ROBINHOOD_DAILY_LOSS_CAP_USD` | 50 | real realized loss today stops new real entries |
| `ROBINHOOD_PRICE_TOLERANCE` | 0.02 | max drift between preview and fresh quote |
| `ROBINHOOD_SYMBOLS` | `BTC-USD,ETH-USD,SOL-USD` | default symbol universe; the primary symbol is ordered first |
| `ROBINHOOD_PRIMARY_SYMBOL` | `BTC-USD` | Bitcoin specialization (section 21): sampled first, weighted in ranking |
| `ROBINHOOD_PRIMARY_WEIGHT` | 1.5 | multiplier on the primary symbol's candidate score (max 10) |
| `ROBINHOOD_PRIMARY_ORDER_MULT` | 1.0 | primary autopilot order = `orderUsd x mult` (max 2.0), never above `ROBINHOOD_MAX_ORDER_USD` |
| `ROBINHOOD_TICK_MS` | 15000 (min 5000) | loop and tape cadence |
| `ROBINHOOD_FEE_RATIO_FALLBACK` | 0.0085 | when neither account nor estimate carries `fee_ratio` |
| `ROBINHOOD_PAPER_START_USD` | 1000 | paper bankroll on first run |
| `ROBINHOOD_QUAL_MIN_CLOSES` | 20 | qualification |
| `ROBINHOOD_QUAL_MIN_HIT_RATE` | 0.45 | qualification |
| `ROBINHOOD_QUAL_MIN_PROFIT_FACTOR` | 1.3 | qualification |
| `ROBINHOOD_QUAL_WINDOW_DAYS` | 30 | qualification |
| `ROBINHOOD_EVOLVE_ENABLED` | `false` | exactly `true` schedules the in-process evolution run every `ROBINHOOD_EVOLVE_INTERVAL_MIN` (section 22); `Run now` always works. Off by default since batch 11: search belongs in the Evolution Lab |
| `ROBINHOOD_EVOLVE_INTERVAL_MIN` | 360 | scheduled generation cadence, checked from the loop tick |
| `ROBINHOOD_EVOLVE_CANDIDATES` | 24 | mutations evaluated per generation (max 200) |
| `ROBINHOOD_EVOLVE_MIN_GAIN` | 0.15 | fraction by which a champion must beat the incumbent's test score |
| `ROBINHOOD_EVOLVE_AUTOPROMOTE` | `false` | exactly `true` applies champions to the paper autopilot without the APPLY click |
| `ROBINHOOD_EVOLVE_MIN_TAPE_DAYS` | 3 | primary-symbol tape coverage required before a generation runs |
| `ROBINHOOD_EVOLVE_MAX_TAPE_DAYS` | 14 (max 45) | newest days of tape replayed per generation |

`robinhoodLimits()` returns exactly `{maxOrderUsd, maxOpen, dailyLossCapUsd, priceTolerance}` in that key order via `envNum = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; }` (a test pins the key list). Autopilot settings are clamped into these ceilings on every pass.

## 14. Tests

All `node:test`; every suite sets `MONEY_PRINTER_DATA_DIR` to a `mkdtemp` dir, `POLYMARKET_AUTOSTART='false'` and `ROBINHOOD_AUTOSTART='false'` before the dynamic import; `globalThis.fetch` is replaced by `installFetch(handler, log)` returning `{ok, status, headers:{get}, text:async()=>...}` and throwing on unexpected paths; `test.after` restores fetch, stops loops and removes the dir. `package.json`'s `test:robinhood` runs `node scripts/sync-robinhood-panel.mjs --check` and then `node --test` over signer, journal, strategy, safety, auto-trader, auto (paper lab), tape, backtest, evolve, hud and http suites; `&& npm run test:robinhood` is appended to `test:all`.

- `tests/robinhood-signer.test.mjs` (package A; holds the docs vector `seed xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=` -> `pub jPItx4TLjcnSUnmnXQQyAKL4eJj3+oWNNMmmm2vATqk=`, api key `rh-api-6148effc-c0b1-486c-8940-a1d099456be6`, ts `1698708981`, path `/api/v1/crypto/trading/orders/`, python-dict body -> `q/nEtxp/P2Or3hph3KejBqnw5o9qeuQ+hYRnB56FaHbjDsNUY9KhB1asMxohDnzdVFSD7StaTqjSd9U9HvaRAw==`): docs seed derives docs public key; docs vector reproduces; JSON body signs deterministically and verifies with `crypto.verify`; timestamp is unix seconds; 64-byte key rejected with hint, 16-byte rejected `badKey`; `formatIncrement` floors and never emits exponent; `ceilIncrement`; key pair round-trips; transport: signs path+query and sends the identical bytes it signed; 401/403/429/400/5xx/network classification; 429 sets backoff and the next request is refused locally; 401 with skewed `date` retries once with the corrected timestamp and identical body, and no retry on a first 403; token bucket refuses locally; `lastDateHeaderSec` recorded on 2xx; v1 fallbacks for accounts/best_bid_ask; `rhPaginate` strips the base URL; `import performs no fetch`.
- `tests/robinhood-journal.test.mjs` (B): ENOENT defaults with autopilot off; corrupt journal -> recoveryRequired + autopilot off; atomic save leaves no tmp when `fs.writeFileSync`/`fs.renameSync` are monkey-patched to throw (no read-only-directory trick; Windows owners can write into read-only dirs); transition graph rejects illegal moves; terminal transition moves to history and keeps count; CLOSED requires verified exit fill; recomputeStats counts only verified closes; realizedTodayUsd respects local day; tape ring caps at 720 and dedupes; paper corruption revokes qualification without touching the real journal; qualification requires closes/hit/PF/pnl/drawdown/staleness/paramsHash and ignores manual closes; sessionArmed never serialized.
- `tests/robinhood-strategy.test.mjs` (C): features warmup/stale/gaps, Donchian excludes current sample, EMA against a hand-computed tape; `roundTripCost = 2*fee + spread + slip`; `requiredHitRate` geometry (4C/1C -> 0.4); entry refuses in low vol even on a breakout, refuses wide spread, accepts a synthetic high-vol breakout with EMA alignment; take-profit net of both fees is positive for the defaults (pinned); exit priority stop > take > trail > time > fade, trailing stop never decreases; sizeOrder floors to increment, enforces min/max/orderCap/buyingPower, never exponent; paper fill math (model and estimate paths); paramsHash stable across key order; deterministic candidate order; same tape yields same decisions.
- `tests/robinhood-safety.test.mjs` (D; env creds = generated valid seed, `ROBINHOOD_REAL_ENABLED='true'`, fetch replaced by a thrower before import): starts disarmed; real order refuses while disarmed; armed session still requires the exact phrase; arm refused with `realDisabled` when the env is not `true`; readiness never echoes the secret and shows the public key; cancel/forget require their phrases; limits keys pinned and re-read from env; enabling real autopilot walks `confirmation -> notArmed -> notQualified`; import performs no fetch.
- `tests/robinhood-auto-trader.test.mjs` (D): gates reject before any signed request (`log.filter(x => x.headers['x-api-key']).length === 0`); client_order_id persisted before place (the fetch handler reads the journal file) and reused after an uncertain send; any 4xx on place lands in history as REJECTED; reconcile promotes only verified fills and keeps the count; never-received rows survive lagging listings and move to FAILED only after 3 successful listings over >= 10 min; auth/network errors never transition; sell fill books realized P/L with fee and sets cooldown; cancelled sell returns to OPEN; cancel changes status only via reconcile; cancel works without arm; forget books no P/L and no cooldown; autopilot double opt-in + qualification + paramsHash gate; autopilot self-disables on 401/403 and persists `enabled:false`; autopilot disables itself with `disabledReason:'dailyLossCap'` at the daily loss cap and with `'paramsChanged'` when the paper hash changes; limits re-read mid-run; constants pinned; idle tick makes no request; tick with paper autopilot samples one batched best_bid_ask; paper order fills at ask with fee, close at bid; paper-reset cannot touch the real journal; snapshot never throws on a dead feed and pins its key list `[at, readiness, account, pairs, quotes, tape, paper, journal, limits, qualificationThresholds, strategy, loop, equities, evolve, lastError]`; configure writes `.env` under the temp USER_ROOT with 0600 and disarms.
- `tests/robinhood-hud.test.mjs` (E; regex on `public/assets/robinhood-panel.js` and the html + `vm.Script` parse of both): the embedded copy equals the synced panel source, APPS entry, `defaultLayout.robinhood` geometry, every control id (credentials, arm, preview, `rhConfirm`/`rhPlace`, cancel-all, reconcile, real autopilot inputs and `rhAutoConfirm`, paper lab, reset, `rhEvolveRun`/`rhEvolveApply`), every `rhAction('<route>'` including `evolve/run` and `evolve/apply`, the four phrases verbatim and never pre-filled, `RH_PHRASES`, the FORGET warning text, `Agentic Trading MCP`, `LAYOUT_VERSION` unchanged, `POLY_MODS` untouched, `mpo-brand-title` count unchanged, and the focused-input / typed-secret refresh guard.
- `tests/robinhood-tape.test.mjs`, `tests/robinhood-backtest.test.mjs`, `tests/robinhood-evolve.test.mjs` (section 22): tape append/dedupe/flush throttle/fs-error reporting/45-day compaction/load; deterministic replay (trending tape closes, flat tape never enters, fees on both legs, no look-ahead, 70/30 split); bounded mutations, scoring penalties, min-gain promotion, propose-only by default, APPLY -> paper params + qualification reset + real autopilot `paramsChanged`, autopromote path, tick buffering.
- `tests/visual-contract.test.mjs` (F): backend-source assertions on `src/robinhoodAutoTrader.js` (`CONFIRM_*` constants, `confirmation!=='FORGET'`, `realEnabled` env check) and `src/robinhoodHttp.js` (`RESET PAPER`, `placedBy:'manual'`, the GET routes, `evolve/apply`).
- `tests/robinhood-http.test.mjs` (F; boots `startDashboard()` on port 0 like the product-economics http test, with `ROBINHOOD_API_KEY`, a generated valid `ROBINHOOD_PRIVATE_KEY` and `ROBINHOOD_REAL_ENABLED='true'` set before importing `src/dashboard.js`): GET `/api/robinhood` 200 with the contract keys; GET readiness; POST `/api/robinhood/order` without arm -> 400 `code:'notArmed'`; sibling cases return `noCredentials` (keys cleared) and `realDisabled` (env flipped); POST `/api/robinhood/autopilot {enabled:true}` -> 400 `confirmation`; unknown sub-path 404; oversized body 400.
- `tests/release-gate.test.cjs` (+4): open Robinhood entry blocks (`/Robinhood crypto order exposure/`); corrupt `robinhood-auto-trader.json` -> `unreadable`; `recoveryRequired` blocks; `robinhood-paper.json` with positions is ignored; the existing allowed case still passes with the file absent.

## 15. Release gate, installer, updater

- `desktop/release-gate.cjs` `updateSafety(dataDir)`: also reads `robinhood-auto-trader.json`; `!ok` -> `'robinhood-auto-trader.json unreadable'`; `recoveryRequired` joins `'trading state requires recovery'`; `rhOpen = (Array.isArray(rh.open) ? rh.open : []).filter(Boolean)` -> `` `${rhOpen.length} Robinhood crypto order exposure(s) open` ``; return gains `robinhoodOpen`. The paper file is not read (paper is not exposure). ENOENT stays allowed.
- `scripts/unified/windows/Install-Windows.ps1`: the file list becomes `@('combo-engine.json','polymarket-us-combos.json','robinhood-auto-trader.json')`; the open check becomes `$Name -in @('polymarket-us-combos.json','robinhood-auto-trader.json')` with the message "Open Polymarket or Robinhood orders block updating."
- `desktop/main.cjs` needs no change: `updateSafety(DATA)` already runs before every asar swap and the message stays "Update held until flat".
- `src/doctor.js`: one env/fs-only `robinhood` line after the PAPER IDENTITY line, using the existing `dataDir` and never importing the venue module: journal present/absent, keys configured/absent, real ENABLED/disabled, open real rows (or RECOVERY/UNREADABLE), paper `qualified` yes/no, evolve ledger generation + champion hash, autopromote on/off; a WARN line when `ROBINHOOD_REAL_ENABLED=true`.
- `scripts/health-check.mjs`: optional `getJson(`${TRADER_URL}/api/robinhood`)` -> `robinhood` (keys / keyValid / real / armed / qualified / auth; WARN when armed or real enabled), `robinhood loop` (running + last tick, WARN when not running), `robinhood state` RED on recovery, `robinhood real autopilot` WARN when enabled, `robinhood exposure` when real rows are open, `robinhood evolve` (generation, proposed champion, autopromote, tape coverage) — all inside one try/catch so an older build without the route is only a WARN.
- Version: `package.json` and the root `version` of `package-lock.json` both move to `0.5.0-alpha.56` in the integration package (`npm install --package-lock-only`); a stale lock stamp broke `npm ci` once. CI runs `test:all` on Node 22 and 24 with `DOCTOR_OFFLINE=1` and needs no workflow change. Release flow is unchanged: tag -> Actions draft release; the signing key is user-only and no agent installs the build.

## 16. Operator runbook and rollback

1. Create keys with read scopes only. Connect them in the HUD. Confirm the derived public key matches the portal. Readiness should show `CONNECTED`, `realEnabled:false`, `SAFE`.
2. Enable paper autopilot on `BTC-USD,ETH-USD` with the default 25 USD paper size. Watch the tape warm up (30 minutes) and the signal column explain why it is or is not trading. Leave it for days; the qualification meter needs 20 strategy closes inside 30 days with hit rate >= 45%, profit factor >= 1.3, positive net P/L, drawdown under the daily loss cap, and a close within 72 h.
3. If qualification never turns green, the strategy has no edge after Robinhood's fees at your tier. Do not loosen the parameters to chase the badge; every change resets the count.
4. Only if qualified and you accept the risk: add the orders scope to the key (or a new key), set `ROBINHOOD_REAL_ENABLED=true` in `.env`, restart, Arm, Preview a 10 USD order, read the gates dry-run, type `PLACE REAL CRYPTO ORDER`. The first real request should still be a read (`accounts`); see section 18 for the response-shape caveat.
5. Real autopilot: type `ENABLE REAL CRYPTO AUTOPILOT` while armed. It runs only while the session stays armed (a restart disarms), sizes at most `ROBINHOOD_MAX_ORDER_USD`, keeps at most `ROBINHOOD_MAX_OPEN` rows, and stops at the daily loss cap.
6. Rollback / stop: Disarm (one click) stops all new real orders immediately. `Cancel all…` (`CANCEL REAL CRYPTO ORDERS`) cancels resting orders without arming. Open verified positions are sold with Sell… or left in the account. Set `ROBINHOOD_REAL_ENABLED=false` and restart to lock the venue. The updater refuses to update while any real row is in `open[]`; use Reconcile now, then Cancel/Sell, then update. `FORGET` drops tracking only and never touches Robinhood.
7. If readiness shows `keyNotFound` right after connecting: check system time (30 s window; `clockSkewSec` in readiness), then regenerate the key pair. `notPermitted` means the key lacks the scope for that call.

## 17. Open questions

- `GET /api/v2/crypto/trading/orders/{id}/` is not in the embedded OpenAPI path list; the wrapper falls back to `listOrders` + id match. Verify live under a read-only key.
- Whether v2 `estimated_price` `fee_ratio` reflects the account tier for a key without the fee-tier orders scope; the fallback chain covers it either way.
- Exchange-side `stop_loss` orders as a later hardening step (rejected for v1 because they would be unreconciled exposure; today a stop can be missed during a 429 backoff of up to 60 s).
- Rate limits are undocumented per endpoint; the 60/min client bucket is a guess below the published 100/min account limit and does not see other processes using the same key.
- Jurisdiction gating (`is_api_tradable` false for the whole account) surfaces as `notTradable` on every pair; the HUD should then say so once rather than per symbol.

## 18. Unverified until observed live

The v2 response field names, decimal-string vs numeric quantities, the `fee_charged` field on the 201 response and 401 semantics under clock skew are derived from the embedded OpenAPI schema and community clients (same wording as `KNOWN_BUGS.md`). Paper fills mark strategy consistency, not real fill quality; real sizing is capped in dollars so the paper-to-real optimism gap is bounded, but nothing here claims profitability.

## 19. Work packages (disjoint file ownership; F last)

| Key | Files | Depends on |
|---|---|---|
| A-signer-transport | `src/robinhoodErrors.js`, `src/robinhoodSigner.js`, `src/robinhoodTransport.js`, `tests/robinhood-signer.test.mjs` | — (writes `src/robinhoodErrors.js` first, verbatim from section 20) |
| B-journal-paper-store | `src/robinhoodJournal.js`, `tests/robinhood-journal.test.mjs` | A (imports `src/robinhoodErrors.js` only) |
| C-strategy | `src/robinhoodStrategy.js`, `tests/robinhood-strategy.test.mjs` | — |
| D-auto-trader-core | `src/robinhoodAutoTrader.js`, `tests/robinhood-safety.test.mjs`, `tests/robinhood-auto-trader.test.mjs` | A, B, C |
| E-hud | `public/dashboard.html`, `tests/robinhood-hud.test.mjs`, `tests/visual-contract.test.mjs` (phrase array only) | — |
| F-integration | `src/dashboard.js`, `package.json`, `package-lock.json`, `.env.example`, `desktop/release-gate.cjs`, `tests/release-gate.test.cjs`, `scripts/unified/windows/Install-Windows.ps1`, `src/doctor.js`, `scripts/health-check.mjs`, `tests/robinhood-http.test.mjs`, `tests/visual-contract.test.mjs` (backend-source assertions), `README.md`, `.agent-state/PROJECT_STATE.md`, `.agent-state/CURRENT_TASKS.md`, this document's status lines | A, B, C, D, E |

Shared conventions: `const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const DATA_DIR = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || path.join(ROOT, 'data'));` bound at import; `USER_ROOT = path.dirname(DATA_DIR)`; journal numbers are JS numbers; anything sent to Robinhood is a decimal string from `formatIncrement`. Nobody uses `instanceof RobinhoodError`; every consumer branches on `e.code`. Header comment of `src/robinhoodAutoTrader.js` states the snapshot contract and the gate order (the `.workflow/` spec convention is gitignored).

## 20. Interface contract

```js
// ===== src/robinhoodErrors.js (A, dependency-free; written first, verbatim)
export const RH_CODES = ['noCredentials','stateRecovery','paperRecovery','realDisabled','notArmed','confirmation','notQualified','orderCap','openCap','dailyLossCap','cooldown','duplicate','priceTolerance','minOrder','increment','aboveMax','notTradable','buyingPower','paperCash','busy','badKey','keyNotFound','notPermitted','rateLimited','clockSkew','network','validation','http','uncertain','notFound','notCancellable','holding','unknown'];
export class RobinhoodError extends Error {
  constructor(code, message, status = 0, details = null) { super(message); this.name = 'RobinhoodError'; this.code = RH_CODES.includes(code) ? code : 'unknown'; this.status = status; this.details = details; this.sent = false; }
}
export const fail = (code, message, status = 0, details = null) => { throw new RobinhoodError(code, message, status, details); };

// ===== src/robinhoodSigner.js (A) — pure, no env/fs/fetch
export const RH_BASE_URL = 'https://trading.robinhood.com';
export const PKCS8_ED25519_PREFIX: Buffer;                                   // 302e020100300506032b657004220420
export function loadRobinhoodPrivateKey(seedBase64: string): KeyObject;       // 32 bytes only; 64 -> RobinhoodError('badKey','... you pasted seed||publicKey ...'); other -> 'badKey'
export function publicKeyBase64(privateKey: KeyObject): string;
export function generateRobinhoodKeyPair(): { privateKeyBase64: string, publicKeyBase64: string };
export function buildSignedMessage({ apiKey, timestamp, path, method, body = '' }): string;   // `${apiKey}${timestamp}${path}${METHOD}${body}`
export function signRequest({ apiKey, privateKey, method, path, body = '', timestamp = Math.floor(Date.now()/1000) }): { 'x-api-key': string, 'x-timestamp': string, 'x-signature': string };
export function buildPath(pathname: string, query?: Record<string, string|number|Array<string|number>|null|undefined>): string; // repeats array keys, commas unencoded, keeps trailing slash
export function formatIncrement(value: number, increment: string|number): string;   // floor, no exponent; throws 'increment' on non-finite
export function ceilIncrement(value: number, increment: string|number): string;
export function incrementDecimals(increment: string|number): number;

// ===== src/robinhoodTransport.js (A)
export { RobinhoodError, RH_CODES, fail } from './robinhoodErrors.js';
export function classifyRobinhoodError(status: number, payload: any, message?: string): string; // 400 validation_error->'validation' | 401->'keyNotFound' | 403->'notPermitted' | 404->'http' | 429->'rateLimited' | 5xx->'http' | else 'http'
export function creds(): { apiKey: string, privateKeyBase64: string };                // trimmed env, never cached
export function keyObject(): KeyObject | null;                                       // memoised on sha256(seed); null when incomplete or badKey (lastAuth notes 'badKey')
export function rhLastAuth(): { error: string|null, code: string|null, at: number };
export function noteRobinhoodAuth({ code = null, message = null, status = 0 } = {}): void;
export function rhClock(): { skewSec: number, syncedAt: number, lastDateHeaderSec: number|null, timestamp: () => number };
export function rhRateLimit(): { tokens: number, capacity: 60, refillPerSec: 1, backoffUntil: number, consecutive429: number };
export async function rhRequest({ method, path, json, timeoutMs = 15000, retryOn401 = true }): Promise<any>; // signs the exact JSON once; body '' for GET/cancel; sets err.sent; throws RobinhoodError
export async function rhGet(path: string, query?: object): Promise<any>;
export async function rhPost(path: string, json?: object, query?: object): Promise<any>;
export async function rhPaginate(path: string, query?: object, { maxPages = 5 } = {}): Promise<any[]>;
export async function fetchAccount(): Promise<{ accountNumber: string, status: string, buyingPowerUsd: number, feeRatio: number|null, apiVersion: 'v2'|'v1', at: number }>;
export async function fetchTradingPairs(symbols: string[]): Promise<Map<string, { symbol, assetCode, assetIncrement: string, quoteIncrement: string, maxOrderSize: number|null, minOrderAmountUsd: number|null, status: string, isApiTradable: boolean }>>;
export async function fetchHoldings(accountNumber: string, assetCodes?: string[]): Promise<Array<{ assetCode, totalQty: number, availableQty: number }>>;
export async function fetchBestBidAsk(symbols: string[]): Promise<Array<{ symbol, bid: number, ask: number, at: number, source: 'v2'|'v1' }>>;
export async function fetchEstimatedPrice(symbol: string, side: 'bid'|'ask'|'both', quantities: string[]): Promise<Array<{ symbol, side, quantity: number, bid: number|null, ask: number|null, feeRatio: number|null, estFee: number|null, estTotalCost: number|null, estTotalCredit: number|null, at: number }>>;
export async function listOrders(accountNumber: string, filters?: { state?, symbol?, created_at_start?, side? }): Promise<NormalizedOrder[]>;
export async function getOrder(accountNumber: string, orderId: string): Promise<NormalizedOrder|null>;
export async function placeOrder(accountNumber: string, body: object): Promise<NormalizedOrder>;   // body serialized exactly once
export async function cancelOrder(accountNumber: string, orderId: string): Promise<{ submitted: true, order: NormalizedOrder|null }>;
export function normalizeOrder(raw: any): NormalizedOrder; // { id, clientOrderId, symbol, side, type, state:'open'|'pending'|'partially_filled'|'filled'|'canceled'|'failed', averagePrice:number|null, filledQty:number, feeCharged:number|null, executions:[{price,qty,at}], createdAt, updatedAt }
export function orderBody({ clientOrderId, symbol, side, type, qtyStr, limitPriceStr?, timeInForce = 'gtc' }): object; // { client_order_id, side, type, symbol, [`${type}_order_config`]: {...} }; omits time_in_force when ROBINHOOD_ORDER_API=v1
export const __testing: { resetTransport(): void, setClock(fn: (() => number)|null): void, setRateLimit(cap: number, refill: number): void, requestLog: Array<{ method, url, headers, body }> };

// ===== src/robinhoodJournal.js (B)
export const JOURNAL_FILE: string, PAPER_FILE: string;
export const OPEN_STATUSES = ['PENDING_SUBMIT','SUBMITTED','SUBMITTED_UNCERTAIN','OPEN','CLOSING','CLOSING_UNCERTAIN'];
export const TERMINAL_STATUSES = ['CLOSED','CANCELLED','REJECTED','FAILED','FORGOTTEN'];
export function defaultJournal(): Journal; export function defaultRealAutopilot(): RealAutopilot; export function normalizeJournal(s: any): Journal; export function loadJournal(): Journal; export function saveJournal(s: Journal): Journal;
export function defaultPaper(): Paper; export function defaultPaperAutopilot(): PaperAutopilot; export function normalizePaper(s: any): Paper; export function loadPaper(): Paper; export function savePaper(s: Paper, { force = false } = {}): Paper; // force bypasses the 30 s tape flush throttle
export function newEntryId(): string; export function newPaperId(): string;
export function makeRealEntry({ symbol, side, requestedQty, requestedUsd, refAsk, refBid, orderType, limitPrice, timeInForce, previewFeeUsd, placedBy, stopPct, takePct, trailArmPct, trailPct, paramsHash }): Entry; // status 'PENDING_SUBMIT', clientOrderId = randomUUID()
export function transition(j: Journal, entryId: string, nextStatus: string, patch?: object): Entry;  // enforces the graph; terminal -> history unshift cap 200; throws 'unknown'
export function recomputeStats(j: Journal): Journal;
export function realizedTodayUsd(j: Journal, now?: number): number;
export function setCooldown(j: Journal|Paper, symbol: string, untilMs: number): void; export function inCooldown(j: Journal|Paper, symbol: string, now?: number): boolean;
export function appendTape(p: Paper, symbol: string, { bid, ask, at, quoteSource }, cap = 720): void;
export function tapeFor(p: Paper, symbol: string): Array<{ t, bid, ask, mid }>;
export function evaluateQualification(p: Paper, now?: number, thresholds?: Thresholds, limits?: { dailyLossCapUsd: number }): Qualification;
export function qualificationThresholds(): { minCloses: number, minHitRate: number, minProfitFactor: number, windowDays: number };
export function startOfDay(now?: number): number;
export const __testing: { resetJournal(): void, resetPaper(): void, journalFile: string, paperFile: string, TAPE_FLUSH_MS: 30000, TAPE_CAP: 720, HISTORY_CAP: 200, PAPER_HISTORY_CAP: 500 };
// Journal, Entry, Paper, PaperPosition, Qualification: exactly the JSON shapes in section 5.
// RealAutopilot = { enabled:false, orderUsd:10, maxOpen:2, dailyLossCapUsd:25, symbols:['BTC-USD','ETH-USD'], orderType:'market', lastRunAt:0, lastAction:null, skipped:[], disabledReason:null, disabledAt:0, enabledAt:0, paramsHash:null }
// PaperAutopilot = { enabled:false, orderUsd:25, maxOpen:3, symbols:['BTC-USD','ETH-USD'], lastRunAt:0, lastAction:null, skipped:[] }
// Qualification = { qualified, paramsHash, closes, hitRate, profitFactor, pnlUsd, grossPnlUsd, feesUsd, feeDragPct, maxDrawdownUsd, requiredHitRate, lastCloseAt, windowDays, reasons:string[], at }

// ===== src/robinhoodStrategy.js (C) — pure, no imports
export const STRATEGY_DEFAULTS = { sampleMs:15000, warmupSamples:120, lookbackSamples:90, volWindow:60, horizonSamples:960, emaFast:12, emaSlow:48, emaSlopeSamples:6, costMultiple:1.5, breakoutBufferPct:0.0005, maxSpreadBps:40, takeMult:4, stopMult:1, trailArmMult:2, trailMult:1, maxHoldMin:240, fadeExit:true, cooldownWinMin:5, cooldownLossMin:30, maxGapRatio:0.1, slipBps:5, minSamples:120 };
export function normalizeParams(p: object): typeof STRATEGY_DEFAULTS;
export function paramsHash(p: object): string;                                                   // 12 hex
export function roundTripCost(feeRatio: number, spreadPct: number, params?): number;              // 2*fee + spread + 2*slipBps/1e4
export function computeFeatures(samples: Array<{ t, bid, ask, mid }>, params?, now?: number): { ok: boolean, reason: 'warmup'|'stale'|'gaps'|null, n, ageMs, mid, bid, ask, spreadPct, spreadBps, sigma1, expectedMovePct, donchianHigh, donchianLow, emaFast, emaSlow, emaSlowPrev, gapRatio };
export function entrySignal(features, { costPct, params? }): { enter: boolean, reason: 'warmup'|'stale'|'gaps'|'spread'|'lowVol'|'noBreakout'|'noTrend'|'breakout', requiredMovePct, takePct, stopPct, trailArmPct, trailPct, requiredHitRate };
export function requiredHitRate({ takePct, stopPct, costPct }): number;
export function exitSignal(position: { fillPrice, openedAt, stopPct, takePct, trailArmPct, trailPct, peakBid, trailStop }, { bid, features?, now, feeRatio, params? }): { exit: boolean, reason: 'stop'|'take'|'trail'|'time'|'fade'|null, peakBid: number, trailStop: number|null };
export function sizeOrder({ orderUsd, ask, pair: { assetIncrement, minOrderAmountUsd, maxOrderSize }, buyingPowerUsd = Infinity, maxOrderUsd, feeRatio, params? }): { ok: boolean, reason: null|'minOrder'|'increment'|'aboveMax'|'orderCap'|'buyingPower', qty: number, qtyStr: string, notionalUsd, estFeeUsd, costUsd };
export function limitBuyPrice(ask: number, quoteIncrement: string, tolerance: number): string;     // ceil(ask*(1+min(tolerance,0.002)))
export function paperBuyFill({ qty, bid, ask, feeRatio, estimate?: { estTotalCost, at }, now?, params? }): { fillPrice, feeUsd, costUsd, source: 'model'|'estimate' };
export function paperSellFill({ qty, bid, ask, feeRatio, estimate?: { estTotalCredit, at }, now?, params? }): { fillPrice, feeUsd, proceedsUsd, source: 'model'|'estimate' };
export function markToMarket(position, bid: number, feeRatio: number): number;
export function cooldownUntil({ closedAt, pnlUsd }, params?): number;
export function pickCandidates(featuresBySymbol: Record<string, { features, costPct }>, openSymbols: string[], cooldowns: Record<string, number>, maxOpen: number, now: number): string[];

// ===== src/robinhoodAutoTrader.js (D)
export const CONFIRM_PLACE='PLACE REAL CRYPTO ORDER', CONFIRM_CANCEL='CANCEL REAL CRYPTO ORDER', CONFIRM_CANCEL_ALL='CANCEL REAL CRYPTO ORDERS', CONFIRM_AUTOPILOT='ENABLE REAL CRYPTO AUTOPILOT', CONFIRM_FORGET='FORGET';
export function robinhoodLimits(): { maxOrderUsd: number, maxOpen: number, dailyLossCapUsd: number, priceTolerance: number }; // exactly these keys, this order
export function robinhoodSymbols(): string[];
export function robinhoodReadiness(): Readiness;
export function configureRobinhood({ apiKey, privateKey, realEnabled = false }): Readiness;   // writes USER_ROOT/.env 0600, clears caches, sessionArmed=false; throws 'badKey' | 'validation'
export function armRobinhood(armed = false): Readiness;                                       // throws stateRecovery | noCredentials | realDisabled
export async function previewRobinhoodOrder({ symbol, side = 'buy', usd?, qty?, orderType = 'market', entryId? }): Promise<Preview>;
export async function placeRobinhoodOrder({ symbol, side = 'buy', usd?, qty?, orderType = 'market', entryId?, confirmation, placedBy = 'manual', overrideCooldown = false, reason? }): Promise<{ ok: true, entry: Entry, journal: { open: Entry[], unverified: number } }>;
export async function cancelRobinhoodOrder({ entryId, confirmation }): Promise<{ ok: true, entry: Entry }>;                    // credentials + phrase only
export async function cancelAllRobinhood({ confirmation }): Promise<{ ok: true, cancelled: string[], errors: Array<{ entryId, error }> }>;
export function forgetRobinhoodEntry({ entryId, confirmation, acknowledgeHolding = false }): { ok: true, entry: Entry };
export async function reconcileRobinhood({ force = false } = {}): Promise<{ ran: boolean, checked: number, changed: number, lastReconcileAt: number, errors: Array<{ entryId, code, message }> }>;
export function robinhoodAutopilot(): RealAutopilot;
export function setRobinhoodAutopilot(patch: { enabled?, confirmation?, orderUsd?, maxOpen?, dailyLossCapUsd?, symbols?, orderType? }): RealAutopilot;
export async function runRobinhoodAutopilotOnce(): Promise<{ ran: boolean, reason?: string, disabled?: true, placed?: string[], closed?: string[], skipped?: Array<{ symbol, reason }>, error?: string }>;
export async function placeRobinhoodPaperOrder({ symbol, usd, placedBy = 'manual' }): Promise<{ ok: true, position: PaperPosition, paper: PaperSnapshot }>;
export async function closeRobinhoodPaperPosition({ id, reason = 'manual' }): Promise<{ ok: true, position: PaperPosition, paper: PaperSnapshot }>;
export function resetRobinhoodPaper({ amountUsd } = {}): PaperSnapshot;
export function setRobinhoodPaperAutopilot(patch: { enabled?, orderUsd?, maxOpen?, symbols?, params? }): PaperAutopilot & { paramsHash: string };
export async function robinhoodSnapshot({ force = false } = {}): Promise<Snapshot>;              // TTL 5 s, in-flight coalesced, never throws
export function startRobinhoodLoops(): NodeJS.Timeout | null;                                   // inert when AUTOSTART() is false; unref'd
export function stopRobinhoodLoops(): void;
export function robinhoodEvolveView(): EvolveView;                                              // section 22
export async function runRobinhoodEvolveOnce({ manual = false } = {}): Promise<EvolveRun>;      // section 22; paper-only, time-boxed
export function applyRobinhoodEvolution({ paramsHash, by = 'operator' }): { ok: true, applied: boolean, paramsHash, autopilot: PaperAutopilot, realAutopilot: RealAutopilot }; // paper params only
export const __testing: { reset(): void, setClock(fn): void, tick(): Promise<void>, journalFile: string, paperFile: string, evolveFile: string, tapeDir: string, CONFIRM_PLACE, CONFIRM_CANCEL, CONFIRM_CANCEL_ALL, CONFIRM_AUTOPILOT, TICK_MS: number, SNAPSHOT_TTL_MS: 5000, PREVIEW_TTL_MS: 30000, ENTRY_TTL_MS: 90000, readonly lastPreview };
// Readiness = { platform:'Robinhood Crypto', hasApiKey, hasPrivateKey, keyValid, credentialsReady, publicKey:string|null, realEnabled:boolean, sessionArmed:boolean, execution:'manual-confirm-only', equities:'official Agentic Trading MCP only — not automated here', developerPortal:'https://robinhood.com/account/crypto', lastAuthError, authCode, lastAuthAt, clockSkewSec:number|null, rateLimit:{ backoffUntil, consecutive429 }, recoveryRequired:boolean, paperRecoveryRequired:boolean, qualified:boolean }
// Preview = { symbol, side, orderType, qty, qtyStr, refAsk, refBid, refAt, limitPrice:string|null, feeRatio, estFeeUsd, estTotalUsd, costPct, limits, gates:{ stateRecovery, credentials, realEnabled, armed, orderCap, openCap, dailyLossCap, cooldown, duplicate, qualified }, wouldPass:boolean, warnings:string[], previewAt, expiresAt }
// Snapshot = { at, readiness, account:{ accountNumber(masked last4), status, buyingPowerUsd, feeRatio, apiVersion, at }|null, pairs:[{ symbol, assetIncrement, quoteIncrement, minOrderAmountUsd, isApiTradable }], quotes:[{ symbol, bid, ask, spreadPct, at, source }],
//   tape:{ [symbol]: { n, ageMs, expectedMovePct, costPct, requiredMovePct, signal:'WARMUP'|'STALE'|'WAIT'|'SPREAD'|'NO-TREND'|'BREAKOUT'|'LONG', reason, spark:number[60] } },
//   paper:{ cashUsd, startUsd, equityUsd, unrealizedUsd, positions:(PaperPosition & { markBid, unrealizedUsd, unrealizedPct, ageMs })[], history:PaperPosition[8], stats, autopilot, params, paramsHash, qualification, recoveryRequired?, recoveryError? },
//   journal:{ open:Entry[], history:Entry[12], stats:{ ...stats, unverified }, autopilot:RealAutopilot, cooldowns, realizedTodayUsd, lastReconcileAt, recoveryRequired?, recoveryError? },
//   limits, qualificationThresholds, strategy:{ params, paramsHash, requiredHitRate, primary }, loop:{ running, tickMs, lastTickAt, needsQuotes }, equities:{ automated:false, route:'Agentic Trading MCP', url:'https://agent.robinhood.com/mcp/trading', note }, evolve: EvolveView (section 22), lastError:{ at, stage, code, message }|null }

// ===== HTTP (F): section 11. Every POST returns { ok:true, ... } or 400 { ok:false, error, code }; GET /api/robinhood -> Snapshot; GET /api/robinhood/readiness -> Readiness.
// ===== HUD (E): reads Snapshot exactly as above, posts the bodies in section 11, sends confirmation strings verbatim.
// ===== release-gate (F): updateSafety(dataDir) returns robinhoodOpen:number and reasons 'robinhood-auto-trader.json unreadable' | 'trading state requires recovery' | `${n} Robinhood crypto order exposure(s) open`.
```

## 21. Bitcoin specialization

The trader specializes in Bitcoin but trades the other configured `*-USD` pairs with the same rules. Three env vars, all re-read on every call:

| Key | Default | Effect |
|---|---|---|
| `ROBINHOOD_PRIMARY_SYMBOL` | `BTC-USD` | The primary pair. `robinhoodSymbols()` orders it first, the feed always samples it first and keeps its tape even when it is not in the autopilot list, and the snapshot marks `tape[symbol].primary:true`. |
| `ROBINHOOD_PRIMARY_WEIGHT` | 1.5 | `pickCandidates(featuresBySymbol, openSymbols, cooldowns, maxOpen, now, weights)` gained an optional sixth `weights` argument (`{ [symbol]: multiplier }`, backwards compatible). Both the paper and the real pass pass `{ [primary]: weight }`, so on equal `expectedMovePct / costPct` the primary wins the slot; ties still break by symbol. Weights change ranking only — the entry signal itself (breakout, EMA alignment, spread, cost multiple) is unchanged. |
| `ROBINHOOD_PRIMARY_ORDER_MULT` | 1.0 (max 2.0) | Real autopilot sizing: `primaryOrderUsd(symbol, orderUsd, limits) = min(symbol === primary ? orderUsd * mult : orderUsd, limits.maxOrderUsd)`. The env ceiling always wins; other pairs use `orderUsd` unchanged. Manual orders are sized by the operator and ignore the multiplier. |

Exposure: `robinhoodReadiness().primary = { symbol, weight }`, `Snapshot.strategy.primary = { symbol, weight, orderMult }`, `Preview.primary:boolean`. The HUD tape table badges the primary row `PRIMARY x<weight>`. The default universe became `BTC-USD,ETH-USD,SOL-USD`.

## 22. Evolution (paper-only self-improvement)

The trader carries a miniature of the Evolution Lab's evolve -> score -> promote loop (`money-printer-evolution-lab/src/evolutionSearch.js`, `evolutionScoring.js`, `evolutionEngine.js#promotionImproves`) that is self-contained, fail-closed and touches the **paper** strategy only. It never imports the Solana scanner, the Lab, or `src/learner.js`; the Lab's `paperPromotionAllowed` gate has its counterpart here in `ROBINHOOD_EVOLVE_AUTOPROMOTE` (default `false`), and real autopilot is never a promotion target.

### 22.1 Durable tape — `src/robinhoodTape.js`

- Every quote the loop samples (`paperPass` -> `J.appendTape`) is also buffered by `bufferTape(symbol, {t, bid, ask})`; malformed, crossed or repeated timestamps are dropped. `flushTape({force, now})` appends the buffer to `<DATA_DIR>/robinhood-tape/<SYMBOL>.ndjson` (rows `{"t","bid","ask"}`) at most every `TAPE_FLUSH_MS = 30000` unless forced; the tick flushes when due, `stopRobinhoodLoops()` and an evolution run flush forcibly. fs failures are returned as `{error}` and noted in `lastError` (`stage:'tape'`); they never throw into the tick and the rows stay buffered.
- The first flush after `COMPACT_EVERY_MS = 6 h` compacts every file to the newest `TAPE_KEEP_DAYS = 45` (atomic tmp + rename). `loadTape(symbol, sinceMs)` returns `[{t, bid, ask, mid}]` oldest first, deduped, including unflushed rows; `tapeCoverage(symbol)` returns `{rows, firstAt, lastAt, days}`.
- The in-memory 720-sample tape in `robinhood-paper.json` remains the live-signal source; the files feed only the replay below.

### 22.2 Replay — `src/robinhoodBacktest.js` (pure)

`backtestTape(samples, {params, feeRatio, orderUsd, startUsd})` walks the samples through the same strategy functions the paper pass uses (`computeFeatures` over a 720-sample window ending at the current sample, `entrySignal`, `exitSignal`, `sizeOrder`, `paperBuyFill`, `paperSellFill`, `cooldownUntil`), one position per symbol, fees on both legs, no look-ahead, and returns `{closes[], metrics:{closes, wins, hitRate, profitFactor, pnlUsd, feesUsd, maxDrawdownUsd, exposureMin, tradesPerDay, avgHoldMin, samples, spanDays, entries}}`. Deterministic; no clock, env, fs or randomness. `walkForwardSplit(samples, 0.7)` -> `{train (older 70%), test (newest 30%), cutAt}`. The Bitcoin-primary weight is not applied here.

### 22.3 Search and scoring — `src/robinhoodEvolve.js`

- Candidates are bounded mutations of the current paper params (`mutateParams`, 2-4 keys per candidate, local nudge or global jump, deterministic `mulberry32` seed per generation): `emaFast 5-30`, `emaSlow 20-120` (fast < slow enforced), `lookbackSamples 30-240`, `costMultiple 1-3`, `takeMult 2-8`, `stopMult 0.5-2`, `trailArmMult 1-4`, `trailMult 0.5-2`, `maxHoldMin 30-720`, `maxSpreadBps 10-80`, `breakoutBufferPct 0-0.002`, `fadeExit` bool. Every other key (sampleMs, warmup, slippage, cooldowns...) is inherited unchanged; `withinEvolveBounds` is re-checked before APPLY.
- Each candidate is replayed per configured symbol (`ROBINHOOD_PRIMARY_SYMBOL` ∪ `robinhoodSymbols()` ∪ paper autopilot symbols) on the walk-forward split of the newest `ROBINHOOD_EVOLVE_MAX_TAPE_DAYS` of tape. `scoreSymbol` = test profit factor capped at 5, scaled by `closes/20` below 20 closes, halved when test drawdown exceeds 3% of the paper start, quartered when test P/L is not positive, divided by `1 + max(0, trainPF - testPF)` (overfit gap). `compositeScore` is the weighted mean across symbols with `{[primary]: ROBINHOOD_PRIMARY_WEIGHT}`.
- `searchGeneration` evaluates the incumbent (current paper params) first, then up to `ROBINHOOD_EVOLVE_CANDIDATES` (default 24) distinct mutations, yielding with `setImmediate` between candidates and stopping when the 20 s budget is exceeded (`timedOut:true`). `beats = best.score > 0 && best.score >= incumbent.score * (1 + ROBINHOOD_EVOLVE_MIN_GAIN)` (an incumbent scoring 0 is beaten by any positive score).
- Ledger `<DATA_DIR>/robinhood-evolve.json`: `{version:1, generation, champion:{params, paramsHash, score, metrics, bySymbol, at, generation}|null, incumbent, applied:{paramsHash, at, by}|null, history[<=100]:{generation, at, elapsedMs, timedOut, evaluated, symbols, tapeDays, incumbentHash, incumbentScore, bestHash, bestScore, gainPct, beats, promoted}, events[<=50]:{at, type:'champion'|'applied', text, ...}, lastRunAt, lastError}`; atomic writes; a corrupt file loads as the default with `lastError.stage:'load'`.

### 22.4 Scheduling, promotion and the HUD

- `runRobinhoodEvolveOnce({manual})` in `src/robinhoodAutoTrader.js` (`evolveBusy` lock): returns `{ran:false, reason:'disabled'}` unless `ROBINHOOD_EVOLVE_ENABLED === 'true'` or the run is manual (the default is off), `paperRecovery` when the paper book needs recovery, `insufficientTape` (with `tapeDays`) unless the primary symbol has >= `ROBINHOOD_EVOLVE_MIN_TAPE_DAYS` (3) of tape and every replayed symbol has at least 3x warmup samples. The loop tick schedules it (fire-and-forget, outside `tickBusy`) at most every `ROBINHOOD_EVOLVE_INTERVAL_MIN` (360) while the loop timer is running; the check itself is throttled to once per 5 min. Result `{ran:true, generation, evaluated, timedOut, elapsedMs, incumbentScore, bestScore, bestHash, gainPct, beats, proposed, promoted, tapeDays}`.
- A champion that `beats` the incumbent is recorded in the ledger and **proposed**: the HUD's EVOLUTION fieldset shows generation, tape coverage per symbol, the incumbent-vs-champion metrics table (score, closes, hit rate, PF, net P/L, drawdown, trades/day), RUN NOW, APPLY TO PAPER and the autopromote status. Nothing changes until APPLY.
- `applyRobinhoodEvolution({paramsHash})` (HTTP `POST /api/robinhood/evolve/apply {paramsHash}`) requires the hash to equal the ledger champion, re-checks the bounds, then calls `setRobinhoodPaperAutopilot({params: champion.params})`: the paper `paramsHash` changes, qualification restarts from zero closes for the new hash (section 9), and a real autopilot that was enabled is disabled with `disabledReason:'paramsChanged'`. Real autopilot settings, the real journal and `ROBINHOOD_REAL_ENABLED` are never touched. The ledger records `applied` and an `applied` event. With `ROBINHOOD_EVOLVE_AUTOPROMOTE=true` the run applies the champion itself (`by:'autopromote'`, `history[0].promoted:true`); the default is propose-only, matching the Lab's `paperPromotionAllowed:false` posture.
- Snapshot: `evolve: { enabled, running, generation, champion, proposed, incumbent, applied, currentParamsHash, tapeDays:{symbol: days}, minTapeDays, lastRunAt, nextRunAt, intervalMin, candidates, minGainPct, autopromote, history[10], events[10], lastError, tape }` (also `GET /api/robinhood/evolve`). `proposed` is the champion while its hash differs from the current paper hash.
- Invariants kept: no network in any evolution path (the replay reads files only), nothing is signed, `sessionArmed` is untouched, and the evolution never writes to `robinhood-auto-trader.json` except through the existing `disableAutopilot('paramsChanged')` path.

