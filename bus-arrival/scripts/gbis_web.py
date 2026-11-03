#!/usr/bin/env python3
"""GBIS 웹 노선 실시간 위치 수집 (관측 전용).

https://www.gbis.go.kr/gbis2014/schBus.action?mapTabCd=1 의 노선 화면이 쓰는
schBusAPI.action?cmd=searchRouteJson 응답에서 노선의 **모든 운행 차량**이 어느 정류장 구간
(fromStationId → toStationId)에 있는지 읽는다.

- 공공데이터포털 인증키와 일일 호출 한도를 쓰지 않는다. 공개 API가 아니라 웹 화면용 응답이므로
  형식이 예고 없이 바뀔 수 있다. 형식이 다르면 실패로 처리하고 기본 수집에는 영향을 주지 않는다.
- 차량의 출발 정류장 순번이 직전 조회 < 대상 순번 <= 이번 조회 이면 그 사이에 대상 정류장에
  도달한 것이다. (lower_ts, upper_ts] 구간을 통과 이벤트로 기록한다.
- 3100 알림·안전 모델에는 아직 사용하지 않는다. 오류 상세에는 URL/응답 원문을 넣지 않는다.
"""
import datetime as dt
import json
import logging

import httpx

URL = "https://www.gbis.go.kr/gbis2014/schBusAPI.action"
REFERER = "https://www.gbis.go.kr/gbis2014/schBus.action?mapTabCd=1"
USER_AGENT = "Mozilla/5.0 (compatible; bus-arrival-log/1.0)"
HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": REFERER,
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*",
}
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
# 정류장 단위 위치가 이만큼 되돌아가면 새 운행(회차)으로 본다. 그보다 작으면 일시적 흔들림으로 무시한다.
NEW_TRIP_DROP = 4


def _int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    text = str(value).strip() if value is not None else ""
    return int(text) if text.lstrip("-").isdigit() else None


def _first(value):
    """GBIS 는 일부 필드를 길이 1 배열로 준다 (busPosition, busDirList, busXList ...)."""
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _text(value):
    value = _first(value)
    return str(value).strip() if value is not None else ""


def parse_route_positions(payload):
    """searchRouteJson 응답을 정규화한다. 형식이 맞지 않으면 ValueError."""
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise ValueError("unsuccessful response")
    result = payload.get("result")
    if not isinstance(result, dict):
        raise ValueError("result missing")

    orders, ambiguous = {}, set()
    for item in result.get("estimateTime") or []:
        station_id, order = _int(item.get("stationId")), _int(item.get("staOrder"))
        if station_id is None or order is None:
            raise ValueError("station order missing")
        if station_id in orders and orders[station_id] != order:
            ambiguous.add(station_id)  # 순환 노선에서 같은 정류장을 두 번 지나는 경우
        orders[station_id] = order
    for station_id in ambiguous:
        orders[station_id] = None
    if not orders:
        raise ValueError("route stations missing")

    realtime = result.get("realTime")
    if not isinstance(realtime, dict) or not isinstance(realtime.get("list", []), list):
        raise ValueError("realTime missing")
    vehicles = []
    for item in realtime.get("list") or []:
        veh_id = _int(item.get("vehId"))
        if veh_id is None:
            raise ValueError("vehId missing")
        from_id, to_id = _int(item.get("fromStationId")), _int(item.get("toStationId"))
        vehicles.append({
            "veh_id": veh_id,
            "plate_no": _text(item.get("busNo")),
            "dir": _text(item.get("busDirList")),
            "from_station_id": from_id,
            "from_order": orders.get(from_id),
            "to_station_id": to_id,
            "to_order": orders.get(to_id),
            # 1: from 정류장에 정차 중, 2: from → to 구간 이동 중 (2026-11-03 실측 확인)
            "bus_position": _text(item.get("busPosition")),
            "x": _int(_first(item.get("busXList"))),
            "y": _int(_first(item.get("busYList"))),
            "seat": _int(item.get("seat")),
            "density": _int(item.get("density")),
        })
    return {
        "vehicles": vehicles,
        "orders": orders,
        "waiting_count": len(realtime.get("vehicleList") or []),
    }


