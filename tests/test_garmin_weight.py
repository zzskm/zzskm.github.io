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
        diag = sync_garmin.build_summary(rows, {"targetWeightKg": 75, "heightCm": 175}, detail=True)["modelDiagnostics"]
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
        # 요약에는 화면이 쓰는 필드만 있고, 감사에는 전체 통계가 있다. 같은 계산이므로 MAE가 같다.
        for horizon in ("7d", "14d", "28d", "84d"):
            self.assertEqual(diag["modelAudit"]["kalman"][horizon]["maeKg"], audit["models"]["kalman"][horizon]["maeKg"])
        # 재검토 MD4: 감사에는 추세별 성적이 있다. 두 구간의 표본 수를 더하면 전체 표본 수다. 요약 파일에는 넣지 않는다.
        self.assertNotIn("regimes", diag)
        for horizon in ("7d", "14d", "28d", "84d"):
            split = audit["regimes"][horizon]
            self.assertEqual(["losing", "other"], list(split))
            self.assertEqual(audit["sampleCounts"][horizon], split["losing"]["sampleCount"] + split["other"]["sampleCount"])
        self.assertEqual(diag["backtest"]["84d"]["sampleCount"], audit["sampleCounts"]["84d"])
        self.assertEqual(summary["rolling"]["lossRateDetail"]["longRangeRate"], audit["lossRate"]["longRangeRate"])
        self.assertIs(True, audit["lossRate"]["longRangeApplied"])
        self.assertEqual({"maeKg", "status"}, set(diag["modelAudit"]["kalman"]["7d"]))
        self.assertIn("biasKg", audit["models"]["kalman"]["7d"])
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
        start, loss, long_loss = base["series"][0]["valueKg"], base["effectiveWeeklyLossKg"], base["longRangeWeeklyLossKg"]
        # 꾸준히 빠지는 이력이라 두 감량률이 거의 같다.
        self.assertAlmostEqual(loss, long_loss, delta=0.02)

        def curve(week: float) -> float:
            return sync_garmin.forecast_weight(start, loss, week, 80, long_loss)

        # 곡선의 초기 기울기 = 주 0.40kg ± 5% (예전 상한 때문에 0.12kg)
        initial = (start - curve(1 / 7)) * 7
        self.assertAlmostEqual(0.40, initial, delta=0.02)
        # ETA 날짜의 곡선 값이 목표 + ε 이하이고, 그 전날은 아니다
        goal = summary["goal"]
        self.assertEqual("date", goal["etaStatus"])
        self.assertLessEqual(curve(goal["etaDays"] / 7), 80 + goal["etaToleranceKg"])
        self.assertGreater(curve((goal["etaDays"] - 1) / 7), 80 + goal["etaToleranceKg"])
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


def _series_rows(weights: list[float | None], start: str = "2030-01-01") -> list[dict]:
    first = sync_garmin.date.fromisoformat(start)
    return [_daily_row((first + sync_garmin.timedelta(days=i)).isoformat(), w) for i, w in enumerate(weights)]


