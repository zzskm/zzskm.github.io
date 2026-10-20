import { buildStressRateFn } from "./stress.js";
import { ASSUMPTIONS } from "./assumptions.js";
import { calculateScenario } from "./cashflow.js";

const STRESS_PRESETS = {
  none:   { label: "없음",              color: "none" },
  mild:   { label: "경미 (-5%p, 3년)", color: "#f59e0b",
            desc: "퇴직 직후 3년간 수익률 -5%p. 2001년 닷컴 버블 붕괴 수준." },
  severe: { label: "중간 (-10%p, 5년)", color: "#ef4444",
            desc: "퇴직 직후 5년간 수익률 -10%p. 2008년 금융위기 장기 침체 수준." },
  "2008": { label: "2008 (−30%, 회복)", color: "#7c3aed",
            desc: "첫해 -30%p 폭락 후 2년간 +10%p 반등, 이후 정상. 최악의 시나리오." },
};

// 수익률 밴드 (명목 % 기준)
function runScenarioBand(input, assumptions = ASSUMPTIONS) {
  const r = input.investmentReturnRate;
  const s = input.scenarioBandSpread;
  const inflRate = input.inflationRate / 100;

  // C1: 선택된 stressTest 프리셋으로 sequenceShock 계산
  const stressKey = input.stressTest ?? "severe";
  const stressRateFn = buildStressRateFn(stressKey, r, input.retireAge, inflRate);
  const hasStress = stressKey !== "none";

  return {
    pessimistic:    calculateScenario(input, r - s, assumptions),
    mid:            calculateScenario(input, r,     assumptions),
    optimistic:     calculateScenario(input, r + s, assumptions),
    sequenceShock:  hasStress
      ? calculateScenario(input, stressRateFn, assumptions, { skipProjectionStress: true })
      : null,
    stressKey,  // UI에서 라벨 표시용
  };
}


export { STRESS_PRESETS, buildStressRateFn, runScenarioBand };
