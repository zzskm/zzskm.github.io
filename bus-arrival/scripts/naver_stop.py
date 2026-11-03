#!/usr/bin/env python3
"""네이버 지도 정류장 도착 정보 — 교대 조회 출처 "naver".

https://map.naver.com/p/api/pubtrans/realtime/bus/arrivals?stopId=163603&base=realtime,schedule
(유라코퍼레이션.SK케미칼 07511, 3100번 노선 id 11001069)

- 공개 API가 아니라 네이버 지도 웹이 내부에서 쓰는 주소다. 예고 없이 바뀌거나 막힐 수 있다.
- 노선 위치 응답의 출처는 GBIS(경기도 버스종합상황실)이지만 남은 시간은 네이버가 따로 계산한다.
  2026-11-03 같은 차량(경기70아7046)에서 GBIS 공식은 20:35~20:37 327초에 멈춰 있었고 네이버는
  20:37:32 207초, 20:38:04 166초였다. 같은 시각이라도 공식 값과 다를 수 있다.
- GBIS vehId 가 없고 차량번호만 있다. 차량번호를 GBIS 에서 관측한 vehId 로 바꾸며, 모르는 번호가
  첫 차량이면 실패로 돌려준다 (vehId 없는 차량을 '버스 없음'으로 넘기면 추적이 잘못 종료된다).
- 실시간 차량이 없으면 네이버는 시간표 기반 예정(status SCHEDULE, 차량번호 없음)을 준다. 정류장의
  다른 노선에 실시간 차량이 있을 때만 '버스 없음'으로 보고, 전부 없으면 실패로 본다.
- stateCd, flag 에 해당하는 값이 없어 None/빈 값으로 둔다.

fetch_info() 는 kakao_stop.fetch_info() 와 같이 실패(None)와 차량 없음을 구분하고, 오류 상세에는
URL·응답 원문·예외 메시지를 기록하지 않는다.
"""
import argparse
import json
import logging

import httpx

from kakao_stop import load_plate_map

ARRIVALS_URL = "https://map.naver.com/p/api/pubtrans/realtime/bus/arrivals"
REFERER = "https://map.naver.com/"
USER_AGENT = "Mozilla/5.0 (compatible; bus-arrival-log/1.0)"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)

# 유라코퍼레이션.SK케미칼(07511) 정류장과 3100번(판교역 방향, 다음 정류장 211995)
STOP_ID = 163603
ROUTE_ID = 11001069
NEXT_STOP_ID = 211995


class NaverDataError(ValueError):
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


def _count(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and value.isascii() and value.isdigit():
        return int(value)
    return None


def _realtime_buses(arrival):
    """차량번호가 있는 실시간 차량만 (시간표 예정은 차량번호가 없다)."""
    buses = arrival.get("buses") if isinstance(arrival, dict) else None
    return [b for b in buses or [] if isinstance(b, dict) and str(b.get("plateNo") or "").strip()]


def parse_arrivals(data, plate_vid, route_id=ROUTE_ID, next_stop_id=NEXT_STOP_ID):
    """정류장 응답에서 대상 노선을 GBIS 항목 조회(fetch_arrival)와 같은 형태로 정규화한다."""
    if not isinstance(data, list):
        raise NaverDataError("invalid_response")
    entries = [e for e in data if isinstance(e, dict)]
    candidates = [e for e in entries if e.get("id") == route_id]
    if not candidates:
        raise NaverDataError("route_missing")
    if len(candidates) > 1:
        raise NaverDataError("duplicate_direction")
    entry = candidates[0]
    if next_stop_id is not None and entry.get("directionStopId") != next_stop_id:
        # 다른 방향(반대편 정류장)의 차량을 대상 차량으로 잘못 고르지 않는다
        raise NaverDataError("direction_mismatch")
    arrival = entry.get("arrival")
    if not isinstance(arrival, dict):
        raise NaverDataError("invalid_response")

    raw = {"status": arrival.get("status"), "reference_time": arrival.get("referenceTime")}
    info = _empty()
    buses = _realtime_buses(arrival)
    if not buses:
        # 정류장 전 노선에 실시간 차량이 없으면 네이버 쪽 수집 장애로 본다
        if not any(_realtime_buses(e.get("arrival")) for e in entries):
            raise NaverDataError("no_realtime")
        return {"info": info, "raw": raw}

    vehicles = []
    for rank, bus in enumerate(buses[:2]):
        plate = str(bus["plateNo"]).strip()
        predict, stops = _count(bus.get("remainingTime")), _count(bus.get("remainingStop"))
        if predict is None or stops is None:
            if rank:
                break  # 후속 차량 값이 이상해도 첫 차량은 쓴다
            raise NaverDataError("invalid_vehicle")
        vehicles.append({"plate_no": plate, "veh_id": plate_vid.get(plate), "predict_sec": predict,
                         "location_no": stops, "remain_seat": _count(bus.get("remainingSeat"))})
    first = vehicles[0]
    if first["veh_id"] is None:
        raise NaverDataError("unknown_vehicle")
    info.update(first)
    if len(vehicles) > 1:
        second = vehicles[1]
        info.update(next_veh_id=second["veh_id"], next_plate_no=second["plate_no"],
                    next_predict_sec=second["predict_sec"], next_remain_seat=second["remain_seat"])
    return {"info": info, "raw": raw}


def fetch_arrivals(stop_id=STOP_ID, *, diagnostics=None, timeout=TIMEOUT):
    """정류장 도착 JSON 1회 조회. 실패 시 None 과 diagnostics(kind, http_status)."""
    detail = diagnostics if diagnostics is not None else {}
    detail.clear()

    def failed(kind, **codes):
        detail.update(kind=kind, **codes)
        logging.warning("네이버 정류장 조회 실패 stop=%s detail=%s", stop_id, json.dumps(detail))
        return None

    try:
        response = httpx.get(ARRIVALS_URL, params={"stopId": str(stop_id), "base": "realtime,schedule"},
                             headers={"User-Agent": USER_AGENT, "Referer": REFERER,
                                      "Accept": "application/json"},
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


def fetch_info(plate_vid, stop_id=STOP_ID, route_id=ROUTE_ID, next_stop_id=NEXT_STOP_ID, *,
               diagnostics=None, timeout=TIMEOUT):
    """조회 + 정규화. 실패(None)와 차량 없음({"info": 빈 차량, ...})을 구분한다."""
    detail = diagnostics if diagnostics is not None else {}
    data = fetch_arrivals(stop_id, diagnostics=detail, timeout=timeout)
    if data is None:
        return None
    try:
        return parse_arrivals(data, plate_vid, route_id, next_stop_id)
    except NaverDataError as exc:
        detail.update(kind=exc.kind)
        logging.warning("네이버 정류장 응답 사용 불가 stop=%s detail=%s", stop_id, json.dumps(detail))
        return None


def main(argv=None):
    p = argparse.ArgumentParser(description="네이버 지도 정류장 응답을 GBIS 형식으로 1회 조회해 출력")
    p.add_argument("--stop-id", type=int, default=STOP_ID)
    p.add_argument("--route-id", type=int, default=ROUTE_ID)
    p.add_argument("--predict-log", default="bus-arrival/predict_log.csv")
    args = p.parse_args(argv)
    logging.basicConfig(level="INFO", format="%(asctime)s [%(levelname)s] %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    detail = {}
    result = fetch_info(load_plate_map(args.predict_log), args.stop_id, args.route_id, diagnostics=detail)
    print(json.dumps(result if result is not None else {"error": detail}, ensure_ascii=False, indent=2))
    return 0 if result is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
