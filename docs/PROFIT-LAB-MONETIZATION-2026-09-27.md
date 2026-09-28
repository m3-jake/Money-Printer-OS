# Profit Lab — Research Pro monetization v1

Status: QUEUED
Priority: 2 — monetization
Prepared: 2026-09-27; refreshed: 2026-09-28
Target branch: profit-lab/monetization-pro-v1-20260925
Current GitHub main observed: eba1bc5bd905688c6ca36fe8b2858250ce983922 (0.5.0-alpha.75)
Observed branch delta: 0 ahead / 23 behind main; fast-forward before applying the patch.

## Why this is the next profitability task
Revenue and funnel instrumentation is already implemented through product economics.
Fresh alpha.75 verification still finds no monetization module, monetization test script, entitlement gate, or upgrade-required flow on `main`.
Do not rebuild instrumentation. The next missing layer is a paid tier tied to clear read-only research value.

## Product boundary
Free keeps the existing dashboard, manual paper workflow, core monitoring, and
GET /api/research-monitor.

Research Pro gates only:
- GET /api/research-control-plane
- GET /api/project-journal

Do not gate or modify trading, execution, arming, settlement, live/paper mode,
risk limits, position management, or kill switches.

## Activation conditions
Monetization must remain disabled unless ALL are deliberately configured:
- MONEY_PRINTER_MONETIZATION_ENFORCE=true
- MONEY_PRINTER_PRO_PRICE_USD=<positive USD price>
- MONEY_PRINTER_CHECKOUT_URL=https://...
- MONEY_PRINTER_LICENSE_PUBLIC_KEY_PEM=<Ed25519 SPKI public key>
