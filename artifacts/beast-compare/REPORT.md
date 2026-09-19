# BEAST furnace final benchmark

Research-only comparison of baseline alpha45 scoring vs optimized CPU/RAM vs GPU-assisted modes on the **same frozen corpus** (seed 45, 250 rows, 513 candidates, corpusHash `2c41fe928de377c85b5c038476668ab7355e53bd75cf9c9f8e0d387569b87d93`). Live execution, wallet, credentials, order sizing, Polymarket real actions, and the running app were not touched.

Parity corpus lock: rankingFingerprint `82a330a852f3f91cb56729bcdd6c425e5c22063ae56ba53c6fd8f3acd24f0b59`, rankingOrderHash `8d5c0989d377ce5f2f0b4b046f658a4fe72913de12813dbb58776686b39034f0`, promotion `RETAIN` winner `BEAST-0070` (missing heldOutN/samples/activityPct). Packed CPU/RAM modes reproduced those fingerprints and the promotion gate exactly.

| Field | Value |
| --- | --- |
| hardware | darwin arm64, 6 threads, 8 GB, node v24.18.0 |
| numerical tolerance | 1e-6 (deterministic keys); integers exact |
| duplicate rate | 0 (513/513 unique) |
| sealed integrity | ranking 213 / sealed 37, `selectionUse=false`; mutating the sealed tail does not change ranking rows |
| promotion gates | unchanged (`robustScore` margin 1.0, heldOutN≥12, samples≥40, activity≥8%, stress>-2, MC≥70%, consistency≥50%) |
| BEAST default | **off** (`MPO_RESEARCH_BEAST` / `research-beast.json`) |
| GPU default | **off** (`MPO_RESEARCH_GPU`); CUDA required; CPU fallback always on |

## Same-corpus modes (513 × 250)

Wall times on this small corpus are noisy (cache and host load). Two consecutive captures:

| Mode | Run A v/s (wall) | Run B v/s (wall) | workers | RSS peak | promotion | winner |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| baseline seeded worker | 1718 (299 ms) | 7240 (71 ms) | 1 | ~78–80 MB | RETAIN | BEAST-0070 |
| CPU/RAM packed 1 worker | 2526 (203 ms) | 9586 (54 ms) | 1 | ~79–80 MB | RETAIN | BEAST-0070 |
| CPU/RAM packed 4 workers | 1397 (367 ms) | 6494 (79 ms) | 4 | ~114–118 MB | RETAIN | BEAST-0070 |
| GPU sidecar | fallback | fallback | 0 | n/a | n/a | torch-unavailable |

Observed packed 1-worker speedup vs baseline on this corpus: **1.32×–1.47×**. Four workers were slower (startup/oversubscription on a 6-thread Mac). CPU proxy ~53–145% of one core for 1-worker; 4-worker RSS +~40 MB.

GPU probe amortization on this host: 73–966 ms then clean `torch-unavailable` fallback (no PyTorch installed). Recompute rate for CPU modes: 0.

## Throughput corpus (2048 × 3000, not the parity lock)

- Original CPU fast-path task (idle): legacy 2134.5 → packed 2558 variants/sec (**1.20×**), wall 966 → 801 ms.
- This host under load, 4 workers: legacy 1108 → packed 1048 variants/sec (**0.95×**). Extra workers are not a proven speedup here.

## GPU-assisted (WITCHDOCTOR RTX 5070, cited)

4097 × 3000, 90-round float64 CUDA: **6227.7 variants/sec**, wall 657.87 ms, peak VRAM 1188 MB, deterministic max abs 4.26e-14. GPU ranks the dense batch; CPU rescores every candidate within 10 deterministic robust-score points of the leader (MC can add at most +10) plus at least 12 finalists and the incumbent. This Mac has no CUDA/torch, so GPU is **not** enabled by default.

## Integration decision

| Change | Verdict |
| --- | --- |
| Packed dataset + persistent worker pool | **ACCEPT** into opt-in BEAST. Ranking/promotion/sealed gates match alpha45 on the frozen corpus. |
| Global Halton + sealed chronological tail | **ACCEPT** (already in furnace). Sealed rows cannot influence ranking. |
| GPU dense scorer as default | **REJECT** on this host. **Opt-in only** when CUDA probe + sampled deterministic parity pass; otherwise CPU fallback. |
| Weakening promotion / live execution | **REJECT**. Champions stay SHADOW/RESEARCH. |

## Recommended BEAST knobs

| Knob | MacBook Neo (this host) | WITCHDOCTOR CUDA host |
| --- | --- | --- |
| workers | **1** (2 is the resource cap; 4 was slower) | 4–8 if they beat 1-worker wall |
| batchSize | **4096** (throughput-verified cap) | 4096 |
| RAM target | **0.8–1.6 GB** (0.4 GB/worker) | 2.4–4 GB |
| cpuPercent | 65–80 | 65–80 |
| GPU batch | n/a (no CUDA) | **4096** |
| GPU VRAM target | n/a | **2048 MB** (measured peak 1188 MB) |
| observed speedup | **1.32×–1.47×** vs baseline on the locked corpus (1 worker) | GPU ~6228 v/s on 4097×3000 |

Enable CPU/RAM BEAST with `MPO_RESEARCH_BEAST=1` (or `data/research-beast.json`). GPU additionally requires `MPO_RESEARCH_GPU=1` and a CUDA sidecar at `research/gpu-furnace/sidecar.py`. Sidecar/parity/timeout failure falls back to CPU for that generation. No deploy, no app restart, no live promotion.
