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
data_quality_diagnostics = sync_modeling.data_quality_diagnostics
model_trend_exposure = sync_modeling.model_trend_exposure
summarize_backtest_errors = sync_modeling.summarize_backtest_errors
run_backtest = sync_modeling.run_backtest
shadow_gate = sync_modeling.shadow_gate
replay_ci_hit_rate = sync_modeling.replay_ci_hit_rate
warming_up_trend_exposure = sync_modeling.warming_up_trend_exposure
SHADOW_MODELS = sync_modeling.SHADOW_MODELS


def _rows(values: list[float | None], start: date = date(2026, 1, 1)) -> list[dict]:
    return [{"date": (start + timedelta(days=i)).isoformat(), "weight_kg": v} for i, v in enumerate(values)]


def _ewma(rows: list[dict]) -> list[dict]:
    values = sync_modeling.compute_ewma([r["weight_kg"] for r in rows])
    return [{"date": r["date"], "valueKg": v} for r, v in zip(rows, values)]


def _stats(mae: float, bias: float, n: int = 40) -> dict:
    return {"sampleCount": n, "maeKg": mae, "rmseKg": mae, "biasKg": bias, "status": "ok"}


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

    def test_error_summary_needs_twenty_samples(self) -> None:
        self.assertEqual("insufficient", summarize_backtest_errors([0.1] * 19)["status"])
        summary = summarize_backtest_errors([0.1] * 20 + [-0.3] * 5)
        self.assertEqual(("ok", 25, 0.14, 0.02), (summary["status"], summary["sampleCount"], summary["maeKg"], summary["biasKg"]))


