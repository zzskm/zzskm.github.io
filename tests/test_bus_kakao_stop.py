import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bus-arrival" / "scripts"))
import kakao_stop  # noqa: E402
from kakao_stop import KakaoDataError, fetch_info, learn_plates, load_plate_map, parse_stop  # noqa: E402

PLATES = {"경기70아7046": 204001378, "경기70아7047": 204001379}


def line(line_id="B70088", name="3100", order=6, plate="경기70아7046", predict=436, stops=2,
         plate2="", predict2=0, stops2=0, state="NORMAL", collect="NORMAL"):
    """2026-11-03 실제 BS73661 응답에서 필요한 필드만 남긴 형태."""
    return {
        "id": line_id, "name": name, "realTime": True, "realtimeState": state,
        "running": state == "NORMAL",
        "arrival": {
            "busStopId": "BS73661", "order": order,
            "vehicleNumber": plate, "vehicleState": "0" if plate else "1001",
            "arrivalTime": predict, "busStopCount": stops, "lastVehicle": False,
            "vehicleNumber2": plate2, "vehicleState2": "0" if plate2 else "1001",
            "arrivalTime2": predict2, "busStopCount2": stops2,
            "collectStatus": collect, "collectStatus2": "NORMAL",
        },
    }


def stop(*lines):
    return {"id": "BS73661", "name": "유라코퍼레이션.SK케미칼", "lines": list(lines)}


OTHER = line("B70086", "310", order=40, plate="경기70아6124", predict=2, stops=1)


class ParseStopTests(unittest.TestCase):
    def test_target_vehicle_maps_to_gbis_shape_and_vehicle_id(self):
        data = parse_stop(stop(OTHER, line(plate2="경기70아7047", predict2=1300, stops2=15)), PLATES)
        info = data["info"]
        self.assertEqual(set(info), set(kakao_stop._empty()))
        self.assertEqual((info["veh_id"], info["plate_no"], info["predict_sec"], info["location_no"]),
                         (204001378, "경기70아7046", 436, 2))
        self.assertEqual((info["next_veh_id"], info["next_plate_no"], info["next_predict_sec"]),
                         (204001379, "경기70아7047", 1300))
        # 카카오에 없는 GBIS 값은 만들어 내지 않는다
        self.assertEqual((info["state_cd"], info["remain_seat"], info["flag"]), (None, None, ""))
        self.assertEqual(data["raw"]["vehicle_state"], "0")

    def test_unknown_next_vehicle_keeps_plate_without_vehicle_id(self):
        info = parse_stop(stop(line(plate2="경기70아9999", predict2=900, stops2=9)), PLATES)["info"]
        self.assertEqual((info["next_veh_id"], info["next_plate_no"]), (None, "경기70아9999"))

    def test_no_target_vehicle_is_no_bus_when_stop_has_other_vehicles(self):
        data = parse_stop(stop(OTHER, line(plate="", predict=0, stops=0, state="NOVEHICLE")), PLATES)
        self.assertEqual(data["info"], kakao_stop._empty())

    def test_unusable_responses_fail_instead_of_becoming_no_bus(self):
        cases = {
            "invalid_response": {"lines": "x"},
            "line_missing": stop(OTHER),
            "direction_mismatch": stop(line(order=12)),
            "duplicate_direction": stop(line(), line()),
            "not_realtime": stop(line(state="NOREALTIME")),
            "collect_status": stop(line(collect="ERROR")),
            "unknown_vehicle": stop(line(plate="경기70아9999")),
            "invalid_vehicle": stop(line(predict=None)),
            "all_lines_empty": stop(line(plate="", state="NOVEHICLE"),
                                    line("B70086", "310", order=40, plate="", state="NOVEHICLE")),
        }
        for kind, data in cases.items():
            with self.subTest(kind=kind), self.assertRaises(KakaoDataError) as caught:
                parse_stop(data, PLATES)
            self.assertEqual(caught.exception.kind, kind)

    def test_other_direction_is_ignored_when_target_order_exists(self):
        info = parse_stop(stop(line(order=12, plate="경기70아7047"), line()), PLATES)["info"]
        self.assertEqual(info["veh_id"], 204001378)


def response(status=200, body=None, text=None):
    r = kakao_stop.httpx.Response(status, text=text if text is not None else json.dumps(body))
    r.request = kakao_stop.httpx.Request("GET", kakao_stop.STOP_URL)
    return r


class FetchTests(unittest.TestCase):
    def test_success_requests_target_stop(self):
        with mock.patch.object(kakao_stop.httpx, "get", return_value=response(body=stop(line()))) as get:
            result = fetch_info(PLATES)
        self.assertEqual(result["info"]["veh_id"], 204001378)
        self.assertEqual(get.call_args.kwargs["params"], {"busstopid": "BS73661"})
        self.assertEqual(get.call_args.kwargs["timeout"], kakao_stop.TIMEOUT_SEC)

    def test_failures_record_only_controlled_detail(self):
        cases = [
            (kakao_stop.httpx.ConnectTimeout("busstopid=secret"), {"kind": "timeout", "phase": "connect"}),
            (kakao_stop.httpx.ReadTimeout("secret"), {"kind": "timeout", "phase": "read"}),
            (kakao_stop.httpx.ConnectError("secret"), {"kind": "connection_error"}),
            (response(403, text="<html>secret</html>"), {"kind": "http_error", "http_status": 403}),
            (response(200, text="<html>secret</html>"), {"kind": "invalid_response"}),
            (response(body=stop(line(plate="경기70아9999"))), {"kind": "unknown_vehicle"}),
        ]
        for outcome, expected in cases:
            kwargs = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
            detail = {"stale": True}
            with self.subTest(expected=expected), mock.patch.object(kakao_stop.httpx, "get", **kwargs), \
                    self.assertLogs(level="WARNING"):
                self.assertIsNone(fetch_info(PLATES, diagnostics=detail))
            self.assertEqual(detail, expected)
            self.assertNotIn("secret", json.dumps(detail))


class PlateMapTests(unittest.TestCase):
    def test_learns_from_gbis_info_and_predict_log(self):
        mapping = learn_plates({}, {"veh_id": 111, "plate_no": "경기70아0001",
                                    "next_veh_id": 222, "next_plate_no": "경기70아0002"})
        self.assertEqual(mapping, {"경기70아0001": 111, "경기70아0002": 222})
        learn_plates(mapping, kakao_stop._empty())
        self.assertEqual(len(mapping), 2)

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "predict_log.csv"
            path.write_text(
                "ts_kst,vehId,plateNo,predict_sec,source\n"
                "2026-11-03T20:00:00+09:00,111,경기70아0001,500,\n"
                "2026-11-03T20:01:00+09:00,,,,\n"
                "2026-11-03T20:02:00+09:00,333,경기70아0001,400,gbis\n"
                "2026-11-03T20:03:00+09:00,999,경기70아0003,300,kakao\n",
                encoding="utf-8")
            self.assertEqual(load_plate_map(str(path)), {"경기70아0001": 333})
            self.assertEqual(load_plate_map(str(Path(folder) / "missing.csv")), {})


if __name__ == "__main__":
    unittest.main()
