#!/usr/bin/env python3
"""Prediction and model-quality helpers for the Garmin weight sync."""

from __future__ import annotations

import math
import statistics
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

EWMA_LAMBDA = 0.1


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


def _linreg_slope(xy_pairs: list[tuple[float, float]]) -> float | None:
    """단순 선형 회귀 slope. xy_pairs = [(x, y), ...]."""
    n = len(xy_pairs)
    if n < 3:
        return None
    xs = [p[0] for p in xy_pairs]
    ys = [p[1] for p in xy_pairs]
    xm = sum(xs) / n
    ym = sum(ys) / n
    num = sum((x - xm) * (y - ym) for x, y in zip(xs, ys))
    den = sum((x - xm) ** 2 for x in xs)
    return num / den if den != 0 else 0.0


SESSION_MIN_ACTIVITY_DAYS = 3


def average_session_kcal(rows: list[dict[str, Any]], window: int = 28) -> float | None:
    """최근 window일의 활동 기록(활동이 있는 날)에서 회당 kcal. 활동일이 SESSION_MIN_ACTIVITY_DAYS 미만이면 None.

    활동이 없는 날의 운동 kcal은 일일 요약의 하루 전체 활동 칼로리라서(exercise_source=intensity) 회당 값으로 쓰지 않는다(M9).
    """
    days = [
        row for row in rows[-window:]
        if (parse_int(row.get("activity_count")) or 0) > 0 and row.get("exercise_source") in (None, "activity")
    ]
    if len(days) < SESSION_MIN_ACTIVITY_DAYS:
        return None
    sessions = sum(parse_int(row.get("activity_count")) or 0 for row in days)
    kcal = sum(parse_float(row.get("exercise_calories")) or 0.0 for row in days)
    return kcal / sessions if sessions else None


def build_smart_scenarios(
    exercise_trend: dict[str, Any],
    opt_pct: float,
    con_pct: float,
    recent7_avg_kcal: float,
    session_kcal: float | None = None,
) -> dict[str, dict[str, Any]]:
    """활동 기록 기반 시나리오.

    최근 활동 기록이 있으면 회당 kcal로 "주2회 추가/누락"을 만든다. 없으면(활동 없이 일일 요약만 있는 기간)
    하루 활동 칼로리의 ±pct로 만든다. 예전에는 주 4회 운동을 가정해 일일 활동 칼로리로 회당 값을 지어냈다(M9).
    """
    avg_session_kcal = session_kcal or 0.0

    def _scenario(name: str, label: str, extra_kcal_per_week: float, desc: str, multiplier: float) -> dict[str, Any]:
        return {
            "label": label,
            "extra_weekly_kcal": extra_kcal_per_week,
            "description": desc,
            "multiplier": multiplier,
        }

    if avg_session_kcal >= 100:
        # 구체적 세션 기반 시나리오
        opt_extra = round(avg_session_kcal * 2, 0)        # +주2회
        con_extra = -round(avg_session_kcal * 2, 0)       # −주2회
        opt_desc = f"주2회 추가 운동 (회당 ~{round(avg_session_kcal)}kcal) 가정"
        con_desc = f"주2회 운동 누락 (회당 ~{round(avg_session_kcal)}kcal) 가정"
    else:
        # fallback: legacy pct 기반
        opt_extra = recent7_avg_kcal * opt_pct * 7
        con_extra = recent7_avg_kcal * con_pct * 7
        opt_desc = f"하루 활동량 +{opt_pct*100:.0f}% 가정"
        con_desc = f"하루 활동량 {con_pct*100:.0f}% 가정"

    return {
        "optimistic":   _scenario("optimistic",   "낙관",   opt_extra, opt_desc, 1.0),
        "base":         _scenario("base",         "기준",   0.0,        "현재 운동량 유지 기준 예측", 0.8),
        "conservative": _scenario("conservative", "보수적", con_extra, con_desc, 0.6),
    }


def compute_calibration(
    rows: list[dict[str, Any]],
    observed_weekly_loss: float | None,
    kcal_to_kg: float,
    window: int = 28,
    min_samples: int = 14,
) -> dict[str, Any]:
    """Phase 1A — intake-free 운동 효율 캘리브레이션.

    observed_weekly_loss(=blended)와 운동 칼로리에서 기대되는 감량을 비교해,
    "운동 효과가 실제 감량으로 얼마나 이어졌는가"를 0.3 ~ 1.5 범위로 산출.

    표본 부족 / 운동량 0 / 비정상 신호일 때는 1.0 (보정 없음).
    """
    if observed_weekly_loss is None or observed_weekly_loss <= 0:
        return {
            "exerciseEfficiency": None,
            "samples": 0,
            "windowDays": window,
            "interpretation": "감량 추세가 확인되지 않아 보정값을 계산하지 않습니다.",
        }

    sample_rows = rows[-window:] if len(rows) >= window else rows
    kcal_vals = [parse_float(r.get("exercise_calories")) or 0.0 for r in sample_rows]
    n = sum(1 for v in kcal_vals if v > 0)
    if n < min_samples:
        return {
            "exerciseEfficiency": None,
            "samples": n,
            "windowDays": window,
            "interpretation": f"표본 부족 ({n}/{min_samples}일) — 보정 비활성",
        }

    avg_kcal = sum(kcal_vals) / len(kcal_vals)
    expected_weekly_loss = avg_kcal * 7 / kcal_to_kg
    if expected_weekly_loss <= 0:
        return {
            "exerciseEfficiency": None,
            "samples": n,
            "windowDays": window,
            "interpretation": "운동량이 없어 보정값을 계산하지 않습니다.",
        }

    raw_ratio = observed_weekly_loss / expected_weekly_loss
    efficiency = max(0.3, min(1.5, raw_ratio))
    pct = round(efficiency * 100)
    if efficiency >= 1.1:
        msg = f"운동 효과가 기대보다 큽니다 ({pct}%) — 식이 통제도 기여 중."
    elif efficiency >= 0.85:
        msg = f"운동 효과가 기대치와 비슷합니다 ({pct}%)."
    else:
        msg = f"운동 효과의 {pct}%만 실제 감량으로 이어졌습니다 — NEAT 감소·보상 섭취 가능성."

    return {
        "exerciseEfficiency": round(efficiency, 3),
        "samples": n,
        "windowDays": window,
        "interpretation": msg,
    }


BODY_FAT_TIERS = ((30.0, 8000.0), (20.0, 7700.0), (15.0, 7200.0))
BODY_FAT_HYSTERESIS = 0.5


def body_fat_tier_value(history: list[float], hysteresis: float = BODY_FAT_HYSTERESIS) -> float | None:
    """체지방률 측정 이력(시간순)으로 kcal/kg 티어를 정한다. 경계를 ±hysteresis 넘게 지나야 티어가 바뀐다(M9).

    가장 최근 한 번만 보면 29~30% 근처에서 측정마다 7,700과 8,000이 오락가락했다.
    """
    def tier_of(value: float) -> int:
        for index, (edge, _) in enumerate(BODY_FAT_TIERS):
            if value >= edge:
                return index
        return len(BODY_FAT_TIERS)

    values = [v for v in history if v is not None and v > 0]
    if not values:
        return None
    tier = tier_of(values[0])
    for value in values[1:]:
        # tier_of는 값이 커질수록 작아진다(높은 체지방 티어 = 작은 번호). ±h를 빼고 더해도 다른 티어일 때만 옮긴다.
        if tier_of(value - hysteresis) < tier:
            tier = tier_of(value - hysteresis)
        elif tier_of(value + hysteresis) > tier:
            tier = tier_of(value + hysteresis)
    return BODY_FAT_TIERS[tier][1] if tier < len(BODY_FAT_TIERS) else 6500.0


def kcal_per_kg(
    body_fat_percent: float | None,
    weight_kg: float | None,
    height_cm: float | None,
    default: float = 7700.0,
) -> tuple[float, str]:
    """Phase 2 — 동적 에너지 밀도.

    체지방률이 있으면 Forbes-lite 티어, 없으면 BMI 티어, 둘 다 없으면 기본값.
    반환: (kcal_per_kg, source) where source ∈ {"body_fat","bmi","default"}
    """
    # 2A: body_fat_percent 기반 (가장 정확)
    if body_fat_percent is not None and body_fat_percent > 0:
        if body_fat_percent >= 30:
            return 8000.0, "body_fat"
        if body_fat_percent >= 20:
            return 7700.0, "body_fat"
        if body_fat_percent >= 15:
            return 7200.0, "body_fat"
        return 6500.0, "body_fat"

    # 2B: BMI 티어 (체지방 결손 시 폴백)
    if weight_kg is not None and height_cm is not None and height_cm > 0:
        bmi = weight_kg / ((height_cm / 100.0) ** 2)
        if bmi >= 30:
            return 8000.0, "bmi"
        if bmi >= 25:
            return 7700.0, "bmi"
        if bmi >= 22:
            return 7400.0, "bmi"
        return 7000.0, "bmi"

    return default, "default"


def _slope_over_window(
    series_map: dict[str, float | None],
    end_day: date,
    window: int,
    min_points: int = 3,
) -> tuple[float | None, int]:
    """단일 윈도우 선형 회귀 slope (kg/day, 음수=감소). 표본 부족 시 (None, 점수)."""
    pts = []
    for i in range(window + 1):
        d = (end_day - timedelta(days=window - i)).isoformat()
        v = series_map.get(d)
        if v is not None:
            pts.append((float(i), v))
    if len(pts) < min_points:
        return None, len(pts)
    return _linreg_slope(pts), len(pts)


