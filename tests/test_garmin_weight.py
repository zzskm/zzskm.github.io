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


if __name__ == "__main__":
    unittest.main()
