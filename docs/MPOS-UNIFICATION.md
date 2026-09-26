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

## Remaining phase gates

Phase completion requires executable tests and a running desktop. Account reconciliation and live venue certification, a full legacy-ledger migration, advanced strategy lifecycle, and additional data subscriptions are separate work items; a registry entry or empty window does not complete them.
