import { CURRENT_YEAR } from '../model/assumptions.js';
import { childCostAt } from '../model/cashflow.js';

export function monthlyNetFromAnnual(annual) {
 return Math.round((Number(annual) || 0) / 12 * 100) / 100;
}

export function annualNetFromMonthly(monthly) {
 return Math.round((Number(monthly) || 0) * 12 * 100) / 100;
}

// Keep existing birth years. Newly added children start as newborns until the
// user supplies a birth year; the UI makes this placeholder explicit.
export function resizeChildren(children = [], count, year = CURRENT_YEAR) {
 const safe = Math.max(0, Math.min(5, Math.trunc(Number(count) || 0)));
 return Array.from({length:safe},(_,index)=>children[index] ?? {
  id:`quick-child-${index+1}`,birthYear:year,
 });
}

export function currentChildCostMonthly(input, year = CURRENT_YEAR) {
 const mult = input.childCostMultiplier ?? 1;
 return (input.children ?? []).reduce((sum,c) =>
  sum + childCostAt(year - c.birthYear) * mult,0);
}

// Cash expenses visible in the quick editor. Medical, taxes and health
// insurance are additional simulation assumptions, not silently added here.
export function quickBudgetBreakdown(input) {
 const living = input.workingLivingCost ?? 0;
 const children = currentChildCostMonthly(input);
 const maintenance = input.housingMaintenance ?? 0;
 const mortgage = input.housingMode === 'own' && input.hasMortgage ? input.monthlyMortgagePayment ?? 0 : 0;
 const rent = input.housingMode === 'monthly_rent' ? input.monthlyRent ?? 0 : 0;
 return {living,children,maintenance,mortgage,rent,total:living+children+maintenance+mortgage+rent};
}
