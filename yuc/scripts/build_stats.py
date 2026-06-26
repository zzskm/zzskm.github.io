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
    p.add_argument("--exclude-dates", default=os.getenv("YUC_EXCLUDE_DATES", "yuc/excluded_dates.txt"))
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


def load_excluded_dates(path: str) -> set[str]:
    excluded = set()
    if not os.path.exists(path):
        return excluded
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            date_part = line.split()[0]
            try:
                dt.datetime.strptime(date_part, "%Y-%m-%d")
                excluded.add(date_part)
            except ValueError:
                continue
    return excluded


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
        return {"p10": None, "p25": None, "median": None, "p75": None, "p90": None, "included_days": 0}
    
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
        "included_days": n
    }


def compute_sample_gap(records: list[dict]) -> list[float]:
    gaps = []
    for i in range(1, len(records)):
        gap = (records[i]["t"] - records[i-1]["t"]).total_seconds() / 60
        gaps.append(gap)
    return gaps


def process_day(records: list[dict], excluded_dates: set[str]) -> Optional[dict]:
    morning_records = [r for r in records if is_morning(r["t"])]
    
    if not morning_records:
        return None
    
    first = morning_records[0]
    date = first["t"].date().isoformat()
    weekday = get_weekday(first["t"])
    sample_count = len(morning_records)
    min_available = min(r["available"] for r in morning_records)
    
    exclude_reasons = []
    
    if date in excluded_dates:
        exclude_reasons.append("manual_exclude")
    
    if weekday >= 5:
        exclude_reasons.append("weekend")
    
    if sample_count < MIN_SAMPLES_MORNING:
        exclude_reasons.append("insufficient_morning_samples")
    
    max_gap = max(compute_sample_gap(morning_records)) if len(morning_records) > 1 else 0
    if max_gap > 25:
        exclude_reasons.append("large_sample_gap")
    
    if min_available > LOW_THRESHOLD:
        exclude_reasons.append("no_low_threshold_observed")
    
    first_le_2 = None
    effective_full = None
    
    for i, r in enumerate(morning_records):
        if r["available"] <= LOW_THRESHOLD:
            prev_avail = morning_records[i - 1]["available"] if i > 0 else None
            prev_gap = None
            if i > 0:
                prev_gap = (r["t"] - morning_records[i - 1]["t"]).total_seconds() / 60
            
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
                    "reason": "first_low_no_recovery",
                }
            else:
                effective_full = {
                    "observed_at": r["t"].isoformat(),
                    "reason": "recovered",
                }
            
            break
    
    if first_le_2 is None:
        exclude_reasons.append("no_effective_full_observed")
    
    return {
        "date": date,
        "weekday": weekday,
        "sample_count": sample_count,
        "first_le_2": first_le_2,
        "effective_full": effective_full,
        "min_available_morning": min_available,
        "exclude_reasons": exclude_reasons,
    }


def main() -> int:
    args = parse_args()
    
    try:
        records = load_csv(args.input_csv)
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    
    excluded_dates = load_excluded_dates(args.exclude_dates)
    
    by_date = {}
    for r in records:
        date_key = r["t"].date().isoformat()
        if date_key not in by_date:
            by_date[date_key] = []
        by_date[date_key].append(r)
    
    days = []
    first_low_times = []
    effective_full_times = []
    exclusion_counts = {
        "weekend": 0,
        "holiday": 0,
        "manual_exclude": 0,
        "insufficient_morning_samples": 0,
        "large_sample_gap": 0,
        "no_low_threshold_observed": 0,
        "no_effective_full_observed": 0,
        "unknown_threshold_confidence": 0,
    }
    
    for date_key in sorted(by_date.keys(), reverse=True):
        day_data = process_day(by_date[date_key], excluded_dates)
        if day_data:
            days.append(day_data)
            has_any_exclusion = bool(day_data["exclude_reasons"])
            
            for reason in day_data["exclude_reasons"]:
                if reason in exclusion_counts:
                    exclusion_counts[reason] += 1
            
            if day_data["first_le_2"]:
                first_le_2 = day_data["first_le_2"]
                t = dt.datetime.fromisoformat(first_le_2["observed_at"])
                time_mins = minutes_since_midnight(t)
                if first_le_2["confidence"] in ("high", "medium"):
                    if not has_any_exclusion and day_data["weekday"] < 5:
                        first_low_times.append(time_mins)
    
    for day_data in days:
        if day_data["effective_full"] and not day_data["exclude_reasons"]:
            if day_data["weekday"] < 5:
                t = dt.datetime.fromisoformat(day_data["effective_full"]["observed_at"])
                effective_full_times.append(minutes_since_midnight(t))
    
    first_low_summary = compute_quantiles(first_low_times)
    effective_full_summary = compute_quantiles(effective_full_times)
    
    output = {
        "schema_version": 2,
        "generated_at": dt.datetime.now(KST_TZ).isoformat(),
        "summary": {
            "first_low": first_low_summary,
            "effective_full": effective_full_summary,
            "excluded_days": exclusion_counts,
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