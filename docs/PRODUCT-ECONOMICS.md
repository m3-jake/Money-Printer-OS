# Product economics and pilot instrumentation

The System → Product tab and `GET /api/product-economics` report the local, durable product ledger. It lives in `MONEY_PRINTER_DATA_DIR/product-economics.sqlite`, independently of trading resets. Keep the SQLite database and its WAL together when backing up a running app, or stop the app before copying it. Visits, verified signups, activation, paid conversions, refunds, acquisition, serving, payment-processing and support costs are separate events. Trading balances, wins, losses and trade fees never enter this ledger.

## What is connected now

- Loading the actual dashboard records an anonymous visitor with an HttpOnly, signed visitor cookie. Refreshes in the same UTC day/source are idempotent. No IP, email, raw referrer URL, or browser fingerprint is saved.
- The first successful `POST /api/polymarket-us/combos/build` (two or more live legs priced into a combo) records activation for that visitor. Until 2026-09-25 activation was the first manual Polymarket paper order; the paper lab has since been detached from the dashboard, so its routes no longer exist. A build is pure math: it places nothing and moves no money. Rejected builds, quotes, placements, autopilot activity and real-wallet activity do not manufacture conversions. A successful build is a first-value milestone, not evidence that a customer earned money.
- First non-direct source/channel/campaign/referral is retained across verified identity links and is frozen at the first signup, activation or payment. A campaign visit after conversion cannot rewrite the acquisition cohort or earlier revenue/cost attribution. URLs can carry `utm_source`, `utm_medium`, `utm_campaign`, and an opaque `ref`; do not put personal information in them.
- Anonymous visitors remain distinct until the server records a verified `identify` or `signup` event with both `anonymousId` and `userId`. A single anonymous identity cannot be reassigned to another account. Cookies cleared or separate devices remain separate without a verified link.
- D1/D7/D30 retention means a visit or activation on that exact UTC day after first activation; only completed target days enter the denominator. Source/user margins, support minutes, CAC and serving cost per active user are available in the API.

## External integrations still required

This repository currently has no customer authentication, signup, checkout or payment provider. No paid customer or revenue is inferred from using the app. Connect verified identity and payment producers before claiming a customer funnel. The existing API unit economics ledger measures trader provider use at configured rates, without customer identity or an invoice feed; it is deliberately not copied into product accounting as actual per-user spend.

The signed server ingest boundary accepts real provider events and cost records, but is disabled unless `PRODUCT_ECONOMICS_INGEST_TOKEN` is at least 32 characters. Configure a random secret in the backend environment; never put it in renderer code, URLs, or public builds. Send `Authorization: Bearer <secret>` from a trusted server. Requests with any browser `Origin` are rejected. Reports require localhost or the same server token. A public deployment also needs TLS and a real authenticated reporting gateway.

`POST /api/product-economics/event` accepts a JSON event. `eventId` must be stable across retries; identical repeats do nothing, conflicting reuse is rejected. `timestamp` is epoch milliseconds and may be omitted for receipt time. Supply the same timestamp on retries if supplied initially. Supported types are `visit`, `signup`, `identify`, `activation`, `payment`, `refund`, `acquisition_cost`, `serving_cost`, `payment_fee`, and `support_cost`.

Payments and refunds require verified `userId`, `currency: "USD"`, positive numeric `amountUsd`, `provider`, and the provider's unique transaction `reference`. Refunds additionally require `originalEventId` of the payment and cannot exceed its remaining amount. The provider/reference pair is unique per event type even if a caller changes the event ID. The upstream payment adapter must verify the provider webhook signature and the actual captured/refunded payment, then map the customer to a verified account; the generic ingest token is not a payment-provider webhook signature.

Costs require `currency: "USD"` and either a measured nonnegative `amountUsd` or `amountUsd: null` with `unknownReason`. Acquisition costs may be attributed to a source without assigning them to a user. Serving/support/payment fee events require an opaque user/anonymous ID. Support events may include actual `supportMinutes`. Explicit zero costs are permitted only when known to be zero. Resolve an unknown cost with a new measured cost of the same type/identity/attribution and `replacesEventId`; the original is retained for audit but excluded from totals. A support-cost resolution inherits previously recorded support minutes if omitted and rejects a conflicting value. No existing money record can be edited.

Example shape for a trusted payment adapter (illustrative placeholders, not recorded data):

```json
{"eventId":"provider:payment:unique-event","type":"payment","userId":"verified-account-id","provider":"configured-provider","reference":"captured-payment-id","currency":"USD","amountUsd":29}
```

Contribution stays unknown until every cost category has at least one priced record and no unpriced costs remain. `knownCostContributionUsd` is revenue less the costs received so far, not a claim of complete profitability. Even complete category coverage does not prove every bill was received; reconcile provider statements and the reporting period. CAC uses recorded acquisition spend divided by recorded paying users and is not a cohort/time-window causal estimate. CAC and cost per activation remain available when acquisition costs are priced even if another cost category is unknown; serving cost per active user similarly requires only priced serving costs. `unpricedCostsByCategory` exposes the category-specific gaps. Unallocated source costs do not become invented per-user costs. Mixed currencies are rejected pending an explicit, audited exchange-rate conversion upstream.

## Small pilot runbook (prepared, not run)

1. Choose 3–5 consenting pilot users and a single first-value task: open the Polymarket window, tick two or more live legs and get a priced combo build. Keep the session unarmed for the pilot, so nothing can be placed. Use opaque account IDs and unique acquisition links.
2. Connect actual signup/auth and verified payment events, or explicitly run an unpaid usability pilot. An unpaid pilot cannot validate willingness to pay. Agree a real offer before collecting payment; no checkout or price is fabricated by this implementation.
3. Record actual acquisition spend, provider/agent serving costs, payment processing fees and support minutes/costs, including confirmed zeroes and unresolved unknowns. Compare provider transaction IDs and receipts with ledger totals; test one retry and one refund through a test account before live billing.
4. Set acceptance criteria before the pilot: successful first task, user return on D1/D7, acceptable support effort, measured cost coverage and a contribution target backed by the real offer. Record the criteria and start/end dates externally; do not revise them after seeing results.
5. Review the Product tab and source/user API report after the fixed window. Report the actual sample size, incomplete costs and matured retention cohorts. Decide whether to keep the offer, fix the first-value flow, or stop the pilot. No automated outreach is implemented or sent.

Start from an empty ledger for real production data. Automated tests use isolated temporary directories. Do not import test payments or synthetic visits into the production ledger.
