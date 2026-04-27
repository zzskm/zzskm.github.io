#!/usr/bin/env python3
"""Sync daily Garmin aggregates and rebuild the public summary."""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import os
import statistics
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger("garmin_weight")
EWMA_LAMBDA = 0.1

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
        LOGGER.warning("%s not available on client", method_name)
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
    # python-garminconnect: get_activities_fordate (언더스코어 없음)
    result = safe_call(client, "get_activities_fordate", day, default=None)
    if isinstance(result, dict):
        payload = result.get("ActivitiesForDay")
        if isinstance(payload, dict):
            payload = payload.get("payload")
        if isinstance(payload, list):
            return payload
    if isinstance(result, list):
        return result
    fallback = safe_call(client, "get_activities_by_date", day, day, default=[])
    return fallback if isinstance(fallback, list) else []


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

    # 활동(activities)이 비어 있으면 일일 요약(stats)의 강도별 분/활동 칼로리로 보강.
    if not activity_totals["exercise_minutes"] and isinstance(stats, dict):
        mod = parse_int(stats.get("moderateIntensityMinutes")) or 0
        vig = parse_int(stats.get("vigorousIntensityMinutes")) or 0
        intensity_minutes = mod + 2 * vig
        if intensity_minutes > 0:
            activity_totals["exercise_minutes"] = float(intensity_minutes)
    if not activity_totals["exercise_calories"] and isinstance(stats, dict):
        active_kcal = parse_int(stats.get("activeKilocalories"))
        if active_kcal:
            activity_totals["exercise_calories"] = float(active_kcal)

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


def compute_ewma(weight_values: list[float | None], lambda_: float = EWMA_LAMBDA) -> list[float | None]:
    """Z_t = λ·X_t + (1-λ)·Z_{t-1}. None은 건너뛰고 직전 Z 유지."""
    z: float | None = None
    out: list[float | None] = []
    for x in weight_values:
        if x is not None:
            z = x if z is None else lambda_ * x + (1 - lambda_) * z
        out.append(round(z, 2) if z is not None else None)
    return out


def compute_prediction_ci(
    ewma_series: list[dict[str, Any]],
    weight_series: list[dict[str, Any]],
    weekly_loss_rate: float,
    prediction_weeks: int = 12,
) -> dict[str, Any]:
    """잔차(실측 - EWMA) std 기반 80% 예측 구간. sqrt(t)로 시간에 따라 확장."""
    ew_map = {p["date"]: p["valueKg"] for p in ewma_series if p["valueKg"] is not None}
    residuals = [
        p["valueKg"] - ew_map[p["date"]]
        for p in weight_series[-30:]
        if p["valueKg"] is not None and p["date"] in ew_map
    ]
    std = statistics.stdev(residuals) if len(residuals) >= 5 else 0.5

    last_valid = next((p for p in reversed(ewma_series) if p["valueKg"] is not None), None)
    if last_valid is None:
        return {"stdResidual": None, "series": []}

    start = last_valid["valueKg"]
    last_date = date.fromisoformat(last_valid["date"])
    series = []
    for week in range(1, prediction_weeks + 1):
        central = round(start - weekly_loss_rate * week, 2)
        spread80 = round(1.28 * std * (week ** 0.5), 2)
        series.append({
            "date": (last_date + timedelta(weeks=week)).isoformat(),
            "central": central,
            "lower80": round(central - spread80, 2),
            "upper80": round(central + spread80, 2),
        })
    return {"stdResidual": round(std, 3), "series": series}


def classify_loss_intensity(weekly_loss_kg: float | None, current_weight_kg: float | None) -> dict[str, Any] | None:
    """주당 체중 대비 감량 % 기준으로 강도 분류 (CDC/WHO 기준)."""
    if current_weight_kg is None or current_weight_kg <= 0 or weekly_loss_kg is None:
        return None
    weekly_pct = (weekly_loss_kg / current_weight_kg) * 100
    daily_deficit = weekly_loss_kg * 7700 / 7

    if weekly_loss_kg <= 0.05:
        level = "maintaining"
    elif weekly_pct < 0.3:
        level = "conservative"
    elif weekly_pct < 0.7:
        level = "standard"
    else:
        level = "aggressive"

    return {
        "level": level,
        "weeklyKg": round(weekly_loss_kg, 3),
        "weeklyPct": round(weekly_pct, 2),
        "dailyDeficitKcal": round(daily_deficit, 0),
    }


