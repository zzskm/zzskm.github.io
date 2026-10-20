import test from 'node:test';
import assert from 'node:assert/strict';
import { KR_DEFAULTS } from '../../src/model/defaults.js';
import { normalizeInput } from '../../src/state/migration.js';
import { applyInputPatch } from '../../src/state/inputUpdates.js';
import { SECTION_FIELDS } from '../../src/state/sections.js';
test('field and section resets clear provenance and retain unrelated settings',()=>{
 const initial=normalizeInput({...KR_DEFAULTS,retireAge:62,savingsBalance:1234,investmentBalance:9000,_sources:{retireAge:'user',savingsBalance:'user',investmentBalance:'user',_sources:'user'}}),original=JSON.stringify(initial);
 const one=applyInputPatch(initial,{retireAge:KR_DEFAULTS.retireAge},{source:'default'});
 assert.equal(one.retireAge,KR_DEFAULTS.retireAge);assert.equal(one._sources.retireAge,undefined);assert.equal(one._sources.savingsBalance,'user');assert.equal(one.savingsBalance,1234);
 const patch=Object.fromEntries(SECTION_FIELDS['자산'].map(k=>[k,KR_DEFAULTS[k]])),section=applyInputPatch(initial,patch,{source:'default'});
 assert.equal(section.savingsBalance,KR_DEFAULTS.savingsBalance);assert.equal(section.investmentBalance,KR_DEFAULTS.investmentBalance);
 for(const k of SECTION_FIELDS['자산'])assert.equal(section._sources[k],undefined);
 assert.equal(section.retireAge,62);assert.equal(section._sources.retireAge,'user');assert.equal(section._sources._sources,undefined);assert.equal(JSON.stringify(initial),original);
 assert.equal(applyInputPatch(one,{retireAge:63})._sources.retireAge,'user');
});
