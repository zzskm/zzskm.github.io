#!/usr/bin/env python3
import argparse
import csv
import json
import os
from collections import Counter, defaultdict


def read_rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--predict", default="bus-arrival/predict_log.csv")
    p.add_argument("--arrival", default="bus-arrival/arrival_log.csv")
    p.add_argument("--output", default="bus-arrival/summary.json")
    args = p.parse_args()

    predictions = read_rows(args.predict)
    arrivals = read_rows(args.arrival)
    by_day = defaultdict(list)
    for row in predictions:
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
    summary = {
        "latest": latest,
        "prediction_samples": len(predictions),
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
