from __future__ import annotations

from datetime import date, timedelta

from scripts.sync_modeling import (
    apply_model_selection_gate,
    data_quality_diagnostics,
    model_trend_exposure,
    nearest_actual_for_backtest,
    summarize_backtest_errors,
    run_generalized_backtest,
)


def test_data_quality_flags_low_coverage_and_streak():
    rows = [{"date": date.fromisoformat("2026-05-01").isoformat(), "weight_kg": 80.0}]
    for i in range(1, 45):
        day = date(2026, 5, 1) + timedelta(days=i)
        weight = 80.0 if i % 6 == 0 else None
        rows.append({"date": day.isoformat(), "weight_kg": weight})
    result = data_quality_diagnostics(rows, window_days=30)
    assert result["recentCoveragePct"] < 70
    assert result["longestMissingStreak"] >= 5
    assert "recent_coverage_low" in result["confidencePenalties"]
    assert "missing_streak_long" in result["confidencePenalties"]
    assert result["usableForRegression"] is False


def test_candidate_predictions_include_regression_candidates():
    dates = [date(2026, 5, 1) + timedelta(days=i).isoformat() for i in range(60)]
    values = [80.0 + i * 0.01 for i in range(60)]
    cutoff_dates = dates[:40]
    cutoff_values = values[:40]
    ewma = cutoff_values[-1]
    candidates = [
        "linear_regression_28d",
        "linear_regression_56d",
        "linear_regression_84d",
        "weighted_linear_regression_56d",
        "robust_regression_56d",
    ]
    found = {
        candidate: compute_candidate_prediction(candidate, cutoff_dates, cutoff_values, ewma, cutoff_values[-1])
        for candidate in candidates
    }
    for candidate, (predicted, weekly_change, reason) in found.items():
        assert reason is None, candidate
        assert predicted is not None, candidate
        assert weekly_change is not None, candidate


def test_selection_gate_blocks_single_horizon_win():
    audit = {
        "flat_baseline": {"7d": {"sampleCount": 30, "maeKg": 0.60, "status": "ok"}, "14d": {"sampleCount": 30, "maeKg": 0.61, "status": "ok"}, "28d": {"sampleCount": 30, "maeKg": 0.62, "status": "ok"}},
        "linear_regression_56d": {"7d": {"sampleCount": 30, "maeKg": 0.50, "status": "ok"}, "14d": {"sampleCount": 30, "maeKg": 0.61, "status": "ok"}, "28d": {"sampleCount": 30, "maeKg": 0.63, "status": "ok"}},
    }
    current_metrics = {"7d": {"sampleCount": 30, "maeKg": 0.55, "status": "ok"}, "14d": {"sampleCount": 30, "maeKg": 0.60, "status": "ok"}, "28d": {"sampleCount": 30, "maeKg": 0.58, "status": "ok"}}
    result = apply_model_selection_gate(audit, current_metrics)
    assert result["status"] == "kept_current"
    assert result["name"] == "current"


def test_negative_trend_disables_prediction():
    trend = model_trend_exposure(weekly_change_kg=-0.2, weekly_loss_rate_kg=None)
    assert trend["direction"] == "gaining"
    assert trend["predictionEnabled"] is False
    assert "trend_is_gaining" in trend["disabledReason"]


def test_backtest_actual_matching():
    rows = []
    weight = 80.0
    start = date(2026, 5, 1)
    for i in range(60):
        day = start + timedelta(days=i)
        weight = max(weight - 0.02, 70.0)
        rows.append({"date": day.isoformat(), "weight_kg": round(weight, 2)})
    rows[40]["weight_kg"] = None
    rows[41]["weight_kg"] = round(rows[39]["weight_kg"] + 0.5, 2)
    actual = nearest_actual_for_backtest(rows, date.fromisoformat(rows[44]["date"]) + timedelta(days=7), 42, tolerance_days=3)
    assert actual is not None
    summary = summarize_backtest_errors([actual, actual])
    assert summary["sampleCount"] == 2
    assert summary["status"] == "insufficient"
    summary2 = summarize_backtest_errors([actual for _ in range(25)])
    assert summary2["status"] == "ok"


def test_generalized_backtest_does_not_leak_future():
    rows = []
    weight = 80.0
    start = date(2026, 5, 1)
    for i in range(60):
        weight = max(weight - 0.05, 70.0)
        rows.append({"date": (start + timedelta(days=i)).isoformat(), "weight_kg": round(weight, 2)})
    ewma_series = [{"date": r["date"], "valueKg": r["weight_kg"]} for r in rows]
    result = run_generalized_backtest(rows, ewma_series, candidate_names=["linear_regression_56d"])
    assert "linear_regression_56d" in result
    assert result["linear_regression_56d"]["7d"]["sampleCount"] >= 20
