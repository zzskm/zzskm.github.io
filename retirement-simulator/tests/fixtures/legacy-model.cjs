// Unmodified pre-refactor calculation and migration oracle; upstream blob 8fff3945.
const ASSUMPTIONS = {
  version: "kr-v6-2026-10",
  krPolicy: {
    pensionReplacementRate: 0.43,       // 2026.1 연금개혁: 40년 가입 소득대체율 43% (현 가입자 전 기간 적용 가정)
    pensionAValueMonthly: 319,          // 만원/월 — 2026년 A값 3,193,511원
    npMaxBaseMonthly: 659,              // 만원/월 — 기준소득월액 상한 (B값 캡, 2026.7~2027.6)
    npMinBaseMonthly: 41,               // 만원/월 — 기준소득월액 하한 (2026.7~2027.6)
    pensionTaxRate: 0.055,              // 연금소득세 — 노령연금에 적용 (유족·기초연금 비과세). 실효세율보다 높은 보수적 가정
    maxNpYears: 40,                     // 국민연금 최대 가입연수
    contributionStartAge: 25,           // 자동 가입연수/퇴직급여 계산 기준 나이
    survivorPensionRatio: 0.50,         // 유족연금 단순 가정: 사망자 NP의 50%
    survivorOverlapRatio: 0.30,         // 본인 노령연금 선택 시 유족연금 중복 지급률
    basicPension: {                     // 기초연금 단순 모델 (2026 기준)
      monthlyFull: 34.97,               // 만원/월 — 기준연금액 (349,700원)
      coupleReductionRate: 0.20,        // 부부 각 20% 감액
      incomeThresholdSingle: 247,       // 만/월 — 소득인정액 선정기준 (단독)
      incomeThresholdCouple: 395.2,     // 만/월 — 소득인정액 선정기준 (부부)
      assetBasicDeduction: 13500,       // 만원 — 일반재산 기본재산액 (대도시)
      financialDeduction: 2000,         // 만원 — 금융재산 공제
      assetConversionRate: 0.04,        // 재산 → 연소득 환산율
      workIncomeDeduction: 116,         // 만/월 — 근로소득 공제 (1인당)
      workIncomeRate: 0.7,              // 공제 후 반영률
    },
    // 지역가입자 건강보험료 추정 (실제 부과 체계의 단순 근사 — 공식 점수표 아님)
    healthInsurance: {
      rate: 0.0719,                     // 2026 건강보험료율
      ltcRate: 0.1314,                  // 장기요양보험료 = 건강보험료 × 13.14%
      pensionIncomeRatio: 0.5,          // 공적연금 소득은 50%만 반영
      pointValue: 211.5,                // 재산 점수당 금액 (원, 2026)
      propertyAssessRatio: 0.41,        // 주택 시세 → 재산세 과세표준 (공시가 현실화율 ~69% × 공정시장가액비율 60%)
      rentalAssessRatio: 0.3,           // 전월세 평가액 = (보증금 + 월세×40) × 0.3
      rentMonthsFactor: 40,
      propertyDeduction: 10000,         // 만원 — 재산 기본공제 1억
      pointsPer1억: 148,                // 공제 후 과표 1억당 재산 점수 (구간표 근사)
      dependentIncomeLimit: 2000,       // 만원/년 — 피부양자 소득 요건
      dependentPropertyLimit: 54000,    // 만원 — 피부양자 재산 과표 요건 (5.4억)
      annualCap: 5000,                  // 만원/년
    },
  },
  lifeCycle: {
    spendingFactors: [
      { fromAge: 0, factor: 1.0 },
      { fromAge: 65, factor: 0.75 },
      { fromAge: 75, factor: 0.55 },
    ],
    childMonthlyCosts: [
      { minAge: 0, maxAge: 6, amount: 50 },    // 만원/월
      { minAge: 7, maxAge: 18, amount: 80 },
      { minAge: 19, maxAge: 22, amount: 150 },
    ],
    // 노년기 의료비 (1인 기준, 만원/월 현재가치)
    medicalMonthlyByAge: [
      { fromAge:  0, amount:  0 },
      { fromAge: 50, amount: 15 },   // 50대 만성질환 시작
      { fromAge: 65, amount: 30 },   // 노인 외래·약제비
      { fromAge: 75, amount: 60 },   // 입원·시술 빈도 증가
      { fromAge: 85, amount: 100 },  // 장기요양·간병
    ],
    medicalInflationRealPremium: 1.5, // %/년 — 의료물가가 일반물가보다 초과 상승
  },
  assetRules: {
    dcAnnualContributionSalaryDivisor: 12,
    readinessMaxRatio: 300,
    includeSeveranceLumpSumDefault: false,
    housingLiquidationThreshold: 600,   // 만원 — 이 이하로 떨어지면 자동 cascade
    fallbackMonthlyRent: 80,            // 만/월 — jeonse→monthly_rent 전환 시 기본 시세
    fallbackDepositOnRent: 5000,        // 만원 — 월세 전환 후 유지할 잔존 보증금
  },
  // 주거비 인플레이션 동학 (CPI와 분리, 주거 모드별 독립 적용)
  housingInflation: {
    scenarios: {
      stable:   { rentAnnual: 0.035, jeonseBumpRange: [0.05, 0.08], jeonseShockYears: null, jeonseShockRange: null, maintAnnual: 0.04 },
      realistic:{ rentAnnual: 0.04,  jeonseBumpRange: [0.07, 0.10], jeonseShockYears: 10,   jeonseShockRange: [0.20, 0.30], maintAnnual: 0.045 },
      stress:   { rentAnnual: 0.06,  jeonseBumpRange: [0.10, 0.14], jeonseShockYears: 8,    jeonseShockRange: [0.25, 0.35], maintAnnual: 0.06 },
    },
    defaultScenario: "realistic",
    jeonseRenewalYears: 2,
    elderlyAge: 75,
    elderlyExtraRate: 0.015,  // 75세+ 주거비 가중 +1.5%p/년
  },
  // 2026 한국 근로소득세 + 4대보험 모델 (세전↔세후 변환용 — 본인 1인 기준, 부양가족·연말정산 공제 미반영)
  taxModel: {
    // 종합소득세 누진 구간 (만원/년 기준 과세표준)
    incomeBrackets: [
      { upTo:   1400, rate: 0.06 },
      { upTo:   5000, rate: 0.15 },
      { upTo:   8800, rate: 0.24 },
      { upTo:  15000, rate: 0.35 },
      { upTo:  30000, rate: 0.38 },
      { upTo:  50000, rate: 0.40 },
      { upTo: 100000, rate: 0.42 },
      { upTo: Infinity, rate: 0.45 },
    ],
    // 근로소득공제 구간표 (총급여 만원/년): 공제액 = base + (총급여 − 이전 구간 상한) × rate, 한도 2,000만
    earnedIncomeDeduction: [
      { upTo:   500, rate: 0.70, base:    0 },
      { upTo:  1500, rate: 0.40, base:  350 },
      { upTo:  4500, rate: 0.15, base:  750 },
      { upTo: 10000, rate: 0.05, base: 1200 },
      { upTo: Infinity, rate: 0.02, base: 1475 },
    ],
    earnedIncomeDeductionCap: 2000,
    personalDeduction: 150,           // 본인 기본공제 (만원)
    standardTaxCredit: 13,            // 근로자 표준세액공제 (만원)
    localTaxRate: 0.10,               // 지방소득세 (소득세의 10%)
    // 근로자 부담 4대보험 (2026): 국민연금 4.75%(상한 적용) + 건강보험 3.595% + 장기요양(건보료×13.14%) + 고용 0.9%
    socialInsurance: { np: 0.0475, hi: 0.03595, ltcOfHi: 0.1314, ei: 0.009 },
  },
  monteCarlo: {
    runs: 1000,                       // 시뮬레이션 횟수 (고정 시드 — 재현 가능. 1,000회 ≈ 0.1초)
    defaultVolatility: 12,            // 연 수익률 표준편차 (명목 %p, 혼합 포트폴리오 가정)
  },
};

