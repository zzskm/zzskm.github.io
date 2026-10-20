import test from 'node:test';
import assert from 'node:assert/strict';
import { KR_DEFAULTS } from '../../src/model/defaults.js';
import { normalizeInput } from '../../src/state/migration.js';
import { calculateScenario } from '../../src/model/cashflow.js';
import { runScenarioBand, buildStressRateFn } from '../../src/model/scenarios.js';
import { runMonteCarlo } from '../../src/model/monteCarlo.js';
import { exploreTargets } from '../../src/insights/targets.js';
import { serializeBackup, parseBackup } from '../../src/state/backup.js';
for (const stressTest of ['none','mild','severe','2008']) {
 test(`${stressTest}: shock comparison matches the stress path without double application`, () => {
  const base=normalizeInput({...KR_DEFAULTS,stressTest}),input={...base,projectionStress:true};
  const expected=calculateScenario(base,buildStressRateFn(stressTest,base.investmentReturnRate,base.retireAge,base.inflationRate/100));
  assert.deepEqual(calculateScenario(input),expected);
  const bands=runScenarioBand(input);assert.deepEqual(bands.mid,expected);
  if(stressTest!=='none')assert.deepEqual(bands.sequenceShock,expected);
  for(const [name,spread] of [['pessimistic',-base.scenarioBandSpread],['optimistic',base.scenarioBandSpread]])assert.deepEqual(bands[name],calculateScenario(base,buildStressRateFn(stressTest,base.investmentReturnRate+spread,base.retireAge,base.inflationRate/100)));
  const mc=runMonteCarlo({...input,returnVolatility:0},undefined,{runs:25});
  assert.equal(mc.p50Final,expected.yearlyAssetFlow.at(-1).financialAssets);assert.equal(mc.successRate,expected.depletionAge===null?100:0);
 });
}
test('shock diagnosis, comparison and restored backup agree',()=>{
 const base=normalizeInput({...KR_DEFAULTS,stressTest:'none'}),targets=exploreTargets(base),compared={...base,...targets.shock.patch},result=calculateScenario(compared);
 assert.equal(result.readinessRatio,targets.shock.readinessRatio);assert.equal(result.depletionAge,targets.shock.depletionAge);
 assert.notEqual(result.readinessRatio,calculateScenario(base).readinessRatio);
 const restored=parseBackup(serializeBackup([{id:'shock',name:'시장 충격',input:compared}],'shock'));
 assert.deepEqual(calculateScenario(restored.scenarios[0].input),result);
 assert.deepEqual(runMonteCarlo(compared,undefined,{runs:50}),runMonteCarlo(compared,undefined,{runs:50}));
});
