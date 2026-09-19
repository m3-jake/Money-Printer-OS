# BEAST baseline benchmark

Research-only evolution scoring baseline. Isolated harness; live app was not started or modified.

| Field | Value |
| --- | --- |
| generatedAt | 2026-09-16T22:39:54.475Z |
| version | 0.5.0-alpha.45 |
| sourceCommit | 3a66485e40b4290fbd7ff83daf982cf37ac4e6e2 |
| seed | 45 |
| candidateCount | 513 |
| datasetRows | 250 |
| workerCount | 1 |
| generationWallMs | 130 |
| variantsPerSec | 3946.154 |
| rssPeakMiB | 81.28 |
| cpuUserMicros | 155044 |
| cpuSystemMicros | 9822 |
| cpuProxyPct | 126.8 |
| corpusHash | 2c41fe928de377c85b5c038476668ab7355e53bd75cf9c9f8e0d387569b87d93 |
| rankingFingerprint | 82a330a852f3f91cb56729bcdd6c425e5c22063ae56ba53c6fd8f3acd24f0b59 |
| rankingOrderHash | 8d5c0989d377ce5f2f0b4b046f658a4fe72913de12813dbb58776686b39034f0 |
| scorer | src/evolutionWorker.js 57e0925536ba6200d52721c3848d61c2dd38727aff73e82f1ec7d5230502dddc |
| promotion | RETAIN promoted=false winner=BEAST-0070 |
| promotionMissing | heldOutN, samples, activityPct |
| hardware | darwin arm64 6 threads node v24.18.0 |
| throughputWorkers | 4 |
| throughputWallMs | 110 |
| throughputVariantsPerSec | 4663.636 |

## Top-N

1. `BEAST-0070` lane=EXIT_TIMING robust=268.511847 heldOut=20.974445 n=4 samples=15 activity=7.5 stress=19.393981 mc=100 cons=100
2. `BEAST-0121` lane=LAUNCH_SNIPE robust=254.862624 heldOut=18.008882 n=5 samples=30 activity=15 stress=16.780863 mc=100 cons=100
3. `BEAST-0466` lane=EXIT_TIMING robust=253.475982 heldOut=14.979065 n=11 samples=46 activity=23 stress=13.575559 mc=100 cons=100
4. `BEAST-0280` lane=EXIT_TIMING robust=248.451611 heldOut=14.800805 n=10 samples=42 activity=21 stress=13.87594 mc=100 cons=100
5. `BEAST-0364` lane=EXIT_TIMING robust=238.302464 heldOut=14.979065 n=11 samples=50 activity=25 stress=13.575559 mc=100 cons=100
6. `BEAST-0220` lane=EXIT_TIMING robust=237.54408 heldOut=14.007607 n=10 samples=43 activity=21.5 stress=13.082741 mc=100 cons=100
7. `BEAST-0214` lane=EXIT_TIMING robust=166.95873 heldOut=14.565701 n=10 samples=34 activity=17 stress=13.64012 mc=100 cons=100
8. `BEAST-0328` lane=EXIT_TIMING robust=162.124646 heldOut=17.883488 n=6 samples=20 activity=10 stress=16.394255 mc=100 cons=100
9. `BEAST-0478` lane=EXIT_TIMING robust=138.106986 heldOut=9.15953 n=4 samples=12 activity=6 stress=9.15953 mc=100 cons=100
10. `BEAST-0310` lane=EXIT_TIMING robust=134.728839 heldOut=9.97926 n=4 samples=10 activity=5 stress=9.97926 mc=0 cons=100

## Promotion gate

```json
{
  "ok": false,
  "promoted": false,
  "stage": "RETAIN",
  "missing": [
    "heldOutN",
    "samples",
    "activityPct"
  ],
  "winnerId": "BEAST-0070",
  "incumbentId": "BASE",
  "winnerTrusted": false,
  "incumbentTrusted": false,
  "winnerMetrics": {
    "robustScore": 268.511847,
    "walkAvgPct": 16.326087,
    "geometricMeanPct": 16.253736,
    "compoundedMultiple": 1.857336,
    "maxDrawdownPct": 0,
    "profitVelocityPctPerMin": 8.163044,
    "consistencyPct": 100,
    "activityPct": 7.5,
    "inactivityPenalty": 16.55,
    "heldOutAvgPct": 20.974445,
    "heldOutN": 4,
    "stressAvgPct": 19.393981,
    "monteCarloPassPct": 100,
    "worstPct": 0,
    "samples": 15
  },
  "incumbentMetrics": {
    "robustScore": 28.67654,
    "walkAvgPct": 14.790989,
    "geometricMeanPct": 14.77825,
    "compoundedMultiple": 1.549885,
    "maxDrawdownPct": 0,
    "profitVelocityPctPerMin": 0.493033,
    "consistencyPct": 100,
    "activityPct": 6,
    "inactivityPenalty": 21.8,
    "heldOutAvgPct": 16,
    "heldOutN": 4,
    "stressAvgPct": 15.874101,
    "monteCarloPassPct": 100,
    "worstPct": 0,
    "samples": 12
  }
}
```
