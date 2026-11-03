import csv
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_bus_arrival_logic import ROOT, SCRAPER, KST, NO_BUS, simulate

sys.path.insert(0, str(ROOT / "bus-arrival" / "scripts"))
import gbis_web  # noqa: E402

ROUTE = 204000170
YURA, CITY_HALL = 206000565, 205000029
START = dt.datetime(2026, 11, 3, 18, tzinfo=KST)
# 3100 노선 순번 일부: 4 → 5 → 6(07511) → 7 ... 12(06004) ... 23(하행 시작)
STATIONS = {4: 204000162, 5: 204000340, 6: YURA, 7: 206000679, 11: 205000030, 12: CITY_HALL,
            13: 205000031, 22: 234001269, 23: 234001272, 40: 204000283, 1: 204000284}


def vehicle(veh_id, from_order, to_order=None, position="2", direction="U"):
    to_order = to_order or from_order + 1
    return {"vehId": str(veh_id), "busNo": ["경기70사0001"], "busDirList": [direction],
            "fromStationId": str(STATIONS.get(from_order, 0)), "toStationId": str(STATIONS.get(to_order, 0)),
            "busPosition": [position], "busXList": [14149567], "busYList": [4495441],
            "seat": "40", "density": "1"}


def payload(*vehicles, success=True):
    return {"success": success, "result": {
        "realTime": {"count": len(vehicles), "list": list(vehicles), "vehicleList": [["경기70사0002"]]},
        "estimateTime": [{"stationId": str(sid), "staOrder": str(order), "routeId": str(ROUTE)}
                         for order, sid in sorted(STATIONS.items())],
    }}


def parsed(*vehicles):
    return gbis_web.parse_route_positions(payload(*vehicles))


def read_csv(path):
    if not Path(path).exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


class ParserTests(unittest.TestCase):
    def test_vehicle_segments_are_mapped_to_route_orders(self):
        data = parsed(vehicle(111, 5), vehicle(222, 23, direction="D"))
        first = data["vehicles"][0]
        self.assertEqual((first["veh_id"], first["from_order"], first["to_order"]), (111, 5, 6))
        self.assertEqual((first["dir"], first["bus_position"], first["seat"]), ("U", "2", 40))
        self.assertEqual(data["orders"][YURA], 6)
        self.assertEqual(data["waiting_count"], 1)

    def test_no_running_bus_is_empty_not_failure(self):
        self.assertEqual(parsed()["vehicles"], [])

    def test_unknown_station_keeps_row_without_order(self):
        data = gbis_web.parse_route_positions(payload({**vehicle(111, 5), "fromStationId": "999"}))
        self.assertIsNone(data["vehicles"][0]["from_order"])

    def test_station_visited_twice_is_ambiguous(self):
        body = payload(vehicle(111, 5))
        body["result"]["estimateTime"].append({"stationId": str(YURA), "staOrder": "30"})
        self.assertIsNone(gbis_web.parse_route_positions(body)["orders"][YURA])

    def test_schema_changes_are_rejected(self):
        for body in (payload(success=False), {"success": True}, {"success": True, "result": {"estimateTime": []}},
                     {"success": True, "result": {"realTime": {}, "estimateTime": [{"stationId": "x"}]}},
                     payload({**vehicle(111, 5), "vehId": ""})):
            with self.assertRaises(ValueError):
                gbis_web.parse_route_positions(body)


class FetchTests(unittest.TestCase):
    def response(self, status, text):
        return gbis_web.httpx.Response(status, text=text, request=gbis_web.httpx.Request("POST", gbis_web.URL))

    def fetch(self, **kwargs):
        detail = {}
        with mock.patch.object(gbis_web.httpx, "post", **kwargs) as post:
            result = gbis_web.fetch_route_positions(ROUTE, diagnostics=detail)
        return result, detail, post

    def test_success_posts_route_query(self):
        result, detail, post = self.fetch(return_value=self.response(200, json.dumps(payload(vehicle(1, 5)))))
        self.assertEqual(len(result["vehicles"]), 1)
        self.assertEqual(detail, {})
        self.assertEqual(post.call_args.kwargs["data"], {"cmd": "searchRouteJson", "routeId": str(ROUTE)})

    def test_failures_record_only_controlled_codes(self):
        cases = [
            ({"return_value": self.response(503, "secret body")}, {"kind": "http_error", "http_status": 503}),
            ({"return_value": self.response(200, "<html>secret</html>")}, {"kind": "invalid_response"}),
            ({"return_value": self.response(200, json.dumps({"success": False, "secret": 1}))}, {"kind": "invalid_schema"}),
            ({"side_effect": gbis_web.httpx.ConnectTimeout("secret")}, {"kind": "timeout", "phase": "connect"}),
            ({"side_effect": gbis_web.httpx.ConnectError("secret")}, {"kind": "connection_error"}),
        ]
        for kwargs, expected in cases:
            with self.subTest(expected=expected):
                result, detail, _ = self.fetch(**kwargs)
                self.assertIsNone(result)
                self.assertEqual(detail, expected)
                self.assertNotIn("secret", json.dumps(detail))


