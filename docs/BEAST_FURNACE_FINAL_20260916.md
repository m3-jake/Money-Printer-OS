# BEAST furnace final benchmark — 2026-09-16

Status: research-only, opt-in, not deployed. Live execution, wallets, credentials, order sizing and Polymarket real actions are unchanged.

## Same fixed corpus

Corpus: 3,000 deterministic 5-minute rows, 2,048 frozen variants, seed 424242, 90 bootstrap rounds. The exact JSON fixture was scored by legacy JS, packed JS, and the WITCHDOCTOR RTX 5070 path.

Mac JS scorer:
- Legacy object scorer: 4,394.79 ms, 466.0 variants/sec.
- Packed scorer: 1,655.96 ms, 1,236.75 variants/sec.
- Packed speedup: 2.654x.
- Legacy vs packed: max absolute error 0, zero deterministic mismatches, exact full ranking parity.

WITCHDOCTOR RTX 5070:
- PyTorch 2.14.0+cu130 / CUDA 13.0 / float64.
- Exact corpus deterministic max absolute error vs JS CPU: 1.455e-11.
- Deterministic mismatch count: 0 across all 2,048 variants and all checked metrics.
- Full deterministic ranking parity: exact; top 10 exact.
- Peak measured VRAM: 1,027.625 MB.
- One-time CUDA/Python initialization is expensive (~8-9 s).
## Persistent CUDA result

A persistent sidecar was added specifically to avoid paying startup every generation. On the same 2,048-variant corpus:
- First server request after startup: ~8,768 ms wall, ~1,581 ms GPU compute.
- Second request in the same server: ~918 ms wall including 3 MB JSON transfer/parse, ~115 ms GPU compute.
- Direct warmed scorer calls previously measured 6,279–6,998 variants/sec; the current end-to-end line protocol is transfer-bound before it is compute-bound.

GPU is therefore a screening accelerator only. It ranks by `robustScoreDeterministic`; every candidate whose deterministic score is within the maximum possible Monte-Carlo contribution (+10 points) of the best candidate is CPU-rescored, plus the configured finalist floor and incumbent. GPU-only candidates have `metrics:null` before the authoritative sort, so they cannot win or promote.

## Safety / fallback

- BEAST and GPU are opt-in (`MPO_RESEARCH_BEAST=1`, `MPO_RESEARCH_GPU=1`).
- Any missing CUDA, sidecar exit, timeout, bad schema, length mismatch or parity failure falls back to the existing CPU scorer.
- Promotion constants are exported and regression-locked; no gate is weakened.
- Chronological sealed rows remain excluded from ranking and are observational only.
- Larger batches remain capped by `throughputVerifiedBatchSize`.

Recommended WITCHDOCTOR research settings: float64 CUDA, 4,096 MB VRAM budget (observed use ~1,028 MB), 4,096-variant verified batch ceiling, CPU fallback enabled, and bounded CPU workers (profile hard cap 16). Keep GPU disabled on machines without CUDA.