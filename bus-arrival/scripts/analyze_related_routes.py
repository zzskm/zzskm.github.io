#!/usr/bin/env python3
"""07511 전체 노선의 ETA 관측을 3100번 도착 추정과 비교한다.

중요: 두 시각 모두 센서 실측 도착이 아니다. 이 보고서만으로 안전 알림을
앞당기거나 늦추지 않는다. 후속 검증용 연관 노선 후보를 발굴하는 용도다.
"""
import argparse
import csv
import datetime as dt
import json
from collections import defaultdict
from pathlib import Path
from statistics import median

KST = dt.timezone(dt.timedelta(hours=9))
TARGET_ROUTE_ID = 204000170
FOLLOWING_WINDOW_SEC = 20 * 60
# 최소 운행일/표본이 확보되기 전에는 순위를 사용자 알림에 사용하지 않는다.
MIN_DAYS = 10
MIN_EVENTS = 15


def read_rows(path):
    if not Path(path).exists():
        return []
    with open(path, newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def moment(value):
    try:
        time = dt.datetime.fromisoformat(value)
        return time if time.tzinfo else None
    except (ValueError, TypeError):
        return None


def arrivals(rows):
    by_date = defaultdict(list)
    for row in rows:
        if row.get("departure_reason") not in ("observed_arrival", "estimated_arrival"):
            continue
        t = moment(row.get("est_arrival_ts"))
        if t is not None:
            by_date[t.date().isoformat()].append(t)
    for times in by_date.values():
        times.sort()
    return by_date


def signal_events(rows):
    """동일 차량의 여러 조회를 1개 ETA 신호로 요약. 첫 번째 차량만 사용."""
    by_vehicle = {}
    route_names = {}
    for row in rows:
        t = moment(row.get("ts_kst"))
        if t is None or row.get("vehicle_rank") != "1":
            continue
        try:
            route_id = int(row.get("route_id", ""))
            order = int(row.get("sta_order", ""))
            vehicle_id = int(row.get("veh_id", ""))
            seconds = int(row.get("predict_sec", ""))
        except (ValueError, TypeError):
            continue
        if route_id == TARGET_ROUTE_ID or not 0 < seconds <= 600:
            continue
        key = (route_id, order, vehicle_id, t.date().isoformat())
        prev = by_vehicle.get(key)
        # 마지막 신호의 ETA 를 사용한다. API의 실제 도착 판정으로 오인하지 않는다.
        if prev is None or prev[0] < t:
            by_vehicle[key] = (t, t + dt.timedelta(seconds=seconds))
        route_names[(route_id, order)] = row.get("route_name") or str(route_id)
    by_route = defaultdict(list)
    for (route_id, order, _vehicle_id, day), (_seen, eta) in by_vehicle.items():
        by_route[(route_id, order)].append((day, eta))
    return by_route, route_names


def stats(signal_rows, arrival_rows):
    targets = arrivals(arrival_rows)
    route_events, names = signal_events(signal_rows)
    all_candidates = []
    for (route_id, order), events in route_events.items():
        matched = []
        days = set()
        covered_target = set()
        for day, eta in events:
            days.add(day)
            future = targets.get(day, [])
            options = [(i, (arrival - eta).total_seconds()) for i, arrival in enumerate(future)]
            options = [(i, lead) for i, lead in options if 0 <= lead <= FOLLOWING_WINDOW_SEC]
            if options:
                i, lead = min(options, key=lambda p: p[1])
                matched.append(round(lead / 60, 2))
                covered_target.add((day, i))
        total_target = sum(len(targets.get(day, [])) for day in days)
        enough = len(days) >= MIN_DAYS and len(events) >= MIN_EVENTS and len(matched) >= 10
        all_candidates.append({
            "route_id": route_id, "route_name": names.get((route_id, order), str(route_id)),
            "sta_order": order,
            "observed_days": len(days), "vehicle_signals": len(events),
            "followed_by_3100_within_20m": len(matched),
            "follow_rate": round(len(matched) / len(events), 3) if events else 0,
            "target_coverage": round(len(covered_target) / total_target, 3) if total_target else 0,
            "median_lead_minutes": round(median(matched), 2) if matched else None,
            "min_lead_minutes": min(matched) if matched else None,
            "max_lead_minutes": max(matched) if matched else None,
            "sufficient_for_screening": enough,
        })
    all_candidates.sort(key=lambda r: (
        -r["follow_rate"], -r["followed_by_3100_within_20m"], -r["observed_days"], r["route_id"]
    ))
    return {
        "schema_version": 1,
        "purpose": "candidate_discovery_only",
        "prediction_model_changed": False,
        "arrival_truth": "target_conditional_estimate_and_other_route_api_eta_not_actual_arrival",
        "window_minutes": FOLLOWING_WINDOW_SEC // 60,
        "minimum_days": MIN_DAYS, "minimum_vehicle_signals": MIN_EVENTS,
        "signals_count": len(signal_rows),
        "target_estimated_arrivals_count": sum(map(len, targets.values())),
        "candidate_routes": all_candidates,
        "status": "screening" if any(c["sufficient_for_screening"] for c in all_candidates) else "collecting",
        "warning": "상관관계는 예측 개선을 입증하지 않음. 시간대 통제 및 미래 날짜 검증, 기존 알림 안전율 비교가 필요함.",
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--signals", default="bus-arrival/route_signal_log.csv")
    p.add_argument("--arrival", default="bus-arrival/arrival_log.csv")
    p.add_argument("--output", default="bus-arrival/reports/related-routes.json")
    args = p.parse_args()
    report = stats(read_rows(args.signals), read_rows(args.arrival))
    report["generated_at"] = dt.datetime.now(KST).isoformat()
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


if __name__ == "__main__":
    main()
