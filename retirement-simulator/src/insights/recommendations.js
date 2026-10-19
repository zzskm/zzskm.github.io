import { ASSUMPTIONS } from '../model/assumptions.js';
import { calculateScenario } from '../model/cashflow.js';
import { runMonteCarlo } from '../model/monteCarlo.js';
import { normalizeInput } from '../state/migration.js';
import { buildCandidates } from './candidates.js';
export const INSIGHT_MC_RUNS=500;
const final=r=>r.yearlyAssetFlow.at(-1)?.financialAssets??0;
export function findInsights(input,baseSuccessRate) {
 const mode=baseSuccessRate>=90?'relax':'improve';
 const base=runMonteCarlo(input,ASSUMPTIONS,{runs:INSIGHT_MC_RUNS});
 const baseDet=calculateScenario(input);
 const detCandidates=buildCandidates(input,mode).map(c=>{
  const patched=normalizeInput({...input,...c.patch}),det=calculateScenario(patched);
  return {...c,det,score:(det.readinessRatio-baseDet.readinessRatio)*10000+Math.max(-1000000,Math.min(1000000,final(det)-final(baseDet)))-c.burden*100};
 });
 // Shortlist across adjustment types so expensive MC work stays bounded.
 const groups=new Map();
 for(const c of detCandidates)if(!groups.has(c.group)||c.score>groups.get(c.group).score)groups.set(c.group,c);
 let finalists=[...groups.values()].sort((a,b)=>b.score-a.score).slice(0,6);
 if(mode==='improve'&&finalists.length>=2){
  const [a,b]=finalists;
  const patch={...a.patch,...b.patch};
  finalists.push({key:`${a.key}+${b.key}`,label:`${a.label} + ${b.label}`,why:'두 조정을 함께 적용한 결과입니다.',patch,burden:a.burden+b.burden,group:'combined',det:calculateScenario(normalizeInput({...input,...patch}))});
 }
 const results=finalists.map(c=>{
  const mc=runMonteCarlo(normalizeInput({...input,...c.patch}),ASSUMPTIONS,{runs:INSIGHT_MC_RUNS});
  const p=base.successRate/100,q=mc.successRate/100;
  const uncertainty=Math.max(2,Math.ceil(1.96*Math.sqrt((p*(1-p)+q*(1-q))/INSIGHT_MC_RUNS)*100));
  return {key:c.key,label:c.label,why:c.why,patch:c.patch,burden:c.burden,group:c.group,
   delta:mc.successRate-base.successRate,newRate:mc.successRate,baseRate:base.successRate,uncertainty,
   meaningful:Math.abs(mc.successRate-base.successRate)>uncertainty,
   depletionFrom:baseDet.depletionAge,depletionTo:c.det.depletionAge,readinessDelta:c.det.readinessRatio-baseDet.readinessRatio,
   shortfallDelta:Math.max(0,-final(baseDet))-Math.max(0,-final(c.det)),
   bridgeReduction:baseDet.bridgeShortfall-c.det.bridgeShortfall,
   worstCashflowChange:Math.min(...c.det.yearlyAssetFlow.map(y=>y.cashflowMonthly))-Math.min(...baseDet.yearlyAssetFlow.map(y=>y.cashflowMonthly)),
  };
 });
 if(mode==='relax')return {mode,items:results.filter(c=>c.newRate>=85).sort((a,b)=>b.newRate-a.newRate),tested:detCandidates.length};
 const improved=results.filter(r=>r.delta>r.uncertainty).sort((a,b)=>b.delta-a.delta||a.burden-b.burden).slice(0,4);
 if(improved.length)return {mode,items:improved,tested:detCandidates.length};
 return {mode:'improve-weak',items:results.filter(r=>r.readinessDelta>=1||r.shortfallDelta>0).sort((a,b)=>b.readinessDelta-a.readinessDelta||b.shortfallDelta-a.shortfallDelta).slice(0,4),tested:detCandidates.length};
}
export function insightMetric(ins,mode) {
 if(mode==='relax')return `동일 표본에서 성공 비율 ${ins.newRate}%`;
 if(ins.meaningful&&ins.delta>0)return `성공 비율 +${ins.delta}%p → ${ins.newRate}%`;
 if(ins.depletionFrom!=null&&(ins.depletionTo==null||ins.depletionTo>ins.depletionFrom))return ins.depletionTo==null?`소진 ${ins.depletionFrom}세 → 계획 수명까지 유지`:`소진 ${ins.depletionFrom}세 → ${ins.depletionTo}세`;
 return ins.shortfallDelta>0?`계획 종료 부족액 약 ${Math.round(ins.shortfallDelta).toLocaleString()}만원 감소`:`준비율 +${ins.readinessDelta}%p · 확률 차이는 표본 오차 범위일 수 있음`;
}
