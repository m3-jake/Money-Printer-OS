# Profit Lab P0 — Pump capture-time evidence provenance

Status: queued for implementation on Money Printer OS 0.5.0-alpha.93.

## Why this is the next unfinished task

The existing prospective Pump study infrastructure normalizes missing market evidence before an experiment can decide whether the evidence was actually observed.

In `src/pumpProfitRuntime.js`, `observedMarket()` currently turns:
- missing `executionScore` into numeric `0`
- missing `liq` / `lastLiquidityUsd` into numeric `0`

That destroys the distinction between “not observed” and “observed as zero.” The proposed guarded PAPER candidate from the already-recorded retrospective nomination (`execution >= 70`, modeled round-trip cost `<= 2.2%`) must therefore NOT be activated until capture-time provenance exists.

The retrospective 25-trade nomination remains hypothesis-generation only. It receives zero validation credit.

## Required implementation

Add a small immutable provenance envelope before normalization:

```js
{
  schema: 'mpo.pump-opportunity-evidence.v1',
  capturedAt,
  executionScore: {
    present: boolean,
    finite: boolean,
    value: number | null
  },
  liquidityUsd: {
    present: boolean,
    finite: boolean,
    value: number | null,
    source: 'liq' | 'lastLiquidityUsd' | null
  }
}
```

Rules:
1. Presence is based on own-property existence, not truthiness.
2. Explicit numeric zero is valid evidence and must remain distinct from missing.
3. If both `liq` and `lastLiquidityUsd` exist, `liq` is authoritative, including explicit zero.
4. Present-but-invalid / non-finite values are recorded as `present: true, finite: false, value: null`.
5. Keep the existing normalized `executionScore`, `liquidityUsd`, and `liq` fields unchanged for legacy consumers.
6. Attach the envelope as `evidenceProvenance` to the observed opportunity before it reaches experiment admission.

## Guarded-candidate integration

The already-planned PAPER-only candidate must inspect `evidenceProvenance`, never the normalized numeric fields, when deciding whether evidence is complete.

Fail closed with explicit reasons for:
- missing execution provenance
- invalid execution provenance
- missing liquidity provenance
- invalid liquidity provenance
- execution score below 70
- modeled round-trip cost above 2.2%
- cost unavailable

Ordering invariant:
1. A future opportunity ID is admitted to the generation’s common stream.
2. BASELINE receives the opportunity unchanged.
3. The guarded candidate receives that same opportunity ID.
4. Candidate-specific evidence/cost rejection happens after common-stream admission.

The guarded candidate must compute modeled round-trip cost at its own prospective size using the existing paper execution economics. It must not alter the active MAX strategy.

## Regression tests

Add a focused test that proves:
- missing execution != observed execution score 0
- missing liquidity != observed liquidity 0
- explicit `liq: 0` wins over a nonzero `lastLiquidityUsd`
- invalid values are present-but-invalid
- legacy normalized fields still produce the exact same numeric values as before
- common BASELINE / guarded opportunity IDs match before candidate filtering
- a missing provenance field causes the guarded candidate to reject closed
- historical nomination rows never increment discovery, validation, PnL, or promotion counters

## Acceptance gates

Before merge:
- `npm run test:pump-profit`
- `npm run test:paper-bots`
- `npm run test:wiring`
- `git diff --check`
- `npm run test:all`

Also keep Evolution Lab shared-core parity green before a paired release.

## Safety boundary

This task is research-only and PAPER-only. Do not change:
- the active MAX policy
- bankroll or paper history
- existing open positions
- wallet/order execution
- arming or settlement
- paper/live mode
- any real-money authority

## Dependency

The policy-keyed prospective generation and opt-in guarded-candidate scaffolding reported from the WITCHDOCTOR working tree should be reconciled first when that machine is online. Do not duplicate or overwrite newer local work. If those changes are absent, implement provenance first and keep the guarded candidate disabled until the generation layer exists.