// ============================================================
// 세전↔세후 변환 유틸 (입력 UI 레이어 전용 — 시뮬 코어는 net annual 사용)
// ============================================================

// 근로자 부담 4대보험 (만원/년). 국민연금은 기준소득월액 상·하한 적용
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

// unit: 입력칸 옆 단위 표시 / typedMax: 슬라이더 범위(max)를 넘는 값도 직접 입력할 수 있는 상한
const UI_RANGES = {
  currentAge:               { min: 25, max: 70, step: 1, unit: "세" },
  retireAge:                { min: 25, max: 75, step: 1, unit: "세" },
  selfPensionStartAge:      { min: 55, max: 75, step: 1, unit: "세" },
  spousePensionStartAge:    { min: 55, max: 75, step: 1, unit: "세" },
  selfLifeExpectancy:       { min: 70, max: 105, step: 1, unit: "세" },
  spouseLifeExpectancy:     { min: 70, max: 105, step: 1, unit: "세" },
  spouseCurrentAge:         { min: 20, max: 80, step: 1, unit: "세" },
  spouseRetireAge:          { min: 40, max: 75, step: 1, unit: "세" },
  selfNpYears:              { min: 0, max: 40, step: 1, unit: "년" },
  spouseNpYears:            { min: 0, max: 40, step: 1, unit: "년" },
  selfNpManualMonthly:      { min: 0, max: 300, step: 1, unit: "만/월" },
  spouseNpManualMonthly:    { min: 0, max: 300, step: 1, unit: "만/월" },
  selfCurrentSalary:        { min: 0, max: 30000, step: 100, unit: "만원" },
  spouseCurrentSalary:      { min: 0, max: 30000, step: 100, unit: "만원" },
  salaryGrowthRate:         { min: 0, max: 8, step: 0.1, unit: "%" },   // 명목 %
  postRetireSideIncome:     { min: 0, max: 500, step: 10, unit: "만/월", typedMax: 2000 },
  investmentBalance:        { min: 0, max: 50000, step: 500, unit: "만원", typedMax: 1000000 },
  savingsBalance:           { min: 0, max: 50000, step: 500, unit: "만원", typedMax: 1000000 },
  monthlyAddSaving:         { min: 0, max: 300, step: 10, unit: "만/월", typedMax: 2000 },
  savingsReturnRate:        { min: 0, max: 8, step: 0.1, unit: "%" },  // 명목 %
  housePrice:               { min: 0, max: 300000, step: 1000, unit: "만원", typedMax: 2000000 },
  houseInflationRate:       { min: 0, max: 10, step: 0.1, unit: "%" },  // 명목 %
  mortgageBalance:          { min: 0, max: 100000, step: 500, unit: "만원", typedMax: 1000000 },
  monthlyMortgagePayment:   { min: 0, max: 500, step: 10, unit: "만/월", typedMax: 3000 },
  mortgageRate:             { min: 0, max: 10, step: 0.1, unit: "%" },  // 명목 %
  housingMaintenance:       { min: 0, max: 100, step: 1, unit: "만/월", typedMax: 500 },   // 만/월
  monthlyRent:              { min: 0, max: 300, step: 5, unit: "만/월", typedMax: 1000 },   // 만/월
  deposit:                  { min: 0, max: 200000, step: 1000, unit: "만원", typedMax: 2000000 }, // 만원
  investmentReturnRate:     { min: 0, max: 12, step: 0.1, unit: "%" },  // 명목 %
  inflationRate:            { min: 0, max: 8, step: 0.1, unit: "%" },
  scenarioBandSpread:       { min: 0, max: 4, step: 0.1, unit: "%p" },
  returnVolatility:         { min: 0, max: 30, step: 0.5, unit: "%p" },  // 명목 %p — 몬테카를로 표준편차
  workingLivingCost:        { min: 50, max: 800, step: 10, unit: "만/월", typedMax: 3000 },
  bridgeLivingCost:         { min: 50, max: 800, step: 10, unit: "만/월", typedMax: 3000 },
  retirementLivingCost:     { min: 50, max: 600, step: 10, unit: "만/월", typedMax: 3000 },
  childCostMultiplier:      { min: 0.5, max: 2.0, step: 0.1, unit: "×" },
  downsizeAge:              { min: 40, max: 105, step: 1, unit: "세" },
  downsizeRatio:            { min: 0, max: 1, step: 0.05, unit: "" },
  medicalCostMultiplier:    { min: 0.5, max: 3.0, step: 0.1, unit: "×" },
};

