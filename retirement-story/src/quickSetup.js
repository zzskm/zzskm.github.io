import {CURRENT_YEAR} from '../../retirement-simulator/src/model/assumptions.js';
import {normalizeInput} from '../../retirement-simulator/src/state/migration.js';
import {childCostAt} from '../../retirement-simulator/src/model/cashflow.js';

const round=n=>Math.round(Number(n)*100)/100;
export function toMonthly(annual) {return round((Number(annual)||0)/12);}
export function toAnnual(monthly) {return round((Number(monthly)||0)*12);}
export function setupDraft(input) {
 return {
  currentAge:input.currentAge,retireAge:input.retireAge,
  selfMonthly:toMonthly(input.selfCurrentSalary),
  spouseMonthly:toMonthly(input.spouseCurrentSalary),
  workingLivingCost:input.workingLivingCost,
  savingsBalance:input.savingsBalance,
  investmentBalance:input.investmentBalance,
  housingMode:input.housingMode,
  mortgageBalance:input.housingMode==='own'&&input.hasMortgage?input.mortgageBalance:0,
  monthlyMortgagePayment:input.monthlyMortgagePayment,
  housingMaintenance:input.housingMaintenance,
  monthlyRent:input.monthlyRent,
  deposit:input.deposit,
  spouseEnabled:input.spouseEnabled,
  spouseCurrentAge:input.spouseCurrentAge,
  spouseRetireAge:input.spouseRetireAge,
  childYears:(input.children??[]).map(c=>c.birthYear),
  bridgeLivingCost:input.bridgeLivingCost,
  retirementLivingCost:input.retirementLivingCost,
 };
}
const inRange=(n,min,max)=>Number.isFinite(Number(n))&&Number(n)>=min&&Number(n)<=max;
export function validateDraft(d) {
 if(!inRange(d.currentAge,25,70))return '현재 나이는 25~70세로 입력하세요.';
 if(!inRange(d.retireAge,Number(d.currentAge)+1,75))return '은퇴 나이는 현재 나이보다 크고 75세 이하여야 합니다.';
 if(!inRange(d.selfMonthly,0,2500)||!inRange(d.spouseMonthly,0,2500))return '세후 월급은 0~2,500만원 범위로 입력하세요.';
 if(!inRange(d.workingLivingCost,0,3000)||!inRange(d.bridgeLivingCost,0,3000)||!inRange(d.retirementLivingCost,0,3000))
  return '생활비는 월 0~3,000만원 범위로 입력하세요.';
 if(!inRange(d.savingsBalance,0,1000000)||!inRange(d.investmentBalance,0,1000000))return '금융자산은 0~1,000,000만원 범위로 입력하세요.';
 if(!['own','jeonse','monthly_rent'].includes(d.housingMode))return '주거 형태를 확인하세요.';
 if(!inRange(d.mortgageBalance,0,1000000)||!inRange(d.monthlyMortgagePayment,0,3000)||!inRange(d.monthlyRent,0,1000)||!inRange(d.deposit,0,2000000)||!inRange(d.housingMaintenance,0,500))
  return '주거 비용 입력값을 확인하세요.';
 if(d.spouseEnabled&&(!inRange(d.spouseCurrentAge,20,80)||!inRange(d.spouseRetireAge,Number(d.spouseCurrentAge)+1,75)))
  return '배우자 나이와 퇴직 나이를 확인하세요.';
 if(d.childYears.length>5||d.childYears.some(y=>!Number.isInteger(Number(y))||Number(y)<1900||Number(y)>CURRENT_YEAR))
  return '자녀 출생연도는 실제 출생연도로 입력하세요.';
 return null;
}
export function withChildCount(years,count) {
 const n=Math.max(0,Math.min(5,Number(count)||0));
 return Array.from({length:n},(_,i)=>years[i]??CURRENT_YEAR);
}
export function applyDraft(base,d) {
 const error=validateDraft(d);
 if(error)throw new RangeError(error);
 const children=d.childYears.map((birthYear,index)=>({
  id:base.children?.[index]?.id||`story-child-${index+1}`,birthYear:Number(birthYear),
 }));
 const mortgageActive=d.housingMode==='own'&&Number(d.mortgageBalance)>0;
 const out=normalizeInput({
  ...base,
  currentAge:Number(d.currentAge),retireAge:Number(d.retireAge),
  selfCurrentSalary:toAnnual(d.selfMonthly),selfSalaryBasis:'net',
  spouseEnabled:!!d.spouseEnabled,spouseCurrentSalary:d.spouseEnabled?toAnnual(d.spouseMonthly):0,spouseSalaryBasis:'net',
  spouseCurrentAge:Number(d.spouseCurrentAge),spouseRetireAge:Number(d.spouseRetireAge),
  children,
  workingLivingCost:Number(d.workingLivingCost),
  bridgeLivingCost:Number(d.bridgeLivingCost),
  retirementLivingCost:Number(d.retirementLivingCost),
  savingsBalance:Number(d.savingsBalance),investmentBalance:Number(d.investmentBalance),
  housingMode:d.housingMode,
  hasMortgage:mortgageActive,mortgageBalance:mortgageActive?Number(d.mortgageBalance):0,
  monthlyMortgagePayment:mortgageActive?Number(d.monthlyMortgagePayment):0,
  housingMaintenance:Number(d.housingMaintenance),
  monthlyRent:d.housingMode==='monthly_rent'?Number(d.monthlyRent):0,
  deposit:d.housingMode==='own'?0:Number(d.deposit),
 });
 if(out.retireAge>=out.selfLifeExpectancy)throw new RangeError('은퇴 나이가 계획 수명보다 작아야 합니다. 정밀 시뮬레이터에서 계획 수명을 변경하세요.');
 return out;
}

export function previewMonthlyOutflows(d,base) {
 const living=Number(d.workingLivingCost)||0;
 const children=Math.round(d.childYears.reduce((sum,y)=>sum+childCostAt(CURRENT_YEAR-Number(y))*(base.childCostMultiplier??1),0));
 const housing=(Number(d.housingMaintenance)||0)
  +(d.housingMode==='own'&&Number(d.mortgageBalance)>0?(Number(d.monthlyMortgagePayment)||0):0)
  +(d.housingMode==='monthly_rent'?(Number(d.monthlyRent)||0):0);
 return {living,children,housing,total:Math.round(living+children+housing)};
}
