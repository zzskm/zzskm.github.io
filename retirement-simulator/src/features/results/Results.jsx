import { analyzeRisk } from "../../insights/analyzer.js";
import React from "react";
import { SCENARIO_COLORS } from "../../model/defaults.js";
import { INSIGHT_MC_RUNS, insightMetric } from "../../insights/recommendations.js";
import { fmt만원, fmt만원월 } from "../../utils/formatting.js";

function getVerdict(result) {
  if (!result.depletionAge) {
    const margin = result.assetBucketsAtEnd?.totalFinancial ?? 0;
    if (margin > 50000) return { icon: "\u{1F389}", text: "잔존 자산 여유 큼",     tone: "emerald", weight: "strong" };
    if (margin > 10000) return { icon: "✓",    text: "안정적으로 유지 가능",  tone: "emerald", weight: "ok" };
    return                       { icon: "✓",    text: "겨우 유지",            tone: "amber",   weight: "tight" };
  }
  const shortage = result.simEndAge - result.depletionAge;
  if (shortage > 15) return     { icon: "⚠⚠", text: `${result.depletionAge}세 큰 폭 부족`, tone: "red",   weight: "critical" };
  if (shortage > 5)  return     { icon: "⚠",       text: `${result.depletionAge}세 자산 고갈`,  tone: "red",   weight: "warn"     };
  return                          { icon: "⚠",       text: `${result.depletionAge}세 막바지 부족`, tone: "amber", weight: "marginal" };
}

function diagnoseRootCause(input, result) { return result.depletionAge === null ? null : analyzeRisk(input,result).cause; }

function mcVerdict(rate) {
  if (rate >= 95) return { icon: "\u{1F389}", text: "매우 안정", tone: "emerald" };
  if (rate >= 90) return { icon: "✓",  text: "안정적", tone: "emerald" };
  if (rate >= 75) return { icon: "⚠",  text: "경계",   tone: "amber" };
  return               { icon: "⚠⚠", text: "위험",   tone: "red" };
}

function ResultBanner({ input, result, npMonthly, mc, onApplyLife90 }) {
  if (!mc) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500" role="status">
        성공확률 계산 중…
      </div>
    );
  }
  const v = mcVerdict(mc.successRate);
  const det = getVerdict(result);
  const cause = diagnoseRootCause(input, result);
  const toneMap = {
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-700",
    amber:   "bg-amber-50 border-amber-200 text-amber-700",
    red:     "bg-red-50 border-red-200 text-red-700",
  };
  const toneClass = toneMap[v.tone] || toneMap.amber;
  const parts = toneClass.split(" ");
  const vol = (input.returnVolatility ?? 12).toFixed(0);
  return (
    <div className={`rounded-xl border p-4 ${parts[0]} ${parts[1]}`}>
      <div className="flex items-baseline gap-3 flex-wrap">
        <div className="text-3xl font-bold num">{mc.successRate}%</div>
        <div className={`text-sm font-semibold ${parts[2]}`}>{v.icon} 성공확률 — {v.text}</div>
      </div>
      <div className="mt-1 text-sm text-slate-700">
        이 모델의 표본에서 수명({result.simEndAge}세)까지 금융자산이 유지된 비율입니다. 실제 미래의 보장 확률은 아닙니다. 시장 수익률이 매년 ±{vol}%p 안팎으로 출렁인다고 보고 {mc.runs.toLocaleString()}회 모의했습니다.
      </div>
      <div className="mt-1 text-xs text-slate-600">
        {mc.medianDepletionAge != null && <>실패한 경우 중앙 고갈 시점 <b>{mc.medianDepletionAge}세</b> · </>}
        수익률이 고정이라면(중간 시나리오): {det.text} · 준비율 {result.readinessRatio}%
      </div>
      <div className="mt-0.5 text-xs text-slate-600 num">
        최종 금융자산 분포{(mc.p10Final < 0 || mc.p50Final < 0) ? "(음수 = 부족액)" : ""} — 하위10% {fmt만원(mc.p10Final)} · 중앙 {fmt만원(mc.p50Final)} · 상위10% {fmt만원(mc.p90Final)} · 본인 국민연금 {fmt만원월(npMonthly)}
      </div>
      {cause && (
        <div className="mt-2 text-xs text-slate-700 border-t border-slate-200 pt-2">
          <span className="font-medium">주된 원인:</span> {cause}
        </div>
      )}
      {input.selfLifeExpectancy < 88 && (
        <div className="mt-2 text-xs text-slate-700 border-t border-slate-200 pt-2 flex items-center gap-2 flex-wrap">
          <span>계획 수명 {input.selfLifeExpectancy}세는 평균 기대수명 수준이라, 평균 이상 오래 사는 경우(장수 위험)는 반영되지 않습니다.</span>
          <button type="button" onClick={onApplyLife90}
            className="px-2 py-0.5 rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 whitespace-nowrap">90세로 확인</button>
        </div>
      )}
    </div>
  );
}

