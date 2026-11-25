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
import re
from dataclasses import dataclass, field
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
warming_up_trend_exposure = _modeling.warming_up_trend_exposure
run_generalized_backtest = _modeling.run_generalized_backtest
apply_model_selection_gate = _modeling.apply_model_selection_gate
compute_ci_calibration_replay = _modeling.compute_ci_calibration_replay


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="garmin-weight/config.json")
    parser.add_argument("--output-csv", default="garmin-weight/data/daily_metrics.csv")
    parser.add_argument("--output-summary", default="garmin-weight/data/summary.json")
    parser.add_argument("--backfill-days", type=int, default=int(os.getenv("BACKFILL_DAYS", "3")))
    parser.add_argument("--date", default=None, help="Override end date (YYYY-MM-DD)")
    parser.add_argument("--skip-garmin", action="store_true", help="Only rebuild summary from CSV.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch from Garmin but write neither CSV nor summary; print call statistics as JSON.")
    parser.add_argument("--stats-output", default=None, help="With --dry-run, write the JSON report here instead of stdout.")
    parser.add_argument("--probe-activities-since", default=None,
                        help="With --dry-run, count activities per month from this date (one range query, no values).")
    parser.add_argument("--previous-summary", default="garmin-weight/data/summary.json",
                        help="Summary whose sync block is carried over (--skip-garmin) or extended.")
    parser.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO"))
    return parser.parse_args(argv)


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


# Garmin 호출 결과. "empty"는 호출은 성공했는데 내용이 없는 경우(HTTP 204 포함)다.
CALL_OK, CALL_EMPTY, CALL_FAILED = "ok", "empty", "failed"
CALL_STATUSES = (CALL_OK, CALL_EMPTY, CALL_FAILED)
# 수집에 쓰는 garminconnect 메서드. CI가 고정한 버전에 모두 있는지 확인한다.
GARMIN_METHODS = (
    "get_stats", "get_heart_rates", "get_sleep_data", "get_body_composition", "get_activities_fordate",
    "get_activities_by_date", "get_training_readiness", "get_training_status", "login",
)


def _http_status(exc: BaseException) -> int | None:
    """예외(와 그 원인 사슬)에 붙은 HTTP 상태 코드. garminconnect는 `exc.response`에 응답을 단다."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        for candidate in (getattr(current, "status_code", None),
                          getattr(getattr(current, "response", None), "status_code", None)):
            if isinstance(candidate, int):
                return candidate
        current = current.__cause__ or current.__context__
    return None


def describe_error(exc: BaseException) -> str:
    """공개 로그에 남길 수 있는 오류 설명. 예외 메시지에는 표시 이름이 든 URL이 섞일 수 있어 클래스와 상태만 쓴다."""
    status = _http_status(exc)
    return type(exc).__name__ + (f" status={status}" if status is not None else "")


def _is_empty_response(value: Any) -> bool:
    return value is None or (isinstance(value, (dict, list, tuple, str)) and len(value) == 0)


_SAFE_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_LONG_DIGITS = re.compile(r"\d{5,}")
STRUCTURE_MAX_DEPTH = 8


def _mask_key(key: Any) -> str:
    text = str(key)
    return text if _SAFE_KEY.match(text) and not _LONG_DIGITS.search(text) else "<id>"


def _merge_shapes(a: Any, b: Any) -> Any:
    if a is None:
        return b
    if b is None or a == b:
        return a
    if isinstance(a, str) and isinstance(b, str):
        return "|".join(sorted(set(a.split("|")) | set(b.split("|"))))
    if isinstance(a, dict) and isinstance(b, dict) and ("<list>" in a) == ("<list>" in b):
        merged = dict(a)
        for key, value in b.items():
            if key == "<list>":
                merged[key] = max(merged.get(key, 0), value)
            elif key == "<null>":
                merged[key] = True
            else:
                merged[key] = _merge_shapes(merged.get(key), value)
        return merged
    if isinstance(a, dict) and b == "null":
        return {**a, "<null>": True}
    if isinstance(b, dict) and a == "null":
        return {**b, "<null>": True}
    return {"<oneof>": [a, b]}


def describe_structure(value: Any, depth: int = 0) -> Any:
    """응답 구조만 남긴다. 값은 버리고 키·타입·리스트 길이만 둔다. 식별자처럼 보이는 키는 `<id>`로 가린다."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "str"
    if depth >= STRUCTURE_MAX_DEPTH:
        return "..."
    if isinstance(value, (list, tuple)):
        item: Any = None
        for entry in value:
            item = _merge_shapes(item, describe_structure(entry, depth + 1))
        return {"<list>": len(value), "<item>": item} if value else {"<list>": 0}
    if isinstance(value, dict):
        shape: dict[str, Any] = {}
        for key, entry in value.items():
            masked = _mask_key(key)
            shape[masked] = _merge_shapes(shape.get(masked), describe_structure(entry, depth + 1))
        return shape
    return type(value).__name__


