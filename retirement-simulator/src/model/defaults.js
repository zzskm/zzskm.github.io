import { ASSUMPTIONS } from "./assumptions.js";
import { grossToNetAnnual } from "./taxation.js";

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

export { UI_RANGES, PRESETS, KR_DEFAULTS, SCENARIO_COLORS };
