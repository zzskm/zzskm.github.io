"""도착 정보 출처 교대 조회(source_rotation.py)와 scrape.run_loop 연결 회귀 테스트.

네트워크는 쓰지 않는다. 공식 API(fetch_arrival), GBIS 웹 정류장(fetch_station_info),
카카오·네이버(fetch_info)를 출처별 가짜 응답으로 바꾸고 가짜 시계로 run_loop 를 돌린다.
"""
import csv
import datetime as dt
import importlib.util
import json
import os
import random
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


SCRAPER = load_module("bus-arrival/scripts/scrape.py", "bus_rotation_scrape")
ROTATION = SCRAPER.source_rotation
SAFETY = load_module("bus-arrival/scripts/safety_model.py", "bus_rotation_safety")
NAVER = SCRAPER.naver_stop
GBIS_WEB = load_module("bus-arrival/scripts/gbis_web.py", "bus_rotation_gbis_web")
KST = SCRAPER.KST
NO_BUS = SCRAPER.no_bus_info("PASS")
ALL = "official,gbis_web,kakao,naver"
START = dt.datetime(2026, 11, 3, 18, 0, tzinfo=KST)  # 화요일


def bus(vid, predict_sec, location_no=3, plate=None):
    return {**NO_BUS, "veh_id": vid, "plate_no": plate or f"경기70아{vid % 10000:04d}",
            "predict_sec": predict_sec, "location_no": location_no}


class InOrder:
    """shuffle 을 하지 않는 난수: 주머니와 대체 순서가 설정 순서 그대로다."""

    @staticmethod
    def shuffle(items):
        return None


def read_csv(path):
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def run(directory, responses, polls, *, sources=ALL, state=None, extra_args=(), rng=None, interval=60,
        delays=None, seen_plates=None):
    """responses: {출처: [응답 또는 None ...]} — 출처를 부를 때마다 앞에서 하나씩 꺼낸다.

    반환: (호출 기록 [(시각, 출처)], arrival 행, predict 행, status, state, 종료 코드)
    """
    base = Path(directory)
    if state is not None:
        (base / "tracker_state.json").write_text(json.dumps(state), encoding="utf-8")
    clock = {"now": START}
    queues = {name: list(items) for name, items in responses.items()}
    calls = []

    def take(name, diagnostics=None):
        calls.append((clock["now"], name))
        clock["now"] += dt.timedelta(seconds=(delays or {}).get(name, 0))  # 응답까지 걸린 시간
        queue = queues.get(name)
        if queue is None:
            raise AssertionError(f"{name} 는 호출되면 안 된다")
        result = queue.pop(0) if queue else None
        if result is None and diagnostics is not None:
            diagnostics.update(kind="timeout", phase="connect")
        return result

    def fake_official(service_key, station_id, route_id, sta_order, **kwargs):
        if station_id != SCRAPER.STATION_ID:
            calls.append((clock["now"], "official_secondary"))
            return None
        return take("official", kwargs.get("diagnostics"))

    def fake_gbis_station(station_id, route_id, sta_order, diagnostics=None):
        if station_id != SCRAPER.STATION_ID:
            calls.append((clock["now"], "gbis_web_secondary"))
            return None
        return take("gbis_web", diagnostics)

    def fake_alt(name):
        def fetch(plate_vid, *args, diagnostics=None, **kwargs):
            if seen_plates is not None:
                seen_plates.append(dict(plate_vid))
            info = take(name, diagnostics)
            return None if info is None else {"info": info, "raw": {}}
        return fetch

    class FakeTime:
        @staticmethod
        def sleep(seconds):
            clock["now"] += dt.timedelta(seconds=seconds)

        @staticmethod
        def monotonic():
            return (clock["now"] - START).total_seconds()

    args = SCRAPER.parse_args([
        "--output-csv", str(base / "arrival_log.csv"),
        "--status-json", str(base / "status.json"),
        "--secondary-station-id", "205000029",
        "--window", "16:00-22:00",
        "--sources", sources,
        "--interval", str(interval),
        "--idle-interval", str(interval),
        "--max-polls", str(polls),
        *extra_args,
    ])
    with mock.patch.dict(os.environ, {"SERVICE_KEY": "test-key"}), \
            mock.patch.object(SCRAPER, "fetch_arrival", fake_official), \
            mock.patch.object(SCRAPER, "fetch_station_info", fake_gbis_station), \
            mock.patch.object(SCRAPER.kakao_stop, "fetch_info", fake_alt("kakao")), \
            mock.patch.object(SCRAPER.naver_stop, "fetch_info", fake_alt("naver")), \
            mock.patch.object(SCRAPER, "RNG", rng or InOrder()), \
            mock.patch.object(SCRAPER, "kst_now", lambda: clock["now"]), \
            mock.patch.object(SCRAPER, "time", FakeTime):
        code = SCRAPER.run_loop(args)
    status_path = base / "status.json"
    return (calls, read_csv(base / "arrival_log.csv"), read_csv(base / "predict_log.csv"),
            json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {},
            json.loads((base / "tracker_state.json").read_text(encoding="utf-8")), code)


