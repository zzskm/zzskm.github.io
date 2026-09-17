#!/usr/bin/env python3
import argparse
import csv
import json
import os
import datetime as dt
from collections import Counter, defaultdict


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
    summary = {
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
    }
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    tmp = args.output + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    os.replace(tmp, args.output)


if __name__ == "__main__":
    main()
