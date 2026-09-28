#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GBIS 버스 도착 로그 수집기 — 유라코퍼레이션.SK케미칼(07511) × 3100번

공공데이터포털 '경기도_버스도착정보 조회' (busarrivalservice/v2/getBusArrivalItemv2)
- 유라코퍼레이션 + 성남시청전면 동시 조회
- 평일 퇴근 시간대(기본 KST 16:00~22:00)에만 수집
- 차량 ID 매칭으로 도착 판정 (다른 차량으로 교체 / 후속 차량 없이 사라짐 모두 감지)
- 실행 간 상태 저장 (tracker_state.json) — 짧은 수집 구간을 이어 붙여도 추적이 끊기지 않음
- 일일 호출 상한 관리

이탈 사유 (arrival_log.csv):
  observed_arrival  — stateCd=1 또는 마지막 예측 60초 이하 (실제 도착 확인)
  estimated_arrival — 마지막 예측 90초 이하 (도착 추정)
  vehicle_changed   — 다른 차량으로 교체 (마지막 예측이 멀었음)
  vanished          — 후속 차량 없이 사라짐 (마지막 예측이 멀었음)
  data_gap          — API 연속 2회 이상 실패 후 차량 변경
  service_end       — flag=STOP 확인
  stale             — 수집 공백(20분 초과)으로 추적 중단
