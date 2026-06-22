#!/usr/bin/env python3
"""Sync daily Garmin aggregates and rebuild the public summary."""

from __future__ import annotations

import argparse
import csv
import json
import importlib.util
import logging
import math
import os
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
    # V2 PR2: 컨텍스트 신호
    "body_fat_percent",
    "sleep_score",
    "training_load_acute",
]

# 정수 컬럼 (load/format에서 round 처리)
INT_CSV_COLUMNS = {
    "weight_measure_count",
    "activity_count",
    "steps",
    "metabolic_age",
    "sleep_score",
    "training_load_acute",
}


@dataclass
class Paths:
    config: Path
    csv: Path
    summary: Path


def _load_sibling_module(module_name: str) -> Any:
    module_path = Path(__file__).resolve().parent / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"{module_name} module not found")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_modeling = _load_sibling_module("sync_modeling")
build_smart_scenarios = _modeling.build_smart_scenarios
compute_calibration = _modeling.compute_calibration
kcal_per_kg = _modeling.kcal_per_kg
compute_weekly_loss_rate = _modeling.compute_weekly_loss_rate
build_exercise_trend = _modeling.build_exercise_trend
mean = _modeling.mean
rolling_average = _modeling.rolling_average
_projected_weight = _modeling._projected_weight
build_prediction_series = _modeling.build_prediction_series
measurement_weight = _modeling.measurement_weight
compute_ewma = _modeling.compute_ewma
compute_prediction_ci = _modeling.compute_prediction_ci
compute_trend_windows = _modeling.compute_trend_windows
backtest_predictions = _modeling.backtest_predictions
classify_prediction_confidence = _modeling.classify_prediction_confidence
classify_loss_intensity = _modeling.classify_loss_intensity
detect_plateau = _modeling.detect_plateau
build_insight = _modeling.build_insight
data_quality_diagnostics = _modeling.data_quality_diagnostics
model_trend_exposure = _modeling.model_trend_exposure
run_generalized_backtest = _modeling.run_generalized_backtest
apply_model_selection_gate = _modeling.apply_model_selection_gate
compute_ci_calibration_replay = _modeling.compute_ci_calibration_replay


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
    if field in INT_CSV_COLUMNS:
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
                if field in INT_CSV_COLUMNS:
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
            LOGGER.warning("garth.dumps() not available, set GARMIN_TOKENS manually")
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

    body_fat = first_number(
        payload,
        "bodyFat",
        "bodyFatPercentage",
        "bodyFatPercent",
        "fatPercentage",
        "percentFat",
    )
    # Garmin은 0~1 범위(소수)로도 0~100(%)로도 반환할 수 있어 정규화
    if body_fat is not None and body_fat <= 1.0:
        body_fat *= 100.0

    return {
        "weight_kg": round_or_none(weight, 2),
        "weight_measure_count": weigh_count,
        "visceral_fat": round_or_none(
            first_number(payload, "visceralFat", "visceralFatRating", "visceralFatMass"),
            2,
        ),
        "metabolic_age": _safe_metabolic_age(first_number(payload, "metabolicAge", "bodyAge", "metabolicBodyAge")),
        "body_fat_percent": round_or_none(body_fat, 1),
    }


def extract_sleep_hours(sleep: Any) -> float | None:
    dto = get_nested(sleep, "dailySleepDTO")
    sleep_seconds = first_number(dto, "sleepTimeSeconds")
    return round_or_none(None if sleep_seconds is None else sleep_seconds / 3600, 2)


