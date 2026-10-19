import React from 'react';
import { analyzeRisk } from '../../insights/analyzer.js';
import { fmt만원 } from '../../utils/formatting.js';
export function DecisionAnalysis({input,result,targets,onCompare,canCompare}) {
 const risk=analyzeRisk(input,result);
 const items=targets?[
  ['퇴직 연령 탐색',targets.earliest===null?'75세까지 탐색한 퇴직 연령에서 유지 조건을 찾지 못함':`검토 후보 ${targets.earliest}세`,targets.patches.retirement],
  ['추가 금융자산',targets.additionalAssets===null?'탐색한 범위에서 필요 자산 후보를 찾지 못함':`추가 저축성 자산 ${fmt만원(targets.additionalAssets)}`,targets.patches.assets],
  ['월 저축 목표',targets.monthlySaving===null?'현재 생활비 조정 범위에서 후보를 찾지 못함':`근로기 지출 월 ${targets.monthlySaving}만원 절감·저축`,targets.patches.saving],
  ['노후 지출 여력',targets.spending===null?'탐색한 생활비에서 유지 조건을 찾지 못함':`탐색한 후보 중 월 ${targets.spending}만원까지 유지`,targets.patches.spending],
  ['장수 위험',targets.longevity.depletionAge?`${targets.longevity.endAge}세 계획 시 ${targets.longevity.depletionAge}세 소진`:`${targets.longevity.endAge}세 계획에서도 유지`,targets.longevity.patch],
  ['퇴직 초기 시장 충격',targets.shock.depletionAge?`중간 충격 가정에서 ${targets.shock.depletionAge}세 소진`:'중간 충격 가정에서도 유지',targets.shock.patch],
 ]:[];
 return <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-3" aria-label="위험 원인과 조정 범위">
  <h2 className="text-sm font-semibold">계획 진단 → 원인 → 조정 범위</h2>
  <p className="text-sm">{risk.title}</p><p className="text-sm">{risk.cause}</p>
  <p className="text-xs text-slate-600">{risk.range}{risk.worstAge!==null?` · 최대 월 부족 ${risk.worstMonthly.toLocaleString()}만원 (${risk.worstAge}세)`:''}</p>
  <p className="text-xs">연금 전 누적 자산 인출 {fmt만원(risk.bridgeShortfall)} · 계획 종료 부족액 {fmt만원(risk.finalShortfall)}</p>
  {targets?<div className="grid sm:grid-cols-2 gap-2">{items.map(([title,text,patch])=><div key={title} className="border rounded-lg p-3 text-xs"><b>{title}</b><p className="my-1">{text}</p>{patch&&Object.keys(patch).some(k=>patch[k]!==input[k])&&canCompare&&<button type="button" className="text-blue-700 underline" onClick={()=>onCompare({label:title,patch})}>비교 시나리오 만들기</button>}</div>)}</div>:<p className="text-xs" role="status">조정 범위를 계산 중입니다…</p>}
  <p className="text-[11px] text-slate-500">탐색 결과는 고정 수익률·현재 생활 수준을 기준으로 한 후보입니다. 최솟값·최댓값이나 성공을 보장하지 않습니다. 저축 목표는 근로기 생활비를 줄여 저축하는 경우이며 월 투자 적립액(자산 배분)과 다릅니다. 주거 전략은 아래 조정안과 고급 다운사이징 설정에서 비교하세요.</p>
 </section>;
}
