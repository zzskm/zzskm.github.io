#!/usr/bin/env python3
"""Prediction and model-quality helpers for the Garmin weight sync."""

from __future__ import annotations

import math
import statistics
from datetime import date, datetime, timedelta
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


def build_smart_scenarios(
    exercise_trend: dict[str, Any],
    opt_pct: float,
    con_pct: float,
    recent7_avg_kcal: float,
) -> dict[str, dict[str, Any]]:
    """Phase 6 — 활동 로그 기반 시나리오.

    legacy '±30%'가 추상적이라, 운동 세션 평균 kcal을 기반으로 "주2회 추가" 등
    구체적 라벨을 생성한다. 표본이 부족하면 pct 기반 fallback.
    """
    # exercise_trend의 recent7Avg는 일평균 kcal. 운동 세션 평균 kcal은 active_days 기반으로 추정.
    avg_session_kcal = 0.0
    if recent7_avg_kcal > 0:
        # active_days 정확값은 rolling에서 계산되지만 여기선 보수적으로 4일 가정
        # (주 4회 운동 = 일평균 kcal × 7 / 4)
        avg_session_kcal = recent7_avg_kcal * 7 / 4.0

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
        opt_desc = f"운동 +{opt_pct*100:.0f}% 가정"
        con_desc = f"운동 {con_pct*100:.0f}% 가정"

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
    window_used_weight: dict[str, float] = {}
    components: list[tuple[float, float]] = []
    for key, w_days, target_w, min_pts in window_specs:
        raw, n = _slope_over_window(ewma_map, end, w_days, min_points=min_pts)
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

    # 운동 칼로리 기대 감량률 (참고값, 시나리오에서만 사용)
    kcal_rows = rows[-14:] if len(rows) >= 14 else rows
    kcal_vals = [parse_float(r.get("exercise_calories")) or 0.0 for r in kcal_rows]
    avg_daily_kcal = sum(kcal_vals) / len(kcal_vals) if kcal_vals else 0.0
    kcal_rate = round_or_none(avg_daily_kcal * 7 / kcal_to_kg, 4)

    return {
        "blended": blended,
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
    week: int,
    target_weight: float | None = None,
    half_life_weeks: float = 16.0,
) -> float:
    """P3: 지수 감쇠 외삽.

    초반에는 effective_weekly_loss로 거의 선형 감소하다가, target_weight 또는
    asymptote 쪽으로 수렴. half_life_weeks가 클수록 더 직선에 가깝다.
    target_weight가 없거나 현재 체중보다 높으면 선형 fallback.
    """
    if target_weight is None or target_weight >= start_weight or effective_weekly_loss <= 0:
        return start_weight - effective_weekly_loss * week

    # 감속 모델: w(t) = target + (start - target) * exp(-k*t)
    # 첫 주 감량이 effective_weekly_loss와 일치하도록 k를 결정한다.
    initial_gap = start_weight - target_weight
    if initial_gap <= 0:
        return start_weight

    # k가 너무 크면 즉시 수렴, 너무 작으면 선형 — half-life 기반으로 부드러운 곡선 보장
    k_from_rate = effective_weekly_loss / initial_gap  # 초기 감량률
    k_from_halflife = math.log(2) / max(half_life_weeks, 1.0)
    k = min(k_from_rate, k_from_halflife * 2)  # rate가 너무 빠르면 half-life로 제한

    decayed_gap = initial_gap * math.exp(-k * week)
    return target_weight + decayed_gap


def build_prediction_series(
    latest_date: str | None,
    start_weight: float | None,
    effective_weekly_loss: float | None,
    weeks: int = 12,
    target_weight: float | None = None,
) -> list[dict[str, Any]]:
    """예측 시리즈 생성. P3에서 지수 감쇠로 변경 — 장기 horizon의 과대 추정 완화."""
    if latest_date is None or start_weight is None or effective_weekly_loss is None:
        return []

    start_day = datetime.strptime(latest_date, "%Y-%m-%d").date()
    series = [{"date": latest_date, "valueKg": round(start_weight, 2)}]
    for week in range(1, weeks + 1):
        future_date = start_day + timedelta(days=7 * week)
        projected = _projected_weight(start_weight, effective_weekly_loss, week, target_weight)
        series.append({"date": future_date.isoformat(), "valueKg": round(projected, 2)})
    return series