est_arrival_ts 는 min(판정 시각, 마지막 관측 시각 + 마지막 예측초) 로 추정한다.
"""

import argparse
import csv
import datetime as dt
import json
import logging
import os
import time
import xml.etree.ElementTree as ET

import httpx


KST = dt.timezone(dt.timedelta(hours=9))

# 유라코퍼레이션.SK케미칼 (정류소번호 7511)
STATION_ID = 206000565
# 성남시청전면 (ARS/모바일 정류소번호 06004)
SECONDARY_MOBILE_NO = "06004"

TARGET_ROUTE_ID = 204000170
STA_ORDER = 6
STA_ORDER_SECONDARY = 12

# 수집 시간대 (KST, 평일). 퇴근 시간대 기준.
COLLECT_WINDOW = "16:00-22:00"

ARRIVAL_BASE = "https://apis.data.go.kr/6410000/busarrivalservice/v2"
USER_AGENT = "Mozilla/5.0 (compatible; bus-arrival-log/1.0)"
STATE_MAX_AGE_SECONDS = 20 * 60
# 추적 중이던 차량이 사라졌을 때: 마지막 예측이 이 이하면 즉시 도착으로 확정,
# 아니면 일시적 누락일 수 있으므로 연속 VANISH_CONFIRM_POLLS 회 안 보이면 확정한다.
NEAR_ARRIVAL_SEC = 180
VANISH_CONFIRM_POLLS = 2
# GBIS resultCode 4: 결과 없음 (운행 차량 없음)
RESULT_NO_DATA = "4"

HOLIDAYS_2026 = {
    "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18",
    "2026-03-01", "2026-05-05", "2026-06-06",
    "2026-08-15", "2026-10-05", "2026-10-06", "2026-10-07",
    "2026-10-09", "2026-12-25",
}

TRACK_DEFAULTS = {
    "cur_vid": None,
    "cur_plate": "",
    "first_seen": None,
    "last_seen": None,
    "min_predict": 99999,
    "max_predict": -1,
    "samples": 0,
    "last_predict": None,
    "last_state_cd": None,
    "miss_count": 0,
}


def kst_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).astimezone(KST).replace(microsecond=0)


def kst_iso() -> str:
    return kst_now().isoformat()


def get_service_key() -> str:
    key = os.getenv("BUS_SERVICE_KEY") or os.getenv("SERVICE_KEY")
    if not key:
        raise RuntimeError("BUS_SERVICE_KEY 환경변수가 없습니다.")
    return key


def xml_text(node, tag: str, default: str = "") -> str:
    el = node.find(tag)
    if el is None:
        return default
    txt = el.text.strip() if el.text else ""
    return txt if txt else default


def no_bus_info(flag: str = "") -> dict:
    return {
        "veh_id": None, "plate_no": "", "predict_min": None, "predict_sec": None,
        "location_no": None, "remain_seat": None, "state_cd": None, "flag": flag,
        "station_nm": "", "next_veh_id": None, "next_plate_no": "",
        "next_predict_min": None, "next_predict_sec": None, "next_remain_seat": None,
    }


def fetch_arrival(service_key: str, station_id: int, route_id: int, sta_order: int) -> dict | None:
    params = {
        "serviceKey": service_key,
        "stationId": str(station_id),
        "routeId": str(route_id),
        "staOrder": str(sta_order),
        "format": "xml",
    }
    try:
        r = httpx.get(f"{ARRIVAL_BASE}/getBusArrivalItemv2",
                      params=params, headers={"User-Agent": USER_AGENT}, timeout=15)
        r.raise_for_status()
        root = ET.fromstring(r.text)
        code = xml_text(root, ".//resultCode")
        if code == RESULT_NO_DATA:
            return no_bus_info()
        if code != "0":
            # data.go.kr 게이트웨이 오류는 resultCode 대신 returnReasonCode 로 온다 (예: 22 호출 한도 초과)
            logging.warning("API 오류 station=%d resultCode=%s msg=%s reason=%s",
                            station_id, code or "-",
                            xml_text(root, ".//resultMessage", "-"),
                            xml_text(root, ".//returnAuthMsg", xml_text(root, ".//returnReasonCode", "-")))
            return None
        n = root.find(".//busArrivalItem")
        if n is None:
            return no_bus_info()

        def ti(tag: str):
            v = xml_text(n, tag)
            return int(v) if v.lstrip("-").isdigit() else None

        return {
            "veh_id": ti("vehId1"),
            "plate_no": xml_text(n, "plateNo1"),
            "predict_min": ti("predictTime1"),
            "predict_sec": ti("predictTimeSec1"),
            "location_no": ti("locationNo1"),
            "remain_seat": ti("remainSeatCnt1"),
            "state_cd": ti("stateCd1"),
            "flag": xml_text(n, "flag"),
            "station_nm": xml_text(n, "stationNm1"),
            "next_veh_id": ti("vehId2"),
            "next_plate_no": xml_text(n, "plateNo2"),
            "next_predict_min": ti("predictTime2"),
            "next_predict_sec": ti("predictTimeSec2"),
            "next_remain_seat": ti("remainSeatCnt2"),
        }
    except Exception as e:
        # 예외 메시지에는 serviceKey 가 담긴 요청 URL 이 포함될 수 있어 종류/상태코드만 남긴다 (공개 로그)
        status = getattr(getattr(e, "response", None), "status_code", None)
        logging.warning("API 실패 station=%d: %s%s", station_id, type(e).__name__,
                        f" HTTP {status}" if status else "")
        return None


def resolve_station_id(service_key: str, route_id: int, mobile_no: str, station_seq: int) -> int | None:
    """노선 경유정류장 목록에서 ARS 번호를 공식 stationId로 변환한다."""
    params = {"serviceKey": service_key, "routeId": str(route_id), "format": "xml"}
    try:
        r = httpx.get(
            "https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteStationListv2",
            params=params, headers={"User-Agent": USER_AGENT}, timeout=15,
        )
        r.raise_for_status()
        root = ET.fromstring(r.text)
        target = mobile_no.lstrip("0") or "0"
        for node in root.findall(".//busRouteStationList"):
            mobile = xml_text(node, "mobileNo").lstrip("0") or "0"
            seq = xml_text(node, "stationSeq")
            if mobile == target and seq == str(station_seq):
                station_id = xml_text(node, "stationId")
                if station_id.isdigit():
                    return int(station_id)
    except Exception as e:
        logging.warning("2차 정류장 stationId 해석 실패: %s", type(e).__name__)
    return None


def append_csv(path: str, row: dict):
    """행을 추가한다. 기존 헤더에 없는 컬럼이 생기면 파일 헤더를 확장해 다시 쓴다."""
    fields = list(row.keys())
    header = []
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, newline="", encoding="utf-8") as f:
            header = next(csv.reader(f), [])
    if header:
        missing = [k for k in fields if k not in header]
        if missing:
            with open(path, newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            header = header + missing
            tmp = path + ".tmp"
            with open(tmp, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=header, restval="")
                w.writeheader()
                w.writerows(rows)
            os.replace(tmp, path)
        fields = header
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, restval="")
        if not header:
            w.writeheader()
        w.writerow(row)


def save_state(path: str, state: dict):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2, default=str)
    os.replace(tmp, path)


def load_state(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def parse_ts(value) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def parse_window(window: str) -> tuple[int, int]:
    """'16:00-22:00' → (시작 초, 종료 초). 종료는 24:00까지 허용."""
    def seconds(part: str) -> int:
        h, m = part.strip().split(":")
        return int(h) * 3600 + int(m) * 60
    start, end = window.split("-")
    return seconds(start), seconds(end)


def in_window(now: dt.datetime, window: str) -> bool:
    start, end = parse_window(window)
    sec = now.hour * 3600 + now.minute * 60 + now.second
    return start <= sec < end


def gate_decision(now: dt.datetime, window: str = COLLECT_WINDOW,
                  daily_calls: int = 0, max_daily_calls: int = 900) -> dict:
    """수집 여부 판정. before_window 이면 wait_seconds 뒤 시작할 수 있다."""
    if now.isoweekday() > 5:
        return {"skip": True, "reason": "weekend", "wait_seconds": 0}
    if now.strftime("%Y-%m-%d") in HOLIDAYS_2026:
        return {"skip": True, "reason": "holiday", "wait_seconds": 0}
    start, end = parse_window(window)
    sec = now.hour * 3600 + now.minute * 60 + now.second
    if sec < start:
        return {"skip": True, "reason": "before_window", "wait_seconds": start - sec}
    if sec >= end:
        return {"skip": True, "reason": "after_window", "wait_seconds": 0}
    if daily_calls >= max_daily_calls:
        return {"skip": True, "reason": "quota", "wait_seconds": 0}
    return {"skip": False, "reason": "ok", "wait_seconds": 0}


def gate_check(args: argparse.Namespace) -> bool:
    """True면 수집을 건너뜀 (주말/공휴일/시간대 밖/호출 상한)."""
    now = kst_now()
    state = load_state(os.path.join(os.path.dirname(args.output_csv), "tracker_state.json"))
    daily_calls = state.get("daily_calls", 0) if state.get("date") == now.strftime("%Y-%m-%d") else 0
    decision = gate_decision(now, args.window, daily_calls, args.max_daily_calls)
    print(f"skip={str(decision['skip']).lower()}")
    print(f"reason={decision['reason']}")
    print(f"wait_seconds={decision['wait_seconds']}")
    return decision["skip"]


def _classify_departure(consec_fail: int, last_flag: str,
                        last_predict: int | None, last_state_cd: int | None,
                        vanished: bool = False) -> str:
    if consec_fail >= 2:
        return "data_gap"
    if last_state_cd == 1 or (last_predict is not None and last_predict <= 60):
        return "observed_arrival"
    if last_predict is not None and last_predict <= 90:
        return "estimated_arrival"
    if last_flag == "STOP":
        return "service_end"
    return "vanished" if vanished else "vehicle_changed"


def arrival_confidence(info: dict, predict: int | None) -> str:
    if info.get("state_cd") == 1:
        return "high"
    if predict is not None and predict <= 60:
        return "medium"
    if predict is not None:
        return "low"
    return "unknown"


def estimate_arrival(state: dict, ts: dt.datetime) -> str:
    last_seen = parse_ts(state.get("last_seen"))
    if last_seen is None or state.get("last_predict") is None:
        return ""
    est = last_seen + dt.timedelta(seconds=state["last_predict"])
    return min(est, ts).isoformat()


def close_track(state: dict, arrival_path: str, ts: dt.datetime, reason: str):
    """추적 중인 차량을 arrival_log 에 기록하고 추적 상태를 비운다."""
    if state.get("cur_vid") is not None and state.get("samples", 0) > 0:
        min_predict = state.get("min_predict", 99999)
        max_predict = state.get("max_predict", -1)
        append_csv(arrival_path, {
            "ts_kst": ts.isoformat(),
            "vehId": state["cur_vid"],
            "plateNo": state.get("cur_plate", ""),
            "first_seen_ts": state.get("first_seen") or "",
            "last_seen_ts": state.get("last_seen") or "",
            "min_predict_sec": min_predict if min_predict < 99999 else "",
            "max_predict_sec": max_predict if max_predict >= 0 else "",
            "samples": state["samples"],
            "departure_reason": reason,
            "last_predict_sec": state.get("last_predict") if state.get("last_predict") is not None else "",
            "est_arrival_ts": estimate_arrival(state, ts),
        })
        logging.info("이탈: vehId=%s plate=%s reason=%s last_predict=%ss",
                     state["cur_vid"], state.get("cur_plate", ""), reason,
                     state.get("last_predict") if state.get("last_predict") is not None else "?")
    state.update(TRACK_DEFAULTS)


def observe(state: dict, info: dict, ts: dt.datetime, arrival_path: str):
    """정상 응답 1건을 추적 상태에 반영한다. (실패 응답은 호출 측에서 처리)"""
    previous_failures = state.get("consec_fail", 0)
    state["consec_fail"] = 0
    state["last_success"] = ts.isoformat()
    vid = info["veh_id"] or None
    predict = info["predict_sec"]
    flag = info["flag"]

    if vid is None:
        # 추적하던 버스가 후속 차량 없이 사라짐: 가까웠으면 즉시, 멀었으면 연속 누락 시 도착으로 확정
        if state.get("cur_vid") is not None:
            state["miss_count"] = state.get("miss_count", 0) + 1
            last_predict = state.get("last_predict")
            near = last_predict is not None and last_predict <= NEAR_ARRIVAL_SEC
            if near or state["miss_count"] >= VANISH_CONFIRM_POLLS or flag == "STOP":
                close_track(state, arrival_path, ts, _classify_departure(
                    previous_failures, flag, last_predict, state.get("last_state_cd"), vanished=True))
        state["last_flag"] = flag
        return

    if vid != state.get("cur_vid"):
        if state.get("cur_vid") is not None:
            close_track(state, arrival_path, ts, _classify_departure(
                previous_failures, flag, state.get("last_predict"), state.get("last_state_cd")))
        state.update({
            "cur_vid": vid,
            "cur_plate": info["plate_no"],
            "first_seen": ts.isoformat(),
            "min_predict": predict if predict is not None else 99999,
            "max_predict": predict if predict is not None else -1,
            "samples": 0,
        })
    elif predict is not None:
        state["min_predict"] = min(state.get("min_predict", 99999), predict)
        state["max_predict"] = max(state.get("max_predict", -1), predict)

    state["last_seen"] = ts.isoformat()
    state["samples"] = state.get("samples", 0) + 1
    state["last_predict"] = predict
    state["last_state_cd"] = info["state_cd"]
    state["miss_count"] = 0
    state["last_flag"] = flag


def run_loop(args: argparse.Namespace):
    service_key = get_service_key()
    route_id = args.route_id or TARGET_ROUTE_ID
    sta_order = args.sta_order
    secondary_station_id = args.secondary_station_id
    sta_order_secondary = args.sta_order_secondary
    if secondary_station_id is None:
        secondary_station_id = resolve_station_id(
            service_key, route_id, args.secondary_mobile_no, sta_order_secondary
        )
    if secondary_station_id is None:
        logging.warning("성남시청전면(%s) stationId를 찾지 못해 2차 조회를 건너뜁니다.",
                        args.secondary_mobile_no)

    base_dir = os.path.dirname(args.output_csv)
    state_path = os.path.join(base_dir, "tracker_state.json")
    predict_path = os.path.join(base_dir, "predict_log.csv")
    arrival_path = args.output_csv
    segment_path = os.path.join(base_dir, "segment_log.csv")
    status_path = args.status_json

    state = load_state(state_path)
    for key, value in TRACK_DEFAULTS.items():
        state.setdefault(key, value)

    now = kst_now()
    today_str = now.strftime("%Y-%m-%d")
    if state.get("date") != today_str:
        state["daily_calls"] = 0
    state["date"] = today_str
    state.setdefault("daily_calls", 0)

    # 수집 공백 뒤: 추적 중이던 차량은 버리지 않고 stale 로 기록한다
    state_reset = False
    last_activity = parse_ts(state.get("last_poll")) or parse_ts(state.get("last_seen"))
    if last_activity and (now - last_activity).total_seconds() > STATE_MAX_AGE_SECONDS:
        close_track(state, arrival_path, now, "stale")
        state["consec_fail"] = 0
        state_reset = True
    state.setdefault("consec_fail", 0)

    logging.info("시작: routeId=%d staOrder=%d (성남시청전면 %s/%d) cur_vid=%s 호출=%d/%d 시간대=%s",
                 route_id, sta_order, secondary_station_id, sta_order_secondary,
                 state["cur_vid"], state["daily_calls"], args.max_daily_calls, args.window)

    # 수집 구간을 이어 붙여 실행해도 조회 간격이 interval 보다 짧아지지 않게 한다
    last_poll = parse_ts(state.get("last_poll"))
    if last_poll:
        gap = (now - last_poll).total_seconds()
        if 0 <= gap < args.interval:
            time.sleep(args.interval - gap)

    deadline = time.monotonic() + args.run_seconds if args.run_seconds else None
    polls = 0
    while True:
        started = time.monotonic()
        ts = kst_now()
        ts_iso = ts.isoformat()

        if not in_window(ts, args.window):
            logging.info("수집 시간대(%s) 밖. 중지.", args.window)
            break
        if state["daily_calls"] >= args.max_daily_calls:
            logging.warning("일일 호출 상한 도달 (%d/%d). 중지.", state["daily_calls"], args.max_daily_calls)
            break

        info = fetch_arrival(service_key, STATION_ID, route_id, sta_order)
        info_secondary = None
        if secondary_station_id is not None:
            info_secondary = fetch_arrival(service_key, secondary_station_id, route_id, sta_order_secondary)
        state["daily_calls"] += 1 + (1 if secondary_station_id is not None else 0)
        state["last_poll"] = ts_iso

        if info is None:
            state["consec_fail"] = state.get("consec_fail", 0) + 1
            status = {
                "error": "api_error",
                "consec_fail": state["consec_fail"],
                "last_success": state.get("last_success"),
                "state_reset": state_reset,
                "daily_calls": state["daily_calls"],
            }
        else:
            vid = info["veh_id"] or None
            predict = info["predict_sec"]

            # 예측 로깅 (유라코 기준)
            append_csv(predict_path, {
                "ts_kst": ts_iso,
                "vehId": vid,
                "plateNo": info["plate_no"],
                "predict_sec": predict,
                "remain_seat": info["remain_seat"],
                "state_cd": info["state_cd"],
                "flag": info["flag"],
                "location_no": info["location_no"],
            })

            # 2차 정류장 보정: 같은 차량이 두 정류장 응답에 나타나는지 기록
            if info_secondary and vid and vid == info_secondary["veh_id"]:
                if info_secondary["state_cd"] == 1 or (info_secondary.get("location_no") or 0) >= 1:
                    append_csv(segment_path, {
                        "ts_kst": ts_iso,
                        "vehId": vid,
                        "from_station": STATION_ID,
                        "to_station": secondary_station_id,
                        "note": "same_veh_at_both",
                    })

            observe(state, info, ts, arrival_path)

            if vid is None:
                status = {
                    "error": "no_bus",
                    "secondary_station_id": secondary_station_id,
                    "secondary_mobile_no": args.secondary_mobile_no,
                    "secondary_available": bool(info_secondary and info_secondary.get("veh_id")),
                    "daily_calls": state["daily_calls"],
                    "last_success": ts_iso,
                }
            else:
                status = {
                    "route_id": route_id,
                    "secondary_station_id": secondary_station_id,
                    "secondary_mobile_no": args.secondary_mobile_no,
                    "current_veh_id": vid,
                    "current_plate": info["plate_no"],
                    "predict_sec": predict,
                    "location_no": info["location_no"],
                    "next_veh_id": info["next_veh_id"],
                    "next_plate_no": info["next_plate_no"],
                    "next_predict_sec": info["next_predict_sec"],
                    "remain_seat": info["remain_seat"],
                    "flag": info["flag"],
                    "tracking_samples": state["samples"],
                    "min_predict_in_track": state["min_predict"],
                    "daily_calls": state["daily_calls"],
                    "confidence": arrival_confidence(info, predict),
                    "last_success": ts_iso,
                    "state_reset": state_reset,
                }

        save_state(state_path, state)
        if status_path:
            _write_status(status_path, ts_iso, {**status, "collect_window": args.window})
        state_reset = False

        polls += 1
        if args.max_polls is not None and polls >= args.max_polls:
            break
        wait = max(0.0, args.interval - (time.monotonic() - started))
        if deadline is not None and time.monotonic() + wait >= deadline:
            break
        time.sleep(wait)


def _write_status(path: str, ts_iso: str, extra: dict):
    data = {"last_poll": ts_iso, "last_poll_local": str(kst_now()), **extra}
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logging.warning("status 기록 실패: %s", e)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--gate-only", action="store_true",
                   help="수집 여부만 판정하고 종료 (평일/공휴일/시간대/호출 상한)")
    p.add_argument("--route-id", type=int, default=None)
    p.add_argument("--sta-order", type=int, default=STA_ORDER)
    p.add_argument("--secondary-station-id", type=int,
                   default=int(os.getenv("BUS_SECONDARY_STATION_ID", "0")) or None)
    p.add_argument("--secondary-mobile-no", default=SECONDARY_MOBILE_NO)
    p.add_argument("--sta-order-secondary", type=int, default=STA_ORDER_SECONDARY)
    p.add_argument("--window", default=os.getenv("BUS_WINDOW") or COLLECT_WINDOW,
                   help="수집 시간대 (KST, HH:MM-HH:MM)")
    p.add_argument("--interval", type=int, default=60)
    p.add_argument("--output-csv", default=os.getenv("BUS_OUTPUT_CSV", "bus-arrival/arrival_log.csv"))
    p.add_argument("--status-json", default=os.getenv("BUS_STATUS_JSON", "bus-arrival/status.json"))
    p.add_argument("--max-polls", type=int, default=None)
    p.add_argument("--run-seconds", type=int, default=None,
                   help="이 시간(초)이 지나면 다음 조회 전에 종료")
    p.add_argument("--max-daily-calls", type=int, default=900)
    p.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO"))
    return p.parse_args(argv)


def main():
    args = parse_args()
    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    os.makedirs(os.path.dirname(args.output_csv) or ".", exist_ok=True)

    if args.gate_only:
        gate_check(args)
        return

    try:
        run_loop(args)
    except KeyboardInterrupt:
        logging.info("사용자 중지")


if __name__ == "__main__":
    main()