def primary_calls(calls):
    return [name for _, name in calls if not name.endswith("_secondary")]


class RotationPlanTests(unittest.TestCase):
    def test_parse_sources_validates_and_dedupes(self):
        self.assertEqual(ROTATION.parse_sources(" official, kakao,official "), ["official", "kakao"])
        with self.assertRaises(ValueError):
            ROTATION.parse_sources("official,daum")
        with self.assertRaises(ValueError):
            ROTATION.parse_sources(" , ")

    def test_each_source_is_first_once_per_shuffled_round(self):
        state, names = {}, ROTATION.parse_sources(ALL)
        rng = random.Random(7)
        for round_no in range(5):
            firsts = []
            for poll in range(len(names)):
                order = ROTATION.plan(state, names, START + dt.timedelta(minutes=poll), rng)
                self.assertEqual(sorted(order), sorted(names), "실패 시 나머지 출처를 모두 시도한다")
                firsts.append(order[0])
            self.assertEqual(sorted(firsts), sorted(names), f"{round_no}번째 바퀴")

    def test_single_source_is_unchanged(self):
        state = {}
        self.assertEqual(ROTATION.plan(state, ["official"], START), ["official"])
        self.assertNotIn("rotation", state)

    def test_alternate_source_backs_off_but_official_never_does(self):
        state, names = {}, ROTATION.parse_sources(ALL)
        for minute in range(3):
            ts = START + dt.timedelta(minutes=minute)
            ROTATION.record(state, "kakao", ts, False, {"kind": "http_error", "http_status": 403})
            ROTATION.record(state, "official", ts, False, {"kind": "timeout", "phase": "connect"})
        later = START + dt.timedelta(minutes=5)
        self.assertTrue(ROTATION.in_backoff(state, "kakao", later))
        self.assertFalse(ROTATION.in_backoff(state, "official", later))
        for minute in range(8):
            self.assertNotIn("kakao", ROTATION.plan(state, names, later + dt.timedelta(seconds=minute), InOrder()))
        self.assertIn("kakao", ROTATION.plan(state, names, START + dt.timedelta(minutes=13), InOrder()))
        ROTATION.record(state, "kakao", START + dt.timedelta(minutes=13), True)
        self.assertEqual(state["sources"]["kakao"]["consec_fail"], 0)
        summary = ROTATION.summary(state, names, START + dt.timedelta(minutes=13))
        self.assertEqual(summary["kakao"]["calls"], 4)
        self.assertEqual(summary["official"]["last_error"], {"kind": "timeout", "phase": "connect"})


