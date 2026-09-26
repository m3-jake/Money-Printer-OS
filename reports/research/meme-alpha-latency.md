# Meme alpha + latency research pass

Integrity: **FAIL**
COLD lead: **FAIL**

## Gates

| Gate | Result | Detail |
|---|---|---|
| cold-sentinel-excluded | FAIL | sentinel=n/a raw=n/a economic=n/a |
| cold-chronological | FAIL | [] |
| cold-walk-forward | FAIL | [] |
| cold-lead | FAIL | COLD top-quartile vs rest must hold on count-based chronological and walk-forward splits after sentinel/economic filters |
| replay-challengers-not-promotable | FAIL | challengers=0 live=false |
| replay-no-positive-sprint-or-fast | PASS | FAST pnl=n/a SPRINT pnl=n/a COLD_TOPQ pnl=n/a |
| forensics-negative-median | PASS | medianReturnPct=-2.8119 |
| forensics-friction-flip | FAIL | gross=-0.2683 net=-2.8119 |
| forensics-stale-purge-maxhold | PASS | n=124 cause=maxHold 2-min timer (champion MPO-Gmuavg7mo-2f63) |
| latency-proposal-mean-explained | PASS | proposal_ms is source-event-to-proposal (includes discovery); ~500s mean is outlier-inflated end-to-end, not proposal-stage queue |

## COLD liquidity top-quartile vs rest

- Raw independent COLD 30m rows: null
- Sentinel liquidity <= $1 excluded: null
- Sub-economic ($1, $1500) excluded: null
- Economic universe (liq >= $1500): null
- Chronological: FAIL []
- Walk-forward: FAIL []
- Cut / nHi / nLo: undefined / undefined / undefined
- Delta / medianDelta / CI low: undefined / undefined / undefined
- Top vs rest median: undefined vs undefined
- Top expectancy / PF / DD / top3: undefined / undefined / undefined / undefined

## Latest paper closes (SPRINT / UNIFIED_EDGE)

- N=247 median net %=-2.8119 median gross %=-0.2683
- Expectancy=0.013 profit factor=2.437
- Negative median: yes. Friction flip (gross>=0, net<0): false
- Dominant loss: stop-loss
- Stale-purge n=124 cause=maxHold 2-min timer (champion MPO-Gmuavg7mo-2f63)

## Proposal-stage latency

- Samples=3910 bottleneck=DISCOVERY
- proposal_ms mean=621684.2811594203 median=99567
- discovery median=89802 wait (ready→proposal) median=23
- proposal_ms is source-event-to-proposal (includes discovery); ~500s mean is outlier-inflated end-to-end, not proposal-stage queue

## Replay Lab (FAST benchmark vs SPRINT and shadow challengers)

- Events=null hash=null

| Config | Trades | P/L | Median % | Expectancy | PF | DD % | Top3 % | Gate | Promotable |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|

## Limitations

Research-only. No live eligibility, sizing, wallet, credential, or safety-gate changes. Challengers cannot self-promote. Replay cannot reconstruct unjournaled upstream features; disappearing candidates are censored. Sentinel liquidity=$1 is treated as missing, not as a tradable quartile member.

Generated fields are deterministic given the input JSON artifacts. r4 checksum: 4157