class PassDetectionTests(unittest.TestCase):
    TARGETS = {YURA: 6, CITY_HALL: 12}

    def step(self, previous, vehicles, minute):
        return gbis_web.detect_passes(previous, parsed(*vehicles)["vehicles"], START + dt.timedelta(minutes=minute),
                                      self.TARGETS, route_id=ROUTE, max_gap_sec=1200)

    def test_reaching_target_order_records_bounds(self):
        events, memory = self.step({}, [vehicle(111, 5)], 0)
        self.assertEqual(events, [])
        events, memory = self.step(memory, [vehicle(111, 6, position="1")], 1)
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual((event["veh_id"], event["station_id"], event["sta_order"]), (111, YURA, 6))
        self.assertEqual(event["lower_ts"], START.isoformat())
        self.assertEqual(event["upper_ts"], (START + dt.timedelta(minutes=1)).isoformat())
        self.assertEqual((event["gap_sec"], event["cur_bus_position"]), (60, "1"))
        events, memory = self.step(memory, [vehicle(111, 7)], 2)
        self.assertEqual(events, [])  # 이미 도달한 정류장은 다시 세지 않는다

    def test_skipping_several_stops_reports_each_target_once(self):
        _, memory = self.step({}, [vehicle(111, 4)], 0)
        events, _ = self.step(memory, [vehicle(111, 13)], 5)
        self.assertEqual([e["station_id"] for e in events], [YURA, CITY_HALL])

    def test_new_trip_and_small_jitter_do_not_create_passes(self):
        _, memory = self.step({}, [vehicle(111, 40, direction="D")], 0)
        events, memory = self.step(memory, [vehicle(111, 1)], 1)
        self.assertEqual(events, [])
        _, memory = self.step(memory, [vehicle(111, 6)], 2)
        events, memory = self.step(memory, [vehicle(111, 5)], 3)  # 흔들림
        self.assertEqual(memory["111"]["order"], 6)
        events, _ = self.step(memory, [vehicle(111, 6)], 4)
        self.assertEqual(events, [])

    def test_long_gap_and_temporary_absence(self):
        _, memory = self.step({}, [vehicle(111, 5)], 0)
        events, gone = self.step(memory, [], 1)
        self.assertIn("111", gone)  # 잠시 빠진 차량은 기억한다
        events, _ = self.step(gone, [vehicle(111, 6)], 3)
        self.assertEqual(events[0]["gap_sec"], 180)
        events, forgotten = self.step(memory, [vehicle(111, 6)], 21)
        self.assertEqual(events, [])  # 공백이 길면 구간이 너무 넓다
        self.assertEqual(forgotten["111"]["order"], 6)
        _, pruned = self.step(memory, [], 25)
        self.assertNotIn("111", pruned)


