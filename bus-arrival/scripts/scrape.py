#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GBIS 버스 도착 로그 수집기 — 유라코퍼레이션.SK케미칼(07511) × 3100번

공공데이터포털 '경기도_버스도착정보 조회' (busarrivalservice/v2/getBusArrivalItemv2)
- 유라코퍼레이션 + 판교역북편 동시 조회
- 차량 ID 매칭으로 구간 이동시간 계산
- 차량 교체 / 실제 도착 / 운행종료 / API 오류를 구분하여 기록
- 실행 간 상태 저장 (tracker_state.json)
- 일일 호출 상한 관리

이탈 사유 (arrival_log.csv):
  observed_arrival — stateCd=1 또는 60초 이하 도달 (실제 도착 확인)
  estimated_arrival — 60초 이하 도달로 판정
  vehicle_changed  — 차량만 변경 (이전 버스 이탈 시점 추정)
  data_gap         — API 연속 2회 이상 실패 후 차량 변경
  service_end      — flag=STOP 확인
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

ARRIVAL_BASE = "https://apis.data.go.kr/6410000/busarrivalservice/v2"
USER_AGENT = "Mozilla/5.0 (compatible; bus-arrival-log/1.0)"
STATE_MAX_AGE_SECONDS = 20 * 60

HOLIDAYS_2026 = {
    "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18",
    "2026-03-01", "2026-05-05", "2026-06-06",
    "2026-08-15", "2026-10-05", "2026-10-06", "2026-10-07",
    "2026-10-09", "2026-12-25",
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
        if xml_text(root, ".//resultCode") != "0":
            return None
        n = root.find(".//busArrivalItem")
        if n is None:
            return None

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
        logging.debug("API 실패 station=%d: %s", station_id, e)
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
        logging.warning("2차 정류장 stationId 해석 실패: %s", e)
    return None


def append_csv(path: str, row: dict):
    exists = os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(row.keys()))
        if not exists:
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


