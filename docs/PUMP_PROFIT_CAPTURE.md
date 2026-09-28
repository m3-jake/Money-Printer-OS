# Pump profit capture: alpha.74 + Evolution Lab alpha.15

This is a PAPER-only, paired-system instrumentation and bounded research release. It does not establish that a larger bet is profitable and does not promote a new profit-capture champion.

## Applied changes

Pump exact-input simulated buys now respect requested SOL; trading fees must fit outside that notional without spending the configured reserve. Modeled fills are no longer timestamped before submission. Missing/zero liquidity rejects a fill. New positions retain entry SOL/USD and use current SOL/USD for SOL valuation and exits. Untagged old positions retain legacy valuation; missing exchange-rate history is not invented. Historical positions, fees and cash postings are not rewritten. Configured position/exposure ceilings and explicit operator ceilings cannot be relaxed by Lab synchronization. New exits are pinned at entry. Positions already open at upgrade retain the policy that was in force immediately before the upgrade, explicitly distinguished from unknown entry-time policy.

Control Bay, Pump.fun and Command Center expose owner, complete effective policy/hash, requested/allowed/filled SOL, binding limits and provisional comparisons. The paired Lab independently checks protocol/baseline hashes and cash identities. Cash reconciliation is not proof of historical executable fills. The old unified Solana mirror remains unverified when partial-posting receipts are missing.

## Bounded experiment

`pump-profit-baseline.json` is create-once. `pump-profit-protocol.json` predeclares seven policies: unchanged baseline; 1.25/1.5/2 requested-size multipliers; three exit-only alternatives. No experimental cap increases are authorized. There are 21 separate books at equal starting cash per policy: the frozen authoritative available cash, 0.15 SOL and 0.25 SOL. Open assets are not fictitiously liquidated into the current-cash scenario; this is not a reconstructed current-inventory replay.

Discovery lasts 24 hours, followed by a maximum-hold plus 120-minute embargo and a 48-hour validation window. Mint and related-cluster overlap is purged. Holdout metrics are hidden during validation. Maximums: 256 total opportunities, 128 per phase, three new opportunities per hour and 524,288 observations. Shared inputs/quote requests are deduplicated. Hash-chained input frames and full quotes are retained under `data/pump-profit-evidence/<protocolHash>/`, outside the rolling generic-tape pruner. No historical P&L is multiplied. Each book accounts for its own cash, reserves, pending commitments, overlap and inventory. The same pool/slot cannot be reused within one book.

Only keyless public GET quotes are collected: at most 4,096 calls per study, 180/hour, four per batch, spaced at least 2.1 seconds. Full routes, exact input/output, minimum output, slot and request/receipt times are retained. No keys, signing, swap construction or transaction submission are used by this collector. Missing quotes/decimals/observations do not create fills. Exact-size quotes are not transaction receipts. Network charges use an explicitly provisional base-fee estimate; priority/rent/failure costs and transaction-success calibration remain unknown.

## Qualification and limitations

Adaptive sizing is implemented as a pure, tested policy but is NOT applied. Increases require independently validated, after-cost group evidence, not heuristic scores or winning streaks. Bounds include near-total loss, current reconciled cash, fees, position/correlated exposure, exit capacity and deteriorating performance. Promotion gates require 100 closed validation positions, 50 independent clusters, two validation days, equal capital, positive paired uncertainty bounds, outlier-robust improvement, no worse drawdown and every prescribed stress result. A qualified result may be eligible for a separately capped 5% paper canary. Active replacement is blocked without independent canary validation; rollback restores the baseline for future entries without editing existing positions.

The release has no qualified profit-capture publication and does not wire unvalidated experimental sizing into existing Lab auto-sync. Existing validated entry/exit champion ownership continues. Historical route/partial-posting gaps cannot be repaired by waiting; the new forward tape is required. Quote-only books cannot qualify until full execution/cost and stress evidence is supplied. Observational marks/MFE and fixed 5/30/120-minute post-exit observations are not executable hindsight profits.

Recovery: `pump-profit-checkpoint.json`, `pump-profit-experiments.json`, `pump-profit-report.json` in the trader data directory; `pump-profit-evaluation.json` in the Lab data directory. Local release uses the existing transactional paired installer. Never reset or rewrite the authoritative paper book to make a study pass.

Tests: `npm run test:pump-profit` in each repository, plus each application's existing `npm run test:all`. The shared pure contracts are byte-identical between the two existing projects. Test fixtures are not trading-performance evidence.