class RunLoopRotationTests(unittest.TestCase):
    def test_default_uses_only_official_api(self):
        with tempfile.TemporaryDirectory() as folder:
            calls, _, predictions, status, state, _ = run(
                folder, {"official": [NO_BUS, NO_BUS]}, 2, sources="official")
        self.assertEqual(primary_calls(calls), ["official", "official"])
        self.assertEqual([r["source"] for r in predictions], ["official", "official"])
        self.assertEqual(status["data_source"], "official")
        self.assertNotIn("sources", status)
        self.assertEqual(state["daily_calls"], 2)

    def test_rotation_spreads_polls_and_counts_only_official_quota(self):
        responses = {name: [NO_BUS] for name in ("official", "gbis_web", "kakao", "naver")}
        with tempfile.TemporaryDirectory() as folder:
            calls, _, predictions, status, state, _ = run(folder, responses, 4)
        self.assertEqual(primary_calls(calls), ["official", "gbis_web", "kakao", "naver"])
        self.assertEqual([r["source"] for r in predictions], ["official", "gbis_web", "kakao", "naver"])
        self.assertEqual(state["daily_calls"], 1, "data.go.kr 호출 수는 공식 API만 센다")
        self.assertEqual({k: v["calls"] for k, v in status["sources"].items()},
                         {"official": 1, "gbis_web": 1, "kakao": 1, "naver": 1})
        self.assertEqual(status["source_attempts"], [{"source": "naver", "ok": True}])

    def test_official_failure_falls_through_to_next_source_without_runner_rotation(self):
        responses = {"official": [None] * 9, "gbis_web": [bus(11, 600)] * 9,
                     "kakao": [bus(11, 540)] * 9, "naver": [bus(11, 480)] * 9}
        with tempfile.TemporaryDirectory() as folder:
            calls, _, predictions, status, state, code = run(
                folder, responses, 9, extra_args=("--max-connect-timeouts", "2"))
        self.assertIsNone(code, "대체 출처로 자료가 이어지면 runner 를 교체하지 않는다")
        self.assertEqual(primary_calls(calls)[:2], ["official", "gbis_web"])
        self.assertNotIn("error", status)
        self.assertEqual(status["consecutive_connect_timeouts"], 0)
        self.assertEqual(state["consec_fail"], 0)
        self.assertNotIn("official", {r["source"] for r in predictions})
        self.assertEqual(state["cur_vid"], 11)
        # 공식 API는 자기 차례가 올 때마다 다시 시도한다 (쉬지 않는다)
        self.assertGreaterEqual(primary_calls(calls).count("official"), 3)

    def test_all_sources_failing_keeps_api_error_and_runner_rotation(self):
        responses = {name: [None] * 4 for name in ("official", "gbis_web", "kakao", "naver")}
        with tempfile.TemporaryDirectory() as folder:
            calls, _, predictions, status, state, code = run(
                folder, responses, 4, extra_args=("--max-connect-timeouts", "2"))
        self.assertEqual(code, SCRAPER.ROTATE_RUNNER_EXIT_CODE)
        self.assertEqual(status["error"], "api_error")
        self.assertEqual(status["api_error_detail"], {"kind": "timeout", "phase": "connect"})
        self.assertEqual(set(status["source_errors"]), {"gbis_web", "kakao", "naver"})
        self.assertEqual(predictions, [])
        self.assertEqual(state["consec_fail"], 2)

    def test_alternate_vanish_is_confirmed_by_next_source(self):
        tracked = {"date": "2026-11-03", "daily_calls": 0, "cur_vid": 11, "cur_plate": "경기70아0011",
                   "first_seen": "2026-11-03T17:55:00+09:00", "last_seen": "2026-11-03T17:59:00+09:00",
                   "last_poll": "2026-11-03T17:59:00+09:00", "next_poll_ts": "2026-11-03T18:00:00+09:00",
                   "samples": 4, "last_predict": 150, "last_location": 1, "min_predict": 150, "max_predict": 400,
                   "rotation": {"bag": ["kakao", "naver", "official", "gbis_web"]}}
        responses = {"kakao": [NO_BUS], "naver": [bus(11, 120, 1)], "official": [], "gbis_web": []}
        with tempfile.TemporaryDirectory() as folder:
            # 대체 순서 = 설정 순서(InOrder): kakao 다음 naver
            calls, arrivals, predictions, status, state, _ = run(
                folder, responses, 1, state=tracked, sources="kakao,naver,official,gbis_web")
        self.assertEqual(primary_calls(calls), ["kakao", "naver"])
        self.assertEqual(arrivals, [], "한 출처의 일시 누락으로 도착을 확정하지 않는다")
        self.assertEqual(state["cur_vid"], 11)
        self.assertEqual(status["data_source"], "naver")
        self.assertEqual(predictions[-1]["source"], "naver")

    def test_confirmed_vanish_closes_track(self):
        tracked = {"date": "2026-11-03", "daily_calls": 0, "cur_vid": 11, "cur_plate": "경기70아0011",
                   "first_seen": "2026-11-03T17:55:00+09:00", "last_seen": "2026-11-03T17:59:00+09:00",
                   "last_poll": "2026-11-03T17:59:00+09:00", "next_poll_ts": "2026-11-03T18:00:00+09:00",
                   "samples": 4, "last_predict": 40, "last_location": 1, "min_predict": 40, "max_predict": 400,
                   "rotation": {"bag": ["kakao", "naver", "official", "gbis_web"]}}
        responses = {"kakao": [NO_BUS], "naver": [NO_BUS], "official": [], "gbis_web": []}
        with tempfile.TemporaryDirectory() as folder:
            calls, arrivals, _, _, state, _ = run(folder, responses, 1, state=tracked,
                                                  sources="kakao,naver,official,gbis_web")
        self.assertEqual(primary_calls(calls), ["kakao", "naver"])
        self.assertEqual([a["departure_reason"] for a in arrivals], ["observed_arrival"])
        self.assertIsNone(state["cur_vid"])

    def test_status_after_arrival_is_publishable(self):
        # 회귀: 도착 처리 직후 recent_closed 순회가 응답 차량 변수를 덮어써 '버스 없음'이
        # 방금 떠난 차량·예측 없음으로 기록됐고, verify_runtime 이 게시를 막아 세션이 죽었다 (2026-11-04~09)
        verify = load_module("bus-arrival/scripts/verify_runtime.py", "bus_rotation_verify")
        for later, expected_vid in ((NO_BUS, None), (bus(22, 900, 8), 22)):
            with self.subTest(expected_vid=expected_vid), tempfile.TemporaryDirectory() as folder:
                (Path(folder) / "summary.json").write_text(json.dumps({"runtime_schema_version": 2}), encoding="utf-8")
                # 5 도착(→recent_closed 에 남음) 직후 11 도착: 두 번째 도착 때 순회할 항목이 있어야 재현된다
                _, arrivals, _, status, state, _ = run(folder, {"official": [bus(5, 40, 1), bus(11, 40, 1), later]},
                                                       3, sources="official", interval=30)
                self.assertEqual([r["vehId"] for r in arrivals], ["5", "11"])
                self.assertEqual(set(state["recent_closed"]), {"5", "11"})
                self.assertEqual(status.get("current_veh_id"), expected_vid)
                self.assertEqual(status.get("error"), None if expected_vid else "no_bus")
                summary = {"runtime_schema_version": 2, "generated_at": status["last_poll"],
                           "safety_model": {"version": 2, "model_status": status["model_status"]}}
                status["publish_prepared_at"] = status["last_poll"]
                self.assertEqual(verify.validate(summary, status), [])

    def test_lagging_sources_do_not_duplicate_an_arrival(self):
        a, b = bus(11, 40, 1), bus(22, 600, 4)
        responses = {"official": [a, bus(22, 590, 4)], "gbis_web": [b], "kakao": [bus(11, 20, 1)],
                     "naver": [bus(22, 580, 4)]}
        with tempfile.TemporaryDirectory() as folder:
            calls, arrivals, _, status, state, _ = run(folder, responses, 3, interval=30)
        # 2번째: GBIS 웹이 다른 차량(22) → 공식으로 확인 후 11 도착 처리
        # 3번째: 카카오가 방금 도착한 11을 아직 보여줌 → 건너뛰고 다음 출처로 22 확인
        self.assertEqual([(r["vehId"], r["departure_reason"]) for r in arrivals], [("11", "observed_arrival")])
        self.assertEqual(state["cur_vid"], 22)
        self.assertEqual(status["data_source"], "naver")
        self.assertIn("11", state["recent_closed"])

    def test_closed_vehicle_shown_late_by_alternate_is_not_reopened(self):
        responses = {"official": [bus(11, 40, 1), NO_BUS], "gbis_web": [NO_BUS], "kakao": [NO_BUS],
                     "naver": [bus(11, 10, 1)]}
        with tempfile.TemporaryDirectory() as folder:
            _, arrivals, predictions, _, state, _ = run(folder, responses, 4, interval=30)
        self.assertEqual([r["departure_reason"] for r in arrivals], ["observed_arrival"])
        self.assertIsNone(state["cur_vid"])
        self.assertEqual(predictions[-1]["vehId"], "", "늦게 남은 차량은 버스 없음으로 기록한다")

    def test_alternate_values_do_not_reset_last_stop_stall(self):
        stuck = bus(11, 170, 1)
        responses = {"official": [stuck, stuck], "gbis_web": [bus(11, 120, 1)], "kakao": [bus(11, 168, 1)],
                     "naver": [bus(11, 130, 1)]}
        with tempfile.TemporaryDirectory() as folder:
            _, _, _, status, state, _ = run(folder, responses, 5, interval=30)
        self.assertEqual(state["near_stall_since"], START.isoformat(), "공식 값만 멈춤 기준을 정한다")
        self.assertEqual(status["data_source"], "official")

    def test_rows_use_time_of_the_answering_request(self):
        responses = {"official": [None], "gbis_web": [bus(11, 600)], "kakao": [], "naver": []}
        with tempfile.TemporaryDirectory() as folder:
            _, _, predictions, status, state, _ = run(folder, responses, 1, interval=30,
                                                      delays={"official": 30})
        answered = (START + dt.timedelta(seconds=30)).isoformat()
        self.assertEqual(predictions[0]["ts_kst"], answered)
        self.assertEqual(status["last_poll"], answered)
        self.assertEqual(status["safety"]["observation_ts"], answered)
        self.assertEqual(status["api_request_started_at"], START.isoformat())
        self.assertEqual(state["next_poll_ts"], (START + dt.timedelta(seconds=30)).isoformat())

    def test_plate_history_is_merged_under_learned_plates(self):
        seen = []
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "predict_log.csv").write_text(
                "ts_kst,vehId,plateNo,predict_sec,source\n"
                "2026-11-02T18:00:00+09:00,204001378,경기70아7046,300,\n"
                "2026-11-02T18:01:00+09:00,999,경기70아9999,300,naver\n", encoding="utf-8")
            run(folder, {"kakao": [NO_BUS]}, 1, sources="kakao,official", seen_plates=seen,
                state={"plate_vid": {"경기70아7047": 204001379}, "rotation": {"bag": ["kakao"]}})
        self.assertEqual(seen[0], {"경기70아7046": 204001378, "경기70아7047": 204001379})

    def test_secondary_station_follows_primary_source(self):
        responses = {"official": [bus(11, 600)], "gbis_web": [bus(11, 540)],
                     "kakao": [bus(11, 480)], "naver": [bus(11, 420)]}
        with tempfile.TemporaryDirectory() as folder:
            calls, *_ = run(folder, responses, 4)
        names = [name for _, name in calls]
        self.assertEqual(names, ["official", "official_secondary", "gbis_web", "gbis_web_secondary",
                                 "kakao", "naver"])

    def test_urgent_publication_waits_for_urgent_publish_interval(self):
        responses = {"official": [bus(11, 600)] * 6}
        with tempfile.TemporaryDirectory() as folder:
            calls, *_ = run(folder, responses, 6, sources="official", interval=30,
                            extra_args=("--exit-on-change",),
                            state={"date": "2026-11-03", "daily_calls": 0, "cur_vid": 11,
                                   "cur_plate": "경기70아0011", "first_seen": "2026-11-03T17:55:00+09:00",
                                   "last_seen": "2026-11-03T17:59:30+09:00",
                                   "last_poll": "2026-11-03T17:59:30+09:00",
                                   "next_poll_ts": "2026-11-03T18:00:00+09:00", "samples": 3,
                                   "last_predict": 630, "last_location": 3})
        # 30초 조회에서 임박 게시는 60초마다: 첫 조회 뒤가 아니라 두 번째 조회 뒤에 구간을 끝낸다
        self.assertEqual(len(primary_calls(calls)), 2)

    def test_alternate_exception_is_isolated(self):
        responses = {"official": [NO_BUS], "gbis_web": [], "kakao": [], "naver": []}
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(SCRAPER, "poll_alternate", side_effect=RuntimeError("boom")):
                calls, _, predictions, status, _, _ = run(
                    folder, responses, 1, state={"rotation": {"bag": ["kakao", "official"]}})
        self.assertEqual(status["data_source"], "official")
        self.assertEqual(status["source_attempts"][0], {"source": "kakao", "ok": False,
                                                        "error": {"kind": "unexpected_error"}})
        self.assertEqual(predictions[-1]["source"], "official")

    def test_non_default_route_disables_alternate_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            calls, *_ = run(folder, {"official": [NO_BUS]}, 1, extra_args=("--sta-order", "7"))
        self.assertEqual(primary_calls(calls), ["official"])


