import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {PERSONAS,createPersonaInput,getPersona,inferPersonaId} from '../src/personas.js';
import {applyDraft,setupDraft,validateDraft,withChildCount,toMonthly,toAnnual} from '../src/quickSetup.js';
import {normalizeInput} from '../../retirement-simulator/src/state/migration.js';
import {calculateScenario} from '../../retirement-simulator/src/model/cashflow.js';

test('five suggested personas preserve household count and calculator defaults',()=>{
 assert.deepEqual(PERSONAS.map(x=>x.id),['solo','couple','one-child','two-children','three-children']);
 assert.equal(new Set(PERSONAS.map(p=>p.title)).size,5);
 for(const p of PERSONAS){
  const input=createPersonaInput(p.id);
  assert.equal(input.children.length,p.household.children.length);
  assert.equal(input.spouseEnabled,p.id!=='solo');
  assert.ok(input.retireAge>input.currentAge);
  assert.equal(input.allowAutoHousingConversion,false);
  assert.ok(calculateScenario(input).yearlyAssetFlow.length>0);
 }
 assert.equal(getPersona('not-real'),null);
});

test('monthly net salary to annual follows the simulator engine units',()=>{
 assert.equal(toMonthly(7200),600);
 assert.equal(toAnnual(620),7440);
 assert.equal(toAnnual(toMonthly(7200)),7200);
});

test('simple input changes income and living costs without resetting modeled housing and children',()=>{
 const base=createPersonaInput('two-children');
 const snapshot=JSON.stringify(base);
 const draft=setupDraft(base);
 draft.currentAge=42;draft.retireAge=50;
 draft.selfMonthly=500;draft.spouseMonthly=125;draft.workingLivingCost=280;
 draft.savingsBalance=9000;draft.investmentBalance=10000;
 const input=applyDraft(base,draft);
 assert.equal(input.currentAge,42);
 assert.equal(input.retireAge,50);
 assert.equal(input.selfCurrentSalary,6000);
 assert.equal(input.spouseCurrentSalary,1500);
 assert.equal(input.workingLivingCost,280);
 assert.deepEqual(input.children,base.children);
 assert.equal(input.housingMode,base.housingMode);
 assert.equal(input.mortgagePriority,base.mortgagePriority);
 assert.equal(input.savingsBalance,9000);
 assert.equal(input.investmentBalance,10000);
 assert.equal(JSON.stringify(base),snapshot);
 assert.ok(calculateScenario(input).yearlyAssetFlow.length>0);
});

test('resizing children retains provided birth years and applies placeholder for new children',()=>{
 assert.deepEqual(withChildCount([2017,2023],3).slice(0,2),[2017,2023]);
 assert.equal(withChildCount([2017,2023],1).length,1);
 assert.equal(withChildCount([],20).length,5);
});

test('invalid retirement age, child years or negative financial balances are blocked',()=>{
 const base=createPersonaInput('one-child');
 const d=setupDraft(base);
 d.retireAge=d.currentAge;
 assert.match(validateDraft(d),/은퇴 나이/);
 assert.throws(()=>applyDraft(base,d),RangeError);
 d.retireAge=60;d.savingsBalance=-1;
 assert.match(validateDraft(d),/금융자산/);
 d.savingsBalance=100;d.childYears=[2099];
 assert.match(validateDraft(d),/출생연도/);
});

test('imported atypical household can be edited without changing spouse or asset strategy',()=>{
 const input=normalizeInput({...createPersonaInput('solo'),spouseEnabled:false,children:[{id:'c1',birthYear:2017}],withdrawalStrategy:'vpw'});
 assert.equal(inferPersonaId(input),'solo');
 const draft=setupDraft(input);
 const modified=applyDraft(input,{...draft,workingLivingCost:160});
 assert.equal(modified.spouseEnabled,false);
 assert.equal(modified.withdrawalStrategy,'vpw');
 assert.equal(modified.children.length,1);
});

test('theme is strictly light and does not depend on OS dark mode',()=>{
 const css=readFileSync(fileURLToPath(new URL('../src/styles.css',import.meta.url)),'utf8');
 assert.match(css,/:root\s*\{\s*color-scheme:light;/);
 assert.doesNotMatch(css,/prefers-color-scheme:\s*dark/);
 assert.match(css,/\.scene-artwork/);
});