class DisplayConsistencyTests(unittest.TestCase):
    """재검토 Q3: 한 화면의 표시가 서로 어긋나지 않는다(MD1 정체 판정, MD5, MD6, MD7, MD9)."""

    @staticmethod
    def _ewma_points(values: list[float]) -> list[dict]:
        first = sync_garmin.date(2030, 1, 1)
        return [{"date": (first + sync_garmin.timedelta(days=i)).isoformat(), "valueKg": v} for i, v in enumerate(values)]

    def test_v_shaped_window_is_not_a_plateau(self) -> None:
        detect = sync_garmin._modeling.detect_plateau
        flat = [84.0] * 20
        self.assertTrue(detect(self._ewma_points(flat))["detected"])
        # 14일 창의 양 끝은 같지만 안에서 0.6kg 내려갔다 올라왔다. 예전에는 양 끝만 봐서 "평평"이었다.
        down_up = [round(84.0 - 0.1 * i, 1) for i in range(1, 7)] + [round(83.4 + 0.1 * i, 1) for i in range(1, 7)]
        dip = flat[:8] + down_up
        self.assertEqual((84.0, 84.0), (dip[-14], dip[-1]))
        self.assertFalse(detect(self._ewma_points(dip))["detected"])
        bump = flat[:8] + [round(168.0 - v, 1) for v in down_up]
        self.assertEqual((84.0, 84.0, 84.6), (bump[-14], bump[-1], max(bump)))
        self.assertFalse(detect(self._ewma_points(bump))["detected"])
        # 창 전체가 천천히(주 0.03kg) 움직이는 것은 여전히 정체다.
        drift = [84.0 - 0.03 / 7 * i for i in range(20)]
        self.assertTrue(detect(self._ewma_points(drift))["detected"])

    @staticmethod
    def _plateau_fixture() -> list[dict]:
        """평평한 구간, 감량 구간, 다시 평평한 구간. 두 번째 평평한 구간 가운데 닷새 동안 1.5kg 낮게 재서 추세에 V자가 생긴다."""
        from math import sin
        weights = []
        for i in range(150):
            level = 84.0 if i < 45 else (84.0 - 0.05 * (i - 45) if i < 75 else 82.5)
            dip = -1.5 if 95 <= i < 100 else 0.0
            weights.append(round(level + dip + 0.2 * sin(i * 1.3), 2))
        return _series_rows(weights)

    def test_plateau_copy_never_appears_with_a_moving_badge(self) -> None:
        # 접두 구간마다(그날 아침의 요약) 정체 문구와 배지를 대조한다.
        rows = self._plateau_fixture()
        plateau_days = 0
        for end in range(30, len(rows)):
            summary = sync_garmin.build_summary(rows[:end] + [{**rows[end], "weight_kg": None}], {"targetWeightKg": 78})
            state = summary["insight"]["state"]
            direction = summary["modelDiagnostics"]["trend"]["direction"]
            if state in ("plateau_after_loss", "plateau_no_loss"):
                plateau_days += 1
                self.assertEqual("flat", direction, rows[end]["date"])
            self.assertEqual(summary["plateau"]["detected"], state in ("plateau_after_loss", "plateau_no_loss"), rows[end]["date"])
        self.assertGreater(plateau_days, 0, "the fixture should contain some flat stretches")

    def test_losing_badge_does_not_carry_a_negative_loss_rate(self) -> None:
        exposure = sync_garmin._modeling.model_trend_exposure
        mixed = exposure(0.12, -0.0183)  # 7일 기울기는 감량, 혼합 감량률은 증량
        self.assertEqual(("losing", 0.12, 0.12), (mixed["direction"], mixed["weeklyLossRateKg"], mixed["weeklyChangeKg"]))
        agreeing = exposure(0.12, 0.2)
        self.assertEqual(("losing", 0.2), (agreeing["direction"], agreeing["weeklyLossRateKg"]))

    def test_coverage_points_climb_one_step_at_a_time(self) -> None:
        points = sync_garmin._modeling.coverage_points
        # (최근 30일 측정률 %, 측정일 수) → 점수. 30일 창에서 20·22·24일이 경계다.
        ladder = {19: 0, 20: 1, 21: 1, 22: 2, 23: 2, 24: 3, 30: 3}
        for days, expected in ladder.items():
            with self.subTest(days=days):
                self.assertEqual(expected, points(round(days / 30 * 100, 0), days))
        # 이력이 짧으면 측정률이 100%여도 맨 윗단은 주지 않는다(예전과 같다).
        self.assertEqual(2, points(100.0, 20))

    def test_one_measurement_moves_the_confidence_score_by_one(self) -> None:
        classify = sync_garmin._modeling.classify_prediction_confidence
        backtest = {"14d": {"status": "ok", "maeKg": 0.55}}
        scores = [classify(round(days / 30 * 100, 0), days, 0.3, backtest)["score"] for days in range(18, 26)]
        self.assertEqual([2, 2, 3, 3, 4, 4, 5, 5], scores)
        self.assertEqual("high", classify(80.0, 24, 0.3, backtest)["level"])
        self.assertEqual("medium", classify(77.0, 23, 0.3, backtest)["level"])
        self.assertIn("최근 측정일 수 부족", classify(77.0, 23, 0.3, backtest)["reasons"])
        self.assertEqual([], classify(80.0, 24, 0.3, backtest)["reasons"])

    def test_long_range_marker_compares_the_84_day_error_with_no_change(self) -> None:
        assess = sync_garmin._modeling.long_range_assessment
        ok = {"status": "ok", "sampleCount": 40}
        worse = assess({"current": {"84d": {**ok, "maeKg": 1.49}}, "ewma_flat": {"84d": {**ok, "maeKg": 1.19}}})
        self.assertEqual(("worse_than_flat", 1.49, 1.19, "84d"), (worse["status"], worse["maeKg"], worse["flatMaeKg"], worse["horizon"]))
        better = assess({"current": {"84d": {**ok, "maeKg": 1.0}}, "ewma_flat": {"84d": {**ok, "maeKg": 1.19}}})
        self.assertEqual("ok", better["status"])
        thin = assess({"current": {"84d": {"status": "insufficient", "maeKg": 0.9, "sampleCount": 5}},
                       "ewma_flat": {"84d": {"status": "insufficient", "maeKg": 1.2, "sampleCount": 5}}})
        self.assertEqual("unverified", thin["status"])
        self.assertEqual("unverified", assess({})["status"])

    def test_summary_carries_the_long_range_marker(self) -> None:
        short = sync_garmin.build_summary(_series_rows([84.0 - 0.01 * i for i in range(40)]), {"targetWeightKg": 78})
        self.assertEqual("unverified", short["modelDiagnostics"]["longRange"]["status"])
        self.assertEqual("unverified", sync_garmin.build_summary([], {"targetWeightKg": 78})["modelDiagnostics"]["longRange"]["status"])
        from math import sin
        long_rows = _series_rows([round(86.0 - 0.015 * i + 0.3 * sin(i * 1.7), 2) if i % 4 else None for i in range(200)])
        long_range = sync_garmin.build_summary(long_rows, {"targetWeightKg": 78})["modelDiagnostics"]["longRange"]
        self.assertIn(long_range["status"], ("ok", "worse_than_flat"))
        self.assertGreaterEqual(long_range["sampleCount"], 20)

    def test_coverage_numbers_count_the_same_window(self) -> None:
        # 재검토 MD6: 요약의 측정률은 완료된 날(오늘 제외)을 세는데 모델 진단은 오늘을 포함해 세서 숫자가 달랐다.
        weights = [84.0 if i % 4 else None for i in range(45)] + [None]  # 마지막 행은 아직 재지 않은 오늘
        rows = _series_rows(weights)
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 78})
        coverage, quality = summary["coverage"], summary["modelDiagnostics"]["dataQuality"]
        self.assertEqual((coverage["last30Measured"], coverage["last30Total"]),
                         (quality["recentMeasuredDays"], quality["recentTotalDays"]))
        self.assertEqual(coverage["last30Pct"], round(quality["recentCoveragePct"], 0))
        self.assertEqual((rows[-31]["date"], rows[-2]["date"]), (coverage["windowStart"], coverage["windowEnd"]))
        window = [p for p in summary["series"]["daily"] if coverage["windowStart"] <= p["date"] <= coverage["windowEnd"]]
        self.assertEqual(coverage["last30Measured"], sum(1 for p in window if p["valueKg"] is not None))
        self.assertEqual(30, len(window))

        two_days = sync_garmin.build_summary(_series_rows([84.0, None]), {"targetWeightKg": 78})["coverage"]
        self.assertEqual((1, 1, "2030-01-01", "2030-01-01"),
                         (two_days["last30Measured"], two_days["last30Total"], two_days["windowStart"], two_days["windowEnd"]))

    def test_insight_says_today_only_for_a_weight_measured_today(self) -> None:
        # 재검토 MD7: 아침 수집은 오늘 체중이 들어오기 전에 돈다. 가장 최근 측정을 "오늘"이라고 쓰면 안 된다.
        base = [84.0] * 40
        yesterday = sync_garmin.build_summary(_series_rows(base + [84.6, None]), {"targetWeightKg": 78})["insight"]
        self.assertTrue(yesterday["headline"].startswith("최근 측정(2/10) 84.6kg이지만"), yesterday["headline"])
        older = sync_garmin.build_summary(_series_rows(base + [84.6, None, None, None]), {"targetWeightKg": 78})["insight"]
        self.assertTrue(older["headline"].startswith("최근 측정(2/10) 84.6kg이지만"), older["headline"])
        today = sync_garmin.build_summary(_series_rows(base + [84.0, 84.6]), {"targetWeightKg": 78})["insight"]
        self.assertTrue(today["headline"].startswith("오늘 84.6kg이지만"), today["headline"])

    def test_outlier_count_only_looks_at_the_recent_window(self) -> None:
        # 재검토 MD9: 전체 이력에서 세면 지난 일이 남아 값이 늘기만 한다.
        weights = [84.0] * 200
        for index in (10, 40, 70):
            weights[index] = 86.5  # 추세(84.0)에서 2.5kg 벗어난 측정
        quality = sync_garmin._modeling.data_quality_diagnostics
        rows = _series_rows(weights)
        self.assertEqual(0, quality(rows)["outlierCandidates"])
        self.assertEqual(60, quality(rows)["outlierWindowDays"])
        self.assertEqual([rows[i]["date"] for i in (10, 40, 70)], quality(rows)["limitedDates"])
        weights[170] = 86.5
        rows = _series_rows(weights)
        self.assertEqual(1, quality(rows)["outlierCandidates"])
        self.assertEqual(4, quality(rows, outlier_window_days=400)["outlierCandidates"])
        # 요약이 넘겨준 날짜를 그대로 센다(차트 표시와 같은 정의).
        self.assertEqual(1, quality(rows, limited_dates=[rows[190]["date"], rows[5]["date"], "1999-01-01"])["outlierCandidates"])


