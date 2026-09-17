import csv
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRAPER = load_module("bus-arrival/scripts/scrape.py", "bus_arrival_scrape")


class BusArrivalLogicTests(unittest.TestCase):
    def test_departure_requires_last_observation_to_be_near_arrival(self):
        self.assertEqual(
            SCRAPER._classify_departure(0, "PASS", 45, None),
            "observed_arrival",
        )
        self.assertEqual(
            SCRAPER._classify_departure(0, "PASS", 150, None),
            "vehicle_changed",
        )
        self.assertEqual(
            SCRAPER._classify_departure(2, "PASS", 30, None),
            "data_gap",
        )

    def test_summary_excludes_no_bus_zero_predictions(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            predict = base / "predict.csv"
            arrival = base / "arrival.csv"
            output = base / "summary.json"
            with predict.open("w", newline="", encoding="utf-8") as stream:
                writer = csv.DictWriter(stream, fieldnames=["ts_kst", "vehId", "predict_sec"])
                writer.writeheader()
                writer.writerows([
                    {"ts_kst": "2026-09-18T09:00:00+09:00", "vehId": "0", "predict_sec": "0"},
                    {"ts_kst": "2026-09-18T09:01:00+09:00", "vehId": "12", "predict_sec": "180"},
                ])
            arrival.write_text("departure_reason\nvehicle_changed\n", encoding="utf-8")
            subprocess.run([
                sys.executable,
                str(ROOT / "bus-arrival/scripts/build_summary.py"),
                "--predict", str(predict),
                "--arrival", str(arrival),
                "--output", str(output),
            ], check=True)
            summary = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(summary["prediction_samples"], 2)
            self.assertEqual(summary["valid_prediction_samples"], 1)
            self.assertEqual(summary["no_bus_samples"], 1)
            self.assertEqual(summary["today"]["min_predict_sec"], 180)


if __name__ == "__main__":
    unittest.main()