def fetch_route_positions(route_id, *, diagnostics=None):
    """노선 실시간 위치 1회 조회. 실패면 None, 운행 차량 없음은 빈 vehicles."""
    detail = diagnostics if diagnostics is not None else {}
    detail.clear()

    def failed(kind, **codes):
        detail.update(kind=kind, **codes)
        logging.warning("GBIS 웹 노선 위치 조회 실패 route=%s detail=%s", route_id, json.dumps(detail))
        return None

    try:
        response = httpx.post(URL, data={"cmd": "searchRouteJson", "routeId": str(route_id)},
                              headers=HEADERS, timeout=TIMEOUT)
        if not response.is_success:
            return failed("http_error", http_status=response.status_code)
        try:
            payload = response.json()
        except ValueError:
            return failed("invalid_response")
        try:
            return parse_route_positions(payload)
        except (ValueError, TypeError, AttributeError):
            return failed("invalid_schema")
    except httpx.TimeoutException as exc:
        phase = "connect" if isinstance(exc, httpx.ConnectTimeout) else "read" if isinstance(exc, httpx.ReadTimeout) else "other"
        return failed("timeout", phase=phase)
    except httpx.RequestError:
        return failed("connection_error")
    except Exception:
        return failed("unexpected_error")


def position_rows(ts_iso, route_id, vehicles):
    """조회 시각별 차량 위치 원시 기록 (route_position_log.csv)."""
    for v in vehicles:
        yield {
            "ts_kst": ts_iso, "route_id": route_id, "veh_id": v["veh_id"], "dir": v["dir"],
            "from_station_id": v["from_station_id"] or "", "from_order": v["from_order"] or "",
            "to_station_id": v["to_station_id"] or "", "to_order": v["to_order"] or "",
            "bus_position": v["bus_position"],
            "x": "" if v["x"] is None else v["x"], "y": "" if v["y"] is None else v["y"],
            "seat": "" if v["seat"] is None else v["seat"],
            "density": "" if v["density"] is None else v["density"],
        }


def _ts(value):
    try:
        return dt.datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def detect_passes(previous, vehicles, ts, targets, *, route_id, max_gap_sec):
    """직전 위치와 비교해 대상 정류장 도달 이벤트를 만든다.

    previous: {veh_id(str): {"order", "bus_position", "ts"}} (tracker_state 에 저장)
    targets: {station_id: sta_order}
    반환: (이벤트 목록, 다음 previous)
    """
    events, current = [], {}
    ts_iso = ts.isoformat()
    for v in vehicles:
        order = v["from_order"]
        if order is None:
            continue
        key = str(v["veh_id"])
        prev = previous.get(key)
        prev_ts = _ts(prev.get("ts")) if prev else None
        gap = (ts - prev_ts).total_seconds() if prev_ts else None
        if prev and gap is not None and 0 < gap <= max_gap_sec and order < prev["order"] < order + NEW_TRIP_DROP:
            current[key] = prev  # 위치가 잠깐 뒤로 흔들림: 같은 정류장 도달을 두 번 세지 않는다
            continue
        current[key] = {"order": order, "bus_position": v["bus_position"], "ts": ts_iso}
        if not prev or gap is None or not 0 < gap <= max_gap_sec or order < prev["order"]:
            continue
        for station_id, target in targets.items():
            if target is not None and prev["order"] < target <= order:
                events.append({
                    "ts_kst": ts_iso, "route_id": route_id, "veh_id": v["veh_id"],
                    "plate_no": v["plate_no"], "dir": v["dir"],
                    "station_id": station_id, "sta_order": target,
                    "lower_ts": prev["ts"], "upper_ts": ts_iso, "gap_sec": int(gap),
                    "prev_from_order": prev["order"], "prev_bus_position": prev.get("bus_position", ""),
                    "cur_from_order": order, "cur_bus_position": v["bus_position"],
                    "evidence": "gbis_web_route_position",
                })
    # 이번 응답에서 빠진 차량은 잠시 기억한다 (일시 누락 뒤 다시 나타나면 넓은 구간으로 기록)
    for key, prev in previous.items():
        prev_ts = _ts(prev.get("ts"))
        if key not in current and prev_ts and 0 <= (ts - prev_ts).total_seconds() <= max_gap_sec:
            current[key] = prev
    return events, current


