

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


const CURRENT_YEAR = new Date().getFullYear();

export { ASSUMPTIONS, CURRENT_YEAR };
