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
RECOVERY_MINUTES = 20
MIN_SAMPLES_MORNING = 3
MIN_VALID_DAYS = 5
KST_TZ = dt.timezone(dt.timedelta(hours=9))


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--input-csv", default=os.getenv("YUC_INPUT_CSV", "yuc/parking_log.csv"))
    p.add_argument("--output-json", default=os.getenv("YUC_OUTPUT_JSON", "yuc/daily_stats.json"))
    p.add_argument("--target-name", default=os.getenv("YUC_TARGET_NAME", "수지노외 공영주차장"))
    return p.parse_args()


def load_csv(path: str) -> list[dict]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"CSV not found: {path}")
    
    records = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                ts_str = row["timestamp_kst"]
                if ts_str.endswith("+09:00"):
                    ts = dt.datetime.fromisoformat(ts_str)
                else:
                    ts = dt.datetime.fromisoformat(ts_str.replace("+09:00", "+09:00"))
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
        return {"p10": None, "p25": None, "median": None, "p75": None, "p90": None, "included_days": 0, "minimum_required_days": MIN_VALID_DAYS}
    
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
        "included_days": n,
        "minimum_required_days": MIN_VALID_DAYS
    }


def compute_sample_gap(records: list[dict]) -> list[float]:
    gaps = []
    for i in range(1, len(records)):
        gap = (records[i]["t"] - records[i-1]["t"]).total_seconds() / 60
        gaps.append(gap)
    return gaps


def process_day(records: list[dict], target_name: str) -> Optional[dict]:
    morning_records = [r for r in records if is_morning(r["t"])]
    
    if not morning_records:
        return None
    
    first = morning_records[0]
    date = first["t"].date().isoformat()
    weekday = get_weekday(first["t"])
    sample_count = len(morning_records)
    min_available = min(r["available"] for r in morning_records)
    max_gap = max(compute_sample_gap(morning_records)) if len(morning_records) > 1 else 0
    
    first_sample = morning_records[0]["t"].isoformat()
    last_sample = morning_records[-1]["t"].isoformat()
    
    first_le_2 = None
    effective_full = None
    
    for i, r in enumerate(morning_records):
        if r["available"] <= LOW_THRESHOLD:
            prev_avail = morning_records[i - 1]["available"] if i > 0 else None
            prev_gap = (r["t"] - morning_records[i - 1]["t"]).total_seconds() / 60 if i > 0 else None
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
                if (morning_records[j]["t"] - r["t"]).total_seconds() > RECOVERY_MINUTES * 60:
                    break
            
            if not recovery_found:
                effective_full = {
                    "observed_at": r["t"].isoformat(),
                }
            
            break
    
    return {
        "date": date,
        "weekday": weekday,
        "sample_count": sample_count,
        "max_gap_minutes": round(max_gap, 1) if max_gap > 0 else None,
        "morning_coverage": {
            "first_sample": first_sample,
            "last_sample": last_sample
        },
        "first_le_2": first_le_2,
        "effective_full": effective_full,
        "min_available_morning": min_available,
        "included_in_first_low_summary": False,
        "included_in_effective_full_summary": False,
    }


def main() -> int:
    args = parse_args()
    
    try:
        records = load_csv(args.input_csv)
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    
    latest_ts = max(r["t"] for r in records) if records else None
    
    by_date = {}
    for r in records:
        date_key = r["t"].date().isoformat()
        if date_key not in by_date:
            by_date[date_key] = []
        by_date[date_key].append(r)
    
    days = []
    first_low_times = []
    effective_full_times = []
    
    for date_key in sorted(by_date.keys(), reverse=True):
        day_data = process_day(by_date[date_key], args.target_name)
        if day_data:
            days.append(day_data)
            
            weekday = day_data["weekday"]
            if weekday >= 5:
                continue
            
            first_le_2 = day_data["first_le_2"]
            if first_le_2 and first_le_2["confidence"] in ("high", "medium"):
                t = dt.datetime.fromisoformat(first_le_2["observed_at"])
                time_mins = minutes_since_midnight(t)
                first_low_times.append(time_mins)
                day_data["included_in_first_low_summary"] = True
            
            effective_full = day_data["effective_full"]
            if effective_full and first_le_2 and first_le_2["confidence"] in ("high", "medium"):
                effective_full_times.append(minutes_since_midnight(dt.datetime.fromisoformat(effective_full["observed_at"])))
                day_data["included_in_effective_full_summary"] = True
    
    first_low_summary = compute_quantiles(first_low_times)
    effective_full_summary = compute_quantiles(effective_full_times)
    
    output = {
        "schema_version": 2,
        "generated_at": dt.datetime.now(KST_TZ).isoformat(),
        "target": args.target_name,
        "source_latest_at": latest_ts.isoformat() if latest_ts else None,
        "thresholds": {
            "low": LOW_THRESHOLD,
            "safe": SAFE_THRESHOLD,
            "morning_start_hour": MORNING_START,
            "morning_end_hour": MORNING_END,
            "recovery_minutes": RECOVERY_MINUTES
        },
        "quality_policy": {
            "min_morning_samples": MIN_SAMPLES_MORNING,
            "max_allowed_gap_minutes": 25,
            "minimum_valid_days_for_bands": MIN_VALID_DAYS,
            "included_confidence": ["high", "medium"]
        },
        "summary": {
            "first_low": first_low_summary,
            "effective_full": effective_full_summary,
        },
        "days": days,
    }
    
    output_path = os.path.abspath(args.output_json)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
        f.write("\n")
    
    print(f"Generated {args.output_json}: {len(days)} days")
    print(f"  first_low: {len(first_low_times)} valid events")
    print(f"  effective_full: {len(effective_full_times)} valid events")
    return 0


if __name__ == "__main__":
    sys.exit(main())