const PRESETS = {
  krDefault: {
    // 프로필 (본인) — 40대 평균 직장인 기준
    currentAge: 40,
    retireAge: 60,
    selfLifeExpectancy: 90,        // 계획 수명 — 통계청 2024 40세 기대여명(남 41.9·여 47.4년 ≈ 82·87세)은 평균이라 절반은 더 오래 삼 → 보수적으로 90세
    selfPensionStartAge: 65,       // 1969년 이후 출생
    selfNpAutoMode: true,
    selfNpYears: 0,                // autoMode=true 시 자동 계산
    selfNpInputMode: "auto",       // "auto" | "manual"
    selfNpManualMonthly: 0,        // 만원/월 (manual 모드)
    selfCurrentSalary: Math.round(grossToNetAnnual(5300)), // 만원/년 (항상 net annual) — 세전 5,300만 (국세청 2023 귀속 40대 근로자 평균 5,265만)
    selfSalaryBasis: "gross",      // "gross" | "net" (입력 UI 표시 모드)
    // 배우자 — 40대 기혼율 ~70%, 맞벌이 가정
    spouseEnabled: true,
    spouseCurrentAge: 38,
    spouseRetireAge: 58,
    spouseLifeExpectancy: 90,      // 계획 수명 (본인과 동일 기준)
    spousePensionStartAge: 65,
    spouseNpAutoMode: true,
    spouseNpYears: 0,
    spouseNpInputMode: "auto",
    spouseNpManualMonthly: 0,
    spouseCurrentSalary: Math.round(grossToNetAnnual(4000)), // 만원/년 (항상 net annual) — 세전 4,000만 (맞벌이 가구소득 ≈ 40대 가구 평균 9,333만, 가계금융복지조사 2025)
    spouseSalaryBasis: "gross",    // "gross" | "net" (입력 UI 표시 모드)
    // 퇴직 후 소득
    postRetireSideIncome: 0,       // 만원/월 (브릿지기간 본인)
    // 자산 (저축성: 예금·MMF 등 / 투자성: DC/IRP·주식·ETF 등) — 40대 평균 금융자산 ~8천만
    investmentBalance: 5000,
    savingsBalance: 3000,
    savingsReturnRate: 3.0,          // 명목 % — 저축성 수익률 (스트레스 미적용)
    monthlyAddSaving: 40,
    // 주거 (housingMode: "own" | "monthly_rent" | "jeonse") — 자가율 ~60%, 수도권 가중
    housingMode: "own",
    housingMaintenance: 25,          // 만/월 관리비 (모든 모드 공통)
    housingInflationScenario: "realistic",
    // 자가 모드 전용
    housePrice: 55000,
    houseInflationRate: 3.0,         // 명목 %
    hasMortgage: true,
    mortgageBalance: 18000,
    monthlyMortgagePayment: 140,
    mortgageRate: 4.0,               // 명목 % — 주택대출 금리
    // 전세/월세 모드 전용
    deposit: 0,                      // 만원 (보증금)
    monthlyRent: 0,                  // 만/월 (월세)
    // 시장 가정 (명목 %)
    investmentReturnRate: 6.0,
    inflationRate: 2.5,
    scenarioBandSpread: 2.0,
    returnVolatility: 12.0,        // 명목 %p — 몬테카를로 연 수익률 표준편차
    salaryGrowthRate: 3.5,         // 명목 %
    // 생활비 — 3인 가구 평균 (자녀비 자동 계산 별도)
    workingLivingCost: 300,
    bridgeLivingCost: 300,
    retirementLivingCost: 220,
    // 자녀 — 합계출산율 0.7~0.8, 40대 기혼 평균 ~1.3명 → 보수적 1명
    children: [
      { id: "child-1", birthYear: 2018 },
    ],
    childCostMultiplier: 1.0,
    // 이벤트
    downsizeEnabled: false,
    downsizeAge: 65,
    downsizeRatio: 0.6,
    // 의료비
    medicalCostMultiplier: 1.0,    // ×배율 (0.5 = 민영보험 보장 두텁게, 2.0 = 중증질환 대비)
    applyMedicalCost: true,
    // 세제
    includeSeveranceLumpSum: ASSUMPTIONS.assetRules.includeSeveranceLumpSumDefault,
    applyHealthInsurance: true,
    applyBasicPension: true,
    // C5: 인출 전략
    withdrawalStrategy: "bucket",     // "bucket" | "4pct" | "vpw"
    // C1: 시퀀스 리스크 스트레스 테스트
    stressTest: "severe",             // "none" | "mild" | "severe" | "2008"
  },
};

