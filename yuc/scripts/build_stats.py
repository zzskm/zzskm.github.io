#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build daily parking statistics from CSV log.
Generates daily_stats.json with threshold crossing times and quantiles.
"""

import argparse
import csv
import datetime as dt
import json
import os
import sys
from typing import Optional

LOW_THRESHOLD = 2
SAFE_THRESHOLD = 5
MORNING_START = 7
MORNING_END = 11
KST_TZ = dt.timezone(dt.timedelta(hours=9))


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--input-csv", default=os.getenv("YUC_INPUT_CSV", "yuc/parking_log.csv"), help="Input CSV path")
    p.add_argument("--output-json", default=os.getenv("YUC_OUTPUT_JSON", "yuc/daily_stats.json"), help="Output JSON path")
    return p.parse_args()


def load_csv(path: str) -> list[dict]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"CSV not found: {path}")
    
    records = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                ts = dt.datetime.fromisoformat(row["timestamp_kst"].replace("+09:00", "+09:00"))
                avail = int(row["available"])
                records.append({"t": ts, "available": avail})
            except (ValueError, KeyError):
                continue
    
    return sorted(records, key=lambda x: x["t"])


def get_weekday(ts: dt.datetime) -> int:
    return ts.weekday()


def minutes_since_midnight(ts: dt.datetime) -> int:
    return ts.hour * 60 + ts.minute


def is_morning(ts: dt.datetime) -> bool:
    return MORNING_START <= ts.hour < MORNING_END


def get_confidence(prev_gap_minutes: Optional[float]) -> str:
    if prev_gap_minutes is None:
        return "unknown"
    if prev_gap_minutes <= 6:
        return "high"
    if prev_gap_minutes <= 12:
        return "medium"
    if prev_gap_minutes <= 25:
        return "low"
    return "unknown"


def compute_quantiles(times: list[int]) -> dict:
    if not times:
        return {"p10": None, "p25": None, "median": None, "p75": None, "p90": None}
    
    sorted_times = sorted(times)
    n = len(sorted_times)
    
    def percentile(p: float) -> int:
        if n == 1:
            return sorted_times[0]
        idx = (p / 100) * (n - 1)
        lower = int(idx)
        upper = lower + 1
        if upper >= n:
            return sorted_times[-1]
        weight = idx - lower
        return int(sorted_times[lower] * (1 - weight) + sorted_times[upper] * weight)
    
    return {
        "p10": percentile(10),
        "p25": percentile(25),
        "median": percentile(50),
        "p75": percentile(75),
        "p90": percentile(90),
    }


def process_day(records: list[dict]) -> Optional[dict]:
    morning_records = [r for r in records if is_morning(r["t"])]
    if not morning_records:
        return None
    
    first = morning_records[0]
    date = first["t"].date().isoformat()
    weekday = get_weekday(first["t"])
    sample_count = len(morning_records)
    
    min_available = min(r["available"] for r in morning_records)
    
    first_le_2 = None
    effective_full = None
    
    for i, r in enumerate(morning_records):
        if r["available"] <= LOW_THRESHOLD:
            prev_avail = morning_records[i - 1]["available"] if i > 0 else None
            prev_gap = None
            if i > 0:
                gap = (r["t"] - morning_records[i - 1]["t"]).total_seconds() / 60
                prev_gap = gap
            
            confidence = get_confidence(prev_gap)
            
            first_le_2 = {
                "observed_at": r["t"].isoformat(),
                "interval_start": morning_records[i - 1]["t"].isoformat() if i > 0 else r["t"].isoformat(),
                "interval_end": r["t"].isoformat(),
                "previous_available": prev_avail,
                "available": r["available"],
                "confidence": confidence,
            }
            
            recovery_found = False
            for j in range(i + 1, len(morning_records)):
                if morning_records[j]["available"] >= SAFE_THRESHOLD:
                    recovery_found = True
                    break
                if (morning_records[j]["t"] - r["t"]).total_seconds() > 20 * 60:
                    break
            
            if not recovery_found:
                effective_full = {
                    "observed_at": r["t"].isoformat(),
                    "reason": "first_low_no_recovery",
                }
            else:
                effective_full = {
                    "observed_at": r["t"].isoformat(),
                    "reason": "recovered",
                }
            
            break
    
    return {
        "date": date,
        "weekday": weekday,
        "sample_count": sample_count,
        "first_le_2": first_le_2,
        "effective_full": effective_full,
        "min_available_morning": min_available,
    }


def main() -> int:
    args = parse_args()
    
    try:
        records = load_csv(args.input_csv)
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    
    by_date = {}
    for r in records:
        date_key = r["t"].date().isoformat()
        if date_key not in by_date:
            by_date[date_key] = []
        by_date[date_key].append(r)
    
    days = []
    weekday_first_le_2_times = []
    
    for date_key in sorted(by_date.keys(), reverse=True):
        day_data = process_day(by_date[date_key])
        if day_data:
            days.append(day_data)
            if day_data["weekday"] < 5 and day_data["first_le_2"]:
                t = dt.datetime.fromisoformat(day_data["first_le_2"]["observed_at"])
                weekday_first_le_2_times.append(minutes_since_midnight(t))
    
    summary = compute_quantiles(weekday_first_le_2_times)
    
    output = {
        "summary": summary,
        "days": days,
    }
    
    os.makedirs(os.path.dirname(os.path.abspath(args.output_json)), exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
        f.write("\n")
    
    print(f"Generated {args.output_json}: {len(days)} days, {len(weekday_first_le_2_times)} weekday first_le_2 events")
    return 0


if __name__ == "__main__":
    sys.exit(main())