def detect_plateau(
    ewma_series: list[dict[str, Any]],
    threshold_kg_per_week: float = 0.05,
    min_days: int = 14,
) -> dict[str, Any]:
    """EWMA 기준 최근 min_days 동안 변화량이 threshold 미만이면 정체기."""
    recent = [p for p in ewma_series[-min_days:] if p.get("valueKg") is not None]
    if len(recent) < min_days:
        return {"detected": False, "startDate": None, "durationDays": 0, "weeklyChangeDelta": None}

    days = (date.fromisoformat(recent[-1]["date"]) - date.fromisoformat(recent[0]["date"])).days
    weekly_change = (recent[0]["valueKg"] - recent[-1]["valueKg"]) / (days / 7) if days > 0 else 0.0
    detected = abs(weekly_change) < threshold_kg_per_week
    return {
        "detected": detected,
        "startDate": recent[0]["date"] if detected else None,
        "durationDays": days if detected else 0,
        "weeklyChangeDelta": round(weekly_change, 3),
    }


def build_insight(
    current_kg: float | None,
    ewma_kg: float | None,
    intensity: dict[str, Any] | None,
    plateau: dict[str, Any] | None,
) -> dict[str, Any]:
    """자연어 코칭 메시지 생성. 프론트는 단순 표시만 담당."""
    lines: list[str] = []
    if ewma_kg is not None and current_kg is not None:
        diff = round(current_kg - ewma_kg, 2)
        if abs(diff) >= 0.3:
            direction = "수분 증가로 일시적 상승" if diff > 0 else "수분 감소로 일시적 하락"
            lines.append(f"오늘 {current_kg}kg이지만 추세는 {ewma_kg}kg — {direction}일 수 있어요.")

    if plateau and plateau.get("detected"):
        dur = plateau.get("durationDays", 0)
        lines.append(
            f"{dur}일째 정체 중이지만 대사 적응 과정의 정상 패턴입니다. "
            "운동량 10% ↑ 또는 식단 변화로 돌파해 보세요."
        )
    elif intensity:
        level = intensity.get("level")
        if level == "aggressive":
            lines.append("감량 속도가 빠릅니다. 단백질 충분 섭취로 근손실을 막아 주세요.")
        elif level == "standard":
            lines.append("CDC 권장 범위(주 0.5%) 안의 건강한 페이스입니다.")
        elif level == "conservative":
            lines.append("느리지만 지속 가능한 페이스 — 장기 유지에 유리합니다.")

    return {"headline": lines[0] if lines else None, "lines": lines}