class StrayMeasurementTests(unittest.TestCase):
    """재검토 MD8: 잘못된 측정 한 건이 추세·예측·ETA를 끌고 가지 못한다."""

    def test_stray_reading_moves_the_trend_by_a_fraction(self) -> None:
        ewma = sync_garmin._modeling.ewma_with_limits
        values, limited = ewma([84.0] * 10 + [70.0] + [84.0] * 5)
        # λ = 0.1이고 갱신 폭은 0.8kg까지다. 70kg(추세보다 14kg 아래)이 추세를 0.08kg만 내린다(제한이 없으면 1.4kg).
        self.assertEqual(83.92, values[10])
        self.assertEqual([i == 10 for i in range(16)], limited)
        unlimited, flags = ewma([84.0] * 10 + [70.0] + [84.0] * 5, limit_kg=None)
        self.assertEqual(82.6, unlimited[10])
        self.assertFalse(any(flags))

    def test_plain_ewma_is_unchanged_inside_the_limit(self) -> None:
        from math import sin
        weights = [84.0 + 0.3 * sin(i * 1.3) if i % 3 else None for i in range(60)]  # 추세에서 0.8kg 넘게 벗어나지 않는다
        z, expected = None, []
        for x in weights:
            if x is not None:
                z = x if z is None else 0.1 * x + 0.9 * z
            expected.append(None if z is None else round(z, 2))
        values, limited = sync_garmin._modeling.ewma_with_limits(weights)
        self.assertEqual(expected, values)
        self.assertFalse(any(limited))
        self.assertEqual(expected, sync_garmin._modeling.compute_ewma(weights))

    def test_real_level_shift_is_followed_after_three_readings(self) -> None:
        ewma = sync_garmin._modeling.ewma_with_limits
        shifted = [84.0] * 10 + [86.5] * 20
        values, limited = ewma(shifted)
        # 처음 두 번은 잘못된 측정일 수 있어 일부만 반영한다. 같은 방향으로 세 번째부터는 실제 변화로 보고 그대로 반영한다.
        self.assertEqual([True, True, False, False], limited[10:14])
        self.assertFalse(any(limited[14:]))
        always_limited, _ = ewma(shifted, release_after=None)
        unlimited, _ = ewma(shifted, limit_kg=None)
        self.assertGreater(values[23], always_limited[23] + 0.4)   # 14번째 측정에서 제한만 둔 경우보다 훨씬 가깝다
        self.assertLess(unlimited[23] - values[23], 0.15)           # 제한이 없는 경우와 거의 같다

    def test_strays_in_both_directions_do_not_count_as_a_shift(self) -> None:
        _, limited = sync_garmin._modeling.ewma_with_limits([84.0] * 10 + [86.0, 82.0, 86.0, 82.0, 86.0])
        self.assertEqual([True] * 5, limited[10:])

    def test_summary_survives_a_stray_reading(self) -> None:
        # 리포트의 재현: 어제 측정을 70kg으로 바꾸면 추세 84.20 → 82.79, 3개월 예측 84.7 → 79.1, ETA가 154일이 됐다.
        from math import sin
        weights = [round(84.2 + 0.3 * sin(i * 1.3), 2) for i in range(89)] + [None]
        clean = sync_garmin.build_summary(_series_rows(weights), {"targetWeightKg": 78})
        weights[-2] = 70.0
        rows = _series_rows(weights)
        stray = sync_garmin.build_summary(rows, {"targetWeightKg": 78})
        self.assertAlmostEqual(clean["current"]["weightEwmaKg"], stray["current"]["weightEwmaKg"], delta=0.12)
        self.assertAlmostEqual(clean["predictions"]["threeMonthWeightKg"], stray["predictions"]["threeMonthWeightKg"], delta=1.0)
        # 추세가 0.08kg 내려가 감량률의 부호가 바뀔 수는 있다. 그래도 도달일이 생기지는 않는다.
        for summary in (clean, stray):
            self.assertIn(summary["goal"]["etaStatus"], ("no_loss", "beyond"))
            self.assertIsNone(summary["goal"]["etaDays"])
        quality = stray["modelDiagnostics"]["dataQuality"]
        self.assertIn(rows[-2]["date"], quality["limitedDates"])
        self.assertGreaterEqual(quality["outlierCandidates"], 1)
        self.assertEqual(70.0, stray["current"]["weightKg"])  # 측정값 자체는 그대로 보여 준다

    def test_implausible_weights_are_not_weights(self) -> None:
        plausible = sync_garmin.plausible_weight
        self.assertEqual([None, 30.0, 84.1, 250.0, None, None, None, None, None],
                         [plausible(v) for v in (29.9, 30, "84.1", 250.0, 250.1, 0, float("inf"), float("nan"), "")])
        self.assertIsNone(sync_garmin.parse_float(float("inf")))
        self.assertIsNone(sync_garmin.parse_float("-inf"))
        extract = sync_garmin.extract_body_metrics
        for raw in (0.0, 5000.0, 500000.0):  # 0kg, 5kg(그램 값), 500kg(그램 값)
            with self.subTest(raw=raw):
                with self.assertLogs(sync_garmin.LOGGER, "WARNING") as logs:
                    metrics = extract({"totalAverage": {"weight": raw}, "dateWeightList": [{"samplePk": 1}]})
                self.assertEqual((None, 0), (metrics["weight_kg"], metrics["weight_measure_count"]))
                # 버린 값 자체는 로그에 남기지 않는다(공개 로그 규칙).
                self.assertEqual(["WARNING:garmin_weight:garmin weight outside 30.0-250.0 kg ignored"], logs.output)
        self.assertEqual(83.9, extract({"totalAverage": {"weight": 83900.0}, "dateWeightList": [{"samplePk": 1}]})["weight_kg"])

    def test_implausible_csv_value_is_left_out_of_the_model(self) -> None:
        # CSV를 손으로 고치다 생긴 값(84.1을 841로)은 모델에 넣지 않는다.
        weights = [84.0] * 40
        weights[30] = 841.0
        rows = _series_rows(weights)
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 78})
        self.assertEqual(84.0, summary["current"]["weightEwmaKg"])
        self.assertIsNone(summary["series"]["daily"][30]["valueKg"])
        self.assertEqual(1, summary["modelDiagnostics"]["dataQuality"]["implausibleWeights"])
        self.assertEqual(841.0, rows[30]["weight_kg"], "the caller's rows are not modified")
        self.assertEqual(0, sync_garmin.build_summary(_series_rows([84.0] * 40), {"targetWeightKg": 78})["modelDiagnostics"]["dataQuality"]["implausibleWeights"])