@dataclass
class CallLog:
    """엔드포인트별 호출 결과 집계. keep_structures면 응답 구조(값 없음)도 모은다."""

    keep_structures: bool = False
    endpoints: dict[str, dict[str, int]] = field(default_factory=dict)
    errors: dict[str, dict[str, int]] = field(default_factory=dict)
    structures: dict[str, Any] = field(default_factory=dict)

    def record(self, endpoint: str, status: str, value: Any = None, error: str | None = None) -> None:
        counts = self.endpoints.setdefault(endpoint, {s: 0 for s in CALL_STATUSES})
        counts[status] += 1
        if error:
            per_endpoint = self.errors.setdefault(endpoint, {})
            per_endpoint[error] = per_endpoint.get(error, 0) + 1
        if self.keep_structures and status == CALL_OK:
            self.structures[endpoint] = _merge_shapes(self.structures.get(endpoint), describe_structure(value))

    def totals(self) -> dict[str, int]:
        return {s: sum(c[s] for c in self.endpoints.values()) for s in CALL_STATUSES}

    def failed_endpoints(self) -> list[str]:
        return sorted(name for name, counts in self.endpoints.items() if counts[CALL_FAILED])

    def status(self) -> str:
        totals = self.totals()
        if totals[CALL_FAILED] == 0:
            return "ok"
        return "partial" if totals[CALL_OK] + totals[CALL_EMPTY] else "failed"


def safe_call(client: Any, method_name: str, *args: Any, log: CallLog | None = None, **kwargs: Any) -> tuple[Any, str]:
    """(값, 상태)를 돌려준다. 상태는 ok/empty/failed. 실패는 예외 클래스와 HTTP 상태만 기록한다."""
    method = getattr(client, method_name, None)
    if not callable(method):
        LOGGER.warning("garmin endpoint=%s unavailable on client", method_name)
        if log is not None:
            log.record(method_name, CALL_FAILED, error="MethodUnavailable")
        return None, CALL_FAILED
    try:
        value = method(*args, **kwargs)
    except Exception as exc:
        error = describe_error(exc)
        LOGGER.warning("garmin endpoint=%s day=%s failed error=%s", method_name, args[0] if args else "", error)
        if log is not None:
            log.record(method_name, CALL_FAILED, error=error)
        return None, CALL_FAILED
    status = CALL_EMPTY if _is_empty_response(value) else CALL_OK
    if log is not None:
        log.record(method_name, status, value=value)
    return value, status


class MissingCredentials(RuntimeError):
    """자격 증명 시크릿이 없다. 메시지에 비밀 값이 없으므로 그대로 출력해도 된다."""


