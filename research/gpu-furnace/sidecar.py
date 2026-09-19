#!/usr/bin/env python3
"""Research-only persistent CUDA scorer for Money Printer OS.

One-shot mode reads a fixture from stdin. Server mode keeps torch/CUDA loaded and
accepts newline-delimited JSON requests so generation scoring amortizes startup.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

SCORES_SCHEMA = "mpo.gpu-furnace.scores.v1"
SERVER_SCHEMA = "mpo.gpu-furnace.server.v1"

def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, default=str, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def load_backend():
    from mpo_gpu_furnace.fixture import pack_fixture
    from mpo_gpu_furnace.scorer import score_batch, describe_environment
    return pack_fixture, score_batch, describe_environment

def probe() -> int:
    try:
        _, _, describe_environment = load_backend()
        env = describe_environment()
        emit({"ok": True, "schema": "mpo.gpu-furnace.probe.v1", **env,
              "torch": env.get("torch"), "cuda": bool(env.get("cudaAvailable")),
              "mps": bool(env.get("mpsAvailable")),
              "device": "cuda" if env.get("cudaAvailable") else "cpu"})
        return 0
    except Exception as exc:
        emit({"ok": False, "schema": "mpo.gpu-furnace.probe.v1", "reason": "torch-unavailable", "error": str(exc)[:240]})
        return 2


def score_fixture(fixture: dict, opts: dict, backend=None) -> dict:
    pack_fixture, score_batch, _ = backend or load_backend()
    packed = pack_fixture(fixture)
    result = score_batch(
        packed,
        device=opts.get("device", "auto"),
        dtype=opts.get("dtype", "float64"),
        seed=int(opts.get("seed", 1)),
        vram_mb=int(opts.get("vramMb", 2048)),
        bootstrap_rounds=packed.bootstrap_rounds,
    )
    return {"ok": True, **result.to_scores_json()}

def one_shot(args: argparse.Namespace) -> int:
    try:
        raw = Path(args.input).read_text(encoding="utf-8") if args.input else sys.stdin.read()
        fixture = json.loads(raw)
        payload = score_fixture(fixture, {"device": args.device, "dtype": args.dtype, "seed": args.seed, "vramMb": args.vram_mb})
        emit(payload)
        return 0
    except Exception as exc:
        emit({"ok": False, "schema": SCORES_SCHEMA, "reason": "score-failed", "error": str(exc)[:240]})
        return 2

def server() -> int:
    try:
        backend = load_backend()
        env = backend[2]()
        emit({"ok": True, "ready": True, "schema": SERVER_SCHEMA, **env})
    except Exception as exc:
        emit({"ok": False, "ready": False, "schema": SERVER_SCHEMA, "reason": "torch-unavailable", "error": str(exc)[:240]})
        return 2
    for line in sys.stdin:
        if not line.strip():
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("requestId")
            payload = score_fixture(req.get("fixture") or {}, req.get("opts") or {}, backend)
            emit({"requestId": req_id, **payload})
        except Exception as exc:
            emit({"requestId": req_id, "ok": False, "schema": SCORES_SCHEMA, "reason": "score-failed", "error": str(exc)[:240]})
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="MPO GPU furnace research sidecar")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--server", action="store_true")
    ap.add_argument("--in", dest="input", default="")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--dtype", default="float64")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--vram-mb", type=int, default=2048)
    args = ap.parse_args()
    if args.probe:
        return probe()
    if args.server:
        return server()
    return one_shot(args)

if __name__ == "__main__":
    raise SystemExit(main())