# MPOS unification — implementation record

## Baseline (2026-09-26)

The existing application runs with Node 24.16.0, using `node src/index.js --dashboard-only` on an isolated temporary data directory. Browser inspection confirmed the desktop, taskbar, window manager, and Pump.fun paper view. No installed trading data or credentials were used.

The repository was already dirty: dashboard, Robinhood, package metadata, design assets, and new practice/research modules belong to earlier work. Preserve these changes. Agent Lab is not part of this implementation.

| System | Implementation | Migration decision |
| --- | --- | --- |
| Frontend | Plain JavaScript in public/dashboard.html, CSS, generated Robinhood panel | Extend the existing window registry; retain MPOS branding and layout persistence |
| Backend | Node ESM, native HTTP server, timers and subprocesses | Extend the current server; no replacement runtime |
| Desktop/update | Electron main.cjs, supervised Node services, signed Ed25519 manifest and SHA-256 archives | Preserve packaging and update verification |
| Storage | Atomic account JSON, append NDJSON, node:sqlite research/economics stores | Add versioned core SQLite tables; explicit migration coverage for legacy books |
| Solana | Dexscreener, Jupiter, Jito, RPC/holder analysis, strategy and position execution | Preserve paper engine and RPC budgeting; fence live transport centrally |
| Polymarket | Global paper/sports, US SDK credentials, US combos/RFQ, evidence | Reuse combo execution and settlement; distinguish global and US venues |
| Robinhood | Signed official crypto transport, paper/practice books, tape, equities research | Preserve current book semantics; no unofficial equities API |
| Experiments | replayLab, executableReplayEvaluator, experimentLane/Registry, evidence gates | Preserve walk-forward/replay; extend availability-time provenance |
| Monitoring | resourcePolicy, dashboard health, API unit economics, worker status | Report measured or unavailable values |
| Network | UDP/HTTP mesh and signed external Evolution Lab advisory link | Preserve existing transport; no automatic live authority |
| Journal | market/action NDJSON, projectJournal, lifecycle milestones | Add risk and ledger milestones to existing project journal |
| Secrets | Environment files, provider signing modules, per-session arming | Keep secrets server-side; centralize new configuration |

The full baseline `npm run test:all` reached three failed pinned response-shape assertions in Robinhood tests: the pre-existing practice book adds `practice`. The tests need to cover that additive field. Other completed suites passed. Tests after the first failing script must still be run.

Fragile areas: the large inline renderer and HTTP dispatcher; multiple portfolio currencies/books; local kill switch only for Solana; global and US Polymarket are distinct products but appear under overlapping names; some legacy docs imply stronger execution locks than transport code enforces. The extracted Robinhood panel is an intentional generated mirror, not dead code. No module is declared dead from filename alone.

## Foundation contract

New modules use canonical source-qualified IDs, recorded source/availability times, provider adapters, and `mpos-core.sqlite`. Source facts and analyst relationships remain distinct. Unknown fees, settlement terms, timestamps, or portfolio coverage remain unknown.

Ledger entries are append-only, idempotent, separated by venue/account/currency/execution mode and retain source references. No inferred deposits or invented opening balances. Legacy books remain visible as legacy coverage until an explicit reconciled import exists.

All new orders go through proposal validation and the Risk Governor. Live adapters require explicit implementation and reconciled account coverage. Emergency halt persists across restart and blocks further submission, including legacy transports; it does not claim to cancel already submitted venue orders.

## Provider references

- Kalshi public market data: https://docs.kalshi.com/getting_started/quick_start_market_data
- Kalshi order book: https://docs.kalshi.com/api-reference/market/get-market-orderbook
- Polymarket global market metadata: https://docs.polymarket.com/api-reference/markets/list-markets

Kalshi uses fixed-point dollar strings and reciprocal YES/NO bids. Do not interpret dollar strings as cents. Global Polymarket CLOB token IDs must stay distinct from US market slugs.

## Architecture as built (2026-09-26, batches M–AE)

Everything below lives in `src/core/` behind `/api/platform/*` (`src/core/http.js`, localhost + same-origin + JSON for mutations) and one `MarketPlatform` instance (`src/core/platform.js`) that owns `mpos-core.sqlite`. Each desktop window is a small renderer in `public/js/` that reads those endpoints. Window names are plain ("Kalshi", never "KALSHI.EXE").

