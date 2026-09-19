# Research evidence pipeline

This branch keeps backtest winners research-only until they have auditable executable evidence. It does not authorize real-money promotion.

## Persistent evidence

- Freeze manifest: canonical candidate/incumbent parameters and code version are hashed and written create-only.
- Trial ledger: every searched configuration is appended to NDJSON; the whole ledger receives a SHA-256 fingerprint.
- Sealed registry: dataset/window identities are atomically consumed once. Restarts and competing processes cannot create a second final audit.
- Grouped interval: paired candidate-minus-incumbent returns are aggregated inside each independent event/group before uncertainty is calculated. The interval uses a Bonferroni-adjusted family-wise alpha over all recorded search trials.

## Evaluators

Solana uses the isolated executable path replay evaluator. Endpoint-only five-minute labels remain proxy-only and cannot establish promotion evidence. Missing/stale paths fail closed.

Polymarket uses the independent as-of tape evaluator. Historical executable depth and fee observations are required; the repository does not currently contain a historical quote/depth/fee tape, so that module correctly remains blocked.

## Experiment Monitor

`research-evidence-monitor.json` is read alongside existing research telemetry. Each module exposes candidate/incumbent identity, stage, net improvement, drawdown, interval, independent-group count, coverage, search-trial count and concrete blocked reasons.

Stages remain `RESEARCH_ONLY`, `PAPER_COMPARISON`, and `REVIEW_READY`. `livePromotionAllowed` is always false.

## Canary

Run `npm run evidence-canary -- --out artifacts/evidence-canary/STATUS.json`. The default canary intentionally has no frozen candidate or observed dataset; it verifies both modules fail closed and lists the evidence still needed. Supplying `--monitor <path>` writes the same research-only status in monitor format.