import test from 'node:test';
import assert from 'node:assert/strict';
import {CURRENT_YEAR} from '../../retirement-simulator/src/model/assumptions.js';
import {normalizeInput} from '../../retirement-simulator/src/state/migration.js';
import {KR_DEFAULTS} from '../../retirement-simulator/src/model/defaults.js';
import {calculateScenario} from '../../retirement-simulator/src/model/cashflow.js';
import {computeStory,extractEvents,buildFrames,monthlyFlow,choiceInput,nextEventAge} from '../src/story.js';

const sample=()=>normalizeInput({...KR_DEFAULTS,
 currentAge:45,retireAge:50,selfLifeExpectancy:86,selfPensionStartAge:65,
 spouseEnabled:false,children:[{id:'first',birthYear:CURRENT_YEAR-16}],
 savingsBalance:2000,investmentBalance:3000,
 housingMode:'own',hasMortgage:true,mortgageBalance:500,
 monthlyMortgagePayment:100,mortgageRate:2,mortgagePriority:'scheduled',
 downsizeEnabled:false,allowAutoHousingConversion:false
});
test('timeline strictly reuses year and financial data produced by retirement engine',()=>{
 const input=sample(),result=calculateScenario(input);
 const frames=buildFrames(input,result);
 assert.equal(frames.length,result.yearlyAssetFlow.length);
 assert.equal(frames[0].age,input.currentAge);
 assert.equal(frames.at(-1).age,result.simEndAge);
 for(const [i,frame] of frames.entries()){
  assert.equal(frame.year,CURRENT_YEAR+frame.age-input.currentAge);
  assert.equal(frame.financialAssets,result.yearlyAssetFlow[i].financialAssets);
  assert.equal(frame.mortgage,result.yearlyAssetFlow[i].mortgage);
  assert.equal(frame.flow.income-frame.flow.spending,frame.flow.balance);
  assert.equal(typeof frame.description,'string');
 }
});
test('events include retirement, pensions, model child milestones, and mortgage payoff only when observed',()=>{
 const input=sample(),result=calculateScenario(input),events=extractEvents(input,result);
 assert.ok(events.some(e=>e.type==='retire'&&e.age===50));
 assert.ok(events.some(e=>e.type==='pension'&&e.age===65));
 assert.ok(events.some(e=>e.title==='자녀1 대학'));
 assert.ok(events.some(e=>e.title==='자녀1 독립'));
 assert.ok(events.some(e=>e.type==='mortgage'));
 assert.ok(events.every(e=>e.age>=input.currentAge&&e.age<=result.simEndAge));
 assert.ok(events.every((e,i)=>!i||events[i-1].age<=e.age));
});
test('solo and no-loan cases avoid fake spouse and payoff events',()=>{
 const input=normalizeInput({...sample(),housingMode:'monthly_rent',hasMortgage:false,mortgageBalance:0,children:[]});
 const events=extractEvents(input,calculateScenario(input));
 assert.equal(events.some(e=>e.type==='mortgage'||e.type==='child'||e.title==='배우자 국민연금 개시'),false);
});
test('readiness target and frame calculations preserve original model result',()=>{
 const input=sample(),story=computeStory(input),result=calculateScenario(input);
 assert.equal(story.result.readinessRatio,result.readinessRatio);
 assert.deepEqual(story.result.yearlyAssetFlow,result.yearlyAssetFlow);
 assert.equal(story.investmentTarget.readinessBefore,result.readinessRatio);
});
test('monthly flow uses each income/expense bucket once; savings transfer is excluded',()=>{
 const f=monthlyFlow({
  selfSalaryMonthly:200,spouseSalaryMonthly:150,selfPensionMonthly:0,spousePensionMonthly:0,basicPensionMonthly:0,bridgeSideMonthly:0,
  livingMonthly:150,childMonthly:80,mortgageMonthly:60,healthInsMonthly:10,medicalMonthly:5,maintMonthlyOut:20,rentMonthlyOut:0,extraSavingMonthly:100
 });
 assert.deepEqual(f,{income:350,spending:325,balance:25});
});
test('what-if decisions produce normalized copies without changing baseline',()=>{
 const original=sample(),before=JSON.stringify(original);
 const delayed=choiceInput(original,'delay');
 const cheaper=choiceInput(original,'spend');
 const debt=choiceInput(original,'debt');
 assert.equal(delayed.retireAge,52);
 assert.equal(cheaper.bridgeLivingCost,Math.max(0,original.bridgeLivingCost-30));
 assert.equal(cheaper.retirementLivingCost,Math.max(0,original.retirementLivingCost-30));
 assert.equal(debt.mortgagePriority,'buffered');
 assert.equal(JSON.stringify(original),before);
});
test('event navigation handles multiple events in the same year without loops',()=>{
 const events=[{age:50},{age:50},{age:55},{age:60}];
 assert.equal(nextEventAge(events,50,true),55);
 assert.equal(nextEventAge(events,55,false),50);
 assert.equal(nextEventAge(events,60,true),null);
 assert.equal(nextEventAge(events,50,false),null);
});
