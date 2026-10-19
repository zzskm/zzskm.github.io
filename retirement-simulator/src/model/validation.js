import { autoPensionStartAge } from "./pension.js";

function validateInput(input) {
  const warnings = [];
  if (input.retireAge <= input.currentAge)
    warnings.push({ key: "retire_age", level: "error", msg: `퇴직 나이(${input.retireAge}세)가 현재 나이(${input.currentAge}세) 이하입니다.` });
  if (input.selfPensionStartAge <= input.retireAge)
    warnings.push({ key: "pension_start", level: "warn", msg: `국민연금 개시(${input.selfPensionStartAge}세)가 퇴직(${input.retireAge}세) 이전 또는 동시입니다. 브릿지 기간이 0이 됩니다.` });
  if (input.selfLifeExpectancy <= input.retireAge)
    warnings.push({ key: "life_exp", level: "error", msg: `기대수명(${input.selfLifeExpectancy}세)이 퇴직 나이(${input.retireAge}세) 이하입니다.` });
  if (input.housingMode === "own" && input.hasMortgage && input.mortgageBalance > 0 && input.monthlyMortgagePayment <= 0)
    warnings.push({ key: "mortgage", level: "warn", msg: "대출 잔액이 있으나 월 원리금이 0입니다. 대출이 상환되지 않습니다." });
  if ((input.investmentBalance + input.savingsBalance) <= 0 && input.selfCurrentSalary <= 0)
    warnings.push({ key: "no_asset", level: "warn", msg: "금융자산과 소득이 모두 0입니다. 자산 항목을 확인해주세요." });
  if (input.investmentReturnRate > 0 && input.inflationRate >= input.investmentReturnRate)
    warnings.push({ key: "real_return", level: "warn", msg: `물가상승률(${input.inflationRate}%)이 투자수익률(${input.investmentReturnRate}%)보다 높습니다. 투자수익이 물가를 따라가지 못합니다.` });
  if (input.spouseEnabled && input.spouseCurrentAge != null && input.spouseLifeExpectancy != null
      && input.spouseLifeExpectancy <= input.spouseCurrentAge)
    warnings.push({ key: "spouse_life", level: "error", msg: `배우자 기대수명(${input.spouseLifeExpectancy}세)이 현재 나이(${input.spouseCurrentAge}세) 이하입니다.` });
  // 자가 모드: 대출 잔액 > 주택 가치 경고
  if (input.housingMode === "own" && input.hasMortgage
      && input.mortgageBalance > 0 && input.housePrice > 0
      && input.mortgageBalance > input.housePrice * 0.9)
    warnings.push({ key: "mortgage_ratio", level: "warn", msg: `대출 잔액(${(input.mortgageBalance/10000).toFixed(1)}억)이 주택 시세(${(input.housePrice/10000).toFixed(1)}억)의 90%를 초과합니다.` });
  // 전세/월세 모드: 보증금이 0인 경우
  if ((input.housingMode === "jeonse" || input.housingMode === "monthly_rent")
      && (input.deposit ?? 0) === 0 && input.housingMode === "jeonse")
    warnings.push({ key: "jeonse_no_deposit", level: "warn", msg: "전세 모드인데 보증금이 0입니다. 보증금을 입력해주세요." });
  // 조기수령 한도 (법정 개시 −5년까지)
  const legalPensionAge = autoPensionStartAge(input.currentAge);
  if (input.selfPensionStartAge < legalPensionAge - 5)
    warnings.push({ key: "early_pension", level: "warn", msg: `국민연금 조기수령은 법정 개시(${legalPensionAge}세)의 5년 전까지만 가능합니다. 감액 하한(−30%)으로 계산됩니다.` });
  // 원리금이 이자에 못 미치는 경우 (실질 기준)
  if (input.housingMode === "own" && input.hasMortgage && input.mortgageBalance > 0 && input.monthlyMortgagePayment > 0) {
    // 월 원리금은 명목 고정 → 명목 금리의 이자와 비교
    if (input.monthlyMortgagePayment * 12 <= input.mortgageBalance * ((input.mortgageRate ?? 4) / 100))
      warnings.push({ key: "mortgage_interest", level: "warn", msg: "월 원리금이 대출 이자보다 적어 잔액이 줄지 않습니다. 원리금 또는 금리를 확인해주세요." });
  }
  return warnings;
}


export { validateInput };
