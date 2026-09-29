# Profit Lab — Research Pro alpha.78

Status: ACTIVE profitability task.

Baseline verified 2026-09-29:
- main: 0.5.0-alpha.78
- main commit: a2f7a249400fdda0a372c544fafa44ebde948cde
- product-economics/funnel instrumentation is already present; do not duplicate it.
- current main has no Research Pro implementation.

## Single task

Finish the checkout → entitlement → paid-attribution loop for a Research Pro tier.

Scope:
- signed, install-bound Ed25519 entitlement
- fail-open configuration: price, checkout URL, public key, explicit enforcement flag must all be valid before any paywall enforces
- GET /api/monetization
- localhost-only POST /api/monetization/activate
- gate only GET /api/research-control-plane and GET /api/project-journal
- structured HTTP 402 upgrade_required response for configured free users
- Upgrade and Activate License actions in Product Economics
- checkout carries plan, install_id, visitor_id; checkout backend remains authoritative for price
- signed activation records an idempotent payment event through productEconomics using the anonymous visitor + verified user identity so original acquisition attribution is preserved

Do not touch trading, order execution, paper/live mode, risk, arming, settlement, or loss limits.

## Acceptance

1. Unit tests cover disabled/incomplete config, structured 402, checkout attribution, valid activation/payment, wrong install, expired entitlement, wrong key, and tamper rejection.
2. HTTP integration test proves both Pro routes return 402 before activation, become 200 after a valid signed activation, and the product ledger reports one payer, the payment revenue, and the visitor's original source.
3. Add test:monetization to package scripts and test:all.
4. Run git diff --check.
5. Run npm run test:monetization.
6. Run npm run test:product-economics.
7. Run npm run test:all.
8. Merge only if all gates pass.

Prepared entitlement-core unit suite has already passed 9/9 outside the repository; repository-wide validation is still required.

## Next after merge

Connect the real checkout/signing backend and run one test transaction end to end:
visit → activation → checkout → signed entitlement → paid attribution.