class IntervalShapeTests(unittest.TestCase):
    """재검토 MD3: 80% 띠는 주마다 그 기간 과거 오차의 80분위로 만든다. 9주차의 계단이 없다."""

    @staticmethod
    def _noisy_rows(days: int = 320) -> list[dict]:
        """완만한 감량에 고른 잡음을 얹는다(표준편차 0.4kg, 시드 고정). 닷새에 하루는 재지 않는다.

        오차의 분포가 기간 내내 같아서, 기준 시점마다 다시 만든 80% 구간의 적중률이 80% 근처에 나와야 한다.
        """
        import random
        noise = random.Random(20261125)
        return _series_rows([round(86.0 - 0.01 * i + noise.gauss(0.0, 0.4), 2) if i % 5 else None for i in range(days)])

    def test_half_widths_follow_past_errors_week_by_week(self) -> None:
        widths = sync_garmin._modeling.interval_half_widths
        quantile = sync_garmin._modeling.quantile
        errors = {week: sorted(0.1 * week + 0.01 * i for i in range(40)) for week in range(1, 13)}
        result = widths(errors, std_residual=0.3)
        self.assertEqual([round(quantile(errors[week], 0.8), 6) for week in range(1, 13)], [round(v, 6) for v in result])

    def test_half_widths_never_shrink_and_fall_back_without_samples(self) -> None:
        widths = sync_garmin._modeling.interval_half_widths
        # 오차가 없으면 모수 추정이다: 1.28 × 표준편차 × √주.
        parametric = widths({}, std_residual=0.4, weeks=4)
        self.assertEqual([round(1.28 * 0.4 * week ** 0.5, 6) for week in (1, 2, 3, 4)], [round(v, 6) for v in parametric])
        # 3주까지만 오차가 충분하다. 4주부터는 3주의 반폭을 √(주 비)로 늘린다. 모수 추정과 섞지 않는다.
        errors = {1: [0.5] * 30, 2: [0.7] * 30, 3: [1.2] * 30, 4: [0.1] * 5}
        partial = widths(errors, std_residual=0.1, weeks=6)
        self.assertEqual([0.5, 0.7, 1.2], partial[:3])
        self.assertAlmostEqual(1.2 * (4 / 3) ** 0.5, partial[3])
        self.assertAlmostEqual(1.2 * (6 / 3) ** 0.5, partial[5])
        # 어느 주의 과거 오차가 앞 주보다 작아도 반폭은 줄지 않는다.
        dipping = widths({1: [0.9] * 30, 2: [0.6] * 30, 3: [1.0] * 30}, std_residual=0.1, weeks=3)
        self.assertEqual([0.9, 0.9, 1.0], dipping)

    def test_band_has_no_step_and_matches_the_backtest_errors(self) -> None:
        rows = self._noisy_rows()
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 78}, detail=True)
        band = summary["predictionCI"]["series"]
        half = [round(point["upper80"] - point["central"], 2) for point in band]
        self.assertEqual(12, len(half))
        self.assertEqual(half, [round(point["central"] - point["lower80"], 2) for point in band])
        self.assertEqual([point["valueKg"] for point in summary["series"]["prediction"][1:]], [point["central"] for point in band])
        for earlier, later in zip(half, half[1:]):
            self.assertGreaterEqual(later, earlier)
            # 예전에는 8주 → 9주에 1.8배로 뛰었다(12주의 RMSE를 9주부터 빌려 썼다).
            self.assertLessEqual(later, earlier * 1.5 + 0.01)

        # 요약과 따로 다시 계산한다: 주마다 운영 모델의 |실측 − 예측|의 80분위.
        modeling = sync_garmin._modeling
        usable = rows  # 마지막 행에 체중이 있다
        ewma = [{"date": r["date"], "valueKg": v} for r, v in zip(usable, modeling.compute_ewma([r["weight_kg"] for r in usable]))]
        ma7 = {p["date"]: p["valueKg"] for p in summary["series"]["daily"]}
        run = modeling.run_backtest(usable, ewma, ma7, target_weight=78.0, horizons=modeling.CI_HORIZONS)
        expected = []
        for week in range(1, 13):
            errors = sorted(abs(s["actual"] - s["predictions"]["current"]) for s in run["samples"][7 * week])
            self.assertGreaterEqual(len(errors), 20, f"fixture should give enough samples at week {week}")
            expected.append(modeling.quantile(errors, 0.8))
        for week in range(1, 12):
            expected[week] = max(expected[week], expected[week - 1])
        self.assertEqual([round(v, 2) for v in expected], half)

    def test_replayed_hit_rate_is_near_the_target_every_week(self) -> None:
        summary = sync_garmin.build_summary(self._noisy_rows(), {"targetWeightKg": 78}, detail=True)
        calibration = summary["modelDiagnostics"]["ciCalibration"]
        self.assertEqual([f"{7 * week}d" for week in range(1, 13)], list(calibration["hitRate"]))
        self.assertEqual(0.8, calibration["targetHitRate"])
        for horizon, rate in calibration["hitRate"].items():
            with self.subTest(horizon=horizon):
                self.assertIsNotNone(rate)
                self.assertGreater(rate, 0.6)
                self.assertLess(rate, 0.97)
        # 화면이 쓰는 네 기간만 predictionCI.hitRate에 둔다.
        self.assertEqual(["7d", "14d", "28d", "84d"], list(summary["predictionCI"]["hitRate"]))
        self.assertEqual(calibration["hitRate"]["28d"], summary["predictionCI"]["hitRate"]["28d"])

    def test_comparison_table_keeps_its_four_horizons(self) -> None:
        for detail in (False, True):
            diag = sync_garmin.build_summary(self._noisy_rows(), {"targetWeightKg": 78}, detail=detail)["modelDiagnostics"]
            with self.subTest(detail=detail):
                self.assertEqual(["7d", "14d", "28d", "84d"], list(diag["backtest"]))
                self.assertEqual(["7d", "14d", "28d", "84d"], list(diag["backtestSampleCounts"]))
                for name, stats in diag["modelAudit"].items():
                    self.assertEqual(["7d", "14d", "28d", "84d"], list(stats), name)

    def test_short_history_uses_the_parametric_band(self) -> None:
        from math import sin
        rows = _series_rows([round(84.0 + 0.3 * sin(i * 1.3), 2) for i in range(40)])
        summary = sync_garmin.build_summary(rows, {"targetWeightKg": 78})
        std = summary["predictionCI"]["stdResidual"]
        half = [round(point["upper80"] - point["central"], 2) for point in summary["predictionCI"]["series"]]
        self.assertEqual([round(1.28 * std * week ** 0.5, 2) for week in range(1, 13)], half)


