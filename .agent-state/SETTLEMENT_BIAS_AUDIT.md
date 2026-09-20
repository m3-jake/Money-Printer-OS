# Integration review correction — 2026-09-16

The historical worker report below is superseded by this review where it conflicts:
- Rejected six-hour auto-void/refund and all timeout-only cash refunds. Unknown,
  still-open, failed-lookup and nonbinary outcomes stay OPEN with aging metrics.
- Missing/malformed prices and unmatched outcome labels remain pending.
- Near-binary prices do not count as confirmed Gamma settlement (exact 0/1 only).
- A paper mark-to-bid loss requires executable depth for the entire holding.
- Closed-list and direct-id recovery, early-exit separation, conservative metrics,
  explicit cancellations and any-lost-leg combo settlement retained.
- Verified 117/117 tests across all 11 suites and SELFTEST PASS locally.
- Live journals and running apps were not modified by these tests.

## Historical worker report

# Polymarket paper settlement-bias audit — 2026-09-16

Journal snapshot: `tests/fixtures/polymarket-paper-20260916.json` (copy of the live Mac paper file `~/Library/Application Support/Money Printer OS/data/polymarket-paper.json` at 10:58 local). Live journal was not modified.

## Headline

The 42–0 singles record is **not** selection quality. It is survivorship from asymmetric settlement **plus** Gamma’s live `/markets?id=` list omitting resolved markets. **Do not keep** the high-turnover strategy on this evidence.

## Observed book (journal as stored)

| Slice | N | Status | Source | Stake | Realized P/L |
| --- | ---: | --- | --- | ---: | ---: |
| Settled singles | 42 | all WON | all `early-exit` | $42.00 | +$2.559 |
| Open singles | 4 | OPEN, treated as missing | — | $4.00 | marked at cost |
| Open combo | 1 × $2.50 | OPEN, treated as missing | — | $2.50 | marked at cost |
| Gamma-resolved WON/LOST | 0 | — | — | — | — |

- Realized ROI on settled stakes: **+6.09%** (+$2.56 / $42). Hit rate 42/42. Mean fill 0.933.
- Time-to-settlement (cashed winners only): min 0.67m, median 7.3m, p90 17.1m, max 51.3m, mean 9.2m.
- Open ages at snapshot: 23.9h, 27.3h, 27.8h, 34.6h, 39.2h. All past ETA+2h. All five had `missingSince`.
- Equity at cost: cash $21.28 + open $6.50 = **$27.78**. Conservative (open = 0): **−$3.94 / $48.50 = −8.13% ROI**.
- Calibration buckets ignore early-exit, so they stay empty (n=0) and cannot arm quarter-Kelly.

## What the five “OPEN” tickets actually were

Gamma `GET /markets?id=` returned **0** rows. The same IDs resolve with `closed=true` (and `GET /markets/{id}`):

| Ticket | Market | Side | Gamma prices | True result |
| --- | --- | --- | --- | --- |
| Novak $1 | 4542172 | Kristina Novak | [1, 0] | **LOST** (Falkowska won 2-6, 7-6, 6-2) |
| Vedder $1 | 4528120 | Eva Vedder | [1, 0] | **LOST** (Ruggeri won 5-7, 7-6, 6-1) |
| Llorca $1 | 4528112 | Lucia Cortez Llorca | [1, 0] | **LOST** (Linana won 2-6, 7-5, 7-5) |
| Marlins $1 | 4363835 | Miami Marlins | [0, 1] | **LOST** (7–8; led 7–6 Top 9th) |
| Combo $2.50 | 4063862 No Barracas + 4118850 Lanús −2.5 | both won | [0,1] and [1,0] | **WON** (~+$0.33 after fees) |

Fully booked paper P/L: **43–4**, realized ≈ **−$1.11 / $48.50 ≈ −2.3% ROI**. Gamma-resolved sample is only 5. 42 of 43 wins remain early-exit cash-outs, not official resolution.

## Mechanism

1. **Asymmetric early-exit.** Singles cash out when bid ≥ 0.99 (or recycle ≥ 0.975). Losers never hit that bid.
2. **Live Gamma list hides closed markets.** `GET /markets?id=` returns [] for resolved IDs; `closed=true` returns them. Settlement treated finished losers as missing, so they never booked LOST.
3. **Combos cannot early-exit**, and a lost leg used to wait for every other leg / missing-market void (stake returned) instead of booking LOST now.
4. **Stale/missing voids return cash**, which is optimistic versus a true loss.
5. **Metrics used settled-only hit rate/ROI** until conservative/censoring fields were added.

## Repairs (paper/research only)

- Fetch resolved markets via `closed=true`, then `GET /markets/{id}` if the live list misses.
- Book LOST as soon as any known leg is lost (pending or missing siblings do not delay).
- Fake clock, throttle/busy dedupe, mark-to-bid crushed losers, cancelled → VOID, 6h censored stale/missing timeout.
- Calibration uses gamma-confirmed results only. Conservative ROI / overdue / exposure-adjusted equity. Autopilot pauses on overdue or `DROP`.
- Strategy `keep=false` until `gammaResolved>=20`, conservative ROI > 0, and overdue opens = 0.
- Real execution remains locked. No orders, credentials, or live journal stakes changed.

## Verdict

`DROP`. Re-evaluate `KEEP` only after gamma-resolved samples include a real mix of wins **and** losers, overdue opens are 0, and conservative ROI is positive.
