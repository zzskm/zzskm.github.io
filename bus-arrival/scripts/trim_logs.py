#!/usr/bin/env python3
import csv
import datetime as dt
import os

KST = dt.timezone(dt.timedelta(hours=9))


def trim(path, days):
    if not os.path.exists(path):
        return 0
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return 0
    cutoff = (dt.datetime.now(dt.timezone.utc).astimezone(KST) - dt.timedelta(days=days)).date()
    kept = []
    for row in rows:
        try:
            day = dt.date.fromisoformat(row.get("ts_kst", "")[:10])
        except ValueError:
            continue
        if day >= cutoff:
            kept.append(row)
    fields = list(rows[0].keys())
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(kept)
    os.replace(tmp, path)
    return len(rows) - len(kept)


if __name__ == "__main__":
    base = "bus-arrival"
    removed = sum(trim(os.path.join(base, name), 30) for name in (
        "predict_log.csv", "arrival_log.csv", "segment_log.csv"
    ))
    print(f"trimmed_rows={removed}")
