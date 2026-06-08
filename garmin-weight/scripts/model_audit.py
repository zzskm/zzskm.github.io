#!/usr/bin/env python3
"""Audit Garmin weight prediction outputs against simple baselines.

This script is intentionally separate from sync_garmin.py. It lets us validate
whether the production model is better than boring baselines before wiring the
result into summary.json. Because apparently even a bathroom scale dashboard
needs a peer review committee now.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable


HORIZONS = (7, 14, 28)


@dataclass(frozen=True)
class Point:
    day: date
    weight: float | None
    ma7: float | None = None
    ewma: float | None = None


def parse_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(number) else number


def round_or_none(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(value, digits)


def mean(values: Iterable[float]) -> float | None:
    values = list(values)
    return sum(values) / len(values) if values else None


def rolling_average(weights: list[float | None], idx: int, window: int) -> float | None:
    start = max(0, idx - window + 1)
    values = [v for v in weights[start:idx + 1] if v is not None]
    return mean(values)


def ewma(weights: list[float | None], lambda_: float = 0.1) -> list[float | None]:
    z: float | None = None
    out: list[float | None] = []
    for value in weights:
      if value is not None:
          z = value if z is None else lambda_ * value + (1 - lambda_) * z
      out.append(z)
    return out


def load_points(csv_path: Path) -> list[Point]:
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    weights = [parse_float(row.get("weight_kg")) for row in rows]
    ewma_values = ewma(weights)

    points: list[Point] = []
    for idx, row in enumerate(rows):
        points.append(Point(
            day=date.fromisoformat(row["date"]),
            weight=weights[idx],
            ma7=rolling_average(weights, idx, 7),
            ewma=ewma_values[idx],
        ))
    return points


def nearest_actual(points: list[Point], target_day: date, start_idx: int, tolerance_days: int = 3) -> float | None:
    candidates: list[tuple[int, float]] = []
    for point in points[start_idx:]:
        if point.weight is None:
            continue
        distance = abs((point.day - target_day).days)
        if distance <= tolerance_days:
            candidates.append((distance, point.weight))
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[0])[1]


def summarize_errors(errors: list[float]) -> dict[str, Any]:
    if not errors:
        return {"sampleCount": 0, "maeKg": None, "biasKg": None, "rmseKg": None, "status": "insufficient"}
    mae = sum(abs(e) for e in errors) / len(errors)
    bias = sum(errors) / len(errors)
    rmse = math.sqrt(sum(e * e for e in errors) / len(errors))
    return {
        "sampleCount": len(errors),
        "maeKg": round(mae, 3),
        "biasKg": round(bias, 3),
        "rmseKg": round(rmse, 3),
        "status": "ok" if len(errors) >= 3 else "insufficient",
    }


def compute_baseline_comparison(points: list[Point], train_window: int = 28) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for horizon in HORIZONS:
        errors = {"flat": [], "ma7": [], "ewma": []}
        for idx in range(train_window, len(points) - horizon):
            point = points[idx - 1]
            target_day = point.day + timedelta(days=horizon)
            actual = nearest_actual(points, target_day, idx)
            if actual is None:
                continue

            predictions = {
                "flat": point.weight,
                "ma7": point.ma7,
                "ewma": point.ewma,
            }
            for name, predicted in predictions.items():
                if predicted is not None:
                    errors[name].append(predicted - actual)

        stats = {name: summarize_errors(values) for name, values in errors.items()}
        maes = {name: data["maeKg"] for name, data in stats.items() if data.get("maeKg") is not None}
        winner = min(maes, key=maes.get) if maes else None
        out[f"{horizon}d"] = {
            "winner": winner,
            "flatMaeKg": stats["flat"]["maeKg"],
            "ma7MaeKg": stats["ma7"]["maeKg"],
            "ewmaMaeKg": stats["ewma"]["maeKg"],
            "samples": {name: stats[name]["sampleCount"] for name in stats},
            "detail": stats,
        }
    return out


def compute_ci_hit_rate(summary: dict[str, Any], points: list[Point]) -> dict[str, float | None]:
    """Estimate whether the current 80% CI width is calibrated on historical residuals.

    This is a first-pass audit. It does not replay the production model for each
    historical date. Instead it compares current CI spread by horizon against
    flat-baseline historical outcomes. A real sync integration should replay the
    model exactly.
    """
    ci_series = summary.get("predictionCI", {}).get("series", []) or []
    spread_by_horizon: dict[int, float] = {}
    for idx, row in enumerate(ci_series, start=1):
        if idx not in (1, 2, 4):
            continue
        lower = parse_float(row.get("lower80"))
        upper = parse_float(row.get("upper80"))
        central = parse_float(row.get("central"))
        if lower is None or upper is None or central is None:
            continue
        spread_by_horizon[idx * 7] = max(abs(central - lower), abs(upper - central))

    out: dict[str, float | None] = {}
    for horizon in HORIZONS:
        spread = spread_by_horizon.get(horizon)
        if spread is None:
            out[f"{horizon}d"] = None
            continue
        hits = 0
        total = 0
        for idx in range(28, len(points) - horizon):
            point = points[idx - 1]
            if point.weight is None:
                continue
            actual = nearest_actual(points, point.day + timedelta(days=horizon), idx)
            if actual is None:
                continue
            total += 1
            if abs(actual - point.weight) <= spread:
                hits += 1
        out[f"{horizon}d"] = round(hits / total, 3) if total else None
    return out


def build_audit(csv_path: Path, summary_path: Path) -> dict[str, Any]:
    points = load_points(csv_path)
    with summary_path.open("r", encoding="utf-8") as handle:
        summary = json.load(handle)

    baseline = compute_baseline_comparison(points)
    ci_hit_rate = compute_ci_hit_rate(summary, points)

    current_backtest = summary.get("modelDiagnostics", {}).get("backtest", {})
    merged: dict[str, Any] = {}
    for horizon in ("7d", "14d", "28d"):
        row = dict(baseline.get(horizon) or {})
        current_mae = parse_float((current_backtest.get(horizon) or {}).get("maeKg"))
        row["currentMaeKg"] = current_mae
        candidates = {
            "flat": row.get("flatMaeKg"),
            "ma7": row.get("ma7MaeKg"),
            "ewma": row.get("ewmaMaeKg"),
            "current": current_mae,
        }
        valid = {k: v for k, v in candidates.items() if v is not None}
        row["winnerWithCurrent"] = min(valid, key=valid.get) if valid else None
        merged[horizon] = row

    return {
        "source": {
            "csv": str(csv_path),
            "summary": str(summary_path),
        },
        "baselineComparison": merged,
        "ciHitRateApprox": ci_hit_rate,
        "notes": [
            "baselineComparison compares current model MAE from summary.json with flat, MA7, and EWMA baselines.",
            "ciHitRateApprox is a calibration smoke test, not a replay of the production model.",
            "Wire this output into summary.json only after validating the numbers on real runs.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default="garmin-weight/data/daily_metrics.csv")
    parser.add_argument("--summary", default="garmin-weight/data/summary.json")
    parser.add_argument("--output", default="")
    args = parser.parse_args()

    payload = build_audit(Path(args.csv), Path(args.summary))
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(text, encoding="utf-8")
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