class PlateMapTests(unittest.TestCase):
    def test_route_positions_and_official_results_teach_plates(self):
        state = {}
        SCRAPER.kakao_stop.learn_plates(state.setdefault("plate_vid", {}), bus(204001378, 300, plate="경기70아7046"))
        self.assertEqual(state["plate_vid"], {"경기70아7046": 204001378})
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            result = {"vehicles": [{"veh_id": 204001379, "plate_no": "경기70아7047", "from_order": 3,
                                    "to_order": 4, "dir": "U", "from_station_id": 1, "to_station_id": 2,
                                    "bus_position": "2", "x": None, "y": None, "seat": None, "density": None}],
                      "orders": {}, "waiting_count": 0}
            with mock.patch.object(SCRAPER, "fetch_route_positions", lambda *a, **k: result), \
                    mock.patch.object(SCRAPER, "kst_now", lambda: START):
                SCRAPER.poll_gbis_web(state, START, 204000170, [], base / "pos.csv", base / "pass.csv")
        self.assertEqual(state["plate_vid"]["경기70아7047"], 204001379)

    def test_gbis_web_min_gap_skips_route_call(self):
        state, called = {}, []
        result = {"vehicles": [], "orders": {}, "waiting_count": 0}
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)

            def fetch(*args, **kwargs):
                called.append(1)
                return result
            with mock.patch.object(SCRAPER, "fetch_route_positions", fetch), \
                    mock.patch.object(SCRAPER, "kst_now", lambda: START):
                for seconds in (0, 30, 60):
                    SCRAPER.poll_gbis_web(state, START + dt.timedelta(seconds=seconds), 204000170, [],
                                          base / "pos.csv", base / "pass.csv", min_gap_sec=55)
        self.assertEqual(len(called), 2)