def extract_sleep_score(sleep: Any) -> int | None:
    """Garmin 'overallSleepScore' (0-100). 다양한 응답 형태를 모두 시도."""
    dto = get_nested(sleep, "dailySleepDTO")
    # 최신 응답: dailySleepDTO.sleepScores.overall.value
    overall = get_nested(dto, "sleepScores", "overall")
    if isinstance(overall, dict):
        v = first_number(overall, "value", "score")
        if v is not None:
            return parse_int(v)
    # 구버전: dailySleepDTO.overallSleepScore (직접 숫자/딕셔너리)
    direct = get_nested(dto, "overallSleepScore")
    if isinstance(direct, dict):
        v = first_number(direct, "value", "score")
        if v is not None:
            return parse_int(v)
    if direct is not None:
        return parse_int(direct)
    # 또 다른 변형
    score = first_number(dto, "sleepScore", "overallSleepScoreValue")
    if score is not None:
        return parse_int(score)
    return None


def extract_training_load(training: Any) -> int | None:
    """급성 훈련 부하 (대개 0-1000+). 응답 키 변이가 많아 폭넓게 탐색."""
    if not isinstance(training, dict):
        return None
    # 1차: 직접 키
    v = first_number(
        training,
        "acuteTrainingLoad",
        "acuteLoad",
        "trainingLoadAcute",
        "load",
    )
    if v is not None:
        return parse_int(v)
    # 2차: 중첩
    for key in ("acuteTrainingLoadDTO", "trainingLoad", "training", "trainingStatus"):
        nested = training.get(key)
        if isinstance(nested, dict):
            v = first_number(nested, "acuteTrainingLoad", "acuteLoad", "value", "load")
            if v is not None:
                return parse_int(v)
    return None


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
    # V2 PR2: 컨텍스트 신호 — 엔드포인트가 없어도 sync는 계속 (safe_call이 default 반환)
    training = (
        safe_call(client, "get_training_readiness", day, default={})
        or safe_call(client, "get_training_status", day, default={})
        or {}
    )

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
        "body_fat_percent": body_metrics["body_fat_percent"],
        "sleep_score": extract_sleep_score(sleep),
        "training_load_acute": extract_training_load(training),
    }