| Layer | Module | What it does |
| --- | --- | --- |
| Core | `model.js`, `database.js`, `eventBus.js` | Canonical entity kinds and source-qualified IDs; `observedAt` vs `availableAt` on every entity; append-only ledger/transition triggers; bounded event bus (`MARKET_PRICE_UPDATED` … `RISK_STATE_CHANGED`, `SEC_FILING_RECEIVED`, `SPORT_EVENT_UPDATED`, `WALLET_ACTIVITY`, `NEWS_RECEIVED`) |
| Core | `ledger.js`, `risk.js`, `executionBoundary.js` | Unified fixed-point ledger (portfolio reconstructed from entries only); Risk Governor GREEN/YELLOW/RED/HALTED with persistent STOP; every live transport refuses while accounts are unreconciled |
| Providers | `predictionProviders.js`, `provider.js` | Kalshi (series fee model + settlement source, strikes, events) and Polymarket (named-outcome binaries, fee schedule, public search); health IDLE/CONNECTED/DEGRADED/DISCONNECTED/AUTH ERROR/STALE |
| Providers | `brokers.js`, `macro.js`, `edgar.js`, `weather.js`, `sports.js` feeds, `wire.js` RSS | Alpaca IEX quotes (key), FRED CSV/ALFRED vintages (key for as-of), SEC EDGAR (declared User-Agent required), NWS + NHC, MLB Stats API + NHL web API, Fed/BEA/CFTC RSS |
| Engines | `contractTerms.js`, `contracts.js`, `fees.js` | Contract propositions → STRONG/RELATED/NOT EQUIVALENT; EXACT only by human attestation bound to rule-text fingerprints; venue taker fees per fill |
| Engines | `strategies.js`, `labSync.js`, `replay.js` | Strategy registry + lifecycle + multi-criteria promotion gate; Lab champions mirrored through it; availability-ordered replay, walk-forward, seeded Monte Carlo, reproducible `lab_runs` |
| Engines | `correlation.js`, `whales.js`, `legacyBooks.js`, `comboPerformance.js` | Event pages (one event → many markets); Solana wallet graph/flags; read-only legacy books; combo performance with Wilson CI |
| Apps | Command Center, Kalshi, Polymarket (Live combos / Markets / Positions / History / Performance), Arbitrage, Stocks, Market Lab, Macro, EDGAR, Weather, Sports, Wire, Whale Watch (Solana tab) | `public/js/mpo-*.js` |

### Rules every module follows

- **Facts vs analysis.** Venue/agency data is stored as fact with its own timestamp. Links, catalysts, entities, importance, sector exposure and flags are labelled RULE_BASED / SPECULATIVE / HEURISTIC and never written into the facts. No language model is used anywhere in the core.
- **Availability time.** Backtests and replays reveal records by `availableAt`: candle-derived tape rows at candle close, Alpaca bars at bar close, FRED vintages at end of the publication day (ET), SEC filings at acceptance time, RSS items at min(published, received).
- **Unknown stays unknown.** Missing fees, terms, quotes, keys or metrics are shown as unavailable and block any number that would depend on them (locked returns, orders, as-of history).
- **No real money.** PAPER and MANUAL_APPROVAL only; LIVE is refused by the proposal path, the broker, the strategy registry and the execution boundary.

### Keys that unlock more (all optional; nothing is borrowed or invented)

| Setting (`%APPDATA%\Money Printer OS\.env`) | Unlocks |
| --- | --- |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | Stock quotes (Stocks orders), Market Lab minute-bar replay, equities lane bars |
| `FRED_API_KEY` | As-of (vintage) macro history for backtests |
| `SEC_USER_AGENT="Name you@example.com"` | EDGAR filings (SEC requires a declared contact) |
| `NWS_USER_AGENT` | Optional contact in NWS requests |

## Remaining work (not done)

- Live venue certification and account reconciliation (policy: no real money).
- A reconciled import of legacy books into the ledger (they are shown read-only).
- Event pages for sports, weather and corporate events (they exist in their own windows and the Wire).
- Kalshi event-level fee overrides; soccer three-way, player-prop and non-sports contract terms.
- Distributed Market Lab sweeps (the Evolution Lab/Furnace does heavy search).
