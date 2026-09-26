# Polymarket: a second strategy family (design, not built)

Status: design only. Nothing here trades or is wired into the Lab yet. This is item 4 of the
2026-09-25 plan (`reports/LAB-DATA-NEXT-USE-2026-09-25.md` section 2.4).

## Why a new family

The one family tested on the Polymarket tape (book reversion, taker entries, 288 configs) loses on
every captured day after fees. That is a real negative result on real prices, so re-gridding it is
pointless. The new families below change *how* we trade (maker vs taker, which markets, which leg)
rather than the signal.

## What the tape can and cannot tell us

`<data>/research-evidence/raw/polymarket-depth-<date>.ndjson` (`mpo.polymarket-depth-tape.v1`),
about every 5 s per tracked market:

| Available | Not available |
| --- | --- |
| 10 levels of bids and asks, best bid/ask, `tickSize` | trade prints (who traded, at what size) |
| `feeMeta` as observed per market: `feesEnabled`, `feeSchedule {rate, exponent, takerOnly}`, `takerBaseFee` | our own queue position |
| event/game grouping, live period, score, `endDate` | latency (coverage flag false) |
| both outcome tokens of a binary market (`outcomeIndex` 0/1) | shared-capital effects |

Observed on 2026-09-26: sports moneylines carry `feesEnabled: true`, `rate 0.05`, `takerOnly: true`.
Makers pay no fee on those markets. Fee facts must always come from the captured `feeMeta` at
capture time, never from a hard-coded table.

## Family A: maker-only posting with a conservative queue model

Post a limit at the best bid (or one tick inside the spread) and never cross. The fee is 0 when
`feeMeta.feeSchedule.takerOnly === true`; otherwise the family skips the market.

Fill model, deliberately pessimistic because there are no trade prints:

1. At post time `t0`, the queue ahead of us is the displayed size at our price, `Q0`. We join at the back.
2. Between snapshots, depletion at our level counts toward our fill **only** when the opposite best
   price touched or crossed our price in that interval (evidence of trading, not cancelling). The
   depletion that counts is capped by the size that disappeared.
3. We are filled once the cumulative counted depletion exceeds `Q0`. A partial fill is the excess,
   capped at our size.
4. If the price moves away (we are no longer at the best) or the order is `ttl` old, cancel. Nothing
   fills after a cancel.
5. Adverse selection is the main risk for makers. Every fill is marked out at +30 s, +5 min and at
   settlement, and the family is scored on settlement P/L **and** on the +5 min markout.

The parameters to search are small: `offsetTicks` 0–2, `ttl` 15 s–10 min, a minimum `Q0`/depth
ratio, a spread floor, the minutes-to-end window and the live/pre-game split.

## Family B: fee-free markets only

The same signals as today, restricted to markets whose captured `feeMeta.feesEnabled === false`.
The control is the identical signal on fee-enabled markets from the same days, so the fee effect is
measured, not assumed. (Earlier notes said "NFL-only". That was a guess; the captured flag decides.)

## Family C: short via the complement

To bet against YES, compare selling YES at its best bid with buying NO at its best ask, using each
token's own book from the same snapshot. Take the cheaper effective price after fees. This is an
execution improvement to apply to A and B rather than a strategy of its own, and it is measured as
cents saved per contract.

## Evaluation protocol (same posture as the rest of the Lab)

- Walk-forward by sealed UTC day. Search on older days and judge on the newest, never re-using a holdout.
- Group by `eventId`/`gameId` so correlated legs count once.
- Fees from the captured `feeMeta` of that row. Unknown fee state means the row is skipped, not priced at 0.
- Promotion needs `laneMayPropose` (`src/evidenceFlags.js`): at least 7 days, at least 20 settled
  or filled trades, and executable prices. Book snapshots count as executable only for Family B and C
  taker legs, and **never** for Family A fills, which stay "modelled" until trade prints exist.
- Family A reports its markouts beside P/L. A positive settlement P/L with negative markouts is
  treated as luck.

## Data step before any search (cheap, do first)

Capture public trade prints in the collector, for example the public `data-api` trades endpoint
per tracked market, into `raw/polymarket-trades-<date>.ndjson`. That turns rule 2 of the queue model
from inference into evidence, and it is the only way Family A fills can ever count as executable.
Budget: one request per tracked market every 30 s.

## Where it runs

It runs as a Lab Polymarket lane. The lane is currently NO_EDGE and off by default (`MPO_LAB_MODULES`).
Re-enable it only after the collector has 7 full days of depth, with trade prints for Family A.
Polymarket US combos stay parked; nothing here touches them.
