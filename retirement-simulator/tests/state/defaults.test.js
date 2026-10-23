import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { KR_DEFAULTS } from '../../src/model/defaults.js';
import { DEFAULT_BENCHMARKS } from '../../src/model/defaultBenchmarks.js';
import { grossToNetAnnual } from '../../src/model/taxation.js';
import { loadInitial, LS_KEY } from '../../src/state/scenarioStore.js';
import { birthYearForAge, birthYearLabel } from '../../src/utils/age.js';
const legacy = createRequire(import.meta.url)('../fixtures/legacy-model.cjs');

test('new plans use household median anchors with explicit example allocation', () => {
  const initial = loadInitial({ getItem: () => null });
  assert.equal(initial.isNew, true);
  const input = initial.scenarios[0].input;
  assert.equal(input.selfCurrentSalary, Math.round(grossToNetAnnual(3600)));
  assert.equal(input.spouseCurrentSalary, Math.round(grossToNetAnnual(2200)));
  assert.equal(DEFAULT_BENCHMARKS.householdGrossAnnualIncome, 3600 + 2200);
  assert.equal(DEFAULT_BENCHMARKS.householdNetWorth, 23860);
  const netWorth = input.housePrice + input.savingsBalance + input.investmentBalance - input.mortgageBalance;
  assert.equal(netWorth, 24000);
  assert.ok(Math.abs(netWorth - DEFAULT_BENCHMARKS.householdNetWorth) / DEFAULT_BENCHMARKS.householdNetWorth < 0.01);
  assert.equal(input.spouseEnabled, true);
  assert.equal(input.children.length, 1);
  assert.deepEqual(input.children, KR_DEFAULTS.children);
});

test('loading a complete saved plan preserves old defaults and custom values', () => {
  const input = { ...legacy.KR_DEFAULTS, currentAge: 48, savingsBalance: 1234.56, _sources: { currentAge: 'user' } };
  const payload = { activeId: 'saved', scenarios: [{ id: 'saved', name: '내 계획', input }] };
  const result = loadInitial({ getItem: key => key === LS_KEY ? JSON.stringify(payload) : null });
  assert.equal(result.isNew, false);
  assert.equal(result.activeId, 'saved');
  for (const [key, value] of Object.entries(input)) assert.deepEqual(result.scenarios[0].input[key], value, key);
});

test('birth-year labels follow the model year and reject non-age values', () => {
  assert.equal(birthYearForAge(40, 2026), 1986);
  assert.equal(birthYearForAge(38, 2026), 1988);
  assert.equal(birthYearForAge(40, 2030), 1990);
  assert.match(birthYearLabel(41, 2026), /1985년생.*생일 미반영/);
  for (const age of [undefined, null, NaN, Infinity, -1, 40.5, '40']) {
    assert.equal(birthYearForAge(age, 2026), null);
    assert.equal(birthYearLabel(age, 2026), '');
  }
});