def build_client() -> tuple[Any, str]:
    """로그인한 클라이언트와 인증 방식("token"/"password")을 돌려준다."""
    from garminconnect import Garmin

    is_cn = os.getenv("GARMIN_IS_CN", "").lower() in ("1", "true", "yes")

    # 1순위: GARMIN_TOKENS (garth.dumps() 출력 base64 문자열)
    # garminconnect 0.3.x에는 garth가 없어 여기서 항상 AttributeError가 난다. P4에서 토큰 캐시로 바꾼다.
    token_b64 = os.getenv("GARMIN_TOKENS") or os.getenv("GARMIN_TOKENS_JSON")
    if token_b64:
        try:
            client = Garmin(is_cn=is_cn)
            client.garth.loads(token_b64)
            client.username  # 토큰 유효성 가벼운 검증
            LOGGER.info("auth: token reuse succeeded (garth.loads)")
            return client, "token"
        except Exception as exc:
            LOGGER.warning("token reuse failed (%s), falling back to password login", describe_error(exc))

    # 2순위: 이메일 + 패스워드
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    if not email or not password:
        raise MissingCredentials("No valid auth: set both GARMIN_EMAIL and GARMIN_PASSWORD")

    mfa_code = os.getenv("GARMIN_MFA_CODE")
    prompt_mfa = (lambda: mfa_code) if mfa_code else None
    client = Garmin(email, password, is_cn=is_cn, prompt_mfa=prompt_mfa)
    client.login()  # 실패하면 예외가 main까지 올라가 클래스와 상태만 기록된다.
    LOGGER.info("auth: password login succeeded")
    return client, "password"


def _activity_list(result: Any) -> list[Any] | None:
    if isinstance(result, dict):
        payload = result.get("ActivitiesForDay")
        if isinstance(payload, dict):
            payload = payload.get("payload")
        if isinstance(payload, list):
            return payload
    if isinstance(result, list):
        return result
    return None


def fetch_activities_for_date(client: Any, day: str, log: CallLog | None = None) -> tuple[list[Any] | None, str]:
    """(활동 목록, 상태). 두 경로가 모두 실패하면 목록은 None이다."""
    # python-garminconnect: get_activities_fordate (언더스코어 없음)
    result, status = safe_call(client, "get_activities_fordate", day, log=log)
    activities = _activity_list(result)
    if activities is not None:
        return activities, CALL_OK if activities else CALL_EMPTY
    fallback, fallback_status = safe_call(client, "get_activities_by_date", day, day, log=log)
    if isinstance(fallback, list):
        return fallback, CALL_OK if fallback else CALL_EMPTY
    if CALL_FAILED in (status, fallback_status):
        return None, CALL_FAILED
    return [], CALL_EMPTY


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


BODY_FIELDS = frozenset({"weight_kg", "weight_measure_count", "visceral_fat", "metabolic_age", "body_fat_percent"})
SLEEP_FIELDS = frozenset({"sleep_hours", "sleep_score"})
ACTIVITY_FIELDS = frozenset({"activity_count", "exercise_minutes", "exercise_calories"})
ROW_FIELDS = frozenset(CSV_HEADERS[1:])


@dataclass
class DayFetch:
    """하루치 수집 결과. failed_fields는 원천 호출이 실패해 값을 알 수 없는 필드다(행에는 None)."""

    row: dict[str, Any]
    failed_fields: set[str]
    sources: dict[str, str]


def _combine_fallback(primary: str, fallback: str) -> str:
    if fallback == CALL_OK:
        return CALL_OK
    return CALL_FAILED if CALL_FAILED in (primary, fallback) else CALL_EMPTY