def gate_check() -> bool:
    """True면 수집을 건너뜀 (주말/공휴일)."""
    now = kst_now()
    dow = now.isoweekday()
    today = now.strftime("%Y-%m-%d")
    skip = dow > 5 or today in HOLIDAYS_2026
    reason = "ok" if not skip else ("weekend" if dow > 5 else "holiday")
    print(f"skip={str(skip).lower()}")
    print(f"reason={reason}")
    # GITHUB_OUTPUT
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write(f"skip={str(skip).lower()}\n")
            f.write(f"reason={reason}\n")
    return skip


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

    state_path = os.path.join(os.path.dirname(args.output_csv), "tracker_state.json")
    predict_path = os.path.join(os.path.dirname(args.output_csv), "predict_log.csv")
    arrival_path = args.output_csv
    segment_path = os.path.join(os.path.dirname(args.output_csv), "segment_log.csv")
    status_path = args.status_json

    state = load_state(state_path)

    # 일일 호출 카운트 관리
    today_str = kst_now().strftime("%Y-%m-%d")
    daily_calls = state.get("daily_calls") if state.get("date") == today_str else 0
    max_daily_calls = args.max_daily_calls

    cur_vid = state.get("cur_vid")
    cur_plate = state.get("cur_plate", "")
    first_seen = dt.datetime.fromisoformat(state["first_seen"]) if state.get("first_seen") else None
    last_seen = dt.datetime.fromisoformat(state["last_seen"]) if state.get("last_seen") else None
    min_predict = state.get("min_predict", 99999)
    max_predict = state.get("max_predict", -1)
    samples = state.get("samples", 0)
    last_predict = state.get("last_predict")
    last_state_cd = state.get("last_state_cd")
    consec_fail = state.get("consec_fail", 0)
    state_reset = False
    if last_seen and (kst_now() - last_seen).total_seconds() > STATE_MAX_AGE_SECONDS:
        cur_vid = None
        cur_plate = ""
        first_seen = None
        last_seen = None
        min_predict = 99999
        max_predict = -1
        samples = 0
        last_predict = None
        last_state_cd = None
        state_reset = True

    logging.info("시작: routeId=%d staOrder=%d (성남시청전면 %d/%d) cur_vid=%s 호출=%d/%d",
                 route_id, sta_order, secondary_station_id, sta_order_secondary,
                 cur_vid, daily_calls, max_daily_calls)

    while True:
        ts = kst_now()
        ts_iso = ts.isoformat()

        if daily_calls >= max_daily_calls:
            logging.warning("일일 호출 상한 도달 (%d/%d). 중지.", daily_calls, max_daily_calls)
            break

        info = fetch_arrival(service_key, STATION_ID, route_id, sta_order)
        info_secondary = None
        if secondary_station_id is not None:
            info_secondary = fetch_arrival(service_key, secondary_station_id, route_id, sta_order_secondary)
        daily_calls += 1 + (1 if secondary_station_id is not None else 0)

        if info is None:
            consec_fail += 1
            _persist(state_path, today_str, daily_calls,
                     cur_vid, cur_plate, first_seen, last_seen,
                     min_predict, max_predict, samples, consec_fail,
                     last_predict, last_state_cd)
            if status_path:
                _write_status(status_path, ts_iso, {
                    "error": "api_error",
                    "consec_fail": consec_fail,
                    "last_success": state.get("last_success"),
                    "state_reset": state_reset,
                })
            if _sleep_and_check(args):
                break
            continue

        previous_failures = consec_fail
        consec_fail = 0
        vid = info["veh_id"]
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
        })

        # 2차 정류장 보정: 같은 차량이 두 정류장 응답에 나타나는지 기록
        if info_secondary and vid and vid == info_secondary["veh_id"]:
            if info_secondary["state_cd"] == 1 or info_secondary.get("location_no", 0) >= 1:
                append_csv(segment_path, {
                    "ts_kst": ts_iso,
                    "vehId": vid,
                    "from_station": STATION_ID,
                    "to_station": secondary_station_id,
                    "note": "same_veh_at_both",
                })

        # 버스 없음은 차량 교체로 처리하지 않는다.
        if not vid:
            if status_path:
                _write_status(status_path, ts_iso, {
                    "error": "no_bus",
                    "secondary_station_id": secondary_station_id,
                    "secondary_mobile_no": args.secondary_mobile_no,
                    "secondary_available": bool(info_secondary and info_secondary.get("veh_id")),
                    "daily_calls": daily_calls,
                })
            _persist(state_path, today_str, daily_calls,
                     cur_vid, cur_plate, first_seen, last_seen,
                     min_predict, max_predict, samples, consec_fail,
                     None, None,
                     last_flag=info["flag"])
            if _sleep_and_check(args):
                break
            continue

        # 차량 변경 감지
        if vid != cur_vid:
            if cur_vid is not None and samples > 0:
                reason = _classify_departure(
                    previous_failures, state.get("last_flag", ""),
                    last_predict, last_state_cd,
                )
                append_csv(arrival_path, {
                    "ts_kst": ts_iso,
                    "vehId": cur_vid,
                    "plateNo": cur_plate,
                    "first_seen_ts": first_seen.isoformat() if first_seen else "",
                    "last_seen_ts": last_seen.isoformat() if last_seen else "",
                    "min_predict_sec": min_predict if min_predict < 99999 else "",
                    "max_predict_sec": max_predict if max_predict >= 0 else "",
                    "samples": samples,
                    "departure_reason": reason,
                })
                logging.info("이탈: vehId=%s plate=%s reason=%s min_predict=%ss",
                             cur_vid, cur_plate, reason,
                             min_predict if min_predict < 99999 else "?")

            cur_vid = vid
            cur_plate = info["plate_no"]
            first_seen = ts
            last_seen = ts
            min_predict = predict if predict is not None else 99999
            max_predict = predict if predict is not None else -1
            samples = 1
        else:
            last_seen = ts
            if predict is not None:
                min_predict = min(min_predict, predict)
                max_predict = max(max_predict, predict)
            samples += 1

        state["last_success"] = ts_iso
        last_predict = predict
        last_state_cd = info["state_cd"]
        _persist(state_path, today_str, daily_calls,
                 cur_vid, cur_plate, first_seen, last_seen,
                 min_predict, max_predict, samples, consec_fail,
                 last_predict, last_state_cd,
                 last_flag=info["flag"])

        if status_path:
            _write_status(status_path, ts_iso, {
                "route_id": route_id,
                "secondary_station_id": secondary_station_id,
                "secondary_mobile_no": args.secondary_mobile_no,
                "current_veh_id": vid,
                "current_plate": info["plate_no"],
                "predict_sec": predict,
                "next_veh_id": info["next_veh_id"],
                "next_plate_no": info["next_plate_no"],
                "next_predict_sec": info["next_predict_sec"],
                "remain_seat": info["remain_seat"],
                "flag": info["flag"],
                "tracking_samples": samples,
                "min_predict_in_track": min_predict,
                "daily_calls": daily_calls,
                "confidence": arrival_confidence(info, predict),
                "last_success": ts_iso,
                "state_reset": state_reset,
            })
        state_reset = False

        if _sleep_and_check(args):
            break