# ---- 정류장 도착 정보 (교대 조회 출처 "gbis_web") ----
# 같은 화면이 정류장을 열 때 쓰는 cmd=searchBusStationJson 응답. 공식 API와 같은 GBIS vehId 를 주지만
# 예측은 분 단위(predictTime1)만 있고 stateCd 가 없다. predict_sec 는 분 × 60 으로 둔다.


class StationDataError(ValueError):
    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


def _station_empty():
    """scrape.no_bus_info() 와 같은 키."""
    return {
        "veh_id": None, "plate_no": "", "predict_min": None, "predict_sec": None,
        "location_no": None, "remain_seat": None, "state_cd": None, "flag": "",
        "station_nm": "", "next_veh_id": None, "next_plate_no": "",
        "next_predict_min": None, "next_predict_sec": None, "next_remain_seat": None,
    }


def parse_station_arrivals(payload, route_id, sta_order):
    """searchBusStationJson 응답에서 대상 노선·방향을 공식 항목 조회와 같은 형태로 정규화한다."""
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise StationDataError("unsuccessful_response")
    result = payload.get("result")
    items = result.get("busArrivalInfo") if isinstance(result, dict) else None
    if not isinstance(items, list):
        raise StationDataError("invalid_schema")
    items = [item for item in items if isinstance(item, dict)]
    candidates = [item for item in items if _int(item.get("routeId")) == route_id]
    if not candidates:
        raise StationDataError("route_missing")
    exact = [item for item in candidates if _int(item.get("staOrder")) == sta_order]
    if len(exact) != 1:
        raise StationDataError("direction_mismatch" if not exact else "duplicate_direction")
    item = exact[0]
    info = _station_empty()
    info.update(flag=_text(item.get("flag")))
    veh_id = _int(item.get("vehId1"))
    if veh_id is None:
        # 퇴근 시간대 정류장 전체가 비어 있으면 GBIS 웹 쪽 장애로 본다 (버스 없음과 구분)
        if not any(_int(other.get("vehId1")) for other in items):
            raise StationDataError("all_routes_empty")
        return info
    minutes = _int(item.get("predictTime1"))
    if minutes is None or minutes < 0:
        raise StationDataError("invalid_vehicle")
    info.update(
        veh_id=veh_id, plate_no=_text(item.get("plateNo1")),
        predict_min=minutes, predict_sec=minutes * 60,
        location_no=_int(item.get("locationNo1")), remain_seat=_int(item.get("remainSeatCnt1")),
        station_nm=_text(item.get("stationNm1")),
    )
    next_id, next_minutes = _int(item.get("vehId2")), _int(item.get("predictTime2"))
    if next_id and next_minutes is not None and next_minutes >= 0:
        info.update(next_veh_id=next_id, next_plate_no=_text(item.get("plateNo2")),
                    next_predict_min=next_minutes, next_predict_sec=next_minutes * 60,
                    next_remain_seat=_int(item.get("remainSeatCnt2")))
    return info


def fetch_station_info(station_id, route_id, sta_order, *, diagnostics=None):
    """정류장 도착 정보 1회 조회. 실패(None)와 차량 없음(빈 차량 dict)을 구분한다."""
    detail = diagnostics if diagnostics is not None else {}
    detail.clear()

    def failed(kind, **codes):
        detail.update(kind=kind, **codes)
        logging.warning("GBIS 웹 정류장 조회 실패 station=%s detail=%s", station_id, json.dumps(detail))
        return None

    try:
        response = httpx.post(URL, data={"cmd": "searchBusStationJson", "stationId": str(station_id)},
                              headers=HEADERS, timeout=TIMEOUT)
        if not response.is_success:
            return failed("http_error", http_status=response.status_code)
        try:
            payload = response.json()
        except ValueError:
            return failed("invalid_response")
        try:
            return parse_station_arrivals(payload, route_id, sta_order)
        except StationDataError as exc:
            return failed(exc.kind)
        except (TypeError, AttributeError):
            return failed("invalid_schema")
    except httpx.TimeoutException as exc:
        phase = "connect" if isinstance(exc, httpx.ConnectTimeout) else "read" if isinstance(exc, httpx.ReadTimeout) else "other"
        return failed("timeout", phase=phase)
    except httpx.RequestError:
        return failed("connection_error")
    except Exception:
        return failed("unexpected_error")
