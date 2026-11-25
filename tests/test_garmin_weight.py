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


def _daily_row(day: str, weight_kg: float | None, **extra) -> dict:
    row = {
        "date": day,
        "weight_kg": weight_kg,
        "weight_measure_count": 1 if weight_kg is not None else 0,
        "exercise_minutes": 30,
        "exercise_calories": 250,
        "activity_count": 1,
        "steps": 7000,
        "sleep_hours": 6.5,
        "resting_hr": 60,
        "visceral_fat": None,
        "metabolic_age": None,
    }
    row.update(extra)
    return row


PLATEAU_ON = {"features": {"plateauLoadClassification": True}}

class GarminWeightTests(unittest.TestCase):
    def test_build_summary_falls_back_to_flat_forecast_when_history_is_short(self) -> None:
        """M8: 28일 창에 점이 모자란 초기 구간은 예측을 숨기지 않고 EWMA 수준의 평평한 예측을 낸다."""
        rows = [_daily_row(f"2026-04-{day:02d}", 82.0 - (day * 0.1)) for day in range(1, 11)]

        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 75})

        ewma = summary["current"]["weightEwmaKg"]
        self.assertIsNotNone(ewma)
        self.assertIsNone(summary["rolling"]["weeklyLossRateKg"])
        self.assertEqual("cold_start_flat", summary["rolling"]["lossRateDetail"]["rateSource"])
        self.assertEqual(ewma, summary["predictions"]["oneMonthWeightKg"])
        self.assertEqual(ewma, summary["predictions"]["threeMonthWeightKg"])
        self.assertEqual({ewma}, {p["valueKg"] for p in summary["series"]["prediction"]})
        self.assertIsNone(summary["goal"]["etaDays"])

        # 추세 표시도 예측과 같은 근거를 써야 한다: 7일 기울기로 "감량 중"이라고 하지 않는다.
        trend = summary["modelDiagnostics"]["trend"]
        self.assertEqual("warming_up", trend["direction"])
        self.assertTrue(trend["predictionEnabled"])
        self.assertEqual((10, 14), (trend["historyPoints"], trend["requiredPoints"]))

        confidence = summary["modelDiagnostics"]["confidence"]
        self.assertEqual("low", confidence["level"])
        self.assertEqual("추세 판단 중 (10/14일)", confidence["reasons"][0])

    def test_build_summary_uses_blend_once_history_is_long_enough(self) -> None:
        rows = [
            _daily_row((sync_garmin.date(2026, 4, 1) + sync_garmin.timedelta(days=day)).isoformat(), round(82.0 - day * 0.05, 2))
            for day in range(20)
        ]

        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 75})

        self.assertEqual("multi_window_blend", summary["rolling"]["lossRateDetail"]["rateSource"])
        self.assertIsNotNone(summary["rolling"]["weeklyLossRateKg"])
        trend = summary["modelDiagnostics"]["trend"]
        self.assertEqual("losing", trend["direction"])
        self.assertEqual("multi_window_blend", trend["rateSource"])
        self.assertFalse(any(r.startswith("추세 판단 중") for r in summary["modelDiagnostics"]["confidence"]["reasons"]))

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

        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 79})

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
        # P6: 모든 기간에 표본 20개 이상이 필요하다(28일 기간은 28일 학습 + 28일 대기 + 20개 시점).
        for day in range(90):
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
        # backtest는 모든 기간에서 ok 상태여야 하고 maeKg이 합리적 범위
        for horizon in ("7d", "14d", "28d"):
            with self.subTest(horizon=horizon):
                entry = bt.get(horizon) or {}
                self.assertEqual("ok", entry.get("status"))
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

    @staticmethod
    def _plateau_rows(load_for_day) -> list[dict]:
        # 28일 내내 체중이 같다 → 최근 14일 EWMA 변화가 0이라 정체로 감지된다.
        return [
            _daily_row(
                (sync_garmin.date(2030, 5, 1) + sync_garmin.timedelta(days=d)).isoformat(),
                82.0,
                exercise_calories=300,
                steps=8000,
                sleep_hours=7,
                body_fat_percent=None,
                sleep_score=75,
                training_load_acute=load_for_day(d),
            )
            for d in range(28)
        ]

    def test_phase4_glycogen_plateau_classified(self) -> None:
        """Phase 4 회귀: 정체기 + 정체 구간 후반 7일의 훈련 부하 급증 → type='glycogen'."""
        # detect_plateau는 최근 14행의 부하를 앞 7일(기준)과 뒤 7일(최근)로 나눠 비교한다.
        rows = self._plateau_rows(lambda d: 150 if d < 21 else 500)
        plateau = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "heightCm": 175, **PLATEAU_ON})["plateau"]
        self.assertTrue(plateau["detected"])
        self.assertEqual("glycogen", plateau["type"])

    def test_plateau_type_is_off_by_default(self) -> None:
        """P5: 기능 스위치가 꺼져 있으면(기본) 부하로 정체기 유형을 나누지 않는다."""
        rows = self._plateau_rows(lambda d: 150 if d < 21 else 500)
        plateau = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "heightCm": 175})["plateau"]
        self.assertTrue(plateau["detected"])
        self.assertIsNone(plateau["type"])

    def test_context_weights_are_off_by_default(self) -> None:
        """P5: 수면·부하 측정 가중치도 기본은 꺼져 있다. 켜면 EWMA가 달라진다."""
        rows = self._plateau_rows(lambda d: 500)
        for row in rows[-10:]:
            row["sleep_score"] = 40
            row["weight_kg"] = row["weight_kg"] + 1.5
        config = {"targetWeightKg": 75, "heightCm": 175}
        off = sync_garmin.build_summary(rows, config)["series"]["ewma"][-1]["valueKg"]
        plain = sync_garmin.build_summary([{**row, "sleep_score": None, "training_load_acute": None} for row in rows], config)
        on = sync_garmin.build_summary(rows, {**config, "features": {"sleepMeasurementWeighting": True,
                                                                     "loadMeasurementWeighting": True}})
        self.assertEqual(plain["series"]["ewma"][-1]["valueKg"], off)
        self.assertLess(on["series"]["ewma"][-1]["valueKg"], off)

    def test_phase4_metabolic_plateau_when_load_is_steady(self) -> None:
        rows = self._plateau_rows(lambda d: 300)
        plateau = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "heightCm": 175, **PLATEAU_ON})["plateau"]
        self.assertTrue(plateau["detected"])
        self.assertEqual("metabolic", plateau["type"])

    def test_shadow_audit_shares_the_operational_sample(self) -> None:
        """P6: Kalman을 포함한 섀도 후보가 운영 모델과 같은 표본으로 평가되고, 결과는 예측에 쓰이지 않는다."""
        rows = []
        for d in range(140):
            rows.append({
                "date": (sync_garmin.date(2030, 6, 1) + sync_garmin.timedelta(days=d)).isoformat(),
                "weight_kg": round(85.0 - d * 0.02 + (0.3 if d % 2 else -0.3), 2) if d % 4 else None,
                "weight_measure_count": 1,
                "exercise_minutes": 30, "exercise_calories": 300,
                "activity_count": 1, "steps": 8000,
                "sleep_hours": 7, "resting_hr": 60,
                "visceral_fat": None, "metabolic_age": None,
                "body_fat_percent": 22.0,
                "sleep_score": 75, "training_load_acute": 180,
            })
        diag = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "heightCm": 175})["modelDiagnostics"]
        self.assertNotIn("modelComparison", diag)  # Kalman은 modelAudit 안에서 한 번만 평가한다
        self.assertIn("kalman", diag["modelAudit"])
        for horizon in ("7d", "14d", "28d", "84d"):
            counts = {diag["backtest"][horizon]["sampleCount"]} | {m[horizon]["sampleCount"] for m in diag["modelAudit"].values()}
            self.assertEqual({diag["backtestSampleCounts"][horizon]}, counts, horizon)
        self.assertIn(diag["selectedModel"]["status"], ("shadow_leader", "no_change"))
        self.assertIs(False, diag["selectedModel"]["affectsPrediction"])
        self.assertEqual("replay", diag["ciCalibration"]["method"])

    def test_today_partial_row_is_left_out_of_aggregates(self) -> None:
        """P6(D4): 아직 끝나지 않은 오늘 행은 7일 활동 집계·30일 커버리지·EWMA 계열에 들어가지 않는다."""
        rows = [
            _daily_row((sync_garmin.date(2030, 8, 1) + sync_garmin.timedelta(days=d)).isoformat(), 84.0 - d * 0.01)
            for d in range(40)
        ]
        for row in rows:
            row["steps"] = 7000
        rows.append({**_daily_row("2030-09-10", None), "steps": 117, "exercise_minutes": 0, "exercise_calories": 0})
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 78})
        self.assertEqual(7000, summary["rolling"]["last7StepsAvg"])
        self.assertEqual("2030-09-09", summary["series"]["ewma"][-1]["date"])
        self.assertEqual((30, 30), (summary["coverage"]["last30Measured"], summary["coverage"]["last30Total"]))
        self.assertEqual("2030-09-10", summary["series"]["daily"][-1]["date"])
        # 예측선과 신뢰 띠는 같은 날짜에 점을 찍는다(대시보드가 날짜로 맞춰 그린다).
        prediction_dates = {p["date"] for p in summary["series"]["prediction"]}
        self.assertEqual("2030-09-10", summary["series"]["prediction"][0]["date"])
        self.assertTrue({p["date"] for p in summary["predictionCI"]["series"]} <= prediction_dates)

        # 오늘 체중이 있으면 EWMA 계열에 넣는다.
        rows[-1]["weight_kg"] = 83.5
        self.assertEqual("2030-09-10", sync_garmin.build_summary(rows, {"targetWeightKg": 78})["series"]["ewma"][-1]["date"])

    def test_model_audit_reports_the_operational_numbers(self) -> None:
        """P6(M9): model_audit.py는 따로 계산하지 않고 요약과 같은 숫자를 낸다."""
        spec = importlib.util.spec_from_file_location("garmin_model_audit", MODULE_PATH.parent / "model_audit.py")
        audit_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(audit_module)
        rows = {
            day: _daily_row(day, round(84.0 - d * 0.01 + (0.3 if d % 2 else -0.3), 2) if d % 3 else None)
            for d in range(120)
            for day in [(sync_garmin.date(2030, 1, 1) + sync_garmin.timedelta(days=d)).isoformat()]
        }
        with tempfile.TemporaryDirectory() as tmp:
            csv_path, config_path = Path(tmp) / "rows.csv", Path(tmp) / "config.json"
            sync_garmin.write_rows(csv_path, rows)
            config_path.write_text('{"targetWeightKg": 78}', encoding="utf-8")
            audit = audit_module.build_audit(csv_path, config_path)
            summary = sync_garmin.build_summary(sync_garmin.normalize_rows(sync_garmin.load_existing_rows(csv_path)), {"targetWeightKg": 78})
        diag = summary["modelDiagnostics"]
        self.assertEqual(diag["backtest"], audit["models"]["current"])
        self.assertEqual(diag["modelAudit"]["kalman"], audit["models"]["kalman"])
        self.assertEqual(diag["ciCalibration"]["hitRate"], audit["ciHitRate"]["hitRate"])
        self.assertNotIn("ciHitRateApprox", audit)

    def test_summary_generation_time(self) -> None:
        """P6 완료 기준: 258행은 1초, 1,095행은 5초 안에 요약을 만든다."""
        import time

        for days, limit in ((258, 1.0), (1095, 5.0)):
            rows = [
                _daily_row((sync_garmin.date(2027, 1, 1) + sync_garmin.timedelta(days=d)).isoformat(),
                           round(90.0 - d * 0.01 + (0.4 if d % 3 == 0 else -0.2), 2) if d % 5 else None)
                for d in range(days)
            ]
            started = time.perf_counter()
            sync_garmin.build_summary(rows, {"targetWeightKg": 78})
            with self.subTest(days=days):
                self.assertLess(time.perf_counter() - started, limit)

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