class LongRangeRateTests(unittest.TestCase):
    """재검토 MD2(결정): 12주 값과 목표 도달일에는 느린 감량률(28일·56일 기울기의 평균)을 쓴다. 곡선 모양은 그대로다."""

    @staticmethod
    def _steady_then_drop(drop_days: int = 0) -> list[dict]:
        """120일 동안 주 0.2kg씩 빠지다가, 마지막 drop_days일에 하루 0.4kg씩 급히 빠진다."""
        from math import sin
        weights = [86.0 - 0.2 / 7 * i + 0.15 * sin(i * 1.3) for i in range(120)]
        for back in range(drop_days):
            weights[119 - back] -= 0.4 * (drop_days - back)
        return _series_rows([round(w, 2) for w in weights])

    def test_forecast_uses_the_fast_rate_first_and_the_slow_rate_later(self) -> None:
        modeling = sync_garmin._modeling
        curve, forecast = modeling._projected_weight, modeling.forecast_weight
        start, fast, slow, target = 84.0, 0.5, 0.1, 78.0
        for week in (0, 1, 2.5, 4):
            self.assertEqual(curve(start, fast, week, target), forecast(start, fast, week, target, slow))
        for week in (12, 20, 60):
            self.assertEqual(curve(start, slow, week, target), forecast(start, fast, week, target, slow))
        # 그 사이는 느린 감량률의 곡선에, 4주까지 벌어진 차이를 12주까지 고르게 줄여 가며 더한다.
        gap = curve(start, fast, 4, target) - curve(start, slow, 4, target)
        self.assertLess(gap, -1.0)
        self.assertAlmostEqual(curve(start, slow, 8, target) + gap / 2, forecast(start, fast, 8, target, slow))
        self.assertAlmostEqual(curve(start, slow, 5, target) + gap * 7 / 8, forecast(start, fast, 5, target, slow))
        self.assertAlmostEqual(curve(start, slow, 11.9, target) + gap * 0.1 / 8, forecast(start, fast, 11.9, target, slow))
        # 두 감량률이 같으면 모든 기간이 한 곡선이다(곡선 모양은 그대로다).
        for week in (3, 5, 8, 11, 12, 40):
            self.assertAlmostEqual(curve(start, fast, week, target), forecast(start, fast, week, target, fast), places=12)
        # 느린 감량률이 없으면 모든 기간이 혼합 감량률의 곡선이다(예전과 같다).
        for week in (1, 6, 12, 30):
            self.assertEqual(curve(start, fast, week, target), forecast(start, fast, week, target))
            self.assertEqual(curve(start, fast, week, target), forecast(start, fast, week, target, None))

    def test_slow_rate_is_the_mean_of_the_28_and_56_day_slopes(self) -> None:
        modeling = sync_garmin._modeling

        def detail(days: int) -> dict:
            rows = self._steady_then_drop()[:days]
            ewma = [{"date": r["date"], "valueKg": v} for r, v in zip(rows, modeling.compute_ewma([r["weight_kg"] for r in rows]))]
            return modeling.compute_weekly_loss_rate(ewma, {}, rows, rows[-1]["date"])

        full = detail(120)
        slopes = full["longRangeSlopes"]
        self.assertEqual(["28d", "56d"], list(slopes))
        self.assertEqual(full["windowSlopes"]["28d"], slopes["28d"])
        self.assertAlmostEqual((slopes["28d"] + slopes["56d"]) / 2, full["longRangeRate"], places=4)
        self.assertAlmostEqual(0.2, full["longRangeRate"], delta=0.03)  # 주 0.2kg씩 빠지는 이력이다
        # 56일 창에 점이 28개에 못 미치면 28일 기울기만 쓴다.
        short = detail(20)
        self.assertIsNone(short["longRangeSlopes"]["56d"])
        self.assertEqual(short["longRangeSlopes"]["28d"], short["longRangeRate"])
        # 혼합 감량률을 만들 수 없는 초기에는 느린 감량률도 없다.
        early = detail(10)
        self.assertIsNone(early["blended"])
        self.assertIsNone(early["longRangeRate"])

    def test_three_month_value_and_eta_come_from_the_slow_rate(self) -> None:
        modeling = sync_garmin._modeling
        summary = sync_garmin.build_summary(self._steady_then_drop(drop_days=5), {"targetWeightKg": 78})
        detail = summary["rolling"]["lossRateDetail"]
        fast, slow = detail["blended"], detail["longRangeRate"]
        self.assertTrue(detail["longRangeApplied"])
        self.assertGreater(fast, slow * 2)  # 최근 닷새의 급한 감량이 혼합 감량률을 끌어올렸다
        start = summary["series"]["prediction"][0]["valueKg"]
        predictions = summary["predictions"]
        self.assertEqual(round(modeling._projected_weight(start, fast, 4, 78.0), 2), predictions["oneMonthWeightKg"])
        self.assertEqual(round(modeling._projected_weight(start, slow, 12, 78.0), 2), predictions["threeMonthWeightKg"])
        base = predictions["scenarios"]["base"]
        self.assertEqual((fast, slow), (base["effectiveWeeklyLossKg"], base["longRangeWeeklyLossKg"]))
        self.assertEqual(predictions["threeMonthWeightKg"], base["series"][-1]["valueKg"])
        self.assertEqual([p["valueKg"] for p in summary["series"]["prediction"]], [p["valueKg"] for p in base["series"]])
        self.assertEqual([round(modeling.forecast_weight(start, fast, week, 78.0, slow), 2) for week in range(13)],
                         [p["valueKg"] for p in summary["series"]["prediction"]])
        # 세 시나리오는 두 감량률에 같은 만큼을 더하거나 뺀다.
        for name, scenario in predictions["scenarios"].items():
            with self.subTest(scenario=name):
                self.assertAlmostEqual(fast - slow, scenario["effectiveWeeklyLossKg"] - scenario["longRangeWeeklyLossKg"], places=3)
        # 도달일은 그려진 곡선이 목표 + ε에 처음 닿는 날이다. 12주 뒤이므로 느린 감량률의 곡선 위에 있다.
        goal = summary["goal"]
        self.assertEqual("date", goal["etaStatus"])
        self.assertGreater(goal["etaDays"], 84)
        limit = 78.0 + goal["etaToleranceKg"]
        self.assertLessEqual(modeling._projected_weight(start, slow, goal["etaDays"] / 7, 78.0), limit)
        self.assertGreater(modeling._projected_weight(start, slow, (goal["etaDays"] - 1) / 7, 78.0), limit)

    def test_a_few_fast_days_move_the_long_range_values_less(self) -> None:
        def values(drop_days: int, slow_rate: bool) -> tuple[float, float, int | None]:
            config = {"targetWeightKg": 78, "features": {"slowLongRangeRate": slow_rate}}
            summary = sync_garmin.build_summary(self._steady_then_drop(drop_days), config)
            return summary["predictions"]["oneMonthWeightKg"], summary["predictions"]["threeMonthWeightKg"], summary["goal"]["etaDays"]

        before_on, after_on = values(0, True), values(5, True)
        before_off, after_off = values(0, False), values(5, False)
        # 1개월 값은 두 설정에서 같다.
        self.assertEqual((before_off[0], after_off[0]), (before_on[0], after_on[0]))
        # 닷새의 급한 감량이 3개월 값과 도달일을 움직이는 폭: 느린 감량률을 쓰면 절반에 못 미친다.
        moved_on, moved_off = before_on[1] - after_on[1], before_off[1] - after_off[1]
        self.assertGreater(moved_off, 1.0)
        self.assertLess(moved_on, moved_off / 2)
        self.assertLess(abs(before_on[2] - after_on[2]), abs(before_off[2] - after_off[2]) / 2)

    def test_eta_follows_the_long_trend(self) -> None:
        eta = sync_garmin._modeling.projected_eta
        # 최근에는 빠지지만 긴 추세가 감량이 아니면 도달일을 내지 않는다(곡선이 12주 안에 닿지 않는 한).
        self.assertEqual(("no_loss", None), eta(84.0, 0.3, 78.0, long_weekly_loss=-0.05))
        self.assertEqual(("no_loss", None), eta(84.0, 0.3, 78.0, long_weekly_loss=0.0))
        # 최근에 조금 올랐어도 긴 추세가 감량이면 도달일이 남는다.
        status, days = eta(84.0, -0.1, 78.0, long_weekly_loss=0.3)
        self.assertEqual("date", status)
        self.assertGreater(days, 84)
        self.assertEqual(("beyond", None), eta(84.0, -0.1, 78.0, long_weekly_loss=0.02))
        self.assertEqual(("no_loss", None), eta(84.0, -0.1, 78.0, long_weekly_loss=-0.02))
        # 목표가 코앞이면 최근 추세의 곡선이 먼저 닿는다.
        status, days = eta(78.6, 0.3, 78.0, long_weekly_loss=-0.05)
        self.assertEqual("date", status)
        self.assertLessEqual(days, 28)
        # 느린 감량률을 주지 않으면 예전과 같다.
        self.assertEqual(eta(84.0, 0.5, 78.0), eta(84.0, 0.5, 78.0, long_weekly_loss=0.5))

    def test_switch_off_keeps_one_rate_for_every_horizon(self) -> None:
        modeling = sync_garmin._modeling
        rows = self._steady_then_drop(drop_days=5)
        off = sync_garmin.build_summary(rows, {"targetWeightKg": 78, "features": {"slowLongRangeRate": False}}, detail=True)
        detail = off["rolling"]["lossRateDetail"]
        self.assertFalse(detail["longRangeApplied"])
        self.assertIsNotNone(detail["longRangeRate"])  # 값은 진단용으로 남는다
        start, fast = off["series"]["prediction"][0]["valueKg"], detail["blended"]
        self.assertEqual([round(modeling._projected_weight(start, fast, week, 78.0), 2) for week in range(13)],
                         [p["valueKg"] for p in off["series"]["prediction"]])
        on = sync_garmin.build_summary(rows, {"targetWeightKg": 78}, detail=True)
        self.assertTrue(sync_garmin.feature_flags({})["slowLongRangeRate"], "the switch is on unless the config turns it off")
        # 4주까지의 성적은 두 설정에서 같고, 12주 성적만 다르다.
        for horizon in ("7d", "14d", "28d"):
            self.assertEqual(off["modelDiagnostics"]["backtest"][horizon], on["modelDiagnostics"]["backtest"][horizon])
        self.assertNotEqual(off["modelDiagnostics"]["backtest"]["84d"]["maeKg"], on["modelDiagnostics"]["backtest"]["84d"]["maeKg"])

    def test_regime_split_separates_losing_cutoffs(self) -> None:
        """재검토 MD4: 전체 평균은 감량 추세일 때와 그 밖의 차이를 가린다. 기준 시점의 감량률 부호로 나눈다."""
        def sample(rate, predicted, flat, actual):
            return {"rate": rate, "actual": actual, "predictions": {"current": predicted, "ewma_flat": flat}}

        samples = {28: [sample(0.3, 83.0, 84.0, 83.6), sample(0.1, 82.0, 83.0, 83.0),   # 감량 추세: 예측이 0.6, 1.0 낮다
                        sample(0.0, 84.0, 84.0, 84.2), sample(-0.2, 85.0, 84.2, 84.6), sample(None, 84.0, 84.0, 84.0)]}
        split = sync_garmin._modeling.regime_split(samples, horizons=(28, 84))
        self.assertEqual({"sampleCount": 2, "maeKg": 0.8, "flatMaeKg": 0.2, "biasKg": -0.8}, split["28d"]["losing"])
        self.assertEqual({"sampleCount": 3, "maeKg": 0.2, "flatMaeKg": 0.2, "biasKg": 0.067}, split["28d"]["other"])
        self.assertEqual({"sampleCount": 0, "maeKg": None, "flatMaeKg": None, "biasKg": None}, split["84d"]["losing"])

    def test_backtest_uses_the_same_forecast_as_the_summary(self) -> None:
        modeling = sync_garmin._modeling
        rows = self._steady_then_drop(drop_days=5)
        ewma = [{"date": r["date"], "valueKg": v} for r, v in zip(rows, modeling.compute_ewma([r["weight_kg"] for r in rows]))]
        run = modeling.run_backtest(rows, ewma, {}, target_weight=78.0, horizons=(28, 56, 84))
        checked = 0
        for horizon in (28, 56, 84):
            for sample in run["samples"][horizon][-3:]:
                index = sample["index"]
                detail = modeling.compute_weekly_loss_rate(ewma[:index], {}, rows[:index], rows[index - 1]["date"])
                expected = modeling.forecast_weight(ewma[index - 1]["valueKg"], detail["blended"], horizon / 7, 78.0, detail["longRangeRate"])
                self.assertAlmostEqual(expected, sample["predictions"]["current"], places=9)
                checked += 1
        self.assertEqual(9, checked)
        single = modeling.run_backtest(rows, ewma, {}, target_weight=78.0, horizons=(84,), use_long_rate=False)
        sample = single["samples"][84][-1]
        detail = modeling.compute_weekly_loss_rate(ewma[:sample["index"]], {}, rows[:sample["index"]], rows[sample["index"] - 1]["date"])
        self.assertAlmostEqual(modeling._projected_weight(ewma[sample["index"] - 1]["valueKg"], detail["blended"], 12, 78.0),
                               sample["predictions"]["current"], places=9)