def normalize_rows(rows: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for key in sorted(rows):
        row = {"date": key}
        for field in CSV_HEADERS[1:]:
            row[field] = rows[key].get(field)
        normalized.append(row)
    return normalized


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
                "last7SleepHoursAvg": None,
                "last7RestingHrAvg": None,
            },
            "predictions": {"oneMonthWeightKg": None, "threeMonthWeightKg": None, "scenarios": {}},
            "goal": {
                "targetWeightKg": config.get("targetWeightKg"),
                "remainingKg": None,
                "etaDays": None,
                "etaDate": None,
            },
            "lossIntensity": None,
            "plateau": {"detected": False, "startDate": None, "durationDays": 0, "weeklyChangeDelta": None, "type": None},
            "predictionCI": {"stdResidual": None, "series": []},
            "modelDiagnostics": {
                "confidence": {"level": "low", "label": "낮음", "score": 0, "reasons": ["데이터 없음"]},
                "trendWindows": {},
                "backtest": {},
            },
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

    # EWMA 계산 — Phase 4: 컨텍스트(수면 점수·훈련 부하)가 있으면 측정 가중치 적용
    all_weights = [row.get("weight_kg") for row in rows]
    ewma_weights = [measurement_weight(row) for row in rows]
    ewma_values = compute_ewma(all_weights, weights=ewma_weights)
    ewma_series = [{"date": all_dates[i], "valueKg": ewma_values[i]} for i in range(len(rows))]

    latest_date = rows[-1]["date"]
    current_weight = latest_weight_row.get("weight_kg") if latest_weight_row else None
    weight_date = latest_weight_row.get("date") if latest_weight_row else None
    current_ma7 = ma7_by_date.get(latest_date)
    current_ma14 = ma14_by_date.get(latest_date)
    current_ewma = ewma_values[-1] if ewma_values else None

    # EWMA slope 중심 + MA7 보조 감량률. 운동 kcal은 기본 예측에서 제외한다.
    trend_window = int(config.get("exerciseTrendWindow") or 28)
    kcal_to_kg_pre = parse_float(config.get("kcalToKgFactor")) or 7700.0
    loss_rate_detail = compute_weekly_loss_rate(
        ewma_series, ma7_by_date, rows, latest_date,
        window=trend_window, kcal_to_kg=kcal_to_kg_pre,
    )
    weekly_loss_rate = loss_rate_detail["blended"]

    last7 = rows[-7:]
    weight_values = [row.get("weight_kg") for row in last7 if row.get("weight_kg") is not None]
    steps_values = [row.get("steps") for row in last7 if row.get("steps") is not None]
    sleep_values = [parse_float(row.get("sleep_hours")) for row in last7]
    sleep_values = [v for v in sleep_values if v is not None]
    rhr_values = [parse_float(row.get("resting_hr")) for row in last7]
    rhr_values = [v for v in rhr_values if v is not None]
    active_days = sum(1 for row in last7 if (row.get("exercise_minutes") or 0) > 0)

    rolling = {
        "weeklyLossRateKg": weekly_loss_rate if weekly_loss_rate and weekly_loss_rate > 0 else None,
        "last7ExerciseMinutes": round(sum((row.get("exercise_minutes") or 0) for row in last7), 1),
        "last7ExerciseCalories": round(sum((row.get("exercise_calories") or 0) for row in last7), 0),
        "last7StepsTotal": sum(steps_values) if steps_values else 0,
        "last7StepsAvg": round_or_none(mean(steps_values), 0),
        "last7ActiveDays": active_days,
        "last7WeightRangeKg": round_or_none((max(weight_values) - min(weight_values)) if len(weight_values) >= 2 else None, 2),
        "last7SleepHoursAvg": round_or_none(mean(sleep_values), 2) if sleep_values else None,
        "last7RestingHrAvg": round_or_none(mean(rhr_values), 1) if rhr_values else None,
    }

    # --- 운동 칼로리 추이 ---
    kcal_to_kg_default = parse_float(config.get("kcalToKgFactor")) or 7700.0
    height_cm = parse_float(config.get("heightCm"))
    # body_fat: 최근 14일 내 마지막 유효값 사용 (체중계가 매일 측정 안 할 수 있음)
    body_fat_pct: float | None = None
    for r in reversed(rows[-14:] if len(rows) > 14 else rows):
        v = parse_float(r.get("body_fat_percent"))
        if v is not None:
            body_fat_pct = v
            break
    # Phase 2: 동적 kcal_per_kg — body_fat > BMI > default 우선순위
    kcal_to_kg, kcal_source = kcal_per_kg(body_fat_pct, current_weight, height_cm, default=kcal_to_kg_default)

    trend_window = int(config.get("exerciseTrendWindow") or 28)
    exercise_trend = build_exercise_trend(rows, window=trend_window)
    pct_deltas = config.get("scenarioExercisePctDelta") or {}
    opt_pct = parse_float(pct_deltas.get("optimistic")) or 0.30
    con_pct = parse_float(pct_deltas.get("conservative")) or -0.30

    recent7_avg_kcal = exercise_trend["recent7Avg"] or 0.0
    # 체중 증가 추세(음수)는 0으로 클리핑: 예측선이 현재 수준보다 위로 올라가지 않도록
    base_trend_loss = max(weekly_loss_rate, 0.0) if weekly_loss_rate is not None else 0.0

    # Phase 1A: 운동 효율 캘리브레이션 (kcal_to_kg는 위에서 정한 동적 값 사용)
    calibration = compute_calibration(rows, weekly_loss_rate, kcal_to_kg, window=trend_window)
    efficiency = calibration.get("exerciseEfficiency") or 1.0

    # Phase 6: 활동 로그 기반 시나리오 — 운동 세션 평균 kcal로 구체화
    smart_scenarios = build_smart_scenarios(
        exercise_trend, opt_pct, con_pct, recent7_avg_kcal,
    )

    target_weight = parse_float(config.get("targetWeightKg"))
    scenarios: dict[str, Any] = {}
    prediction_start = current_ewma if current_ewma is not None else current_ma7
    if prediction_start is not None:
        for name, sdef in smart_scenarios.items():
            extra_weekly_kcal = sdef["extra_weekly_kcal"]
            # Phase 2: 동적 kcal_to_kg · Phase 1A: 운동 효율 계수 적용
            extra_weekly_loss_kg = (extra_weekly_kcal / kcal_to_kg) * efficiency
            effective_loss = base_trend_loss + extra_weekly_loss_kg
            assumed_daily = round_or_none(recent7_avg_kcal + extra_weekly_kcal / 7.0, 1)
            # P3: 시나리오 3개월 예측도 지수 감쇠 사용
            three_month_proj = _projected_weight(prediction_start, max(effective_loss, 0.0), 12, target_weight)
            scenarios[name] = {
                "multiplier": sdef.get("multiplier", 0.8),  # 호환용 유지
                "threeMonthWeightKg": round_or_none(three_month_proj, 2),
                "assumedDailyKcal": assumed_daily,
                "weeklyKcalDelta": round_or_none(extra_weekly_kcal, 1),
                "extraWeeklyLossKg": round_or_none(extra_weekly_loss_kg, 4),
                "effectiveWeeklyLossKg": round_or_none(effective_loss, 4),
                "label": sdef["label"],
                "description": sdef["description"],
            }

    # base 시나리오의 effective_weekly_loss 를 예측/ETA/CI 에 사용
    base_effective_loss = scenarios.get("base", {}).get("effectiveWeeklyLossKg") or 0.0

    # P3: 1/3개월 예측도 지수 감쇠 외삽으로 통일
    one_month_weight = None
    three_month_weight = None
    if prediction_start is not None and base_effective_loss > 0:
        one_month_weight = round_or_none(_projected_weight(prediction_start, base_effective_loss, 4, target_weight), 2)
        three_month_weight = round_or_none(_projected_weight(prediction_start, base_effective_loss, 12, target_weight), 2)

    remaining_kg = None
    eta_days = None
    eta_date = None
    eta_range_days = None
    eta_range_dates = None
    if target_weight is not None and prediction_start is not None:
        remaining_kg = round_or_none(prediction_start - target_weight, 2)
        if remaining_kg <= 0:
            eta_days = 0
            eta_date = latest_date
        elif base_effective_loss > 0:
            eta_days = math.ceil((remaining_kg / base_effective_loss) * 7)
            eta_date = (datetime.strptime(latest_date, "%Y-%m-%d").date() + timedelta(days=eta_days)).isoformat()

    # 고도화 계산
    # P3/P4: target_weight + backtest를 CI에 주입하려면 backtest를 먼저 계산해야 한다.
    _early_backtest = backtest_predictions(
        rows, ewma_series, ma7_by_date,
        train_window=trend_window,
        target_weight=target_weight,
    )
    prediction_ci = compute_prediction_ci(
        ewma_series,
        daily_series,
        base_effective_loss,
        target_weight=target_weight,
        backtest=_early_backtest,
    )
    loss_intensity = classify_loss_intensity(
        base_effective_loss if base_effective_loss > 0 else None,
        current_ewma,
    )
    plateau = detect_plateau(ewma_series, rows=rows)
    insight = build_insight(current_weight, current_ewma, loss_intensity, plateau)

    # rolling에 exerciseTrend 추가
    rolling["exerciseTrend"] = exercise_trend
    rolling["lossRateDetail"] = loss_rate_detail

    # 측정 커버리지 (최근 30일)
    last30 = rows[-30:]
    measured_count = sum(1 for r in last30 if r.get("weight_kg") is not None)
    coverage_pct = round(measured_count / len(last30) * 100, 0) if last30 else 0

    # 마지막 측정일과 경과 일수
    # latest_date(CSV의 최신 일자)를 기준으로 계산해 UTC/KST 경계의 음수 결과를 방지한다.
    last_measurement_date: str | None = None
    for r in reversed(rows):
        if r.get("weight_kg") is not None:
            last_measurement_date = r["date"]
            break
    if last_measurement_date and latest_date:
        try:
            last_dt = date.fromisoformat(last_measurement_date)
            ref_dt = date.fromisoformat(latest_date)
            days_since = max((ref_dt - last_dt).days, 0)
        except Exception:
            days_since = None
    else:
        days_since = None

    if remaining_kg is not None and remaining_kg > 0 and scenarios:
        fast_loss = scenarios.get("optimistic", {}).get("effectiveWeeklyLossKg")
        slow_loss = scenarios.get("conservative", {}).get("effectiveWeeklyLossKg")
        if fast_loss and slow_loss and fast_loss > 0 and slow_loss > 0:
            min_eta = math.ceil((remaining_kg / fast_loss) * 7)
            max_eta = math.ceil((remaining_kg / slow_loss) * 7)
            base_day = datetime.strptime(latest_date, "%Y-%m-%d").date()
            eta_range_days = {"min": min_eta, "max": max_eta}
            eta_range_dates = {
                "min": (base_day + timedelta(days=min_eta)).isoformat(),
                "max": (base_day + timedelta(days=max_eta)).isoformat(),
            }

    trend_windows = compute_trend_windows(ewma_series, latest_date)
    backtest = _early_backtest  # CI 계산에 사용한 동일한 백테스트 결과 재사용

    # Phase 5: Kalman 필터 후보 모델 비교 (채택 결정용)
    kalman_comparison: dict[str, Any] | None = None
    try:
        # 같은 디렉토리의 모듈을 안전하게 로드 (실행 방식에 무관)
        import importlib.util as _ilu
        _kspec = _ilu.spec_from_file_location(
            "kalman_predictor",
            Path(__file__).resolve().parent / "kalman_predictor.py",
        )
        if _kspec is None or _kspec.loader is None:
            raise RuntimeError("kalman_predictor module not found")
        _kmod = _ilu.module_from_spec(_kspec)
        _kspec.loader.exec_module(_kmod)
        kalman_bt = _kmod.kalman_backtest(rows, train_window=trend_window)
        kalman_comparison = {
            "kalmanBacktest": kalman_bt,
            **_kmod.compare_backtests(backtest, kalman_bt),
        }
    except Exception as exc:  # 한 번이라도 실패해도 V1 흐름 영향 없음
        LOGGER.warning("kalman comparison skipped: %s", exc)
        kalman_comparison = {"error": str(exc)}

    confidence = classify_prediction_confidence(
        coverage_pct=coverage_pct,
        measured_days=measured_count,
        std_residual=prediction_ci.get("stdResidual"),
        backtests=backtest,
    )

    data_quality = data_quality_diagnostics(rows)
    trend_state = model_trend_exposure(loss_rate_detail.get("windowSlopes", {}).get("7d"), weekly_loss_rate)

    if trend_state.get("predictionEnabled") is False:
        one_month_weight = None
        three_month_weight = None
        if base_effective_loss <= 0:
            eta_days = None
            eta_date = None
            eta_range_days = None
            eta_range_dates = None

    shadow_audit = run_generalized_backtest(
        rows, ewma_series,
        candidate_names=["flat_baseline", "ma7_baseline", "ewma_baseline", "linear_regression_28d", "linear_regression_56d", "linear_regression_84d", "weighted_linear_regression_56d", "robust_regression_56d", "kalman"],
        train_window=trend_window,
    )
    shadow_audit_candidates = {k: v for k, v in shadow_audit.items() if k != "current_multi_window_ewma_blend"}
    selection_gate = apply_model_selection_gate(shadow_audit_candidates, backtest)

    ci_hit_series = prediction_ci.get("series") or []
    spread_by_horizon: dict[int, float] = {}
    for idx, row in enumerate(ci_hit_series, start=1):
        if idx not in (1, 2, 4):
            continue
        lower = parse_float(row.get("lower80"))
        upper = parse_float(row.get("upper80"))
        central = parse_float(row.get("central"))
        if lower is None or upper is None or central is None:
            continue
        spread_by_horizon[idx * 7] = max(abs(central - lower), abs(upper - central))

    def central_fn(horizon_days: int, cutoff_ewma: float | None, cutoff_values_prefix: list[float | None]) -> float | None:
        if cutoff_ewma is None or base_effective_loss <= 0:
            return None
        return _projected_weight(cutoff_ewma, base_effective_loss, max(round(horizon_days / 7), 1), target_weight)

    def spread_fn(horizon_days: int) -> float | None:
        return spread_by_horizon.get(horizon_days)

    ci_calibration = compute_ci_calibration_replay(
        rows,
        ewma_series,
        central_fn=central_fn,
        spread_fn=spread_fn,
        train_window=trend_window,
    )

    hit_rate = ci_calibration.get("hitRate", {})
    if "hitRate" not in prediction_ci:
        prediction_ci["hitRate"] = hit_rate
    prediction_ci["calibration"] = {
        "status": ci_calibration.get("status"),
        "targetHitRate": 0.8,
        "notes": [],
    }

    recent_window_change = loss_rate_detail.get("windowSlopes", {}).get("7d")
    trend_display = model_trend_exposure(recent_window_change, weekly_loss_rate)

    model_diagnostics = {
        "model": "multi_window_ewma_blend + exp_decay + dynamic_kcal_per_kg + exercise_efficiency",
        "confidence": confidence,
        "coverage": {
            "measuredDays": measured_count,
            "totalDays": len(last30),
            "pct": coverage_pct,
        },
        "dataQuality": data_quality,
        "trend": trend_display,
        "selectedModel": selection_gate,
        "trendWindows": trend_windows,
        "residualStdKg": prediction_ci.get("stdResidual"),
        "backtest": backtest,
        "modelAudit": shadow_audit_candidates,
        "kcalPerKg": round(kcal_to_kg, 0),
        "kcalPerKgSource": kcal_source,
        "calibration": calibration,
        "modelComparison": kalman_comparison,
        "ciCalibration": ci_calibration,
        "notes": [
            "기본 예측은 체중 추세 기반입니다.",
            "시나리오는 운동 효율 계수(NEAT·보상 섭취 보정)와 동적 kcal/kg 사용.",
            "28일 이상 예측은 장기 추정으로 취급합니다.",
        ],
    }

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
            "etaRangeDays": eta_range_days,
            "etaRangeDates": eta_range_dates,
        },
        "lossIntensity": loss_intensity,
        "plateau": plateau,
        "predictionCI": prediction_ci,
        "modelDiagnostics": model_diagnostics,
        "insight": insight,
        "coverage": {
            "last30Measured": measured_count,
            "last30Total": len(last30),
            "last30Pct": coverage_pct,
            "lastMeasurementAt": last_measurement_date,
            "daysSinceLastMeasurement": days_since,
        },
        "series": {
            "daily": daily_series,
            "ma7": ma7_series,
            "ma14": ma14_series,
            "ewma": ewma_series,
            "prediction": build_prediction_series(latest_date, current_ewma, base_effective_loss, target_weight=target_weight),
            "predictionCI": prediction_ci["series"],
            "steps": [
                {"date": row["date"], "value": row.get("steps")}
                for row in rows[-30:]
            ],
            "exerciseMinutes": [
                {"date": row["date"], "value": row.get("exercise_minutes") or 0}
                for row in rows[-30:]
            ],
            "exerciseCaloriesDaily": [
                {"date": row["date"], "value": parse_float(row.get("exercise_calories")) or 0}
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
            LOGGER.warning("all fields empty for %s, keeping existing data", day)
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
