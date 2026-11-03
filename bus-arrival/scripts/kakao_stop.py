#!/usr/bin/env python3
"""카카오맵 정류장 도착 정보 수집 — GBIS 조회 실패 시 폴백 입력용.

https://map.kakao.com/bus/stop.json?busstopid=BS73661 (유라코퍼레이션.SK케미칼, 07511)

- 공개 API가 아니라 카카오맵 웹이 내부에서 쓰는 주소다. 예고 없이 바뀌거나 막힐 수 있고
  robots.txt 는 자동 수집을 허용하지 않는다. 사용자가 알고 교대 조회 출처로 쓰기로 했다 (SOURCES.md).
- 값은 GBIS 를 재배포한 것으로 보인다 (2026-11-03 20:34 같은 차량 GBIS 445초·2정거장, 카카오 436초·2정거장).
- 응답에 GBIS vehId 가 없다. 차량번호를 GBIS 에서 관측한 vehId 로 바꾸며, 모르는 차량번호가 첫 차량이면
  실패로 돌려준다 (vehId 없는 차량을 '버스 없음'으로 넘기면 추적이 잘못 종료된다).
- stateCd(도착/출발), 잔여 좌석, flag(PASS/STOP)에 해당하는 값이 없어 None/빈 값으로 둔다.
  vehicleState(예: 0 운행, 1001 차량 없음, 1002 곧 도착으로 보임)는 의미가 확인되지 않아 raw 로만 보존한다.

fetch_info() 는 station_signals.fetch_station_list() 와 같이 실패(None)와 차량 없음(dict)을 구분하고,
오류 상세에는 URL·응답 원문·예외 메시지를 기록하지 않는다.
"""
import argparse
import csv
import json
import logging
import os

import httpx

STOP_URL = "https://map.kakao.com/bus/stop.json"
USER_AGENT = "Mozilla/5.0 (compatible; bus-arrival-log/1.0)"
TIMEOUT_SEC = 10

# 유라코퍼레이션.SK케미칼 정류장과 3100번(판교역 방향, GBIS staOrder 6)
STOP_ID = "BS73661"
LINE_ID = "B70088"
STA_ORDER = 6

REALTIME_STATES = ("NORMAL", "NOVEHICLE")
# vehId 를 GBIS 에서 직접 받은 predict_log 출처 (빈 값/"gbis"는 출처 열 추가 전 기록·이전 이름)
VEHICLE_ID_SOURCES = ("gbis", "official", "gbis_web")


class KakaoDataError(ValueError):
    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


def _empty():
    """scrape.no_bus_info() 와 같은 키."""
    return {
        "veh_id": None, "plate_no": "", "predict_min": None, "predict_sec": None,
        "location_no": None, "remain_seat": None, "state_cd": None, "flag": "",
        "station_nm": "", "next_veh_id": None, "next_plate_no": "",
        "next_predict_min": None, "next_predict_sec": None, "next_remain_seat": None,
    }