const KR_DEFAULTS = PRESETS.krDefault;
const SCENARIO_COLORS = ["#3b82f6", "#0ea5e9", "#f59e0b", "#8b5cf6"];
const CURRENT_YEAR = new Date().getFullYear();

// ============================================================
// 자동 계산 헬퍼
// ============================================================

// 출생연도 기반 국민연금 개시 나이 (2026년 기준 법정 수급 개시)
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
  const rateFn = typeof returnRateOverride === "function"
    ? returnRateOverride
    : () => toReal(returnRateOverride ?? input.investmentReturnRate);
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

// ============================================================
// C1: 시퀀스 리스크 프리셋 정의
// ============================================================

const STRESS_PRESETS = {
  none:   { label: "없음",              color: "none" },
  mild:   { label: "경미 (-5%p, 3년)", color: "#f59e0b",
            desc: "퇴직 직후 3년간 수익률 -5%p. 2001년 닷컴 버블 붕괴 수준." },
  severe: { label: "중간 (-10%p, 5년)", color: "#ef4444",
            desc: "퇴직 직후 5년간 수익률 -10%p. 2008년 금융위기 장기 침체 수준." },
  "2008": { label: "2008 (−30%, 회복)", color: "#7c3aed",
            desc: "첫해 -30%p 폭락 후 2년간 +10%p 반등, 이후 정상. 최악의 시나리오." },
};

