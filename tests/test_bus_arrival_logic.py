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


def bus(vid, predict_sec, location_no=None, plate="경기70아0000"):
    return {**NO_BUS, "veh_id": vid, "plate_no": plate, "predict_sec": predict_sec,
            "location_no": location_no}


def read_csv(path):
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def simulate(directory, responses, start, state=None, extra_args=(), poll_times=None, secondary=None):
    """가짜 시계로 run_loop 를 돌린다. 1차 정류장 응답만 responses 순서대로 돌려준다.

    poll_times 리스트를 주면 1차 조회 시각을, secondary 리스트를 주면 2차 조회 시각을 채운다.
    """
    base = Path(directory)
    if state is not None:
        (base / "tracker_state.json").write_text(json.dumps(state), encoding="utf-8")
    clock = {"now": start}
    queue = iter(responses)

    def fake_fetch(service_key, station_id, route_id, sta_order):
        if station_id == SCRAPER.STATION_ID:
            if poll_times is not None:
                poll_times.append(clock["now"])
            return next(queue)
        if secondary is not None:
            secondary.append(clock["now"])
        return None

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
        *extra_args,
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

    def test_holidays_come_from_holidays_json(self):
        # 2026 추석 연휴는 휴일, 2025 추석 날짜(2026-10-06)는 평일이다
        self.assertEqual(SCRAPER.gate_decision(self.at(17, 0, dt.date(2026, 9, 25)))["reason"], "holiday")
        self.assertEqual(SCRAPER.gate_decision(self.at(17, 0, dt.date(2026, 3, 2)))["reason"], "holiday")
        self.assertEqual(SCRAPER.gate_decision(self.at(17, 0, dt.date(2026, 10, 6)))["reason"], "ok")

    def test_missing_holidays_file_falls_back_to_collecting(self):
        self.assertEqual(SCRAPER.load_holidays("/nonexistent/holidays.json"), (set(), set()))

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
        # 버스가 있을 때만 2차 정류장을 조회한다: (1+1) + (1+1) + 1
        self.assertEqual(state["daily_calls"], 5)

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
        # 도착 추정 시각은 확정 시점이 아니라 처음 안 보인 시점
        self.assertEqual(arrivals[0]["ts_kst"], "2026-09-28T17:02:00+09:00")
        self.assertEqual(arrivals[0]["est_arrival_ts"], "2026-09-28T17:01:00+09:00")

    def test_bus_vanishing_one_stop_away_is_estimated_arrival(self):
        """3100번 실측 패턴: 1정거장 전에서 예측초가 195초에 멈춘 채 통과해 사라진다."""
        with tempfile.TemporaryDirectory() as directory:
            arrivals, state = simulate(
                directory, [bus(111, 270, 1), bus(111, 195, 1), bus(111, 195, 1), NO_BUS], self.START)
        self.assertEqual([r["departure_reason"] for r in arrivals], ["estimated_arrival"])
        self.assertEqual(arrivals[0]["est_arrival_ts"], "2026-09-28T17:03:00+09:00")
        self.assertIsNone(state["cur_vid"])
        self.assertIsNone(state["first_miss_ts"])

    def test_vehicle_change_one_stop_away_is_estimated_arrival(self):
        with tempfile.TemporaryDirectory() as directory:
            arrivals, _ = simulate(directory, [bus(111, 250, 1), bus(222, 600, 5)], self.START)
        self.assertEqual([r["departure_reason"] for r in arrivals], ["estimated_arrival"])

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
        self.assertEqual(saved["daily_calls"], 11)

    def test_does_not_poll_outside_window(self):
        late = dt.datetime(2026, 9, 28, 22, 0, tzinfo=KST)
        with tempfile.TemporaryDirectory() as directory:
            arrivals, state = simulate(directory, [], late)
        self.assertEqual(arrivals, [])
        self.assertEqual(state, {})