def _m5_rows(days: int = 90, start_kg: float = 86.11, weekly: float = 0.4) -> list[dict]:
    """리포트 M5의 합성 예: 주 0.4kg씩 꾸준히 빠지는 90일, 이틀에 한 번 350kcal 활동."""
    start = sync_garmin.date(2030, 1, 1)
    return [
        _daily_row((start + sync_garmin.timedelta(days=i)).isoformat(), round(start_kg - weekly / 7 * i, 2),
                   exercise_minutes=40 if i % 2 == 0 else 0, exercise_calories=350 if i % 2 == 0 else 0,
                   activity_count=1 if i % 2 == 0 else 0, body_fat_percent=25.0)
        for i in range(days)
    ]


class ForecastCurveTests(unittest.TestCase):
    """P7: 감쇠 곡선(M5), 곡선에서 구한 ETA, 시나리오 시계열(M6), 인사이트(M7), M9."""

    def test_m5_example_meets_the_completion_criteria(self) -> None:
        summary = sync_garmin.build_summary(_m5_rows(), {"targetWeightKg": 80})
        scenarios = summary["predictions"]["scenarios"]
        base = scenarios["base"]
        start, loss = base["series"][0]["valueKg"], base["effectiveWeeklyLossKg"]
        # 곡선의 초기 기울기 = 주 0.40kg ± 5% (예전 상한 때문에 0.12kg)
        initial = (start - sync_garmin._projected_weight(start, loss, 1 / 7, 80)) * 7
        self.assertAlmostEqual(0.40, initial, delta=0.02)
        # ETA 날짜의 곡선 값이 목표 + ε 이하이고, 그 전날은 아니다
        goal = summary["goal"]
        self.assertEqual("date", goal["etaStatus"])
        self.assertLessEqual(sync_garmin._projected_weight(start, loss, goal["etaDays"] / 7, 80), 80 + goal["etaToleranceKg"])
        self.assertGreater(sync_garmin._projected_weight(start, loss, (goal["etaDays"] - 1) / 7, 80), 80 + goal["etaToleranceKg"])
        self.assertLessEqual(goal["etaRangeDays"]["min"], goal["etaDays"])
        self.assertGreaterEqual(goal["etaRangeDays"]["max"], goal["etaDays"])
        # 세 시나리오 카드가 서로 다르고, 카드 값과 선 끝 값이 같다
        cards = [scenarios[k]["threeMonthWeightKg"] for k in ("optimistic", "base", "conservative")]
        self.assertEqual(3, len(set(cards)))
        self.assertLess(cards[0], cards[1])
        self.assertLess(cards[1], cards[2])
        for key, scenario in scenarios.items():
            with self.subTest(scenario=key):
                self.assertEqual(13, len(scenario["series"]))
                self.assertAlmostEqual(scenario["threeMonthWeightKg"], scenario["series"][-1]["valueKg"], delta=0.01)
                self.assertEqual([p["date"] for p in summary["series"]["prediction"]], [p["date"] for p in scenario["series"]])
        self.assertAlmostEqual(summary["predictions"]["threeMonthWeightKg"], base["threeMonthWeightKg"], delta=0.01)
        self.assertEqual(summary["predictionCI"]["series"][-1]["upper80"], base["series"][-1]["upper80"])

    def test_curve_slope_matches_the_trend_and_guards_tiny_gaps(self) -> None:
        start, rate = 83.0, 0.4
        for target in (78.0, 82.0):
            slope = (start - sync_garmin._projected_weight(start, rate, 1e-4, target)) / 1e-4
            self.assertAlmostEqual(rate, slope, places=3)
        # 남은 간격(0.2kg)이 한 주 감량보다 작으면 k를 1/주로 묶는다. 목표 아래로는 내려가지 않는다.
        near = sync_garmin._projected_weight(80.2, 0.4, 1, 80.0)
        self.assertAlmostEqual(80.0 + 0.2 * sync_garmin.math.exp(-1), near, places=6)
        self.assertEqual(83.8, sync_garmin._projected_weight(83.0, -0.2, 4, 78.0))  # 증량은 직선

    def test_eta_statuses(self) -> None:
        eta = sync_garmin._modeling.projected_eta
        self.assertEqual(("reached", 0), eta(80.25, 0.3, 80.0))
        self.assertEqual(("no_loss", None), eta(84.0, -0.05, 78.0))
        self.assertEqual(("no_loss", None), eta(84.0, 0.0, 78.0))
        self.assertEqual(("beyond", None), eta(84.0, 0.02, 78.0))  # 2년 안에 목표 + 0.3kg에 닿지 않는다
        status, days = eta(84.0, 0.5, 78.0)
        self.assertEqual("date", status)
        self.assertLessEqual(days, 104 * 7)
        loose_status, loose_days = eta(84.0, 0.5, 78.0, tolerance_kg=1.0)
        self.assertLess(loose_days, days)

    def test_eta_tolerance_comes_from_config(self) -> None:
        summary = sync_garmin.build_summary(_m5_rows(), {"targetWeightKg": 80, "etaToleranceKg": 0.6})
        self.assertEqual(0.6, summary["goal"]["etaToleranceKg"])
        default = sync_garmin.build_summary(_m5_rows(), {"targetWeightKg": 80})
        self.assertLess(summary["goal"]["etaDays"], default["goal"]["etaDays"])

    def test_plateau_length_is_the_real_run(self) -> None:
        """M7: 감량 뒤 40일 평평하면 durationDays가 13이 아니라 실제 길이에 가깝다. '대사 적응'은 감량 뒤에만."""
        start = sync_garmin.date(2030, 1, 1)
        weights = [86.0 - 0.06 * i for i in range(50)] + [83.0] * 40
        rows = [_daily_row((start + sync_garmin.timedelta(days=i)).isoformat(), round(w, 2)) for i, w in enumerate(weights)]
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 78})
        plateau = summary["plateau"]
        self.assertTrue(plateau["detected"])
        self.assertGreater(plateau["durationDays"], 20)
        self.assertLessEqual(plateau["durationDays"], 40)
        self.assertEqual("plateau_after_loss", summary["insight"]["state"])
        self.assertIn("줄어든 뒤", summary["insight"]["lines"][-1])

        flat_rows = [_daily_row((start + sync_garmin.timedelta(days=i)).isoformat(), 84.0) for i in range(90)]
        flat = sync_garmin.build_summary(flat_rows, {"targetWeightKg": 78})
        self.assertEqual("plateau_no_loss", flat["insight"]["state"])
        text = " ".join(flat["insight"]["lines"])
        self.assertNotIn("적응", text)
        self.assertIn("6.0kg 남았습니다", text)

    def test_gaining_trend_gets_its_own_copy(self) -> None:
        start = sync_garmin.date(2030, 1, 1)
        rows = [_daily_row((start + sync_garmin.timedelta(days=i)).isoformat(), round(82.0 + 0.04 * i, 2)) for i in range(90)]
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 78})
        self.assertEqual("gaining", summary["insight"]["state"])
        self.assertIn("늘고 있어", summary["insight"]["lines"][-1])
        self.assertEqual("no_loss", summary["goal"]["etaStatus"])

    def test_no_unsourced_guideline_claims(self) -> None:
        for weekly in (0.2, 0.45, 0.9):
            summary = sync_garmin.build_summary(_m5_rows(weekly=weekly, start_kg=95.0), {"targetWeightKg": 70})
            text = " ".join(summary["insight"]["lines"])
            with self.subTest(weekly=weekly):
                self.assertNotIn("CDC", text)
                self.assertNotIn("WHO", text)
        source = (MODULE_PATH.parent / "sync_modeling.py").read_text(encoding="utf-8")
        self.assertNotIn("CDC", source)

    def test_session_kcal_needs_real_activity_days(self) -> None:
        """M9: 활동 기록이 있으면 회당 kcal로, 일일 요약만 있으면 하루 활동량 비율로 시나리오를 만든다."""
        summary = sync_garmin.build_summary(_m5_rows(), {"targetWeightKg": 80})
        self.assertIn("회당 ~350kcal", summary["predictions"]["scenarios"]["optimistic"]["description"])
        self.assertEqual(700.0, summary["predictions"]["scenarios"]["optimistic"]["weeklyKcalDelta"])

        intensity_only = [{**row, "activity_count": 0, "exercise_source": "intensity", "exercise_calories": 300}
                          for row in _m5_rows()]
        summary = sync_garmin.build_summary(intensity_only, {"targetWeightKg": 80})
        description = summary["predictions"]["scenarios"]["optimistic"]["description"]
        self.assertIn("하루 활동량 +30%", description)
        self.assertNotIn("회당", description)

    def test_body_fat_tier_has_hysteresis(self) -> None:
        """M9: 30% 경계 근처의 측정이 7,700/8,000을 오가지 않는다(±0.5%p)."""
        tier = sync_garmin._modeling.body_fat_tier_value
        self.assertEqual(7700.0, tier([29.8, 30.2, 29.9, 30.3]))
        self.assertEqual(8000.0, tier([29.8, 30.6]))
        self.assertEqual(8000.0, tier([29.8, 30.6, 30.1, 29.6]))
        self.assertEqual(7700.0, tier([29.8, 30.6, 29.4]))
        self.assertEqual(6500.0, tier([14.0]))
        self.assertIsNone(tier([None, 0.0]))


