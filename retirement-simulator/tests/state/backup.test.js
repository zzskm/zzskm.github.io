import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeBackup, parseBackup } from '../../src/state/backup.js';
import { loadInitial, saveScenarios, LS_KEY } from '../../src/state/scenarioStore.js';
import { KR_DEFAULTS } from '../../src/model/defaults.js';
import { normalizeInput } from '../../src/state/migration.js';
import { parseNumericDraft } from '../../src/utils/units.js';
function storage(data={}) { return {data,getItem:k=>data[k]??null,setItem:(k,v)=>{data[k]=v;}}; }
const base={id:'base',name:'원본',input:normalizeInput(KR_DEFAULTS)};
test('backup round trip preserves all scenarios and salary basis',()=>{
 const r=parseBackup(serializeBackup([base],'base')); assert.deepEqual(r.scenarios[0].input,base.input);assert.equal(r.activeId,'base');
});
test('reject malformed imports before any state mutation',()=>{
 for(const text of ['null','{}','[]','{"version":99,"scenarios":[]}',JSON.stringify({scenarios:[{...base,input:{...base.input,investmentBalance:'1000'}}]}),JSON.stringify({scenarios:[{...base,input:{...base.input,currentAge:100000}}]})]) assert.throws(()=>parseBackup(text));
});
test('all supported storage versions and migration fields survive',()=>{
 for(const key of ['retirement-sim-v5','retirement-sim-v4','retirement-sim-v3-stepwise','retirement-sim-v2']) {
  const raw={currentSalary:3600,retirementBalance:2000,privatePensionBalance:1000,cashSavings:500,spouseMonthlyIncome:100,child1BirthYear:2018,hasHouse:false,withdrawalStrategy:'unified'};
  const st=storage({[key]:JSON.stringify({scenarios:[{id:'s',name:'내 계획',input:raw}],activeId:'s'})});
  const loaded=loadInitial(st);const input=loaded.scenarios[0].input;
  assert.equal(input.investmentBalance,3000);assert.equal(input.savingsBalance,500);assert.equal(input.selfCurrentSalary,3600);assert.equal(input.spouseCurrentSalary,1200);assert.equal(input.withdrawalStrategy,'bucket');assert.equal(input.children[0].birthYear,2018);assert.equal(input.housingMode,'monthly_rent');
  assert.ok(saveScenarios(loaded.scenarios,loaded.activeId,st));assert.deepEqual(loadInitial(st).scenarios,loaded.scenarios);
 }
});
test('corrupt current key does not hide valid legacy data or get silently overwritten',()=>{
 const st=storage({[LS_KEY]:'broken','retirement-sim-v4':JSON.stringify({scenarios:[base],activeId:'missing'})});
 const loaded=loadInitial(st);assert.equal(loaded.storageError,true);assert.equal(loaded.activeId,'base');assert.equal(st.data[LS_KEY],'broken');
});
test('exact previous payload is backed up, write failures are reported',()=>{
 const raw=JSON.stringify({scenarios:[base],activeId:'base'});const st=storage({[LS_KEY]:raw});
 assert.ok(saveScenarios([base],'base',st));assert.equal(st.data['retirement-sim-recovery-v5'],raw);
 assert.equal(saveScenarios([base],'base',{getItem(){throw Error('denied');}}),false);
});
test('numeric drafts accept precision and units, reject empty/nonfinite/out of bounds',()=>{
 assert.equal(parseNumericDraft('1,234.56',{min:0,max:2000}).value,1234.56);
 assert.equal(parseNumericDraft('.5',{min:0,max:10000,scale:10000}).value,5000);
 for(const s of ['', '.', 'Infinity','1e999','-1']) assert.equal(parseNumericDraft(s,{min:0,max:100}).valid,false);
 assert.equal(parseNumericDraft('40.5',{min:20,max:70,integer:true}).valid,false);
 assert.equal(parseNumericDraft('1234',{min:0,max:50000}).value,1234);
});
test('complete backups with over twelve scenarios round trip without data loss',()=>{
 const scenarios=Array.from({length:13},(_,n)=>({...base,id:`s${n}`,name:`계획 ${n}`,input:{...base.input,retireAge:60+n%5}})),restored=parseBackup(serializeBackup(scenarios,'s12'));
 assert.equal(restored.scenarios.length,13);assert.equal(restored.activeId,'s12');assert.deepEqual(restored.scenarios.map(s=>s.input),scenarios.map(s=>s.input));
});
test('export and import share the same UTF-8 byte limit',()=>{
 const scenarios=[{...base,name:'가'.repeat(700000)}];assert.throws(()=>serializeBackup(scenarios,'base'),/2MB/);assert.throws(()=>parseBackup(JSON.stringify({scenarios})),/2MB/);
 assert.throws(()=>parseBackup(JSON.stringify({scenarios:[{...base,input:{...base.input,projectionStress:'true'}}]})),/시장 충격/);
});
