"""2-state Kalman filter for weight tracking (a shadow candidate of the backtest).

State vector: x = [weight_kg, velocity_kg_per_day]
Transition:   x_t = F x_{t-1} + noise,  F = [[1, dt], [0, 1]],  dt = 1 day
Observation:  z_t = H x_t + noise,      H = [1, 0]

Stdlib only — 2x2 행렬 연산을 풀어 쓴다.

`kalman_filter(weights)`는 날마다의 (체중, 속도) 추정을 돌려준다. sync_modeling.run_backtest가 기준 시점의 상태로
`체중 + 속도 × 기간`을 예측해 섀도 후보 `kalman`으로 평가한다. 운영 예측에는 쓰지 않는다.
"""
from __future__ import annotations

# 기본 노이즈 파라미터 — 체중계 측정 노이즈 ~0.3kg, 속도 변화 노이즈는 매우 작게
DEFAULT_PROCESS_NOISE = (0.0001, 0.00005)  # (weight, velocity) variances per day
DEFAULT_OBS_NOISE = 0.09                    # σ ≈ 0.3kg → σ² = 0.09


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
