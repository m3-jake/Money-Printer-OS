# Robinhood recovery - 2026-09-25

## Delivery status

Version 0.5.0-alpha.56 is a **paper-only recovery candidate**, not a live-trading release.
The unfinished design branch and seven untracked foundation/test files were preserved before editing.
Original backup: `W:\mpo-robinhood-recovery-20260925-120332` on WITCHDOCTOR.
Source: `W:\money-printer-os`, branch `feature/robinhood-auto-trader`.
Evolution Lab, installed applications, actual account balances, and credentials were not changed.

## Working in this candidate

- Standalone Robinhood Auto Trader desktop window, retaining the existing layout and styling.
- Read-only account/quote integration with corrected official v2 field mappings.
- Fee/slippage-aware simulated buys, exits, cash accounting, duplicate protection and position caps.
- Paper strategy loop, editable settings, conservative evidence qualification, and strategy hash isolation.
- Explicit manual reset, corrupted-book recovery, failed-write rollback and input-draft preservation.
- Loopback/same-origin JSON routes, no real-order HTTP routes, and update guards for saved real exposure.

Real order placement, cancellation, arming, live autopilot, browser credential saving, and real-order reconciliation are **not installed**. The corresponding exported controller operations reject or return an explicit non-executing status. `ROBINHOOD_REAL_ENABLED=true` cannot enable execution in this build. Existing real journals remain read-only; inspect outstanding orders directly at the broker.

The recovered low-level transport still contains future live-order helpers. Their presence is not evidence that live execution is production-ready. Live work still requires a complete state machine, reconciliation/retry audit, sensitive diagnostic-log review, authenticated broker validation and a separately authorized deployment.

## Verification

`npm run test:all` passed: 477 test executions across the repository's test commands, including 107 Robinhood tests. Some shared tests are invoked by more than one command; 477 is not a unique-test count.
`npm run selftest` passed with an isolated temporary data directory.
An isolated Chrome smoke test passed 10 UI/workflow checks using synthetic quotes: 11 mocked read requests, zero broker writes, zero browser runtime exceptions.
The Windows installer was syntax-parsed, not executed. No installer, native Electron boot, Mac build, release publication or actual brokerage authentication was performed.

## Reproduce and maintain

Run `npm run test:robinhood` for the feature tests and `npm run test:all` for the repository regression command. Both must pass before packaging.
Edit `public/assets/robinhood-panel.js`, then run `npm run sync:robinhood-panel`; the test suite verifies its embedded copy in `public/dashboard.html` matches.
Run `node scripts/robinhood-browser-smoke.mjs <absolute-screenshot-path>` on Windows with Chrome or Edge installed. It creates a disposable profile and paper book, never loads the app's credentials, and blocks non-local browser DNS.
Test logs and the verified screenshot are retained in the recovery backup directory, outside the repository.

## Read-only connection

The paper engine needs current market data. Configure read-only Robinhood Crypto API credentials through the existing local environment configuration, then restart the source application: `ROBINHOOD_API_KEY` and `ROBINHOOD_PRIVATE_KEY` (base64 Ed25519 32-byte seed). Do not commit the local environment file or give this paper-only application trading permissions.
Leave `ROBINHOOD_REAL_ENABLED=false`. The normal sampler is idle until paper autopilot is enabled or paper positions need exit checks; `ROBINHOOD_AUTOSTART=false` disables its timer for tests. The default interval is 15 seconds and default warm-up is 120 observations. Opening the panel alone does not start paper entries.
The default bank is a simulated USD 1,000. All displayed paper balances, fills, costs and qualification badges are simulations, not a statement of actual returns or proof of future profitability. Reset affects only that simulated book.

## Official API references checked

- Robinhood Crypto API documentation: https://docs.robinhood.com/crypto/trading/
- Robinhood API support: https://robinhood.com/us/en/support/articles/crypto-api/

The current v2 schema uses `fee_tier_status.fee_ratio`, `bid` / `ask`, `/api/v2/crypto/trading/estimated_price/`, and `est_fee` / `est_total_cost` / `est_total_credit`. The recovered code previously missed several of these fields. These mappings were verified against the official documentation's embedded OpenAPI schema and covered with offline fixtures; they were not authenticated against a real account.
