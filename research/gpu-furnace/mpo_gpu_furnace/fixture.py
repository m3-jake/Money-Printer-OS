"""Fixture packing for the GPU furnace research sidecar.

Loads `mpo.gpu-furnace.fixture.v1` JSON (produced by Node `src/gpuFurnaceContract.js`)
into flat float64 arrays with the exact coercion / ordering / fold semantics of
`src/evolutionWorker.js`.  Research-only: imports nothing from the live engine.
"""
from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np

# Fixed feature order -- must match src/evolutionWorker.js FEATURES exactly.
FEATURES: tuple[str, ...] = (
    "edge", "explosion", "execution", "momentum", "liquidity",
    "freshness", "flow", "volumeAccel", "priceAccel",
)
N_FEATURES = len(FEATURES)

FIXTURE_SCHEMA = "mpo.gpu-furnace.fixture.v1"
SCORES_SCHEMA = "mpo.gpu-furnace.scores.v1"
REPORT_SCHEMA = "mpo.gpu-furnace.report.v1"

N_FOLDS = 4
MIN_FOLD_ROWS = 15
DEFAULT_BOOTSTRAP_ROUNDS = 90

# Metric keys emitted by evolutionWorker.js scoreVariant(), in worker order.
WORKER_METRIC_KEYS: tuple[str, ...] = (
    "robustScore", "walkAvgPct", "geometricMeanPct", "compoundedMultiple",
    "maxDrawdownPct", "profitVelocityPctPerMin", "consistencyPct", "activityPct",
    "inactivityPenalty", "heldOutAvgPct", "heldOutN", "stressAvgPct",
    "monteCarloPassPct", "worstPct", "samples",
)
# Sidecar addition (CPU equivalent = robustScore - min(10, monteCarloPassPct/10)).
DETERMINISTIC_KEY = "robustScoreDeterministic"
# Fields that are pure functions of integer counts / the selection mask.
MASK_DERIVED_KEYS: tuple[str, ...] = (
    "samples", "heldOutN", "activityPct", "consistencyPct", "inactivityPenalty",
)
# Deterministic metric keys (everything except the two Monte-Carlo-dependent ones).
DETERMINISTIC_KEYS: tuple[str, ...] = (
    "walkAvgPct", "geometricMeanPct", "compoundedMultiple", "maxDrawdownPct",
    "profitVelocityPctPerMin", "consistencyPct", "activityPct", "inactivityPenalty",
    "heldOutAvgPct", "heldOutN", "stressAvgPct", "worstPct", "samples",
    DETERMINISTIC_KEY,
)
INTEGER_KEYS: tuple[str, ...] = ("samples", "heldOutN")

# evolutionWorker.js metrics() computes median/winPct/sharpe but scoreVariant()
# never reads them, so the sidecar does not compute them at all.
OMITTED_WORKER_FIELDS: tuple[str, ...] = ("median", "winPct", "sharpe")


def js_number(value: Any) -> float:
    """Mirror of JavaScript ``Number(x || 0)``.

    Falsy (None/False/0/-0/NaN/'') -> 0.0; True -> 1.0; numeric strings parse.
    Divergence from strict JS, per the task contract: a non-numeric *truthy*
    string yields 0.0 here where JS would yield NaN (NaN would poison every
    downstream reduction; fixtures never contain such values).
    ``Infinity`` is preserved because JS treats it as truthy.
    """
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if value is None:
        return 0.0
    if isinstance(value, (int, float, np.integer, np.floating)):
        f = float(value)
        if math.isnan(f) or f == 0.0:
            return 0.0
        return f
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return 0.0
        try:
            f = float(s)
        except ValueError:
            return 0.0
        if math.isnan(f) or f == 0.0:
            return 0.0
        return f
    return 0.0


def fold_layout(n_rows: int, n_folds: int = N_FOLDS) -> tuple[int, list[tuple[int, int]]]:
    """folds(rows, 4) from evolutionWorker.js: size = floor(R/5), folds 1..4.

    Rows [0, size) and [5*size, R) are never scored.  size < 15 -> no folds,
    which makes scoreVariant() return null for every variant.
    """
    size = n_rows // (n_folds + 1)
    if size < MIN_FOLD_ROWS:
        return size, []
    return size, [(size * i, size * (i + 1)) for i in range(1, n_folds + 1)]


