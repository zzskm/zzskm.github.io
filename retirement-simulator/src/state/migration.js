import { ASSUMPTIONS } from "../model/assumptions.js";
import { KR_DEFAULTS } from "../model/defaults.js";
import { autoPensionStartAge, autoLifeExpectancy } from "../model/pension.js";

function normalizeInput(raw = {}) {
  const legacyChildren = [raw.child1BirthYear, raw.child2BirthYear]
    .filter(Boolean)
    .map((birthYear, idx) => ({ id: `legacy-child-${idx + 1}`, birthYear }));
  const children = Array.isArray(raw.children)
    ? raw.children.filter(c => c && c.birthYear).slice(0, 5).map((c, idx) => ({
        id: c.id || `child-${idx + 1}`,
        birthYear: Number(c.birthYear),
      }))
    : legacyChildren;

  // v3 → v4 마이그레이션: 단일 필드 → 본인/배우자 분리
  const selfCurrentSalary  = raw.selfCurrentSalary  ?? raw.currentSalary       ?? KR_DEFAULTS.selfCurrentSalary;
  const selfLifeExpectancy = raw.selfLifeExpectancy  ?? raw.lifeExpectancy      ?? autoLifeExpectancy(raw.currentAge ?? KR_DEFAULTS.currentAge);
  const selfPensionStartAge = raw.selfPensionStartAge ?? raw.pensionStartAge    ?? autoPensionStartAge(raw.currentAge ?? KR_DEFAULTS.currentAge);
  const selfNpYears        = raw.selfNpYears         ?? raw.npYearsContributed  ?? 0;
  const selfNpAutoMode     = raw.selfNpAutoMode      ?? raw.npYearsAutoMode     ?? true;

  // v3 spouseMonthlyIncome(월)→v4 spouseCurrentSalary(연봉)
  const spouseCurrentSalary = raw.spouseCurrentSalary
    ?? (raw.spouseMonthlyIncome != null ? raw.spouseMonthlyIncome * 12 : KR_DEFAULTS.spouseCurrentSalary);

  const spouseLifeExpectancy  = raw.spouseLifeExpectancy  ?? raw.lifeExpectancy       ?? autoLifeExpectancy(raw.spouseCurrentAge ?? KR_DEFAULTS.spouseCurrentAge);
  const spousePensionStartAge = raw.spousePensionStartAge ?? raw.pensionStartAge      ?? autoPensionStartAge(raw.spouseCurrentAge ?? KR_DEFAULTS.spouseCurrentAge);

  const input = {
    ...KR_DEFAULTS,
    ...raw,
    selfCurrentSalary,
    selfLifeExpectancy,
    selfPensionStartAge,
    selfNpYears,
    selfNpAutoMode,
    selfNpInputMode:     raw.selfNpInputMode     ?? "auto",
    selfNpManualMonthly: raw.selfNpManualMonthly ?? 0,
    spouseCurrentSalary,
    spouseLifeExpectancy,
    spousePensionStartAge,
    spouseNpYears:       raw.spouseNpYears       ?? 0,
    spouseNpAutoMode:    raw.spouseNpAutoMode     ?? true,
    spouseNpInputMode:   raw.spouseNpInputMode    ?? "auto",
    spouseNpManualMonthly: raw.spouseNpManualMonthly ?? 0,
    postRetireSideIncome: raw.postRetireSideIncome ?? raw.sideIncomeSelf ?? KR_DEFAULTS.postRetireSideIncome,
    // v4→v5 bucket rename: retirementBalance→investmentBalance, cashSavings→savingsBalance
    // 개인연금(privatePensionBalance)은 투자성 자산으로 통합
    investmentBalance:   raw.investmentBalance
      ?? (raw.retirementBalance != null ? raw.retirementBalance + (raw.privatePensionBalance ?? 0) : undefined)
      ?? raw.currentDC
      ?? KR_DEFAULTS.investmentBalance,
    savingsBalance:      raw.savingsBalance
      ?? raw.cashSavings
      ?? raw.insuranceValue
      ?? KR_DEFAULTS.savingsBalance,
    savingsReturnRate:   raw.savingsReturnRate    ?? KR_DEFAULTS.savingsReturnRate,
    monthlyAddSaving:    raw.monthlyAddSaving     ?? raw.monthlyAdditionalSaving ?? KR_DEFAULTS.monthlyAddSaving,
    spouseEnabled:       raw.spouseEnabled        ?? ((raw.spouseMonthlyIncome ?? raw.spouseCurrentSalary ?? 0) > 0),
    spouseCurrentAge:    raw.spouseCurrentAge     ?? KR_DEFAULTS.spouseCurrentAge,
    // PR4: housingMode (hasHouse 레거시 마이그레이션)
    housingMode:         raw.housingMode          ?? (raw.hasHouse === false ? "monthly_rent" : "own"),
    housingMaintenance:  raw.housingMaintenance   ?? KR_DEFAULTS.housingMaintenance,
    housingInflationScenario: raw.housingInflationScenario ?? KR_DEFAULTS.housingInflationScenario,
    deposit:             raw.deposit              ?? KR_DEFAULTS.deposit,
    monthlyRent:         raw.monthlyRent          ?? KR_DEFAULTS.monthlyRent,
    hasMortgage:         raw.hasMortgage          ?? ((raw.mortgageBalance ?? KR_DEFAULTS.mortgageBalance) > 0),
    includeSeveranceLumpSum:   raw.includeSeveranceLumpSum   ?? ASSUMPTIONS.assetRules.includeSeveranceLumpSumDefault,
    medicalCostMultiplier:     raw.medicalCostMultiplier     ?? 1.0,
    applyMedicalCost:          raw.applyMedicalCost          ?? true,
    // C5: 인출 전략
    withdrawalStrategy:        (raw.withdrawalStrategy === "unified" ? "bucket" : raw.withdrawalStrategy) ?? "bucket",
    // C1: 시퀀스 리스크 스트레스 테스트
    stressTest:                raw.stressTest                ?? "severe",
    // PR3: 소득 입력 표시 모드 (net annual은 selfCurrentSalary에 저장, 이건 UI 전용)
    selfSalaryBasis:           raw.selfSalaryBasis           ?? "gross",
    spouseSalaryBasis:         raw.spouseSalaryBasis         ?? "gross",
    children,
  };

  // 명목 % 마이그레이션: v3 이하는 실질 %를 입력했음
  // v4부터 명목 % 입력 — LS_KEY가 바뀌었으므로 LEGACY 로드 시만 변환 필요
  // 단순히 기존 값을 그대로 쓰되, 하위 호환성 이슈 최소화를 위해 정상 범위로 클램핑
  // (실질 3.5% → 명목 3.5%는 약간 낮지만 사용자가 다시 설정할 것)

  const isOwn = input.housingMode === "own";
  const normalized = {
    ...input,
    housePrice:            isOwn ? input.housePrice : 0,
    mortgageBalance:       isOwn && input.hasMortgage ? input.mortgageBalance : 0,
    monthlyMortgagePayment: isOwn && input.hasMortgage ? input.monthlyMortgagePayment : 0,
    downsizeEnabled:       isOwn ? input.downsizeEnabled : false,
    // 자가 아닌 모드에서 자가 전용 필드 무효화
    deposit:               isOwn ? 0 : input.deposit,
    monthlyRent:           input.housingMode === "monthly_rent" ? input.monthlyRent : 0,
  };
  // 레거시 필드 정리
  delete normalized.hasHouse;
  delete normalized.lifeExpectancy;
  delete normalized.pensionStartAge;
  delete normalized.npYearsContributed;
  delete normalized.npYearsAutoMode;
  delete normalized.currentSalary;
  delete normalized.spouseMonthlyIncome;
  delete normalized.sideIncomeSelf;
  delete normalized.sideIncomeSpouse;
  delete normalized.currentDC;
  delete normalized.currentPensionSavings;
  delete normalized.insuranceValue;
  delete normalized.monthlyAdditionalSaving;
  delete normalized.child1BirthYear;
  delete normalized.child2BirthYear;
  // v4→v5 제거된 필드
  delete normalized.retirementBalance;
  delete normalized.cashSavings;
  delete normalized.privatePensionBalance;
  delete normalized.privatePensionStartAge;
  delete normalized.privatePensionWithdrawRate;
  delete normalized.applyPensionTax;
  return normalized;
}


export { normalizeInput };
