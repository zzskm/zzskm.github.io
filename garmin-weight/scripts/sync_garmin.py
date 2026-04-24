#!/usr/bin/env python3
"""Sync daily Garmin aggregates and rebuild the public summary."""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger("garmin_weight")

CSV_HEADERS = [
    "date",
    "weight_kg",
    "weight_measure_count",
    "exercise_minutes",
    "exercise_calories",
    "activity_count",
    "steps",
    "sleep_hours",
    "resting_hr",
    "visceral_fat",
    "metabolic_age",
]


@dataclass
class Paths:
    config: Path
    csv: Path
    summary: Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="garmin-weight/config.json")
    parser.add_argument("--output-csv", default="garmin-weight/data/daily_metrics.csv")
    parser.add_argument("--output-summary", default="garmin-weight/data/summary.json")
    parser.add_argument("--backfill-days", type=int, default=int(os.getenv("BACKFILL_DAYS", "3")))
    parser.add_argument("--date", default=None, help="Override end date (YYYY-MM-DD)")
    parser.add_argument("--skip-garmin", action="store_true", help="Only rebuild summary from CSV.")
    parser.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO"))
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def parse_float(value: Any) -> float | None:
    if value in ("", None):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number):
        return None
    return number


def parse_int(value: Any) -> int | None:
    number = parse_float(value)
    if number is None:
        return None
    return int(round(number))