// 스트레스 프리셋을 age → realRate 함수로 변환
function buildStressRateFn(stressKey, r, retireAge, inflRate) {
  const baseReal  = (1 + r / 100) / (1 + inflRate) - 1;
  if (!stressKey || stressKey === "none") return () => baseReal;

  if (stressKey === "mild") {
    const shockReal = (1 + Math.max(-30, r - 5) / 100) / (1 + inflRate) - 1;
    return (age) => (age >= retireAge && age < retireAge + 3) ? shockReal : baseReal;
  }
  if (stressKey === "severe") {
    const shockReal = (1 + Math.max(-30, r - 10) / 100) / (1 + inflRate) - 1;
    return (age) => (age >= retireAge && age < retireAge + 5) ? shockReal : baseReal;
  }
  if (stressKey === "2008") {
    const crashReal   = (1 + Math.max(-50, r - 30) / 100) / (1 + inflRate) - 1;
    const recovReal   = (1 + (r + 10) / 100) / (1 + inflRate) - 1;
    return (age) => {
      if (age === retireAge)                          return crashReal;   // 첫해 폭락
      if (age > retireAge && age <= retireAge + 2)   return recovReal;   // 2년 반등
      return baseReal;
    };
  }
  return () => baseReal;
}

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
      ? calculateScenario(input, stressRateFn, assumptions)
      : null,
    stressKey,  // UI에서 라벨 표시용
  };
}

// ============================================================
// C10: 몬테카를로 — 연도별 정규분포 수익률, 고정 시드 (재현 가능)
// ============================================================

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runMonteCarlo(input, assumptions = ASSUMPTIONS, opts = {}) {
  const mc = assumptions.monteCarlo;
  const runs = opts.runs ?? mc.runs;
  const mean = input.investmentReturnRate;
  const vol  = input.returnVolatility ?? mc.defaultVolatility;
  const inflRate = input.inflationRate / 100;
  // 입력 수익률은 연복리(중앙값) 수익률로 해석한다: (1+R)이 로그정규분포, 중앙값 = 1+r.
  // → 중간 시나리오(고정 수익률) 경로가 몬테카를로의 중앙 경로와 일치하고, 수익률이 −100% 아래로 내려가지 않는다.
  const growth = 1 + mean / 100;
  const cv = vol / 100 / growth;
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  const mu = Math.log(growth);
  let success = 0;
  const depletionAges = [];
  const finalAssets = [];
  for (let i = 0; i < runs; i++) {
    const rand = mulberry32(0x51ab1e + i * 7919);
    const normal = () => {
      const u1 = Math.max(rand(), 1e-9), u2 = rand();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const rateFn = () => Math.exp(mu + sigma * normal()) / (1 + inflRate) - 1;
    const res = calculateScenario(input, rateFn, assumptions, { lite: true });
    if (res.depletionAge === null) success++;
    else depletionAges.push(res.depletionAge);
    finalAssets.push(res.yearlyAssetFlow[res.yearlyAssetFlow.length - 1]?.financialAssets ?? 0);
  }
  depletionAges.sort((a, b) => a - b);
  finalAssets.sort((a, b) => a - b);
  const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
  return {
    runs,
    successRate: Math.round((success / runs) * 100),
    medianDepletionAge: pct(depletionAges, 0.5),
    p10Final: pct(finalAssets, 0.10),
    p50Final: pct(finalAssets, 0.50),
    p90Final: pct(finalAssets, 0.90),
  };
}

// ============================================================
// C9: 입력 정합성 검증
// ============================================================

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


module.exports = {ASSUMPTIONS, KR_DEFAULTS, PRESETS, normalizeInput, calculateScenario, runScenarioBand, runMonteCarlo, grossToNetAnnual, netToGrossAnnual, estimatedPensionMonthlyFor, healthInsuranceYearly, pensionClaimFactor};