class SummarySlimTests(unittest.TestCase):
    """P9: 아무도 읽지 않는 계열은 요약에 없다."""

    def test_unused_series_are_gone(self) -> None:
        rows = [_daily_row((sync_garmin.date(2030, 1, 1) + sync_garmin.timedelta(days=d)).isoformat(), 84.0 - d * 0.01)
                for d in range(40)]
        for summary in (sync_garmin.build_summary(rows, {"targetWeightKg": 78}), sync_garmin.build_summary([], {"targetWeightKg": 78})):
            self.assertEqual({"daily", "ma14", "ewma", "prediction"}, set(summary["series"]))
            self.assertIn("series", summary["predictionCI"])


def _contrast(a: str, b: str) -> float:
    def lum(hex_color: str) -> float:
        h = hex_color.lstrip("#")
        channels = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


class PageHygieneTests(unittest.TestCase):
    """P9: 색 대비(A1), 마크업(A3), 문자열 끼워 넣기(F7), 고정 문구, 검색 노출."""

    APP = MODULE_PATH.parents[1]

    def _tokens(self) -> dict:
        import re
        css = (self.APP / "style.css").read_text(encoding="utf-8")
        root = css[css.index(":root {"):css.index("}", css.index(":root {"))]
        return dict(re.findall(r"--([\w-]+):\s*(#[0-9A-Fa-f]{6})", root))

    def test_text_colors_meet_contrast(self) -> None:
        tokens = self._tokens()
        # 글자가 놓이는 밝은 배경: 패널(흰색), 패널 안의 칸(--panel-alt), 페이지 바탕(--bg).
        backgrounds = {"white": "#FFFFFF", "panel-alt": tokens["panel-alt"], "bg": tokens["bg"]}
        # 정의만 있고 쓰이지 않는 색 변수가 다시 생기지 않게 한다(재검토 FE7). 칩의 견본 색은 index.html의 style 속성에서 쓴다.
        used_in = (self.APP / "style.css").read_text(encoding="utf-8") + (self.APP / "index.html").read_text(encoding="utf-8")
        unused = [name for name in tokens if f"var(--{name})" not in used_in]
        self.assertEqual([], unused, "color variables that are defined but never used")
        for name in ("muted", "accent-text", "ink", "ink-soft", "accent-ink"):
            for bg_name, bg in backgrounds.items():
                with self.subTest(text=name, background=bg_name):
                    self.assertGreaterEqual(_contrast(tokens[name], bg), 4.5)
        css = (self.APP / "style.css").read_text(encoding="utf-8")
        self.assertGreaterEqual(_contrast("#FFFFFF", tokens["accent-strong"]), 4.5)
        self.assertIn(".hero-badge--gaining { background: var(--accent-strong); color: #fff; }", css)
        self.assertGreaterEqual(_contrast("#FFFFFF", "#756A64"), 4.5)
        self.assertIn(".hero-badge--neutral { background: #756A64; color: #fff; }", css)
        self.assertNotIn("color: var(--accent);", css)  # 강조색을 글자로 쓸 때는 --accent-text

    def test_markup_and_scripts(self) -> None:
        import re
        html = (self.APP / "index.html").read_text(encoding="utf-8")
        self.assertIn('<meta name="robots" content="noindex" />', html)
        for button in re.findall(r"<button\b.*?</button>", html, flags=re.S):
            self.assertNotRegex(button, r"<(p|div|h\d)\b")
        for stale in ("SYNC V2.4.1", "MONITORING TREND", "LOW RELIABILITY", "Last Sync Status", "Weight Trend"):
            self.assertNotIn(stale, html)
        for script in ("app.js", "app.helpers.js", "enhancements.js"):
            source = (self.APP / script).read_text(encoding="utf-8")
            with self.subTest(script=script):
                self.assertNotIn(".innerHTML", source)
                self.assertNotIn("PLATEAU_CONTENT", source)


