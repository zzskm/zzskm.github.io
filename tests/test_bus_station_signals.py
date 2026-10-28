import csv
import datetime as dt
import importlib.util
import json
import os
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "bus-arrival" / "scripts"
sys.path.insert(0, str(SCRIPTS))
from station_signals import fetch_station_list, parse_station_list, signal_rows


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRAPE = load_module("station_list_scrape_test", "scrape.py")
RELATED = load_module("station_list_related_test", "analyze_related_routes.py")
KST = dt.timezone(dt.timedelta(hours=9))


def xml(items):
    return ET.fromstring(
        "<response><msgHeader><resultCode>0</resultCode></msgHeader><msgBody>"
        + "".join(items) + "</msgBody></response>"
    )


def arrival_node(route_id=204000170, order=6, vid=111, predict=450, name="3100", next_vid=""):
    return (
        "<busArrivalList><routeId>%s</routeId><routeName>%s</routeName>"
        "<staOrder>%s</staOrder><vehId1>%s</vehId1><predictTimeSec1>%s</predictTimeSec1>"
        "<locationNo1>2</locationNo1><flag>PASS</flag>"
        "<vehId2>%s</vehId2></busArrivalList>"
    ) % (route_id, name, order, vid, predict, next_vid)


class StationSignalsParserTests(unittest.TestCase):
    def test_target_direction_and_other_routes_are_preserved(self):
        root = xml([
            arrival_node(route_id=204000170, order=12, vid=999),
            arrival_node(route_id=204000170, order=6, vid=111),
            arrival_node(route_id=233000392, order=4, vid=222, name="6011", next_vid="223"),
        ])
        data = parse_station_list(root, 204000170, 6)
        self.assertEqual(data["info"]["veh_id"], 111)
        self.assertEqual(len(data["routes"]), 3)
        other = [r for r in data["routes"] if r["route_name"] == "6011"][0]
        rows = list(signal_rows("2026-10-28T17:00:00+09:00", 206000565, [other]))
        self.assertEqual([r["veh_id"] for r in rows], [222, 223])
        self.assertEqual([r["vehicle_rank"] for r in rows], [1, 2])
        self.assertEqual(rows[0]["predict_sec"], 450)

    def test_target_absent_means_no_bus_not_api_failure(self):
        data = parse_station_list(xml([arrival_node(route_id=233000392, name="6011")]), 204000170, 6)
        self.assertIsNone(data["info"]["veh_id"])
        self.assertEqual(len(data["routes"]), 1)

    def test_wrong_direction_must_not_be_used(self):
        data = parse_station_list(xml([arrival_node(order=12)]), 204000170, 6)
        self.assertIsNone(data["info"]["veh_id"])

    def test_duplicate_direction_rejected(self):
        with self.assertRaises(ValueError):
            parse_station_list(xml([arrival_node(vid=111), arrival_node(vid=222)]), 204000170, 6)

    def test_diagnostics_do_not_leak_key(self):
        r = SCRAPE.httpx.Response(
            403,
            text="<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>22</returnReasonCode>"
                 "<returnAuthMsg>secret-key</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>",
            request=SCRAPE.httpx.Request("GET", "https://apis.data.go.kr/?serviceKey=secret-key"),
        )
        details = {}
        with mock.patch("station_signals.httpx.get", return_value=r), self.assertLogs(level="WARNING") as output:
            result = fetch_station_list("secret-key", 206000565, 204000170, 6, diagnostics=details)
        self.assertIsNone(result)
        self.assertEqual(details["kind"], "http_error")
        self.assertNotIn("secret-key", "\n".join(output.output) + json.dumps(details))

    def test_api_success_uses_one_station_request_without_route_id(self):
        body = ET.tostring(xml([arrival_node()]), encoding="unicode")
        r = SCRAPE.httpx.Response(200, text=body,
                                  request=SCRAPE.httpx.Request("GET", "https://apis.data.go.kr/"))
        with mock.patch("station_signals.httpx.get", return_value=r) as fetch:
            result = fetch_station_list("private-key", 206000565, 204000170, 6)
        self.assertEqual(result["info"]["veh_id"], 111)
        self.assertTrue(fetch.call_args[0][0].endswith("getBusArrivalListv2"))
        self.assertEqual(fetch.call_args.kwargs["params"]["stationId"], "206000565")
        self.assertNotIn("routeId", fetch.call_args.kwargs["params"])


