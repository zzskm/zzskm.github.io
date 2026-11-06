import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUSEHOLD_MEDIAN_2026, HOUSEHOLD_PRESETS, createHouseholdPresetInput } from '../../src/features/comparison/householdPresets.js';
import { calculateScenario } from '../../src/model/cashflow.js';
import { validateInput } from '../../src/model/validation.js';

test('all five distinct household presets cover 2026 median-income household sizes', () => {
 assert.deepEqual(HOUSEHOLD_PRESETS.map(p=>p.label),['솔로','무자녀 부부','1자녀','2자녀','3자녀']);
 assert.deepEqual(HOUSEHOLD_PRESETS.map(p=>p.size),[1,2,3,4,5]);
 assert.deepEqual(Object.values(HOUSEHOLD_MEDIAN_2026),[2564238,4199292,5359036,6494738,7556719]);
});

for (const preset of HOUSEHOLD_PRESETS) {
 test(`household preset ${preset.id} has matching dependents, benchmark annual modeled income, and finite projection`, () => {
  const input=createHouseholdPresetInput(preset.id);
  const other=createHouseholdPresetInput(preset.id);
  assert.notStrictEqual(input,other);
  assert.deepEqual(input,other);
  assert.equal(input.children.length,preset.size===1?0:preset.size-2);
  assert.equal(input.spouseEnabled,preset.size>1);
  const expectedAnnual=Math.round(preset.medianMonthlyWon*12/10000);
  assert.equal(input.selfCurrentSalary+input.spouseCurrentSalary,expectedAnnual);
  assert.equal(input.selfSalaryBasis,'net');
  assert.equal(input.spouseSalaryBasis,'net');
  assert.equal(input.allowAutoHousingConversion,false);
  assert.equal(input.mortgagePriority,'surplus');
  assert.ok(input.workingLivingCost>=50);
  assert.equal(validateInput(input).filter(w=>w.level==='error').length,0);
  const result=calculateScenario(input);
  assert.ok(result.yearlyAssetFlow.length>30);
  assert.ok(result.yearlyAssetFlow.every(y=>Object.values(y).every(v=>typeof v!=='number'||Number.isFinite(v))));
 });
}

test('invalid preset id is rejected without mutating other scenarios',()=>{
 assert.throws(()=>createHouseholdPresetInput('not-a-preset'),RangeError);
 const one=createHouseholdPresetInput('one-child');
 one.children[0].birthYear=2000;
 assert.equal(createHouseholdPresetInput('one-child').children[0].birthYear,2018);
});