def fetch_day_row(client: Any, day: str, log: CallLog | None = None) -> DayFetch:
    stats, stats_status = safe_call(client, "get_stats", day, log=log)
    heart_rates, hr_status = safe_call(client, "get_heart_rates", day, log=log)
    sleep, sleep_status = safe_call(client, "get_sleep_data", day, log=log)
    body, body_status = safe_call(client, "get_body_composition", day, log=log)
    activities, activities_status = fetch_activities_for_date(client, day, log=log)
    # V2 PR2: 컨텍스트 신호. 준비도가 비거나 실패하면 훈련 상태로 대신한다.
    training, training_status = safe_call(client, "get_training_readiness", day, log=log)
    if training_status != CALL_OK:
        training, status_fallback = safe_call(client, "get_training_status", day, log=log)
        training_status = _combine_fallback(training_status, status_fallback)

    stats = stats if isinstance(stats, dict) else {}
    failed: set[str] = set()
    if body_status == CALL_FAILED:
        failed |= BODY_FIELDS
    if stats_status == CALL_FAILED:
        failed.add("steps")
    if sleep_status == CALL_FAILED:
        failed |= SLEEP_FIELDS

    body_metrics = extract_body_metrics(body)

    resting_hr = extract_resting_hr(stats, heart_rates, sleep)
    if resting_hr is None and CALL_FAILED in (stats_status, hr_status, sleep_status):
        failed.add("resting_hr")

    if activities_status == CALL_FAILED:
        # 활동 값이 0보다 크면 일일 요약보다 우선하므로, 활동을 못 받은 날은 운동 값을 정할 수 없다.
        failed |= ACTIVITY_FIELDS
        activity_totals: dict[str, Any] = {name: None for name in ACTIVITY_FIELDS}
    else:
        activity_totals = extract_activity_totals(activities or [])
        # 활동이 없으면 일일 요약(stats)의 강도별 분/활동 칼로리로 보강한다.
        intensity_minutes = (parse_int(stats.get("moderateIntensityMinutes")) or 0) + 2 * (parse_int(stats.get("vigorousIntensityMinutes")) or 0)
        stats_fallback = {"exercise_minutes": intensity_minutes, "exercise_calories": parse_int(stats.get("activeKilocalories")) or 0}
        for name, fallback in stats_fallback.items():
            if activity_totals[name]:
                continue
            if stats_status == CALL_FAILED:
                failed.add(name)
            elif fallback > 0:
                activity_totals[name] = float(fallback)

    training_load = extract_training_load(training)
    if training_load is None and training_status == CALL_FAILED:
        failed.add("training_load_acute")

    row = {
        "date": day,
        "weight_kg": body_metrics["weight_kg"],
        "weight_measure_count": body_metrics["weight_measure_count"],
        "exercise_minutes": activity_totals["exercise_minutes"],
        "exercise_calories": activity_totals["exercise_calories"],
        "activity_count": activity_totals["activity_count"],
        "steps": extract_steps(stats),
        "sleep_hours": extract_sleep_hours(sleep),
        "resting_hr": resting_hr,
        "visceral_fat": body_metrics["visceral_fat"],
        "metabolic_age": body_metrics["metabolic_age"],
        "body_fat_percent": body_metrics["body_fat_percent"],
        "sleep_score": extract_sleep_score(sleep),
        "training_load_acute": training_load,
    }
    for name in failed:
        row[name] = None
    sources = {
        "stats": stats_status, "heart_rates": hr_status, "sleep": sleep_status, "body": body_status,
        "activities": activities_status, "training": training_status,
    }
    return DayFetch(row=row, failed_fields=failed, sources=sources)


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
        # 데이터가 없어도 소비자(체중 페이지, 개인 대시보드)가 읽는 키는 모두 둔다.
        return {
            "generatedAt": datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z",
            "current": {
                "weightKg": None, "weightDate": None, "weightMa7Kg": None, "weightMa14Kg": None, "weightEwmaKg": None,
                "bodyFatPercent": None, "bodyFatDelta30d": None, "visceralFat": None,
            },
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
                "exerciseTrend": build_exercise_trend([]),
                "lossRateDetail": {"blended": None, "rateSource": None, "model": "multi_window_ewma_blend"},
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
                "coverage": {"measuredDays": 0, "totalDays": 0, "pct": 0},
                "dataQuality": data_quality_diagnostics([]),
                "trend": model_trend_exposure(None, None),
                "trendWindows": {},
                "backtest": {},
            },
            "insight": {"headline": None, "lines": []},
            "coverage": {
                "last30Measured": 0,
                "last30Total": 0,
                "last30Pct": 0,
                "lastMeasurementAt": None,
                "daysSinceLastMeasurement": None,
            },
            "series": {
                "daily": [], "ma7": [], "ma14": [], "ewma": [], "prediction": [], "predictionCI": [],
                "steps": [], "exerciseMinutes": [], "exerciseCaloriesDaily": [],
            },
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

    def _latest_with_delta(key: str, delta_days: int = 30, digits: int = 1):
        """최신 유효값과 delta_days 이전 값과의 차이. 값이 없으면 (None, None)."""
        latest = latest_day = None
        for r in reversed(rows):
            v = parse_float(r.get(key))
            if v is not None:
                latest, latest_day = v, r["date"]
                break
        if latest is None:
            return None, None
        cutoff = (date.fromisoformat(latest_day) - timedelta(days=delta_days)).isoformat()
        past = None
        for r in reversed(rows):
            if r["date"] <= cutoff:
                v = parse_float(r.get(key))
                if v is not None:
                    past = v
                    break
        return round(latest, digits), (round(latest - past, digits) if past is not None else None)

    body_fat_percent_val, body_fat_delta_30d = _latest_with_delta("body_fat_percent")
    visceral_fat_val, _ = _latest_with_delta("visceral_fat", digits=0)

    kcal_to_kg_default = parse_float(config.get("kcalToKgFactor")) or 7700.0
    height_cm = parse_float(config.get("heightCm"))
    body_fat_pct: float | None = None
    for r in reversed(rows[-14:] if len(rows) > 14 else rows):
        v = parse_float(r.get("body_fat_percent"))
        if v is not None:
            body_fat_pct = v
            break
    kcal_to_kg, kcal_source = kcal_per_kg(body_fat_pct, current_weight, height_cm, default=kcal_to_kg_default)

    # EWMA slope 중심 + MA7 보조 감량률. 운동 kcal은 기본 예측에서 제외한다.
    trend_window = int(config.get("exerciseTrendWindow") or 28)
    loss_rate_detail = compute_weekly_loss_rate(
        ewma_series, ma7_by_date, rows, latest_date,
        window=trend_window, kcal_to_kg=kcal_to_kg,
    )
    weekly_loss_rate = loss_rate_detail["blended"]
    # 첫 측정 후 28일 창의 EWMA 점이 모자라면(대략 처음 13일) 감량률을 판단할 수 없다.
    # 이때는 예측을 숨기지 않고 현재 EWMA 수준을 그대로 잇는다(감량률 0으로 계산되는 평평한 예측).
    warming_up: tuple[int, int] | None = None
    if weekly_loss_rate is None and current_ewma is not None:
        warming_up = (
            loss_rate_detail["windowPoints"].get("28d", 0),
            loss_rate_detail["longWindowMinPoints"],
        )
    if warming_up:
        loss_rate_detail["rateSource"] = "cold_start_flat"
    else:
        loss_rate_detail["rateSource"] = "multi_window_blend" if weekly_loss_rate is not None else None

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

    trend_window = int(config.get("exerciseTrendWindow") or 28)
    exercise_trend = build_exercise_trend(rows, window=trend_window)
    pct_deltas = config.get("scenarioExercisePctDelta") or {}
    opt_pct = parse_float(pct_deltas.get("optimistic")) or 0.30
    con_pct = parse_float(pct_deltas.get("conservative")) or -0.30

    recent7_avg_kcal = exercise_trend["recent7Avg"] or 0.0
    base_trend_loss = weekly_loss_rate if weekly_loss_rate is not None else 0.0

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
            three_month_proj = _projected_weight(prediction_start, effective_loss, 12, target_weight)
            scenarios[name] = {
                "multiplier": round(effective_loss / base_trend_loss, 2) if base_trend_loss > 0 else 1.0,
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
    if prediction_start is not None:
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
        warming_up=warming_up,
    )

    data_quality = data_quality_diagnostics(rows)

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

    if warming_up:
        trend_display = warming_up_trend_exposure(*warming_up)
    else:
        recent_window_change = loss_rate_detail.get("windowSlopes", {}).get("7d")
        trend_display = model_trend_exposure(recent_window_change, weekly_loss_rate)
        trend_display["rateSource"] = loss_rate_detail["rateSource"]

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
            "bodyFatPercent": body_fat_percent_val,
            "bodyFatDelta30d": body_fat_delta_30d,
            "visceralFat": visceral_fat_val,
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


