import {CURRENT_YEAR} from '../../retirement-simulator/src/model/assumptions.js';
import {KR_DEFAULTS} from '../../retirement-simulator/src/model/defaults.js';
import {normalizeInput} from '../../retirement-simulator/src/state/migration.js';
import {calculateScenario} from '../../retirement-simulator/src/model/cashflow.js';
import {retirementReadinessInvestmentTarget} from '../../retirement-simulator/src/insights/targets.js';

const PRIORITY={depletion:100,retire:95,pension:90,mortgage:85,child:75,housing:70,medical:60,start:50};
const EVENT_TONES={depletion:'danger',retire:'amber',pension:'mint',mortgage:'mint',child:'blue',housing:'amber',medical:'blue',start:'blue'};
const heading=(row,input)=>{
 if(row.age===input.currentAge)return '지금, 당신의 노후를 그려본다';
 if(row.age===input.retireAge)return '월급이 멈추는 해';
 if(row.phase==='bridge')return '연금이 시작되기 전까지';
 if(row.phase==='pension')return '연금과 함께 살아가는 시간';
 if(row.phase==='work')return '은퇴 자금을 준비하는 시간';
 return '계획의 다음 장';
};
const findPrior=(rows,index)=>index>0?rows[index-1]:null;
const round=n=>Math.round(Number(n)||0);
export function monthlyFlow(row) {
 const income=round(row.selfSalaryMonthly)+round(row.spouseSalaryMonthly)+round(row.selfPensionMonthly)
 +round(row.spousePensionMonthly)+round(row.basicPensionMonthly)+round(row.bridgeSideMonthly);
 const spending=round(row.livingMonthly)+round(row.childMonthly)+round(row.mortgageMonthly)
 +round(row.healthInsMonthly)+round(row.medicalMonthly)+round(row.maintMonthlyOut)+round(row.rentMonthlyOut);
 return {income,spending,balance:income-spending};
}
export function extractEvents(input,result) {
 const rows=result.yearlyAssetFlow??[];
 if(!rows.length)return [];
 const min=rows[0].age,max=rows.at(-1).age;
 const events=[];
 function add(age,type,title,detail) {
  if(age<min||age>max||!Number.isFinite(age))return;
  events.push({id:`${type}-${age}-${events.length}`,age,year:CURRENT_YEAR+age-input.currentAge,type,title,detail,priority:PRIORITY[type]??0,tone:EVENT_TONES[type]??'blue'});
 }
 add(input.currentAge,'start','지금부터의 기록','현재 입력값에서 출발한 계산 경로입니다.');
 add(input.retireAge,'retire',`${input.retireAge}세, 은퇴`,'본인의 근로소득이 종료되는 시점입니다. 배우자 근로소득은 별도 설정에 따라 계속될 수 있습니다.');
 add(input.selfPensionStartAge,'pension','본인 국민연금 개시','설정한 개시 연령부터 모델의 예상 연금액을 반영합니다.');
 if(input.spouseEnabled) {
  const spousePensionAge=input.currentAge+(input.spousePensionStartAge-input.spouseCurrentAge);
  add(spousePensionAge,'pension','배우자 국민연금 개시','배우자의 나이와 설정한 연금 개시 연령을 반영한 시점입니다.');
 }
 for(const item of result.childEventList??[]) {
  add(item.age,'child',item.label,item.label.includes('대학')
   ?'자녀가 대학 진학 연령에 도달합니다. 실제 진학 여부나 비용은 개인마다 다릅니다.'
   :'자녀가 모델에서 독립으로 가정하는 연령에 도달합니다. 실제 독립 여부는 확정할 수 없습니다.');
 }
 if(input.housingMode==='own'&&input.hasMortgage&&input.mortgageBalance>0) {
  const payoff=rows.find((r,i)=>r.mortgage<=0&&(i===0?input.mortgageBalance>0:rows[i-1].mortgage>0));
  if(payoff) add(payoff.age,'mortgage','주택대출 상환 완료','모델 기준으로 주택대출 잔액이 0이 되는 해입니다.');
 }
 for(const item of result.downsizeEvents??[]) add(item.age,'housing',item.label,'시뮬레이션의 주거 이전·다운사이징 가정이 반영되었습니다.');
 if(result.depletionAge!==null&&result.depletionAge!==undefined)
  add(result.depletionAge,'depletion','금융자산 고갈 위험','고정 수익률 가정에서 장기적으로 회복하지 못하는 금융자산 고갈 구간입니다. 주택 순자산과는 다릅니다.');
 if(max>=75&&min<=75) add(75,'medical','75세 이후의 지출 구조','모델에서 기본 생활비 감소와 노년 의료비 증가를 가정하는 시점입니다.');
 return events.sort((a,b)=>a.age-b.age||b.priority-a.priority);
}
export function buildFrames(input,result) {
 const events=extractEvents(input,result);
 const groups=new Map();
 for(const event of events){const list=groups.get(event.age)??[];list.push(event);groups.set(event.age,list);}
 return result.yearlyAssetFlow.map((row,index,rows)=>{
  const prior=findPrior(rows,index),flow=monthlyFlow(row),yearEvents=groups.get(row.age)??[];
  const leading=yearEvents[0];
  let text;
  if(leading?.type==='depletion') text='예상 금융자산이 소진되는 구간입니다. 이 결과는 시장 변동을 배제한 고정 수익률 시나리오이며, 실제 미래가 확정된 것은 아닙니다.';
  else if(leading?.type==='retire') text=`본인의 급여가 사라진 뒤에도 생활비와 주거비는 계속됩니다. 이 해의 월수입은 약 ${flow.income.toLocaleString('ko-KR')}만 원, 기본 월지출은 약 ${flow.spending.toLocaleString('ko-KR')}만 원입니다.`;
  else if(leading?.type==='pension') text=`예상 공적연금이 월수입에 반영됩니다. 현재가치 기준 월수입은 약 ${flow.income.toLocaleString('ko-KR')}만 원입니다.`;
  else if(leading?.type==='mortgage') text='대출 잔액이 0에 도달합니다. 앞으로의 재무 부담은 감소하지만, 생활비·의료비 등 다른 지출은 남습니다.';
  else if(leading?.type==='child') text='가구의 생애주기 변화가 발생하는 시점입니다. 자녀 비용은 실제 지출 내역이 아니라 연령별 가정에 따라 계산됩니다.';
  else if(leading?.type==='housing') text='입력한 주거 계획 또는 허용한 자동 전환 가정에 따라 자산 구성이 달라집니다.';
  else if(leading?.type==='medical') text='모델의 노년 생활비·의료비 가정이 변화합니다. 질병 발생 자체를 예측하는 것은 아닙니다.';
  else if(index===0) text='연령·가구·소득·금융자산을 바탕으로 한 장기 시뮬레이션입니다. 화면의 모든 금액은 현재가치로 환산한 모델 추정치입니다.';
  else if(row.financialAssets<(prior?.financialAssets??0)) text='금융자산이 전년보다 감소한 해입니다. 생활비와 주거비에 필요한 인출, 투자 성과 등을 함께 살펴볼 시점입니다.';
  else text='금융자산이 전년보다 유지되거나 증가한 해입니다. 현재 가정이 이어진다고 전제한 결과입니다.';
  return {
   ...row,index,flow,events:yearEvents,
   heading:leading?.title??heading(row,input),description:text,
   chapter:row.age<input.retireAge?'준비기':row.age<input.selfPensionStartAge?'브릿지':'연금기',
   tone:leading?.tone??(row.phase==='bridge'?'amber':'blue'),
   change:prior?row.financialAssets-prior.financialAssets:null,
  };
 });
}
export function computeStory(input=KR_DEFAULTS) {
 const normalized=normalizeInput(input);
 const result=calculateScenario(normalized);
 return {input:normalized,result,frames:buildFrames(normalized,result),events:extractEvents(normalized,result),
  investmentTarget:retirementReadinessInvestmentTarget(normalized,result)};
}
export function choiceInput(input,kind) {
 if(kind==='delay')return normalizeInput({...input,retireAge:Math.min(input.retireAge+2,input.selfLifeExpectancy-1,75)});
 if(kind==='spend')return normalizeInput({...input,
  bridgeLivingCost:Math.max(0,input.bridgeLivingCost-30),
  retirementLivingCost:Math.max(0,input.retirementLivingCost-30)});
 if(kind==='debt'&&input.hasMortgage&&input.housingMode==='own')return normalizeInput({...input,mortgagePriority:'buffered'});
 return normalizeInput(input);
}
export function nextEventAge(events,current,forward=true) {
 const options=forward?events.filter(e=>e.age>current):events.filter(e=>e.age<current);
 return options.length?(forward?options[0].age:options.at(-1).age):null;
}