class PwaAssetTests(unittest.TestCase):
    """P8(W3, W5): 자산 버전은 sw.js 한 곳에서 정하고, index.html·manifest가 같은 값을 쓴다."""

    APP = MODULE_PATH.parents[1]

    def _version(self) -> str:
        import re
        match = re.search(r"const ASSET_VERSION = '([0-9a-z]+)';", (self.APP / "sw.js").read_text(encoding="utf-8"))
        self.assertIsNotNone(match)
        return match.group(1)

    def test_versions_match_the_service_worker(self) -> None:
        import json
        import re
        version = self._version()
        html = (self.APP / "index.html").read_text(encoding="utf-8")
        manifest = json.loads((self.APP / "manifest.webmanifest").read_text(encoding="utf-8"))
        sw = (self.APP / "sw.js").read_text(encoding="utf-8")
        local = re.findall(r'(?:href|src)="\./([^"?]+)\?v=([0-9a-z]+)"', html)
        self.assertGreaterEqual(len(local), 8)
        for path, used in local:
            with self.subTest(path=path):
                self.assertEqual(version, used)
                self.assertIn(f"`./{path}?v=${{ASSET_VERSION}}`", sw)
        for icon in manifest["icons"]:
            path, used = icon["src"].removeprefix("./").split("?v=")
            with self.subTest(icon=path):
                self.assertEqual(version, used)
                self.assertIn(f"`./{path}?v=${{ASSET_VERSION}}`", sw)
                self.assertTrue((self.APP / path).is_file())
        self.assertEqual(manifest["theme_color"], re.search(r'name="theme-color" content="([^"]+)"', html).group(1))
        self.assertNotIn("apple-mobile-web-app-capable", html)
        self.assertTrue(any(i["type"] == "image/png" and i["sizes"] == "512x512" for i in manifest["icons"]))

    def test_cdn_assets_carry_integrity(self) -> None:
        import re
        html = (self.APP / "index.html").read_text(encoding="utf-8")
        for tag in re.findall(r"<(?:script|link)[^>]+cdn\.jsdelivr\.net[^>]*>", html):
            with self.subTest(tag=tag[:80]):
                self.assertRegex(tag, r'integrity="sha384-[A-Za-z0-9+/=]+"')
                self.assertIn('crossorigin="anonymous"', tag)
                self.assertNotIn(".min.", tag)  # jsDelivr가 즉석에서 만드는 .min 파일은 SRI를 걸 수 없다
        self.assertNotIn("pretendardvariable.min.css", html)
        self.assertIn("dynamic-subset", html)
        self.assertIn("JetBrains+Mono:wght@700&", html)


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
    "modelDiagnostics.longRange.status",
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
        for path in ("coverage", "modelDiagnostics.dataQuality", "series.ma14"):
            with self.subTest(path=path):
                self.assertIsNot(_MISSING, _lookup(summary, path))
        self.assertFalse(summary["modelDiagnostics"]["trend"]["predictionEnabled"])


if __name__ == "__main__":
    unittest.main()