def compute_weekly_loss_rate(
    ewma_series: list[dict[str, Any]],
    ma7_by_date: dict[str, float | None],
    rows: list[dict[str, Any]],
    latest_date: str,
    window: int = 28,  # 호환성 유지용 (다중 윈도우에서는 무시)
    kcal_to_kg: float = 7700.0,
    weights: tuple[float, float, float] = (0.65, 0.35, 0.0),  # 호환성 유지용
) -> dict[str, Any]:
    """다중 윈도우 EWMA slope 블렌딩 기반 주간 감량률.

    P2 개선: 28일 단일 EWMA+MA7 회귀(거의 동일 신호)를 3/7/14/28일 EWMA slope 합성으로 교체.
    가중치는 최근에 더 큰 비중 → 추세 가속이 빨리 반영되어 변동폭 증가.

    반환:
      blended   - 최종 합성값 (kg/주, 양수=감소).
      ewmaSlope - 28일 EWMA slope (legacy 호환)
      ma7Slope  - 7일 EWMA slope을 노출 (legacy 키로 매핑)
      kcalRate  - 운동 칼로리 기반 기대 감량률 참고값(시나리오 전용)
      weights   - 사용된 윈도우 가중치 (단기/중기/장기)
      windowSlopes - {"3d":..., "7d":..., "14d":..., "28d":...} 각 윈도우 kg/주
    """
    end = date.fromisoformat(latest_date)

    # EWMA map은 모든 윈도우가 공유
    ewma_map: dict[str, float | None] = {p["date"]: p["valueKg"] for p in ewma_series if p.get("valueKg") is not None}

    # 윈도우별 slope (kg/주, 양수=감소)
    # 윈도우별 (목표가중치, 최소표본수)
    # 28d는 충분히 긴 history가 있어야만 인정 — 데이터가 부족하면 blended를 끄는 게이트 역할.
    window_specs = [
        ("3d", 3, 0.10, 3),     # 매우 단기 - 노이즈 크므로 가중치 낮음
        ("7d", 7, 0.30, 5),     # 단기 - 최근 트렌드 핵심
        ("14d", 14, 0.35, 10),  # 중기 - 안정성
        ("28d", 28, 0.25, 14),  # 장기 - 베이스라인 (가드 역할)
    ]
    window_slopes: dict[str, float | None] = {}
    window_points: dict[str, int] = {}
    window_used_weight: dict[str, float] = {}
    components: list[tuple[float, float]] = []
    for key, w_days, target_w, min_pts in window_specs:
        raw, n = _slope_over_window(ewma_map, end, w_days, min_points=min_pts)
        window_points[key] = n
        weekly = -raw * 7 if raw is not None else None
        window_slopes[key] = round(weekly, 4) if weekly is not None else None
        if weekly is not None:
            components.append((weekly, target_w))
            window_used_weight[key] = target_w
        else:
            window_used_weight[key] = 0.0

    # 충분한 표본 가드: 28일 슬로프 (가장 엄격한 최소 표본수)가 존재해야만 blended를 만든다.
    has_long_window = window_slopes.get("28d") is not None
    if components and has_long_window:
        total_w = sum(w for _, w in components)
        blended = round(sum(v * w for v, w in components) / total_w, 4)
        normalized_weights = {k: round(w / total_w, 3) for k, w in window_used_weight.items()}
    else:
        blended = None
        normalized_weights = {k: 0.0 for k in window_used_weight}

    # 장기 값(12주 예측과 목표 도달일)에 쓰는 느린 감량률: 28일과 56일 기울기의 평균이다(재검토 MD2).
    # 56일 창에 점이 모자라면(이력이 짧다) 28일 기울기만 쓴다. 혼합 감량률을 만들 수 없으면 이것도 없다.
    raw_long, long_points = _slope_over_window(ewma_map, end, LONG_RATE_WINDOW_DAYS, min_points=LONG_RATE_MIN_POINTS)
    long_slope = round(-raw_long * 7, 4) if raw_long is not None else None
    long_parts = [value for value in (window_slopes.get("28d"), long_slope) if value is not None]
    long_range_rate = round(sum(long_parts) / len(long_parts), 4) if blended is not None and long_parts else None

    # 운동 칼로리 기대 감량률 (참고값, 시나리오에서만 사용)
    kcal_rows = rows[-14:] if len(rows) >= 14 else rows
    kcal_vals = [parse_float(r.get("exercise_calories")) or 0.0 for r in kcal_rows]
    avg_daily_kcal = sum(kcal_vals) / len(kcal_vals) if kcal_vals else 0.0
    kcal_rate = round_or_none(avg_daily_kcal * 7 / kcal_to_kg, 4)

    return {
        "blended": blended,
        # 12주 예측과 목표 도달일이 쓰는 감량률과 그 재료(kg/주, 양수 = 감량).
        "longRangeRate": long_range_rate,
        "longRangeSlopes": {"28d": window_slopes.get("28d"), f"{LONG_RATE_WINDOW_DAYS}d": long_slope},
        "longRangePoints": long_points,
        "ewmaSlope": window_slopes.get("28d"),  # legacy 호환
        "ma7Slope": window_slopes.get("7d"),    # legacy 호환 (단기 신호로 재매핑)
        "kcalRate": kcal_rate,
        "weights": {  # legacy 키 유지 + 신규 윈도우 가중치
            "ewma": normalized_weights.get("28d", 0.0),
            "ma7": normalized_weights.get("7d", 0.0),
            "kcal": 0.0,
            "windows": normalized_weights,
        },
        "windowSlopes": window_slopes,
        "windowPoints": window_points,
        # blended를 만들려면 28일 창에 이만큼의 EWMA 점이 있어야 한다(위 window_specs의 가드).
        "longWindowMinPoints": next(spec[3] for spec in window_specs if spec[0] == "28d"),
        "model": "multi_window_ewma_blend",
    }


def build_exercise_trend(rows: list[dict[str, Any]], window: int = 28) -> dict[str, Any]:
    """최근 운동 칼로리 추이 계산 (recent7 vs prev21)."""
    if not rows:
        return {"recent7Avg": 0.0, "prev21Avg": 0.0, "deltaPct": 0.0, "slopePerDay": 0.0, "direction": "stable"}

    def avg_kcal(segment: list[dict[str, Any]]) -> float:
        vals = [parse_float(r.get("exercise_calories")) or 0.0 for r in segment]
        return sum(vals) / len(vals) if vals else 0.0

    last_n = rows[-window:] if len(rows) >= window else rows
    recent7 = last_n[-7:] if len(last_n) >= 7 else last_n

    if len(last_n) >= 14:
        prev_segment = last_n[:-7]  # up to 21 days before recent7
    elif len(last_n) > 7:
        prev_segment = last_n[:-7]
    else:
        prev_segment = recent7  # fallback: same as recent

    recent7_avg = avg_kcal(recent7)
    prev_avg = avg_kcal(prev_segment)
    delta_pct = (recent7_avg - prev_avg) / max(prev_avg, 1.0)

    # Linear regression slope (kcal/day per day)
    n = len(last_n)
    if n >= 2:
        ys = [parse_float(r.get("exercise_calories")) or 0.0 for r in last_n]
        x_mean = (n - 1) / 2
        y_mean = sum(ys) / n
        num = sum((i - x_mean) * (y - y_mean) for i, y in enumerate(ys))
        den = sum((i - x_mean) ** 2 for i in range(n))
        slope = num / den if den != 0 else 0.0
    else:
        slope = 0.0

    if delta_pct > 0.05:
        direction = "increasing"
    elif delta_pct < -0.05:
        direction = "decreasing"
    else:
        direction = "stable"

    return {
        "recent7Avg": round_or_none(recent7_avg, 1),
        "prev21Avg": round_or_none(prev_avg, 1),
        "deltaPct": round_or_none(delta_pct, 3),
        "slopePerDay": round_or_none(slope, 2),
        "direction": direction,
    }

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


def _projected_weight(
    start_weight: float,
    effective_weekly_loss: float,
    week: float,
    target_weight: float | None = None,
) -> float:
    """감쇠 곡선 w(t) = target + gap·exp(−k·t), k = 감량률 / gap (t는 주).

    t=0의 기울기가 감량률과 같아 곡선이 처음에는 추세를 그대로 따르고 목표로 수렴한다(M5 a안, 2026-11-25).
    예전에는 k를 2·ln2/16(주 0.087)로 묶어 목표가 가까우면 초기 기울기가 추세보다 훨씬 완만했고 시나리오가 한 곡선이 됐다.
    남은 간격이 한 주 감량보다 작을 때만 k를 1/주로 묶는다(보호).
    목표가 없거나, 이미 목표 이하이거나, 감량률이 0 이하(유지·증량)이면 직선이다.
    """
    if target_weight is None or target_weight >= start_weight or effective_weekly_loss <= 0:
        return start_weight - effective_weekly_loss * week
    gap = start_weight - target_weight
    k = min(effective_weekly_loss / gap, 1.0)
    return target_weight + gap * math.exp(-k * week)


