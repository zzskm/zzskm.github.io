import test from 'node:test';
import assert from 'node:assert/strict';
import {readWizardDraft,saveWizardDraft,removeWizardDraft,wizardErrors,applyWizardDraft} from '../../src/state/wizardDraft.js';
import {KR_DEFAULTS} from '../../src/model/defaults.js';
const store=()=>{const data={};return {getItem:k=>data[k]??null,setItem:(k,v)=>{data[k]=v;},removeItem:k=>{delete data[k];}};};
test('wizard interruption resumes draft and step for the correct scenario',()=>{
 const storage=store();const d={step:3,input:KR_DEFAULTS,changed:['retireAge']};
 assert.ok(saveWizardDraft('a',d,storage));assert.equal(readWizardDraft('a',storage).step,3);assert.equal(readWizardDraft('b',storage),null);removeWizardDraft('a',storage);assert.equal(readWizardDraft('a',storage),null);
});
test('selective wizard merge retains unrelated and excluded settings',()=>{
 const base={...KR_DEFAULTS,investmentReturnRate:4.2};
 const merged=applyWizardDraft(base,{...base,retireAge:62,savingsBalance:9999},['retireAge']);
 assert.equal(merged.retireAge,62);assert.equal(merged.savingsBalance,base.savingsBalance);assert.equal(merged.investmentReturnRate,4.2);assert.equal(merged._sources.retireAge,'user');
});
test('wizard validation blocks invalid household and ages',()=>{
 assert.ok(wizardErrors({...KR_DEFAULTS,retireAge:30},0).retireAge);
 assert.ok(wizardErrors({...KR_DEFAULTS,spouseRetireAge:20},1).spouseRetireAge);
 assert.ok(wizardErrors({...KR_DEFAULTS,housingMode:'jeonse',deposit:0},3).deposit);
 assert.deepEqual(wizardErrors(KR_DEFAULTS,0),{});
});