@dataclass
class Packed:
    """Flat float64 view of a fixture."""

    F: np.ndarray                 # [R, 9] float64, ts-sorted
    ret: np.ndarray               # [R]    float64
    ts: np.ndarray                # [R]    float64 (sort key only)
    W: np.ndarray                 # [V, 9] float64
    thr: np.ndarray               # [V]    float64
    stop: np.ndarray              # [V]    float64
    take: np.ndarray              # [V]    float64
    hold: np.ndarray              # [V]    float64
    ids: list[str]
    fold_size: int
    fold_slices: list[tuple[int, int]]
    features: tuple[str, ...] = FEATURES
    schema: str = FIXTURE_SCHEMA
    seed: int = 0
    source: str = "synthetic"
    bootstrap_rounds: int = DEFAULT_BOOTSTRAP_ROUNDS
    parent_ids: list[Any] = field(default_factory=list)
    test_lanes: list[Any] = field(default_factory=list)
    cpu_metrics: list[dict | None] | None = None
    cpu_timing: dict | None = None
    node_version: str | None = None
    path: str | None = None

    @property
    def n_rows(self) -> int:
        return int(self.F.shape[0])

    @property
    def n_variants(self) -> int:
        return int(self.W.shape[0])

    @property
    def has_folds(self) -> bool:
        return bool(self.fold_slices)


