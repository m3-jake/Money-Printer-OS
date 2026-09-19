"""Pure-Python mirror of src/evolutionWorker.js scoreVariant() -- TEST ORACLE ONLY.

Operation order is deliberately identical to the JavaScript (sequential
`reduce` sums, multiply-then-add model score, sequential wallet loop) so the
batched torch implementation can be diffed against it at 1e-9.  This module is
never used on a hot path and imports nothing from the live engine.
"""
from __future__ import annotations

import random
from typing import Any, Sequence

from .fixture import DEFAULT_BOOTSTRAP_ROUNDS, N_FEATURES, Packed


def js_mean(values: Sequence[float]) -> float:
    """JS: a.length ? a.reduce((q,x)=>q+Number(x||0),0)/a.length : 0"""
    if not values:
        return 0.0
    q = 0.0
    for x in values:
        q = q + x
    return q / len(values)


def js_median(values: Sequence[float]) -> float:
    """JS: sort ascending; odd -> middle, even -> mean of the middle two."""
    if not values:
        return 0.0
    x = sorted(values)
    m = len(x) // 2
    return x[m] if len(x) % 2 else (x[m - 1] + x[m]) / 2


def model_score(weights: Sequence[float], feats: Sequence[float]) -> float:
    """JS: FEATURES.reduce((q,k)=>q+Number(w[k]||0)*Number(f[k]||0),0)*100"""
    q = 0.0
    for k in range(N_FEATURES):
        q = q + weights[k] * feats[k]
    return q * 100.0


def execution_adjusted(ret: float, stress: float = 0.0) -> float:
    """JS: friction = .35+stress*1.45; slip = stress*max(0,min(4,|ret|*.045));
    return max(-100, ret-friction-slip)"""
    friction = 0.35 + stress * 1.45
    slip = stress * max(0.0, min(4.0, abs(ret) * 0.045))
    return max(-100.0, (ret - friction) - slip)


class RowView:
    """Python-float view of a Packed fixture (avoids numpy scalar overhead)."""

    def __init__(self, packed: Packed):
        self.F = [list(map(float, row)) for row in packed.F]
        self.ret = [float(x) for x in packed.ret]
        self.W = [list(map(float, row)) for row in packed.W]
        self.thr = [float(x) for x in packed.thr]
        self.stop = [float(x) for x in packed.stop]
        self.take = [float(x) for x in packed.take]
        self.hold = [float(x) for x in packed.hold]
        self.fold_slices = list(packed.fold_slices)
        self.n_variants = packed.n_variants


def metrics(view: RowView, v: int, lo: int, hi: int, stress: float = 0.0) -> dict[str, Any]:
    """Mirror of evolutionWorker.js metrics(v, rows, stress)."""
    w = view.W[v]
    threshold = view.thr[v]
    stop = view.stop[v]
    take = view.take[v]
    selected: list[float] = []
    F, RET = view.F, view.ret
    for r in range(lo, hi):
        if model_score(w, F[r]) < threshold:
            continue
        ret = execution_adjusted(RET[r], stress)
        ret = max(-stop, min(take, ret))
        selected.append(ret)

    n = len(selected)
    avg = js_mean(selected)
    down = [x for x in selected if x < 0]
    worst = min(down) if down else 0.0
    velocity = (avg / max(1.0, view.hold[v])) if n else -99.0
    total = hi - lo
    activity_pct = (n / total * 100.0) if total else 0.0

    wallet = 1.0
    peak = 1.0
    max_drawdown_pct = 0.0
    for r in selected:
        wallet *= max(0.01, 1 + r / 100)
        peak = max(peak, wallet)
        max_drawdown_pct = min(max_drawdown_pct, (wallet / peak - 1) * 100)
    geometric_mean_pct = ((wallet ** (1 / n) - 1) * 100) if n else 0.0

    return {
        "n": n, "avg": avg, "worstPct": worst, "velocity": velocity,
        "activityPct": activity_pct, "geometricMeanPct": geometric_mean_pct,
        "compoundedMultiple": wallet, "maxDrawdownPct": max_drawdown_pct,
        "returns": selected,
    }


