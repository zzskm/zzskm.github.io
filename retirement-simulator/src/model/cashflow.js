import { buildStressRateFn } from "./stress.js";
import { ASSUMPTIONS, CURRENT_YEAR } from "./assumptions.js";
import { netToGrossAnnual } from "./taxation.js";
import { autoPensionStartAge, pensionClaimFactor, simEndAgeFor, estimatedPensionMonthlyFor } from "./pension.js";

function ageFactor(age, assumptions = ASSUMPTIONS) {
  return assumptions.lifeCycle.spendingFactors
    .filter(row => age >= row.fromAge)
    .sort((a, b) => b.fromAge - a.fromAge)[0]?.factor ?? 1.0;
}

function childCostAt(age, assumptions = ASSUMPTIONS) {
  if (age < 0) return 0;
  return assumptions.lifeCycle.childMonthlyCosts.find(row =>
    age >= row.minAge && age <= row.maxAge
  )?.amount ?? 0;
}

function childrenOf(input) {
  if (Array.isArray(input.children)) return input.children.filter(c => c && c.birthYear);
  return [input.child1BirthYear, input.child2BirthYear]
    .filter(Boolean)
    .map((birthYear, idx) => ({ id: `legacy-child-${idx + 1}`, birthYear }));
}

function childCostYearly(input, year, assumptions = ASSUMPTIONS) {
  let cost = 0;
  for (const child of childrenOf(input)) {
    cost += childCostAt(year - child.birthYear, assumptions) * 12;
  }
  return cost * (input.childCostMultiplier ?? 1.0);
}

function childEvents(input) {
  const events = [];
  childrenOf(input).forEach((child, i) => {
    const idx = i + 1;
    const parentAgeAt = (childAge) =>
      input.currentAge + ((child.birthYear + childAge) - CURRENT_YEAR);
    events.push({ age: parentAgeAt(19), label: `자녀${idx} 대학` });
    events.push({ age: parentAgeAt(23), label: `자녀${idx} 독립` });
  });
  const endAge = simEndAgeFor(input);
  return events.filter(e => e.age >= input.currentAge && e.age <= endAge);
}

// 연령별 의료비 1인 기준 (만원/월), 의료물가 초과 상승 반영
function medicalCostMonthly(age, yearsFromNow, assumptions = ASSUMPTIONS) {
  const lc = assumptions.lifeCycle;
  const base = [...(lc.medicalMonthlyByAge ?? [])]
    .filter(r => age >= r.fromAge)
    .sort((a, b) => b.fromAge - a.fromAge)[0]?.amount ?? 0;
  const premium = (lc.medicalInflationRealPremium ?? 0) / 100;
  return base * Math.pow(1 + premium, yearsFromNow);
}

// 지역가입자 건강보험료 단순 추정 (만원/년). 실제 부과 체계의 근사이며 공단 산정과 다를 수 있음.
//  - 소득: 근로·사업 등 부수입 100% + 공적연금 50%에 보험료율(7.19%)
//  - 재산: 주택·전월세를 과세표준으로 환산해 1억 공제 후 점수화 (금융자산은 부과 대상 아님)
//  - 장기요양: 건강보험료 × 13.14%
//  - 배우자가 직장가입자이고 소득·재산이 요건 이내면 피부양자(보험료 0)
function healthInsuranceYearly({ earnedIncome = 0, pensionIncome = 0, houseValue = 0, deposit = 0, monthlyRent = 0, spouseEmployed = false },
                               assumptions = ASSUMPTIONS) {
  const hi = assumptions.krPolicy.healthInsurance;
  const propertyBase = Math.max(0, houseValue) * hi.propertyAssessRatio
                     + (Math.max(0, deposit) + Math.max(0, monthlyRent) * hi.rentMonthsFactor) * hi.rentalAssessRatio;
  const incomeBase = Math.max(0, earnedIncome) + Math.max(0, pensionIncome) * hi.pensionIncomeRatio;
  if (spouseEmployed && incomeBase <= hi.dependentIncomeLimit && propertyBase <= hi.dependentPropertyLimit) return 0;
  const incomePremium = incomeBase * hi.rate;
  const points = hi.pointsPer1억 * Math.max(0, propertyBase - hi.propertyDeduction) / 10000;
  const propertyPremium = points * hi.pointValue * 12 / 10000;   // 원 → 만원
  return Math.min((incomePremium + propertyPremium) * (1 + hi.ltcRate), hi.annualCap);
}