def _coerce_rows(rows: Sequence[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = len(rows)
    F = np.zeros((n, N_FEATURES), dtype=np.float64)
    ret = np.zeros(n, dtype=np.float64)
    ts = np.zeros(n, dtype=np.float64)
    for i, row in enumerate(rows):
        feats = row.get("features") or {}
        for k, name in enumerate(FEATURES):
            F[i, k] = js_number(feats.get(name))
        ret[i] = js_number(row.get("returnPct"))
        ts[i] = js_number(row.get("ts"))
    return F, ret, ts


def _coerce_variants(variants: Sequence[dict]):
    v = len(variants)
    W = np.zeros((v, N_FEATURES), dtype=np.float64)
    thr = np.zeros(v, dtype=np.float64)
    stop = np.zeros(v, dtype=np.float64)
    take = np.zeros(v, dtype=np.float64)
    hold = np.zeros(v, dtype=np.float64)
    ids: list[str] = []
    parents: list[Any] = []
    lanes: list[Any] = []
    for i, var in enumerate(variants):
        weights = var.get("weights") or {}
        for k, name in enumerate(FEATURES):
            W[i, k] = js_number(weights.get(name))
        # evolutionWorker.js reads these raw (no ||0); fixtures always supply them.
        thr[i] = js_number(var.get("threshold"))
        stop[i] = js_number(var.get("stopPct"))
        take[i] = js_number(var.get("takePct"))
        hold[i] = js_number(var.get("maxHoldMin"))
        ids.append(str(var.get("id", f"V{i + 1:04d}")))
        parents.append(var.get("parentId"))
        lanes.append(var.get("testLane"))
    return W, thr, stop, take, hold, ids, parents, lanes


def pack_fixture(obj: dict, *, path: str | None = None) -> Packed:
    """Validate + pack a fixture dict into :class:`Packed`."""
    schema = obj.get("schema")
    if schema != FIXTURE_SCHEMA:
        raise ValueError(f"unexpected fixture schema {schema!r} (want {FIXTURE_SCHEMA!r})")
    feats = tuple(obj.get("features") or ())
    if feats != FEATURES:
        raise ValueError(f"feature order mismatch: {feats!r} != {FEATURES!r}")
    rows = obj.get("rows")
    variants = obj.get("variants")
    if not isinstance(rows, list) or not isinstance(variants, list):
        raise ValueError("fixture must contain list 'rows' and list 'variants'")
    if not variants:
        raise ValueError("fixture contains no variants")

    F, ret, ts = _coerce_rows(rows)
    # JS: [...rows].sort((a,b)=>Number(a.ts)-Number(b.ts)) -- stable since ES2019.
    order = np.argsort(ts, kind="stable")
    F, ret, ts = F[order], ret[order], ts[order]

    W, thr, stop, take, hold, ids, parents, lanes = _coerce_variants(variants)
    size, slices = fold_layout(len(rows))

    cpu = obj.get("cpu") or {}
    cpu_metrics = cpu.get("metrics") if isinstance(cpu.get("metrics"), list) else None
    if cpu_metrics is not None and len(cpu_metrics) != len(variants):
        raise ValueError("cpu.metrics length does not match variants length")

    return Packed(
        F=F, ret=ret, ts=ts, W=W, thr=thr, stop=stop, take=take, hold=hold,
        ids=ids, fold_size=size, fold_slices=slices, features=feats, schema=schema,
        seed=int(obj.get("seed") or 0), source=str(obj.get("source") or "unknown"),
        bootstrap_rounds=int(obj.get("bootstrapRounds") or DEFAULT_BOOTSTRAP_ROUNDS),
        parent_ids=parents, test_lanes=lanes,
        cpu_metrics=cpu_metrics,
        cpu_timing=cpu.get("timing") if isinstance(cpu.get("timing"), dict) else None,
        node_version=cpu.get("node"), path=path,
    )


def load_fixture(path: str) -> Packed:
    with open(path, "r", encoding="utf-8") as fh:
        return pack_fixture(json.load(fh), path=str(path))


def make_synthetic_fixture(
    seed: int = 7,
    variants: int = 64,
    rows: int = 600,
    *,
    bootstrap_rounds: int = DEFAULT_BOOTSTRAP_ROUNDS,
    thresholds: Any = "auto",
) -> dict:
    """Deterministic synthetic fixture dict (no cpu block).

    Distribution is arbitrary but seeded/reproducible: features ~ U(-1, 1),
    returnPct ~ gauss(0.15, 3.5), weights ~ U(-0.5, 0.5), thresholds spread so
    that selection rates vary widely across variants.  Rows are emitted in
    shuffled order so the packer's ts sort is exercised.
    """
    rng = random.Random(seed)
    base_ts = 1_700_000_000_000
    row_objs = []
    for i in range(rows):
        row_objs.append({
            "ts": base_ts + i * 60_000,
            "returnPct": round(rng.gauss(0.15, 3.5), 9),
            "features": {name: round(rng.uniform(-1.0, 1.0), 9) for name in FEATURES},
        })
    shuffled = list(row_objs)
    rng.shuffle(shuffled)

    var_objs = []
    for i in range(variants):
        if thresholds == "auto":
            thr = round(rng.uniform(-40.0, 60.0), 9)
        elif isinstance(thresholds, (int, float)):
            thr = float(thresholds)
        else:
            thr = float(thresholds[i % len(thresholds)])
        var_objs.append({
            "id": f"V{i + 1:04d}",
            "weights": {name: round(rng.uniform(-0.5, 0.5), 9) for name in FEATURES},
            "threshold": thr,
            "stopPct": round(rng.uniform(2.0, 14.0), 9),
            "takePct": round(rng.uniform(2.0, 18.0), 9),
            "maxHoldMin": rng.randint(1, 45),
            "parentId": None if i == 0 else "V0001",
            "testLane": i % 3,
        })

    return {
        "schema": FIXTURE_SCHEMA,
        "features": list(FEATURES),
        "seed": seed,
        "generatedAt": 0,
        "source": "synthetic",
        "bootstrapRounds": bootstrap_rounds,
        "rows": shuffled,
        "variants": var_objs,
    }


def make_synthetic(seed: int = 7, variants: int = 64, rows: int = 600, **kwargs) -> Packed:
    """Seeded synthetic :class:`Packed` for tests / selfcheck."""
    return pack_fixture(make_synthetic_fixture(seed, variants, rows, **kwargs))
