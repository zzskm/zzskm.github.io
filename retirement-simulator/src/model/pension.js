import { ASSUMPTIONS, CURRENT_YEAR } from "./assumptions.js";
import { netToGrossAnnual } from "./taxation.js";

function autoPensionStartAge(currentAge) {
  const birthYear = CURRENT_YEAR - currentAge;
  if (birthYear >= 1969) return 65;
  if (birthYear >= 1965) return 64;
  if (birthYear >= 1961) return 63;
  return 62;
}

// 조기(−6%/년, 최대 5년)·연기(+7.2%/년, 최대 5년) 수령 계수
function pensionClaimFactor(startAge, legalAge) {
  const diff = (startAge ?? legalAge) - legalAge;
  if (diff < 0) return Math.max(0.70, 1 + 0.06 * diff);
  return Math.min(1.36, 1 + 0.072 * diff);
}

// 퇴직 나이 기준 자동 가입연수
function autoNpYears(retireAge, policy = ASSUMPTIONS.krPolicy) {
  return Math.min(policy.maxNpYears, Math.max(0, retireAge - policy.contributionStartAge));
}

// 기본 계획 수명. 통계청 2024 생명표의 기대수명(출생 시 남 80.8·여 86.6, 40세 기대여명 남 41.9·여 47.4년)은
// '평균'이라 절반 가까이는 그보다 오래 산다. 노후 설계는 장수 리스크를 보수적으로 잡아 90세(고령자는 현재 나이+15세)를 기본으로 한다.
function autoLifeExpectancy(currentAge) {
  return Math.max(90, currentAge + 15);
}

// 부부 최대 수명을 본인 나이축으로 환산
function simEndAgeFor(input) {
  const selfLE = input.selfLifeExpectancy ?? 87;
  if (!input.spouseEnabled) return selfLE;
  const offset = (input.spouseCurrentAge ?? input.currentAge) - input.currentAge;
  const spouseLeInSelfAge = (input.spouseLifeExpectancy ?? selfLE) - offset;
  return Math.max(selfLE, spouseLeInSelfAge);
}

// ============================================================
// 계산 헬퍼
// ============================================================

function npYearsFor(input, person, assumptions = ASSUMPTIONS) {
  const policy = assumptions.krPolicy;
  if (person === "spouse") {
    if (input.spouseNpAutoMode) return Math.min(policy.maxNpYears, Math.max(0, input.spouseRetireAge - policy.contributionStartAge));
    return Math.min(policy.maxNpYears, Math.max(0, input.spouseNpYears));
  }
  // self
  if (input.selfNpAutoMode) return autoNpYears(input.retireAge, policy);
  return Math.min(policy.maxNpYears, Math.max(0, input.selfNpYears));
}

function estimatedPensionMonthlyFor(input, person, assumptions = ASSUMPTIONS) {
  const policy = assumptions.krPolicy;
  // B값: 세전 월소득 기준 + 기준소득월액 상·하한 (저장값은 세후 연봉이므로 역산)
  const bValue = (netAnnual) => Math.min(Math.max(netToGrossAnnual(netAnnual ?? 0) / 12, policy.npMinBaseMonthly), policy.npMaxBaseMonthly);
  // 소득이 0이면 보험료를 내지 않는 것으로 보고 자동 추정 연금은 0 (전업·무소득 → 직접 입력 모드 사용)
  const hasIncome = (netAnnual) => (netAnnual ?? 0) > 0;
  if (person === "spouse") {
    if (input.spouseNpInputMode === "manual") return input.spouseNpManualMonthly ?? 0;
    if (!hasIncome(input.spouseCurrentSalary)) return 0;
    const avgMonthly = (policy.pensionAValueMonthly + bValue(input.spouseCurrentSalary)) / 2;
    const years = npYearsFor(input, "spouse", assumptions);
    const replacement = years < 10 ? 0 : policy.pensionReplacementRate * (years / policy.maxNpYears);
    return replacement * avgMonthly;
  }
  // self
  if (input.selfNpInputMode === "manual") return input.selfNpManualMonthly ?? 0;
  if (!hasIncome(input.selfCurrentSalary)) return 0;
  const avgMonthly = (policy.pensionAValueMonthly + bValue(input.selfCurrentSalary)) / 2;
  const years = npYearsFor(input, "self", assumptions);
  const replacement = years < 10 ? 0 : policy.pensionReplacementRate * (years / policy.maxNpYears);
  return replacement * avgMonthly;
}

// 하위 호환용 (인사이트 등에서 사용)
function npYears(input, assumptions = ASSUMPTIONS) { return npYearsFor(input, "self", assumptions); }
function estimatedPensionMonthly(input, assumptions = ASSUMPTIONS) { return estimatedPensionMonthlyFor(input, "self", assumptions); }


export { autoPensionStartAge, pensionClaimFactor, autoNpYears, autoLifeExpectancy, simEndAgeFor, npYearsFor, estimatedPensionMonthlyFor, npYears, estimatedPensionMonthly };
