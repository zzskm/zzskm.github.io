import React, { useEffect, useRef } from "react";
import { ASSUMPTIONS } from "../model/assumptions.js";

function useModalBehavior(onClose) {
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    const opener = document.activeElement;
    const previousOverflow=document.body.style.overflow; document.body.style.overflow="hidden";
    // 입력칸의 Esc(편집 취소)는 preventDefault 되어 있으므로 모달을 닫지 않는다
    const onKey = (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) onCloseRef.current();
      if (e.key === "Tab") {
        const dialog=closeRef.current?.closest('[role="dialog"]');
        const elements=Array.from(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], summary, [tabindex="0"]')??[]).filter(el=>el.getClientRects().length>0);
        const first=elements[0],last=elements.at(-1);
        if(e.shiftKey&&(document.activeElement===first||!dialog?.contains(document.activeElement))){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&(document.activeElement===last||!dialog?.contains(document.activeElement))){e.preventDefault();first?.focus();}
      }
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow=previousOverflow;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
  }, []);
  return closeRef;
}

function AssumptionsModal({ onClose }) {
  const a = ASSUMPTIONS;
  const p = a.krPolicy;
  const lc = a.lifeCycle;
  const ar = a.assetRules;
  const hi = p.healthInsurance;
  const closeRef = useModalBehavior(onClose);

  const Row = ({ label, value, note }) => (
    <tr className="border-b border-slate-100 align-top">
      <td className="py-1.5 pr-3 text-xs text-slate-600">{label}</td>
      <td className="py-1.5 px-3 text-xs font-medium text-slate-900 num">{value}</td>
      <td className="py-1.5 pl-3 text-[11px] text-slate-500 leading-snug">{note}</td>
    </tr>
  );
  const H3 = ({ children }) => <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">{children}</h3>;

  return (
    <div className="wizard-overlay" onClick={onClose}>
      <div className="wizard-card max-w-lg" role="dialog" aria-modal="true" aria-labelledby="assumptions-title" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 id="assumptions-title" className="text-base font-semibold">모델 가정 ({a.version})</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">시뮬레이션에 사용된 상수와 기준값입니다. 모두 단순화된 추정이며 실제 제도와 다를 수 있습니다.</p>
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="모델 가정 닫기" className="text-slate-500 hover:text-slate-700 text-xl leading-none ml-4 w-8 h-8">×</button>
        </div>

        <div className="space-y-4">
          {/* 국민연금 */}
          <div>
            <H3>국민연금·기초연금 (2026 기준)</H3>
            <table className="w-full">
              <tbody>
                <Row label="소득대체율 (40년 가입)" value={`${Math.round(p.pensionReplacementRate * 100)}%`} note="2026.1 연금개혁 반영. 가입연수에 비례해 단순 적용하며, 현재 가입자의 전체 가입기간에 적용된다고 가정. 연금액 = 소득대체율 × (A값+B값)÷2 × 가입연수÷40." />
                <Row label="A값 (평균 월소득)" value={`${p.pensionAValueMonthly}만/월`} note="2026년 A값 3,193,511원. 오늘 가치 기준이라 매년 임금상승률로 인상된다고 보지 않음." />
                <Row label="기준소득월액 상·하한" value={`${p.npMaxBaseMonthly}만 / ${p.npMinBaseMonthly}만`} note="2026.7~2027.6 적용. 세전 월소득이 이 범위로 제한됩니다." />
                <Row label="조기/연기 수령" value="−6% · +7.2% /년" note="법정 개시연령 대비 조기 최대 −30%, 연기 최대 +36%. 시뮬레이션에 반영." />
                <Row label="최대 가입연수" value={`${p.maxNpYears}년`} note={`자동 계산 시 퇴직나이−${p.contributionStartAge}로 추정. 실제는 경력 단절·실업으로 더 짧을 수 있어 직접 조정하세요. 소득이 0이면 자동 추정 연금은 0.`} />
                <Row label="연금소득세" value={`${p.pensionTaxRate * 100}%`} note="노령연금 수령액에 적용(실효세율보다 높은 보수적 가정). 유족·기초연금은 비과세." />
                <Row label="유족연금" value={`사망자 NP × ${p.survivorPensionRatio * 100}%`} note="본인 노령연금과 중복 시 '본인+유족 30%' vs '유족 100%' 중 큰 쪽 선택. 개시 나이 무관." />
                <Row label="기초연금" value={`월 ${p.basicPension.monthlyFull}만 (부부 각 −${p.basicPension.coupleReductionRate * 100}%)`} note={`65세+ 소득인정액 단독 ${p.basicPension.incomeThresholdSingle}만/부부 ${p.basicPension.incomeThresholdCouple}만 이하 시 지급. 재산 환산 = [(주택·보증금 − ${p.basicPension.assetBasicDeduction.toLocaleString()}만) + (금융 − ${p.basicPension.financialDeduction.toLocaleString()}만) − 대출] × 4% ÷ 12. 국민연금이 기준액의 1.5배를 넘으면 절반으로 감액.`} />
              </tbody>
            </table>
          </div>
          {/* 생애주기 */}
          <div>
            <H3>생활비 생애주기</H3>
            <table className="w-full">
              <tbody>
                <Row label="지출 감소 (65~74세)" value="× 0.75" note="'연금 수령기 생활비' 입력값에 곱해집니다(입력 아래에 실제 적용액 표시). 의료비는 별도 항목." />
                <Row label="지출 감소 (75세 이상)" value="× 0.55" note="생애주기 가설 기반 단순화. 입력값 자체가 이미 낮다면 과소 추정이 될 수 있어 조정 가능." />
                <Row label="노년 의료비 기준 (1인)" value="50대 15만 → 65세 30만 → 75세 60만 → 85세 100만/월" note="본인부담·비급여·간병 포함 단순화. 배율 슬라이더로 조정." />
                <Row label="의료물가 초과 상승" value={`+${lc.medicalInflationRealPremium}%p/년`} note="의료물가가 일반물가보다 매년 1.5%p 더 빠르게 상승하는 가정." />
              </tbody>
            </table>
          </div>
          {/* 자산 규칙 */}
          <div>
            <H3>자산·세제·건강보험</H3>
            <table className="w-full">
              <tbody>
                <Row label="세후 소득 환산" value="2026 근로소득세 + 4대보험" note={`근로소득공제 구간표·세액공제 반영, 근로자 4대보험 약 9.7%(국민연금 ${a.taxModel.socialInsurance.np * 100}%·건보 ${a.taxModel.socialInsurance.hi * 100}%·장기요양·고용 0.9%). 본인 1인 기준이며 부양가족·연말정산 공제는 제외한 보수적 추정.`} />
                <Row label="DC 연간 적립" value="세전 연봉 ÷ 12" note="매년 세전 월급만큼 DC 자동 적립 (투자성 자산 버킷). 회사 매칭·수수료 미반영." />
                <Row label="퇴직금 세율" value="6.6%" note="퇴직 시점 세전 월급 × 근속연수 기준. 분리과세 단순 적용, 저축성 버킷에 입금." />
                <Row label="주택대출" value="명목 금리·고정 원리금" note="입력 금리로 이자가 붙고 월 원리금은 명목 고정이라, 물가가 오르면 실질 부담은 줄어듭니다." />
                <Row label="건강보험료 추정" value="지역가입자 단순 근사" note={`퇴직 후 (소득+연금소득×${hi.pensionIncomeRatio * 100}%)×${(hi.rate * 100).toFixed(2)}% + 재산(시세×${hi.propertyAssessRatio} → 1억 공제 후 점수×${hi.pointValue}원), 장기요양 +${(hi.ltcRate * 100).toFixed(2)}%. 배우자가 근로 중이고 소득 ${hi.dependentIncomeLimit.toLocaleString()}만·재산 ${(hi.dependentPropertyLimit / 10000).toFixed(1)}억 이하면 피부양자(0원). 재산 점수는 공식 표의 근사치입니다.`} />
                <Row label="준비율 최대 표시" value={`${ar.readinessMaxRatio}%`} note="수명까지 자산이 남을 경우 최대 300%로 캡핑." />
              </tbody>
            </table>
          </div>
          {/* 시퀀스 리스크 */}
          <div>
            <H3>시퀀스 리스크 · 몬테카를로</H3>
            <table className="w-full">
              <tbody>
                <Row label="몬테카를로" value={`${a.monteCarlo.runs.toLocaleString()}회 · 로그정규`} note="입력 수익률을 연복리(중앙값)로 보고 매년 수익률을 무작위 추출(표준편차=변동성, 고정 시드, 투자성 자산만). 그래서 '중간 시나리오'가 몬테카를로의 중앙 경로와 같습니다. 성공확률 = 수명까지 자산이 유지된 비율." />
                <Row label="경미 (Mild)" value="−5%p, 3년" note="퇴직 직후 3년간 수익률 -5%p. 2001년 닷컴 버블 수준." />
                <Row label="중간 (Severe)" value="−10%p, 5년" note="퇴직 직후 5년간 수익률 -10%p. 2008년 금융위기 장기 침체 수준." />
                <Row label="2008 스타일" value="−30% → +10% 2년" note="첫해 -30%p 폭락, 이후 2년 +10%p 반등, 이후 정상. 최악의 순서 리스크." />
              </tbody>
            </table>
          </div>
          {/* 한계 */}
          <div>
            <H3>모델이 반영하지 않는 것</H3>
            <ul className="text-[11px] text-slate-600 leading-relaxed list-disc pl-4 space-y-0.5">
              <li>잉여 현금은 전액 저축된다고 가정합니다(낙관적). 차량 교체·여행·경조사·부모 부양 같은 비정기 지출은 생활비에 포함해 입력해 주세요.</li>
              <li>퇴직 직후 1~2년은 전년도 소득 기준으로 건보료가 부과되어 추정보다 높을 수 있습니다(임의계속가입 등으로 완화 가능).</li>
              <li>연금 수령 중 근로소득에 따른 국민연금 감액, 주택연금, 자녀 결혼·독립 자금, 상속·증여는 반영하지 않습니다.</li>
              <li>세금은 본인 1인 근로소득 기준 추정이며 금융소득종합과세·양도세·재산세는 반영하지 않습니다.</li>
            </ul>
          </div>
        </div>

        <div className="mt-5 flex justify-between items-center">
          <a href="https://www.nps.or.kr" target="_blank" rel="noopener" className="text-[11px] text-slate-500 hover:text-slate-700 underline">국민연금공단 →</a>
          <button onClick={onClose} aria-label="모델 가정 닫기" className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700">닫기</button>
        </div>
      </div>
    </div>
  );
}


export { useModalBehavior, AssumptionsModal };
