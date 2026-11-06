import React, { useState } from 'react';
import { HOUSEHOLD_PRESETS } from './householdPresets.js';

const fmt=n=>Math.round(n).toLocaleString('ko-KR');

export function HouseholdPresetPicker({onAdd,onReplace,canAdd}) {
 const [selected,setSelected]=useState('two-children');
 const [replaceArmed,setReplaceArmed]=useState(false);
 const preset=HOUSEHOLD_PRESETS.find(p=>p.id===selected);
 const choose=id=>{setSelected(id);setReplaceArmed(false);};
 return <section className="rounded-lg border border-slate-200 bg-slate-50 p-3 mb-4 space-y-2" aria-label="중위소득 기준 가구 프리셋">
   <div className="text-sm font-semibold text-slate-900">가구 구성 프리셋</div>
   <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="가구 구성 선택">
     {HOUSEHOLD_PRESETS.map(p=><button type="button" key={p.id} aria-pressed={p.id===selected} onClick={()=>choose(p.id)}
       className={`border rounded-md px-2 py-1.5 text-xs text-left ${p.id===selected?'border-slate-800 bg-slate-900 text-white':'border-slate-200 bg-white text-slate-700 hover:border-slate-400'}`}>{p.label}</button>)}
   </div>
   <div className="rounded-md bg-white border border-slate-200 p-2 text-xs text-slate-700 space-y-1">
     <p><b>{preset.size}인 가구</b> · 2026년 기준 중위소득 100% <b>월 {(preset.medianMonthlyWon/10000).toFixed(1)}만원</b></p>
     <p>{preset.description} · 주거·자산·생활비는 비교용 가정</p>
     <p className="text-slate-500">복지제도 기준 중위소득을 세후 가구소득에 대응시킨 예시입니다. 실제 세후 중위임금·가구별 평균 지출을 뜻하지 않습니다.</p>
   </div>
   <div className="flex flex-wrap gap-2">
    <button type="button" disabled={!canAdd} onClick={()=>{onAdd(preset.id);setReplaceArmed(false);}}
      className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-xs disabled:opacity-40">새 시나리오 추가</button>
    <button type="button" onClick={()=>replaceArmed?(onReplace(preset.id),setReplaceArmed(false)):setReplaceArmed(true)}
      className={`rounded-md px-2.5 py-1.5 text-xs border ${replaceArmed?'bg-red-50 text-red-700 border-red-300':'bg-white text-slate-600 border-slate-300'}`}>
      {replaceArmed?'현재 계획 덮어쓰기 확인':'현재 계획에 적용'}
    </button>
    {replaceArmed&&<button type="button" onClick={()=>setReplaceArmed(false)} className="text-xs text-slate-500 underline">취소</button>}
   </div>
   {!canAdd&&<p className="text-[11px] text-amber-700">시나리오 최대 4개. 새로 추가하려면 기존 시나리오를 정리하세요.</p>}
   <p className="text-[11px] text-slate-500">프리셋은 출발점입니다. 생계급여 자격·연금 예상액·실제 가구 재무상황을 판정하지 않습니다. <a className="underline" target="_blank" rel="noopener noreferrer" href="https://www.mohw.go.kr/menu.es?mid=a10708010300">중위소득 출처: 보건복지부</a></p>
 </section>;
}
