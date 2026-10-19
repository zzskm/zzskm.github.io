import { calculateScenario } from '../model/cashflow.js';
import { runScenarioBand } from '../model/scenarios.js';
import { normalizeInput } from '../state/migration.js';
const holds=r=>r.depletionAge===null;
export function exploreTargets(input) {
 const calculate=patch=>calculateScenario(normalizeInput({...input,...patch}));
 const base=calculate({});
 // Discrete searches deliberately report ranges rather than a guaranteed optimum.
 const ages=Array.from({length:Math.max(0,76-Math.max(input.currentAge+1,25))},(_,n)=>Math.max(input.currentAge+1,25)+n).filter(n=>n<input.selfLifeExpectancy);
 const earliest=ages.find(age=>holds(calculate({retireAge:age})))??null;
 const assetSteps=[0,1000,2500,5000,10000,20000,40000,80000,160000,320000,640000].filter(n=>input.savingsBalance+n<=1000000);
 const additionalAssets=assetSteps.find(n=>holds(calculate({savingsBalance:input.savingsBalance+n})))??null;
 const maxSaving=Math.max(0,input.workingLivingCost-50);
 const savingSteps=[...new Set([0,10,25,50,75,100,150,200,300,Math.round(maxSaving)].filter(n=>n<=maxSaving))].sort((a,b)=>a-b);
 const monthlySaving=input.currentAge<input.retireAge?savingSteps.find(n=>holds(calculate({workingLivingCost:input.workingLivingCost-n})))??null:null;
 const costs=[...new Set([50,...Array.from({length:19},(_,n)=>Math.round(input.retirementLivingCost*(.1+(n*.1)))).filter(n=>n>=50&&n<=3000)])].sort((a,b)=>a-b);
 const spending=costs.filter(n=>holds(calculate({retirementLivingCost:n}))).at(-1)??null;
 const longevityPatch={selfLifeExpectancy:Math.min(105,input.selfLifeExpectancy+5),...(input.spouseEnabled?{spouseLifeExpectancy:Math.min(105,input.spouseLifeExpectancy+5)}:{})};
 const longevity=calculate(longevityPatch);
 const shockPatch={stressTest:'severe'};
 const shock=runScenarioBand(normalizeInput({...input,...shockPatch})).sequenceShock;
 return {earliest,additionalAssets,monthlySaving,spending,baseEndAge:base.simEndAge,
  longevity:{patch:longevityPatch,depletionAge:longevity.depletionAge,endAge:longevity.simEndAge,final:longevity.yearlyAssetFlow.at(-1)?.financialAssets??0},
  shock:{patch:shockPatch,depletionAge:shock.depletionAge,readinessRatio:shock.readinessRatio},
  patches:{retirement:earliest===null?null:{retireAge:earliest},assets:additionalAssets===null?null:{savingsBalance:input.savingsBalance+additionalAssets},saving:monthlySaving===null?null:{workingLivingCost:input.workingLivingCost-monthlySaving},spending:spending===null?null:{retirementLivingCost:spending}},
 };
}
