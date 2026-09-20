# Money Printer OS alpha.41 — execution and turnover

> HISTORICAL — alpha.41, superseded by `.agent-state/`

Source baseline: alpha.40 commit `61077bb`, inspected on the Mac on September 15, 2026. Windows was offline.

## Findings

- Solana paper history contained 1,190 closed trades at inspection. The latest six-hour slice had 549 closes and approximately -0.633 SOL realized P/L. This is a snapshot, not evidence of a profitable strategy.
- Repeated Dexscreener HTTP 429 responses interrupted data. The old held-position loop made one request per position every cycle, before discovery and research requests.
- Three held positions had thousands of rejected price updates. Exact-pool prices repeatedly reported 98–99% drops; the old guard kept their prior marks indefinitely.
- Polymarket US credentials were present, but authenticated requests returned `401 API key not found`. The session was disarmed. Real execution requires working credentials and the app's existing controls; combo/RFQ access remains unverified.

## Changes

- Batch up to 30 held pools in one request, with exact base-token/pool identity checks. A 16-position fixture drops from 16 calls to one. Five-second held-price cache, shared 20-second discovery reads and 30-second outcome reads reduce duplicate requests.
- Abort timed-out requests; coalesce in-flight requests; bound cache size and request volume; honor Retry-After with increasing host-wide backoff. Never pass expired cache data off as a new quote.
- Paper-only recognition of a drastic decline requires three distinct exact-pool observations over at least 15 seconds. Huge upward discontinuities and live-account discontinuities remain quarantined. Corrections are journalled and may lower previously overstated paper equity.
- Paper exit impact uses current sale value. Exit fees apply to sale proceeds; break-even includes entry fees, exit fees and slippage. The SPRINT control now accepts its own preset. Rejected candidates no longer block all candidates below the first five; the existing fill/position/exposure limits still apply.
- US combo stake is a total budget including rounded fees. RFQs reserve fee headroom; limit-order sizes and quote acceptance obey the same cash cap. Expired quotes and aging cached legs fail validation.
- US combo selection skips open games and cooldowns. BBO refreshes use four concurrent requests and require successful fresh quotes; rankings update after price changes.
- Missing remaining-order quantity no longer implies a full real fill. Reconciliation preserves the entry-time fee schedule across the announced fee change.
- Global Polymarket paper buy estimates spend only the specified budget across asks. Early cash-outs walk bid depth, include selling fees and require positive net proceeds over the original stake. Insufficient depth cannot produce a fabricated profitable exit.
- Provider backoff and held prices awaiting verification are visible in health diagnostics.

These are execution and accounting fixes. They do not establish an investment edge or guarantee faster profits. Historical paper results are preserved, not retroactively recomputed. No real trade was placed, and credentials, stake caps and real-trading arm/confirmation settings were not changed.

## Validation

All 55 targeted regressions passed on the Mac. Alpha.41 was installed and restarted; the running API reported version 0.5.0-alpha.41 and HEALTHY, with all 13 then-held positions showing fresh prices. The request manager recovered from one startup rate-limit response and reported 26 requests, 36 cache hits and zero timeouts at the first post-restart inspection. The three previously stranded symbols were no longer open. This short runtime check establishes operation, not future profitability.

Installed archive SHA-256: `a0a460636a1794525fe12797b9e7181814f44975891d0a25b8a434de7a6c6f2b`.

Run `node --test tests/execution-turnover.test.mjs tests/polymarket-us-combos.test.mjs tests/sports-turnover.test.mjs tests/polymarket-us-safety.test.mjs tests/store-recovery.test.mjs` in the complete source checkout. All network/order behavior in these regressions is mocked and account files use temporary directories.

## References

- [Dexscreener API reference](https://docs.dexscreener.com/api/reference): batched pair/token reads and request limits.
- [Polymarket US fee schedule](https://docs.polymarket.us/fees): rounded fees and September 16 fee change.
- [Polymarket US BBO](https://docs.polymarket.us/api-reference/markets/get-market-bbo): public quote fields.
- [Global Polymarket order books](https://docs.polymarket.com/market-data/prices-order-books): executable prices and available depth.

## Rollback

The alpha.40 checkout remains untouched. The installer preserves its installed `app.asar` and the account files in a dated backup before swapping alpha.41 into the existing Mac app. Restore only the prior app archive to roll back code; restore account data only when explicitly recovering a ledger.
