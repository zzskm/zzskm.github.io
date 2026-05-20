"""Phase 5 — 2-state Kalman filter for weight tracking.

State vector: x = [weight_kg, velocity_kg_per_day]
Transition:   x_t = F x_{t-1} + noise,  F = [[1, dt], [0, 1]],  dt = 1 day
Observation:  z_t = H x_t + noise,      H = [1, 0]

Stdlib only — 2x2 행렬 연산을 풀어 쓴다.

용도:
- `kalman_estimate(weights)` → [{date_idx, weight, velocity}, ...]
- `kalman_backtest(rows, horizons)` → V1과 동일 스키마의 backtest dict

채택은 ROI 게이트 (V1 대비 backtest MAE 0.05kg 이상 개선) 통과 시.
"""
from __future__ import annotations

from typing import Any


# 기본 노이즈 파라미터 — 체중계 측정 노이즈 ~0.3kg, 속도 변화 노이즈는 매우 작게
DEFAULT_PROCESS_NOISE = (0.0001, 0.00005)  # (weight, velocity) variances per day
DEFAULT_OBS_NOISE = 0.09                    # σ ≈ 0.3kg → σ² = 0.09


def _mat2_inv(a: float, b: float, c: float, d: float) -> tuple[float, float, float, float]:
    det = a * d - b * c
    if abs(det) < 1e-12:
        det = 1e-12 if det >= 0 else -1e-12
    return (d / det, -b / det, -c / det, a / det)


def kalman_filter(
    weights: list[float | None],
    process_noise: tuple[float, float] = DEFAULT_PROCESS_NOISE,
    obs_noise: float = DEFAULT_OBS_NOISE,
) -> list[tuple[float, float] | None]:
    """1-step Kalman filter. None 측정은 prediction-only step.

    반환: [(weight_estimate, velocity_estimate) | None for each input index]
    """
    q_w, q_v = process_noise
    r = obs_noise

    # 초기 상태: 첫 유효 측정값으로 초기화, velocity는 0
    x_w: float | None = None
    x_v: float = 0.0
    # 공분산 P (2x2): 큰 초기 불확실성
    p11, p12, p21, p22 = 1.0, 0.0, 0.0, 1.0

    out: list[tuple[float, float] | None] = []

    for z in weights:
        if x_w is None:
            if z is None:
                out.append(None)
                continue
            x_w = z
            x_v = 0.0
            out.append((x_w, x_v))
            continue

        # === Predict step ===
        # x' = F x  → w' = w + v,  v' = v
        x_w_pred = x_w + x_v
        x_v_pred = x_v
        # P' = F P F^T + Q,  F = [[1,1],[0,1]]
        # F P = [[p11+p21, p12+p22],[p21, p22]]
        # F P F^T = [[p11+p12+p21+p22, p12+p22],[p21+p22, p22]]
        p11_pred = p11 + p12 + p21 + p22 + q_w
        p12_pred = p12 + p22
        p21_pred = p21 + p22
        p22_pred = p22 + q_v

        if z is None:
            # 측정 없음 → predict만 적용
            x_w, x_v = x_w_pred, x_v_pred
            p11, p12, p21, p22 = p11_pred, p12_pred, p21_pred, p22_pred
            out.append((x_w, x_v))
            continue

        # === Update step ===
        # y = z - H x',  H = [1, 0]
        y = z - x_w_pred
        # S = H P' H^T + R = p11_pred + r
        s = p11_pred + r
        # K = P' H^T / S = [p11_pred / s, p21_pred / s]
        k1 = p11_pred / s
        k2 = p21_pred / s
        # x = x' + K y
        x_w = x_w_pred + k1 * y
        x_v = x_v_pred + k2 * y
        # P = (I - K H) P'
        p11 = (1 - k1) * p11_pred
        p12 = (1 - k1) * p12_pred
        p21 = p21_pred - k2 * p11_pred
        p22 = p22_pred - k2 * p12_pred

        out.append((x_w, x_v))

    return out


def kalman_velocity_weekly(state: tuple[float, float] | None) -> float | None:
    """현재 상태에서 추정한 주간 감량률 (kg/주, 양수=감소)."""
    if state is None:
        return None
    _, v = state
    return -v * 7


def kalman_backtest(
    rows: list[dict[str, Any]],
    horizons: tuple[int, ...] = (7, 14, 28),
    train_window: int = 28,
    min_samples: int = 3,
) -> dict[str, Any]:
    """V1과 동일한 인터페이스의 백테스트 — 같은 비교 가능하도록.

    각 시점 prefix로 Kalman을 돌려 그 시점의 [weight, velocity] 상태를 얻고,
    선형 외삽 `predicted = weight + velocity * horizon`. (Kalman은 비선형 감쇠를
    내장하지 않지만 짧은 horizon에서는 동등 비교 가능.)
    """
    out: dict[str, Any] = {}
    from datetime import date, timedelta

    for horizon in horizons:
        errors: list[float] = []
        for idx in range(train_window, len(rows) - horizon):
            prefix_weights = [r.get("weight_kg") for r in rows[:idx]]
            states = kalman_filter(prefix_weights)
            last_state = next((s for s in reversed(states) if s is not None), None)
            if last_state is None:
                continue
            w_now, v_now = last_state
            # 음수 속도(=감량)만 의미 있음. 양수(증가)면 보수적으로 0.
            v_eff = min(v_now, 0.0)
            predicted = w_now + v_eff * horizon

            latest = rows[idx - 1]["date"]
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


def compare_backtests(v1: dict[str, Any], kalman: dict[str, Any]) -> dict[str, Any]:
    """horizon별 MAE 개선폭(=V1 - Kalman) 계산. 0.05kg 이상이면 채택 권장."""
    result: dict[str, Any] = {}
    for horizon in set(v1.keys()) | set(kalman.keys()):
        a = v1.get(horizon, {})
        b = kalman.get(horizon, {})
        if a.get("status") == "ok" and b.get("status") == "ok":
            delta = round(a["maeKg"] - b["maeKg"], 3)
            result[horizon] = {
                "v1MaeKg": a["maeKg"],
                "kalmanMaeKg": b["maeKg"],
                "deltaKg": delta,
                "kalmanWins": delta >= 0.05,
            }
    recommend = any(v.get("kalmanWins") for v in result.values())
    return {"perHorizon": result, "recommendKalman": recommend}
