# Polymarket independent research evaluator

Research-only as-of backtest for Polymarket opportunities. It does **not** place
orders, size live risk, touch wallets or credentials, or import
`src/polymarket.js`.

Live execution, paper autopilot, and the running app are unchanged.

## Why this exists

`polymarketPolicyReplay` only re-filters tickets that were already taken.
Meme `replayLab` reads `market.ndjson`, not Polymarket books. This module
evaluates a **captured as-of tape** of quotes, depth, fees, sports signals, and
resolutions, then compares a frozen candidate with an incumbent on the same
opportunity set.

Prices alone are not a predictive edge. A high win rate is not profitability.

## CLI

```bash
node src/polymarketResearchEval.js --tape tests/fixtures/polymarket-research-eval-test-only.json
# or
npm run poly-research-eval -- --tape path/to/tape.json --out reports/poly-research \
  --incumbent take-none --candidate take-all --min-events 20
```

Writes `<out>.json` and `<out>.md`. Refuses to write into the Money Printer OS
app-data directory. Reports omit wall-clock timestamps so reruns are
byte-identical.

## Tape schema (`polymarket-research-tape/v1`)

Every observation **must** carry `asOfTs`. Synthetic/test tapes **must** set
`testOnly: true`. Historical depth and fee schedules are never invented; if a
required as-of field is missing, the opportunity is rejected and promotion
fails closed.

```json
{
  "schema": "polymarket-research-tape/v1",
  "testOnly": true,
  "source": "synthetic-test",
  "bankrollUsd": 100,
  "maxRelatedEventExposureUsd": 25,
  "maxOpenPositions": 8,
  "quoteStaleMs": 15000,
  "depthStaleMs": 15000,
  "sportsStaleMs": 120000,
  "feeStaleMs": 86400000,
  "incumbent": { "preset": "take-none" },
  "candidate": { "preset": "take-all" },
  "observations": [],
  "opportunities": []
}
```

### Observation types

| type | required as-of fields | notes |
|---|---|---|
| `odds` / `quote` | `asOfTs`, `marketId`/`tokenId`, `bid`, `ask` | May embed `asks`/`bids` depth |
| `depth` / `book` | `asOfTs`, `asks[]` `{price,size}` | Executable book. Never inferred from last price |
| `fee` / `fee-metadata` | `asOfTs`, `marketId`, `feesEnabled` and either `feeSchedule.rate` or `takerBaseFee` | `feesEnabled: false` is captured "no fee" |
| `sports` / `sports-signal` | `asOfTs`, `eventId` | Stale if older than `sportsStaleMs` (default 120s) |
| `outcome` / `resolution` | `asOfTs`, `marketId`, `resolvedPrice` `0` or `1` | Capital stays locked until this timestamp |

Default quote/depth freshness matches live CLOB overlay (`15s`). Sports
freshness matches live candidate gating (`120s`). Fee metadata has no live
default fallback: a missing schedule does **not** become 5%.

### Opportunities

```json
{
  "id": "opp-1",
  "decisionTs": 1000,
  "eventId": "game-1",
  "marketId": "m1",
  "tokenId": "t1",
  "requestedStakeUsd": 10,
  "signal": { "asOfTs": 1000, "score": 80 }
}
```

`signal.asOfTs` after `decisionTs` is lookahead (`future-signal`). Already
resolved markets are rejected. Combo opportunities may set `legs[]`; related
event ids are unioned for the exposure cap.

## Simulation

1. Walk decision and resolution timestamps with a monotonic as-of clock.
   Future observations are invisible; using them throws `lookahead`.
2. At each decision, require a fresh executable quote, captured depth, captured
   fee metadata, and a fresh sports signal.
3. Walk the captured ask book. Cash includes taker fees
   (`rate * p^exp * (1-p)^exp`, sports_fees_v3). Thin books **partial-fill**;
   empty books reject. Size is never invented.
4. Shared bankroll. Stake plus fees leave cash and stay **locked** until the
   captured outcome timestamp (delayed resolution cannot be spent through).
5. Concurrent positions respect `maxOpenPositions` and
   `maxRelatedEventExposureUsd` per event.
6. Settlement pays `shares` if `resolvedPrice === 1`, else `0`. No mark-to-mid.

## Grouping, comparison, promotion

Splits and bootstrap resample **events**, not legs. Two winning markets on the
same game are one independent observation.

Candidate and incumbent run on the **same** opportunity timestamps. The report
includes net PnL, drawdown, coverage, independent event count, event-grouped
bootstrap, and rejection reasons.

Promotion is fail-closed and **never** sets `live: true`. It fails when:

- required observation kinds are missing
- coverage is below threshold
- outcomes are still unresolved
- independent event count is too small for event-grouped inference
- net PnL is not positive (win rate is ignored as a profit proxy)
- event-grouped 95% CI is missing or not positive
- the candidate does not beat the incumbent on net PnL

Presets: `take-none`, `take-all`, `favorites` (ask ≥ 0.85),
`mid-price-favorites` (mid ≥ 0.85; used to show that mid-price “edge” dies
after executable costs).

## Collectors

Reuse Gamma/CLOB/sports snapshots **only if they were persisted with as-of
timestamps**. This evaluator does not start feeds, does not call paid APIs,
and will not backfill missing books or fee schedules.