# 장기 값에는 느린 감량률을 쓴다(재검토 MD2, 2026-11-25 사용자 결정: 곡선 모양은 그대로 두고 12주 값과 목표 도달일에만).
# 혼합 감량률은 3·7일 창의 비중이 0.40이라, 측정 한 번에 12주 값이 0.5kg 넘게 움직이고 도달일이 수백 일씩 오갔다.
LONG_RATE_FROM_WEEK = 4     # 이 주까지는 혼합 감량률의 곡선 그대로다(1개월 값과 7·14·28일 성적이 바뀌지 않는다)
LONG_RATE_FULL_WEEK = 12    # 이 주부터는 느린 감량률의 곡선이다
LONG_RATE_WINDOW_DAYS = 56  # 느린 감량률 = 28일 기울기와 이 창의 기울기의 평균
LONG_RATE_MIN_POINTS = 28


def forecast_weight(
    start_weight: float,
    weekly_loss: float,
    week: float,
    target_weight: float | None = None,
    long_weekly_loss: float | None = None,
) -> float:
    """운영 모델의 예측 체중(week주 뒤). 예측선, 시나리오, 80% 구간의 중심, 목표 도달일, 백테스트가 모두 이 함수를 쓴다.

    4주까지는 혼합 감량률(weekly_loss)의 감쇠 곡선이고 12주부터는 느린 감량률(long_weekly_loss)의 감쇠 곡선이다.
    그 사이는 느린 감량률의 곡선에, 4주까지 벌어진 두 곡선의 차이를 12주까지 고르게 줄여 가며 더한다.
    두 감량률이 같으면 모든 기간이 한 곡선이다. long_weekly_loss가 None이면 혼합 감량률의 곡선만 쓴다.
    두 감량률이 크게 다르면(최근 며칠에 급히 빠졌을 때) 선이 4주 뒤에 방향을 바꾼다. 최근 추세와 긴 추세가 다르다는 뜻이다.
    """
    if long_weekly_loss is None or week <= LONG_RATE_FROM_WEEK:
        return _projected_weight(start_weight, weekly_loss, week, target_weight)
    far = _projected_weight(start_weight, long_weekly_loss, week, target_weight)
    if week >= LONG_RATE_FULL_WEEK:
        return far
    gap = (_projected_weight(start_weight, weekly_loss, LONG_RATE_FROM_WEEK, target_weight)
           - _projected_weight(start_weight, long_weekly_loss, LONG_RATE_FROM_WEEK, target_weight))
    return far + gap * (LONG_RATE_FULL_WEEK - week) / (LONG_RATE_FULL_WEEK - LONG_RATE_FROM_WEEK)


ETA_TOLERANCE_KG = 0.3
ETA_MAX_WEEKS = 104


def projected_eta(
    start_weight: float | None,
    weekly_loss: float | None,
    target_weight: float | None,
    tolerance_kg: float = ETA_TOLERANCE_KG,
    max_weeks: int = ETA_MAX_WEEKS,
    long_weekly_loss: float | None = None,
) -> tuple[str, int | None]:
    """예측 곡선(forecast_weight)이 목표 + tolerance_kg 이하로 처음 내려가는 날(오늘부터 일 수)과 상태.

    상태: reached(이미 목표 + tolerance 이하) / date / beyond(max_weeks 안에 닿지 않음) / no_loss(감량 추세 아님) / unknown.
    tolerance 기본값 0.3kg은 일별 실측과 추세의 평균 차이(0.44kg)보다 작게 잡은 값이다. 감쇠 곡선은 목표에 닿지 않으므로
    목표 자체를 기준으로 하면 ETA가 무한이 된다.
    12주 뒤부터는 느린 감량률의 곡선이므로 도달일은 대개 느린 감량률이 정한다. 곡선이 닿지 않을 때, 느린 감량률이
    감량이면 beyond이고 아니면 no_loss다(최근 며칠이 감량이어도 긴 추세가 감량이 아니면 도달일을 내지 않는다).
    """
    if start_weight is None or target_weight is None:
        return "unknown", None
    if start_weight - target_weight <= tolerance_kg:
        return "reached", 0
    if weekly_loss is None:
        return "no_loss", None
    deciding = long_weekly_loss if long_weekly_loss is not None else weekly_loss
    if weekly_loss <= 0 and deciding <= 0:
        return "no_loss", None
    for day in range(1, max_weeks * 7 + 1):
        if forecast_weight(start_weight, weekly_loss, day / 7, target_weight, long_weekly_loss) <= target_weight + tolerance_kg:
            return "date", day
    return ("beyond" if deciding > 0 else "no_loss"), None


def build_scenario_series(
    latest_date: str,
    start_weight: float,
    weekly_loss: float,
    target_weight: float | None,
    spreads_by_week: dict[int, float],
    weeks: int = 12,
    long_weekly_loss: float | None = None,
) -> list[dict[str, Any]]:
    """시나리오 하나의 예측 시계열(0~weeks주, weeks+1점)과 80% 구간. 카드 값과 차트 선이 같은 계산이다(M6)."""
    start_day = date.fromisoformat(latest_date)
    series = []
    for week in range(weeks + 1):
        central = round(forecast_weight(start_weight, weekly_loss, week, target_weight, long_weekly_loss), 2)
        spread = spreads_by_week.get(week, 0.0) if week else 0.0
        series.append({
            "date": (start_day + timedelta(days=7 * week)).isoformat(),
            "valueKg": central,
            "lower80": round(central - spread, 2),
            "upper80": round(central + spread, 2),
        })
    return series


def build_prediction_series(
    latest_date: str | None,
    start_weight: float | None,
    effective_weekly_loss: float | None,
    weeks: int = 12,
    target_weight: float | None = None,
    long_weekly_loss: float | None = None,
) -> list[dict[str, Any]]:
    """예측 시리즈 생성. P3에서 지수 감쇠로 변경 — 장기 horizon의 과대 추정 완화."""
    if latest_date is None or start_weight is None or effective_weekly_loss is None:
        return []

    start_day = datetime.strptime(latest_date, "%Y-%m-%d").date()
    series = [{"date": latest_date, "valueKg": round(start_weight, 2)}]
    for week in range(1, weeks + 1):
        future_date = start_day + timedelta(days=7 * week)
        projected = forecast_weight(start_weight, effective_weekly_loss, week, target_weight, long_weekly_loss)
        series.append({"date": future_date.isoformat(), "valueKg": round(projected, 2)})
    return series


def measurement_weight(row: dict[str, Any], use_sleep: bool = True, use_load: bool = True) -> float:
    """Phase 4 — 컨텍스트 기반 측정 신뢰도 가중치 (0.5 ~ 1.0).

    수면 부족·급격한 훈련 부하 증가는 수분 정체/글리코겐 변동을 일으켜 그날
    체중을 추세 신호가 아닌 잡음으로 만든다. 신뢰도가 낮을수록 EWMA 업데이트
    비중을 줄여 추세선이 노이즈에 끌려가지 않게 한다.
    """
    w = 1.0
    score = parse_float(row.get("sleep_score")) if use_sleep else None
    if score is not None and score < 60:
        w *= 0.7  # 수면 점수 60 미만 → 수분 정체 가능성
    load = parse_int(row.get("training_load_acute")) if use_load else None
    if load is not None and load >= 400:
        w *= 0.85  # 급성 부하 매우 높음 → 글리코겐/수분 저장 가능성
    return max(w, 0.4)


# 측정 하나가 추세에서 이만큼 넘게 벗어나 있으면, 이만큼만 벗어난 것으로 보고 추세에 반영한다(재검토 MD8).
# 다른 사람이 잰 값 같은 잘못된 측정 한 건이 추세·예측·ETA를 끌고 가지 못하게 한다. 0.8kg은 일별 실측과 추세의
# 차이(표준편차 0.3~0.5kg)의 약 2배다. 실제 이력에서 측정의 약 5분의 1이 이 선을 넘는다.
EWMA_UPDATE_LIMIT_KG = 0.8
# 같은 방향으로 이 횟수만큼 연속으로 벗어나면 잘못된 측정이 아니라 실제 변화로 보고, 그 측정부터 그대로 반영한다.
# 제한만 두면 2.5kg의 실제 변화를 따라잡는 데 25일이 걸린다(제한이 없으면 15일, 3회 뒤에 풀면 17일).
EWMA_LIMIT_RELEASE_AFTER = 3