def merge_day_row(existing: dict[str, Any] | None, fetched: DayFetch) -> dict[str, Any]:
    """필드 단위 병합. 원천 호출이 실패한 필드는 기존 값을 유지하고, 성공했는데 값이 없을 때만 비운다."""
    row = dict(fetched.row)
    if existing:
        for name in fetched.failed_fields:
            row[name] = existing.get(name)
    return row


@dataclass
class SyncResult:
    rows: dict[str, dict[str, Any]]
    fetched: dict[str, DayFetch]
    log: CallLog
    kept_rows: list[str]


def sync_days(client: Any, days: list[str], existing_rows: dict[str, dict[str, Any]], log: CallLog) -> SyncResult:
    rows = dict(existing_rows)
    fetched_by_day: dict[str, DayFetch] = {}
    kept: list[str] = []
    for day in days:
        LOGGER.info("syncing %s", day)
        fetched = fetch_day_row(client, day, log=log)
        fetched_by_day[day] = fetched
        existing = existing_rows.get(day)
        if existing is None and fetched.failed_fields >= ROW_FIELDS:
            LOGGER.warning("garmin day=%s every call failed, no row created", day)
            continue
        merged = merge_day_row(existing, fetched)
        if existing is not None and _row_is_empty(merged) and not _row_is_empty(existing):
            # 모든 핵심 필드가 "성공했지만 비어 있음"인 날은 일시적인 빈 응답일 가능성이 커서 덮지 않는다.
            LOGGER.warning("garmin day=%s every key field came back empty, keeping existing row", day)
            kept.append(day)
            continue
        rows[day] = merged
    return SyncResult(rows=rows, fetched=fetched_by_day, log=log, kept_rows=kept)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z"


