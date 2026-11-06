import test from 'node:test';
import assert from 'node:assert/strict';
import { KR_DEFAULTS } from '../../src/model/defaults.js';
import { monthlyNetFromAnnual, annualNetFromMonthly, resizeChildren, currentChildCostMonthly, quickBudgetBreakdown } from '../../src/components/quickEntry.js';

test('monthly salary editing maps to annual net income without a duplicate input',()=>{
 assert.equal(monthlyNetFromAnnual(7200),600);
 assert.equal(annualNetFromMonthly(600),7200);
 assert.equal(annualNetFromMonthly(568.07),6816.84);
 assert.equal(monthlyNetFromAnnual(0),0);
});
test('child count adjustment retains birth years and adds explicit newborn placeholders',()=>{
 const existing=[{id:'first',birthYear:2017}];
 const grown=resizeChildren(existing,3,2026);
 assert.equal(grown[0],existing[0]);
 assert.deepEqual(grown.map(x=>x.birthYear),[2017,2026,2026]);
 assert.equal(resizeChildren(grown,1,2026).length,1);
 assert.equal(resizeChildren(existing,20,2026).length,5);
});
test('quick budget reports additive child assumptions but does not double count housing',()=>{
 const own={...KR_DEFAULTS,workingLivingCost:300,children:[{id:'a',birthYear:2018},{id:'b',birthYear:2023}],
  childCostMultiplier:1.2,housingMode:'own',hasMortgage:true,monthlyMortgagePayment:120,housingMaintenance:28};
 const b=quickBudgetBreakdown(own);
 assert.equal(b.children,156);
 assert.equal(currentChildCostMonthly(own),156);
 assert.equal(b.mortgage,120);
 assert.equal(b.total,604);
 const renter=quickBudgetBreakdown({...own,housingMode:'monthly_rent',monthlyRent:80});
 assert.equal(renter.mortgage,0);
 assert.equal(renter.rent,80);
});
