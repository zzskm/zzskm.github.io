import React from 'react';
import { DEFAULT_BENCHMARKS } from '../model/defaultBenchmarks.js';

export function DefaultReference() {
  const b = DEFAULT_BENCHMARKS;
  return <details className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 mb-3">
    <summary className="cursor-pointer font-medium">{b.title} · 출처와 예시 가정</summary>
    <div className="mt-2 space-y-2 leading-relaxed">
      <p>전국 전체 가구의 중위값을 참고합니다. 소득은 {b.incomeYear}년 세전 연 {b.householdGrossAnnualIncome.toLocaleString()}만원, 순자산은 2025년 3월 말 {b.householdNetWorth.toLocaleString()}만원입니다. 나이·가구원 수별 중위값이나 한 가구를 관측한 값은 아닙니다.</p>
      <p>계산용 예시: 본인·배우자 세전 연봉 3,600만·2,200만원, 주택 3억원, 저축 4,000만·투자 2,000만원, 대출 1억 2,000만원으로 순자산 약 2억 4,000만원을 구성했습니다. 가구 총소득을 근로소득으로 단순화했으며 각 개인·자산 항목의 중위값은 아닙니다.</p>
      <p>40세·배우자·자녀 1명, 60세 퇴직·90세 계획 수명, 월 생활비 200만→220만→200만원, 저축·원리금·수익률 등은 계획용 가정입니다. 생활비 외에 주거·자녀·의료비가 별도 계산됩니다. 조사 금액을 현재 연도까지 물가 보정하지 않았습니다.</p>
      <p>새 계획과 기본값 복원에 적용되며 저장된 설정은 유지됩니다. 내 소득·주거·가족 상황으로 바꿔주세요.</p>
      <p><a className="underline" href={b.sourceUrl} target="_blank" rel="noreferrer">국가데이터처·금융감독원·한국은행, {b.survey}</a> · <a className="underline" href={b.incomeTableUrl} target="_blank" rel="noreferrer">가구소득 중앙값 재수록 표 (18쪽)</a></p>
      <p>함께 참고한 <a className="underline" href={b.comparisonUrl} target="_blank" rel="noreferrer">{b.comparisonTitle}</a>는 2023년 만 20~64세 취업자 조사입니다. 주요 금액이 평균이므로 중위값으로 사용하지 않았습니다.</p>
    </div>
  </details>;
}
