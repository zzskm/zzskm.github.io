#!/usr/bin/env python3
"""GBIS 07511 정류소 목록 수집. 기존 3100번 알림과 독립적으로 노선 신호를 기록한다.

getBusArrivalListv2:
https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusArrivalStation
"""
import json
import logging
import xml.etree.ElementTree as ET

import httpx

BASE = "https://apis.data.go.kr/6410000/busarrivalservice/v2"
USER_AGENT = "Mozilla/5.0 (compatible; bus-arrival-log/1.0)"


def _text(node, tag):
    found = node.find(tag)
    return (found.text or "").strip() if found is not None else ""


def _number(node, tag):
    value = _text(node, tag)
    return int(value) if value.lstrip("-").isdigit() else None


def _empty():
    return {
        "veh_id": None, "plate_no": "", "predict_min": None, "predict_sec": None,
        "location_no": None, "remain_seat": None, "state_cd": None, "flag": "",
        "station_nm": "", "next_veh_id": None, "next_plate_no": "",
        "next_predict_min": None, "next_predict_sec": None, "next_remain_seat": None,
    }


def parse_station_list(root, target_route_id, target_order):
    """목록 응답을 정규화한다. 대상과 다른 방향의 차량을 잘못 선택하지 않는다."""
    rows = []
    for node in root.findall(".//busArrivalList"):
        route_id = _number(node, "routeId")
        if route_id is None:
            raise ValueError("busArrivalList missing routeId")
        rows.append({
            "route_id": route_id,
            "route_name": _text(node, "routeName"),
            "sta_order": _number(node, "staOrder"),
            "veh_id": _number(node, "vehId1"),
            "plate_no": _text(node, "plateNo1"),
            "predict_min": _number(node, "predictTime1"),
            "predict_sec": _number(node, "predictTimeSec1"),
            "location_no": _number(node, "locationNo1"),
            "remain_seat": _number(node, "remainSeatCnt1"),
            "state_cd": _number(node, "stateCd1"),
            "flag": _text(node, "flag"),
            "station_nm": _text(node, "stationNm1"),
            "next_veh_id": _number(node, "vehId2"),
            "next_plate_no": _text(node, "plateNo2"),
            "next_predict_min": _number(node, "predictTime2"),
            "next_predict_sec": _number(node, "predictTimeSec2"),
            "next_remain_seat": _number(node, "remainSeatCnt2"),
        })
    candidates = [r for r in rows if r["route_id"] == target_route_id]
    exact = [r for r in candidates if r["sta_order"] == target_order]
    if len(exact) == 1:
        chosen = exact[0]
    elif len(exact) > 1:
        raise ValueError("duplicate target direction")
    elif len(candidates) == 1 and candidates[0]["sta_order"] is None:
        chosen = candidates[0]
    elif any(r["sta_order"] is None for r in candidates):
        raise ValueError("ambiguous target direction")
    else:
        chosen = _empty()
    return {"info": chosen, "routes": rows}


def fetch_station_list(service_key, station_id, target_route_id, target_order, *, diagnostics=None):
    """정류장 전체를 한 번 조회. 실패(None)와 차량 없음(dict)을 구분한다.

    오류 상세에는 인증키, URL, 응답 원문을 절대 기록하지 않는다.
    """
    detail = diagnostics if diagnostics is not None else {}
    detail.clear()

    def failed(kind, **codes):
        detail.update(kind=kind, **codes)
        logging.warning("정류소 목록 API 오류 station=%s detail=%s", station_id, json.dumps(detail))
        return None

    try:
        response = httpx.get(
            BASE + "/getBusArrivalListv2",
            params={"serviceKey": service_key, "stationId": str(station_id), "format": "xml"},
            headers={"User-Agent": USER_AGENT}, timeout=15,
        )
        try:
            root = ET.fromstring(response.text)
        except ET.ParseError:
            response.raise_for_status()
            return failed("invalid_response")
        codes = {}
        for key, tag in (("result_code", "resultCode"), ("gateway_code", "returnReasonCode")):
            value = _text(root, ".//" + tag)
            if value.isascii() and value.isdigit() and len(value) <= 3:
                codes[key] = value
        if not response.is_success:
            return failed("http_error", http_status=response.status_code, **codes)
        if "gateway_code" in codes:
            return failed("gateway_error", **codes)
        result_code = _text(root, ".//resultCode")
        if result_code == "4":
            return {"info": _empty(), "routes": []}
        if result_code != "0":
            return failed("api_response_error", **codes)
        if root.find(".//msgBody") is None:
            return failed("invalid_response")
        try:
            return parse_station_list(root, target_route_id, target_order)
        except ValueError:
            return failed("invalid_list_schema")
    except httpx.TimeoutException as exc:
        phase = "connect" if isinstance(exc, httpx.ConnectTimeout) else "read" if isinstance(exc, httpx.ReadTimeout) else "other"
        return failed("timeout", phase=phase)
    except httpx.HTTPStatusError as exc:
        return failed("http_error", http_status=exc.response.status_code)
    except httpx.RequestError:
        return failed("connection_error")
    except Exception:
        return failed("unexpected_error")


def signal_rows(ts_iso, station_id, routes):
    """노선 자동 발굴용 원시 ETA 관측. 실제 통과 시각이라고 해석하면 안 된다."""
    for route in routes:
        for rank, prefix in ((1, ""), (2, "next_")):
            veh_id = route.get(prefix + "veh_id")
            if not veh_id:
                continue
            yield {
                "ts_kst": ts_iso, "station_id": station_id,
                "route_id": route["route_id"], "route_name": route["route_name"],
                "sta_order": route["sta_order"], "vehicle_rank": rank,
                "veh_id": veh_id, "plate_no": route.get(prefix + "plate_no") or "",
                "predict_sec": route.get(prefix + "predict_sec"),
                "location_no": route.get("location_no") if rank == 1 else "",
                "state_cd": route.get("state_cd") if rank == 1 else "",
                "flag": route.get("flag") or "",
            }