def build_summary(rows: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    if not rows:
        return {
            "generatedAt": datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z",
            "current": {"weightKg": None, "weightDate": None, "weightMa7Kg": None, "weightMa14Kg": None, "weightEwmaKg": None},
            "rolling": {
                "weeklyLossRateKg": None,
                "last7ExerciseMinutes": 0,
                "last7ExerciseCalories": 0,
                "last7StepsTotal": 0,
                "last7StepsAvg": None,
                "last7ActiveDays": 0,
                "last7WeightRangeKg": None,
            },
            "predictions": {"oneMonthWeightKg": None, "threeMonthWeightKg": None, "scenarios": {}},
            "goal": {
                "targetWeightKg": config.get("targetWeightKg"),
                "remainingKg": None,
                "etaDays": None,
                "etaDate": None,
            },
            "lossIntensity": None,
            "plateau": {"detected": False, "startDate": None, "durationDays": 0, "weeklyChangeDelta": None},
            "predictionCI": {"stdResidual": None, "series": []},
            "insight": {"headline": None, "lines": []},
            "series": {"daily": [], "ma7": [], "ma14": [], "ewma": [], "prediction": [], "predictionCI": [], "steps": [], "exerciseMinutes": []},
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

    # EWMA 계산
    all_weights = [row.get("weight_kg") for row in rows]
    ewma_values = compute_ewma(all_weights)
    ewma_series = [{"date": all_dates[i], "valueKg": ewma_values[i]} for i in range(len(rows))]

    latest_date = rows[-1]["date"]
    current_weight = latest_weight_row.get("weight_kg") if latest_weight_row else None
    weight_date = latest_weight_row.get("date") if latest_weight_row else None
    current_ma7 = ma7_by_date.get(latest_date)
    current_ma14 = ma14_by_date.get(latest_date)
    current_ewma = ewma_values[-1] if ewma_values else None

    weekly_loss_rate = None
    if len(rows) >= 14:
        lookback_date = (datetime.strptime(latest_date, "%Y-%m-%d").date() - timedelta(days=14)).isoformat()
        previous_ma7 = ma7_by_date.get(lookback_date)
        if previous_ma7 is not None and current_ma7 is not None:
            weekly_loss_rate = round_or_none((previous_ma7 - current_ma7) / 2, 2)

    last7 = rows[-7:]
    weight_values = [row.get("weight_kg") for row in last7 if row.get("weight_kg") is not None]
    steps_values = [row.get("steps") for row in last7 if row.get("steps") is not None]
    active_days = sum(1 for row in last7 if (row.get("exercise_minutes") or 0) > 0)

    rolling = {
        "weeklyLossRateKg": weekly_loss_rate if weekly_loss_rate and weekly_loss_rate > 0 else None,
        "last7ExerciseMinutes": round(sum((row.get("exercise_minutes") or 0) for row in last7), 1),
        "last7ExerciseCalories": round(sum((row.get("exercise_calories") or 0) for row in last7), 0),
        "last7StepsTotal": sum(steps_values) if steps_values else 0,
        "last7StepsAvg": round_or_none(mean(steps_values), 0),
        "last7ActiveDays": active_days,
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

    # 고도화 계산
    effective_loss_for_ci = weekly_loss_rate if weekly_loss_rate and weekly_loss_rate > 0 else 0.0
    prediction_ci = compute_prediction_ci(ewma_series, daily_series, effective_loss_for_ci)
    loss_intensity = classify_loss_intensity(
        weekly_loss_rate if weekly_loss_rate and weekly_loss_rate > 0 else None,
        current_ewma,
    )
    plateau = detect_plateau(ewma_series)
    insight = build_insight(current_weight, current_ewma, loss_intensity, plateau)

    # 측정 커버리지 (최근 30일)
    last30 = rows[-30:]
    measured_count = sum(1 for r in last30 if r.get("weight_kg") is not None)
    coverage_pct = round(measured_count / len(last30) * 100, 0) if last30 else 0

    return {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z",
        "current": {
            "weightKg": current_weight,
            "weightDate": weight_date,
            "weightMa7Kg": current_ma7,
            "weightMa14Kg": current_ma14,
            "weightEwmaKg": current_ewma,
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
        "lossIntensity": loss_intensity,
        "plateau": plateau,
        "predictionCI": prediction_ci,
        "insight": insight,
        "coverage": {
            "last30Measured": measured_count,
            "last30Total": len(last30),
            "last30Pct": coverage_pct,
        },
        "series": {
            "daily": daily_series,
            "ma7": ma7_series,
            "ma14": ma14_series,
            "ewma": ewma_series,
            "prediction": build_prediction_series(latest_date, current_ewma, weekly_loss_rate, base_multiplier),
            "predictionCI": prediction_ci["series"],
            "steps": [
                {"date": row["date"], "value": row.get("steps")}
                for row in rows[-30:]
            ],
            "exerciseMinutes": [
                {"date": row["date"], "value": row.get("exercise_minutes") or 0}
                for row in rows[-30:]
            ],
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
