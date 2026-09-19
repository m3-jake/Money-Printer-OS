# RTX 5070 GPU furnace benchmark — 2026-09-16

Device: WITCHDOCTOR, NVIDIA GeForce RTX 5070, 12,226 MiB VRAM, PyTorch 2.14.0+cu130, CUDA 13.0. Research-only; live execution was not modified.

## Verified parity
64 variants × 600 rows, float64 CUDA vs pure reference, 1 bootstrap round: maximum deterministic absolute error `4.263256414560601e-14`; sample/held-out counts identical. Repeat runs were bit-identical for tested device/dtype/seed/chunk settings.

## Throughput
4097 variants × 3000 rows. With a 1-round bootstrap, warm float64 was `196.89 ms` = `20,808.7 variants/sec`, peak VRAM `380.392 MB`; warm float32 was `288.21 ms` = `14,215.5 variants/sec`, peak VRAM `230.97 MB`.

With the production 90-round robustness bootstrap, float64 completed in `657.87 ms` = `6,227.7 variants/sec`, compute portion `347.97 ms`, peak VRAM `1,188.423 MB`, one 4097-variant chunk, bootstrap chunk 4. The first float32 call paid CUDA initialization and was not used as a steady-state recommendation.

The Mac optimized CPU benchmark (different hardware, same scorer semantics) measured `2,558 variants/sec` after the CPU fast path versus `2,134.5 variants/sec` legacy. A final same-corpus Windows CPU-vs-GPU benchmark remains the integration gate; GPU is not wired into the running app by this task.

## Integration contract
Use CUDA only as an opt-in research scorer. GPU ranks the dense batch; finalists are rescored by the existing CPU path before any promotion gate. Any sidecar error or parity failure falls back to full CPU research scoring. No live orders, wallet code, Polymarket execution, credentials, or risk sizing are imported or changed.
