from __future__ import annotations

import importlib.util
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "garmin-weight" / "scripts" / "sync_modeling.py"
SPEC = importlib.util.spec_from_file_location("garmin_sync_modeling", MODULE_PATH)
sync_modeling = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = sync_modeling
SPEC.loader.exec_module(sync_modeling)

_projected_weight = sync_modeling._projected_weight
apply_model_selection_gate = sync_modeling.apply_model_selection_gate
compute_candidate_prediction = sync_modeling.compute_candidate_prediction
data_quality_diagnostics = sync_modeling.data_quality_diagnostics
model_trend_exposure = sync_modeling.model_trend_exposure
nearest_actual_for_backtest = sync_modeling.nearest_actual_for_backtest
summarize_backtest_errors = sync_modeling.summarize_backtest_errors
run_generalized_backtest = sync_modeling.run_generalized_backtest
warming_up_trend_exposure = sync_modeling.warming_up_trend_exposure


class GarminModelHardeningTests(unittest.TestCase):
    def test_data_quality_flags_low_coverage_and_streak(self) -> None:
        rows = [{"date": date.fromisoformat("2026-05-01").isoformat(), "weight_kg": 80.0}]
        for i in range(1, 45):
            day = date(2026, 5, 1) + timedelta(days=i)
            weight = 80.0 if i % 6 == 0 else None
            rows.append({"date": day.isoformat(), "weight_kg": weight})
        result = data_quality_diagnostics(rows, window_days=30)
        self.assertLess(result["recentCoveragePct"], 70)
        self.assertGreaterEqual(result["longestMissingStreak"], 5)
        self.assertIn("recent_coverage_low", result["confidencePenalties"])
        self.assertIn("missing_streak_long", result["confidencePenalties"])
        self.assertIs(result["usableForRegression"], False)

    def test_candidate_predictions_include_regression_candidates(self) -> None:
        dates = [(date(2026, 5, 1) + timedelta(days=i)).isoformat() for i in range(60)]
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
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                predicted, weekly_change, reason = compute_candidate_prediction(
                    candidate, cutoff_dates, cutoff_values, ewma, cutoff_values[-1]
                )
                self.assertIsNone(reason)
                self.assertIsNotNone(predicted)
                self.assertIsNotNone(weekly_change)

    def test_selection_gate_blocks_single_horizon_win(self) -> None:
        audit = {
            "flat_baseline": {"7d": {"sampleCount": 30, "maeKg": 0.60, "status": "ok"}, "14d": {"sampleCount": 30, "maeKg": 0.61, "status": "ok"}, "28d": {"sampleCount": 30, "maeKg": 0.62, "status": "ok"}},
            "linear_regression_56d": {"7d": {"sampleCount": 30, "maeKg": 0.50, "status": "ok"}, "14d": {"sampleCount": 30, "maeKg": 0.61, "status": "ok"}, "28d": {"sampleCount": 30, "maeKg": 0.63, "status": "ok"}},
        }
        current_metrics = {"7d": {"sampleCount": 30, "maeKg": 0.55, "status": "ok"}, "14d": {"sampleCount": 30, "maeKg": 0.60, "status": "ok"}, "28d": {"sampleCount": 30, "maeKg": 0.58, "status": "ok"}}
        result = apply_model_selection_gate(audit, current_metrics)
        self.assertEqual("kept_current", result["status"])
        self.assertEqual("current", result["name"])

    def test_gaining_trend_keeps_prediction_enabled(self) -> None:
        trend = model_trend_exposure(weekly_change_kg=-0.2, weekly_loss_rate_kg=None)
        self.assertEqual("gaining", trend["direction"])
        self.assertIs(trend["predictionEnabled"], True)
        self.assertIsNone(trend["disabledReason"])

    def test_unknown_trend_disables_prediction(self) -> None:
        # 체중 측정이 하나도 없을 때만 이 경로를 쓴다. 측정이 있으면 warming_up으로 예측을 낸다.
        trend = model_trend_exposure(weekly_change_kg=None, weekly_loss_rate_kg=None)
        self.assertIs(trend["predictionEnabled"], False)
        self.assertEqual("insufficient_data", trend["disabledReason"])

    def test_warming_up_trend_keeps_prediction_enabled(self) -> None:
        trend = warming_up_trend_exposure(9, 14)
        self.assertEqual("warming_up", trend["direction"])
        self.assertIs(trend["predictionEnabled"], True)
        self.assertEqual("cold_start_flat", trend["rateSource"])
        self.assertIsNone(trend["weeklyChangeKg"])

    def test_projected_weight_gaining_is_linear_upward(self) -> None:
        self.assertEqual(83.8, _projected_weight(83.0, -0.2, 4, target_weight=78.0))

    def test_backtest_actual_matching(self) -> None:
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
        self.assertIsNotNone(actual)
        summary = summarize_backtest_errors([actual, actual])
        self.assertEqual(2, summary["sampleCount"])
        self.assertEqual("insufficient", summary["status"])
        summary2 = summarize_backtest_errors([actual for _ in range(25)])
        self.assertEqual("ok", summary2["status"])

    def test_generalized_backtest_does_not_leak_future(self) -> None:
        rows = []
        weight = 80.0
        start = date(2026, 5, 1)
        for i in range(60):
            weight = max(weight - 0.05, 70.0)
            rows.append({"date": (start + timedelta(days=i)).isoformat(), "weight_kg": round(weight, 2)})
        ewma_series = [{"date": r["date"], "valueKg": r["weight_kg"]} for r in rows]
        result = run_generalized_backtest(rows, ewma_series, candidate_names=["linear_regression_56d"])
        self.assertIn("linear_regression_56d", result)
        self.assertGreaterEqual(result["linear_regression_56d"]["7d"]["sampleCount"], 20)


if __name__ == "__main__":
    unittest.main()