class SourceParserTests(unittest.TestCase):
    def test_gbis_web_station_parser(self):
        def item(route, order, vid="", minutes="", plate=""):
            return {"routeId": str(route), "staOrder": str(order), "vehId1": vid, "predictTime1": minutes,
                    "plateNo1": plate, "locationNo1": "2" if vid else "", "remainSeatCnt1": "30" if vid else "",
                    "flag": "PASS", "stationNm1": "", "vehId2": "", "predictTime2": ""}
        payload = {"success": True, "result": {"busArrivalInfo": [
            item(204000170, 6, "204001378", "5", "경기70아7046"), item(1, 3, "9", "2", "x")]}}
        info = GBIS_WEB.parse_station_arrivals(payload, 204000170, 6)
        self.assertEqual((info["veh_id"], info["predict_sec"], info["location_no"], info["state_cd"]),
                         (204001378, 300, 2, None))
        empty = {"success": True, "result": {"busArrivalInfo": [item(204000170, 6), item(1, 3, "9", "2")]}}
        self.assertIsNone(GBIS_WEB.parse_station_arrivals(empty, 204000170, 6)["veh_id"])
        for payload, kind in (
            ({"success": True, "result": {"busArrivalInfo": [item(204000170, 6), item(1, 3)]}}, "all_routes_empty"),
            ({"success": True, "result": {"busArrivalInfo": [item(1, 3, "9", "2")]}}, "route_missing"),
            ({"success": True, "result": {"busArrivalInfo": [item(204000170, 7, "9", "2")]}}, "direction_mismatch"),
            ({"success": False}, "unsuccessful_response"),
            ({"success": True, "result": {"busArrivalInfo": [item(204000170, 6, "9", "?")]}}, "invalid_vehicle"),
        ):
            with self.assertRaises(GBIS_WEB.StationDataError) as caught:
                GBIS_WEB.parse_station_arrivals(payload, 204000170, 6)
            self.assertEqual(caught.exception.kind, kind)

    def test_naver_parser(self):
        def entry(route, buses, next_stop=NAVER.NEXT_STOP_ID, status="RUNNING"):
            return {"id": route, "directionStopId": next_stop,
                    "arrival": {"status": status, "buses": buses, "referenceTime": "2026-11-03T20:37:32+09:00"}}
        running = {"plateNo": "경기70아7046", "remainingTime": 207, "remainingStop": 1, "remainingSeat": 43}
        other = entry(5036, [{"plateNo": "경기70아7620", "remainingTime": 140, "remainingStop": 1}])
        plates = {"경기70아7046": 204001378}
        info = NAVER.parse_arrivals([entry(NAVER.ROUTE_ID, [running]), other], plates)["info"]
        self.assertEqual((info["veh_id"], info["predict_sec"], info["location_no"], info["remain_seat"]),
                         (204001378, 207, 1, 43))
        schedule = entry(NAVER.ROUTE_ID, [{"plateNo": None, "remainingTime": 739}], status="SCHEDULE")
        self.assertIsNone(NAVER.parse_arrivals([schedule, other], plates)["info"]["veh_id"])
        for data, kind in (
            ([schedule, entry(5036, [])], "no_realtime"),
            ([entry(NAVER.ROUTE_ID, [running])], None),
            ([entry(NAVER.ROUTE_ID, [running], next_stop=1)], "direction_mismatch"),
            ([entry(NAVER.ROUTE_ID, [running]), entry(NAVER.ROUTE_ID, [running])], "duplicate_direction"),
            ([other], "route_missing"),
            ({"error": 1}, "invalid_response"),
        ):
            if kind is None:
                continue
            with self.assertRaises(NAVER.NaverDataError) as caught:
                NAVER.parse_arrivals(data, plates)
            self.assertEqual(caught.exception.kind, kind)
        with self.assertRaises(NAVER.NaverDataError) as caught:
            NAVER.parse_arrivals([entry(NAVER.ROUTE_ID, [running]), other], {})
        self.assertEqual(caught.exception.kind, "unknown_vehicle")

    def test_naver_errors_never_include_url_or_body(self):
        class Response:
            is_success = False
            status_code = 403
        detail = {}
        with mock.patch.object(NAVER.httpx, "get", lambda *a, **k: Response()):
            self.assertIsNone(NAVER.fetch_info({}, diagnostics=detail))
        self.assertEqual(detail, {"kind": "http_error", "http_status": 403})