def ewma_with_limits(
    weight_values: list[float | None],
    lambda_: float = EWMA_LAMBDA,
    weights: list[float] | None = None,
    limit_kg: float | None = EWMA_UPDATE_LIMIT_KG,
    release_after: int | None = EWMA_LIMIT_RELEASE_AFTER,
) -> tuple[list[float | None], list[bool]]:
    """(EWMA 값, 측정마다 반영이 제한됐는지).

    Z_t = λ_eff·X_t + (1 − λ_eff)·Z_{t-1}. None은 건너뛰고 직전 Z를 유지한다.
    weights가 있으면 그 날의 가중치만큼 λ를 줄인다(λ_eff = λ·w, 1.0이면 그대로).
    X_t가 Z_{t-1}에서 limit_kg 넘게 벗어나 있으면 X_t 대신 Z_{t-1} ± limit_kg를 넣는다. 같은 방향으로
    release_after번 연속 벗어나면 X_t를 그대로 넣는다. limit_kg가 None이면 제한이 없다.
    제한에 걸리지 않는 측정의 계산은 제한을 두기 전과 한 자리도 다르지 않다.
    """
    z: float | None = None
    out: list[float | None] = []
    limited: list[bool] = []
    streak, direction = 0, 0
    for i, x in enumerate(weight_values):
        was_limited = False
        if x is not None:
            w = (weights[i] if weights is not None and i < len(weights) else 1.0)
            lam_eff = lambda_ * max(min(w, 1.0), 0.0)
            if z is None:
                z = x
            else:
                if limit_kg is not None and abs(x - z) > limit_kg:
                    sign = 1 if x > z else -1
                    streak = streak + 1 if sign == direction else 1
                    direction = sign
                    if release_after is None or streak < release_after:
                        x = z + sign * limit_kg
                        was_limited = True
                else:
                    streak, direction = 0, 0
                z = lam_eff * x + (1 - lam_eff) * z
        out.append(round(z, 2) if z is not None else None)
        limited.append(was_limited)
    return out, limited


def compute_ewma(
    weight_values: list[float | None],
    lambda_: float = EWMA_LAMBDA,
    weights: list[float] | None = None,
) -> list[float | None]:
    """ewma_with_limits의 EWMA 값만 돌려준다."""
    return ewma_with_limits(weight_values, lambda_, weights)[0]


# 80% 구간을 그리는 주 수와, 그 구간을 만들 때 평가하는 예측 기간(일). 화면의 비교 표는 BACKTEST_HORIZONS만 쓴다.
CI_WEEKS = 12
CI_LEVEL = 0.8
CI_HORIZONS = tuple(7 * week for week in range(1, CI_WEEKS + 1))
CI_MIN_SAMPLES = 20


def quantile(sorted_values: list[float], q: float) -> float:
    """정렬된 값의 분위수(선형 보간). 빈 목록이면 0.0."""
    if not sorted_values:
        return 0.0
    position = (len(sorted_values) - 1) * q
    lower = int(math.floor(position))
    upper = min(lower + 1, len(sorted_values) - 1)
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (position - lower)


def interval_half_widths(
    abs_errors_by_week: dict[int, list[float]],
    std_residual: float,
    weeks: int = CI_WEEKS,
    min_samples: int = CI_MIN_SAMPLES,
) -> list[float]:
    """1주~weeks주의 80% 구간 반폭(kg).

    abs_errors_by_week[주]는 그 기간 과거 예측의 |실측 − 예측|을 오름차순으로 정렬한 목록이다.
    - 오차가 min_samples개 이상인 주: 그 오차의 80분위다. 과거 예측의 80%가 이 폭 안에 들었다는 뜻이다.
    - 모자란 주: 오차가 충분한 가장 가까운 앞 주의 반폭을 √(주 비)로 늘린다. 그런 주가 하나도 없으면(이력이 짧다)
      모수 추정(1.28 × 잔차 표준편차 × √주)을 쓴다. 두 방법을 한 띠에 섞지 않는다. 섞으면 그 경계에서 폭이 뛴다
      (실제 이력을 재생하면 잔차 표준편차가 컸던 2026-05~07에 3배까지 뛰었다).
    - 반폭은 주가 갈수록 줄지 않는다.

    이웃한 주의 반폭 비는 모수 추정과 √ 연장에서 √2를 넘지 않는다. 오차로 정한 주끼리는 과거 오차가 그만큼
    달랐을 때만 넘는다.
    예전에는 평가한 기간(1·2·4·12주)의 RMSE를 가장 가까운 주에 빌려 써서 9주차에 폭이 1.8배로 뛰었고,
    5~8주는 그 기간의 실제 오차보다 좁았다(재검토 MD3).
    """
    widths: list[float] = []
    anchor: tuple[int, float] | None = None  # (오차가 충분했던 마지막 주, 그 반폭)
    for week in range(1, weeks + 1):
        errors = abs_errors_by_week.get(week) or []
        if len(errors) >= min_samples:
            width = quantile(errors, CI_LEVEL)
            anchor = (week, width)
        elif anchor is not None:
            width = anchor[1] * math.sqrt(week / anchor[0])
        else:
            width = 1.28 * std_residual * math.sqrt(week)
        if widths:
            width = max(width, widths[-1])
        widths.append(width)
    return widths


def residual_std(residuals: list[float | None]) -> float:
    """일별 실측과 추세의 차이의 표준편차. 값이 5개 미만이면 0.5kg으로 둔다."""
    known = [value for value in residuals if value is not None]
    return statistics.stdev(known) if len(known) >= 5 else 0.5


def compute_prediction_ci(
    ewma_series: list[dict[str, Any]],
    weight_series: list[dict[str, Any]],
    effective_weekly_loss: float,
    prediction_weeks: int = CI_WEEKS,
    target_weight: float | None = None,
    backtest_samples: dict[int, list[dict[str, Any]]] | None = None,
    start_date: str | None = None,
    long_weekly_loss: float | None = None,
) -> dict[str, Any]:
    """예측 구간(80% 띠). start_date가 있으면 그 날부터 주 단위로 점을 찍는다(예측선과 날짜를 맞춘다).

    중심은 예측 곡선이고 반폭은 interval_half_widths가 정한다. backtest_samples는 run_backtest의 samples다
    (예측 기간(일) → 표본). 주마다 운영 모델의 과거 오차를 모아 넘긴다.
    """
    ew_map = {p["date"]: p["valueKg"] for p in ewma_series if p["valueKg"] is not None}
    std = residual_std([
        p["valueKg"] - ew_map[p["date"]] if p["valueKg"] is not None and p["date"] in ew_map else None
        for p in weight_series[-30:]
    ])

    last_valid = next((p for p in reversed(ewma_series) if p["valueKg"] is not None), None)
    if last_valid is None:
        return {"stdResidual": None, "series": []}

    start = last_valid["valueKg"]
    last_date = date.fromisoformat(start_date or last_valid["date"])

    abs_errors = {
        week: sorted(abs(sample["actual"] - sample["predictions"][OPERATIONAL_MODEL]) for sample in (backtest_samples or {}).get(7 * week, []))
        for week in range(1, prediction_weeks + 1)
    }
    widths = interval_half_widths(abs_errors, std, weeks=prediction_weeks)

    series = []
    for week in range(1, prediction_weeks + 1):
        central = round(forecast_weight(start, effective_weekly_loss, week, target_weight, long_weekly_loss), 2)
        spread80 = round(widths[week - 1], 2)
        series.append({
            "date": (last_date + timedelta(weeks=week)).isoformat(),
            "central": central,
            "lower80": round(central - spread80, 2),
            "upper80": round(central + spread80, 2),
        })
    return {"stdResidual": round(std, 3), "series": series}


def compute_trend_windows(
    ewma_series: list[dict[str, Any]],
    latest_date: str,
    windows: tuple[int, ...] = (7, 14, 28),
) -> dict[str, Any]:
    """최근 N일 EWMA 회귀 감량률(kg/주). 양수=감소."""
    end = date.fromisoformat(latest_date)
    ewma_map = {p["date"]: p["valueKg"] for p in ewma_series if p.get("valueKg") is not None}
    out: dict[str, Any] = {}
    for window in windows:
        pts = []
        for i in range(window + 1):
            d = (end - timedelta(days=window - i)).isoformat()
            v = ewma_map.get(d)
            if v is not None:
                pts.append((float(i), v))
        raw = _linreg_slope(pts)
        out[f"{window}d"] = {
            "weeklyLossKg": round_or_none(-raw * 7, 4) if raw is not None else None,
            "points": len(pts),
        }
    return out


# 측정 점수의 맨 윗단(3점)은 최근 30일 중 이만큼 잰 경우에만 준다. 이력이 짧으면 측정률이 높아도 2점까지다.
FULL_COVERAGE_DAYS = 24
# 측정률(%)과 측정 점수. 한 단계씩 오른다. 30일 창에서는 20일·22일·24일이 경계다.
COVERAGE_STEPS = ((80.0, 3), (72.5, 2), (65.0, 1))


def coverage_points(coverage_pct: float, measured_days: int) -> int:
    """측정률로 주는 점수(0~3).

    예전에는 측정률 80%에 2점, 측정일 24일에 1점을 따로 줬다. 30일 창에서는 둘이 같은 조건이라 23일은 1점, 24일은 3점이
    되어 측정 한 번에 등급이 두 단계 뛰었다(재검토 MD5). 양 끝의 점수(65% 1점, 80%·24일 3점)는 그대로 두고 사이에 한 단을 넣었다.
    """
    for threshold, points in COVERAGE_STEPS:
        if coverage_pct >= threshold and (points < 3 or measured_days >= FULL_COVERAGE_DAYS):
            return points
    return 0