def measurement_weight(row: dict[str, Any]) -> float:
    """Phase 4 — 컨텍스트 기반 측정 신뢰도 가중치 (0.5 ~ 1.0).

    수면 부족·급격한 훈련 부하 증가는 수분 정체/글리코겐 변동을 일으켜 그날
    체중을 추세 신호가 아닌 잡음으로 만든다. 신뢰도가 낮을수록 EWMA 업데이트
    비중을 줄여 추세선이 노이즈에 끌려가지 않게 한다.
    """
    w = 1.0
    score = parse_float(row.get("sleep_score"))
    if score is not None and score < 60:
        w *= 0.7  # 수면 점수 60 미만 → 수분 정체 가능성
    load = parse_int(row.get("training_load_acute"))
    if load is not None and load >= 400:
        w *= 0.85  # 급성 부하 매우 높음 → 글리코겐/수분 저장 가능성
    return max(w, 0.4)


def compute_ewma(
    weight_values: list[float | None],
    lambda_: float = EWMA_LAMBDA,
    weights: list[float] | None = None,
) -> list[float | None]:
    """Z_t = λ_eff·X_t + (1-λ_eff)·Z_{t-1}. None은 건너뛰고 직전 Z 유지.

    weights가 제공되면 그 날의 가중치만큼 λ를 축소(`λ_eff = λ · w`).
    가중치 1.0 = 기존 동작, 0.7 = 영향력 30% 감소.
    """
    z: float | None = None
    out: list[float | None] = []
    for i, x in enumerate(weight_values):
        if x is not None:
            w = (weights[i] if weights is not None and i < len(weights) else 1.0)
            lam_eff = lambda_ * max(min(w, 1.0), 0.0)
            z = x if z is None else lam_eff * x + (1 - lam_eff) * z
        out.append(round(z, 2) if z is not None else None)
    return out


