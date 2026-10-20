import test from 'node:test';
import assert from 'node:assert/strict';
import {createLRU,simulationKey,cachedScenarioBand} from '../../src/model/cache.js';
import {KR_DEFAULTS} from '../../src/model/defaults.js';
test('cache keys ignore display-only edits and invalidate real model edits',()=>{
 assert.equal(simulationKey(KR_DEFAULTS),simulationKey({...KR_DEFAULTS,selfSalaryBasis:'net',_sources:{retireAge:'user'}}));
 assert.notEqual(simulationKey(KR_DEFAULTS),simulationKey({...KR_DEFAULTS,retireAge:61}));
 assert.equal(cachedScenarioBand(KR_DEFAULTS),cachedScenarioBand({...KR_DEFAULTS}));
});
test('bounded cache refreshes access order',()=>{
 const c=createLRU(2);c.set('a',1);c.set('b',2);c.get('a');c.set('c',3);assert.equal(c.get('b'),undefined);assert.equal(c.get('a'),1);assert.equal(c.size,2);
});
