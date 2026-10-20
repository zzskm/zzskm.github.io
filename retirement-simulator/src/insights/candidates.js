import { normalizeInput } from '../state/migration.js';
export function buildCandidates(input, mode='improve') {
 const out=[];
 const add=(key,label,why,patch,burden,group)=>{
  const applied=normalizeInput({...input,...patch});
  const exact=Object.fromEntries(Object.keys(patch).filter(k=>applied[k]!==input[k]).map(k=>[k,applied[k]]));
  if(Object.keys(exact).length)out.push({key,label,why,patch:exact,burden,group});
 };
 if(mode==='relax'){
  for(const n of [1,2,3])if(input.retireAge-n>input.currentAge)add(`earlier${n}`,`퇴직 ${n}년 앞당기기`,'근로 기간을 줄였을 때의 변화를 확인합니다.',{retireAge:input.retireAge-n},n,'retirement');
  for(const p of [.05,.1,.15]){
   const n=Math.max(1,Math.round(input.retirementLivingCost*p));
   if(input.retirementLivingCost+n<=3000)add(`spend${n}`,`노후 월 생활비 ${n}만원 늘리기`,'더 여유로운 생활비의 영향을 비교합니다.',{retirementLivingCost:input.retirementLivingCost+n},1,'spending');
  }
  return out;
 }
 if(input.selfCurrentSalary>0)for(const n of [1,2,3,5])if(input.retireAge+n<=Math.min(75,input.selfLifeExpectancy-1))add(`later${n}`,`퇴직 ${n}년 늦추기`,'근로 소득 기간을 늘리고 자산 인출을 늦춥니다.',{retireAge:input.retireAge+n},n,'retirement');
 for(const p of [.05,.1,.15,.2]){
  const b=Math.max(50,Math.round(input.bridgeLivingCost*(1-p))),r=Math.max(50,Math.round(input.retirementLivingCost*(1-p)));
  if(b<=input.bridgeLivingCost&&r<=input.retirementLivingCost)add(`cut${p}`,`퇴직 후 생활비 약 ${Math.round(p*100)}% 줄이기`,'브릿지·연금 수령기 생활비를 함께 줄입니다.',{bridgeLivingCost:b,retirementLivingCost:r},Math.ceil(p*20),'spending');
 }
 if(input.retireAge<input.selfPensionStartAge)for(const n of [25,50,100])if(input.postRetireSideIncome+n<=2000)add(`side${n}`,`브릿지 월 부수입 ${n}만원 추가`,'국민연금 개시 전 본인 부수입을 확보합니다.',{postRetireSideIncome:input.postRetireSideIncome+n},Math.ceil(n/25),'bridge');
 if(input.currentAge<input.retireAge&&input.selfCurrentSalary>0)for(const p of [.05,.1,.15]){
  const n=Math.min(input.workingLivingCost-50,Math.max(1,Math.round(input.workingLivingCost*p)));
  if(n>0)add(`save${n}`,`근로기 월 ${n}만원 지출 줄여 저축`,'남는 소득은 기존 모델에 따라 저축성 자산에 누적됩니다.',{workingLivingCost:input.workingLivingCost-n},Math.ceil(p*20),'saving');
 }
 if(input.spouseEnabled&&input.spouseCurrentSalary>0)for(const n of [1,2,3])if(input.spouseRetireAge+n<=Math.min(75,input.spouseLifeExpectancy-1))add(`spouse${n}`,`배우자 퇴직 ${n}년 늦추기`,'가구 근로 소득 기간을 늘립니다.',{spouseRetireAge:input.spouseRetireAge+n},n,'spouse');
 if(input.housingMode==='own'&&input.housePrice>0)for(const ratio of [.8,.6,.4]){
  if(input.downsizeEnabled&&ratio>=input.downsizeRatio)continue;
  const age=Math.max(input.currentAge,input.retireAge);
  if(age<input.selfLifeExpectancy)add(`house${ratio}`,`${age}세에 주택 가치 ${Math.round(ratio*100)}%로 축소`,'주택 차액의 금융자산 전환과 주거비를 함께 반영합니다.',{downsizeEnabled:true,downsizeAge:age,downsizeRatio:ratio},Math.ceil((1-ratio)*5),'housing');
 }
 return out;
}
