"""Batched torch implementation of the evolutionWorker.js robust scorer.

Precision contract (see .workflow/scratch/gpu-furnace-spec.md):
  * the selection score is ALWAYS float64 with the exact JS 9-step
    multiply-then-add order, so the selection mask is bitwise identical to the
    CPU worker in every mode (no matmul, no TF32);
  * aggregates run in the requested dtype (float32 | float64);
  * mask-derived fields (samples / heldOutN / activityPct / consistencyPct /
    inactivityPenalty) are always evaluated in float64 from integer counts, so
    they stay exact even in the float32 pass;
  * the bootstrap uses a seeded torch.Generator on the compute device.

Research-only: imports nothing from the live engine.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import torch

from .fixture import DEFAULT_BOOTSTRAP_ROUNDS, N_FEATURES, N_FOLDS, Packed

# --- VRAM model -------------------------------------------------------------
# Per (variant, fold-row) live bytes: float64 selection score (8) + bool mask (1)
# + ROW_TERMS dtype temporaries (clip, factor, wallet, peak, ratio, masked clip);
# plus, across the 4 concatenated folds, CAT_TERMS dtype planes (clip_cat,
# compacted returns) and one int64 argsort index (4 rows * 8 bytes).
ROW_FIXED_BYTES = 9
ROW_TERMS = 6
CAT_TERMS = 8
CAT_INDEX_BYTES = 4 * 8
ROW_BUDGET_FRACTION = 0.5
BOOT_BUDGET_FRACTION = 0.25
# Bootstrap draw plane holds u (dtype) + idx (int64) + gathered values (dtype).
BOOT_ELEM_EXTRA = 8

DEFAULT_VRAM_MB = 2048
DTYPES = {"float32": torch.float32, "float64": torch.float64}


@dataclass
class ScoreResult:
    metrics: list[dict[str, Any] | None]
    device: str
    dtype: str
    seed: int
    chunk_variants: int
    rounds_chunk: int
    bootstrap_rounds: int
    mc_reference_rounds: int | None
    timing: dict[str, float]
    peak_memory_mb: float | None
    vram_mb: int
    device_name: str = ""
    notes: list[str] = field(default_factory=list)

    def to_scores_json(self) -> dict[str, Any]:
        from .fixture import SCORES_SCHEMA
        return {
            "schema": SCORES_SCHEMA,
            "device": self.device,
            "dtype": self.dtype,
            "seed": self.seed,
            "chunkVariants": self.chunk_variants,
            "roundsChunk": self.rounds_chunk,
            "bootstrapRounds": self.bootstrap_rounds,
            "mcReferenceRounds": self.mc_reference_rounds,
            "timing": self.timing,
            "peakMemoryMb": self.peak_memory_mb,
            "vramBudgetMb": self.vram_mb,
            "deviceName": self.device_name,
            "metrics": self.metrics,
        }


# --- environment ------------------------------------------------------------

def resolve_device(name: str | None) -> torch.device:
    if name in (None, "", "auto"):
        return torch.device("cuda") if torch.cuda.is_available() else torch.device("cpu")
    return torch.device(name)


def resolve_dtype(name: str | torch.dtype) -> torch.dtype:
    if isinstance(name, torch.dtype):
        return name
    try:
        return DTYPES[str(name)]
    except KeyError:
        raise ValueError(f"dtype must be one of {sorted(DTYPES)} (got {name!r})") from None


def device_supports_float64(dev: torch.device) -> bool:
    # Apple MPS has no float64 kernels at all.
    return dev.type != "mps"


def describe_environment(dev: torch.device | None = None) -> dict[str, Any]:
    info: dict[str, Any] = {
        "torch": torch.__version__,
        "cudaAvailable": bool(torch.cuda.is_available()),
        "cudaVersion": getattr(torch.version, "cuda", None),
        "mpsAvailable": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
        "deviceName": None,
        "capability": None,
        "totalVramMb": None,
        "threads": torch.get_num_threads(),
    }
    if torch.cuda.is_available():
        try:
            idx = dev.index if (dev is not None and dev.type == "cuda" and dev.index is not None) else 0
            props = torch.cuda.get_device_properties(idx)
            info["deviceName"] = props.name
            info["capability"] = f"sm_{props.major}{props.minor}"
            info["totalVramMb"] = round(props.total_memory / (1024 * 1024), 1)
        except Exception as exc:  # pragma: no cover - depends on driver
            info["deviceName"] = f"<unavailable: {exc}>"
    elif info["mpsAvailable"]:
        info["deviceName"] = "Apple MPS"
    else:
        info["deviceName"] = "cpu"
    return info


def configure_determinism() -> None:
    torch.set_float32_matmul_precision("highest")
    try:
        torch.use_deterministic_algorithms(True, warn_only=True)
    except Exception:  # pragma: no cover
        pass
    try:
        torch.backends.cuda.matmul.allow_tf32 = False
    except Exception:  # pragma: no cover
        pass
    try:
        torch.backends.cudnn.allow_tf32 = False
    except Exception:  # pragma: no cover
        pass


def _sync(dev: torch.device) -> None:
    if dev.type == "cuda":
        torch.cuda.synchronize()
    elif dev.type == "mps":
        try:
            torch.mps.synchronize()
        except Exception:  # pragma: no cover
            pass


# --- chunk sizing -----------------------------------------------------------

def derive_chunking(
    n_rows: int,
    n_variants: int,
    dtype: torch.dtype,
    vram_mb: int,
    rounds: int,
    chunk_variants: int | None = None,
    rounds_chunk: int | None = None,
) -> tuple[int, int, dict[str, Any]]:
    """Derive (chunk_variants, rounds_chunk) from the VRAM budget.

    n = R // 5 (rows per fold; all 4 folds have the same length)
      chunk  = clamp(floor(0.5  * budget / (n * (41 + 14*itemsize))), 1, V)
      rchunk = clamp(floor(0.25 * budget / (chunk * 4n * (2*itemsize + 8))), 1, rounds)
    41 = 8 (float64 score) + 1 (bool mask) + 32 (int64 argsort index over 4 folds);
    14 = 6 per-fold dtype temporaries + 8 concatenated/compacted dtype planes.
    """
    itemsize = torch.finfo(dtype).bits // 8
    n = max(1, n_rows // (N_FOLDS + 1))
    budget = max(1, int(vram_mb)) * 1024 * 1024
    per_variant = n * (ROW_FIXED_BYTES + CAT_INDEX_BYTES) + n * itemsize * (ROW_TERMS + CAT_TERMS)
    auto_chunk = int((budget * ROW_BUDGET_FRACTION) // max(1, per_variant))
    chunk = max(1, min(n_variants, auto_chunk if auto_chunk > 0 else 1))
    if chunk_variants:
        chunk = max(1, min(n_variants, int(chunk_variants)))
    boot_elem = chunk * (N_FOLDS * n) * (2 * itemsize + BOOT_ELEM_EXTRA)
    auto_rounds = int((budget * BOOT_BUDGET_FRACTION) // max(1, boot_elem))
    rchunk = max(1, min(int(rounds), auto_rounds if auto_rounds > 0 else 1))
    if rounds_chunk:
        rchunk = max(1, min(int(rounds), int(rounds_chunk)))
    model = {
        "rowsPerFold": n,
        "itemsize": itemsize,
        "bytesPerVariant": per_variant,
        "vramBudgetMb": int(vram_mb),
        "autoChunkVariants": auto_chunk,
        "autoRoundsChunk": auto_rounds,
        "estimatedPeakMb": round((chunk * per_variant + chunk * (N_FOLDS * n) * (2 * itemsize + BOOT_ELEM_EXTRA) * rchunk) / (1024 * 1024), 2),
    }
    return chunk, rchunk, model


# --- helpers ----------------------------------------------------------------

def _adjusted_returns(ret: np.ndarray, stress: float) -> np.ndarray:
    """executionAdjusted() over a whole fold, float64 (row-only, variant-free)."""
    friction = 0.35 + stress * 1.45
    slip = stress * np.minimum(4.0, np.maximum(0.0, np.abs(ret) * 0.045))
    return np.maximum(-100.0, (ret - friction) - slip)


def _f(x: float) -> float:
    """Normalise -0.0 -> 0.0 so repeatability comparisons are stable."""
    return float(x) + 0.0


def _bootstrap(
    compact: torch.Tensor,
    n_total: torch.Tensor,
    rounds: int,
    rounds_chunk: int,
    gen: torch.Generator,
    dev: torch.device,
    cdtype: torch.dtype,
) -> torch.Tensor:
    """Seeded bootstrapPass over the compacted per-variant selected returns."""
    vc, n_max = compact.shape
    if n_max == 0 or rounds <= 0:
        return torch.zeros(vc, dtype=torch.float64, device=dev)
    n_safe_i = n_total.clamp(min=1)
    hi_idx = (n_safe_i - 1).view(1, vc, 1)
    n_col = n_safe_i.to(cdtype).view(1, vc, 1)
    n_row = n_safe_i.to(cdtype).view(1, vc)
    slots = torch.arange(n_max, device=dev).view(1, 1, n_max)
    slot_ok = slots < n_total.view(1, vc, 1)
    zero = torch.zeros((), dtype=cdtype, device=dev)
    base = compact.unsqueeze(0)
    positive = torch.zeros(vc, dtype=torch.int64, device=dev)
    done = 0
    while done < rounds:
        rc = min(rounds_chunk, rounds - done)
        u = torch.rand((rc, vc, n_max), generator=gen, device=dev, dtype=cdtype)
        idx = torch.minimum(torch.floor(u * n_col).to(torch.int64), hi_idx)
        vals = torch.gather(base.expand(rc, vc, n_max), 2, idx)
        vals = torch.where(slot_ok, vals, zero)
        s = vals.sum(dim=2)
        positive += ((s / n_row) > 0).sum(dim=0)
        done += rc
        del u, idx, vals, s
    mc = positive.to(torch.float64) / float(rounds) * 100.0
    return torch.where(n_total >= 12, mc, torch.zeros_like(mc))


# --- main entry point -------------------------------------------------------

def score_batch(
    packed: Packed,
    *,
    device: str | torch.device = "auto",
    dtype: str | torch.dtype = "float64",
    seed: int = 1,
    vram_mb: int = DEFAULT_VRAM_MB,
    bootstrap_rounds: int | None = None,
    chunk_variants: int | None = None,
    rounds_chunk: int | None = None,
    mc_reference_rounds: int | None = None,
) -> ScoreResult:
    wall0 = time.perf_counter()
    configure_determinism()

    dev = device if isinstance(device, torch.device) else resolve_device(device)
    cdtype = resolve_dtype(dtype)
    dtype_name = "float64" if cdtype is torch.float64 else "float32"
    if cdtype is torch.float64 and not device_supports_float64(dev):
        raise ValueError(f"device {dev} has no float64 kernels; use --dtype float32")
    sel_dev = dev if device_supports_float64(dev) else torch.device("cpu")
    notes: list[str] = []
    if sel_dev != dev:
        notes.append(f"selection stage forced to {sel_dev} (device lacks float64)")

    rounds = int(bootstrap_rounds if bootstrap_rounds is not None else packed.bootstrap_rounds)
    n_variants = packed.n_variants
    n_rows = packed.n_rows
    chunk, rchunk, model = derive_chunking(
        n_rows, n_variants, cdtype, vram_mb, rounds, chunk_variants, rounds_chunk
    )
    env = describe_environment(dev)

    if dev.type == "cuda":
        torch.cuda.reset_peak_memory_stats(dev)

    if not packed.fold_slices:
        notes.append(f"fold size {packed.fold_size} < 15 -> scoreVariant returns null for every variant")
        wall_ms = (time.perf_counter() - wall0) * 1000.0
        return ScoreResult(
            metrics=[None] * n_variants, device=str(dev), dtype=dtype_name, seed=seed,
            chunk_variants=chunk, rounds_chunk=rchunk, bootstrap_rounds=rounds,
            mc_reference_rounds=mc_reference_rounds,
            timing={"wallMs": wall_ms, "h2dMs": 0.0, "computeMs": 0.0},
            peak_memory_mb=0.0 if dev.type == "cuda" else None, vram_mb=int(vram_mb),
            device_name=str(env.get("deviceName")), notes=notes,
        )

    h2d_ms = 0.0
    compute_ms = 0.0

    # ---- host-side per-fold row tensors (float64, variant independent) -------
    t0 = time.perf_counter()
    fold_cols: list[list[torch.Tensor]] = []
    fold_adj: list[torch.Tensor] = []
    fold_len: list[int] = []
    stress_adj: torch.Tensor | None = None
    for fi, (lo, hi) in enumerate(packed.fold_slices):
        fold_len.append(hi - lo)
        block = np.ascontiguousarray(packed.F[lo:hi])
        cols = [
            torch.from_numpy(np.ascontiguousarray(block[:, k])).to(sel_dev, torch.float64)
            for k in range(N_FEATURES)
        ]
        fold_cols.append(cols)
        adj = _adjusted_returns(packed.ret[lo:hi], 0.2)
        fold_adj.append(torch.from_numpy(adj).to(dev, cdtype))
        if fi == len(packed.fold_slices) - 1:
            s_adj = _adjusted_returns(packed.ret[lo:hi], 0.85)
            stress_adj = torch.from_numpy(s_adj).to(dev, cdtype)
    W_all = torch.from_numpy(np.ascontiguousarray(packed.W))
    thr_all = torch.from_numpy(np.ascontiguousarray(packed.thr))
    stop_all = torch.from_numpy(np.ascontiguousarray(packed.stop))
    take_all = torch.from_numpy(np.ascontiguousarray(packed.take))
    hold_all = torch.from_numpy(np.ascontiguousarray(packed.hold))
    _sync(dev)
    h2d_ms += (time.perf_counter() - t0) * 1000.0

    zero = torch.zeros((), dtype=cdtype, device=dev)
    one = torch.ones((), dtype=cdtype, device=dev)
    pos_inf = torch.full((), float("inf"), dtype=cdtype, device=dev)
    neg99 = torch.full((), -99.0, dtype=cdtype, device=dev)
    gen = torch.Generator(device=dev)
    gen.manual_seed(int(seed) & 0x7FFF_FFFF_FFFF_FFFF)
    ref_gen: torch.Generator | None = None
    if mc_reference_rounds:
        ref_gen = torch.Generator(device=dev)
        ref_gen.manual_seed((int(seed) ^ 0x5DEECE66D) & 0x7FFF_FFFF_FFFF_FFFF)

    out: list[dict[str, Any] | None] = []

    for start in range(0, n_variants, chunk):
        stop_i = min(start + chunk, n_variants)
        t0 = time.perf_counter()
        W = W_all[start:stop_i].to(sel_dev, torch.float64)
        thr_c = thr_all[start:stop_i].to(sel_dev, torch.float64).unsqueeze(1)
        stop_c = stop_all[start:stop_i].to(dev, cdtype).unsqueeze(1)
        take_c = take_all[start:stop_i].to(dev, cdtype).unsqueeze(1)
        hold_v = torch.clamp(hold_all[start:stop_i].to(dev, cdtype), min=1.0)
        _sync(dev)
        h2d_ms += (time.perf_counter() - t0) * 1000.0

        t0 = time.perf_counter()
        vc = stop_i - start
        neg_stop_c = -stop_c
        avg_s, vel_s, act_s, geo_s, comp_s, mdd_s, worst_s, n_s = [], [], [], [], [], [], [], []
        clips: list[torch.Tensor] = []
        sels: list[torch.Tensor] = []
        stress_avg = None

        for fi, cols in enumerate(fold_cols):
            nf = fold_len[fi]
            # --- selection score: exact JS order, float64, no matmul ---------
            score = W[:, 0:1] * cols[0]
            for k in range(1, N_FEATURES):
                score = score + W[:, k:k + 1] * cols[k]
            score = score * 100.0
            sel = score >= thr_c
            del score
            if sel_dev != dev:
                sel = sel.to(dev)

            # --- clipped adjusted returns ------------------------------------
            clip = torch.maximum(torch.minimum(fold_adj[fi].unsqueeze(0), take_c), neg_stop_c)
            n_f = sel.sum(dim=1)
            n_safe = n_f.clamp(min=1).to(cdtype)
            sum_f = torch.where(sel, clip, zero).sum(dim=1)
            has = n_f > 0
            avg_f = torch.where(has, sum_f / n_safe, zero)
            worst_f = torch.clamp(torch.where(sel, clip, pos_inf).amin(dim=1), max=0.0)
            vel_f = torch.where(has, avg_f / hold_v, neg99)
            act_f = n_f.to(torch.float64) / float(nf) * 100.0

            # --- wallet path (JS: wallet*=max(.01,1+r/100); peak starts at 1) --
            factor = torch.where(sel, torch.clamp(1 + clip / 100, min=0.01), one)
            wallet = torch.cumprod(factor, dim=1)
            peak = torch.clamp(torch.cummax(wallet, dim=1).values, min=1.0)
            mdd_f = torch.clamp(((wallet / peak - 1) * 100).amin(dim=1), max=0.0)
            compounded = wallet[:, -1].clone()
            geo_f = torch.where(has, (torch.pow(compounded, 1.0 / n_safe) - 1) * 100, zero)
            del factor, wallet, peak

            if fi == len(fold_cols) - 1 and stress_adj is not None:
                s_clip = torch.maximum(torch.minimum(stress_adj.unsqueeze(0), take_c), neg_stop_c)
                s_sum = torch.where(sel, s_clip, zero).sum(dim=1)
                stress_avg = torch.where(has, s_sum / n_safe, zero)
                del s_clip, s_sum

            avg_s.append(avg_f); vel_s.append(vel_f); act_s.append(act_f)
            geo_s.append(geo_f); comp_s.append(compounded); mdd_s.append(mdd_f)
            worst_s.append(worst_f); n_s.append(n_f)
            clips.append(clip); sels.append(sel)

        # --- 4-fold aggregation (JS reduce order) ---------------------------
        avg = (avg_s[0] + avg_s[1] + avg_s[2] + avg_s[3]) / 4
        vel = (vel_s[0] + vel_s[1] + vel_s[2] + vel_s[3]) / 4
        geo = (geo_s[0] + geo_s[1] + geo_s[2] + geo_s[3]) / 4
        act = (act_s[0] + act_s[1] + act_s[2] + act_s[3]) / 4  # float64
        comp_sorted = torch.sort(torch.stack(comp_s, dim=0), dim=0).values
        comp = (comp_sorted[1] + comp_sorted[2]) / 2
        mdd = torch.stack(mdd_s, dim=0).amin(dim=0)
        worst = torch.stack(worst_s, dim=0).amin(dim=0)
        n_stack = torch.stack(n_s, dim=0)
        samples = n_stack.sum(dim=0)
        enough = (n_stack >= 8).all(dim=0)
        consistency = torch.stack([(a > 0).to(torch.float64) for a in avg_s], dim=0).sum(dim=0) / 4
        samples_f64 = samples.to(torch.float64)
        inactivity = (torch.clamp(10 - act, min=0.0) * 2.2
                      + torch.clamp(32 - samples_f64, min=0.0) * 0.65)

        # --- bootstrap ------------------------------------------------------
        clip_cat = torch.cat(clips, dim=1)
        sel_cat = torch.cat(sels, dim=1)
        del clips, sels
        order = torch.argsort((~sel_cat).to(torch.uint8), dim=1, stable=True)
        compact = torch.gather(clip_cat, 1, order)
        del clip_cat, sel_cat, order
        n_max = int(samples.max().item())
        compact = compact[:, :n_max].contiguous()
        mc = _bootstrap(compact, samples, rounds, rchunk, gen, dev, cdtype)
        mc_ref = None
        if ref_gen is not None:
            mc_ref = _bootstrap(compact, samples, int(mc_reference_rounds), rchunk, ref_gen, dev, cdtype)
        del compact

        # --- robust score ---------------------------------------------------
        act_c = act.to(cdtype)
        inact_c = inactivity.to(cdtype)
        cons_c = consistency.to(cdtype)
        held_avg = avg_s[-1]
        det = (
            avg * 0.45 + geo * 1.5 + vel * 30 + cons_c * 8
            + torch.clamp(stress_avg * 0.30, min=-12.0)
            + torch.clamp(act_c * 0.35, max=8.0)
            + torch.clamp(mdd * 0.06, min=-8.0)
            - inact_c
            - torch.where(enough, zero, torch.full_like(zero, 18.0))
            - torch.clamp(-held_avg, min=0.0) * 0.30
        )
        robust = det + torch.clamp(mc.to(cdtype) / 10, max=10.0)

        _sync(dev)
        compute_ms += (time.perf_counter() - t0) * 1000.0

        # --- emit -----------------------------------------------------------
        h_robust = robust.to("cpu", torch.float64).tolist()
        h_det = det.to("cpu", torch.float64).tolist()
        h_avg = avg.to("cpu", torch.float64).tolist()
        h_geo = geo.to("cpu", torch.float64).tolist()
        h_comp = comp.to("cpu", torch.float64).tolist()
        h_mdd = mdd.to("cpu", torch.float64).tolist()
        h_vel = vel.to("cpu", torch.float64).tolist()
        h_cons = (consistency * 100).to("cpu", torch.float64).tolist()
        h_act = act.to("cpu", torch.float64).tolist()
        h_inact = inactivity.to("cpu", torch.float64).tolist()
        h_held_avg = held_avg.to("cpu", torch.float64).tolist()
        h_held_n = n_s[-1].to("cpu").tolist()
        h_stress = stress_avg.to("cpu", torch.float64).tolist()
        h_mc = mc.to("cpu", torch.float64).tolist()
        h_worst = worst.to("cpu", torch.float64).tolist()
        h_samples = samples.to("cpu").tolist()
        h_mc_ref = mc_ref.to("cpu", torch.float64).tolist() if mc_ref is not None else None

        for i in range(vc):
            row = {
                "robustScore": _f(h_robust[i]),
                "walkAvgPct": _f(h_avg[i]),
                "geometricMeanPct": _f(h_geo[i]),
                "compoundedMultiple": _f(h_comp[i]),
                "maxDrawdownPct": _f(h_mdd[i]),
                "profitVelocityPctPerMin": _f(h_vel[i]),
                "consistencyPct": _f(h_cons[i]),
                "activityPct": _f(h_act[i]),
                "inactivityPenalty": _f(h_inact[i]),
                "heldOutAvgPct": _f(h_held_avg[i]),
                "heldOutN": int(h_held_n[i]),
                "stressAvgPct": _f(h_stress[i]),
                "monteCarloPassPct": _f(h_mc[i]),
                "worstPct": _f(h_worst[i]),
                "samples": int(h_samples[i]),
                "robustScoreDeterministic": _f(h_det[i]),
            }
            if h_mc_ref is not None:
                row["monteCarloPassPctReference"] = _f(h_mc_ref[i])
            out.append(row)

    peak = None
    if dev.type == "cuda":
        peak = round(torch.cuda.max_memory_allocated(dev) / (1024 * 1024), 3)

    wall_ms = (time.perf_counter() - wall0) * 1000.0
    result = ScoreResult(
        metrics=out, device=str(dev), dtype=dtype_name, seed=int(seed),
        chunk_variants=chunk, rounds_chunk=rchunk, bootstrap_rounds=rounds,
        mc_reference_rounds=int(mc_reference_rounds) if mc_reference_rounds else None,
        timing={"wallMs": wall_ms, "h2dMs": h2d_ms, "computeMs": compute_ms},
        peak_memory_mb=peak, vram_mb=int(vram_mb),
        device_name=str(env.get("deviceName")), notes=notes,
    )
    result.notes.append(
        "chunk model: " + ", ".join(f"{k}={v}" for k, v in model.items())
    )
    return result
