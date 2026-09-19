# Research evidence gate v1

Status: implementation and tests; not installed into the running app. This pure validator and CLI consume trusted evaluator evidence. They do not themselves simulate fills, establish provenance, calculate confidence intervals, enforce an audit registry, or authorize real orders. The integration must implement those producers and persistence before using reviewReady operationally.

Run `node --test tests/research-evidence-gate.test.mjs` or `node scripts/research-evidence-report.mjs /absolute/path/evidence.json`.

Contract is `mpo.research-evidence.v1`. Required fields and a complete fixture are in tests/research-evidence-gate.test.mjs. The fixture is synthetic test input only, never promotion evidence. Module must be solana or polymarket; validate each separately.

Stages:
- RESEARCH_ONLY: executable replay or independent sealed evidence absent/invalid.
- PAPER_COMPARISON: sealed checks passed; frozen candidate needs fresh paired paper evidence.
- REVIEW_READY: both phases passed. livePromotionAllowed remains false always.

Initial policy: at least 100 independent groups per phase, positive net and stressed returns, maximum drawdown at most 20 percent, and a positive lower improvement bound at confidence level at least 95 percent, accounting for all recorded search trials. These are conservative engineering defaults, not a statistical guarantee or an optimized risk policy. Positive drawdown magnitudes are required. All returns and bounds use percentage units and the same capital base.

v1 deliberately requires prospective data periods after candidate freeze. Ranking must end by freeze; sealed audit must be complete and retired exactly once; forward period begins after sealed period and uses a different dataset. A future historical sealed-test mode needs a verifiable precommitted inaccessible data manifest rather than relaxing this temporal check casually.

Confidence intervals must come from a separately tested, documented producer with grouping/dependence assumptions and multiplicity correction. method is an audit label, not statistical proof. No fabricated interval or claimed group count can replace actual records. Integration must compute immutable candidate hashes from canonical parameters/code, dataset/opportunity hashes from records, independent group counts from event identities, and costs/coverage from replay results. Atomic audit consumption must prevent repeated final exams across restarts/machines; spent windows can later join training but must not be reused as final tests.

Monitor should display candidate vs incumbent net performance, stage, independent groups, coverage, trial count, confidence interval, and reasons[].message. Legacy heldOutAvgPct/monteCarloPassPct metrics alone intentionally fail closed. Existing research rankings can continue, but must be labeled proxy scores until the executable evaluator validates them.

Review/integration owns evolution engine wiring after current CPU fast-path and sealed-validation tasks finish. Do not overwrite their active files. Register this focused test in test:all at integration. No paid dependencies added.