def classify_prediction_confidence(
    coverage_pct: float,
    measured_days: int,
    std_residual: float | None,
    backtests: dict[str, Any],
    warming_up: tuple[int, int] | None = None,
) -> dict[str, Any]:
    """최근 측정과 2주 예측 오차로 매기는 등급(0~6점). 3개월 값의 품질은 long_range_assessment가 따로 본다.

    warming_up=(현재 점 수, 필요한 점 수)이면 추세를 아직 판단할 수 없는 초기 구간이므로 신뢰도를 낮음으로 고정한다.
    """
    score = coverage_points(coverage_pct, measured_days)
    reasons = []
    if coverage_pct < 65:
        reasons.append("최근 측정률이 낮음")
    if measured_days < FULL_COVERAGE_DAYS:
        reasons.append("최근 측정일 수 부족")

    if std_residual is not None and std_residual <= 0.45:
        score += 1
    elif std_residual is not None and std_residual > 0.7:
        reasons.append("일별 체중 변동이 큼")

    bt14 = backtests.get("14d") or {}
    if bt14.get("status") == "ok" and bt14.get("maeKg") is not None:
        if bt14["maeKg"] <= 0.45:
            score += 2
        elif bt14["maeKg"] <= 0.7:
            score += 1
        else:
            reasons.append("14일 예측 오차가 큼")
    else:
        reasons.append("14일 백테스트 표본 부족")

    if score >= 5:
        level, label = "high", "높음"
    elif score >= 3:
        level, label = "medium", "보통"
    else:
        level, label = "low", "낮음"

    if warming_up is not None:
        points, required = warming_up
        level, label = "low", "낮음"
        reasons.insert(0, f"추세 판단 중 ({points}/{required}일)")

    return {
        "level": level,
        "label": label,
        "score": score,
        "reasons": reasons,
    }


def classify_loss_intensity(weekly_loss_kg: float | None, current_weight_kg: float | None) -> dict[str, Any] | None:
    """주당 감량이 체중의 몇 %인지로 속도를 나눈다. 경계(0.3%/0.7%)는 이 대시보드가 정한 값이다."""
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


def _weekly_change(points: list[dict[str, Any]]) -> float | None:
    days = (date.fromisoformat(points[-1]["date"]) - date.fromisoformat(points[0]["date"])).days
    return (points[0]["valueKg"] - points[-1]["valueKg"]) / (days / 7) if days > 0 else None


RECENT_SLOPE_DAYS = 7
RECENT_SLOPE_MIN_POINTS = 5


def _is_flat_window(points: list[dict[str, Any]], ewma_map: dict[str, float | None], threshold_kg_per_week: float) -> bool:
    """창이 평평한가: 양 끝의 변화가 주 threshold 미만이고, 창 끝의 최근 7일 기울기도 주 threshold 미만이다.

    양 끝만 보면 창 안에서 내려갔다 올라온 V자(또는 그 반대)도 평평이 된다(재검토 MD1). 그런 창은 최근 기울기가 0이 아니다.
    두 번째 조건은 추세 배지가 '유지'가 되는 조건과 같은 값이다(compute_weekly_loss_rate의 windowSlopes['7d']와
    model_trend_exposure의 임계값). 그래서 "N일째 평평" 문구와 "감량 중"·"증량 중" 배지가 함께 나오지 않는다.
    """
    change = _weekly_change(points)
    if change is None or abs(change) >= threshold_kg_per_week:
        return False
    raw, _ = _slope_over_window(ewma_map, date.fromisoformat(points[-1]["date"]), RECENT_SLOPE_DAYS,
                                min_points=RECENT_SLOPE_MIN_POINTS)
    return raw is not None and abs(round(-raw * 7, 4)) < threshold_kg_per_week