function ActionSuggestions({ insights, onExplore, scenarioCount }) {
  if (!insights || insights.items.length === 0) return null;
  const relax = insights.mode === "relax";
  const weak = insights.mode === "improve-weak";
  const box = relax ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50";
  const titleCls = relax ? "text-emerald-900" : "text-amber-900";
  const arrowCls = relax ? "text-emerald-500" : "text-amber-500";
  const btnCls = relax ? "border-emerald-300 text-emerald-700 hover:bg-emerald-100" : "border-amber-300 text-amber-700 hover:bg-amber-100";
  return (
    <div className={`rounded-xl border p-4 ${box}`}>
      <div className={`text-sm font-semibold mb-2 ${titleCls}`}>
        {relax ? "여유가 있어요 — 이런 선택도 가능합니다" : weak ? "한 가지로는 부족해요 — 그래도 효과가 큰 순서입니다" : "이런 조정이 도움이 됩니다"}
      </div>
      <ul className="space-y-2">
        {insights.items.map(ins => (
          <li key={ins.key} className="flex items-start gap-2">
            <span className={`${arrowCls} mt-0.5 shrink-0`}>{"→"}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-800">{ins.label}</div>
              <div className="text-xs text-slate-600">
                {ins.why} · 실행 부담 {ins.burden}/10 (상대 비교) · <b className="num">{insightMetric(ins, insights.mode)}</b>
              </div>
            </div>
            {scenarioCount < SCENARIO_COLORS.length && (
              <button type="button" onClick={() => onExplore(ins)}
                className={`text-xs px-2 py-1 rounded border shrink-0 ${btnCls}`}>
                비교 시나리오 만들기
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-slate-500 mt-2">
        {weak
          ? "단독 효과가 작아서 소진 시점(수익률 고정 기준)으로 비교했습니다. 여러 조정을 함께 적용해 보세요."
          : `조정안별 성공확률은 같은 시장 시나리오 ${INSIGHT_MC_RUNS}회로 비교한 값이라 위 성공확률과 ±몇 %p 차이가 날 수 있습니다.`}
      </p>
    </div>
  );
}

function ExploreCard({ scenario, result, isActive, onActivate }) {
  const v = getVerdict(result);
  const toneMap = {
    emerald: "bg-emerald-50",
    amber:   "bg-amber-50",
    red:     "bg-red-50",
  };
  const toneBg = toneMap[v.tone] || toneMap.amber;
  const toneText = { emerald: "text-emerald-700", amber: "text-amber-700", red: "text-red-700" }[v.tone] || "text-amber-700";

  return (
    <button onClick={onActivate}
      className={`text-left rounded-xl p-3 transition-all min-w-[140px] shrink-0 ${toneBg}
        ${isActive ? "shadow-sm ring-2" : "border border-slate-200 hover:border-slate-400 ring-0"}`}
      style={isActive ? { borderColor: scenario.color, "--tw-ring-color": scenario.color, borderWidth: "2px" } : undefined}>
      <div className="text-[11px] text-slate-500 mb-1 truncate">{scenario.name}</div>
      <div className={`text-sm font-bold ${toneText}`}>{v.icon} {v.text}</div>
      <div className="text-[11px] text-slate-500 mt-1 num">
        준비율 {result.readinessRatio}%
        {result.depletionAge && ` · 소진 ${result.depletionAge}세`}
      </div>
    </button>
  );
}


export { getVerdict, diagnoseRootCause, mcVerdict, ResultBanner, ActionSuggestions, ExploreCard };