def compute_prediction_ci(
    ewma_series: list[dict[str, Any]],
    weight_series: list[dict[str, Any]],
    effective_weekly_loss: float,
    prediction_weeks: int = 12,
    target_weight: float | None = None,
    backtest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """예측 구간 (80% 밴드).

    P3: central은 지수 감쇠 외삽과 일치.
    P4: 잔차 std × √t 와 horizon별 backtest RMSE 중 더 큰 값 사용 (CI 저평가 방지).
    """
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

    # P4: backtest RMSE를 주(week) 단위 키로 사전 인덱싱. 키는 7d/14d/28d → 1/2/4주.
    bt_rmse_by_week: dict[int, float] = {}
    if backtest:
        for horizon_key, val in backtest.items():
            if not isinstance(val, dict) or val.get("status") != "ok":
                continue
            try:
                days = int(horizon_key.rstrip("d"))
            except ValueError:
                continue
            wk = max(1, round(days / 7))
            rmse = val.get("rmseKg")
            if isinstance(rmse, (int, float)):
                bt_rmse_by_week[wk] = float(rmse)

    def _backtest_rmse_for(week: int) -> float | None:
        """가장 가까운 horizon의 RMSE를 반환. (예: 5주차 → 4주 backtest 사용)"""
        if not bt_rmse_by_week:
            return None
        nearest = min(bt_rmse_by_week.keys(), key=lambda w: abs(w - week))
        return bt_rmse_by_week[nearest]

    series = []
    for week in range(1, prediction_weeks + 1):
        central_raw = _projected_weight(start, effective_weekly_loss, week, target_weight)
        central = round(central_raw, 2)
        residual_spread = 1.28 * std * (week ** 0.5)
        bt_rmse = _backtest_rmse_for(week)
        # backtest RMSE는 이미 실측 오차이므로 1.28σ에 해당한다고 보고 동일 스케일로 비교
        # (분포가 가우시안 80%면 1.28σ ≈ RMSE 수준).
        bt_spread = bt_rmse if bt_rmse is not None else 0.0
        spread80 = round(max(residual_spread, bt_spread), 2)
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


def backtest_predictions(
    rows: list[dict[str, Any]],
    ewma_series: list[dict[str, Any]],
    ma7_by_date: dict[str, float | None],
    horizons: tuple[int, ...] = (7, 14, 28),
    train_window: int = 28,
    min_samples: int = 3,
    target_weight: float | None = None,
) -> dict[str, Any]:
    """과거 prefix 기준 단순 백테스트. 실제 측정값은 목표일 ±3일 내 가장 가까운 값."""
    ewma_by_date = {p["date"]: p["valueKg"] for p in ewma_series if p.get("valueKg") is not None}
    out: dict[str, Any] = {}
    for horizon in horizons:
        errors: list[float] = []
        for idx in range(train_window, len(rows) - horizon):
            latest = rows[idx - 1]["date"]
            current_ewma = ewma_by_date.get(latest)
            if current_ewma is None:
                continue
            detail = compute_weekly_loss_rate(
                ewma_series[:idx],
                ma7_by_date,
                rows[:idx],
                latest,
                window=train_window,
            )
            rate = detail.get("blended")
            if rate is None or rate <= 0:
                continue
            target_day = date.fromisoformat(latest) + timedelta(days=horizon)
            candidates = []
            for row in rows[idx:]:
                actual = row.get("weight_kg")
                if actual is None:
                    continue
                distance = abs((date.fromisoformat(row["date"]) - target_day).days)
                if distance <= 3:
                    candidates.append((distance, actual))
            if not candidates:
                continue
            actual = min(candidates, key=lambda item: item[0])[1]
            # P3: 본 예측과 동일한 지수 감쇠 모델 사용 — CI에 들어가는 RMSE 비대칭 제거.
            predicted = _projected_weight(current_ewma, rate, horizon / 7, target_weight)
            errors.append(predicted - actual)

        key = f"{horizon}d"
        if len(errors) < min_samples:
            out[key] = {"sampleCount": len(errors), "status": "insufficient"}
            continue
        mae = sum(abs(e) for e in errors) / len(errors)
        bias = sum(errors) / len(errors)
        rmse = (sum(e * e for e in errors) / len(errors)) ** 0.5
        out[key] = {
            "sampleCount": len(errors),
            "biasKg": round(bias, 3),
            "maeKg": round(mae, 3),
            "rmseKg": round(rmse, 3),
            "status": "ok",
        }
    return out


def classify_prediction_confidence(
    coverage_pct: float,
    measured_days: int,
    std_residual: float | None,
    backtests: dict[str, Any],
) -> dict[str, Any]:
    score = 0
    reasons = []
    if coverage_pct >= 80:
        score += 2
    elif coverage_pct >= 65:
        score += 1
    else:
        reasons.append("최근 측정률이 낮음")

    if measured_days >= 24:
        score += 1
    else:
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

    return {
        "level": level,
        "label": label,
        "score": score,
        "reasons": reasons,
    }


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
    rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """EWMA 기준 최근 min_days 동안 변화량이 threshold 미만이면 정체기.

    Phase 4: rows가 함께 제공되면 같은 기간 평균 training_load_acute로
    정체기 유형을 'metabolic'(대사 적응) vs 'glycogen'(부하 급증 → 수분 저장)으로 분리.
    """
    recent = [p for p in ewma_series[-min_days:] if p.get("valueKg") is not None]
    if len(recent) < min_days:
        return {"detected": False, "startDate": None, "durationDays": 0, "weeklyChangeDelta": None, "type": None}

    days = (date.fromisoformat(recent[-1]["date"]) - date.fromisoformat(recent[0]["date"])).days
    weekly_change = (recent[0]["valueKg"] - recent[-1]["valueKg"]) / (days / 7) if days > 0 else 0.0
    detected = abs(weekly_change) < threshold_kg_per_week

    plateau_type: str | None = None
    if detected and rows:
        # 정체기 기간의 최근 7일 평균 부하 vs 정체기 직전 21일 평균 부하 비교
        loads = [parse_int(r.get("training_load_acute")) for r in rows[-min_days:]]
        loads = [v for v in loads if v is not None]
        if len(loads) >= 7:
            recent_load = sum(loads[-7:]) / max(len(loads[-7:]), 1)
            baseline_loads = loads[:-7] if len(loads) > 7 else loads
            baseline_load = sum(baseline_loads) / max(len(baseline_loads), 1)
            # 평균 부하가 직전보다 25% 이상 상승했으면 글리코겐 정체기로 분류
            if baseline_load > 0 and recent_load > baseline_load * 1.25:
                plateau_type = "glycogen"
            else:
                plateau_type = "metabolic"

    return {
        "detected": detected,
        "startDate": recent[0]["date"] if detected else None,
        "durationDays": days if detected else 0,
        "weeklyChangeDelta": round(weekly_change, 3),
        "type": plateau_type,
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
            lines.append(f"오늘 {current_kg}kg이지만 추세는 {ewma_kg}kg, {direction}일 수 있어요.")

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
            lines.append("느리지만 지속 가능한 페이스입니다. 장기 유지에 유리합니다.")

    return {"headline": lines[0] if lines else None, "lines": lines}


def data_quality_diagnostics(rows: list[dict[str, Any]], window_days: int = 30, outlier_delta_kg: float = 1.5, streak_penalty_days: int = 5, coverage_penalty_pct: float = 70.0) -> dict[str, Any]:
    """Phase 1 — data quality diagnostics for the candidate model pipeline."""
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
    outlier_candidates = 0
    previous_weight: float | None = None
    measured_dates = 0
    total_dates = total_days

    recent_measured_weights: list[float] = []
    for row in last_n:
        w = row.get("weight_kg")
        if w is not None:
            recent_measured_weights.append(float(w))

    diffs: list[float] = []
    for i in range(1, len(recent_measured_weights)):
        diffs.append(abs(recent_measured_weights[i] - recent_measured_weights[i - 1]))

    adaptive_delta = outlier_delta_kg
    if len(diffs) >= 3:
        mean_diff = sum(diffs) / len(diffs)
        variance = sum((d - mean_diff) ** 2 for d in diffs) / len(diffs)
        std_diff = variance ** 0.5
        adaptive_delta = max(outlier_delta_kg, std_diff * 2)

    for row in rows:
        weight = row.get("weight_kg")
        if weight is None:
            current_streak += 1
            longest_missing = max(longest_missing, current_streak)
        else:
            current_streak = 0
            measured_dates += 1
            if previous_weight is not None and abs(weight - previous_weight) >= adaptive_delta:
                outlier_candidates += 1
            previous_weight = weight

    cadence = round(measured_dates / total_dates, 3) if total_dates else None
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
    if outlier_candidates > total_days * 0.2:
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
        weekly_loss_rate_kg = round(weekly_loss_rate_kg or weekly_change_kg, 4)
        weekly_change_kg_display = weekly_loss_rate_kg
    elif weekly_change_kg <= -flat_threshold:
        direction = "gaining"
        weekly_loss_rate_kg = None
        weekly_change_kg_display = weekly_change_kg
    else:
        direction = "flat"
        weekly_loss_rate_kg = None
        weekly_change_kg_display = weekly_change_kg

    prediction_enabled = direction == "losing"
    disabled_reason = {
        "losing": None,
        "gaining": "trend_is_gaining",
        "flat": "trend_is_flat",
        "unknown": "insufficient_data",
    }[direction]

    return {
        "direction": direction,
        "weeklyChangeKg": weekly_change_kg_display,
        "weeklyLossRateKg": weekly_loss_rate_kg,
        "predictionEnabled": prediction_enabled,
        "disabledReason": disabled_reason,
    }


def nearest_actual_for_backtest(rows: list[dict[str, Any]], target_day: date, start_idx: int, tolerance_days: int = 3) -> float | None:
    """Find the closest actual measurement to a target horizon day within tolerance."""
    candidates: list[tuple[int, float]] = []
    for point in rows[start_idx:]:
        weight = point.get("weight_kg") if isinstance(point, dict) else None
        if weight is None:
            continue
        distance = abs((date.fromisoformat(point["date"]) - target_day).days)
        if distance <= tolerance_days:
            candidates.append((distance, weight))
    return min(candidates, key=lambda item: item[0])[1] if candidates else None


def summarize_backtest_errors(errors: list[float], min_samples: int = 20) -> dict[str, Any]:
    if not errors:
        return {"sampleCount": 0, "maeKg": None, "rmseKg": None, "biasKg": None, "status": "insufficient"}
    mae = sum(abs(e) for e in errors) / len(errors)
    bias = sum(errors) / len(errors)
    rmse = math.sqrt(sum(e * e for e in errors) / len(errors))
    status = "ok" if len(errors) >= min_samples else "insufficient"
    return {
        "sampleCount": len(errors),
        "maeKg": round(mae, 3),
        "rmseKg": round(rmse, 3),
        "biasKg": round(bias, 3),
        "status": status,
    }


def run_regression_slope(dates: list[str], values: list[float | None], window_days: int) -> tuple[float | None, int]:
    start = max(0, len(dates) - window_days)
    pts: list[tuple[float, float]] = []
    for i in range(start, len(dates)):
        v = values[i]
        if v is not None:
            pts.append((float(i - start), v))
    if len(pts) < 3:
        return None, len(pts)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    xm = sum(xs) / len(xs)
    ym = sum(ys) / len(ys)
    num = sum((x - xm) * (y - ym) for x, y in zip(xs, ys))
    den = sum((x - xm) ** 2 for x in xs)
    slope = num / den if den != 0 else 0.0
    return slope, len(pts)


def candidate_weighted_regression(dates: list[str], values: list[float | None], window_days: int = 56) -> tuple[float | None, int]:
    """Weighted linear regression with linear recency weights."""
    start = max(0, len(dates) - window_days)
    pts: list[tuple[float, float, float]] = []
    for i in range(start, len(dates)):
        v = values[i]
        if v is None:
            continue
        weight = float(i - start + 1)
        pts.append((float(i - start), v, weight))
    if len(pts) < 3:
        return None, len(pts)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    ws = [p[2] for p in pts]
    wsum = sum(ws)
    if wsum <= 0:
        return None, len(pts)
    xm = sum(x * w for x, w in zip(xs, ws)) / wsum
    ym = sum(y * w for y, w in zip(ys, ws)) / wsum
    num = sum(w * (x - xm) * (y - ym) for x, y, w in zip(xs, ys, ws))
    den = sum(w * (x - xm) ** 2 for x, w in zip(xs, ws))
    return num / den if den != 0 else 0.0, len(pts)


def candidate_robust_regression(dates: list[str], values: list[float | None], window_days: int = 56, delta_kg: float = 1.5) -> tuple[float | None, int]:
    """Robust-ish slope estimator: trim one-sided outliers larger than delta_kg before OLS."""
    start = max(0, len(dates) - window_days)
    pts: list[tuple[float, float]] = []
    previous: float | None = None
    for i in range(start, len(dates)):
        v = values[i]
        if v is None:
            continue
        if previous is not None and abs(v - previous) >= delta_kg:
            pts.append((float(i - start), v * 1.01))
            previous = v
            continue
        pts.append((float(i - start), v))
        previous = v
    if len(pts) < 3:
        return None, len(pts)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    xm = sum(xs) / len(xs)
    ym = sum(ys) / len(ys)
    num = sum((x - xm) * (y - ym) for x, y in zip(xs, ys))
    den = sum((x - xm) ** 2 for x in xs)
    return num / den if den != 0 else 0.0, len(pts)


def candidate_linreg(dates: list[str], values: list[float | None], window_days: int = 28) -> tuple[float | None, int]:
    return run_regression_slope(dates, values, window_days)


def compute_candidate_prediction(candidate_name: str, cutoff_dates: list[str], cutoff_values: list[float | None], rolling_ewma: float | None, rolling_ma7: float | None, train_window: int = 56) -> tuple[float | None, float | None, str | None]:
    """Return predicted_weight at cutoff, weekly_change, or reason unavailable."""
    if candidate_name == "flat_baseline":
        if rolling_ewma is None:
            return None, None, "no_ewma"
        predicted = rolling_ewma
        weekly_change = 0.0
        return predicted, weekly_change, None
    if candidate_name == "ma7_baseline":
        if cutoff_values[-1] is None:
            return None, None, "no_measurement"
        ma7_values = [v for v in cutoff_values[-7:] if v is not None]
        if len(ma7_values) < 3:
            return None, None, "insufficient_ma7"
        predicted = sum(ma7_values) / len(ma7_values)
        weekly_change = 0.0
        return predicted, weekly_change, None
    if candidate_name == "ewma_baseline":
        if rolling_ewma is None:
            return None, None, "no_ewma"
        predicted = rolling_ewma
        weekly_change = 0.0
        return predicted, weekly_change, None
    if candidate_name == "current_multi_window_ewma_blend":
        return None, None, "uses_separate_multi_window_slope_blend"
    if candidate_name == "linear_regression_28d":
        slope, n = candidate_linreg(cutoff_dates, cutoff_values, 28)
        if slope is None:
            return None, None, "insufficient_points"
        predicted = rolling_ewma if rolling_ewma is not None else cutoff_values[-1]
        weekly_change = -slope * 7
        return predicted, weekly_change, None
    if candidate_name == "linear_regression_56d":
        slope, n = candidate_linreg(cutoff_dates, cutoff_values, 56)
        if slope is None:
            return None, None, "insufficient_points"
        predicted = rolling_ewma if rolling_ewma is not None else cutoff_values[-1]
        weekly_change = -slope * 7
        return predicted, weekly_change, None
    if candidate_name == "linear_regression_84d":
        slope, n = candidate_linreg(cutoff_dates, cutoff_values, 84)
        if slope is None:
            return None, None, "insufficient_points"
        predicted = rolling_ewma if rolling_ewma is not None else cutoff_values[-1]
        weekly_change = -slope * 7
        return predicted, weekly_change, None
    if candidate_name == "weighted_linear_regression_56d":
        slope, n = candidate_weighted_regression(cutoff_dates, cutoff_values, 56)
        if slope is None:
            return None, None, "insufficient_points"
        predicted = rolling_ewma if rolling_ewma is not None else cutoff_values[-1]
        weekly_change = -slope * 7
        return predicted, weekly_change, None
    if candidate_name == "robust_regression_56d":
        slope, n = candidate_robust_regression(cutoff_dates, cutoff_values, 56)
        if slope is None:
            return None, None, "insufficient_points"
        predicted = rolling_ewma if rolling_ewma is not None else cutoff_values[-1]
        weekly_change = -slope * 7
        return predicted, weekly_change, None
    if candidate_name == "kalman":
        return None, None, "kalman_requires_separate_filter"
    return None, None, "unknown_candidate"


def run_generalized_backtest(rows: list[dict[str, Any]], ewma_series: list[dict[str, Any]], candidate_names: list[str] | None = None, train_window: int = 28, horizon_days: tuple[int, ...] = (7, 14, 28), tolerance_days: int = 3) -> dict[str, Any]:
    """Phase 3 — rolling backtest over candidate models. Trains only on prefix before each cutoff."""
    default_candidates = [
        "flat_baseline",
        "ma7_baseline",
        "ewma_baseline",
        "current_multi_window_ewma_blend",
        "linear_regression_28d",
        "linear_regression_56d",
        "linear_regression_84d",
        "weighted_linear_regression_56d",
        "robust_regression_56d",
        "kalman",
    ]
    candidate_names = [name for name in (candidate_names or default_candidates) if name in default_candidates]
    dates = [row["date"] for row in rows]
    values = [row.get("weight_kg") for row in rows]
    ewma_by_date = {p["date"]: p["valueKg"] for p in ewma_series if p.get("valueKg") is not None}
    latest_ewma = next((p["valueKg"] for p in reversed(ewma_series) if p.get("valueKg") is not None), None)
    out: dict[str, Any] = {}
    for candidate in candidate_names:
        candidate_out: dict[str, Any] = {}
        for horizon in horizon_days:
            errors: list[float] = []
            for idx in range(train_window, len(rows) - horizon):
                cutoff_date = rows[idx - 1]["date"]
                cutoff_ewma = ewma_by_date.get(cutoff_date)
                cutoff_dates_prefix = dates[:idx]
                cutoff_values_prefix = values[:idx]
                predicted, weekly_change, reason = compute_candidate_prediction(
                    candidate,
                    cutoff_dates_prefix,
                    cutoff_values_prefix,
                    cutoff_ewma,
                    values[idx - 1],
                    train_window=train_window,
                )
                if reason:
                    continue
                target_day = date.fromisoformat(cutoff_date) + timedelta(days=horizon)
                actual = nearest_actual_for_backtest(rows, target_day, idx, tolerance_days=tolerance_days)
                if actual is None:
                    continue
                if weekly_change is None:
                    continue
                if candidate == "current_multi_window_ewma_blend":
                    continue
                if predicted is None:
                    continue
                try:
                    week_fraction = max(horizon / 7, 1.0)
                    prediction = predicted + weekly_change * week_fraction
                except Exception:
                    continue
                errors.append(round(prediction - actual, 4))
            candidate_out[f"{horizon}d"] = summarize_backtest_errors(errors)
        out[candidate] = candidate_out
    kalman_out: dict[str, Any] = {}
    try:
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location("kalman_predictor", Path(__file__).resolve().parent / "kalman_predictor.py")
        if _spec is not None and _spec.loader is not None:
            _mod = _ilu.module_from_spec(_spec)
            _spec.loader.exec_module(_mod)
            kalman_rows = [{"date": r["date"], "weight_kg": r.get("weight_kg")} for r in rows]
            kalman_out = _mod.kalman_backtest(kalman_rows, horizons=horizon_days, train_window=train_window)
    except Exception as exc:
        kalman_out = {"error": str(exc)}
    if "kalman" in candidate_names:
        out["kalman"] = kalman_out
    return out


def apply_model_selection_gate(audit: dict[str, Any], current_metrics: dict[str, Any], gate: dict[str, Any] | None = None) -> dict[str, Any]:
    """Phase 4 — conservative model selection gate."""
    current_backtest = current_metrics or {}
    gate = {
        "minSampleCount": 20,
        "minImprovementKg": 0.05,
        "minImprovementPct": 0.08,
        "minHorizonWins": 2,
    } | (gate or {})
    min_samples = int(gate["minSampleCount"])
    min_improve_abs = float(gate["minImprovementKg"])
    min_improve_pct = float(gate["minImprovementPct"])
    min_horizon_wins = int(gate["minHorizonWins"])

    best_candidate = "current"
    best_reason = "no_candidate"
    wins: dict[str, Any] = {}
    for candidate, horizons in audit.items():
        if candidate == "current_multi_window_ewma_blend":
            continue
        candidate_wins = 0
        passes = True
        reasons: list[str] = []
        for horizon_key, stats in horizons.items():
            if not isinstance(stats, dict):
                continue
            current_h = current_backtest.get(horizon_key) or {}
            if stats.get("status") != "ok" or current_h.get("status") != "ok":
                passes = False
                reasons.append(f"{horizon_key}_not_ok")
                continue
            if stats.get("sampleCount", 0) < min_samples:
                passes = False
                reasons.append(f"{horizon_key}_sample_count_low")
                continue
            current_mae = current_h.get("maeKg")
            candidate_mae = stats.get("maeKg")
            if current_mae is None or candidate_mae is None:
                passes = False
                reasons.append(f"{horizon_key}_missing_mae")
                continue
            improve_abs = float(current_mae) - float(candidate_mae)
            improve_pct = improve_abs / float(current_mae) if current_mae else 0.0
            if improve_abs >= min_improve_abs or improve_pct >= min_improve_pct:
                candidate_wins += 1
            if candidate_wins >= min_horizon_wins and passes:
                best_candidate = candidate
                best_reason = "beat_current_on_selection_gate"
                break
        if best_candidate == candidate and passes:
            break

    status = "kept_current" if best_candidate == "current" else "adopted_new"
    if best_candidate != "current":
        best_reason = f"adopted_{best_candidate}"
    return {
        "name": best_candidate if status == "adopted_new" else "current",
        "status": status,
        "reason": best_reason,
        "gate": gate,
    }


def compute_ci_calibration_replay(rows: list[dict[str, Any]], ewma_series: list[dict[str, Any]], central_fn, spread_fn, train_window: int = 28, tolerance_days: int = 3) -> dict[str, Any]:
    """Phase 6 — replay selected-model CI bands against historical actuals.

    central_fn(horizon_days, cutoff_ewma, cutoff_values_prefix) -> central_prediction
    spread_fn(horizon_days) -> upper-lower half-width
    """
    dates = [row["date"] for row in rows]
    values = [row.get("weight_kg") for row in rows]
    ewma_by_date = {p["date"]: p["valueKg"] for p in ewma_series if p.get("valueKg") is not None}
    out: dict[str, Any] = {}
    for horizon in (7, 14, 28):
        hits = 0
        total = 0
        for idx in range(train_window, len(rows) - horizon):
            cutoff_date = rows[idx - 1]["date"]
            cutoff_ewma = ewma_by_date.get(cutoff_date)
            cutoff_dates = dates[:idx]
            cutoff_values = values[:idx]
            central = central_fn(horizon, cutoff_ewma, cutoff_values)
            spread = spread_fn(horizon)
            if central is None or spread is None:
                continue
            target_day = date.fromisoformat(cutoff_date) + timedelta(days=horizon)
            actual = nearest_actual_for_backtest(rows, target_day, idx, tolerance_days=tolerance_days)
            if actual is None:
                continue
            total += 1
            if abs(actual - central) <= spread:
                hits += 1
        out[f"{horizon}d"] = round(hits / total, 3) if total else None
    hit_rate = {k: v for k, v in out.items()}
    status = "ok" if any(v is not None for v in hit_rate.values()) else "insufficient"
    return {
        "hitRate": {"7d": hit_rate["7d"], "14d": hit_rate["14d"], "28d": hit_rate["28d"]},
        "status": status,
        "samples": sum(1 for v in hit_rate.values() if v is not None),
    }