class BusArrivalAdaptivePollingTests(unittest.TestCase):
    START = dt.datetime(2026, 9, 28, 17, 0, tzinfo=KST)

    def run_sim(self, responses, **kwargs):
        times = []
        secondary = []
        with tempfile.TemporaryDirectory() as directory:
            arrivals, state = simulate(directory, responses, self.START, poll_times=times,
                                       secondary=secondary, **kwargs)
            status = json.loads((Path(directory) / "status.json").read_text(encoding="utf-8"))
        return times, secondary, state, status, arrivals

    @staticmethod
    def gaps(times):
        return [int((b - a).total_seconds()) for a, b in zip(times, times[1:])]

    def test_idle_interval_is_longer_than_tracking_interval(self):
        times, _, _, _, _ = self.run_sim([NO_BUS, NO_BUS, NO_BUS])
        self.assertEqual(self.gaps(times), [120, 120])
        times, _, _, _, _ = self.run_sim([bus(111, 900), bus(111, 840), bus(111, 780)])
        self.assertEqual(self.gaps(times), [60, 60])

    def test_pending_vanish_confirmation_keeps_fast_polling(self):
        # 멀리서 사라진 차량은 소실 확정 전까지(추적 중) 60초 간격, 확정되면 유휴 간격
        times, _, state, _, arrivals = self.run_sim([bus(111, 500), NO_BUS, NO_BUS, NO_BUS])
        self.assertEqual(self.gaps(times), [60, 60, 120])
        self.assertEqual([r["departure_reason"] for r in arrivals], ["vanished"])
        self.assertIsNone(state["cur_vid"])

    def test_api_failure_retries_at_tracking_interval(self):
        times, _, _, _, _ = self.run_sim([None, NO_BUS])
        self.assertEqual(self.gaps(times), [60])

    def test_secondary_station_is_polled_only_when_a_bus_is_present(self):
        _, secondary, state, _, _ = self.run_sim([NO_BUS, bus(111, 600), NO_BUS])
        self.assertEqual(len(secondary), 1)
        self.assertEqual(state["daily_calls"], 4)  # 1 + (1+1) + 1

    def test_status_reports_current_poll_interval(self):
        _, _, _, status, _ = self.run_sim([NO_BUS])
        self.assertEqual(status["poll_interval_sec"], 120)
        self.assertNotIn("secondary_available", status)
        _, _, _, status, _ = self.run_sim([bus(111, 600)])
        self.assertEqual(status["poll_interval_sec"], 60)

    def test_idle_interval_is_configurable(self):
        times, _, _, _, _ = self.run_sim([NO_BUS, NO_BUS], extra_args=("--idle-interval", "180"))
        self.assertEqual(self.gaps(times), [180])

    def test_next_poll_time_carries_over_between_segments(self):
        with tempfile.TemporaryDirectory() as directory:
            times = []
            simulate(directory, [NO_BUS], self.START, poll_times=times)
            state = json.loads((Path(directory) / "tracker_state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["next_poll_ts"], "2026-09-28T17:02:00+09:00")
            # 30초 뒤에 새 세그먼트가 시작돼도 다음 조회 시각(17:02:00)까지 기다린다
            times = []
            simulate(directory, [NO_BUS], self.START + dt.timedelta(seconds=30), poll_times=times)
        self.assertEqual(times, [self.START + dt.timedelta(minutes=2)])

    def test_segment_without_due_poll_fills_run_seconds(self):
        """다음 조회가 구간 밖이면 조회 없이 구간 길이(게시 주기)만큼 기다린 뒤 끝난다."""
        state = {"date": "2026-09-28", "daily_calls": 0, "last_poll": "2026-09-28T17:00:00+09:00",
                 "next_poll_ts": "2026-09-28T17:10:00+09:00"}
        with tempfile.TemporaryDirectory() as directory:
            times = []
            simulate(directory, [NO_BUS], self.START, state=state, poll_times=times,
                     extra_args=("--run-seconds", "300"))
        self.assertEqual(times, [])

    def test_exit_on_change_ends_segment_when_bus_first_seen(self):
        times, _, state, _, _ = self.run_sim([bus(111, 900), bus(111, 840)], extra_args=("--exit-on-change",))
        self.assertEqual(len(times), 1)
        self.assertEqual(state["cur_vid"], 111)
        # 변화가 없으면 계속 조회한다
        times, _, _, _, _ = self.run_sim([NO_BUS, NO_BUS], extra_args=("--exit-on-change",))
        self.assertEqual(len(times), 2)

    def test_exit_on_change_ends_segment_when_track_closes(self):
        times, _, state, _, arrivals = self.run_sim(
            [bus(111, 60), bus(111, 40), NO_BUS, NO_BUS], extra_args=("--exit-on-change",))
        # 첫 발견에서 한 번 끝나므로 이어 붙여 실행하는 상황을 상태 파일로 재현한다
        self.assertEqual(len(times), 1)


class GuardRowsTests(unittest.TestCase):
    GUARD = load_module("bus-arrival/scripts/guard_rows.py", "bus_arrival_guard")
    TODAY = dt.date(2026, 9, 29)

    @staticmethod
    def csv_text(days):
        return "ts_kst,vehId\n" + "".join(f"{d}T17:00:00+09:00,1\n" for d in days)

    def check(self, head_days, now_days):
        head = {"b/predict_log.csv": self.csv_text(head_days)}
        now = {"b/predict_log.csv": self.csv_text(now_days)}
        return self.GUARD.shrunk_files("b", lambda p: head.get(p, ""), lambda p: now.get(p, ""), self.TODAY)

    def test_row_loss_in_recent_days_is_reported(self):
        bad = self.check(["2026-09-29"] * 5, ["2026-09-29"] * 3)
        self.assertEqual(bad, [("predict_log.csv", 5, 3)])

    def test_growth_and_trimmed_old_rows_pass(self):
        self.assertEqual(self.check(["2026-09-29"] * 3, ["2026-09-29"] * 4), [])
        # 30일 트림으로 오래된 행이 사라지는 것은 최근 2일 비교에 걸리지 않는다
        self.assertEqual(self.check(["2026-08-01", "2026-09-29"], ["2026-09-29"]), [])


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
