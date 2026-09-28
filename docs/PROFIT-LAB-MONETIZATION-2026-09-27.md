# Profit Lab — Research Pro monetization v1

Status: QUEUED
Priority: 2 — monetization
Prepared: 2026-09-27
Target branch: profit-lab/monetization-pro-v1-20260925
Current GitHub main observed: 1733a51b87c345813857973d10e872a0aa0aec72 (0.5.0-alpha.63)

## Why this is the next profitability task
Revenue and funnel instrumentation is already implemented through product economics.
Do not rebuild it. The next missing layer is a paid tier tied to clear read-only research value.

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