class CalibrationSourceTests(unittest.TestCase):
    def test_model_calibrates_on_official_rows_only(self):
        def row(minute, predict, source):
            return {"ts_kst": f"2026-11-02T18:{minute:02d}:00+09:00", "vehId": "11", "plateNo": "p",
                    "predict_sec": str(predict), "location_no": "2", "state_cd": "", "source": source}
        predictions = [row(0, 600, "official"), row(1, 540, "kakao"), row(2, 480, "naver"),
                       row(3, 420, "official"), row(4, 50, "gbis_web")]
        legacy = [{k: v for k, v in r.items() if k != "source"} for r in predictions]
        arrival = {"vehId": "11", "plateNo": "p", "first_seen_ts": "2026-11-02T18:00:00+09:00",
                   "last_seen_ts": "2026-11-02T18:04:00+09:00", "ts_kst": "2026-11-02T18:05:00+09:00",
                   "departure_reason": "observed_arrival", "samples": "5",
                   "est_arrival_ts": "2026-11-02T18:04:50+09:00"}
        trips, audit = SAFETY.match_trips(predictions, [arrival])
        self.assertEqual([r["predict_sec"] for r in trips[0]["rows"]], ["600", "420"])
        self.assertEqual(audit["alternate_source_rows"], 3)
        self.assertTrue(trips[0]["eligible"], "운행 구간 판정은 모든 출처 관측으로 한다")
        legacy_trips, legacy_audit = SAFETY.match_trips(legacy, [arrival])
        self.assertEqual(len(legacy_trips[0]["rows"]), 5, "출처 열이 없던 기록은 공식 API 기록이다")
        self.assertEqual(legacy_audit["alternate_source_rows"], 0)


if __name__ == "__main__":
    unittest.main()
