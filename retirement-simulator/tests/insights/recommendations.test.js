import test from 'node:test';
import assert from 'node:assert/strict';
import { KR_DEFAULTS } from '../../src/model/defaults.js';
import { calculateScenario } from '../../src/model/cashflow.js';
import { normalizeInput } from '../../src/state/migration.js';
import { buildCandidates } from '../../src/insights/candidates.js';
import { findInsights } from '../../src/insights/recommendations.js';
import { analyzeRisk } from '../../src/insights/analyzer.js';
import { exploreTargets } from '../../src/insights/targets.js';
test('exclude irrelevant housing spouse and bridge candidates',()=>{
 const i=normalizeInput({...KR_DEFAULTS,housingMode:'monthly_rent',spouseEnabled:false,retireAge:70,selfCurrentSalary:0});
 const c=buildCandidates(i);assert.ok(!c.some(x=>['housing','spouse','bridge','retirement'].includes(x.group)));
 assert.ok(c.every(x=>Object.entries(x.patch).some(([k,v])=>v!==i[k])));
});
test('recommendations are serializable, nonmutating and match applied model',()=>{
 const i=normalizeInput({...KR_DEFAULTS,investmentBalance:0,savingsBalance:0,retireAge:50});const original=JSON.stringify(i);
 const r=findInsights(i,20);assert.ok(r.tested>5);assert.equal(JSON.stringify(i),original);assert.deepEqual(JSON.parse(JSON.stringify(r)),r);
 for(const c of r.items){const result=calculateScenario(normalizeInput({...i,...c.patch}));assert.equal(c.depletionTo,result.depletionAge);assert.ok(c.uncertainty>=2);}
});
test('target candidates match deterministic calculation and risk cashflows',()=>{
 const i=normalizeInput(KR_DEFAULTS),r=calculateScenario(i),targets=exploreTargets(i),risk=analyzeRisk(i,r);
 assert.equal(risk.bridgeShortfall,r.bridgeShortfall);assert.equal(targets.longevity.endAge,r.simEndAge+5);
 for(const patch of Object.values(targets.patches))if(patch)assert.equal(calculateScenario(normalizeInput({...i,...patch})).depletionAge,null);
});