class UnifiedBacktestTests(unittest.TestCase):
    """P6: 같은 표본, 하나의 부호 규칙, 강건 회귀, bias 게이트, 시점별 신뢰구간 재현."""

    def test_regression_on_exact_line_has_near_zero_error(self) -> None:
        # 부호 회귀 방지(M2). EWMA 자리에 실측을 넣어 수준 지연을 없애면, 맞는 부호의 회귀는 오차가 0에 가깝다.
        rows = _rows([90.0 - 0.05 * i for i in range(150)])
        ewma = [{"date": r["date"], "valueKg": r["weight_kg"]} for r in rows]
        models = run_backtest(rows, ewma, horizons=(7, 14, 28))["models"]
        for name in ("linreg_28d", "linreg_56d", "linreg_84d", "weighted_linreg_56d", "robust_56d"):
            for horizon in ("7d", "14d", "28d"):
                with self.subTest(model=name, horizon=horizon):
                    self.assertLess(models[name][horizon]["maeKg"], 0.01)
        # 변화 없음은 같은 시계열에서 0.05kg × 기간만큼 틀린다(기준선이 맞게 계산되는지).
        self.assertAlmostEqual(0.35, models["ewma_flat"]["7d"]["maeKg"], places=2)

    def test_robust_fit_resists_a_single_outlier(self) -> None:
        # 리포트 M2의 재현: 84.0kg 평탄 구간에 87.0kg 한 점. 예전 robust_regression_56d는 이 점을 1% 키웠다.
        points = [(float(x), 84.0) for x in range(-55, 1)]
        points[48] = (points[48][0], 87.0)
        ols = sync_modeling.ols_fit(points)[0] * 7
        robust = sync_modeling.theil_sen_fit(points)[0] * 7
        self.assertGreater(abs(ols), 0.01)
        self.assertLess(abs(robust), abs(ols))
        self.assertAlmostEqual(0.0, robust, places=6)

    def test_every_model_uses_the_same_sample(self) -> None:
        values = [84.0 + 0.3 * ((i * 7) % 5 - 2) / 2 if i % 3 else None for i in range(200)]
        rows = _rows(values)
        result = run_backtest(rows, _ewma(rows))
        for horizon in ("7d", "14d", "28d", "84d"):
            counts = {name: result["models"][name][horizon]["sampleCount"] for name in ("current", *SHADOW_MODELS)}
            with self.subTest(horizon=horizon):
                self.assertEqual(1, len(set(counts.values())), counts)
                self.assertEqual(result["sampleCounts"][horizon], counts["current"])
                self.assertGreater(counts["current"], 20)

    def test_a_cutoff_that_one_model_cannot_score_is_dropped_for_all(self) -> None:
        # 위 테스트의 픽스처에서는 모든 모델이 모든 기준 시점에서 예측을 내므로 표본 수가 구조상 같다.
        # 40일 동안 측정이 없으면 그 구간의 뒤쪽에서는 28일 회귀가 예측을 내지 못한다. 그 기준 시점은 모든 모델에서 뺀다.
        values = [84.0 + 0.3 * ((i * 7) % 5 - 2) / 2 if i % 3 else None for i in range(200)]
        gap = range(90, 130)
        with_gap = [None if i in gap else value for i, value in enumerate(values)]
        rows = _rows(with_gap)
        result = run_backtest(rows, _ewma(rows))
        full = run_backtest(_rows(values), _ewma(_rows(values)))
        for horizon in ("7d", "14d", "28d", "84d"):
            counts = {name: result["models"][name][horizon]["sampleCount"] for name in ("current", *SHADOW_MODELS)}
            with self.subTest(horizon=horizon):
                self.assertEqual(1, len(set(counts.values())), counts)
                self.assertLess(counts["current"], full["models"]["current"][horizon]["sampleCount"])
        # 기준 시점(index - 1번째 날)의 직전 28일에 측정이 하나도 없는 곳에는 표본이 없다.
        blind = [s["index"] for s in result["samples"][7] if gap.start + 28 <= s["index"] - 1 < gap.stop]
        self.assertEqual([], blind)
        self.assertTrue([s for s in full["samples"][7] if gap.start + 28 <= s["index"] - 1 < gap.stop])

    def test_all_trend_directions_are_evaluated(self) -> None:
        # M3: 감량기만 고르지 않는다. 증량 시계열에서도 운영 모델 표본이 나온다.
        rows = _rows([80.0 + 0.03 * i for i in range(120)])
        current = run_backtest(rows, _ewma(rows))["models"]["current"]
        self.assertEqual("ok", current["7d"]["status"])
        self.assertGreaterEqual(current["7d"]["sampleCount"], 80)

    def test_backtest_does_not_see_the_future(self) -> None:
        values = [84.0 - 0.02 * i for i in range(120)]
        rows = _rows(values)
        base = run_backtest(rows, _ewma(rows), horizons=(7,))
        changed_values = values[:60] + [v + 3.0 for v in values[60:]]
        changed_rows = _rows(changed_values)
        changed = run_backtest(changed_rows, _ewma(changed_rows), horizons=(7,))
        early = [s for s in base["samples"][7] if s["index"] <= 50]
        early_changed = [s for s in changed["samples"][7] if s["index"] <= 50]
        self.assertTrue(early)
        for a, b in zip(early, early_changed):
            self.assertEqual(a["predictions"], b["predictions"])  # 기준 시점 뒤를 바꿔도 예측은 그대로다

    def test_gate_rejects_worse_bias_and_single_wins(self) -> None:
        current = {"7d": _stats(0.60, -0.05), "14d": _stats(0.70, -0.06), "28d": _stats(0.80, -0.10), "84d": _stats(1.40, -0.50)}
        models = {name: dict(current) for name in SHADOW_MODELS}
        models["current"] = current
        # MAE는 네 기간 모두 크게 낮지만 7일 bias가 더 나쁘다 → 탈락.
        models["linreg_56d"] = {"7d": _stats(0.40, -0.20), "14d": _stats(0.50, -0.06), "28d": _stats(0.60, -0.10), "84d": _stats(1.00, -0.40)}
        # 84일에서만 이긴다 → 탈락(여러 기간에서 이겨야 한다).
        models["ewma_flat"] = {"7d": _stats(0.61, -0.05), "14d": _stats(0.71, -0.06), "28d": _stats(0.81, -0.10), "84d": _stats(1.10, -0.40)}
        result = shadow_gate(models)
        self.assertEqual(("no_change", "current", False), (result["status"], result["name"], result["affectsPrediction"]))
        self.assertIn("7d_bias_worse", result["candidates"]["linreg_56d"]["blocked"])
        self.assertEqual(["84d"], result["candidates"]["ewma_flat"]["wins"])
        # bias가 나빠지지 않고 두 기간 이상에서 이기면 shadow_leader가 된다(예측은 바뀌지 않는다).
        models["robust_56d"] = {"7d": _stats(0.50, -0.04), "14d": _stats(0.60, -0.05), "28d": _stats(0.80, -0.10), "84d": _stats(1.40, -0.50)}
        result = shadow_gate(models)
        self.assertEqual(("shadow_leader", "robust_56d"), (result["status"], result["name"]))
        self.assertEqual(["7d", "14d"], result["candidates"]["robust_56d"]["wins"])

    def test_gate_needs_enough_samples(self) -> None:
        models = {name: {"7d": _stats(0.3, 0.0, n=10)} for name in SHADOW_MODELS}
        models["current"] = {"7d": _stats(0.6, 0.0, n=10)}
        result = shadow_gate(models, horizons=(7,))
        self.assertEqual("no_change", result["status"])
        self.assertIn("7d_insufficient", result["candidates"]["ewma_flat"]["blocked"])

    def test_ci_replay_reproduces_known_coverage(self) -> None:
        # 평평한 84kg에 ±0.4kg 교대 잡음. 잔차 표준편차가 약 0.4이므로 7일 반폭은 1.28×0.4≈0.51이고
        # 모든 오차가 그 안에 든다(포함률 1.0). 같은 시계열에 1.5kg 계단을 넣으면 계단 뒤 표본은 벗어난다.
        flat = _rows([84.0 + (0.4 if i % 2 else -0.4) for i in range(160)])
        backtest = run_backtest(flat, _ewma(flat), horizons=(7,))
        replay = replay_ci_hit_rate(backtest, flat, _ewma(flat))
        self.assertEqual(1.0, replay["hitRate"]["7d"])
        self.assertEqual(backtest["sampleCounts"]["7d"], replay["sampleCounts"]["7d"])

        step = _rows([84.0 + (0.4 if i % 2 else -0.4) + (1.5 if i >= 100 else 0.0) for i in range(160)])
        step_bt = run_backtest(step, _ewma(step), horizons=(7,))
        step_replay = replay_ci_hit_rate(step_bt, step, _ewma(step))
        expected = sum(
            1 for s in step_bt["samples"][7]
            if abs(s["actual"] - s["predictions"]["current"]) <= max(1.28 * 0.41, 0.0) + 0.2
        ) / len(step_bt["samples"][7])
        self.assertLess(step_replay["hitRate"]["7d"], 1.0)
        self.assertAlmostEqual(expected, step_replay["hitRate"]["7d"], delta=0.15)

    def test_ci_replay_covers_gaining_trends(self) -> None:
        # M4: 증량 추세에서도 적중률이 나온다(예전에는 감량률이 0 이하면 전부 None).
        rows = _rows([80.0 + 0.03 * i + (0.3 if i % 2 else -0.3) for i in range(150)])
        backtest = run_backtest(rows, _ewma(rows))
        replay = replay_ci_hit_rate(backtest, rows, _ewma(rows))
        self.assertEqual("ok", replay["status"])
        # 예전 테스트는 7일만 봤다. 네 기간 모두 적중률이 나오고 표본 수가 백테스트와 같다.
        for horizon in ("7d", "14d", "28d", "84d"):
            with self.subTest(horizon=horizon):
                self.assertIsNotNone(replay["hitRate"][horizon])
                self.assertTrue(0.0 < replay["hitRate"][horizon] <= 1.0)
                self.assertEqual(backtest["sampleCounts"][horizon], replay["sampleCounts"][horizon])


if __name__ == "__main__":
    unittest.main()
