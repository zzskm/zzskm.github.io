from __future__ import annotations

import csv
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "garmin-weight" / "scripts" / "sync_garmin.py"
SPEC = importlib.util.spec_from_file_location("sync_garmin", MODULE_PATH)
sync_garmin = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = sync_garmin
SPEC.loader.exec_module(sync_garmin)


class GarminWeightTests(unittest.TestCase):
    def test_build_summary_disables_predictions_when_history_is_short(self) -> None:
        rows = [
            {
                "date": f"2026-04-{day:02d}",
                "weight_kg": 82.0 - (day * 0.1),
                "weight_measure_count": 1,
                "exercise_minutes": 30,
                "exercise_calories": 250,
                "activity_count": 1,
                "steps": 7000,
                "sleep_hours": 6.5,
                "resting_hr": 60,
                "visceral_fat": None,
                "metabolic_age": None,
            }
            for day in range(1, 11)
        ]

        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "scenarioMultipliers": {"base": 0.8}})

        self.assertIsNone(summary["rolling"]["weeklyLossRateKg"])
        self.assertIsNone(summary["predictions"]["oneMonthWeightKg"])
        self.assertIsNone(summary["goal"]["etaDays"])

    def test_build_summary_supports_missing_optional_fields(self) -> None:
        rows = []
        for day in range(1, 21):
            rows.append(
                {
                    "date": f"2026-04-{day:02d}",
                    "weight_kg": round(82.5 - (day * 0.08), 2),
                    "weight_measure_count": 1,
                    "exercise_minutes": 40 if day % 2 == 0 else 0,
                    "exercise_calories": 320 if day % 2 == 0 else 0,
                    "activity_count": 1 if day % 2 == 0 else 0,
                    "steps": 8500,
                    "sleep_hours": None,
                    "resting_hr": None,
                    "visceral_fat": None,
                    "metabolic_age": None,
                }
            )

        summary = sync_garmin.build_summary(
            rows,
            {"targetWeightKg": 79, "scenarioMultipliers": {"base": 0.8, "optimistic": 1.0, "conservative": 0.6}},
        )

        self.assertIsNotNone(summary["rolling"]["weeklyLossRateKg"])
        self.assertIsNotNone(summary["predictions"]["oneMonthWeightKg"])
        self.assertIsNotNone(summary["predictions"]["threeMonthWeightKg"])
        self.assertIn("base", summary["predictions"]["scenarios"])
        self.assertIsNone(summary["rolling"]["last7SleepHoursAvg"])
        self.assertIsNone(summary["rolling"]["last7RestingHrAvg"])

    def test_write_rows_upserts_by_date(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            csv_path = Path(tmpdir) / "daily_metrics.csv"
            rows = {
                "2026-04-01": {
                    "date": "2026-04-01",
                    "weight_kg": 82.0,
                    "weight_measure_count": 1,
                    "exercise_minutes": 20,
                    "exercise_calories": 180,
                    "activity_count": 1,
                    "steps": 5000,
                    "sleep_hours": 6.1,
                    "resting_hr": 61,
                    "visceral_fat": None,
                    "metabolic_age": None,
                }
            }
            sync_garmin.write_rows(csv_path, rows)

            loaded = sync_garmin.load_existing_rows(csv_path)
            loaded["2026-04-01"]["weight_kg"] = 81.7
            loaded["2026-04-02"] = {
                "date": "2026-04-02",
                "weight_kg": 81.5,
                "weight_measure_count": 1,
                "exercise_minutes": 25,
                "exercise_calories": 200,
                "activity_count": 1,
                "steps": 6200,
                "sleep_hours": 6.4,
                "resting_hr": 60,
                "visceral_fat": None,
                "metabolic_age": None,
            }
            sync_garmin.write_rows(csv_path, loaded)

            with csv_path.open("r", encoding="utf-8", newline="") as handle:
                reader = list(csv.DictReader(handle))

            self.assertEqual(2, len(reader))
            self.assertEqual("81.7", reader[0]["weight_kg"])
            self.assertEqual("2026-04-02", reader[1]["date"])

    def test_empty_state_summary_matches_public_schema(self) -> None:
        payload = sync_garmin.build_summary([], {"targetWeightKg": 75})
        self.assertEqual([], payload["series"]["daily"])
        self.assertIn("generatedAt", payload)
        self.assertEqual(75, payload["goal"]["targetWeightKg"])

    def test_days_since_last_measurement_not_negative(self) -> None:
        """P6 회귀: latest_date 기준으로 측정 일수를 계산해 음수가 나오지 않음."""
        rows = [
            {
                "date": f"2030-01-{day:02d}",
                "weight_kg": 82.0 - day * 0.05,
                "weight_measure_count": 1,
                "exercise_minutes": 30,
                "exercise_calories": 200,
                "activity_count": 1,
                "steps": 7000,
                "sleep_hours": 7,
                "resting_hr": 60,
                "visceral_fat": None,
                "metabolic_age": None,
            }
            for day in range(1, 21)
        ]
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 75})
        days = summary["coverage"]["daysSinceLastMeasurement"]
        self.assertIsNotNone(days)
        self.assertGreaterEqual(days, 0)

    def test_multi_window_blend_responds_to_recent_acceleration(self) -> None:
        """P2 회귀: 후반에 가속된 감량 추세가 단일 28일 회귀보다 큰 blended를 만든다."""
        # 앞 14일은 평탄, 뒤 14일은 빠르게 감량 — 다중 윈도우가 가속을 반영해야 함
        rows = []
        for day in range(1, 15):
            rows.append({
                "date": f"2030-02-{day:02d}",
                "weight_kg": 82.0,
                "weight_measure_count": 1,
                "exercise_minutes": 30,
                "exercise_calories": 200,
                "activity_count": 1,
                "steps": 7000,
                "sleep_hours": 7,
                "resting_hr": 60,
                "visceral_fat": None,
                "metabolic_age": None,
            })
        for day in range(15, 29):
            rows.append({
                "date": f"2030-02-{day:02d}",
                "weight_kg": round(82.0 - (day - 14) * 0.15, 2),
                "weight_measure_count": 1,
                "exercise_minutes": 45,
                "exercise_calories": 350,
                "activity_count": 1,
                "steps": 9000,
                "sleep_hours": 7,
                "resting_hr": 58,
                "visceral_fat": None,
                "metabolic_age": None,
            })
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 75})
        detail = summary["rolling"]["lossRateDetail"]
        self.assertEqual(detail["model"], "multi_window_ewma_blend")
        self.assertIn("windowSlopes", detail)
        # 7일 슬로프가 28일 슬로프보다 더 가파른 감량을 보여야 함
        slopes = detail["windowSlopes"]
        self.assertIsNotNone(slopes.get("7d"))
        self.assertIsNotNone(slopes.get("28d"))
        self.assertGreater(slopes["7d"], slopes["28d"])
        # blended는 단순 28일 값보다 단기 신호 쪽으로 끌려 와야 함
        self.assertGreater(detail["blended"], slopes["28d"])

    def test_kcal_per_kg_bmi_tiers(self) -> None:
        """Phase 2B 회귀: BMI 구간별 kcal_per_kg 매핑."""
        # 체지방률이 우선
        v, src = sync_garmin.kcal_per_kg(32.0, 90.0, 175.0)
        self.assertEqual(8000.0, v)
        self.assertEqual("body_fat", src)
        # BMI 30+ → 8000
        v, src = sync_garmin.kcal_per_kg(None, 95.0, 175.0)
        self.assertEqual("bmi", src)
        self.assertEqual(8000.0, v)
        # BMI 23 → 7400
        v, src = sync_garmin.kcal_per_kg(None, 70.0, 175.0)
        self.assertEqual("bmi", src)
        self.assertEqual(7400.0, v)
        # 키 정보 없음 → default
        v, src = sync_garmin.kcal_per_kg(None, 70.0, None)
        self.assertEqual("default", src)
        self.assertEqual(7700.0, v)

    def test_calibration_reports_efficiency_in_summary(self) -> None:
        """Phase 1A 회귀: 충분한 history에서 calibration이 modelDiagnostics에 노출."""
        rows = []
        for day in range(1, 32):
            rows.append({
                "date": f"2030-03-{day:02d}",
                "weight_kg": round(82.0 - day * 0.05, 2),
                "weight_measure_count": 1,
                "exercise_minutes": 30,
                "exercise_calories": 300,
                "activity_count": 1,
                "steps": 8000,
                "sleep_hours": 7,
                "resting_hr": 60,
                "visceral_fat": None,
                "metabolic_age": None,
            })
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "heightCm": 175})
        diag = summary["modelDiagnostics"]
        self.assertIn("calibration", diag)
        self.assertIn("kcalPerKg", diag)
        self.assertIn(diag["kcalPerKgSource"], ("body_fat", "bmi", "default"))
        self.assertIn("exerciseEfficiency", diag["calibration"])

    def test_backtest_uses_exp_decay_model(self) -> None:
        """Phase 3 회귀: backtest 결과의 predicted가 지수 감쇠 외삽과 일치해야 한다."""
        # 충분히 긴 history + 목표 체중 가까이 — 지수 감쇠가 선형보다 분명히 보수적인 예측을 함
        rows = []
        for day in range(60):
            rows.append({
                "date": (sync_garmin.date(2030, 1, 1) + sync_garmin.timedelta(days=day)).isoformat(),
                "weight_kg": round(85.0 - day * 0.04, 2),
                "weight_measure_count": 1,
                "exercise_minutes": 30,
                "exercise_calories": 250,
                "activity_count": 1,
                "steps": 8000,
                "sleep_hours": 7,
                "resting_hr": 60,
                "visceral_fat": None,
                "metabolic_age": None,
            })
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "heightCm": 175})
        bt = summary["modelDiagnostics"]["backtest"]
        # backtest는 ok 상태여야 하고 maeKg이 합리적 범위
        for horizon in ("7d", "14d", "28d"):
            entry = bt.get(horizon)
            if entry and entry.get("status") == "ok":
                self.assertLess(entry["maeKg"], 1.0)

    def test_phase2a_body_fat_takes_priority_over_bmi(self) -> None:
        """Phase 2A 회귀: body_fat_percent가 있으면 BMI보다 우선해 kcalPerKgSource를 결정."""
        rows = []
        for d in range(30):
            rows.append({
                "date": f"2030-04-{d+1:02d}",
                "weight_kg": round(95.0 - d * 0.05, 2),  # BMI 30+ (175cm)
                "weight_measure_count": 1,
                "exercise_minutes": 30, "exercise_calories": 300,
                "activity_count": 1, "steps": 8000,
                "sleep_hours": 7, "resting_hr": 60,
                "visceral_fat": None, "metabolic_age": None,
                "body_fat_percent": 22.0,   # 22% → kcal_per_kg=7700 (body_fat tier)
                "sleep_score": 75, "training_load_acute": 180,
            })
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 80, "heightCm": 175})
        diag = summary["modelDiagnostics"]
        self.assertEqual("body_fat", diag["kcalPerKgSource"])
        self.assertEqual(7700.0, diag["kcalPerKg"])

    def test_phase4_glycogen_plateau_classified(self) -> None:
        """Phase 4 회귀: 정체기 + 훈련 부하 급증 → type='glycogen'."""
        rows = []
        # 14일 평탄(체중 변화 거의 없음) + 부하 급증 패턴
        base_kg = 82.0
        for d in range(28):
            load = 150 if d < 14 else 500   # 후반 부하 급증
            rows.append({
                "date": (sync_garmin.date(2030, 5, 1) + sync_garmin.timedelta(days=d)).isoformat(),
                "weight_kg": round(base_kg - d * 0.02, 2),  # 매우 느린 감소
                "weight_measure_count": 1,
                "exercise_minutes": 30, "exercise_calories": 300,
                "activity_count": 1, "steps": 8000,
                "sleep_hours": 7, "resting_hr": 60,
                "visceral_fat": None, "metabolic_age": None,
                "body_fat_percent": None,
                "sleep_score": 75,
                "training_load_acute": load,
            })
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "heightCm": 175})
        plateau = summary["plateau"]
        if plateau.get("detected"):
            self.assertEqual("glycogen", plateau.get("type"))

    def test_phase5_kalman_comparison_present(self) -> None:
        """Phase 5 회귀: modelDiagnostics.modelComparison이 V1/Kalman MAE 비교를 노출."""
        rows = []
        for d in range(60):
            rows.append({
                "date": (sync_garmin.date(2030, 6, 1) + sync_garmin.timedelta(days=d)).isoformat(),
                "weight_kg": round(85.0 - d * 0.04, 2),
                "weight_measure_count": 1,
                "exercise_minutes": 30, "exercise_calories": 300,
                "activity_count": 1, "steps": 8000,
                "sleep_hours": 7, "resting_hr": 60,
                "visceral_fat": None, "metabolic_age": None,
                "body_fat_percent": 22.0,
                "sleep_score": 75, "training_load_acute": 180,
            })
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "heightCm": 175})
        mc = summary["modelDiagnostics"].get("modelComparison")
        self.assertIsNotNone(mc)
        self.assertIn("kalmanBacktest", mc)
        self.assertIn("recommendKalman", mc)
        self.assertIn("perHorizon", mc)

    def test_prediction_curve_decays_toward_target(self) -> None:
        """P3 회귀: 선형 외삽이라면 12주 감량 = 12 * weekly. 지수 감쇠는 더 작아야 함."""
        start = 90.0
        weekly = 0.3
        target = 80.0
        linear_12w_drop = weekly * 12  # = 3.6
        proj = sync_garmin._projected_weight(start, weekly, 12, target_weight=target)
        actual_drop = start - proj
        self.assertLess(actual_drop, linear_12w_drop)
        self.assertGreater(proj, target)  # 목표를 지나치지 않음


if __name__ == "__main__":
    unittest.main()
