#!/usr/bin/env python3
import argparse
import csv
import json
import os
import datetime as dt
from collections import Counter, defaultdict
from safety_model import match_trips, fit_model, historical_slots, KST


RECENT_ROWS = 30


def read_rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def is_valid_prediction(row):
    try:
        return int(row.get("vehId", "0")) != 0 and int(row.get("predict_sec", "")) > 0
    except (TypeError, ValueError):
        return False


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--predict", default="bus-arrival/predict_log.csv")
    p.add_argument("--arrival", default="bus-arrival/arrival_log.csv")
    p.add_argument("--output", default="bus-arrival/summary.json")
    args = p.parse_args()

    predictions = read_rows(args.predict)
    arrivals = read_rows(args.arrival)
    valid_predictions = [row for row in predictions if is_valid_prediction(row)]
    no_bus_samples = sum(row.get("vehId", "") in ("", "0") for row in predictions)
    invalid_samples = len(predictions) - len(valid_predictions) - no_bus_samples
    by_day = defaultdict(list)
    for row in valid_predictions:
        day = row.get("ts_kst", "")[:10]
        if day:
            try:
                by_day[day].append(int(row.get("predict_sec", "")))
            except (TypeError, ValueError):
                pass

    daily = {}
    for day, values in sorted(by_day.items()):
        daily[day] = {
            "samples": len(values),
            "min_predict_sec": min(values),
            "avg_predict_sec": round(sum(values) / len(values)),
        }

    latest = predictions[-1] if predictions else {}
    latest_valid = next((row for row in reversed(predictions) if is_valid_prediction(row)), {})
    today = dt.datetime.now(dt.timezone.utc).astimezone(dt.timezone(dt.timedelta(hours=9))).strftime("%Y-%m-%d")
    since = (dt.date.fromisoformat(today) - dt.timedelta(days=42)).isoformat()
    model_predictions = [r for r in predictions if (r.get('ts_kst') or '')[:10] >= since]
    model_arrivals = [r for r in arrivals if (r.get('first_seen_ts') or '')[:10] >= since]
    trips, safety_audit = match_trips(model_predictions, model_arrivals)
    safety_audit['window_days'] = 42
    # Exclude the entire current day: no partially completed daily history in calibration.
    training = [t for t in trips if 0 < (dt.date.fromisoformat(today) - dt.date.fromisoformat(t['day'])).days <= 42]
    model = fit_model(training)
    holiday_path = os.path.join(os.path.dirname(args.predict), 'holidays.json')
    try:
        with open(holiday_path, encoding='utf-8') as f:
            holidays = json.load(f)
    except (OSError, ValueError):
        holidays = {}
    summary = {
        "safety_model": model,
        "safety_audit": safety_audit,
        "historical_alerts": historical_slots(training, holidays, today),
        "generated_at": dt.datetime.now(KST).isoformat(),
        "latest": latest,
        "latest_valid": latest_valid,
        "today": daily.get(today, {"samples": 0, "min_predict_sec": None, "avg_predict_sec": None}),
        "prediction_samples": len(predictions),
        "valid_prediction_samples": len(valid_predictions),
        "no_bus_samples": no_bus_samples,
        "invalid_samples": invalid_samples,
        "arrival_records": len(arrivals),
        "departure_reasons": dict(Counter(r.get("departure_reason", "unknown") for r in arrivals)),
        "daily": daily,
        # 대시보드가 1분마다 전체 CSV 를 받지 않도록 최근 기록만 함께 싣는다
        "recent_predictions": predictions[-RECENT_ROWS:],
        "recent_arrivals": arrivals[-RECENT_ROWS:],
    }
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    tmp = args.output + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    os.replace(tmp, args.output)


if __name__ == "__main__":
    main()