def round_or_none(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(value, digits)


def format_cell(value: Any, field: str) -> str:
    if value is None:
        return ""
    if field in {"weight_measure_count", "activity_count", "steps", "metabolic_age"}:
        return str(int(round(float(value))))
    if field == "date":
        return str(value)
    return f"{float(value):.2f}".rstrip("0").rstrip(".")


def load_existing_rows(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        rows: dict[str, dict[str, Any]] = {}
        for row in reader:
            key = row.get("date")
            if not key:
                continue
            parsed = {"date": key}
            for field in CSV_HEADERS[1:]:
                if field in {"weight_measure_count", "activity_count", "steps", "metabolic_age"}:
                    parsed[field] = parse_int(row.get(field))
                else:
                    parsed[field] = parse_float(row.get(field))
            rows[key] = parsed
        return rows


def write_rows(path: Path, rows: dict[str, dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_HEADERS)
        writer.writeheader()
        for key in sorted(rows):
            writer.writerow({field: format_cell(rows[key].get(field), field) for field in CSV_HEADERS})


def daterange(end_day: date, days: int) -> list[str]:
    start = end_day - timedelta(days=max(days - 1, 0))
    return [(start + timedelta(days=offset)).isoformat() for offset in range((end_day - start).days + 1)]


def first_number(data: Any, *keys: str) -> float | None:
    if not isinstance(data, dict):
        return None
    for key in keys:
        number = parse_float(data.get(key))
        if number is not None:
            return number
    return None


def first_list_length(data: Any, *keys: str) -> int:
    if not isinstance(data, dict):
        return 0
    for key in keys:
        value = data.get(key)
        if isinstance(value, list):
            return len(value)
    return 0


def get_nested(data: Any, *keys: str) -> Any:
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def safe_call(client: Any, method_name: str, *args: Any, default: Any = None, **kwargs: Any) -> Any:
    method = getattr(client, method_name, None)
    if not callable(method):
        LOGGER.debug("%s not available on client", method_name)
        return default
    try:
        return method(*args, **kwargs)
    except Exception as exc:  # pragma: no cover
        LOGGER.warning("%s failed for %s: %s", method_name, args[0] if args else "", exc)
        return default


def build_client() -> Any:
    from garminconnect import Garmin, GarminConnectAuthenticationError

    is_cn = os.getenv("GARMIN_IS_CN", "").lower() in ("1", "true", "yes")

    # 1순위: GARMIN_TOKENS (garth.dumps() 출력 base64 문자열)
    token_b64 = os.getenv("GARMIN_TOKENS") or os.getenv("GARMIN_TOKENS_JSON")
    if token_b64:
        try:
            client = Garmin(is_cn=is_cn)
            client.garth.loads(token_b64)
            client.username  # 토큰 유효성 가벼운 검증
            LOGGER.info("auth: token reuse succeeded (garth.loads)")
            return client
        except Exception as exc:
            LOGGER.warning("token reuse failed (%s), falling back to password login", exc)

    # 2순위: 이메일 + 패스워드
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    if not email or not password:
        raise RuntimeError(
            "No valid auth: set GARMIN_TOKENS (preferred) or both GARMIN_EMAIL and GARMIN_PASSWORD"
        )

    mfa_code = os.getenv("GARMIN_MFA_CODE")
    prompt_mfa = (lambda: mfa_code) if mfa_code else None
    client = Garmin(email, password, is_cn=is_cn, prompt_mfa=prompt_mfa)
    try:
        client.login()
    except GarminConnectAuthenticationError as exc:
        raise RuntimeError(f"Garmin login failed: {exc}") from exc

    LOGGER.info("auth: password login succeeded")
    try:
        if hasattr(client, "garth") and hasattr(client.garth, "dumps"):
            LOGGER.info("Login succeeded. Update GARMIN_TOKENS secret with: client.garth.dumps()")
        else:
            LOGGER.warning("garth.dumps() not available — set GARMIN_TOKENS manually")
    except Exception as exc:
        LOGGER.warning("Could not check garth: %s", exc)
    return client


def fetch_activities_for_date(client: Any, day: str) -> list[dict[str, Any]]:
    result = safe_call(client, "get_activities_for_date", day, default=[])
    return result if isinstance(result, list) else []


def _safe_metabolic_age(value: Any) -> int | None:
    age = parse_int(value)
    return age if age is not None and 10 <= age <= 120 else None


def extract_body_metrics(body: Any) -> dict[str, Any]:
    total_average = body.get("totalAverage") if isinstance(body, dict) else None
    payload = total_average if isinstance(total_average, dict) else (body if isinstance(body, dict) else {})

    # Garmin API는 종종 grams 단위로 내려줌. 명시적 grams 키 우선 확인.
    weight_grams = first_number(payload, "weightInGrams", "weightGrams")
    if weight_grams is not None:
        weight = weight_grams / 1000
    else:
        weight = first_number(
            payload,
            "weightKg",
            "weightKG",
            "weightInKg",
            "bodyWeightKg",
            "weight",
            "bodyWeight",
            "totalWeight",
        )
        # 값이 있는데 200 초과면 grams으로 간주 (정상 체중 범위 가정)
        if weight is not None and weight > 200:
            weight = weight / 1000

    weigh_count = first_list_length(body, "dateWeightList", "weightSummaries", "allWeightMetrics", "weightEntries")
    if weight is not None and weigh_count == 0:
        weigh_count = 1

    return {
        "weight_kg": round_or_none(weight, 2),
        "weight_measure_count": weigh_count,
        "visceral_fat": round_or_none(
            first_number(payload, "visceralFat", "visceralFatRating", "visceralFatMass"),
            2,
        ),
        "metabolic_age": _safe_metabolic_age(first_number(payload, "metabolicAge", "bodyAge", "metabolicBodyAge")),
    }


def extract_sleep_hours(sleep: Any) -> float | None:
    dto = get_nested(sleep, "dailySleepDTO")
    sleep_seconds = first_number(dto, "sleepTimeSeconds")
    return round_or_none(None if sleep_seconds is None else sleep_seconds / 3600, 2)


def extract_resting_hr(stats: Any, heart_rates: Any, sleep: Any) -> float | None:
    for payload in (heart_rates, sleep, stats):
        number = first_number(payload, "restingHeartRate")
        if number is not None:
            return round_or_none(number, 0)
    return None


def extract_steps(stats: Any) -> int | None:
    if not isinstance(stats, dict):
        return None
    for key in ("totalSteps", "steps", "stepCount"):
        value = parse_int(stats.get(key))
        if value is not None:
            return value
    return None


def extract_activity_totals(activities: list[dict[str, Any]]) -> dict[str, Any]:
    total_minutes = 0.0
    total_calories = 0.0
    count = 0
    for activity in activities:
        if not isinstance(activity, dict):
            continue
        duration = first_number(activity, "duration", "movingDuration", "elapsedDuration", "durationInSeconds")
        calories = first_number(activity, "calories")
        if duration is not None and duration > 0:
            total_minutes += duration / 60
        if calories is not None and calories > 0:
            total_calories += calories
        count += 1
    return {
        "exercise_minutes": round_or_none(total_minutes, 1) if count else 0.0,
        "exercise_calories": round_or_none(total_calories, 0) if count else 0.0,
        "activity_count": count,
    }


def fetch_day_row(client: Any, day: str) -> dict[str, Any]:
    stats = safe_call(client, "get_stats", day, default={}) or {}
    heart_rates = safe_call(client, "get_heart_rates", day, default={}) or {}
    sleep = safe_call(client, "get_sleep_data", day, default={}) or {}
    body = safe_call(client, "get_body_composition", day, default={}) or {}
    activities = fetch_activities_for_date(client, day)

    body_metrics = extract_body_metrics(body)
    activity_totals = extract_activity_totals(activities)

    return {
        "date": day,
        "weight_kg": body_metrics["weight_kg"],
        "weight_measure_count": body_metrics["weight_measure_count"],
        "exercise_minutes": activity_totals["exercise_minutes"],
        "exercise_calories": activity_totals["exercise_calories"],
        "activity_count": activity_totals["activity_count"],
        "steps": extract_steps(stats),
        "sleep_hours": extract_sleep_hours(sleep),
        "resting_hr": extract_resting_hr(stats, heart_rates, sleep),
        "visceral_fat": body_metrics["visceral_fat"],
        "metabolic_age": body_metrics["metabolic_age"],
    }


def normalize_rows(rows: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for key in sorted(rows):
        row = {"date": key}
        for field in CSV_HEADERS[1:]:
            row[field] = rows[key].get(field)
        normalized.append(row)
    return normalized


def mean(values: list[float]) -> float | None:
    cleaned = [value for value in values if value is not None]
    if not cleaned:
        return None
    return sum(cleaned) / len(cleaned)


def rolling_average(weights_by_date: dict[str, float | None], all_dates: list[str], index: int, window_days: int) -> float | None:
    start = max(0, index - window_days + 1)
    values = []
    for position in range(start, index + 1):
        value = weights_by_date.get(all_dates[position])
        if value is not None:
            values.append(value)
    return round_or_none(mean(values), 2)


def build_prediction_series(
    latest_date: str | None,
    start_weight: float | None,
    weekly_loss_rate: float | None,
    multiplier: float,
    weeks: int = 12,
) -> list[dict[str, Any]]:
    if latest_date is None or start_weight is None or weekly_loss_rate is None or weekly_loss_rate <= 0:
        return []

    start_day = datetime.strptime(latest_date, "%Y-%m-%d").date()
    series = [{"date": latest_date, "valueKg": round(start_weight, 2)}]
    for week in range(1, weeks + 1):
        future_date = start_day + timedelta(days=7 * week)
        projected = start_weight - weekly_loss_rate * multiplier * week
        series.append({"date": future_date.isoformat(), "valueKg": round(projected, 2)})
    return series


def build_summary(rows: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    if not rows:
        return {
            "generatedAt": datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z",
            "current": {"weightKg": None, "weightDate": None, "weightMa7Kg": None, "weightMa14Kg": None},
            "rolling": {
                "weeklyLossRateKg": None,
                "last7ExerciseMinutes": 0,
                "last7ExerciseCalories": 0,
                "last7SleepHoursAvg": None,
                "last7RestingHrAvg": None,
                "last7WeightRangeKg": None,
            },
            "predictions": {"oneMonthWeightKg": None, "threeMonthWeightKg": None, "scenarios": {}},
            "goal": {
                "targetWeightKg": config.get("targetWeightKg"),
                "remainingKg": None,
                "etaDays": None,
                "etaDate": None,
            },
            "series": {"daily": [], "ma7": [], "ma14": [], "prediction": []},
        }

    all_dates = [row["date"] for row in rows]
    weights_by_date = {row["date"]: row.get("weight_kg") for row in rows}
    ma7_by_date = {}
    ma14_by_date = {}
    daily_series = []
    ma7_series = []
    ma14_series = []
    latest_weight_row = None

    for index, row in enumerate(rows):
        day = row["date"]
        weight = row.get("weight_kg")
        daily_series.append({"date": day, "valueKg": weight})
        ma7 = rolling_average(weights_by_date, all_dates, index, 7)
        ma14 = rolling_average(weights_by_date, all_dates, index, 14)
        ma7_by_date[day] = ma7
        ma14_by_date[day] = ma14
        ma7_series.append({"date": day, "valueKg": ma7})
        ma14_series.append({"date": day, "valueKg": ma14})
        if weight is not None:
            latest_weight_row = row

    latest_date = rows[-1]["date"]
    current_weight = latest_weight_row.get("weight_kg") if latest_weight_row else None
    weight_date = latest_weight_row.get("date") if latest_weight_row else None
    current_ma7 = ma7_by_date.get(latest_date)
    current_ma14 = ma14_by_date.get(latest_date)

    weekly_loss_rate = None
    if len(rows) >= 14:
        lookback_date = (datetime.strptime(latest_date, "%Y-%m-%d").date() - timedelta(days=14)).isoformat()
        previous_ma7 = ma7_by_date.get(lookback_date)
        if previous_ma7 is not None and current_ma7 is not None:
            weekly_loss_rate = round_or_none((previous_ma7 - current_ma7) / 2, 2)

    last7 = rows[-7:]
    sleep_values = [row.get("sleep_hours") for row in last7 if row.get("sleep_hours") is not None]
    rhr_values = [row.get("resting_hr") for row in last7 if row.get("resting_hr") is not None]
    weight_values = [row.get("weight_kg") for row in last7 if row.get("weight_kg") is not None]

    rolling = {
        "weeklyLossRateKg": weekly_loss_rate if weekly_loss_rate and weekly_loss_rate > 0 else None,
        "last7ExerciseMinutes": round(sum((row.get("exercise_minutes") or 0) for row in last7), 1),
        "last7ExerciseCalories": round(sum((row.get("exercise_calories") or 0) for row in last7), 0),
        "last7SleepHoursAvg": round_or_none(mean(sleep_values), 2),
        "last7RestingHrAvg": round_or_none(mean(rhr_values), 1),
        "last7WeightRangeKg": round_or_none((max(weight_values) - min(weight_values)) if len(weight_values) >= 2 else None, 2),
    }

    multipliers = config.get("scenarioMultipliers") or {}
    base_multiplier = parse_float(multipliers.get("base")) or 0.8
    optimistic_multiplier = parse_float(multipliers.get("optimistic")) or 1.0
    conservative_multiplier = parse_float(multipliers.get("conservative")) or 0.6

    effective_weekly_loss = None
    if weekly_loss_rate is not None and weekly_loss_rate > 0:
        effective_weekly_loss = weekly_loss_rate * base_multiplier

    one_month_weight = None
    three_month_weight = None
    if current_ma7 is not None and weekly_loss_rate is not None and weekly_loss_rate > 0:
        one_month_weight = round_or_none(current_ma7 - weekly_loss_rate * 4, 2)
        three_month_weight = round_or_none(current_ma7 - weekly_loss_rate * 12 * base_multiplier, 2)

    target_weight = parse_float(config.get("targetWeightKg"))
    remaining_kg = None
    eta_days = None
    eta_date = None
    if target_weight is not None and current_ma7 is not None:
        remaining_kg = round_or_none(current_ma7 - target_weight, 2)
        if remaining_kg <= 0:
            eta_days = 0
            eta_date = latest_date
        elif effective_weekly_loss and effective_weekly_loss > 0:
            eta_days = math.ceil((remaining_kg / effective_weekly_loss) * 7)
            eta_date = (datetime.strptime(latest_date, "%Y-%m-%d").date() + timedelta(days=eta_days)).isoformat()

    scenarios = {}
    if current_ma7 is not None and weekly_loss_rate is not None and weekly_loss_rate > 0:
        for name, multiplier in {
            "optimistic": optimistic_multiplier,
            "base": base_multiplier,
            "conservative": conservative_multiplier,
        }.items():
            scenarios[name] = {
                "multiplier": multiplier,
                "threeMonthWeightKg": round_or_none(current_ma7 - weekly_loss_rate * 12 * multiplier, 2),
            }

    return {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z",
        "current": {
            "weightKg": current_weight,
            "weightDate": weight_date,
            "weightMa7Kg": current_ma7,
            "weightMa14Kg": current_ma14,
        },
        "rolling": rolling,
        "predictions": {
            "oneMonthWeightKg": one_month_weight,
            "threeMonthWeightKg": three_month_weight,
            "scenarios": scenarios,
        },
        "goal": {
            "targetWeightKg": target_weight,
            "remainingKg": remaining_kg,
            "etaDays": eta_days,
            "etaDate": eta_date,
        },
        "series": {
            "daily": daily_series,
            "ma7": ma7_series,
            "ma14": ma14_series,
            "prediction": build_prediction_series(latest_date, current_ma7, weekly_loss_rate, base_multiplier),
        },
    }


def _row_is_empty(row: dict[str, Any]) -> bool:
    """핵심 필드가 전부 None/0 이면 API 실패로 간주."""
    key_fields = ("weight_kg", "steps", "sleep_hours", "resting_hr", "activity_count")
    return all(row.get(f) in (None, 0) for f in key_fields)


def sync_rows(args: argparse.Namespace, paths: Paths) -> list[dict[str, Any]]:
    existing_rows = load_existing_rows(paths.csv)
    if args.skip_garmin:
        return normalize_rows(existing_rows)

    end_day = datetime.strptime(args.date, "%Y-%m-%d").date() if args.date else date.today()
    client = build_client()
    for day in daterange(end_day, args.backfill_days):
        LOGGER.info("syncing %s", day)
        new_row = fetch_day_row(client, day)
        if _row_is_empty(new_row) and day in existing_rows:
            LOGGER.warning("all fields empty for %s — keeping existing data", day)
            continue
        existing_rows[day] = new_row

    write_rows(paths.csv, existing_rows)
    return normalize_rows(existing_rows)


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(message)s")
    paths = Paths(
        config=Path(args.config),
        csv=Path(args.output_csv),
        summary=Path(args.output_summary),
    )
    config = load_json(paths.config)
    rows = sync_rows(args, paths)
    summary = build_summary(rows, config)
    save_json(paths.summary, summary)
    LOGGER.info("wrote %s rows and refreshed %s", len(rows), paths.summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
