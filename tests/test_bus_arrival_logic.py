import csv
import datetime as dt
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRAPER = load_module("bus-arrival/scripts/scrape.py", "bus_arrival_scrape")
KST = SCRAPER.KST
NO_BUS = SCRAPER.no_bus_info("PASS")


def bus(vid, predict_sec, plate="경기70아0000"):
    return {**NO_BUS, "veh_id": vid, "plate_no": plate, "predict_sec": predict_sec}


def read_csv(path):
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def simulate(directory, responses, start, state=None):
    """가짜 시계로 run_loop 를 돌린다. 1차 정류장 응답만 responses 순서대로 돌려준다."""
    base = Path(directory)
    if state is not None:
        (base / "tracker_state.json").write_text(json.dumps(state), encoding="utf-8")
    clock = {"now": start}
    queue = iter(responses)

    def fake_fetch(service_key, station_id, route_id, sta_order):
        return next(queue) if station_id == SCRAPER.STATION_ID else None

    class FakeTime:
        @staticmethod
        def sleep(seconds):
            clock["now"] += dt.timedelta(seconds=seconds)

        @staticmethod
        def monotonic():
            return (clock["now"] - start).total_seconds()

    args = SCRAPER.parse_args([
        "--output-csv", str(base / "arrival_log.csv"),
        "--status-json", str(base / "status.json"),
        "--secondary-station-id", "205000029",
        "--window", "16:00-22:00",
        "--max-polls", str(max(1, len(responses))),
    ])
    with mock.patch.dict(os.environ, {"SERVICE_KEY": "test-key"}), \
            mock.patch.object(SCRAPER, "fetch_arrival", fake_fetch), \
            mock.patch.object(SCRAPER, "kst_now", lambda: clock["now"]), \
            mock.patch.object(SCRAPER, "time", FakeTime):
        SCRAPER.run_loop(args)
    state_path = base / "tracker_state.json"
    return (
        read_csv(base / "arrival_log.csv"),
        json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {},
    )


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
        self.assertEqual(
            SCRAPER._classify_departure(0, "PASS", 500, None, vanished=True),
            "vanished",
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
                # summary 의 today 는 실행일(KST) 기준이므로 오늘 날짜로 만든다
                today = dt.datetime.now(KST).strftime("%Y-%m-%d")
                writer.writerows([
                    {"ts_kst": f"{today}T09:00:00+09:00", "vehId": "0", "predict_sec": "0"},
                    {"ts_kst": f"{today}T09:01:00+09:00", "vehId": "12", "predict_sec": "180"},
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
            self.assertEqual(len(summary["recent_predictions"]), 2)
            self.assertEqual(summary["recent_arrivals"], [{"departure_reason": "vehicle_changed"}])


class BusArrivalGateTests(unittest.TestCase):
    MONDAY = dt.date(2026, 9, 28)

    def at(self, hh, mm, day=None):
        d = day or self.MONDAY
        return dt.datetime(d.year, d.month, d.day, hh, mm, tzinfo=KST)

    def test_waits_until_window_start_on_weekday(self):
        decision = SCRAPER.gate_decision(self.at(15, 30), "16:00-22:00")
        self.assertEqual(decision, {"skip": True, "reason": "before_window", "wait_seconds": 1800})

    def test_collects_only_inside_window(self):
        self.assertEqual(SCRAPER.gate_decision(self.at(16, 0), "16:00-22:00")["reason"], "ok")
        self.assertEqual(SCRAPER.gate_decision(self.at(21, 59), "16:00-22:00")["reason"], "ok")
        self.assertEqual(SCRAPER.gate_decision(self.at(22, 0), "16:00-22:00")["reason"], "after_window")

    def test_skips_weekend_holiday_and_quota(self):
        self.assertEqual(SCRAPER.gate_decision(self.at(17, 0, dt.date(2026, 9, 27)))["reason"], "weekend")
        self.assertEqual(SCRAPER.gate_decision(self.at(17, 0, dt.date(2026, 10, 5)))["reason"], "holiday")
        self.assertEqual(
            SCRAPER.gate_decision(self.at(17, 0), daily_calls=900, max_daily_calls=900)["reason"],
            "quota",
        )


class BusArrivalTrackingTests(unittest.TestCase):
    START = dt.datetime(2026, 9, 28, 17, 0, tzinfo=KST)

    def test_bus_vanishing_near_station_is_recorded_as_arrival(self):
        with tempfile.TemporaryDirectory() as directory:
            arrivals, state = simulate(directory, [bus(111, 150), bus(111, 50), NO_BUS], self.START)
        self.assertEqual(len(arrivals), 1)
        row = arrivals[0]
        self.assertEqual(row["vehId"], "111")
        self.assertEqual(row["departure_reason"], "observed_arrival")
        self.assertEqual(row["samples"], "2")
        self.assertEqual(row["last_predict_sec"], "50")
        self.assertEqual(row["est_arrival_ts"], "2026-09-28T17:01:50+09:00")
        self.assertIsNone(state["cur_vid"])
        self.assertEqual(state["daily_calls"], 6)

    def test_vehicle_change_closes_previous_track(self):
        with tempfile.TemporaryDirectory() as directory:
            arrivals, state = simulate(directory, [bus(111, 400), bus(222, 600)], self.START)
        self.assertEqual([r["departure_reason"] for r in arrivals], ["vehicle_changed"])
        self.assertEqual(state["cur_vid"], 222)

    def test_far_bus_needs_consecutive_misses_before_closing(self):
        with tempfile.TemporaryDirectory() as directory:
            arrivals, state = simulate(directory, [bus(111, 500), NO_BUS, bus(111, 480)], self.START)
        self.assertEqual(arrivals, [])
        self.assertEqual(state["samples"], 2)
        with tempfile.TemporaryDirectory() as directory:
            arrivals, _ = simulate(directory, [bus(111, 500), NO_BUS, NO_BUS], self.START)
        self.assertEqual([r["departure_reason"] for r in arrivals], ["vanished"])

    def test_track_left_over_from_long_gap_is_logged_as_stale(self):
        state = {
            "date": "2026-09-28", "daily_calls": 10,
            "cur_vid": 111, "cur_plate": "경기70아0000",
            "first_seen": "2026-09-28T16:00:00+09:00", "last_seen": "2026-09-28T16:05:00+09:00",
            "last_poll": "2026-09-28T16:05:00+09:00",
            "min_predict": 30, "max_predict": 300, "samples": 5, "last_predict": 30,
        }
        with tempfile.TemporaryDirectory() as directory:
            arrivals, saved = simulate(directory, [NO_BUS], self.START, state)
        self.assertEqual([r["departure_reason"] for r in arrivals], ["stale"])
        self.assertEqual(arrivals[0]["est_arrival_ts"], "2026-09-28T16:05:30+09:00")
        self.assertEqual(saved["daily_calls"], 12)

    def test_does_not_poll_outside_window(self):
        late = dt.datetime(2026, 9, 28, 22, 0, tzinfo=KST)
        with tempfile.TemporaryDirectory() as directory:
            arrivals, state = simulate(directory, [], late)
        self.assertEqual(arrivals, [])
        self.assertEqual(state, {})


class BusArrivalCsvTests(unittest.TestCase):
    def test_append_extends_header_for_new_columns(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "log.csv"
            path.write_text("ts_kst,vehId\n2026-09-28T17:00:00+09:00,1\n", encoding="utf-8")
            SCRAPER.append_csv(str(path), {"ts_kst": "2026-09-28T17:01:00+09:00", "vehId": 2, "location_no": 3})
            rows = read_csv(path)
        self.assertEqual(list(rows[0].keys()), ["ts_kst", "vehId", "location_no"])
        self.assertEqual(rows[0]["location_no"], "")
        self.assertEqual(rows[1]["location_no"], "3")


if __name__ == "__main__":
    unittest.main()
