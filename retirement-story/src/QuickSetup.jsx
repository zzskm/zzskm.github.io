import React,{useState} from 'react';
import {CURRENT_YEAR} from '../../retirement-simulator/src/model/assumptions.js';
import {PERSONAS,createPersonaInput} from './personas.js';
import {PersonaAvatar} from './PersonaAvatar.jsx';
import {setupDraft,applyDraft,validateDraft,withChildCount,previewMonthlyOutflows} from './quickSetup.js';

function NumberField({label,value,onChange,min=0,max=1000000,step=1,unit='만원',hint}) {
 return <label className="setup-field">
  <span className="field-label">{label}</span>
  <span className="field-control">
    <input type="number" inputMode="decimal" min={min} max={max} step={step}
      aria-label={label} value={value} onChange={e=>onChange(e.target.value===''?'':Number(e.target.value))}/>
    <span>{unit}</span>
  </span>
  {hint&&<small>{hint}</small>}
 </label>;
}
export function QuickSetup({input,initialPersonaId,initialName,onApply,onCancel}) {
 const [personaId,setPersonaId]=useState(initialPersonaId);
 const [base,setBase]=useState(input);
 const [draft,setDraft]=useState(()=>setupDraft(input));
 const [nickname,setNickname]=useState(initialName||'나');
 const [expanded,setExpanded]=useState(false);
 const [error,setError]=useState('');
 const [presetTouched,setPresetTouched]=useState(false);
 const budget=previewMonthlyOutflows(draft,base);
 const update=(key,value)=>{setDraft(prev=>({...prev,[key]:value}));setError('');};
 const choosePersona=id=>{
  const next=createPersonaInput(id);
  setPersonaId(id);setBase(next);setDraft(setupDraft(next));setExpanded(false);
  setError('');setPresetTouched(true);
 };
 const submit=e=>{
  e.preventDefault();
  const invalid=validateDraft(draft);
  if(invalid){setError(invalid);return;}
  try{onApply(applyDraft(base,draft),personaId,nickname.trim().slice(0,20)||'나');}
  catch(err){setError(err.message||'설정값을 확인하세요.');}
 };
 return <section className="setup-panel" aria-label="내 캐릭터 만들기">
  <div className="setup-title">
   <div><p className="eyebrow">CREATE YOUR CHARACTER</p><h2>어떤 삶을 살아갈까?</h2>
    <p>가구 구성으로 출발점을 고르고, 실제 숫자만 바꾸면 된다.</p>
   </div>
   <button type="button" className="setup-close" onClick={onCancel} aria-label="간편 설정 닫기">닫기 ×</button>
  </div>
  <div className="persona-grid" role="group" aria-label="가구 페르소나 선택">
    {PERSONAS.map(p=><button type="button" key={p.id} className={`persona-card ${personaId===p.id?'selected':''}`}
      onClick={()=>choosePersona(p.id)} aria-pressed={personaId===p.id}>
      <PersonaAvatar id={p.id} age={draft.currentAge} size="small"/>
      <span className="persona-name">{p.title}</span>
      <small>{p.short}</small>
    </button>)}
  </div>
  <p className="preset-notice">5개 프리셋은 가구 구성별 <b>비교용 예시</b>다. 2026년 복지 기준 중위소득 100%를 세후 가구소득에 대응시킨 값이며, 실제 세후 중위임금이나 평균 지출을 의미하지 않는다.
   {presetTouched&&<span> 선택한 예시로 <b>아래 입력 초안만 초기화</b>했다. 기존 계획은 '스토리 시작' 전까지 변경하지 않는다.</span>}
  </p>
  <form onSubmit={submit} noValidate>
   <div className="setup-fields-head"><h3>나의 기본 정보</h3><span>단위: 세, 만원</span></div>
   <div className="setup-fields">
    <label className="setup-field">
     <span className="field-label">캐릭터 이름</span>
     <span className="field-control"><input type="text" aria-label="내 캐릭터 이름" maxLength={20} value={nickname} onChange={e=>setNickname(e.target.value)} placeholder="예: 미래의 나"/></span>
    </label>
    <NumberField label="현재 나이" value={draft.currentAge} onChange={v=>update('currentAge',v)} min={25} max={70} unit="세"/>
    <NumberField label="목표 은퇴 나이" value={draft.retireAge} onChange={v=>update('retireAge',v)} min={26} max={75} unit="세"/>
    <NumberField label="본인 세후 월급" value={draft.selfMonthly} onChange={v=>update('selfMonthly',v)} min={0} max={2500}/>
    {draft.spouseEnabled&&<NumberField label="배우자 세후 월급" value={draft.spouseMonthly} onChange={v=>update('spouseMonthly',v)} min={0} max={2500}/>}
    <NumberField label="월 기본 생활비" value={draft.workingLivingCost} onChange={v=>update('workingLivingCost',v)} min={0} max={3000}
       hint="자녀 양육비·관리비·대출 상환은 모델에서 별도로 계산한다."/>
    <NumberField label="예금·현금성 자산" value={draft.savingsBalance} onChange={v=>update('savingsBalance',v)} min={0}/>
    <NumberField label="투자·퇴직연금 자산" value={draft.investmentBalance} onChange={v=>update('investmentBalance',v)} min={0}/>
   </div>
   <div className="setup-preview" aria-label="예상 월 기본지출">
     <div><strong>예상 월 기본지출</strong><b>{budget.total.toLocaleString('ko-KR')}만원</b></div>
     <p>기본생활비 {budget.living.toLocaleString('ko-KR')} + 자동 양육비 {budget.children.toLocaleString('ko-KR')} + 관리비·대출·월세 {budget.housing.toLocaleString('ko-KR')}만원</p>
     <small>건강보험료·추가 의료비·세금·적립식 투자액은 이 합계에 포함되지 않는다. 이미 생활비에 포함된 자녀비·주거비는 중복 계산하지 않도록 입력액을 조정해야 한다.</small>
   </div>
   <button type="button" className="details-toggle" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>
    <span>주거·가족·은퇴 후 생활비 자세히 설정</span><span aria-hidden="true">{expanded?'−':'+'}</span>
   </button>
   {expanded&&<div className="details-area">
    <div className="setup-fields">
     <label className="setup-field">
      <span className="field-label">주거 형태</span>
      <span className="field-control">
       <select aria-label="주거 형태" value={draft.housingMode} onChange={e=>update('housingMode',e.target.value)}>
        <option value="own">자가</option><option value="jeonse">전세</option><option value="monthly_rent">월세</option>
       </select>
      </span>
     </label>
     <NumberField label="월 관리비" value={draft.housingMaintenance} onChange={v=>update('housingMaintenance',v)} min={0} max={500}/>
     {draft.housingMode==='own'&&<>
      <NumberField label="주택대출 잔액" value={draft.mortgageBalance} onChange={v=>update('mortgageBalance',v)} min={0}/>
      {Number(draft.mortgageBalance)>0&&
       <NumberField label="매월 대출 원리금" value={draft.monthlyMortgagePayment} onChange={v=>update('monthlyMortgagePayment',v)} min={0} max={3000}/>}
     </>}
     {draft.housingMode!=='own'&&<NumberField label="주택 보증금" value={draft.deposit} onChange={v=>update('deposit',v)} min={0}/>}
     {draft.housingMode==='monthly_rent'&&<NumberField label="매월 월세" value={draft.monthlyRent} onChange={v=>update('monthlyRent',v)} min={0} max={1000}/>}
     <NumberField label="연금 수령 전 월 생활비" value={draft.bridgeLivingCost} onChange={v=>update('bridgeLivingCost',v)} min={0} max={3000}/>
     <NumberField label="연금 수령 후 월 생활비" value={draft.retirementLivingCost} onChange={v=>update('retirementLivingCost',v)} min={0} max={3000}/>
     <label className="setup-field field-choice">
      <span className="field-label">배우자 포함</span>
      <span className="field-control"><input type="checkbox" aria-label="배우자 포함" checked={draft.spouseEnabled} onChange={e=>update('spouseEnabled',e.target.checked)}/><span>포함</span></span>
     </label>
     {draft.spouseEnabled&&<>
      <NumberField label="배우자 현재 나이" value={draft.spouseCurrentAge} onChange={v=>update('spouseCurrentAge',v)} min={20} max={80} unit="세"/>
      <NumberField label="배우자 목표 은퇴 나이" value={draft.spouseRetireAge} onChange={v=>update('spouseRetireAge',v)} min={21} max={75} unit="세"/>
     </>}
     <label className="setup-field">
      <span className="field-label">자녀 수</span>
      <span className="field-control">
       <select aria-label="자녀 수" value={draft.childYears.length} onChange={e=>update('childYears',withChildCount(draft.childYears,e.target.value))}>
        {[0,1,2,3,4,5].map(n=><option key={n} value={n}>{n}명</option>)}
       </select>
      </span>
     </label>
     {draft.childYears.map((year,i)=>
      <NumberField key={i} label={`자녀 ${i+1} 출생연도`} value={year} min={1900} max={CURRENT_YEAR} unit="년"
       onChange={v=>update('childYears',draft.childYears.map((y,j)=>i===j?v:y))}/>)}
    </div>
    <p className="details-footnote">출생연도와 자녀 수는 자동 양육비 및 진학·독립 이벤트에 영향을 준다. 연금액·세율·금리 등의 정밀 설정은 기존 은퇴 시뮬레이터에서 조정한다.</p>
   </div>}
   {error&&<p className="setup-error" role="alert">{error}</p>}
   <div className="setup-actions"><button type="submit" className="setup-submit">이 설정으로 스토리 시작 →</button>
    <button type="button" onClick={onCancel} className="setup-cancel">취소</button></div>
  </form>
 </section>;
}
