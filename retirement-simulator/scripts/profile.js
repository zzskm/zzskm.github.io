import {performance} from 'node:perf_hooks';
import {calculateScenario} from '../src/model/cashflow.js';
import {KR_DEFAULTS} from '../src/model/defaults.js';
import {normalizeInput} from '../src/state/migration.js';
import {runMonteCarlo} from '../src/model/monteCarlo.js';
import {findInsights} from '../src/insights/recommendations.js';
import {exploreTargets} from '../src/insights/targets.js';
const input=normalizeInput(KR_DEFAULTS);
for(const [label,run] of [['deterministic',()=>calculateScenario(input)],['MC 1000',()=>runMonteCarlo(input)],['personalized insights',()=>findInsights(input,50)],['target ranges',()=>exploreTargets(input)]]){
 run();const start=performance.now();for(let n=0;n<5;n++)run();console.log(`${label}: ${((performance.now()-start)/5).toFixed(1)} ms average`);
}