def bootstrap_pass(returns: Sequence[float], rounds: int, rng: random.Random) -> float:
    """JS bootstrapPass(): Math.random() replaced by a seeded random.Random."""
    n = len(returns)
    if rounds <= 0 or n < 12:
        return 0.0
    positive = 0
    for _ in range(rounds):
        s = 0.0
        for _ in range(n):
            s += returns[int(rng.random() * n)]
        if s / n > 0:
            positive += 1
    return positive / rounds * 100.0


def score_variant(
    view: RowView,
    v: int,
    rounds: int = DEFAULT_BOOTSTRAP_ROUNDS,
    rng: random.Random | None = None,
) -> dict[str, Any] | None:
    """Mirror of evolutionWorker.js scoreVariant(); None when size < 15."""
    folds = view.fold_slices
    if not folds:
        return None
    rng = rng or random.Random(0)

    walk = [metrics(view, v, lo, hi, 0.2) for (lo, hi) in folds]
    held = walk[-1]
    stress = metrics(view, v, folds[-1][0], folds[-1][1], 0.85)

    enough = all(m["n"] >= 8 for m in walk)
    consistency = len([m for m in walk if m["avg"] > 0]) / len(walk)
    avg = js_mean([m["avg"] for m in walk])
    velocity = js_mean([m["velocity"] for m in walk])
    activity_pct = js_mean([m["activityPct"] for m in walk])
    geometric_mean_pct = js_mean([m["geometricMeanPct"] for m in walk])
    compounded = js_median([m["compoundedMultiple"] for m in walk])
    max_drawdown_pct = min(m["maxDrawdownPct"] for m in walk)
    total_samples = 0
    for m in walk:
        total_samples = total_samples + m["n"]

    flat: list[float] = []
    for m in walk:
        flat.extend(m["returns"])
    mc = bootstrap_pass(flat, rounds, rng)

    inactivity = max(0.0, 10 - activity_pct) * 2.2 + max(0.0, 32 - total_samples) * 0.65

    # Exact JS chain order (the min(10, mc/10) term sits mid-chain).
    robust = (
        avg * 0.45 + geometric_mean_pct * 1.5 + velocity * 30 + consistency * 8
        + min(10.0, mc / 10) + max(-12.0, stress["avg"] * 0.30)
        + min(8.0, activity_pct * 0.35) + max(-8.0, max_drawdown_pct * 0.06)
        - inactivity - (0 if enough else 18) - max(0.0, -held["avg"]) * 0.30
    )
    # Spec order for the deterministic score (MC term factored out to the end).
    robust_det = (
        avg * 0.45 + geometric_mean_pct * 1.5 + velocity * 30 + consistency * 8
        + max(-12.0, stress["avg"] * 0.30)
        + min(8.0, activity_pct * 0.35) + max(-8.0, max_drawdown_pct * 0.06)
        - inactivity - (0 if enough else 18) - max(0.0, -held["avg"]) * 0.30
    )

    return {
        "robustScore": robust,
        "walkAvgPct": avg,
        "geometricMeanPct": geometric_mean_pct,
        "compoundedMultiple": compounded,
        "maxDrawdownPct": max_drawdown_pct,
        "profitVelocityPctPerMin": velocity,
        "consistencyPct": consistency * 100,
        "activityPct": activity_pct,
        "inactivityPenalty": inactivity,
        "heldOutAvgPct": held["avg"],
        "heldOutN": held["n"],
        "stressAvgPct": stress["avg"],
        "monteCarloPassPct": mc,
        "worstPct": min(m["worstPct"] for m in walk),
        "samples": total_samples,
        "robustScoreDeterministic": robust_det,
    }


def score_all(
    packed: Packed,
    rounds: int = DEFAULT_BOOTSTRAP_ROUNDS,
    seed: int = 1,
) -> list[dict[str, Any] | None]:
    """Score every variant.  One shared RNG stream mirrors the global Math.random."""
    view = RowView(packed)
    rng = random.Random(seed)
    return [score_variant(view, v, rounds, rng) for v in range(view.n_variants)]
