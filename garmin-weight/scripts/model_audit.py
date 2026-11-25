#!/usr/bin/env python3
"""Audit the garmin-weight prediction models from the CSV, offline.

P6(M9): there is no second set of formulas here any more. The audit runs the
operational summary builder (sync_garmin.build_summary), so its numbers are the
ones the page shows: every model on the same cutoffs with the same actual
matching, the shadow gate, and the 80% interval hit rate replayed per cutoff.

    python garmin-weight/scripts/model_audit.py [--csv ...] [--config ...] [--output audit.json]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

SCRIPTS = Path(__file__).resolve().parent


def _load_sync_garmin() -> Any:
    spec = importlib.util.spec_from_file_location("garmin_sync_for_audit", SCRIPTS / "sync_garmin.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("sync_garmin.py not found")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclass가 모듈을 찾을 수 있어야 한다
    spec.loader.exec_module(module)
    return module


def build_audit(csv_path: Path, config_path: Path) -> dict[str, Any]:
    sync_garmin = _load_sync_garmin()
    rows = sync_garmin.normalize_rows(sync_garmin.load_existing_rows(csv_path))
    summary = sync_garmin.build_summary(rows, sync_garmin.load_json(config_path), detail=True)
    diagnostics = summary.get("modelDiagnostics", {})
    return {
        "source": {"csv": str(csv_path), "config": str(config_path), "rows": len(rows)},
        "sampleCounts": diagnostics.get("backtestSampleCounts", {}),
        "models": {"current": diagnostics.get("backtest", {}), **diagnostics.get("modelAudit", {})},
        "shadowGate": diagnostics.get("selectedModel"),
        "ciHitRate": diagnostics.get("ciCalibration", {}),
        # MD4: the operational model split by the trend at the cutoff. Compare maeKg with flatMaeKg in each group.
        "regimes": diagnostics.get("regimes", {}),
        "lossRate": {
            key: summary.get("rolling", {}).get("lossRateDetail", {}).get(key)
            for key in ("blended", "longRangeRate", "longRangeSlopes", "longRangeApplied")
        },
        "notes": [
            "Same code path as summary.json (sync_garmin.build_summary).",
            "Every model uses the same cutoffs and the same nearest actual within ±3 days.",
            "Weight change sign: predictions are weights; bias = predicted - actual.",
            "ciHitRate replays the 80% interval as it would have been built at each cutoff.",
            "regimes: 'losing' = the blended loss rate at the cutoff was above zero; 'other' = flat, gaining or unknown.",
        ],
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default="garmin-weight/data/daily_metrics.csv")
    parser.add_argument("--config", default="garmin-weight/config.json")
    parser.add_argument("--output", default="")
    args = parser.parse_args(argv)

    payload = build_audit(Path(args.csv), Path(args.config))
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(text, encoding="utf-8")
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
