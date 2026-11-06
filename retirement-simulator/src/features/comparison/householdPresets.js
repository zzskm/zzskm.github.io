import { KR_DEFAULTS } from '../../model/defaults.js';
import { normalizeInput } from '../../state/migration.js';

// 2026 Ministry of Health and Welfare official median-income benchmarks (KRW/month).
// https://www.mohw.go.kr/menu.es?mid=a10708010300
// IMPORTANT: official 기준 중위소득 is a welfare benchmark, NOT observed post-tax earnings.
// Using it as the household's modeled net annual wage is a deliberate starter-scenario
// convention; the wage split, house, assets, spending and ages below are illustrative.
export const HOUSEHOLD_MEDIAN_2026 = Object.freeze({
  1: 2564238,
  2: 4199292,
  3: 5359036,
  4: 6494738,
  5: 7556719,
});

const examples = [
 { id:'solo', label:'솔로', size:1, children:[], selfShare:1,
   living:150, bridge:155, retirement:135, maintenance:12,
   housing:'monthly_rent', deposit:1000, rent:60, house:0, mortgage:0, payment:0,
   savings:1500, investments:1500, monthlySaving:15 },
 { id:'couple', label:'무자녀 부부', size:2, children:[], selfShare:0.6,
   living:245, bridge:245, retirement:200, maintenance:18,
   housing:'jeonse', deposit:15000, rent:0, house:0, mortgage:0, payment:0,
   savings:2200, investments:3200, monthlySaving:25 },
 { id:'one-child', label:'1자녀', size:3, children:[2018], selfShare:0.65,
   living:240, bridge:250, retirement:210, maintenance:22,
   housing:'own', deposit:0, rent:0, house:28000, mortgage:14000, payment:85,
   savings:2500, investments:4000, monthlySaving:30 },
 { id:'two-children', label:'2자녀', size:4, children:[2018,2023], selfShare:0.65,
   living:265, bridge:275, retirement:220, maintenance:25,
   housing:'own', deposit:0, rent:0, house:32000, mortgage:17000, payment:100,
   savings:3500, investments:5500, monthlySaving:40 },
 { id:'three-children', label:'3자녀', size:5, children:[2016,2020,2024], selfShare:0.65,
   living:285, bridge:295, retirement:230, maintenance:28,
   housing:'own', deposit:0, rent:0, house:35000, mortgage:19000, payment:115,
   savings:4000, investments:6500, monthlySaving:50 },
];

export const HOUSEHOLD_PRESETS = Object.freeze(examples.map(({children,...example})=>Object.freeze({
 ...example,
 children: Object.freeze(children.slice()),
 medianMonthlyWon: HOUSEHOLD_MEDIAN_2026[example.size],
 description: example.size===1?'1인 단독소득·월세 예시':
   example.size===2?'맞벌이·전세 예시':`맞벌이·자가·자녀 ${children.length}명 예시`,
})));

export function createHouseholdPresetInput(id) {
 const preset=HOUSEHOLD_PRESETS.find(p=>p.id===id);
 if(!preset) throw new RangeError('Unknown household preset');
 // The calculation engine expects NET annual income in 만원.
 const householdAnnual = Math.round(preset.medianMonthlyWon*12/10000);
 const selfAnnual = Math.round(householdAnnual*preset.selfShare);
 const spouseAnnual = preset.size>1?householdAnnual-selfAnnual:0;
 return normalizeInput({
  ...KR_DEFAULTS,
  currentAge:40,retireAge:60,selfLifeExpectancy:90,
  selfPensionStartAge:65,selfCurrentSalary:selfAnnual,selfSalaryBasis:'net',
  spouseEnabled:preset.size>1,spouseCurrentAge:38,spouseRetireAge:60,
  spouseLifeExpectancy:90,spousePensionStartAge:65,
  spouseCurrentSalary:spouseAnnual,spouseSalaryBasis:'net',
  selfNpInputMode:'auto',spouseNpInputMode:'auto',selfNpAutoMode:true,spouseNpAutoMode:true,
  selfNpYears:0,spouseNpYears:0,postRetireSideIncome:0,
  children:preset.children.map((birthYear,n)=>({id:`median-${preset.id}-child-${n+1}`,birthYear})),
  childCostMultiplier:1,
  housingMode:preset.housing,deposit:preset.deposit,monthlyRent:preset.rent,
  hasMortgage:preset.mortgage>0,housePrice:preset.house,
  mortgageBalance:preset.mortgage,monthlyMortgagePayment:preset.payment,
  mortgageRate:4,housingMaintenance:preset.maintenance,
  savingsBalance:preset.savings,investmentBalance:preset.investments,
  monthlyAddSaving:preset.monthlySaving,
  workingLivingCost:preset.living,bridgeLivingCost:preset.bridge,
  retirementLivingCost:preset.retirement,
  mortgagePriority:'surplus',allowAutoHousingConversion:false,
  downsizeEnabled:false,
  _sources:{
    selfCurrentSalary:'preset:2026-median-benchmark',
    spouseCurrentSalary:'preset:2026-median-benchmark',
  },
 });
}