def annotate(level: str, message: str) -> None:
    """GitHub Actions 주석. 값이나 예외 메시지는 넣지 않는다."""
    print(f"::{level}::{message}", flush=True)


def report_calls(log: CallLog, auth: str) -> None:
    totals = log.totals()
    status = log.status()
    annotate("notice", f"garmin auth={auth} status={status} ok={totals[CALL_OK]} empty={totals[CALL_EMPTY]} failed={totals[CALL_FAILED]}")
    for endpoint in log.failed_endpoints():
        annotate("warning", f"garmin endpoint={endpoint} failed={log.endpoints[endpoint][CALL_FAILED]}")
    if status == "failed":
        annotate("error", "garmin every call failed; data left unchanged")


def load_previous_sync(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        previous = load_json(path).get("sync")
    except (OSError, ValueError) as exc:
        LOGGER.warning("previous summary unreadable (%s)", describe_error(exc))
        return None
    return previous if isinstance(previous, dict) else None


def build_sync_block(log: CallLog, auth: str, days: list[str], previous: dict[str, Any] | None, now: str) -> dict[str, Any]:
    status = log.status()
    return {
        "status": status,
        "auth": auth,
        "lastAttemptAt": now,
        "lastSuccessAt": now if status != "failed" else (previous or {}).get("lastSuccessAt"),
        "days": len(days),
        "endDate": days[-1] if days else None,
        "calls": log.totals(),
        "failedEndpoints": log.failed_endpoints(),
        "endpoints": {name: dict(counts) for name, counts in sorted(log.endpoints.items())},
    }


def build_probe_report(result: SyncResult, existing_rows: dict[str, dict[str, Any]], auth: str, days: list[str]) -> dict[str, Any]:
    """dry-run 보고서. 값은 넣지 않고 건수·상태·응답 구조만 넣는다."""
    try:
        from importlib.metadata import version
        library = version("garminconnect")
    except Exception:  # pragma: no cover - 로컬에는 garminconnect가 없을 수 있다
        library = None

    fields: dict[str, dict[str, int]] = {name: {"value": 0, "none": 0, "failed": 0} for name in CSV_HEADERS[1:]}
    merge: dict[str, dict[str, int]] = {name: {"same": 0, "changed": 0, "filled": 0, "cleared": 0, "kept": 0} for name in CSV_HEADERS[1:]}
    new_days = 0
    for day, fetched in result.fetched.items():
        for name in CSV_HEADERS[1:]:
            bucket = "failed" if name in fetched.failed_fields else ("none" if fetched.row.get(name) is None else "value")
            fields[name][bucket] += 1
        existing = existing_rows.get(day)
        if existing is None:
            new_days += 1
            continue
        merged = result.rows.get(day, existing)
        for name in CSV_HEADERS[1:]:
            before, after = existing.get(name), merged.get(name)
            if name in fetched.failed_fields or day in result.kept_rows:
                merge[name]["kept"] += 1
            elif before == after:
                merge[name]["same"] += 1
            elif before is None:
                merge[name]["filled"] += 1
            elif after is None:
                merge[name]["cleared"] += 1
            else:
                merge[name]["changed"] += 1
    return {
        "generatedAt": utc_now_iso(),
        "library": {"garminconnect": library},
        "auth": auth,
        "status": result.log.status(),
        "days": len(days),
        "endDate": days[-1] if days else None,
        "calls": result.log.totals(),
        "endpoints": {name: dict(counts) for name, counts in sorted(result.log.endpoints.items())},
        "errors": result.log.errors,
        "fields": fields,
        "mergeVsCsv": {"newDays": new_days, "keptRows": len(result.kept_rows), "fields": merge},
        "structures": result.log.structures,
    }


def probe_activity_history(client: Any, since: str, until: str) -> dict[str, Any]:
    """기간 조회 한 번으로 월별 활동 수만 센다(D1 판정용). 활동 내용은 남기지 않고 구조만 남긴다."""
    history_log = CallLog(keep_structures=True)
    activities, status = safe_call(client, "get_activities_by_date", since, until, log=history_log)
    by_month: dict[str, int] = {}
    for activity in activities if isinstance(activities, list) else []:
        start = activity.get("startTimeLocal") if isinstance(activity, dict) else None
        month = start[:7] if isinstance(start, str) and re.match(r"^\d{4}-\d{2}", start) else "unknown"
        by_month[month] = by_month.get(month, 0) + 1
    return {
        "since": since,
        "until": until,
        "status": status,
        "errors": history_log.errors,
        "total": sum(by_month.values()),
        "byMonth": dict(sorted(by_month.items())),
        "structure": history_log.structures.get("get_activities_by_date"),
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(message)s")
    paths = Paths(
        config=Path(args.config),
        csv=Path(args.output_csv),
        summary=Path(args.output_summary),
    )
    config = load_json(paths.config)
    previous_sync = load_previous_sync(Path(args.previous_summary))
    existing_rows = load_existing_rows(paths.csv)

    if args.skip_garmin:
        rows = normalize_rows(existing_rows)
        summary = build_summary(rows, config)
        summary["sync"] = previous_sync  # 수집하지 않았으므로 직전 수집 기록을 그대로 둔다.
        save_json(paths.summary, summary)
        LOGGER.info("rebuilt %s from %s rows", paths.summary, len(rows))
        return 0

    end_day = datetime.strptime(args.date, "%Y-%m-%d").date() if args.date else date.today()
    days = daterange(end_day, args.backfill_days)
    try:
        client, auth = build_client()
    except MissingCredentials as exc:
        annotate("error", str(exc))
        return 1
    except Exception as exc:
        annotate("error", f"garmin login failed error={describe_error(exc)}")
        return 1

    log = CallLog(keep_structures=args.dry_run)
    result = sync_days(client, days, existing_rows, log)
    report_calls(log, auth)
    failed = log.status() == "failed"

    if args.dry_run:
        probe = build_probe_report(result, existing_rows, auth, days)
        if args.probe_activities_since:
            probe["activityHistory"] = probe_activity_history(client, args.probe_activities_since, days[-1])
        report = json.dumps(probe, ensure_ascii=False, indent=2)
        if args.stats_output:
            Path(args.stats_output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.stats_output).write_text(report + "\n", encoding="utf-8")
        else:
            print(report)
        return 1 if failed else 0

    write_rows(paths.csv, result.rows)
    rows = normalize_rows(result.rows)
    summary = build_summary(rows, config)
    summary["sync"] = build_sync_block(log, auth, days, previous_sync, summary["generatedAt"])
    save_json(paths.summary, summary)
    LOGGER.info("wrote %s rows and refreshed %s", len(rows), paths.summary)
    # 전부 실패하면 작업을 실패시킨다. 커밋 스텝이 건너뛰어지고 GitHub가 실패를 알린다.
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
