import { ASSUMPTIONS, CURRENT_YEAR } from './assumptions.js';
import { runScenarioBand } from './scenarios.js';
export function simulationKey(input) {
 const ignored=new Set(['_sources','selfSalaryBasis','spouseSalaryBasis']);
 return JSON.stringify([ASSUMPTIONS.version,CURRENT_YEAR,Object.keys(input).filter(k=>!ignored.has(k)).sort().map(k=>[k,input[k]])]);
}
export function createLRU(limit=12) {
 const entries=new Map();
 return {get(key){if(!entries.has(key))return undefined;const v=entries.get(key);entries.delete(key);entries.set(key,v);return v;},set(key,value){entries.delete(key);entries.set(key,value);while(entries.size>limit)entries.delete(entries.keys().next().value);},get size(){return entries.size;}};
}
const bands=createLRU(24);
export function cachedScenarioBand(input) {
 const key=simulationKey(input),cached=bands.get(key);if(cached)return cached;
 const result=runScenarioBand(input);bands.set(key,result);return result;
}