class StationListRuntimeTests(unittest.TestCase):
    START = dt.datetime(2026, 9, 28, 17, 0, tzinfo=KST)

    def simulate(self, batches, fallback=None):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            cursor = {"time": self.START}
            queue = iter(batches)

            class Clock:
                @staticmethod
                def sleep(seconds):
                    cursor["time"] += dt.timedelta(seconds=seconds)

                @staticmethod
                def monotonic():
                    return (cursor["time"] - self.START).total_seconds()

            args = SCRAPE.parse_args([
                "--output-csv", str(base / "arrival_log.csv"),
                "--status-json", str(base / "status.json"),
                "--secondary-station-id", "205000029",
                "--primary-mode", "station-list",
                "--max-polls", str(len(batches)),
            ])
            def station_fetch(*_args, **kwargs):
                value = next(queue)
                if value is None:
                    kwargs["diagnostics"].update(kind="timeout", phase="read")
                return value

            with mock.patch.dict(os.environ, {"SERVICE_KEY": "dummy"}), \
                    mock.patch.object(SCRAPE, "fetch_station_list", station_fetch), \
                    mock.patch.object(SCRAPE, "fetch_arrival", return_value=fallback or SCRAPE.no_bus_info()) as legacy, \
                    mock.patch.object(SCRAPE, "kst_now", lambda: cursor["time"]), \
                    mock.patch.object(SCRAPE, "time", Clock):
                SCRAPE.run_loop(args)

            def rows(name):
                path = base / name
                if not path.exists():
                    return []
                with path.open(newline="", encoding="utf-8") as stream:
                    return list(csv.DictReader(stream))

            return (rows("route_signal_log.csv"), rows("predict_log.csv"),
                    json.loads((base / "tracker_state.json").read_text(encoding="utf-8")),
                    json.loads((base / "status.json").read_text(encoding="utf-8")),
                    legacy.call_count)

    def test_active_target_and_related_routes_use_existing_call_budget(self):
        root = xml([arrival_node(), arrival_node(route_id=233000392, name="6011", vid=222)])
        batch = parse_station_list(root, 204000170, 6)
        signals, predictions, state, status, secondary_calls = self.simulate([batch])
        self.assertEqual(len(signals), 2)
        self.assertEqual({r["route_name"] for r in signals}, {"3100", "6011"})
        self.assertEqual(predictions[0]["vehId"], "111")
        self.assertEqual(state["daily_calls"], 2)  # 목록 1회 + 기존 2차 정류장 1회
        self.assertEqual(secondary_calls, 1)
        self.assertEqual(status["primary_source"], "station_list")

    def test_list_failure_uses_legacy_only_as_fallback(self):
        signals, predictions, state, status, legacy_calls = self.simulate([None])
        self.assertFalse(signals)
        self.assertEqual(legacy_calls, 1)
        self.assertEqual(state["daily_calls"], 2)
        self.assertEqual(status["primary_source"], "item_fallback")
        self.assertEqual(status["station_list_error_detail"], {"kind": "timeout", "phase": "read"})


class RelatedRouteStatsTests(unittest.TestCase):
    def test_one_vehicle_multiple_polls_count_once_and_do_not_affect_prediction(self):
        signals = [
            {"ts_kst": "2026-10-28T17:00:00+09:00", "route_id": "233000392",
             "route_name": "6011", "sta_order": "4", "vehicle_rank": "1",
             "veh_id": "222", "predict_sec": "240"},
            {"ts_kst": "2026-10-28T17:02:00+09:00", "route_id": "233000392",
             "route_name": "6011", "sta_order": "4", "vehicle_rank": "1",
             "veh_id": "222", "predict_sec": "120"},
        ]
        arrivals = [
            {"est_arrival_ts": "2026-10-28T17:08:00+09:00", "departure_reason": "observed_arrival"}
        ]
        result = RELATED.stats(signals, arrivals)
        c = result["candidate_routes"][0]
        self.assertEqual(c["vehicle_signals"], 1)
        self.assertEqual(c["followed_by_3100_within_20m"], 1)
        self.assertEqual(c["median_lead_minutes"], 4)
        self.assertFalse(c["sufficient_for_screening"])
        self.assertFalse(result["prediction_model_changed"])


if __name__ == "__main__":
    unittest.main()
