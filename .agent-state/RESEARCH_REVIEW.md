# Research review — 2026-09-16

Base worker commit: 6413227. Independent review corrections:
- Legacy NULL wait_ms falls back to ready/proposal timestamps; missing samples
  cannot prove a short proposal queue.
- Replay training quartiles exclude sentinel and sub-economic liquidity (<1500).
- Positive COLD-versus-rest differences are insufficient: top median must itself
  be positive for the overall lead and positive-fold counts.

Validation: 144/144 test:all plus SELFTEST PASS on the corrected research branch.
Original report files are historical worker outputs, not regenerated proof of
these corrections. No strategy promotion is authorized by those reports.

Integration guidance: latencyStats.js + alphaDb.js instrumentation can be
integrated independently. Do not cherry-pick the entire branch without checking
edgeProof productionLearningUnlocked effects: quarantining observations changes
the population that could open that gate. Hypothesis mining must retain funding
cluster identity rather than silently falling back to mint when x.cluster_id is
available. Those are remaining review issues, not validated live behavior.

Research code has not been installed into the running app. Live state and
credentials remain untouched. No claim is made that discovery latency was fixed.
