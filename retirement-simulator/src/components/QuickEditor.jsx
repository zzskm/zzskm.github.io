import React from 'react';
import { NumericField } from './NumericField.jsx';
import { Toggle } from './Section.jsx';
import { UI_RANGES } from '../model/defaults.js';
import { CURRENT_YEAR } from '../model/assumptions.js';
import { monthlyNetFromAnnual, annualNetFromMonthly, resizeChildren, quickBudgetBreakdown } from './quickEntry.js';

const SectionTitle=({children})=><h3 className="text-xs font-semibold text-slate-800 mt-4 mb-2 pb-1 border-b border-slate-100">{children}</h3>;
const QuickNumber=({label,field,input,onChange,...props})=><NumericField
 label={label} fieldKey={field} value={input[field]} onChange={onChange(field)}
 {...(UI_RANGES[field]??{})} slider={false} {...props} />;

export function QuickEditor({input,onChange,onPatch,onDetailed}) {
 const cost=quickBudgetBreakdown(input);
 const monthlyIncome=(key,label)=><NumericField label={label} fieldKey={key}
   value={monthlyNetFromAnnual(input[key])} onChange={n=>onChange(key)(annualNetFromMonthly(n))}
   min={0} max={3000} typedMax={10000} step={1} unit="만/월" slider={false}
   hint="통장에 실제 들어오는 세후 금액. 세전 연봉은 전체 입력에서 설정." />;
 return <div className="space-y-1" aria-label="핵심 입력">
   <div className="rounded-md bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
     <b className="text-slate-800">핵심 항목만 수정</b>
     <p className="mt-1">세후 월급·생활비·금융자산·대출을 입력하면 기존 계산 가정을 사용합니다. 연금·세금·시장 수익률 등은 전체 입력에서 조정할 수 있습니다.</p>
   </div>
   <SectionTitle>은퇴 시점과 가족</SectionTitle>
   <QuickNumber label="현재 나이" field="currentAge" input={input} onChange={onChange} />
   <QuickNumber label="퇴직 나이" field="retireAge" input={input} onChange={onChange}
     min={input.currentAge+1} max={Math.min(75,input.selfLifeExpectancy-1)} />
   <Toggle label="배우자 포함" value={input.spouseEnabled} onChange={onChange('spouseEnabled')}/>
   <label className="flex items-center justify-between gap-2 mb-3 text-xs text-slate-700">
     자녀 수
     <select aria-label="자녀 수" value={input.children.length} onChange={e=>onChange('children')(resizeChildren(input.children,e.target.value))}
       className="border rounded-md px-3 py-2 bg-white">
       {[0,1,2,3,4,5].map(n=><option value={n} key={n}>{n}명</option>)}
     </select>
   </label>
   {input.children.map((child,n)=><NumericField key={child.id} label={'자녀 '+(n+1)+' 출생연도'}
     value={child.birthYear} min={1900} max={CURRENT_YEAR} integer={true} slider={false} unit="년"
     onChange={year=>onChange('children')(input.children.map((c,j)=>j===n?{...c,birthYear:year}:c))}/>)}
   {input.children.some(c=>c.birthYear===CURRENT_YEAR)&&
     <p className="mb-3 text-[11px] text-amber-700">추가된 자녀의 출생연도는 올해로 시작합니다. 실제 출생연도를 수정하세요.</p>}

   <SectionTitle>세후 소득</SectionTitle>
   {monthlyIncome('selfCurrentSalary','본인 세후 월급')}
   {input.spouseEnabled&&monthlyIncome('spouseCurrentSalary','배우자 세후 월급')}

   <SectionTitle>생활비 (오늘의 돈)</SectionTitle>
   <QuickNumber label="근로기 월 생활비" field="workingLivingCost" input={input} onChange={onChange}
     hint="대출·관리비·자녀비를 제외하고 입력하세요. 식료품과 교육비를 중복 입력하지 않도록 확인하세요." />
   <QuickNumber label="퇴직 후 연금 전 월 생활비" field="bridgeLivingCost" input={input} onChange={onChange} />
   <button type="button" onClick={()=>onChange('bridgeLivingCost')(input.workingLivingCost)}
     className="text-xs text-blue-700 underline mb-3">근로기 생활비와 같게 설정</button>
   <QuickNumber label="연금 수령기 월 생활비" field="retirementLivingCost" input={input} onChange={onChange}/>
   <div className="rounded-md bg-blue-50 border border-blue-100 p-3 text-xs text-slate-700 space-y-1">
     <p className="font-semibold">현재 월 기본지출 구성 (모델 가정)</p>
     <div className="flex justify-between"><span>생활비</span><span>{cost.living.toLocaleString()}만원</span></div>
     <div className="flex justify-between"><span>자녀비 자동 추가</span><span>{Math.round(cost.children).toLocaleString()}만원</span></div>
     <div className="flex justify-between"><span>관리비·월세·정기 대출</span><span>{(cost.maintenance+cost.mortgage+cost.rent).toLocaleString()}만원</span></div>
     <div className="flex justify-between border-t border-blue-200 pt-1 font-semibold"><span>기본지출 합계</span><span>{Math.round(cost.total).toLocaleString()}만원/월</span></div>
     <p className="text-[11px] text-slate-600">자녀비는 실제 거래가 아닌 나이별 자동 추정액입니다. 건강보험·세금·노후 의료비 등은 추가 계산되며 이 합계에 포함되지 않습니다.</p>
   </div>

   <SectionTitle>금융자산</SectionTitle>
   <QuickNumber label="예금·현금성 자산" field="savingsBalance" input={input} onChange={onChange} unit="만원"
     hint="입출금·예금·MMF 등" />
   <QuickNumber label="투자·퇴직연금 자산" field="investmentBalance" input={input} onChange={onChange} unit="만원"
     hint="주식·ETF·DC·IRP 등을 한 번만 합산" />

   <SectionTitle>주거 및 대출</SectionTitle>
   <label className="flex items-center justify-between gap-2 mb-3 text-xs text-slate-700">
     주거 형태
     <select aria-label="주거 형태" value={input.housingMode} onChange={e=>onPatch({housingMode:e.target.value})}
       className="border rounded-md px-3 py-2 bg-white">
       <option value="own">자가</option><option value="jeonse">전세</option><option value="monthly_rent">월세</option>
     </select>
   </label>
   {input.housingMode==='own'?
     <>
       <QuickNumber label="주택 평가액" field="housePrice" input={input} onChange={onChange} unit="만원" />
       <Toggle label="주택담보대출 있음" value={input.hasMortgage} onChange={v=>onPatch({hasMortgage:v})}/>
       {input.hasMortgage&&<>
         <QuickNumber label="대출 잔액" field="mortgageBalance" input={input} onChange={onChange} unit="만원"/>
         <QuickNumber label="월 원리금 상환" field="monthlyMortgagePayment" input={input} onChange={onChange}
           hint="대출 잔액과 별도로 입력하는 매월 실제 납부액" />
         <QuickNumber label="대출 금리" field="mortgageRate" input={input} onChange={onChange}
           hint="현재 시뮬레이션 전체 기간에 적용되는 고정 명목 금리" />
       </>}
     </>:
     <>
       <QuickNumber label="보증금" field="deposit" input={input} onChange={onChange} unit="만원"/>
       {input.housingMode==='monthly_rent'&&
         <QuickNumber label="월세" field="monthlyRent" input={input} onChange={onChange}/>}
     </>}
   <QuickNumber label="월 관리비" field="housingMaintenance" input={input} onChange={onChange}/>

   <button type="button" onClick={onDetailed} className="mt-3 w-full rounded-md border border-slate-300 text-slate-800 px-3 py-2 text-sm hover:bg-slate-50">
     연금·시장·세금 등 상세 입력
   </button>
 </div>;
}
