import React, { useMemo, useState, useEffect } from 'react';
import { UI_RANGES } from '../../model/defaults.js';
import { CURRENT_YEAR } from '../../model/assumptions.js';
import { estimatedPensionMonthlyFor } from '../../model/pension.js';
import { calculateScenario } from '../../model/cashflow.js';
import { NumericField, SalaryInput, FieldContext } from '../../components/NumericField.jsx';
import { Toggle } from '../../components/Section.jsx';
import { useModalBehavior } from '../../components/Modal.jsx';
import { readWizardDraft, saveWizardDraft, removeWizardDraft, wizardErrors, applyWizardDraft } from '../../state/wizardDraft.js';
import { fmt만원 } from '../../utils/formatting.js';
const WIZARD_STEPS=['나의 은퇴 목표','가구 상황','소득과 연금','자산과 부채','결과 확인'];
export function SetupWizard({ initial, scenarioId, onComplete, onClose }) {
 const [saved]=useState(()=>readWizardDraft(scenarioId));
 const [step,setStep]=useState(saved?.step??0);
 const [draft,setDraft]=useState(saved?.input??initial);
 const [changed,setChanged]=useState(saved?.changed??[]);
 const [excluded,setExcluded]=useState([]);
 const [createComparison,setCreateComparison]=useState(false);
 const [saveError,setSaveError]=useState(false);
 const [invalidDrafts,setInvalidDrafts]=useState({});
 const closeRef=useModalBehavior(onClose);
 useEffect(()=>{setSaveError(!saveWizardDraft(scenarioId,{step,input:draft,changed}));},[scenarioId,step,draft,changed]);
 const set=k=>v=>{setDraft(prev=>({...prev,[k]:v}));setChanged(prev=>prev.includes(k)?prev:[...prev,k]);};
 const errors=wizardErrors(draft,step);
 const blocked=Object.keys(errors).length>0||Object.values(invalidDrafts).some(Boolean);
 const input=applyWizardDraft(initial,draft,changed.filter(k=>!excluded.includes(k)));
 const result=useMemo(()=>calculateScenario(input),[draft,excluded,initial]);
 const num=(k,label,hint)=><NumericField key={k} fieldKey={k} label={label} value={draft[k]} {...UI_RANGES[k]} onChange={set(k)} hint={hint} slider={false}/>;
 const housing=<label className="text-sm block mb-3">주거 형태<select value={draft.housingMode} onChange={e=>set('housingMode')(e.target.value)} className="border rounded ml-3 p-2"><option value="own">자가</option><option value="jeonse">전세</option><option value="monthly_rent">월세</option></select></label>;
 const allErrors=[0,1,2,3].flatMap(n=>Object.values(wizardErrors(input,n)));
 const finish=()=>{if(allErrors.length)return;onComplete({input,createComparison});removeWizardDraft(scenarioId);};
 const fieldNames={currentAge:'현재 나이',retireAge:'희망 퇴직 나이',bridgeLivingCost:'브릿지 생활비',retirementLivingCost:'은퇴 생활비',selfCurrentSalary:'본인 소득',spouseCurrentSalary:'배우자 소득',selfNpInputMode:'연금 입력 방식',selfNpManualMonthly:'예상 국민연금',housingMode:'주거 형태',savingsBalance:'저축성 자산',investmentBalance:'투자성 자산',housePrice:'주택 시세',mortgageBalance:'대출 잔액',monthlyMortgagePayment:'월 원리금',deposit:'보증금',monthlyRent:'월세',spouseEnabled:'배우자 여부',spouseCurrentAge:'배우자 나이',spouseRetireAge:'배우자 퇴직 나이',children:'자녀',postRetireSideIncome:'퇴직 후 부수입'};
 return <FieldContext.Provider value={{input:draft,errors,onValidityChange:(k,invalid)=>setInvalidDrafts(prev=>({...prev,[k]:invalid}))}}>
  <div className="wizard-overlay" onClick={onClose}><div className="wizard-card" role="dialog" aria-modal="true" aria-labelledby="wizard-title" onClick={e=>e.stopPropagation()}>
   <div className="flex justify-between items-center"><h2 id="wizard-title" className="font-semibold text-lg">은퇴 계획 만들기</h2><button type="button" ref={closeRef} onClick={onClose} aria-label="빠른 설정 닫기">✕</button></div>
   <p className="text-xs text-slate-500 mb-2">{step+1}/5 · {WIZARD_STEPS[step]}{saved?' · 저장된 초안에서 재개':''}</p>
   <progress value={step+1} max="5" className="w-full mb-3" aria-label="설정 진행"/>
   {saveError&&<p role="alert" className="text-red-700 text-xs">초안을 저장하지 못했습니다. 이 창을 닫으면 입력을 잃을 수 있습니다.</p>}
   {step===0&&<><p className="text-sm mb-4">언제 퇴직하고 어느 정도로 생활할지 정합니다. 주거·의료·자녀 비용은 별도로 계산합니다.</p>{num('currentAge','현재 나이')}{num('retireAge','희망 퇴직 나이')}{num('bridgeLivingCost','퇴직 후 연금 전 월 생활비')}{num('retirementLivingCost','연금 수령 후 월 생활비','65세·75세 이후 기본 지출 감소 가정을 적용합니다.')}</>}
   {step===1&&<><p className="text-sm mb-4">함께 생활하는 가족과 주거 형태에 맞춰 필요한 항목만 입력합니다.</p><Toggle label="배우자 있음" value={draft.spouseEnabled} onChange={set('spouseEnabled')}/>{draft.spouseEnabled&&<>{num('spouseCurrentAge','배우자 현재 나이')}{num('spouseRetireAge','배우자 퇴직 나이')}</>}{housing}<label className="block text-sm">자녀 수<select className="border rounded p-2 ml-3" value={draft.children.length} onChange={e=>set('children')(Array.from({length:Number(e.target.value)},(_,n)=>draft.children[n]??{id:`wizard-child-${n}`,birthYear:CURRENT_YEAR}))}>{[0,1,2,3,4,5].map(n=><option key={n}>{n}</option>)}</select></label>{draft.children.map((c,n)=><NumericField key={c.id} label={`자녀 ${n+1} 출생 연도`} value={c.birthYear} min={1900} max={CURRENT_YEAR} integer slider={false} onChange={v=>set('children')(draft.children.map((child,idx)=>idx===n?{...child,birthYear:v}:child))}/>)}</>}
   {step===2&&<><p className="text-sm mb-4">연금공단 예상액을 알고 있다면 직접 입력하세요. 모르면 현재 소득·가입연수로 추정할 수 있습니다.</p><SalaryInput name="본인 소득" netAnnual={draft.selfCurrentSalary} basis={draft.selfSalaryBasis} onChangeNet={set('selfCurrentSalary')} onChangeBasis={set('selfSalaryBasis')}/>{draft.spouseEnabled&&<SalaryInput name="배우자 소득" netAnnual={draft.spouseCurrentSalary} basis={draft.spouseSalaryBasis} onChangeNet={set('spouseCurrentSalary')} onChangeBasis={set('spouseSalaryBasis')}/>}<label className="text-sm block my-3">국민연금 예상액<select className="border rounded p-2 ml-2" value={draft.selfNpInputMode} onChange={e=>set('selfNpInputMode')(e.target.value)}><option value="manual">직접 입력</option><option value="auto">기본 가정으로 추정</option></select></label>{draft.selfNpInputMode==='manual'?num('selfNpManualMonthly','본인 예상 국민연금 (월)'): <p className="text-xs mb-3">자동 추정 월 약 {Math.round(estimatedPensionMonthlyFor(draft,'self'))}만원 · 소득·가입연수·개시 나이 가정 적용</p>}{num('postRetireSideIncome','브릿지 기간 월 부수입','본인 퇴직 후 국민연금 개시 전 기간에만 반영합니다.')}</>}
   {step===3&&<><p className="text-sm mb-4">오늘 기준 잔액을 입력합니다. DC/IRP는 투자성 자산에 한 번만 포함해주세요.</p>{num('savingsBalance','저축성 자산')}{num('investmentBalance','투자성 자산 (DC/IRP 포함)')}{draft.housingMode==='own'?<>{num('housePrice','주택 시세')}<Toggle label="주택 대출 있음" value={draft.hasMortgage} onChange={set('hasMortgage')}/>{draft.hasMortgage&&<>{num('mortgageBalance','대출 잔액')}{num('monthlyMortgagePayment','월 원리금')}</>}</>:<>{num('deposit','보증금')}{draft.housingMode==='monthly_rent'&&num('monthlyRent','월세')}</>}</>}
   {step===4&&<><p className="text-sm mb-3">반영할 변경 항목을 선택하세요. 선택하지 않은 항목은 기존 설정을 유지합니다.</p><ul className="text-xs space-y-2 mb-4">{changed.map(k=><li key={k}><label className="flex items-center gap-2"><input type="checkbox" checked={!excluded.includes(k)} onChange={e=>setExcluded(prev=>e.target.checked?prev.filter(x=>x!==k):[...prev,k])}/>{fieldNames[k]??k}: {Array.isArray(draft[k])?`${draft[k].length}명`:typeof draft[k]==='boolean'?(draft[k]?'있음':'없음'):String(draft[k])}</label></li>)}</ul><div className="bg-slate-50 rounded p-3 text-sm space-y-2"><p>{input.currentAge}세 → 퇴직 {input.retireAge}세 · 계획 종료 {result.simEndAge}세</p><p>금융자산 {fmt만원(input.savingsBalance+input.investmentBalance)} · 은퇴 생활비 월 {input.retirementLivingCost}만원</p><p>고정 수익률 초기 분석: {result.depletionAge?`${result.depletionAge}세 자산 소진`:'계획 수명까지 자산 유지'}</p><p>연금 전 {result.bridgeYears}년 · 누적 자산 인출 {fmt만원(result.bridgeShortfall)}</p><p className="text-xs text-slate-500">수익률·물가·의료비·연금 자동 추정 등 입력하지 않은 가정은 기존 설정을 사용합니다. 성공확률은 완료 후 계산합니다.</p></div><label className="text-sm flex gap-2 items-center mt-3"><input type="checkbox" checked={createComparison} onChange={e=>setCreateComparison(e.target.checked)}/>퇴직을 2년 늦춘 비교 시나리오도 만들기</label>{allErrors.map(msg=><p key={msg} role="alert" className="text-xs text-red-700">{msg}</p>)}</>}
   {step<4&&<p className="text-xs text-slate-500 border-t pt-2 mt-3" aria-live="polite">현재 계획: {draft.retireAge}세 퇴직 · 금융 {fmt만원(draft.savingsBalance+draft.investmentBalance)} · 은퇴 생활비 월 {draft.retirementLivingCost}만원</p>}
   <div className="flex justify-between items-center gap-2 mt-4"><button type="button" disabled={step===0} onClick={()=>setStep(n=>n-1)} className="border rounded px-3 py-2 disabled:opacity-30">이전</button>{step>0&&step<4&&<button type="button" disabled={blocked} className="text-xs underline disabled:opacity-30" onClick={()=>setStep(n=>n+1)}>현재 값·추정값 사용</button>}{step<4?<button type="button" disabled={blocked} onClick={()=>setStep(n=>n+1)} className="bg-slate-900 text-white rounded px-4 py-2 disabled:opacity-30">다음</button>:<button type="button" disabled={allErrors.length>0} onClick={finish} className="bg-slate-900 text-white rounded px-4 py-2 disabled:opacity-30">계획에 반영</button>}</div>
  </div></div>
 </FieldContext.Provider>;
}