def detect_plateau(
    ewma_series: list[dict[str, Any]],
    threshold_kg_per_week: float = 0.05,
    min_days: int = 14,
    rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """EWMA가 14일 동안 평평하면(_is_flat_window) 정체다.

    durationDays는 실제로 이어진 정체 길이다: 끝에서부터 14일 창을 하루씩 뒤로 옮기며 모두 기준 안인 구간의 처음부터 센다(M7).
    예전에는 고정 창 양 끝의 차이라서 항상 13이었다.
    rows가 있으면(기능 스위치 plateauLoadClassification) 같은 기간 급성 부하로 glycogen/metabolic을 나눈다.
    """
    points = [p for p in ewma_series if p.get("valueKg") is not None]
    empty = {"detected": False, "startDate": None, "durationDays": 0, "weeklyChangeDelta": None, "type": None}
    if len(points) < min_days:
        return empty

    latest_change = _weekly_change(points[-min_days:])
    if latest_change is None:
        return empty
    ewma_map = {p["date"]: p["valueKg"] for p in points}
    detected = _is_flat_window(points[-min_days:], ewma_map, threshold_kg_per_week)
    start_index = len(points) - min_days
    if detected:
        while start_index > 0 and _is_flat_window(points[start_index - 1:start_index - 1 + min_days], ewma_map, threshold_kg_per_week):
            start_index -= 1

    plateau_type: str | None = None
    if detected and rows:
        loads = [parse_int(r.get("training_load_acute")) for r in rows[-min_days:]]
        loads = [v for v in loads if v is not None]
        if len(loads) >= 7:
            recent_load = sum(loads[-7:]) / max(len(loads[-7:]), 1)
            baseline_loads = loads[:-7] if len(loads) > 7 else loads
            baseline_load = sum(baseline_loads) / max(len(baseline_loads), 1)
            plateau_type = "glycogen" if baseline_load > 0 and recent_load > baseline_load * 1.25 else "metabolic"

    start_date = points[start_index]["date"]
    return {
        "detected": detected,
        "startDate": start_date if detected else None,
        "durationDays": (date.fromisoformat(points[-1]["date"]) - date.fromisoformat(start_date)).days if detected else 0,
        "weeklyChangeDelta": round(latest_change, 3),
        "type": plateau_type,
    }


PRIOR_LOSS_KG = 1.0
PRIOR_LOSS_LOOKBACK_DAYS = 56


def classify_trend_state(
    ewma_series: list[dict[str, Any]],
    weekly_loss_rate: float | None,
    plateau: dict[str, Any] | None,
) -> dict[str, Any]:
    """인사이트 상태: losing / plateau_after_loss / plateau_no_loss / maintaining / gaining / warming_up.

    정체 직전 56일 동안 EWMA가 1kg 이상 내려왔으면 "감량 후 정체"다. "대사 적응"은 이 상태에서만 말한다(M7).
    """
    points = [p for p in ewma_series if p.get("valueKg") is not None]
    if weekly_loss_rate is None or not points:
        return {"state": "warming_up", "priorLossKg": None}
    if plateau and plateau.get("detected"):
        start = date.fromisoformat(plateau["startDate"])
        window = [p for p in points if start - timedelta(days=PRIOR_LOSS_LOOKBACK_DAYS) <= date.fromisoformat(p["date"]) <= start]
        at_start = next((p["valueKg"] for p in reversed(window)), points[-1]["valueKg"])
        prior_loss = round(max(p["valueKg"] for p in window) - at_start, 2) if window else 0.0
        state = "plateau_after_loss" if prior_loss >= PRIOR_LOSS_KG else "plateau_no_loss"
        return {"state": state, "priorLossKg": prior_loss}
    if weekly_loss_rate > 0.05:
        return {"state": "losing", "priorLossKg": None}
    if weekly_loss_rate < -0.05:
        return {"state": "gaining", "priorLossKg": None}
    return {"state": "maintaining", "priorLossKg": None}


def build_insight(
    current_kg: float | None,
    ewma_kg: float | None,
    intensity: dict[str, Any] | None,
    plateau: dict[str, Any] | None,
    trend: dict[str, Any] | None = None,
    weekly_loss_rate: float | None = None,
    remaining_kg: float | None = None,
    weight_date: str | None = None,
    latest_date: str | None = None,
) -> dict[str, Any]:
    """상태별 안내 문구. 프런트는 그대로 보여 준다(M7).

    current_kg는 가장 최근 측정값이고 weight_date는 그 날짜다. latest_date(요약의 마지막 날)와 같을 때만 "오늘"이라고 쓴다.
    아침 수집은 오늘 체중이 들어오기 전에 돌므로 대부분 어제나 그 전의 값이다(재검토 MD7).
    """
    lines: list[str] = []
    if ewma_kg is not None and current_kg is not None:
        diff = round(current_kg - ewma_kg, 2)
        if abs(diff) >= 0.3:
            direction = "수분 증가로 일시적 상승" if diff > 0 else "수분 감소로 일시적 하락"
            if weight_date is not None and weight_date == latest_date:
                when = "오늘"
            elif weight_date is not None:
                measured = date.fromisoformat(weight_date)
                when = f"최근 측정({measured.month}/{measured.day})"
            else:
                when = "최근 측정"
            lines.append(f"{when} {current_kg}kg이지만 추세는 {ewma_kg}kg, {direction}일 수 있어요.")

    state = (trend or {}).get("state")
    days = (plateau or {}).get("durationDays", 0)
    remaining = f" 목표까지 {remaining_kg:.1f}kg 남았습니다." if remaining_kg is not None and remaining_kg > 0 else ""
    if state == "plateau_after_loss":
        lines.append(
            f"앞서 {trend['priorLossKg']:.1f}kg 줄어든 뒤 {days}일째 추세가 평평합니다. "
            "감량 뒤 몸이 적응하는 흔한 구간일 수 있어요. 운동량이나 식단을 조금 바꿔 보세요."
        )
    elif state == "plateau_no_loss":
        lines.append(f"{days}일째 체중 추세가 평평합니다.{remaining}")
    elif state == "gaining":
        rate = abs(weekly_loss_rate) if weekly_loss_rate is not None else None
        pace = f"주 {rate:.2f}kg씩 " if rate is not None else ""
        lines.append(f"최근 추세가 {pace}늘고 있어 목표에서 멀어지는 중입니다. 식사량과 활동량을 점검해 보세요.")
    elif state == "maintaining":
        lines.append(f"체중 추세가 거의 변하지 않고 있습니다(주 ±0.05kg 이내).{remaining}")
    elif state == "losing" and intensity:
        level = intensity.get("level")
        pct = intensity.get("weeklyPct")
        if level == "aggressive":
            lines.append(f"주 체중의 {pct:.1f}%씩 줄어 빠른 편입니다. 단백질을 충분히 드세요.")
        elif level == "standard":
            lines.append(f"주 체중의 {pct:.1f}%씩 꾸준히 줄고 있습니다.")
        elif level == "conservative":
            lines.append("느리지만 꾸준히 줄고 있습니다. 오래 유지하기 좋은 속도입니다.")

    return {"headline": lines[0] if lines else None, "lines": lines, "state": state}


OUTLIER_WINDOW_DAYS = 60


def data_quality_diagnostics(rows: list[dict[str, Any]], window_days: int = 30,
                             streak_penalty_days: int = 5, coverage_penalty_pct: float = 70.0,
                             outlier_window_days: int = OUTLIER_WINDOW_DAYS,
                             limited_dates: list[str] | None = None) -> dict[str, Any]:
    """자료 품질 진단. rows는 완료된 날만 준다(오늘 행 제외). 요약의 측정률과 같은 창을 세기 위해서다(재검토 MD6).

    이상치는 한 가지 뜻으로만 쓴다: 추세에서 EWMA_UPDATE_LIMIT_KG 넘게 벗어나 추세에 일부만 반영한 측정이다
    (ewma_with_limits). limited_dates는 그런 측정의 날짜이고, 주지 않으면 rows의 체중으로 계산한다.
    - limitedDates: rows 안의 그런 날짜 전부. 화면이 차트에 표시한다.
    - outlierCandidates: 그중 최근 outlier_window_days일 안의 건수. 전체 이력에서 세면 지난 일이 남아 값이 늘기만 한다(재검토 MD9).
    """
    if not rows:
        return {
            "totalDays": 0,
            "measuredDays": 0,
            "recentWindowDays": window_days,
            "recentMeasuredDays": 0,
            "recentTotalDays": 0,
            "recentCoveragePct": 0.0,
            "longestMissingStreak": 0,
            "outlierCandidates": 0,
            "outlierWindowDays": outlier_window_days,
            "limitedDates": [],
            "usableForRegression": False,
            "recentMeasurementCadence": None,
            "confidencePenalties": ["no_data"],
        }

    total_days = len(rows)
    measured_days = sum(1 for row in rows if row.get("weight_kg") is not None)

    last_n = rows[-window_days:] if len(rows) >= window_days else rows
    recent_measured = sum(1 for row in last_n if row.get("weight_kg") is not None)
    recent_total = len(last_n)
    recent_coverage_pct = round(recent_measured / recent_total * 100, 1) if recent_total else 0.0

    longest_missing = 0
    current_streak = 0
    for row in rows:
        if row.get("weight_kg") is None:
            current_streak += 1
            longest_missing = max(longest_missing, current_streak)
        else:
            current_streak = 0

    if limited_dates is None:
        _, flags = ewma_with_limits([row.get("weight_kg") for row in rows])
        limited_dates = [row["date"] for row, was_limited in zip(rows, flags) if was_limited]
    row_dates = {row["date"] for row in rows}
    limited = sorted(day for day in limited_dates if day in row_dates)
    outlier_start = rows[max(0, len(rows) - outlier_window_days)]["date"]
    outlier_candidates = sum(1 for day in limited if day >= outlier_start)

    cadence = round(measured_days / total_days, 3) if total_days else None
    usable_for_regression = (
        total_days >= 14
        and measured_days >= 14
        and recent_coverage_pct >= 50.0
        and longest_missing < 10
    )

    penalties: list[str] = []
    if recent_coverage_pct < coverage_penalty_pct:
        penalties.append("recent_coverage_low")
    if longest_missing >= streak_penalty_days:
        penalties.append("missing_streak_long")
    if measured_days < 14:
        penalties.append("measured_days_insufficient")
    if outlier_candidates > min(total_days, outlier_window_days) * 0.2:
        penalties.append("outliers_high")
    if not penalties:
        penalties.append("no_penalty")

    return {
        "totalDays": total_days,
        "measuredDays": measured_days,
        "recentWindowDays": window_days,
        "recentMeasuredDays": recent_measured,
        "recentTotalDays": recent_total,
        "recentCoveragePct": recent_coverage_pct,
        "longestMissingStreak": longest_missing,
        "outlierCandidates": outlier_candidates,
        "outlierWindowDays": outlier_window_days,
        "limitedDates": limited,
        "usableForRegression": usable_for_regression,
        "recentMeasurementCadence": cadence,
        "confidencePenalties": penalties,
    }


def model_trend_exposure(weekly_change_kg: float | None, weekly_loss_rate_kg: float | None) -> dict[str, Any]:
    """Phase 5 — expose trend state and keep prediction gating explicit."""
    flat_threshold = 0.05
    if weekly_change_kg is None:
        return {
            "direction": "unknown",
            "weeklyChangeKg": None,
            "weeklyLossRateKg": None,
            "predictionEnabled": False,
            "disabledReason": "insufficient_data",
        }

    weekly_change_kg = round(weekly_change_kg, 4)
    if weekly_change_kg >= flat_threshold:
        direction = "losing"
        # 방향은 7일 기울기로 정한다(사용자 결정, 재검토 MD1). 혼합 감량률이 음수면 그 값을 감량률로 내보내지 않는다.
        # 예전에는 direction이 losing인데 weeklyLossRateKg가 음수인 블록이 나왔다.
        blended_loss = weekly_loss_rate_kg if weekly_loss_rate_kg is not None and weekly_loss_rate_kg > 0 else None
        weekly_loss_rate_kg = round(blended_loss if blended_loss is not None else weekly_change_kg, 4)
        weekly_change_kg_display = weekly_loss_rate_kg
    elif weekly_change_kg <= -flat_threshold:
        direction = "gaining"
        weekly_loss_rate_kg = None
        weekly_change_kg_display = weekly_change_kg
    else:
        direction = "flat"
        weekly_loss_rate_kg = None
        weekly_change_kg_display = weekly_change_kg

    # ponytail: direction is information, not a gate — confidence + CI communicate uncertainty
    prediction_enabled = direction != "unknown"
    disabled_reason = "insufficient_data" if direction == "unknown" else None

    return {
        "direction": direction,
        "weeklyChangeKg": weekly_change_kg_display,
        "weeklyLossRateKg": weekly_loss_rate_kg,
        "predictionEnabled": prediction_enabled,
        "disabledReason": disabled_reason,
    }


def warming_up_trend_exposure(points: int, required: int) -> dict[str, Any]:
    """처음 측정 후 28일 창에 점이 모자란 구간의 추세 표시.

    감량률을 아직 판단할 수 없으므로 예측은 현재 EWMA 수준을 그대로 잇는 평평한 값이다
    (rateSource='cold_start_flat'). 숨기지 않고 표시하되 방향은 따로 표기한다.
    """
    return {
        "direction": "warming_up",
        "weeklyChangeKg": None,
        "weeklyLossRateKg": None,
        "predictionEnabled": True,
        "disabledReason": None,
        "rateSource": "cold_start_flat",
        "historyPoints": points,
        "requiredPoints": required,
    }


# ---------------------------------------------------------------------------
# P6: 통합 백테스트
#
# 모든 모델(운영, 섀도 후보, Kalman, 변화 없음)을 같은 기준 시점 집합과 같은 실측 매칭으로 평가한다.
# 부호 규칙은 하나다: 모델은 (기준 수준 kg, 하루 체중 변화 kg)를 내고 감량은 음수다.
# 운영 모델만 감쇠 곡선(_projected_weight)을 쓰고, 그 함수가 받는 감량률(양수=감량)은 경계에서 바꾼다.
# ---------------------------------------------------------------------------

BACKTEST_HORIZONS = (7, 14, 28, 84)
BACKTEST_MIN_SAMPLES = 20
BACKTEST_TOLERANCE_DAYS = 3
OPERATIONAL_MODEL = "current"
# 섀도 후보. 예측에는 쓰지 않고 운영 모델과 비교만 한다.
SHADOW_MODELS = (
    "ewma_flat",            # 변화 없음: 기준 시점 EWMA를 그대로 잇는다
    "ma7",                  # 최근 측정 7회의 평균을 그대로 잇는다
    "linreg_28d",
    "linreg_56d",
    "linreg_84d",
    "weighted_linreg_56d",  # 최근일수록 큰 가중
    "robust_56d",           # Theil–Sen(쌍별 기울기의 중앙값)
    "kalman",               # [체중, 속도] 상태. 증량 속도도 운영 모델처럼 그대로 쓴다
)
_REGRESSIONS = {
    "linreg_28d": (28, "ols"),
    "linreg_56d": (56, "ols"),
    "linreg_84d": (84, "ols"),
    "weighted_linreg_56d": (56, "weighted"),
    "robust_56d": (56, "theil_sen"),
}
SHADOW_GATE = {
    "minSampleCount": BACKTEST_MIN_SAMPLES,
    "minImprovementKg": 0.05,
    "minImprovementPct": 0.08,
    "minHorizonWins": 2,
}


def summarize_backtest_errors(errors: list[float], min_samples: int = BACKTEST_MIN_SAMPLES) -> dict[str, Any]:
    """오차(예측 − 실측) 목록의 표본 수·MAE·RMSE·bias. 표본이 min_samples 미만이면 status가 insufficient다."""
    if not errors:
        return {"sampleCount": 0, "maeKg": None, "rmseKg": None, "biasKg": None, "status": "insufficient"}
    mae = sum(abs(e) for e in errors) / len(errors)
    bias = sum(errors) / len(errors)
    rmse = math.sqrt(sum(e * e for e in errors) / len(errors))
    return {
        "sampleCount": len(errors),
        "maeKg": round(mae, 3),
        "rmseKg": round(rmse, 3),
        "biasKg": round(bias, 3),
        "status": "ok" if len(errors) >= min_samples else "insufficient",
    }


def ols_fit(points: list[tuple[float, float]], weights: list[float] | None = None) -> tuple[float, float] | None:
    """(x, y) 점의 (가중) 최소제곱 직선 (기울기, x=0에서의 값). 점이 3개 미만이거나 x가 모두 같으면 None."""
    if len(points) < 3:
        return None
    ws = weights if weights is not None else [1.0] * len(points)
    total = sum(ws)
    if total <= 0:
        return None
    xm = sum(w * x for (x, _), w in zip(points, ws)) / total
    ym = sum(w * y for (_, y), w in zip(points, ws)) / total
    den = sum(w * (x - xm) ** 2 for (x, _), w in zip(points, ws))
    if den == 0:
        return None
    slope = sum(w * (x - xm) * (y - ym) for (x, y), w in zip(points, ws)) / den
    return slope, ym - slope * xm


def theil_sen_fit(points: list[tuple[float, float]]) -> tuple[float, float] | None:
    """Theil–Sen 직선 (기울기, x=0에서의 값). 기울기는 쌍별 기울기의 중앙값, 절편은 y − 기울기·x의 중앙값이다.
    이상치 한 점이 직선을 거의 움직이지 못한다. 점이 3개 미만이면 None."""
    if len(points) < 3:
        return None
    slopes = [
        (y2 - y1) / (x2 - x1)
        for i, (x1, y1) in enumerate(points)
        for (x2, y2) in points[i + 1:]
        if x2 != x1
    ]
    if not slopes:
        return None
    slope = statistics.median(slopes)
    return slope, statistics.median(y - slope * x for x, y in points)


def _kalman_filter_fn():
    """kalman_predictor.kalman_filter. 실행 방식과 무관하게 같은 폴더에서 읽는다."""
    import importlib.util

    module_path = Path(__file__).resolve().parent / "kalman_predictor.py"
    spec = importlib.util.spec_from_file_location("garmin_kalman_predictor", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("kalman_predictor module not found")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.kalman_filter


def shadow_predictors(
    prefix: list[tuple[int, float]],
    cutoff_ordinal: int,
    level: float,
    kalman_state: tuple[float, float] | None,
) -> dict[str, tuple[float, float]]:
    """기준 시점까지의 측정(서수일, kg)으로 섀도 모델마다 (기준 수준, 하루 변화)를 만든다. 정할 수 없는 모델은 뺀다.

    회귀 후보는 측정에서 기울기만 얻고, 출발점은 운영 모델과 같은 기준 시점 EWMA다. 수준이 아니라 추세 추정 방법을
    비교하려는 것이다(직선의 x=0 값에서 출발하면 실제 이력에서 7/14/28일 MAE가 0.03~0.18kg 나빠졌다).
    """
    out: dict[str, tuple[float, float]] = {"ewma_flat": (level, 0.0)}
    recent = [weight for _, weight in prefix[-7:]]
    if len(recent) >= 3:
        out["ma7"] = (sum(recent) / len(recent), 0.0)
    for name, (window, method) in _REGRESSIONS.items():
        points = [(float(day - cutoff_ordinal), weight) for day, weight in prefix if day > cutoff_ordinal - window]
        if method == "theil_sen":
            fit = theil_sen_fit(points)
        elif method == "weighted":
            fit = ols_fit(points, [window + x for x, _ in points])
        else:
            fit = ols_fit(points)
        if fit is not None:
            out[name] = (level, fit[0])
    if kalman_state is not None:
        out["kalman"] = (kalman_state[0], kalman_state[1])
    return out


def _nearest_actual(
    meas_ord: list[int], meas_w: list[float], meas_row: list[int],
    first_row: int, target: int, tolerance_days: int,
) -> tuple[float | None, int | None]:
    """기준 시점 뒤(first_row 이후 행)의 측정 중 target에 가장 가까운 것. 같은 거리면 이른 날."""
    import bisect

    lo = bisect.bisect_left(meas_ord, target - tolerance_days)
    hi = bisect.bisect_right(meas_ord, target + tolerance_days)
    best: tuple[int, int] | None = None
    for k in range(lo, hi):
        if meas_row[k] < first_row:
            continue
        distance = abs(meas_ord[k] - target)
        if best is None or distance < best[0]:
            best = (distance, k)
    if best is None:
        return None, None
    return meas_w[best[1]], meas_ord[best[1]]


def run_backtest(
    rows: list[dict[str, Any]],
    ewma_series: list[dict[str, Any]],
    ma7_by_date: dict[str, float | None],
    target_weight: float | None = None,
    train_window: int = 28,
    horizons: tuple[int, ...] = BACKTEST_HORIZONS,
    tolerance_days: int = BACKTEST_TOLERANCE_DAYS,
    min_samples: int = BACKTEST_MIN_SAMPLES,
    use_long_rate: bool = True,
) -> dict[str, Any]:
    """기준 시점마다 앞부분(rows[:idx])만으로 모든 모델의 예측을 만들고 같은 실측과 비교한다.

    기준 시점은 학습 창(train_window) 뒤의 모든 날이다(감량기만 고르지 않는다, M3).
    한 기준 시점은 모든 모델이 예측을 낼 수 있고 실측이 ±tolerance_days 안에 있을 때만 표본이 된다(같은 표본).
    운영 모델은 본 예측과 같은 함수(forecast_weight)와 같은 두 감량률을 쓰고, 감량률을 정할 수 없는 초기에는 평평하게 잇는다.
    """
    ewma_by_date = {p["date"]: p["valueKg"] for p in ewma_series if p.get("valueKg") is not None}
    ordinals = [date.fromisoformat(row["date"]).toordinal() for row in rows]
    weights = [row.get("weight_kg") for row in rows]
    meas_row = [i for i, weight in enumerate(weights) if weight is not None]
    meas_ord = [ordinals[i] for i in meas_row]
    meas_w = [float(weights[i]) for i in meas_row]
    kalman_states = _kalman_filter_fn()(weights) if meas_row else []

    import bisect

    cutoffs: list[dict[str, Any]] = []
    for idx in range(train_window, len(rows)):
        cutoff_date = rows[idx - 1]["date"]
        level = ewma_by_date.get(cutoff_date)
        if level is None:
            continue
        detail = compute_weekly_loss_rate(ewma_series[:idx], ma7_by_date, rows[:idx], cutoff_date, window=train_window)
        rate, long_rate = detail["blended"], (detail["longRangeRate"] if use_long_rate else None)
        k = bisect.bisect_left(meas_row, idx)
        prefix = list(zip(meas_ord[:k], meas_w[:k]))
        state = kalman_states[idx - 1] if kalman_states else None
        shadow = shadow_predictors(prefix, ordinals[idx - 1], level, state)
        if any(name not in shadow for name in SHADOW_MODELS):
            continue  # 같은 표본: 한 모델이라도 예측을 못 내면 이 기준 시점은 모두에게서 뺀다
        cutoffs.append({"index": idx, "ordinal": ordinals[idx - 1], "level": level, "rate": rate, "longRate": long_rate,
                        "shadow": shadow})

    samples: dict[int, list[dict[str, Any]]] = {h: [] for h in horizons}
    for cutoff in cutoffs:
        for horizon in horizons:
            actual, actual_ord = _nearest_actual(meas_ord, meas_w, meas_row, cutoff["index"], cutoff["ordinal"] + horizon, tolerance_days)
            if actual is None:
                continue
            rate = cutoff["rate"] if cutoff["rate"] is not None else 0.0
            predictions = {OPERATIONAL_MODEL: forecast_weight(cutoff["level"], rate, horizon / 7, target_weight, cutoff["longRate"])}
            for name, (base, slope_per_day) in cutoff["shadow"].items():
                predictions[name] = base + slope_per_day * horizon
            samples[horizon].append({
                "index": cutoff["index"],
                "cutoff": cutoff["ordinal"],
                "rate": cutoff["rate"],
                "actualOrdinal": actual_ord,
                "actual": actual,
                "predictions": predictions,
            })

    models = {
        name: {
            f"{h}d": summarize_backtest_errors([s["predictions"][name] - s["actual"] for s in samples[h]], min_samples)
            for h in horizons
        }
        for name in (OPERATIONAL_MODEL, *SHADOW_MODELS)
    }
    return {
        "models": models,
        "sampleCounts": {f"{h}d": len(samples[h]) for h in horizons},
        "samples": samples,
        "horizons": horizons,
        "minSamples": min_samples,
    }


def regime_split(
    samples_by_horizon: dict[int, list[dict[str, Any]]],
    horizons: tuple[int, ...] = BACKTEST_HORIZONS,
) -> dict[str, Any]:
    """운영 모델의 성적을 기준 시점의 추세로 나눈다(재검토 MD4). 화면에는 쓰지 않고 model_audit.py가 내보낸다.

    losing: 기준 시점의 혼합 감량률이 감량(> 0)이던 표본. other: 그 밖(유지·증량, 감량률을 정할 수 없던 초기).
    전체 평균은 두 구간의 차이를 가린다. 2026-11-25 재검토에서는 감량 추세일 때 28일 예측부터 "변화 없음"보다 나빴다.
    biasKg는 예측 − 실측의 평균이다(음수면 예측이 실제보다 낮다, 곧 감량을 과하게 본다).
    """
    out: dict[str, Any] = {}
    for horizon in horizons:
        groups: dict[str, list[dict[str, Any]]] = {"losing": [], "other": []}
        for sample in samples_by_horizon.get(horizon, []):
            groups["losing" if (sample.get("rate") or 0.0) > 0 else "other"].append(sample)
        out[f"{horizon}d"] = {}
        for name, items in groups.items():
            errors = [item["predictions"][OPERATIONAL_MODEL] - item["actual"] for item in items]
            flat_errors = [item["predictions"][FLAT_MODEL] - item["actual"] for item in items]
            out[f"{horizon}d"][name] = {
                "sampleCount": len(items),
                "maeKg": round(sum(abs(e) for e in errors) / len(errors), 3) if errors else None,
                "flatMaeKg": round(sum(abs(e) for e in flat_errors) / len(flat_errors), 3) if flat_errors else None,
                "biasKg": round(sum(errors) / len(errors), 3) if errors else None,
            }
    return out


LONG_RANGE_HORIZON = "84d"
FLAT_MODEL = "ewma_flat"


def long_range_assessment(models: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """3개월(84일) 예측을 믿을 근거가 있는지. 화면이 3개월 값과 목표 도달일에 "장기 추정" 표시를 붙일지 정한다.

    신뢰도 등급은 최근 측정과 2주 예측 오차만 본다. 그 등급이 높아도 3개월 예측은 "변화 없음"보다 나쁠 수 있다
    (재검토 MD5, 사용자 결정: 등급은 그대로 두고 3개월 값에 따로 표시한다).
    status: ok(변화 없음보다 낫거나 같다) / worse_than_flat / unverified(표본이 모자라 비교할 수 없다).
    """
    current = (models.get(OPERATIONAL_MODEL) or {}).get(LONG_RANGE_HORIZON) or {}
    flat = (models.get(FLAT_MODEL) or {}).get(LONG_RANGE_HORIZON) or {}
    if current.get("status") != "ok" or flat.get("status") != "ok":
        status = "unverified"
    elif current["maeKg"] > flat["maeKg"]:
        status = "worse_than_flat"
    else:
        status = "ok"
    return {
        "horizon": LONG_RANGE_HORIZON,
        "status": status,
        "maeKg": current.get("maeKg"),
        "flatMaeKg": flat.get("maeKg"),
        "sampleCount": current.get("sampleCount", 0),
    }


def shadow_gate(models: dict[str, dict[str, Any]], horizons: tuple[int, ...] = BACKTEST_HORIZONS,
                gate: dict[str, Any] | None = None) -> dict[str, Any]:
    """섀도 후보가 운영 모델보다 나은지 본다. 결과는 진단용이며 예측을 바꾸지 않는다.

    통과 조건(모두): 모든 기간에서 표본이 충분하다, 어느 기간에서도 |bias|가 운영 모델보다 크지 않다,
    minHorizonWins개 이상의 기간에서 MAE가 minImprovementKg 또는 minImprovementPct만큼 낮다.
    통과한 후보가 있으면 MAE 비율 평균이 가장 낮은 후보가 shadow_leader다. 없으면 no_change다.
    """
    gate = SHADOW_GATE | (gate or {})
    current = models.get(OPERATIONAL_MODEL) or {}
    evaluated: dict[str, Any] = {}
    passing: list[tuple[float, str]] = []
    for name in SHADOW_MODELS:
        stats = models.get(name) or {}
        wins: list[str] = []
        blocked: list[str] = []
        ratios: list[float] = []
        for horizon in horizons:
            key = f"{horizon}d"
            base, cand = current.get(key) or {}, stats.get(key) or {}
            if base.get("status") != "ok" or cand.get("status") != "ok" or cand.get("sampleCount", 0) < gate["minSampleCount"]:
                blocked.append(f"{key}_insufficient")
                continue
            if abs(cand["biasKg"]) > abs(base["biasKg"]):
                blocked.append(f"{key}_bias_worse")
            improvement = base["maeKg"] - cand["maeKg"]
            if improvement >= gate["minImprovementKg"] or (base["maeKg"] > 0 and improvement / base["maeKg"] >= gate["minImprovementPct"]):
                wins.append(key)
            if base["maeKg"] > 0:
                ratios.append(cand["maeKg"] / base["maeKg"])
        evaluated[name] = {"wins": wins, "blocked": blocked}
        if not blocked and len(wins) >= gate["minHorizonWins"] and ratios:
            passing.append((sum(ratios) / len(ratios), name))
    if passing:
        _, leader = min(passing)
        status, reason = "shadow_leader", f"{leader} beat current on {','.join(evaluated[leader]['wins'])}"
    else:
        leader, status, reason = None, "no_change", "no shadow candidate passed the gate"
    return {
        "name": leader or OPERATIONAL_MODEL,
        "status": status,
        "reason": reason,
        "candidates": evaluated,
        "gate": gate,
        "affectsPrediction": False,
    }


def replay_ci_hit_rate(
    backtest: dict[str, Any],
    rows: list[dict[str, Any]],
    ewma_series: list[dict[str, Any]],
    min_samples: int = BACKTEST_MIN_SAMPLES,
) -> dict[str, Any]:
    """운영 모델의 80% 구간을 기준 시점마다 그때의 자료로 다시 만들어 실측 포함률을 잰다(M4).

    구간 반폭은 compute_prediction_ci와 같은 함수(interval_half_widths)로 만든다. 기준 시점마다 그때까지 실측이
    나온 오차만 쓰고, 잔차 표준편차도 기준 시점까지 마지막 30행의 (체중 − EWMA)로 구한다.
    추세 방향과 무관하게 모든 표본에서 잰다.
    """
    import bisect

    ewma_by_date = {p["date"]: p["valueKg"] for p in ewma_series if p.get("valueKg") is not None}
    residuals: list[float | None] = []
    for row in rows:
        weight, level = row.get("weight_kg"), ewma_by_date.get(row["date"])
        residuals.append(weight - level if weight is not None and level is not None else None)

    horizons = tuple(backtest.get("horizons", ()))
    week_of = {horizon: max(1, round(horizon / 7)) for horizon in horizons}
    weeks = max(week_of.values(), default=0)

    def error_of(sample: dict[str, Any]) -> float:
        return abs(sample["actual"] - sample["predictions"][OPERATIONAL_MODEL])

    # 기간마다: 실측일 순서로 줄을 세워 두고, 기준 시점이 지나갈 때 그때까지 나온 오차를 정렬된 목록에 넣는다.
    pending = {h: sorted(backtest["samples"][h], key=lambda s: s["actualOrdinal"]) for h in horizons}
    pointer = {h: 0 for h in horizons}
    known: dict[int, list[float]] = {week_of[h]: [] for h in horizons}
    by_cutoff: dict[int, list[tuple[int, dict[str, Any]]]] = {}
    for h in horizons:
        for sample in backtest["samples"][h]:
            by_cutoff.setdefault(sample["cutoff"], []).append((h, sample))

    hits = {h: 0 for h in horizons}
    totals = {h: 0 for h in horizons}
    for cutoff in sorted(by_cutoff):
        for h in horizons:
            queue = pending[h]
            while pointer[h] < len(queue) and queue[pointer[h]]["actualOrdinal"] <= cutoff:
                bisect.insort(known[week_of[h]], error_of(queue[pointer[h]]))
                pointer[h] += 1
        index = by_cutoff[cutoff][0][1]["index"]
        std = residual_std(residuals[max(0, index - 30):index])
        widths = interval_half_widths(known, std, weeks=weeks, min_samples=min_samples)
        for h, sample in by_cutoff[cutoff]:
            totals[h] += 1
            if error_of(sample) <= widths[week_of[h] - 1]:
                hits[h] += 1

    hit_rate = {f"{h}d": round(hits[h] / totals[h], 3) if totals[h] >= min_samples else None for h in horizons}
    return {
        "hitRate": hit_rate,
        "sampleCounts": {f"{h}d": totals[h] for h in horizons},
        "status": "ok" if any(v is not None for v in hit_rate.values()) else "insufficient",
        "method": "replay",
        "targetHitRate": CI_LEVEL,
    }