// ============================================================
// 핵심 시뮬레이션 (v4 — 본인/배우자 분리, 명목→실질 변환)
// ============================================================

function calculateScenario(input, returnRateOverride, assumptions = ASSUMPTIONS, opts = {}) {
  const lite = !!opts.lite;  // 몬테카를로용 — 연도별 상세 row 생략, 고갈/준비율만 계산
  const policy = assumptions.krPolicy;

  // ── 명목 → 실질 변환 ──────────────────────────────────────
  const inflRate = input.inflationRate / 100;
  const toReal = (nomPct) => (1 + nomPct / 100) / (1 + inflRate) - 1;
  // returnRateOverride가 함수이면 연도별 실질수익률 함수; 숫자이면 고정
  const baseRateFn = typeof returnRateOverride === "function"
    ? returnRateOverride
    : () => toReal(returnRateOverride ?? input.investmentReturnRate);
  // An explicitly selected shock comparison applies the same preset to every
  // projection, including sampled MC returns. Ordinary/legacy inputs are unchanged.
  const mean = typeof returnRateOverride === "number" ? returnRateOverride : input.investmentReturnRate;
  const stressRateFn = buildStressRateFn(input.stressTest, mean, input.retireAge, inflRate);
  const rateFn = input.projectionStress === true && !opts.skipProjectionStress
    ? typeof returnRateOverride === "function"
      ? age => Math.max(-1, baseRateFn(age) + stressRateFn(age) - toReal(mean))
      : stressRateFn
    : baseRateFn;
  const sg = toReal(input.salaryGrowthRate);
  const hg = toReal(input.houseInflationRate);

  // ── 본인/배우자 국민연금 (조기 −6%·연기 +7.2%/년 계수 반영) ──
  const selfNpMonthly    = estimatedPensionMonthlyFor(input, "self",   assumptions)
    * pensionClaimFactor(input.selfPensionStartAge, autoPensionStartAge(input.currentAge));
  const spouseNpMonthly  = estimatedPensionMonthlyFor(input, "spouse", assumptions)
    * pensionClaimFactor(input.spousePensionStartAge ?? 65, autoPensionStartAge(input.spouseCurrentAge ?? input.currentAge));

  // ── 세전 연봉 (DC 적립·퇴직금은 세전 기준) ──
  const selfGrossAnnual0 = netToGrossAnnual(input.selfCurrentSalary);

  // ── 시뮬레이션 종료 나이 (self 기준) ──────────────────────
  const selfLE   = input.selfLifeExpectancy;
  const simEndAge = simEndAgeFor(input);

  // ── 초기 자산 (2-bucket: 저축성 / 투자성) ───────────────────
  let financialSavings     = input.savingsBalance;      // 저축성 (예금·MMF, 스트레스 미적용)
  let financialInvestments = input.investmentBalance;   // 투자성 (DC/IRP·주식·ETF, 스트레스 적용)

  // ── 주거 모드 초기화 (cascade로 변경 가능 — mutable 로컬 변수) ──
  let simHousingMode = input.housingMode ?? "own";
  const isOwn    = () => simHousingMode === "own";
  const isRent   = () => simHousingMode === "monthly_rent";
  const isJeonse = () => simHousingMode === "jeonse";

  let house    = isOwn() ? input.housePrice : 0;
  // 주택대출: 금리·원리금은 명목 기준(월 원리금 고정 → 물가가 오르면 실질 부담은 줄어듦). 명목 잔액을 추적하고 실질로 환산해 보고
  let mortgageNom = isOwn() && input.hasMortgage ? input.mortgageBalance : 0;
  let mortgage    = mortgageNom;   // 실질 잔액 (연말 기준)

  // 주거비 (현재가치 기준 real)
  let curMaintenance = input.housingMaintenance ?? 0;   // 만/월
  let curMonthlyRent = input.monthlyRent ?? 0;          // 만/월
  let curDeposit     = input.deposit ?? 0;              // 만원 (보증금)

  // 주거비 인플레이션 파라미터
  const hInfl    = assumptions.housingInflation;
  const hScen    = hInfl.scenarios[input.housingInflationScenario ?? hInfl.defaultScenario] ?? hInfl.scenarios.realistic;
  const hRentReal  = (1 + hScen.rentAnnual)  / (1 + inflRate) - 1;
  const hMaintReal = (1 + hScen.maintAnnual) / (1 + inflRate) - 1;
  const jeonseBumpMid  = (hScen.jeonseBumpRange[0] + hScen.jeonseBumpRange[1]) / 2;
  const jeonseShockMid = hScen.jeonseShockRange ? (hScen.jeonseShockRange[0] + hScen.jeonseShockRange[1]) / 2 : 0;
  // real 2-year equivalent bump
  const jeonseBumpReal  = (1 + jeonseBumpMid)  / Math.pow(1 + inflRate, hInfl.jeonseRenewalYears) - 1;
  const jeonseShockReal = (1 + jeonseShockMid) / (1 + inflRate) - 1;
  let jeonseYearsSinceRenewal = 0;
  let yearsSinceShock = 0;

  let depletionAge = null;
  let bridgeShortfall = 0;
  let totalAssetsAtRetirement = 0;
  let severancePaid = !input.includeSeveranceLumpSum;
  let downsizeDone = false;
  const downsizeEvents = [];
  const years = [];

  // C5: 인출 전략 — 4% SWR 기준값은 퇴직 시점에 확정
  const strategy = input.withdrawalStrategy === "unified" ? "bucket" : (input.withdrawalStrategy ?? "bucket");
  let swrAnnual = 0;   // 4pct 전략용 고정 인출액 (퇴직 시 확정)

  // 유족연금 추적
  let selfSurvivorNpBonus   = 0;  // 배우자 사망 시 본인이 받을 추가 NP
  let spouseSurvivorNpBonus = 0;  // 본인 사망 시 배우자가 받을 추가 NP (계산만)
  let prevSelfAlive  = true;
  let prevSpouseAlive = input.spouseEnabled;

  for (let age = input.currentAge; age <= simEndAge; age++) {
    const t = age - input.currentAge;
    const year = CURRENT_YEAR + t;

    // ── 생존 여부 ──
    const selfAlive   = age <= selfLE;
    const spouseAge   = (input.spouseCurrentAge ?? input.currentAge) + t;
    const spouseAlive = input.spouseEnabled && spouseAge <= input.spouseLifeExpectancy;

    // 유족연금: 배우자가 이번 해에 사망했을 때
    if (prevSpouseAlive && !spouseAlive && selfAlive) {
      selfSurvivorNpBonus = spouseNpMonthly * policy.survivorPensionRatio;
    }
    // 본인이 이번 해에 사망했을 때 (배우자가 받을 몫)
    if (prevSelfAlive && !selfAlive && spouseAlive) {
      spouseSurvivorNpBonus = selfNpMonthly * policy.survivorPensionRatio;
    }
    prevSelfAlive  = selfAlive;
    prevSpouseAlive = spouseAlive;

    // ── 근로 소득 ──
    const selfIsWorking   = selfAlive && age < input.retireAge;
    const spouseIsWorking = spouseAlive && spouseAge < (input.spouseRetireAge ?? 75);

    const selfSalaryAnnual   = selfIsWorking   ? input.selfCurrentSalary   * Math.pow(1 + sg, t) : 0;
    const spouseSalaryAnnual = spouseIsWorking ? (input.spouseCurrentSalary ?? 0) * Math.pow(1 + sg, t) : 0;

    // ── DC 적립 (본인 근로기만, 세전 연봉 기준) ──
    const dcContribAnnual = selfIsWorking
      ? (selfGrossAnnual0 * Math.pow(1 + sg, t)) / assumptions.assetRules.dcAnnualContributionSalaryDivisor : 0;

    // ── 국민연금 — 노령연금에 연금소득세, 유족연금은 택일(본인+유족30% vs 유족100%)·비과세·개시나이 무관 ──
    const selfIsPension   = selfAlive   && age       >= input.selfPensionStartAge;
    const spouseIsPension = spouseAlive && spouseAge >= (input.spousePensionStartAge ?? 65);

    const npTaxKeep = 1 - policy.pensionTaxRate;
    const npPayout = (alive, ownEligible, ownMonthly, survivorMonthly) => {
      if (!alive) return 0;
      const own = ownEligible ? ownMonthly * npTaxKeep : 0;
      if (survivorMonthly > 0) return Math.max(own + survivorMonthly * policy.survivorOverlapRatio, survivorMonthly) * 12;
      return own * 12;
    };
    let selfPensionAnnual   = npPayout(selfAlive,   selfIsPension,   selfNpMonthly,   selfSurvivorNpBonus);
    let spousePensionAnnual = npPayout(spouseAlive, spouseIsPension, spouseNpMonthly, spouseSurvivorNpBonus);

    // ── 브릿지 소득 (본인 퇴직 후, 연금 개시 전) ──
    const selfIsRetired = selfAlive && !selfIsWorking;
    const selfIsBridge  = selfIsRetired && !selfIsPension;
    const bridgeSideAnnual = selfIsBridge ? input.postRetireSideIncome * 12 : 0;

    // ── 생활비 ──
    const isAnyoneAlive = selfAlive || spouseAlive;
    const baseLivingMonthly = selfIsWorking
      ? input.workingLivingCost
      : selfIsBridge
        ? input.bridgeLivingCost
        : input.retirementLivingCost;
    // 본인 사망 후에도 배우자 생존 시 생활비는 0.7배로 단순화
    const livingScale = (!selfAlive && spouseAlive) ? 0.7 : 1.0;
    const livingAnnual = isAnyoneAlive
      ? baseLivingMonthly * 12 * ageFactor(age, assumptions) * livingScale : 0;

    const childAnnual = isAnyoneAlive ? childCostYearly(input, year, assumptions) : 0;

    // ── 대출 상환 (자가 모드만) — 명목 금리로 이자 부과 후 명목 고정 원리금 상환, 실질로 환산 ──
    if (isOwn() && input.hasMortgage && mortgageNom > 0) mortgageNom *= (1 + (input.mortgageRate ?? 4) / 100);
    const mortgagePaidNom = (isOwn() && input.hasMortgage)
      ? Math.min(mortgageNom, input.monthlyMortgagePayment * 12) : 0;
    mortgageNom = Math.max(0, mortgageNom - mortgagePaidNom);
    const mortgagePaid = mortgagePaidNom / Math.pow(1 + inflRate, t);        // 해당 연도 실질 상환액
    mortgage = mortgageNom / Math.pow(1 + inflRate, t + 1);                  // 연말 실질 잔액 (house와 동일 시점)

    // ── 추가저축 (본인 근로기만) ──
    const extraSavingAnnual = selfIsWorking ? input.monthlyAddSaving * 12 : 0;

    // ── 주거비 인플레이션 동학 ──
    const elderlyBonus = (age >= hInfl.elderlyAge) ? hInfl.elderlyExtraRate : 0;

    // 관리비: 모든 모드, 실질 성장
    curMaintenance *= (1 + hMaintReal + elderlyBonus);

    // 월세: 실질 성장
    if (isRent()) {
      curMonthlyRent *= (1 + hRentReal + elderlyBonus);
    }

    // 전세: 2년 주기 보증금 점프 + 충격
    let jeonseTopUpAnnual = 0;
    if (isJeonse()) {
      jeonseYearsSinceRenewal++;
      if (jeonseYearsSinceRenewal >= hInfl.jeonseRenewalYears) {
        const bump = curDeposit * (jeonseBumpReal + elderlyBonus * hInfl.jeonseRenewalYears);
        curDeposit += bump;
        jeonseTopUpAnnual += bump;
        jeonseYearsSinceRenewal = 0;
      }
      yearsSinceShock++;
      if (hScen.jeonseShockYears && yearsSinceShock >= hScen.jeonseShockYears) {
        const shock = curDeposit * jeonseShockReal;
        curDeposit += shock;
        jeonseTopUpAnnual += shock;
        yearsSinceShock = 0;
      }
    }

    // ── 건강보험료 (퇴직 후, 지역가입자 추정) ──
    // 본인이 은퇴했거나, 본인 사망 후 배우자가 은퇴 상태면 세대 보험료 부과. 배우자가 근로 중이면 피부양자 요건 검토
    const selfOwnNpAnnual   = selfIsPension   ? selfNpMonthly   * 12 : 0;
    const spouseOwnNpAnnual = spouseIsPension ? spouseNpMonthly * 12 : 0;
    let healthInsAnnual = 0;
    if (input.applyHealthInsurance) {
      const housing = { houseValue: house, deposit: curDeposit, monthlyRent: isRent() ? curMonthlyRent : 0 };
      if (selfIsRetired) {
        healthInsAnnual = healthInsuranceYearly({
          ...housing,
          earnedIncome: bridgeSideAnnual,
          pensionIncome: selfOwnNpAnnual + (spouseIsWorking ? 0 : spouseOwnNpAnnual),
          spouseEmployed: spouseIsWorking,
        }, assumptions);
      } else if (!selfAlive && spouseAlive && !spouseIsWorking) {
        healthInsAnnual = healthInsuranceYearly({ ...housing, pensionIncome: spouseOwnNpAnnual }, assumptions);
      }
    }

    // ── 노년기 의료비 ──
    const selfMedical   = selfAlive   ? medicalCostMonthly(age,      t, assumptions) * 12 : 0;
    const spouseMedical = spouseAlive ? medicalCostMonthly(spouseAge, t, assumptions) * 12 : 0;
    const medicalAnnual = (input.applyMedicalCost !== false)
      ? (selfMedical + spouseMedical) * (input.medicalCostMultiplier ?? 1.0) : 0;

    // ── 퇴직금 일시금 (퇴직 시점 세전 월급 기준) ──
    if (!severancePaid && age === input.retireAge && selfAlive) {
      const yearsWorked = Math.max(0, input.retireAge - policy.contributionStartAge);
      const grossSeverance = (selfGrossAnnual0 * Math.pow(1 + sg, t) / 12) * yearsWorked;
      // 퇴직소득세 단순 적용 (근속연수공제 후 6.6% 단순 가정)
      const severanceTax = grossSeverance * 0.066;
      financialSavings += grossSeverance - severanceTax;
      severancePaid = true;
    }

    // ── 수동 다운사이징 (자가 모드만) ──
    if (!downsizeDone && isOwn() && input.downsizeEnabled && age === input.downsizeAge) {
      const liquidated = house * (1 - input.downsizeRatio);
      financialSavings += liquidated;
      house = house * input.downsizeRatio;
      downsizeDone = true;
      downsizeEvents.push({ age, label: "주택 다운사이징", liquidated });
    }

    // 퇴직 시점 금융자산 = 퇴직 해 현금흐름·수익 반영 이전 잔액 (퇴직금 일시금·다운사이징 반영 후)
    if (age === input.retireAge) totalAssetsAtRetirement = financialSavings + financialInvestments;

    // ── 주거비 집계 ──
    const maintAnnual = isAnyoneAlive ? curMaintenance * 12 : 0;
    const rentAnnual  = (isAnyoneAlive && isRent()) ? curMonthlyRent * 12 : 0;

    // ── 기초연금 (65세+, 소득인정액 하위 단순 추정) ──
    let basicPensionAnnual = 0;
    if (input.applyBasicPension !== false) {
      const bp = policy.basicPension;
      const bothAlive = selfAlive && spouseAlive;
      // 재산의 소득환산 = [(일반재산 − 기본재산액) + (금융재산 − 금융공제) − 부채] × 4% ÷ 12
      const generalAsset = house + curDeposit;
      const financialAsset = financialSavings + financialInvestments;
      const assetRecog = Math.max(0, (generalAsset - bp.assetBasicDeduction) + (financialAsset - bp.financialDeduction) - mortgage)
        * bp.assetConversionRate / 12;
      const workRecog  = (Math.max(0, (selfSalaryAnnual + bridgeSideAnnual) / 12 - bp.workIncomeDeduction)
                        + Math.max(0, spouseSalaryAnnual / 12 - bp.workIncomeDeduction)) * bp.workIncomeRate;
      const recognized = assetRecog + workRecog + (selfPensionAnnual + spousePensionAnnual) / 12;
      if (recognized <= (bothAlive ? bp.incomeThresholdCouple : bp.incomeThresholdSingle)) {
        const per = bp.monthlyFull * (bothAlive ? 1 - bp.coupleReductionRate : 1);
        // 국민연금 연계 감액 단순화: NP가 기준연금액 1.5배 초과 시 절반
        const selfBp   = (selfAlive   && age       >= 65) ? per * (selfNpMonthly   > bp.monthlyFull * 1.5 ? 0.5 : 1) : 0;
        const spouseBp = (spouseAlive && spouseAge >= 65) ? per * (spouseNpMonthly > bp.monthlyFull * 1.5 ? 0.5 : 1) : 0;
        basicPensionAnnual = (selfBp + spouseBp) * 12;
      }
    }

    // ── 현금흐름 집계 ──
    const income = selfSalaryAnnual + spouseSalaryAnnual + selfPensionAnnual + spousePensionAnnual
                 + bridgeSideAnnual + basicPensionAnnual;
    const outflow = livingAnnual + childAnnual + mortgagePaid + healthInsAnnual + medicalAnnual
                  + maintAnnual + rentAnnual + jeonseTopUpAnnual;
    const cashflowExclSaving = income - outflow;
    const cashflowWithSaving = cashflowExclSaving - extraSavingAnnual;

    // ── 자산 운용 (C5: 인출 전략 분기, 2-bucket) ──
    const rInv = rateFn(age);                          // 투자성 — 스트레스 적용
    const rSav = toReal(input.savingsReturnRate);      // 저축성 — 스트레스 미적용, 고정

    // 먼저 모든 버킷에 수익률 적용
    financialInvestments = financialInvestments * (1 + rInv) + dcContribAnnual;
    financialSavings     = financialSavings     * (1 + rSav);
    house = isOwn() ? house * (1 + hg) : 0;

    // 퇴직 시점 4pct SWR 기준값 확정
    if (strategy === "4pct" && age === input.retireAge) {
      swrAnnual = (financialSavings + financialInvestments) * 0.04;
    }

    // 2-bucket 인출 헬퍼: 저축성 → 투자성 순으로 deficit 충당
    function withdrawFromBuckets(deficit) {
      const fromSav = Math.min(Math.max(0, financialSavings), deficit);
      financialSavings -= fromSav;
      const rem = deficit - fromSav;
      if (rem > 0) {
        const fromInv = Math.min(Math.max(0, financialInvestments), rem);
        financialInvestments -= fromInv;
        const leftover = rem - fromInv;
        if (leftover > 0) financialSavings -= leftover; // 음수로 소진 감지
      }
    }

    // 목표 인출액 중 지출 초과분을 버킷에서 꺼내 저축성에 보관 (소멸 방지 — 투자성→현금화 효과)
    function cashOutExcess(targetWithdrawal, spent) {
      const excess = Math.max(0, targetWithdrawal - spent);
      const available = Math.max(0, financialSavings) + Math.max(0, financialInvestments);
      const move = Math.min(excess, available);
      if (move > 0) { withdrawFromBuckets(move); financialSavings += move; }
    }

    // 전략별 현금흐름 적용
    // 근로기(퇴직 전)와 버킷 전략: 총 현금흐름(cashflowExclSaving) 전액이 금융자산에 반영된다.
    // 추가저축(월 투자 적립)은 그 잉여 중 투자성 자산으로 보내는 몫일 뿐 자산 총액을 늘리지 않는다 (이중 계산 방지).
    const settleCashflow = (net) => { if (net >= 0) financialSavings += net; else withdrawFromBuckets(-net); };
    const retired = age >= input.retireAge;

    if (!retired || strategy === "bucket" || (strategy !== "4pct" && strategy !== "vpw")) {
      // Bucket: 잉여 → 저축성, 부족 → 저축성 → 투자성 순 인출
      financialInvestments += extraSavingAnnual;
      settleCashflow(cashflowExclSaving - extraSavingAnnual);

    } else if (strategy === "4pct") {
      // 4% 룰: 퇴직 후 매년 swrAnnual 인출 — 지출 초과분은 저축성 버킷에 보관
      const netNeed = Math.max(0, outflow - income);
      withdrawFromBuckets(netNeed);
      cashOutExcess(swrAnnual, netNeed);
      financialSavings += Math.max(0, income - outflow);

    } else {
      // VPW: 잔여 기대연수 기반 비율 인출 — 지출 초과분은 저축성 버킷에 보관
      const remaining = Math.max(1, simEndAge - age);
      const vpwRate = rInv > 0.0001
        ? rInv / (1 - Math.pow(1 + rInv, -remaining))
        : 1 / remaining;
      const totalFinancial = Math.max(0, financialSavings) + Math.max(0, financialInvestments);
      const actualNeed = Math.max(0, outflow - income);
      withdrawFromBuckets(actualNeed);
      cashOutExcess(Math.min(vpwRate * totalFinancial, totalFinancial), actualNeed);
      financialSavings += Math.max(0, income - outflow);
    }

    const financialTotal = financialSavings + financialInvestments;

    // ── 자동 주거 다운그레이드 cascade (퇴직 후, 금융자산 임계값 미만) ──
    const THRESHOLD = assumptions.assetRules.housingLiquidationThreshold;
    if (age >= input.retireAge) {
      // Step 1: 자가 → 전세
      if (isOwn() && house > 0 && financialTotal < THRESHOLD) {
        const houseAfterMortgage = Math.max(0, house - mortgage);
        const newDeposit = houseAfterMortgage * 0.7;
        const cashOut    = houseAfterMortgage * 0.3;
        curDeposit = newDeposit;
        financialSavings += cashOut;
        house = 0; mortgage = 0; mortgageNom = 0;
        simHousingMode = "jeonse";
        jeonseYearsSinceRenewal = 0; yearsSinceShock = 0;
        downsizeEvents.push({ age, label: "자가→전세 전환 (자동)", liquidated: cashOut, deposit: newDeposit });
      }
      // Step 2: 전세 → 월세
      const financialTotalPostCascade1 = financialSavings + financialInvestments;
      if (isJeonse() && curDeposit > 0 && financialTotalPostCascade1 < THRESHOLD) {
        const fallbackDeposit = assumptions.assetRules.fallbackDepositOnRent;
        const remainDeposit = Math.min(curDeposit, fallbackDeposit);
        const recovered = curDeposit - remainDeposit;
        curDeposit = remainDeposit;
        financialSavings += recovered;
        simHousingMode = "monthly_rent";
        if (!curMonthlyRent || curMonthlyRent <= 0) {
          curMonthlyRent = assumptions.assetRules.fallbackMonthlyRent;
        }
        downsizeEvents.push({ age, label: "전세→월세 전환 (자동)", liquidated: recovered, depositRemaining: remainDeposit });
      }
    }

    const financialTotalFinal = financialSavings + financialInvestments;
    const netWorth = financialTotalFinal + house - mortgage + curDeposit;

    if (selfIsBridge && cashflowExclSaving < 0) bridgeShortfall += -cashflowExclSaving;

    if (lite) { years.push({ age, financialAssets: Math.round(financialTotalFinal) }); continue; }

    years.push({
      age, year,
      phase: selfIsWorking ? "work" : selfIsBridge ? "bridge" : "pension",
      selfAlive, spouseAlive,
      financialSavings: Math.round(financialSavings),
      financialInvestments: Math.round(financialInvestments),
      financialAssets: Math.round(financialTotalFinal),
      houseValue: Math.round(house),
      mortgage: Math.round(mortgage),
      deposit: Math.round(curDeposit),
      housingMode: simHousingMode,
      netWorth: Math.round(netWorth),
      maintMonthly:  Math.round(curMaintenance),
      rentMonthly:   Math.round(isRent() ? curMonthlyRent : 0),
      selfSalaryMonthly:    Math.round(selfSalaryAnnual   / 12),
      spouseSalaryMonthly:  Math.round(spouseSalaryAnnual / 12),
      selfPensionMonthly:   Math.round(selfPensionAnnual  / 12),
      spousePensionMonthly: Math.round(spousePensionAnnual / 12),
      basicPensionMonthly:  Math.round(basicPensionAnnual  / 12),
      bridgeSideMonthly:    Math.round(bridgeSideAnnual   / 12),
      livingMonthly:        Math.round(livingAnnual       / 12),
      childMonthly:         Math.round(childAnnual        / 12),
      mortgageMonthly:      Math.round(mortgagePaid       / 12),
      healthInsMonthly:     Math.round(healthInsAnnual    / 12),
      medicalMonthly:       Math.round(medicalAnnual      / 12),
      maintMonthlyOut:      Math.round(maintAnnual        / 12),
      rentMonthlyOut:       Math.round((rentAnnual + jeonseTopUpAnnual) / 12),
      extraSavingMonthly:   Math.round(extraSavingAnnual / 12),
      cashflowMonthly:      Math.round(cashflowWithSaving / 12),
    });
  }

  // 자산 고갈 나이: 끝까지 회복하지 못한 음수 구간의 시작 (퇴직 전 파산 포함)
  for (let k = years.length - 1; k >= 0; k--) {
    if (years[k].financialAssets > 0) break;
    depletionAge = years[k].age;
  }

  const bridgeYears = Math.max(0, input.selfPensionStartAge - input.retireAge);

  let readinessRatio;
  if (depletionAge === null) {
    const last = years[years.length - 1];
    const margin = Math.max(0, last.financialAssets);
    readinessRatio = Math.min(assumptions.assetRules.readinessMaxRatio,
      100 + (totalAssetsAtRetirement > 0 ? (margin / totalAssetsAtRetirement) * 100 : 0));
  } else {
    const survived = Math.max(0, depletionAge - input.retireAge);
    const need = simEndAge - input.retireAge;  // 부부 최대 수명 기준
    readinessRatio = need > 0 ? (survived / need) * 100 : 0;
  }

  const lastYear = years[years.length - 1] || {};

  return {
    yearlyAssetFlow: years,
    assetBucketsAtEnd: {
      savings:        lastYear.financialSavings     ?? 0,
      investments:    lastYear.financialInvestments ?? 0,
      totalFinancial: lastYear.financialAssets      ?? 0,
    },
    bridgeYears,
    bridgeShortfall:        Math.round(bridgeShortfall),
    totalAssetsAtRetirement: Math.round(totalAssetsAtRetirement),
    selfNpMonthly:    Math.round(selfNpMonthly),
    spouseNpMonthly:  Math.round(spouseNpMonthly),
    readinessRatio: Math.round(readinessRatio),
    depletionAge,
    simEndAge,
    childEventList: lite ? [] : childEvents(input),
    downsizeEvents,
    assumptionVersion: assumptions.version,
  };
}


export { ageFactor, childCostAt, childrenOf, childCostYearly, childEvents, medicalCostMonthly, healthInsuranceYearly, calculateScenario };