class ScraperIntegrationTests(unittest.TestCase):
    BUS = {**NO_BUS, "veh_id": 111, "plate_no": "경기70사0001", "predict_sec": 300, "location_no": 2, "flag": "PASS"}

    def run_with_web(self, folder, responses, web_results, extra=("--gbis-web",), start=START, details=None,
                     delay=0):
        queue = iter(web_results)

        def fake_web(route_id, *, diagnostics=None):
            SCRAPER.time.sleep(delay)  # simulate() 가 바꿔 둔 가짜 시계
            result = next(queue)
            if result is None and diagnostics is not None:
                diagnostics.update(details or {"kind": "timeout", "phase": "connect"})
            return result

        with mock.patch.object(SCRAPER, "fetch_route_positions", side_effect=fake_web) as web:
            arrivals, state = simulate(folder, responses, start, extra_args=extra)
        status = json.loads((Path(folder) / "status.json").read_text(encoding="utf-8"))
        return arrivals, state, status, web

    def test_positions_and_passes_are_logged_without_using_data_go_kr_budget(self):
        with tempfile.TemporaryDirectory() as plain, tempfile.TemporaryDirectory() as folder:
            _, baseline = simulate(plain, [self.BUS, self.BUS], START)
            _, state, status, web = self.run_with_web(
                folder, [self.BUS, self.BUS], [parsed(vehicle(111, 5), vehicle(222, 30, direction="D")),
                                               parsed(vehicle(111, 6, position="1"), vehicle(222, 31, direction="D"))],
                delay=2)
            positions = read_csv(Path(folder) / "route_position_log.csv")
            passes = read_csv(Path(folder) / "route_pass_log.csv")
        self.assertEqual(web.call_count, 2)
        self.assertEqual(state["daily_calls"], baseline["daily_calls"])
        self.assertEqual(state["gbis_web"]["calls"], 2)
        self.assertEqual(len(positions), 4)
        self.assertEqual({r["veh_id"] for r in positions}, {"111", "222"})
        self.assertEqual([(p["veh_id"], p["station_id"], p["sta_order"]) for p in passes], [("111", str(YURA), "6")])
        # 구간 경계는 GBIS 응답 시각 (data.go.kr 조회 시각보다 늦다)
        self.assertEqual(passes[0]["lower_ts"], (START + dt.timedelta(seconds=2)).isoformat())
        self.assertEqual(passes[0]["upper_ts"], (START + dt.timedelta(seconds=62)).isoformat())
        self.assertEqual(positions[0]["ts_kst"], (START + dt.timedelta(seconds=2)).isoformat())
        self.assertEqual(status["gbis_web"]["ok"], True)
        self.assertEqual(status["gbis_web"]["vehicles"], 2)
        self.assertEqual(status["gbis_web"]["passes"], 1)
        self.assertEqual(status["current_veh_id"], 111)

    def test_failures_back_off_and_leave_primary_tracking_unchanged(self):
        with tempfile.TemporaryDirectory() as plain, tempfile.TemporaryDirectory() as folder:
            _, baseline = simulate(plain, [self.BUS] * 5, START)
            _, state, status, web = self.run_with_web(folder, [self.BUS] * 5, [None] * 5)
            plain_status = json.loads((Path(plain) / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(web.call_count, 3)  # 3회 연속 실패 뒤 10분간 쉰다
        self.assertEqual(status["gbis_web"]["skipped"], "backoff")
        self.assertEqual(status["gbis_web"]["consec_fail"], 3)
        for key in ("cur_vid", "samples", "daily_calls", "consec_fail", "last_success", "next_poll_ts"):
            self.assertEqual(state[key], baseline[key], key)
        self.assertEqual(state["connection_health"]["consecutive_timeouts"], 0)
        for key in ("current_veh_id", "predict_sec", "safety", "poll_interval_sec", "daily_calls"):
            self.assertEqual(status[key], plain_status[key], key)

    def test_recovers_after_backoff(self):
        with tempfile.TemporaryDirectory() as folder:
            _, state, _, _ = self.run_with_web(folder, [self.BUS] * 3, [None] * 3)
            _, state, status, web = self.run_with_web(folder, [self.BUS], [parsed(vehicle(111, 5))],
                                                      start=START + dt.timedelta(minutes=13))
        self.assertEqual(web.call_count, 1)
        self.assertEqual((status["gbis_web"]["ok"], state["gbis_web"]["consec_fail"]), (True, 0))
        self.assertIsNone(state["gbis_web"]["skip_until"])

    def test_unexpected_collector_error_is_contained(self):
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(SCRAPER, "detect_passes", side_effect=RuntimeError("secret")):
            arrivals, state, status, _ = self.run_with_web(folder, [self.BUS], [parsed(vehicle(111, 5))])
        self.assertEqual(status["gbis_web"], {"ok": False, "error_detail": {"kind": "unexpected_error"}})
        self.assertEqual(status["current_veh_id"], 111)
        self.assertNotIn("secret", json.dumps(status))

    def test_disabled_by_default(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("BUS_GBIS_WEB", None)
            _, _, status, web = self.run_with_web(folder, [self.BUS], [], extra=())
        self.assertEqual(web.call_count, 0)
        self.assertNotIn("gbis_web", status)
        self.assertTrue(SCRAPER.parse_args(["--gbis-web"]).gbis_web)


if __name__ == "__main__":
    unittest.main()