def _classify_departure(consec_fail: int, last_flag: str,
                        last_predict: int | None, last_state_cd: int | None) -> str:
    if consec_fail >= 2:
        return "data_gap"
    if last_state_cd == 1 or (last_predict is not None and last_predict <= 60):
        return "observed_arrival"
    if last_predict is not None and last_predict <= 90:
        return "estimated_arrival"
    if last_flag == "STOP":
        return "service_end"
    return "vehicle_changed"


def arrival_confidence(info: dict, predict: int | None) -> str:
    if info.get("state_cd") == 1:
        return "high"
    if predict is not None and predict <= 60:
        return "medium"
    if predict is not None:
        return "low"
    return "unknown"


def _persist(state_path: str, date: str, daily_calls: int,
             cur_vid, cur_plate, first_seen, last_seen,
             min_predict, max_predict, samples, consec_fail,
             last_predict, last_state_cd,
             last_flag: str = ""):
    save_state(state_path, {
        "date": date,
        "daily_calls": daily_calls,
        "cur_vid": cur_vid,
        "cur_plate": cur_plate or "",
        "first_seen": first_seen.isoformat() if first_seen else None,
        "last_seen": last_seen.isoformat() if last_seen else None,
        "min_predict": min_predict,
        "max_predict": max_predict,
        "samples": samples,
        "last_predict": last_predict,
        "last_state_cd": last_state_cd,
        "consec_fail": consec_fail,
        "last_flag": last_flag,
    })


def _write_status(path: str, ts_iso: str, extra: dict):
    data = {"last_poll": ts_iso, "last_poll_local": str(kst_now()), **extra}
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logging.debug("status 기록 실패: %s", e)


def _sleep_and_check(args: argparse.Namespace) -> bool:
    if args.max_polls is not None:
        args.max_polls -= 1
        if args.max_polls <= 0:
            return True
    time.sleep(args.interval)
    return False


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--gate-only", action="store_true",
                   help="평일/공휴일 체크만 하고 종료 (워크플로우 게이트용)")
    p.add_argument("--route-id", type=int, default=None)
    p.add_argument("--sta-order", type=int, default=STA_ORDER)
    p.add_argument("--secondary-station-id", type=int,
                   default=int(os.getenv("BUS_SECONDARY_STATION_ID", "0")) or None)
    p.add_argument("--secondary-mobile-no", default=SECONDARY_MOBILE_NO)
    p.add_argument("--sta-order-secondary", type=int, default=STA_ORDER_SECONDARY)
    p.add_argument("--interval", type=int, default=60)
    p.add_argument("--output-csv", default=os.getenv("BUS_OUTPUT_CSV", "bus-arrival/arrival_log.csv"))
    p.add_argument("--status-json", default=os.getenv("BUS_STATUS_JSON", "bus-arrival/status.json"))
    p.add_argument("--max-polls", type=int, default=None)
    p.add_argument("--max-daily-calls", type=int, default=900)
    p.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO"))
    return p.parse_args()


def main():
    args = parse_args()
    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    os.makedirs(os.path.dirname(args.output_csv) or ".", exist_ok=True)

    if args.gate_only:
        gate_check()
        return

    try:
        run_loop(args)
    except KeyboardInterrupt:
        logging.info("사용자 중지")


if __name__ == "__main__":
    main()