_MISSING = object()

# 개인 대시보드(dashboard.js, dashboard-model.js)가 summary.json에서 읽는 경로.
# 스키마를 바꿀 때 이 목록과 tests/test_dashboard_browser.py의 픽스처를 함께 본다.
DASHBOARD_FIELDS = (
    "generatedAt",
    "current.weightKg",
    "current.weightDate",
    "current.bodyFatPercent",
    "rolling.last7StepsAvg",
    "rolling.last7ExerciseMinutes",
    "rolling.lossRateDetail.blended",
    "rolling.exerciseTrend.deltaPct",
    "predictions.oneMonthWeightKg",
    "predictions.threeMonthWeightKg",
    "modelDiagnostics.confidence.level",
    "modelDiagnostics.confidence.reasons",
    "modelDiagnostics.trend.predictionEnabled",
    "modelDiagnostics.trend.disabledReason",
    "predictionCI.series",
    "series.daily",
    "series.ewma",
    "series.prediction",
)


def _lookup(payload: dict, path: str):
    node = payload
    for key in path.split("."):
        if not isinstance(node, dict) or key not in node:
            return _MISSING
        node = node[key]
    return node


class SummaryConsumerContractTests(unittest.TestCase):
    """요약 파일의 소비자가 읽는 키가 데이터 유무와 무관하게 항상 있어야 한다."""

    def _assert_contract(self, summary: dict) -> None:
        for path in DASHBOARD_FIELDS:
            with self.subTest(path=path):
                self.assertIsNot(_MISSING, _lookup(summary, path), f"summary.json lacks {path}")
        self.assertIsInstance(summary["modelDiagnostics"]["trend"]["predictionEnabled"], bool)
        self.assertIsInstance(summary["modelDiagnostics"]["confidence"]["reasons"], list)
        self.assertIn(summary["modelDiagnostics"]["confidence"]["level"], ("low", "medium", "high"))
        for path in ("predictionCI.series", "series.daily", "series.ewma", "series.prediction"):
            self.assertIsInstance(_lookup(summary, path), list, path)

    def test_contract_with_data(self) -> None:
        rows = [
            _daily_row(
                (sync_garmin.date(2030, 7, 1) + sync_garmin.timedelta(days=d)).isoformat(),
                round(84.0 - d * 0.03, 2) if d % 3 else None,
                body_fat_percent=29.0,
            )
            for d in range(45)
        ]
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 78})
        self._assert_contract(summary)
        self.assertIsNotNone(summary["current"]["weightKg"])
        self.assertIsNotNone(summary["predictions"]["oneMonthWeightKg"])
        self.assertTrue(summary["series"]["prediction"])
        for point in summary["predictionCI"]["series"]:
            self.assertLessEqual({"date", "central", "lower80", "upper80"}, set(point))

    def test_contract_while_warming_up(self) -> None:
        rows = [_daily_row(f"2030-08-{d:02d}", 84.0) for d in range(1, 6)]
        self._assert_contract(sync_garmin.build_summary(rows, {"targetWeightKg": 78}))

    def test_contract_without_data(self) -> None:
        summary = sync_garmin.build_summary([], {"targetWeightKg": 78})
        self._assert_contract(summary)
        # 계획서 기준: 빈 요약에도 아래 키가 있어야 한다.
        for path in ("coverage", "modelDiagnostics.dataQuality", "series.exerciseCaloriesDaily"):
            with self.subTest(path=path):
                self.assertIsNot(_MISSING, _lookup(summary, path))
        self.assertFalse(summary["modelDiagnostics"]["trend"]["predictionEnabled"])


if __name__ == "__main__":
    unittest.main()
