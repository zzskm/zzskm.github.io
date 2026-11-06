import test from 'node:test';
import assert from 'node:assert/strict';
import { KR_DEFAULTS } from '../../src/model/defaults.js';
import { calculateScenario } from '../../src/model/cashflow.js';
import { normalizeInput } from '../../src/state/migration.js';
import { retirementReadinessInvestmentTarget } from '../../src/insights/targets.js';

const make = patch => normalizeInput({
 ...KR_DEFAULTS, currentAge:49, retireAge:50, selfLifeExpectancy:85,
 spouseEnabled:true, spouseCurrentAge:35, spouseRetireAge:70,
 spouseCurrentSalary:12000, selfCurrentSalary:3000,
 investmentBalance:5000, savingsBalance:8000, children:[],
 housePrice:40000, mortgageBalance:12000, monthlyMortgagePayment:50, mortgageRate:2,
 workingLivingCost:75, bridgeLivingCost:75, retirementLivingCost:75,
 applyHealthInsurance:false, applyBasicPension:false, applyMedicalCost:false,
 allowAutoHousingConversion:false, ...patch
});

test('mortgage priority uses only post-retirement surplus and never changes pre-retirement rows',()=>{
 const input=make({mortgagePriority:'scheduled'});
 const scheduled=calculateScenario(input);
 const surplus=calculateScenario({...input,mortgagePriority:'surplus'});
 const before=scheduled.yearlyAssetFlow.find(y=>y.age===49);
 const after=surplus.yearlyAssetFlow.find(y=>y.age===49);
 assert.deepEqual(before,after);
 const retireScheduled=scheduled.yearlyAssetFlow.find(y=>y.age===50);
 const retireSurplus=surplus.yearlyAssetFlow.find(y=>y.age===50);
 assert.ok(retireSurplus.mortgageExtraMonthly>0);
 assert.ok(retireSurplus.mortgage < retireScheduled.mortgage);
 assert.ok(retireSurplus.financialAssets < retireScheduled.financialAssets);
 assert.ok(retireSurplus.mortgage>=0);
});

test('buffered mortgage payoff preserves two years of spending in liquid savings',()=>{
 const input=make({spouseEnabled:false, selfCurrentSalary:0, investmentBalance:2000,
  savingsBalance:15000, bridgeLivingCost:100, retirementLivingCost:100,
  mortgagePriority:'surplus'});
 const surplus=calculateScenario(input);
 const buffered=calculateScenario({...input,mortgagePriority:'buffered'});
 const firstSurplus=surplus.yearlyAssetFlow.find(y=>y.age===50);
 const firstBuffered=buffered.yearlyAssetFlow.find(y=>y.age===50);
 assert.ok(firstBuffered.mortgage<firstSurplus.mortgage);
 assert.ok(firstBuffered.mortgageExtraMonthly>firstSurplus.mortgageExtraMonthly);
 assert.ok(firstBuffered.financialSavings>=0);
});

test('house cannot be sold by an undocumented fallback unless enabled',()=>{
 const input=make({spouseEnabled:false,selfCurrentSalary:0,investmentBalance:0,
  savingsBalance:0,housePrice:40000,hasMortgage:false,downsizeEnabled:false,
  mortgagePriority:'scheduled',bridgeLivingCost:1000,retirementLivingCost:1000,
  allowAutoHousingConversion:false});
 const keep=calculateScenario(input);
 const fallback=calculateScenario({...input,allowAutoHousingConversion:true});
 assert.equal(keep.downsizeEvents.some(e=>e.label.includes('자동')),false);
 assert.equal(keep.yearlyAssetFlow.find(y=>y.age===50).housingMode,'own');
 assert.ok(fallback.downsizeEvents.some(e=>e.label.includes('자동')));
});

test('readiness target is calculated at retirement and does not alter inputs',()=>{
 const input=make({spouseEnabled:false,investmentBalance:100,savingsBalance:100,
  selfCurrentSalary:1000,bridgeLivingCost:350,retirementLivingCost:350,
  mortgagePriority:'scheduled'});
 const before=JSON.stringify(input);
 const base=calculateScenario(input);
 assert.ok(base.depletionAge!==null);
 const target=retirementReadinessInvestmentTarget(input,base);
 assert.ok(target.additionalAtRetirement>0);
 assert.equal(target.targetAtRetirement,base.totalAssetsAtRetirement+target.additionalAtRetirement);
 const achieved=calculateScenario(input,undefined,undefined,{retirementTopUp:target.additionalAtRetirement});
 assert.equal(achieved.depletionAge,null);
 assert.ok(achieved.readinessRatio>=100);
 assert.equal(JSON.stringify(input),before);
 const already=retirementReadinessInvestmentTarget({...input,investmentBalance:500000});
 assert.equal(already.additionalAtRetirement,0);
});
