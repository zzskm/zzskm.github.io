import { ASSUMPTIONS } from "./assumptions.js";

function socialInsuranceAnnual(grossAnnual, tm = ASSUMPTIONS.taxModel, policy = ASSUMPTIONS.krPolicy) {
  const si = tm.socialInsurance;
  const npBaseMonthly = Math.min(Math.max(grossAnnual / 12, policy.npMinBaseMonthly), policy.npMaxBaseMonthly);
  const hi = grossAnnual * si.hi;
  return npBaseMonthly * 12 * si.np + hi + hi * si.ltcOfHi + grossAnnual * si.ei;
}

// 근로소득공제 (구간표, 한도 적용)
function earnedIncomeDeductionOf(grossAnnual, tm = ASSUMPTIONS.taxModel) {
  let prev = 0;
  for (const t of tm.earnedIncomeDeduction) {
    if (grossAnnual <= t.upTo) return Math.min(tm.earnedIncomeDeductionCap, t.base + (grossAnnual - prev) * t.rate);
    prev = t.upTo;
  }
  return tm.earnedIncomeDeductionCap;
}

// 근로소득세액공제 한도 (총급여 구간별)
function earnedTaxCreditCap(g) {
  if (g <= 3300)  return 74;
  if (g <= 7000)  return Math.max(66, 74 - (g - 3300) * 0.008);
  if (g <= 12000) return Math.max(50, 66 - (g - 7000) * 0.5);
  return Math.max(20, 50 - (g - 12000) * 0.5);
}

// 세전 연봉 → 세후 실수령 (만원/년). 본인 1인 기준: 부양가족·연말정산 공제는 반영하지 않는 보수적 추정
function grossToNetAnnual(grossAnnual, tm = ASSUMPTIONS.taxModel) {
  if (!grossAnnual || grossAnnual <= 0) return 0;
  const socialIns = socialInsuranceAnnual(grossAnnual, tm);
  const taxBase   = Math.max(0, grossAnnual - earnedIncomeDeductionOf(grossAnnual, tm) - tm.personalDeduction - socialIns);
  let tax = 0, prev = 0;
  for (const b of tm.incomeBrackets) {
    if (taxBase <= prev) break;
    tax += (Math.min(taxBase, b.upTo) - prev) * b.rate;
    prev = b.upTo;
    if (taxBase <= b.upTo) break;
  }
  const earnedCredit = tax <= 130 ? tax * 0.55 : 71.5 + (tax - 130) * 0.30;
  const incomeTax = Math.max(0, tax - Math.min(earnedCredit, earnedTaxCreditCap(grossAnnual)) - tm.standardTaxCredit);
  const localTax = incomeTax * tm.localTaxRate;
  return Math.max(0, grossAnnual - socialIns - incomeTax - localTax);
}

function netToGrossAnnual(netAnnual, tm = ASSUMPTIONS.taxModel) {
  if (!netAnnual || netAnnual <= 0) return 0;
  let lo = netAnnual, hi = netAnnual * 2.5;
  for (let iter = 0; iter < 32; iter++) {
    const mid = (lo + hi) / 2;
    (grossToNetAnnual(mid, tm) < netAnnual) ? (lo = mid) : (hi = mid);
  }
  return Math.round((lo + hi) / 2);
}

function basisAnnualToNet(annualInBasis, basis) {
  if (!annualInBasis || annualInBasis <= 0) return 0;
  return basis === "gross" ? grossToNetAnnual(annualInBasis) : annualInBasis;
}
function netToBasisAnnual(netAnnual, basis) {
  if (!netAnnual || netAnnual <= 0) return 0;
  return basis === "gross" ? netToGrossAnnual(netAnnual) : netAnnual;
}


export { socialInsuranceAnnual, earnedIncomeDeductionOf, earnedTaxCreditCap, grossToNetAnnual, netToGrossAnnual, basisAnnualToNet, netToBasisAnnual };