def _seconds(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and value.isascii() and value.isdigit():
        return int(value)
    return None


def _has_vehicle(arrival, suffix=""):
    return bool(str(arrival.get("vehicleNumber" + suffix) or "").strip())


def _vehicle(arrival, suffix, plate_vid):
    plate = str(arrival.get("vehicleNumber" + suffix) or "").strip()
    if not plate:
        return None
    predict, stops = _seconds(arrival.get("arrivalTime" + suffix)), _seconds(arrival.get("busStopCount" + suffix))
    if predict is None or stops is None:
        raise KakaoDataError("invalid_vehicle")
    return {"plate_no": plate, "veh_id": plate_vid.get(plate), "predict_sec": predict, "location_no": stops}


def parse_stop(data, plate_vid, line_id=LINE_ID, sta_order=STA_ORDER):
    """정류장 응답에서 대상 노선을 GBIS 항목 조회(fetch_arrival)와 같은 형태로 정규화한다.

    plate_vid: 차량번호 → GBIS vehId. 첫 차량 번호가 없으면 KakaoDataError("unknown_vehicle").
    반환: {"info": GBIS 형식 dict, "raw": 카카오 원래 값 일부}
    """
    if not isinstance(data, dict) or not isinstance(data.get("lines"), list):
        raise KakaoDataError("invalid_response")
    lines = [line for line in data["lines"] if isinstance(line, dict)]
    candidates = [line for line in lines if line.get("id") == line_id]
    if not candidates:
        raise KakaoDataError("line_missing")
    exact = [line for line in candidates
             if isinstance(line.get("arrival"), dict) and _seconds(line["arrival"].get("order")) == sta_order]
    if len(exact) != 1:
        # 다른 방향(순번)의 차량을 대상 차량으로 잘못 고르지 않는다
        raise KakaoDataError("direction_mismatch" if not exact else "duplicate_direction")
    line, arrival = exact[0], exact[0]["arrival"]

    state = line.get("realtimeState")
    if line.get("realTime") is not True or state not in REALTIME_STATES:
        raise KakaoDataError("not_realtime")
    if arrival.get("collectStatus") != "NORMAL":
        raise KakaoDataError("collect_status")

    raw = {
        "stop_id": data.get("id"), "line_id": line_id, "line_name": line.get("name"),
        "realtime_state": state, "order": sta_order,
        "vehicle_state": arrival.get("vehicleState"), "vehicle_state2": arrival.get("vehicleState2"),
        "plate_no": arrival.get("vehicleNumber") or "", "plate_no2": arrival.get("vehicleNumber2") or "",
        "arrival_sec": arrival.get("arrivalTime"), "arrival_sec2": arrival.get("arrivalTime2"),
        "stop_count": arrival.get("busStopCount"), "stop_count2": arrival.get("busStopCount2"),
        "last_vehicle": arrival.get("lastVehicle"),
    }
    info = _empty()
    first = _vehicle(arrival, "", plate_vid)
    if first is None:
        # 퇴근 시간대 정류장 전체(29개 노선)가 비어 있으면 카카오 쪽 수집 장애로 본다
        if not any(isinstance(l.get("arrival"), dict) and _has_vehicle(l["arrival"]) for l in lines):
            raise KakaoDataError("all_lines_empty")
        return {"info": info, "raw": raw}
    if first["veh_id"] is None:
        raise KakaoDataError("unknown_vehicle")
    info.update(first)
    try:
        second = _vehicle(arrival, "2", plate_vid) if arrival.get("collectStatus2", "NORMAL") == "NORMAL" else None
    except KakaoDataError:
        second = None  # 후속 차량 값이 이상해도 첫 차량은 쓴다
    if second is not None:
        info.update(next_veh_id=second["veh_id"], next_plate_no=second["plate_no"],
                    next_predict_sec=second["predict_sec"])
    return {"info": info, "raw": raw}


def fetch_stop(stop_id=STOP_ID, *, diagnostics=None, timeout=TIMEOUT_SEC):
    """정류장 JSON 1회 조회. 실패 시 None 과 diagnostics(kind, http_status)."""
    detail = diagnostics if diagnostics is not None else {}
    detail.clear()

    def failed(kind, **codes):
        detail.update(kind=kind, **codes)
        logging.warning("카카오 정류장 조회 실패 stop=%s detail=%s", stop_id, json.dumps(detail))
        return None

    try:
        response = httpx.get(STOP_URL, params={"busstopid": stop_id},
                             headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                             timeout=timeout)
        if not response.is_success:
            return failed("http_error", http_status=response.status_code)
        try:
            return response.json()
        except ValueError:
            return failed("invalid_response")
    except httpx.TimeoutException as exc:
        phase = "connect" if isinstance(exc, httpx.ConnectTimeout) else "read" if isinstance(exc, httpx.ReadTimeout) else "other"
        return failed("timeout", phase=phase)
    except httpx.RequestError:
        return failed("connection_error")
    except Exception:
        return failed("unexpected_error")


def fetch_info(plate_vid, stop_id=STOP_ID, line_id=LINE_ID, sta_order=STA_ORDER, *,
               diagnostics=None, timeout=TIMEOUT_SEC):
    """조회 + 정규화. 실패(None)와 차량 없음({"info": 빈 차량, ...})을 구분한다."""
    detail = diagnostics if diagnostics is not None else {}
    data = fetch_stop(stop_id, diagnostics=detail, timeout=timeout)
    if data is None:
        return None
    try:
        return parse_stop(data, plate_vid, line_id, sta_order)
    except KakaoDataError as exc:
        detail.update(kind=exc.kind)
        logging.warning("카카오 정류장 응답 사용 불가 stop=%s detail=%s", stop_id, json.dumps(detail))
        return None


def learn_plates(plate_vid, info):
    """GBIS 정상 응답(fetch_arrival/fetch_station_list 의 info)에서 차량번호 → vehId 를 갱신한다."""
    for vid_key, plate_key in (("veh_id", "plate_no"), ("next_veh_id", "next_plate_no")):
        vid, plate = info.get(vid_key), (info.get(plate_key) or "").strip()
        if vid and plate:
            plate_vid[plate] = int(vid)
    return plate_vid


def load_plate_map(predict_log_path):
    """predict_log.csv 의 GBIS(공식·GBIS 웹) 관측으로 차량번호 → vehId 를 만든다 (나중 관측이 우선)."""
    mapping = {}
    if not os.path.exists(predict_log_path):
        return mapping
    with open(predict_log_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if (row.get("source") or "gbis") not in VEHICLE_ID_SOURCES:
                continue
            vid, plate = (row.get("vehId") or "").strip(), (row.get("plateNo") or "").strip()
            if vid.isdigit() and int(vid) and plate:
                mapping[plate] = int(vid)
    return mapping


def main(argv=None):
    p = argparse.ArgumentParser(description="카카오맵 정류장 응답을 GBIS 형식으로 1회 조회해 출력")
    p.add_argument("--stop-id", default=STOP_ID)
    p.add_argument("--line-id", default=LINE_ID)
    p.add_argument("--sta-order", type=int, default=STA_ORDER)
    p.add_argument("--predict-log", default="bus-arrival/predict_log.csv")
    args = p.parse_args(argv)
    logging.basicConfig(level="INFO", format="%(asctime)s [%(levelname)s] %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    detail = {}
    result = fetch_info(load_plate_map(args.predict_log), args.stop_id, args.line_id, args.sta_order,
                        diagnostics=detail)
    print(json.dumps(result if result is not None else {"error": detail}, ensure_ascii=False, indent=2))
    return 0 if result is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
