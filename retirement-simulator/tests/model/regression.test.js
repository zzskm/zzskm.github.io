import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { KR_DEFAULTS } from '../../src/model/defaults.js';
import { normalizeInput } from '../../src/state/migration.js';
import { calculateScenario, healthInsuranceYearly } from '../../src/model/cashflow.js';
import { runScenarioBand } from '../../src/model/scenarios.js';
import { runMonteCarlo } from '../../src/model/monteCarlo.js';
import { grossToNetAnnual, netToGrossAnnual } from '../../src/model/taxation.js';
import { estimatedPensionMonthlyFor, pensionClaimFactor } from '../../src/model/pension.js';
const legacy = createRequire(import.meta.url)('../fixtures/legacy-model.cjs');
const fixtures = [
 {}, {spouseEnabled:false,children:[],housingMode:'monthly_rent',deposit:5000,monthlyRent:80},
 {housingMode:'jeonse',deposit:40000,investmentBalance:0,savingsBalance:0},
 {currentAge:59,retireAge:60,selfPensionStartAge:65,spouseEnabled:false},
 {investmentBalance:1000000,savingsBalance:500000,hasMortgage:false},
 {withdrawalStrategy:'4pct'}, {withdrawalStrategy:'vpw'},
 {selfNpInputMode:'manual',selfNpManualMonthly:120,spouseNpInputMode:'manual',spouseNpManualMonthly:80},
 {downsizeEnabled:true,downsizeAge:65,downsizeRatio:0.4},
 {housingMode:'own',housePrice:0,mortgageBalance:0,savingsBalance:0,investmentBalance:0,selfCurrentSalary:0,spouseEnabled:false},
 {selfLifeExpectancy:105,spouseLifeExpectancy:105},
 {investmentReturnRate:0,returnVolatility:0,inflationRate:8},
 {investmentReturnRate:12,returnVolatility:30,inflationRate:0},
 {children:[{id:'a',birthYear:2026},{id:'b',birthYear:2005}]},
 {applyMedicalCost:false,applyHealthInsurance:false,applyBasicPension:false,includeSeveranceLumpSum:true},
];
for (const [idx,patch] of fixtures.entries()) {
 test(`legacy parity: complete yearly flows, housing, pension, withdrawal and seeded MC ${idx}`,()=>{
  const input=normalizeInput({...KR_DEFAULTS,...patch});
  assert.deepEqual(input,legacy.normalizeInput({...legacy.KR_DEFAULTS,...patch}));
  assert.deepEqual(calculateScenario(input),legacy.calculateScenario(input));
  assert.deepEqual(runScenarioBand(input),legacy.runScenarioBand(input));
  assert.deepEqual(runMonteCarlo(input,undefined,{runs:50}),legacy.runMonteCarlo(input,undefined,{runs:50}));
  assert.ok(calculateScenario(input).yearlyAssetFlow.every(r=>Object.values(r).every(v=>typeof v!=='number'||Number.isFinite(v))));
 });
}
test('2026 default regression golden values',()=>{
 const actual=calculateScenario(normalizeInput(KR_DEFAULTS));
 const golden=JSON.parse(requireGolden());
 for(const [key,value] of Object.entries(golden)) assert.deepEqual(actual[key],value,key);
});
import { readFileSync } from 'node:fs';
function requireGolden(){return readFileSync(new URL('../fixtures/default-2026.json',import.meta.url),'utf8');}
test('fixed-seed repeatability and zero-volatility limit',()=>{
 const input=normalizeInput({...KR_DEFAULTS,returnVolatility:0});
 const a=runMonteCarlo(input,undefined,{runs:100});
 assert.deepEqual(a,runMonteCarlo(input,undefined,{runs:100}));
 assert.equal(a.successRate,calculateScenario(input).depletionAge===null?100:0);
});
test('tax round trips and unchanged policy boundaries',()=>{
 for(const gross of [0,500,1400,1500,3300,4500,5000,7000,8800,10000,12000,15000,100000]) {
  assert.equal(grossToNetAnnual(gross),legacy.grossToNetAnnual(gross));
  assert.ok(Math.abs(netToGrossAnnual(grossToNetAnnual(gross))-gross)<=1);
 }
});
test('manual pension and claim adjustment boundaries',()=>{
 assert.equal(pensionClaimFactor(50,65),0.7);
 assert.equal(pensionClaimFactor(80,65),1.36);
 const input=normalizeInput({...KR_DEFAULTS,selfNpInputMode:'manual',selfNpManualMonthly:123});
 assert.equal(estimatedPensionMonthlyFor(input,'self'),legacy.estimatedPensionMonthlyFor(input,'self'));
 assert.equal(healthInsuranceYearly({earnedIncome:0,pensionIncome:2000,houseValue:50000}),legacy.healthInsuranceYearly({earnedIncome:0,pensionIncome:2000,houseValue:50000}));
});
