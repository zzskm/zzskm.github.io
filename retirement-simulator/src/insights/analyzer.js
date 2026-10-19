// Diagnoses describe modeled cashflows, not proven financial causality.
export function analyzeRisk(input, result) {
 const retired=result.yearlyAssetFlow.filter(y=>y.age>=input.retireAge);
 const deficits=retired.filter(y=>y.cashflowMonthly<0);
 const sums={living:0,housing:0,medical:0,children:0};
 for(const y of retired){sums.living+=y.livingMonthly??0;sums.housing+=(y.mortgageMonthly??0)+(y.maintMonthlyOut??0)+(y.rentMonthlyOut??0);sums.medical+=(y.medicalMonthly??0)+(y.healthInsMonthly??0);sums.children+=y.childMonthly??0;}
 const labels={living:'생활비',housing:'주거비·대출',medical:'의료비·건강보험',children:'자녀 비용'};
 const largest=Object.keys(sums).sort((a,b)=>sums[b]-sums[a])[0];
 const worst=deficits.reduce((min,y)=>!min||y.cashflowMonthly<min.cashflowMonthly?y:min,null);
 const bridgeDominates=result.bridgeYears>0&&result.bridgeShortfall>Math.max(0,result.totalAssetsAtRetirement)*0.3;
 return {
  title: result.depletionAge?`고정 수익률 가정에서는 ${result.depletionAge}세부터 금융자산이 부족합니다.`:`고정 수익률 가정에서는 ${result.simEndAge}세까지 금융자산이 유지됩니다.`,
  cause:bridgeDominates?`${input.retireAge}세 퇴직 후 ${input.selfPensionStartAge}세 국민연금 개시 전 기간의 자산 인출 부담이 큽니다.`:`퇴직 이후 현금흐름에서 가장 큰 지출 항목은 ${labels[largest]}입니다.`,
  range:deficits.length?`${deficits[0].age}~${deficits.at(-1).age}세 (연도별 적자 발생 구간의 처음과 끝)`:'고정 수익률 기준 월 현금흐름 적자 없음',
  worstAge:worst?.age??null,worstMonthly:worst?Math.max(0,-worst.cashflowMonthly):0,
  bridgeShortfall:result.bridgeShortfall,
  finalShortfall:Math.max(0,-(result.yearlyAssetFlow.at(-1)?.financialAssets??0)),
  spending:sums,
 };
}
