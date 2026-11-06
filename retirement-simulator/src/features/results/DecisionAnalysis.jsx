import React from 'react';
import { analyzeRisk } from '../../insights/analyzer.js';
import { fmt만원 } from '../../utils/formatting.js';
export function DecisionAnalysis({input,result,targets,onCompare,canCompare}) {
 const risk=analyzeRisk(input,result);
 const target=targets?.readinessInvestmentTarget;
 const extraMortgage=result.yearlyAssetFlow.reduce((sum,y)=>sum+(y.mortgageExtraMonthly??0)*12,0);
 const autoMoves=result.downsizeEvents?.filter(e=>e.label?.includes("자동"))??[];
 const mortgagePaidOff=input.housingMode==="own"&&input.hasMortgage
  ? result.yearlyAssetFlow.find(y=>y.age>=input.retireAge&&y.mortgage===0)?.age??null : null;
 const items=targets?[
  ['퇴직 연령 탐색',targets.earliest===null?'75세까지 탐색한 퇴직 연령에서 유지 조건을 찾지 못함':`검토 후보 ${targets.earliest}세`,targets.patches.retirement],
  ['지금 추가할 금융자산',targets.additionalAssets===null?'탐색한 범위에서 필요 자산 후보를 찾지 못함':`현재가치 저축성 자산 ${fmt만원(targets.additionalAssets)} 추가`,targets.patches.assets],
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
  {target&&<div className="rounded-lg border border-blue-200 bg-blue-50 p-3" role="status">
    <h3 className="text-sm font-semibold">퇴직 {input.retireAge}세 · 준비율 100% 목표</h3>
    <p className="text-sm mt-1">{target.additionalAtRetirement===null
      ? "탐색 한도(추가 100억원) 안에서 목표를 달성하지 못했습니다."
      : target.additionalAtRetirement===0
        ? `현재 추정 퇴직 금융자산 ${fmt만원(target.targetAtRetirement)}으로 100% 기준을 충족합니다.`
        : `퇴직 시 예상 금융자산 ${fmt만원(result.totalAssetsAtRetirement)}에 추가 투자자산 ${fmt만원(target.additionalAtRetirement)}이 필요합니다. 목표 총 금융자산은 ${fmt만원(target.targetAtRetirement)}입니다.`}
    </p>
    <p className="text-[11px] text-slate-600 mt-1">퇴직 시점의 현재가치 기준 일시 추가 보유액입니다. 지금 투자할 금액이나 매월 적립액이 아닙니다. 고정 수익률 모델의 준비율 100% 기준이며 실제 성공확률 100%를 의미하지 않습니다.</p>
  </div>}
  <div className="rounded-lg bg-slate-50 p-3 text-xs space-y-1">
    <b>은퇴 연착륙 점검</b>
    <p>대출: {input.housingMode!=="own"||!input.hasMortgage?"주택대출 없음":`퇴직 후 ${{scheduled:"정기 상환",surplus:"잉여현금 우선 상환",buffered:"2년 지출 예비자금 보유 후 적극 상환"}[input.mortgagePriority??"surplus"]} · 예상 완납 ${mortgagePaidOff??"계획 기간 내 없음"}${mortgagePaidOff===null?"":"세"} · 추가 원금 상환 연도별 합산 약 ${fmt만원(extraMortgage)}`}</p>
    <p>주거: {input.allowAutoHousingConversion===true
      ? `금융자산 부족 시 자동 전환 허용${autoMoves.length?` (시뮬레이션 ${autoMoves.length}회)`:""}`
      : "자동 주택 처분 없음 (직접 설정한 다운사이징만 허용)"}</p>
    <p>모델 한계: 연 단위 대출 원리금·고정 금리, 중도상환수수료 미반영. 연금계좌 출금 가능 연령과 인출세율은 금융자산 버킷에서 별도로 구분하지 않습니다. 국민연금·의료비·자녀 비용은 단순 추정입니다.</p>
  </div>
  {targets?<div className="grid sm:grid-cols-2 gap-2">{items.map(([title,text,patch])=><div key={title} className="border rounded-lg p-3 text-xs"><b>{title}</b><p className="my-1">{text}</p>{patch&&Object.keys(patch).some(k=>patch[k]!==input[k])&&canCompare&&<button type="button" className="text-blue-700 underline" onClick={()=>onCompare({label:title,patch})}>비교 시나리오 만들기</button>}</div>)}</div>:<p className="text-xs" role="status">조정 범위를 계산 중입니다…</p>}
  <p className="text-[11px] text-slate-500">탐색 결과는 고정 수익률·현재 생활 수준을 기준으로 한 후보입니다. 최솟값·최댓값이나 성공을 보장하지 않습니다. 저축 목표는 근로기 생활비를 줄여 저축하는 경우이며 월 투자 적립액(자산 배분)과 다릅니다. 주거 전략은 아래 조정안과 고급 다운사이징 설정에서 비교하세요.</p>
 </section>;
}
