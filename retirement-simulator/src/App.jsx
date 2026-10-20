import { cachedScenarioBand } from "./model/cache.js";
import { useAnalysis } from "./features/analysis/useAnalysis.js";
import { DecisionAnalysis } from "./features/results/DecisionAnalysis.jsx";
import { serializeBackup, parseBackup } from "./state/backup.js";
import { applyInputPatch } from "./state/inputUpdates.js";
import { SECTION_FIELDS } from "./state/sections.js";
import React, { useState, useMemo, useEffect } from "react";
import { ResponsiveContainer, ComposedChart, Area, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceArea, ReferenceLine, ReferenceDot } from "recharts";
import { ASSUMPTIONS, CURRENT_YEAR } from "./model/assumptions.js";
import { UI_RANGES, KR_DEFAULTS, SCENARIO_COLORS } from "./model/defaults.js";
import { autoPensionStartAge, pensionClaimFactor, autoNpYears, npYearsFor } from "./model/pension.js";
import { ageFactor } from "./model/cashflow.js";
import { STRESS_PRESETS } from "./model/scenarios.js";
import { validateInput } from "./model/validation.js";
import { insightMetric } from "./insights/recommendations.js";
import { EXPLORE_PRESETS } from "./features/comparison/presets.js";
import { fmt만원, fmt만원월 } from "./utils/formatting.js";
import { useDebugMode, useIsMobile } from "./components/hooks.js";
import { FieldContext, Slider, NumberInput, SalaryInput } from "./components/NumericField.jsx";
import { Toggle, Section, SummaryCard } from "./components/Section.jsx";
import { getVerdict, mcVerdict, ResultBanner, ActionSuggestions, ExploreCard } from "./features/results/Results.jsx";
import { AssumptionsModal } from "./components/Modal.jsx";
import { SetupWizard } from "./features/wizard/SetupWizard.jsx";
import { normalizeInput } from "./state/migration.js";
import { LS_KEY, uid, makeScenario, loadInitial, saveScenarios, ADV_KEY, VERSION_KEY, WIZARD_KEY, AUTO_NAME_RE, readFlag, writeFlag } from "./state/scenarioStore.js";
import { ScenarioNameEditor } from "./features/comparison/ScenarioNameEditor.jsx";

function App() {
  const [initial] = useState(() => loadInitial());
  const [storageBlocked, setStorageBlocked] = useState(initial.storageError);
  const [scenarios, setScenarios] = useState(initial.scenarios);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [advancedMode, setAdvancedMode] = useState(() => readFlag(ADV_KEY) === "1");
  const [showWizard, setShowWizard] = useState(() => initial.isNew);
  const [wizardSeen, setWizardSeen] = useState(() => readFlag(WIZARD_KEY) === "1");
  const [showSeqShock, setShowSeqShock] = useState(false);
  const [showAssumptions, setShowAssumptions] = useState(false); // C7
  const [activePresetId, setActivePresetId] = useState(null);
  const [resetArmed, setResetArmed] = useState(false);
  const debugMode = useDebugMode(); // C9
  const [mobileView, setMobileView] = useState("results"); // "results" | "inputs"
  const isMobile = useIsMobile(640);     // 차트 높이 등
  const isStacked = useIsMobile(1024);   // 입력/결과가 세로로 쌓이는 구간 → 탭 전환
  const [toast, setToast] = useState(() => {
    if (initial.warning) return initial.warning;
    if (initial.wasLegacyMigrated) return "v7 업데이트: 개인연금이 투자성 자산에 통합되었습니다. 자산 항목을 다시 확인해주세요.";
    if (!initial.isNew && readFlag(VERSION_KEY) !== ASSUMPTIONS.version)
      return "가정이 2026년 제도 기준으로 갱신되었습니다(국민연금 소득대체율 43%·기초연금·건강보험료·세후 소득 계산 등). 저장된 시나리오의 결과가 이전과 달라질 수 있어요. 자세한 내용은 'ⓘ 가정'에서 확인하세요.";
    return null;
  });

  useEffect(() => { writeFlag(VERSION_KEY, ASSUMPTIONS.version); }, []);
  useEffect(() => { writeFlag(ADV_KEY, advancedMode ? "1" : "0"); }, [advancedMode]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), Math.max(6000, toast.length * 130));
    return () => clearTimeout(t);
  }, [toast]);

  // 리셋 버튼: 첫 클릭은 확인 단계, 3초 안에 다시 누르면 실행
  useEffect(() => {
    if (!resetArmed) return;
    const t = setTimeout(() => setResetArmed(false), 3000);
    return () => clearTimeout(t);
  }, [resetArmed]);

  useEffect(() => {
    if (!storageBlocked && !saveScenarios(scenarios, activeId)) setToast("설정을 저장하지 못했습니다. JSON 백업을 내려받아 보관해주세요.");
  }, [scenarios, activeId, storageBlocked]);

  const active = scenarios.find(s => s.id === activeId) || scenarios[0];
  const setInputField = (k) => (v) => {
    setScenarios(prev => prev.map(s => {
      if (s.id !== active.id) return s;
      const newInput = normalizeInput({ ...s.input, [k]: v, _sources: { ...s.input._sources, [k]: "user" } });
      const update = { ...s, input: newInput };
      if (k === "retireAge" && AUTO_NAME_RE.test(s.name)) update.name = `퇴직 ${v}세`;
      return update;
    }));
  };
  const setInputPatch = (patch, options) => {
    setScenarios(prev => prev.map(s =>
      s.id === active.id ? { ...s, input: applyInputPatch(s.input, patch, options) } : s
    ));
  };
  const renameScenario = (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setScenarios(prev => prev.map(s => s.id === id ? { ...s, name: trimmed } : s));
  };
  const addChild = () => {
    if (active.input.children.length >= 5) return;
    setInputField("children")([
      ...active.input.children,
      { id: uid(), birthYear: CURRENT_YEAR - Math.max(0, active.input.currentAge - 35) },
    ]);
  };
  const updateChild = (id, birthYear) => {
    setInputField("children")(active.input.children.map(c => c.id === id ? { ...c, birthYear } : c));
  };
  const removeChild = (id) => {
    setInputField("children")(active.input.children.filter(c => c.id !== id));
  };

  const addScenario = () => {
    if (scenarios.length >= SCENARIO_COLORS.length) return;
    // 활성 시나리오의 퇴직나이 기준으로 +5, −5, +10 순으로 비교 시나리오 생성
    const base = active.input.retireAge;
    const offsets = [5, -5, 10];
    const off = offsets[scenarios.length - 1] ?? 5;
    const minRetire = Math.max(active.input.currentAge + 1, 25);
    const newRetire = Math.min(75, Math.max(minRetire, base + off));
    const next = makeScenario(
      `퇴직 ${newRetire}세`,
      { ...active.input, retireAge: newRetire },
      scenarios.length,
    );
    setScenarios(prev => [...prev, next]);
    setActiveId(next.id);
  };

  const removeScenario = (id) => {
    if (scenarios.length <= 1) return;
    const next = scenarios.filter(s => s.id !== id);
    setScenarios(next);
    // 프리셋 시나리오가 모두 사라지면 프리셋 상태 초기화
    if (!next.some(s => s.origin?.startsWith("preset:"))) setActivePresetId(null);
    if (activeId === id) setActiveId(next[0].id);
  };

  const resetActive = () => {
    if (!resetArmed) { setResetArmed(true); return; }
    setResetArmed(false);
    setScenarios(prev => prev.map(s => s.id === activeId ? { ...s, input: normalizeInput(KR_DEFAULTS) } : s));
  };

  const applyPreset = (preset) => {
    // 기존 프리셋 시나리오 제거 (origin이 "preset:"으로 시작하는 것들)
    const manual = scenarios.filter(s => !s.origin || !s.origin.startsWith("preset:"));
    const baseInput = active.input;
    const generated = preset.generate(baseInput);
    // 총 시나리오 수를 SCENARIO_COLORS 수(4) 이하로 제한
    const maxNew = Math.max(0, SCENARIO_COLORS.length - manual.length);
    const trimmed = generated.slice(0, maxNew);
    if (trimmed.length === 0) return;
    const newScenarios = trimmed.map((g, idx) => ({
      id: uid(),
      name: g.suffix,
      color: SCENARIO_COLORS[(manual.length + idx) % SCENARIO_COLORS.length],
      input: normalizeInput({ ...baseInput, ...g.patch }),
      origin: `preset:${preset.id}`,
    }));
    setScenarios([...manual, ...newScenarios]);
    setActivePresetId(preset.id);
  };

  const clearPreset = () => {
    setScenarios(prev => prev.filter(s => !s.origin || !s.origin.startsWith("preset:")));
    setActivePresetId(null);
  };

  const applyInsightAsNewScenario = (ins) => {
    if (scenarios.length >= SCENARIO_COLORS.length) return;
    const newInput = normalizeInput({ ...active.input, ...(typeof ins.patch === "function" ? ins.patch(active.input) : ins.patch) });
    const nextColor = SCENARIO_COLORS[scenarios.length];
    const newId = uid();
    setScenarios(prev => [...prev, { id: newId, name: ins.label, color: nextColor, input: newInput }]);
    setActiveId(newId);
  };

  const markWizardSeen = () => { writeFlag(WIZARD_KEY, "1"); setWizardSeen(true); };
  const openWizard = () => { setShowWizard(true); markWizardSeen(); };
  const closeWizard = () => { setShowWizard(false); markWizardSeen(); };

  const handleWizardComplete = ({input: result, createComparison}) => {
    const updatedName = `퇴직 ${result.retireAge}세`;
    const laterAge = Math.min(75, result.retireAge + 2);
    setScenarios(prev => {
      const updated = prev.map(s => s.id === active.id
        ? { ...s, name: AUTO_NAME_RE.test(s.name) ? updatedName : s.name, input: normalizeInput(result) }
        : s);
      // 처음 설정할 때만 '퇴직 +5세' 비교 시나리오를 자동 추가 (다시 실행할 때마다 쌓이지 않도록)
      if (createComparison && prev.length < SCENARIO_COLORS.length && laterAge !== result.retireAge)
        updated.push(makeScenario(`퇴직 ${laterAge}세`, { ...result, retireAge: laterAge }, 1));
      return updated;
    });
    closeWizard();
  };

  // 결과 계산
  const bandsById = useMemo(() => {
    const m = new Map();
    for (const s of scenarios) m.set(s.id, cachedScenarioBand(s.input));
    return m;
  }, [scenarios]);

  const activeBand = bandsById.get(active.id);
  const activeResult = activeBand.mid;

  // C10: 몬테카를로 + 개선 제안 — 렌더 밖에서 디바운스 계산 (입력 안정화 300ms 후 1회, 활성 시나리오만).
  // 계산 중에는 직전 결과를 흐리게 유지해 입력 때마다 배너가 깜빡이거나 높이가 바뀌지 않게 한다.
  const analysis = useAnalysis(active.input);
  const mcState = analysis.state;
  const mcStale = analysis.stale;
  const mcResult = !mcStale ? mcState?.mc ?? null : null;
  const insights = !mcStale ? mcState?.insights ?? null : null;
  const targets = !mcStale ? mcState?.targets ?? null : null;

  // 기본값 대비 변경 여부 헬퍼 (슬라이더 강조 표시용)
  const normalizedDefaults = useMemo(() => normalizeInput(KR_DEFAULTS), []);
  const changedFrom = (field) => {
    const cur = i[field]; const def = normalizedDefaults[field];
    if (typeof def === "number") return Math.abs(cur - def) > 0.001;
    return cur !== def;
  };

  const i = active.input;

  // C9: 입력 정합성 검증
  const validationWarnings = useMemo(() => validateInput(i), [i]);

  // C9: 디버그 콘솔 로그
  useEffect(() => {
    if (!debugMode) return;
    const bEnd = activeResult.assetBucketsAtEnd;
    const bTotal = bEnd.savings + bEnd.investments;
    const yaf = activeResult.yearlyAssetFlow;
    const lastY = yaf[yaf.length - 1] ?? {};
    const retireY = yaf.find(y => y.age === i.retireAge) ?? {};
    const warnings = validateInput(i);

    console.group(`[RetireSim Debug] 시나리오: ${active.name}`);
    console.table({
      준비율: activeResult.readinessRatio + "%",
      자산소진: activeResult.depletionAge ? activeResult.depletionAge + "세" : "없음",
      시뮬종료나이: activeResult.simEndAge + "세",
      퇴직시금융자산: fmt만원(activeResult.totalAssetsAtRetirement),
      브릿지인출: fmt만원(activeResult.bridgeShortfall),
      본인연금월: fmt만원월(activeResult.selfNpMonthly),
      배우자연금월: fmt만원월(activeResult.spouseNpMonthly),
      인출전략: i.withdrawalStrategy,
      스트레스테스트: i.stressTest,
      주거모드: i.housingMode,
      "종료_저축성": fmt만원(bEnd.savings) + (bTotal > 0 ? ` (${Math.round(bEnd.savings/bTotal*100)}%)` : ""),
      "종료_투자성": fmt만원(bEnd.investments) + (bTotal > 0 ? ` (${Math.round(bEnd.investments/bTotal*100)}%)` : ""),
      "종료_순자산": fmt만원(lastY.netWorth ?? 0),
      "종료_금융자산": fmt만원(lastY.financialAssets ?? 0),
      "퇴직시_관리비월": fmt만원월(retireY.maintMonthly ?? 0),
      "퇴직시_주거비월": fmt만원월(retireY.rentMonthly ?? 0),
      cascade이벤트: activeResult.downsizeEvents.length + "건",
    });
    if (activeResult.downsizeEvents.length > 0) {
      console.group("cascade 이벤트");
      console.table(activeResult.downsizeEvents);
      console.groupEnd();
    }
    if (warnings.length > 0) {
      console.group("입력 검증 경고");
      console.table(warnings);
      console.groupEnd();
    }
    console.log("yearlyAssetFlow:", yaf);
    console.groupEnd();
  }, [activeResult, debugMode, active.name, i]);

  // 자산흐름 차트 데이터 결합
  const chartData = useMemo(() => {
    const map = new Map();
    const ages = activeBand.mid.yearlyAssetFlow.map(y => y.age);
    for (const age of ages) map.set(age, { age });
    for (const s of scenarios) {
      const band = bandsById.get(s.id);
      band.mid.yearlyAssetFlow.forEach((y, idx) => {
        const row = map.get(y.age) || { age: y.age };
        // 금융자산 실선 (주요 라인)
        row[`mid_${s.id}`] = y.financialAssets;
        row[`pess_${s.id}`] = band.pessimistic.yearlyAssetFlow[idx]?.financialAssets;
        row[`opt_${s.id}`] = band.optimistic.yearlyAssetFlow[idx]?.financialAssets;
        if (s.id === active.id) {
          // 밴드는 금융자산 기준
          row[`band_${s.id}`] = [
            band.pessimistic.yearlyAssetFlow[idx]?.financialAssets,
            band.optimistic.yearlyAssetFlow[idx]?.financialAssets,
          ];
          // C1: 시퀀스 리스크 라인
          row["seq_shock"] = band.sequenceShock?.yearlyAssetFlow[idx]?.financialAssets ?? undefined;
          // 순자산 점선 (활성 시나리오 중간 시나리오만)
          row["net_worth"] = y.netWorth;
        }
        map.set(y.age, row);
      });
    }
    return Array.from(map.values()).sort((a, b) => a.age - b.age);
  }, [scenarios, bandsById, active.id]);

  // 자산 구성 변화 차트 데이터 (활성 시나리오)
  const bucketData = useMemo(() =>
    activeResult.yearlyAssetFlow.map(y => ({
      age:    y.age,
      "저축성 자산":  Math.max(0, y.financialSavings),
      "투자성 자산":  Math.max(0, y.financialInvestments),
      "주택":         Math.max(0, y.houseValue),
      "보증금":       Math.max(0, y.deposit),
      "대출":        -Math.max(0, y.mortgage),
    })),
  [activeResult]);

  // 현금흐름 차트 데이터 (Step 6 — 라벨 표준화)
  const cashflowData = activeResult.yearlyAssetFlow.map(y => ({
    age:            y.age,
    "본인 근로":      y.selfSalaryMonthly,
    "배우자 근로":    y.spouseSalaryMonthly,
    "본인 국민연금":  y.selfPensionMonthly,
    "배우자 국민연금": y.spousePensionMonthly,
    "기초연금":       y.basicPensionMonthly ?? 0,
    "브릿지 월소득":  y.bridgeSideMonthly,
    "생활비":       -y.livingMonthly,
    "양육비":       -y.childMonthly,
    "대출 상환":    -y.mortgageMonthly,
    "건강보험료":   -y.healthInsMonthly,
    "의료비":      -y.medicalMonthly,
    "관리비·주거":  -(y.maintMonthlyOut ?? 0) - (y.rentMonthlyOut ?? 0),
    "추가저축":     -(y.extraSavingMonthly ?? 0),
    "순현금흐름":    y.cashflowMonthly,
  }));

  const minAge = i.currentAge;
  const maxAge = i.selfLifeExpectancy;

  // 입력 모드·시나리오가 바뀌면 (세로 배치일 때) 화면 맨 위에서 시작
  const switchMobileView = (view) => {
    setMobileView(view);
    try { window.scrollTo({ top: 0 }); } catch {}
  };

  const lifeQuickPick = [85, 90, 95];
  const lifeQuickActive = (age) => i.selfLifeExpectancy === age && (!i.spouseEnabled || i.spouseLifeExpectancy === age);
  const applyLifespan = (age) => setInputPatch({
    selfLifeExpectancy: age,
    ...(i.spouseEnabled ? { spouseLifeExpectancy: age } : {}),
  });
  const retireLivingHint = `65~74세 ${Math.round(i.retirementLivingCost * ageFactor(65))}만 · 75세+ ${Math.round(i.retirementLivingCost * ageFactor(75))}만/월로 적용됩니다 (의료비·주거비 별도, 배우자만 남으면 ×0.7).`;
  const householdNet = i.selfCurrentSalary + (i.spouseEnabled ? (i.spouseCurrentSalary ?? 0) : 0);

  const fieldErrors = {};
  if (i.retireAge < i.currentAge) fieldErrors.retireAge = '퇴직 나이는 현재 나이 이상으로 입력해주세요.';
  if (i.selfLifeExpectancy <= Math.max(i.currentAge, i.retireAge)) fieldErrors.selfLifeExpectancy = '계획 수명은 현재·퇴직 나이보다 커야 합니다.';
  if (i.spouseEnabled && i.spouseLifeExpectancy <= i.spouseCurrentAge) fieldErrors.spouseLifeExpectancy = '배우자 계획 수명을 확인해주세요.';
  const resetFields = fields => {
    const patch = Object.fromEntries(fields.map(k=>[k,k === "projectionStress" ? false : KR_DEFAULTS[k]]));
    setInputPatch(patch, { source: "default" });
  };
  const exportJSON = () => {
    try {
      const url=URL.createObjectURL(new Blob([serializeBackup(scenarios,activeId)],{type:'application/json'}));
      const a=document.createElement('a'); a.href=url; a.download='retirement-scenarios.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch (error) { setToast(`백업 실패: ${error.message}`); }
  };
  const importJSON = async event => {
    const file=event.target.files?.[0]; event.target.value=''; if(!file) return;
    try {
      if(file.size>2_000_000) throw new Error('백업 파일은 2MB 이하여야 합니다.');
      const restored=parseBackup(await file.text());
      // Import appends instead of replacing the current plans.
      const additions=restored.scenarios.map(s=>({...s,id:uid()}));
      setScenarios(prev=>[...prev,...additions]); setActiveId(additions[0].id); setStorageBlocked(false);
      setToast('백업을 비교 시나리오로 추가했습니다. 기존 설정은 유지됩니다.');
    } catch(error) { setToast(`가져오기 실패: ${error.message}`); }
  };

  return (
    <FieldContext.Provider value={{input:i,errors:fieldErrors,onReset:k=>resetFields([k]),onResetSection:title=>resetFields(SECTION_FIELDS[title]??[])}}>
    <div className="min-h-screen">
      {showWizard && (
        <SetupWizard
          key={active.id}
          scenarioId={active.id}
          initial={active.input}
          onComplete={handleWizardComplete}
          onClose={closeWizard}
        />
      )}
      {showAssumptions && <AssumptionsModal onClose={() => setShowAssumptions(false)} />}

      <div className="max-w-7xl mx-auto px-4 py-2 flex gap-3 flex-wrap text-xs">
        <button type="button" onClick={exportJSON} className="underline">JSON 백업 내보내기</button>
        <label className="underline flex items-center gap-2">JSON 가져오기<input type="file" accept=".json,application/json" onChange={importJSON} className="max-w-[200px]" /></label>
        {storageBlocked && <p role="alert">저장 원본 보호를 위해 자동 저장이 중단되었습니다. JSON으로 백업해주세요.</p>}
      </div>
      <header className="border-b border-slate-200 bg-white sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-2.5">
          <div className="flex items-baseline gap-3 flex-wrap justify-between">
            <div className="flex items-baseline gap-3">
              <h1 className="text-base font-semibold">은퇴 현금흐름 시뮬레이터</h1>
              <span className="text-xs text-slate-500 hidden md:inline">브릿지 위험과 국민연금 효과를 시각화</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setShowAssumptions(true)}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                title="시뮬레이션에 사용된 가정과 상수를 확인합니다"
              >ⓘ 가정</button>
              <button
                onClick={openWizard}
                className={`text-sm px-3 py-1.5 rounded-lg font-medium transition-all bg-slate-900 text-white hover:bg-slate-700 shadow-sm ${!wizardSeen ? "ring-2 ring-amber-300 ring-offset-2 animate-pulse" : ""}`}
                title="기본 정보 몇 가지만 입력하면 자동으로 시나리오를 만들어 드립니다"
              >🪄 빠른 설정</button>
            </div>
          </div>
          {/* 입력/결과가 세로로 쌓이는 화면(<1024px): 결과/입력 토글 */}
          {isStacked && (
            <div className="mt-1.5 flex gap-1 text-xs bg-slate-100 rounded-lg p-0.5 w-fit" role="tablist" aria-label="화면 전환">
              <button
                id="results-tab"
                role="tab"
                aria-selected={mobileView === "results"}
                aria-controls="results-panel"
                onClick={() => switchMobileView("results")}
                className={`px-4 py-1.5 rounded-md transition-all ${mobileView === "results" ? 'bg-white shadow text-slate-900 font-medium' : 'text-slate-500'}`}
              >결과</button>
              <button
                id="inputs-tab"
                role="tab"
                aria-selected={mobileView === "inputs"}
                aria-controls="inputs-panel"
                onClick={() => switchMobileView("inputs")}
                className={`px-4 py-1.5 rounded-md transition-all ${mobileView === "inputs" ? 'bg-white shadow text-slate-900 font-medium' : 'text-slate-500'}`}
              >입력</button>
            </div>
          )}
          {/* 시나리오 탭 */}
          <div className="mt-1.5 flex items-center gap-1 overflow-x-auto -mb-px">
            {scenarios.map(s => {
              const res = bandsById?.get(s.id)?.mid;
              const baseRes = bandsById?.get(scenarios[0]?.id)?.mid;
              const deltaR = res && baseRes && s.id !== scenarios[0]?.id
                ? Math.round(res.readinessRatio - baseRes.readinessRatio) : null;
              return (
                <div key={s.id} className={`scenario-tab flex items-center gap-1 px-2 py-1 rounded-t border-b-2 transition-colors shrink-0 ${s.id === activeId ? 'border-current bg-slate-50' : 'border-transparent hover:bg-slate-50'}`} style={{ color: s.color }}>
                  <button
                    onClick={() => setActiveId(s.id)}
                    aria-current={s.id === activeId ? "true" : undefined}
                    className="text-xs font-medium"
                  >{isMobile && s.name.length > 6 ? s.name.slice(0, 6) + '…' : s.name}</button>
                  {deltaR !== null && (
                    <span className={`text-[10px] px-1 rounded-full font-medium ${deltaR >= 0 ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-600"}`}
                      title="첫 번째 시나리오 대비 준비율 차이">
                      {deltaR >= 0 ? "+" : ""}{deltaR}%
                    </span>
                  )}
                  {scenarios.length > 1 && (
                    <button onClick={() => removeScenario(s.id)} className="text-xs text-slate-500 hover:text-red-500 px-0.5" title="삭제" aria-label={`${s.name} 시나리오 삭제`}>×</button>
                  )}
                </div>
              );
            })}
            {scenarios.length < SCENARIO_COLORS.length && (
              <button
                onClick={addScenario}
                className="text-xs px-2.5 py-1 text-slate-500 hover:text-slate-700 border border-dashed border-slate-300 hover:border-slate-400 rounded-md ml-1 transition-colors shrink-0"
                title="현재 시나리오의 퇴직 나이를 ±5세 바꾼 비교 시나리오 추가"
              >+ 비교</button>
            )}
          </div>
        </div>
      </header>

      <main className={`max-w-7xl mx-auto px-4 py-5 grid grid-cols-1 lg:grid-cols-12 gap-5 ${isStacked && mobileView === "inputs" ? "pb-24" : ""}`}>
        {/* 입력 패널 */}
        <aside
          id="inputs-panel"
          role={isStacked ? "tabpanel" : undefined}
          aria-labelledby={isStacked ? "inputs-tab" : undefined}
          className={`lg:col-span-4 xl:col-span-3 ${isStacked && mobileView !== "inputs" ? "hidden" : ""}`}
        >
          <div className="lg:sticky lg:top-24 bg-white rounded-xl border border-slate-200 p-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
            <div className="mb-3 pb-2 border-b border-slate-100 flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">편집 중</div>
                <ScenarioNameEditor key={active.id} name={active.name} color={active.color} onRename={(n) => renameScenario(active.id, n)} />
              </div>
              <div className="flex gap-1 text-xs bg-slate-100 rounded-lg p-0.5 shrink-0" role="group" aria-label="입력 모드">
                <button type="button" aria-pressed={!advancedMode} onClick={() => setAdvancedMode(false)} className={`px-2.5 py-1 rounded-md transition-all ${!advancedMode ? 'bg-white shadow text-slate-900 font-medium' : 'text-slate-500 hover:text-slate-700'}`}>기본</button>
                <button type="button" aria-pressed={advancedMode} onClick={() => setAdvancedMode(true)} className={`px-2.5 py-1 rounded-md transition-all ${advancedMode ? 'bg-white shadow text-slate-900 font-medium' : 'text-slate-500 hover:text-slate-700'}`}>고급</button>
              </div>
            </div>

            {/* 프로필 */}
            <Section title="프로필" defaultOpen summary={`${i.currentAge}→${i.retireAge}→${i.selfPensionStartAge}세`}>
              <Slider label="현재 나이" value={i.currentAge} {...UI_RANGES.currentAge} fieldKey="currentAge" onChange={setInputField("currentAge")} format={v => `${v}세`} changed={changedFrom("currentAge")} />
              <Slider label="퇴직 나이" value={i.retireAge} {...UI_RANGES.retireAge} min={i.currentAge} fieldKey="retireAge" onChange={setInputField("retireAge")} format={v => `${v}세`} changed={changedFrom("retireAge")} />
              <Slider label={i.spouseEnabled ? "계획 수명 (본인)" : "계획 수명"} value={i.selfLifeExpectancy} {...UI_RANGES.selfLifeExpectancy} fieldKey="selfLifeExpectancy" onChange={setInputField("selfLifeExpectancy")} format={v => `${v}세`} changed={changedFrom("selfLifeExpectancy")}
                hint="통계청 2024: 40세 기대여명 남 41.9년·여 47.4년(평균 약 82·87세). 평균은 절반이 그보다 오래 산다는 뜻이라 90세 전후를 권장합니다." />
              <div className="flex items-center gap-1.5 -mt-1 mb-3 flex-wrap" role="group" aria-label="계획 수명 빠른 선택">
                <span className="text-[11px] text-slate-500">빠른 선택</span>
                {lifeQuickPick.map(age => (
                  <button key={age} type="button" aria-pressed={lifeQuickActive(age)} onClick={() => applyLifespan(age)}
                    className={`px-2.5 py-1 rounded-full border text-[11px] transition-colors ${lifeQuickActive(age) ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{age}세</button>
                ))}
                {i.spouseEnabled && <span className="text-[11px] text-slate-500">부부 공통</span>}
              </div>
              {advancedMode && (
                <Slider label="국민연금 개시 나이" value={i.selfPensionStartAge} {...UI_RANGES.selfPensionStartAge} fieldKey="selfPensionStartAge" onChange={setInputField("selfPensionStartAge")} format={v => `${v}세`} hint={`법정 ${autoPensionStartAge(i.currentAge)}세 · 조기 −6%/연기 +7.2%/년 → 수령액 ×${pensionClaimFactor(i.selfPensionStartAge, autoPensionStartAge(i.currentAge)).toFixed(2)}`} />
              )}
            </Section>

            {/* 가구 (배우자·자녀) — 기본 모드에서도 바로 편집 */}
            <Section title="가구" summary={`${i.spouseEnabled ? "부부" : "1인"} · 자녀 ${i.children.length}명`}>
              <Toggle label="배우자 반영" value={i.spouseEnabled} fieldKey="spouseEnabled" onChange={setInputField("spouseEnabled")} hint="배우자의 소득·연금·수명을 함께 계산" />
              {i.spouseEnabled && <>
                <Slider label="배우자 현재 나이" value={i.spouseCurrentAge} {...UI_RANGES.spouseCurrentAge} fieldKey="spouseCurrentAge" onChange={setInputField("spouseCurrentAge")} format={v => `${v}세`} />
                <Slider label="배우자 퇴직 나이" value={i.spouseRetireAge} {...UI_RANGES.spouseRetireAge} fieldKey="spouseRetireAge" onChange={setInputField("spouseRetireAge")} format={v => `${v}세`} />
                {advancedMode && <>
                  <Slider label="배우자 계획 수명" value={i.spouseLifeExpectancy} {...UI_RANGES.spouseLifeExpectancy} fieldKey="spouseLifeExpectancy" onChange={setInputField("spouseLifeExpectancy")} format={v => `${v}세`} />
                  <Slider label="배우자 국민연금 개시" value={i.spousePensionStartAge} {...UI_RANGES.spousePensionStartAge} fieldKey="spousePensionStartAge" onChange={setInputField("spousePensionStartAge")} format={v => `${v}세`} hint={`법정 ${autoPensionStartAge(i.spouseCurrentAge)}세 → 수령액 ×${pensionClaimFactor(i.spousePensionStartAge, autoPensionStartAge(i.spouseCurrentAge)).toFixed(2)}`} />
                </>}
              </>}
              <div className="mt-1 pt-2 border-t border-slate-100">
                <div className="text-xs text-slate-700 font-medium mb-2">자녀</div>
                {i.children.length === 0 && <p className="text-xs text-slate-500 mb-2">자녀 없음</p>}
                {i.children.map((child, idx) => (
                  <div key={child.id} className="flex items-end gap-2 mb-2">
                    <div className="flex-1">
                      <NumberInput
                        label={`자녀 ${idx + 1} 현재 나이 (${child.birthYear}년생)`}
                        value={CURRENT_YEAR - child.birthYear}
                        onChange={v => updateChild(child.id, CURRENT_YEAR - Math.min(40, Math.max(0, v ?? 0)))}
                        suffix="세"
                      />
                    </div>
                    <button onClick={() => removeChild(child.id)} className="mb-3 px-2 py-1.5 text-xs rounded border border-slate-200 text-slate-600 hover:text-red-600" aria-label={`자녀 ${idx + 1} 삭제`}>삭제</button>
                  </div>
                ))}
                {i.children.length < 5 && (
                  <button onClick={addChild} className="mb-3 px-2.5 py-1.5 text-xs rounded border border-slate-200 text-slate-600 hover:bg-slate-50">+ 자녀 추가</button>
                )}
                {advancedMode && (
                  <Slider label="사교육비 강도" value={i.childCostMultiplier} {...UI_RANGES.childCostMultiplier} fieldKey="childCostMultiplier" onChange={setInputField("childCostMultiplier")} format={v => `${v.toFixed(1)}×`} hint="1.0 = 표준 (0~6세 50 / 초중고 80 / 대학 150만원 월)" />
                )}
              </div>
            </Section>

            {/* 소득 */}
            <Section title="소득" defaultOpen summary={`세후 ${fmt만원(householdNet)}/년`}>
              <SalaryInput
                name="본인 연봉"
                netAnnual={i.selfCurrentSalary}
                basis={i.selfSalaryBasis ?? "gross"}
                onChangeNet={setInputField("selfCurrentSalary")}
                onChangeBasis={setInputField("selfSalaryBasis")}
              />
              {i.spouseEnabled && (
                <SalaryInput
                  name="배우자 연봉"
                  netAnnual={i.spouseCurrentSalary}
                  basis={i.spouseSalaryBasis ?? "gross"}
                  onChangeNet={setInputField("spouseCurrentSalary")}
                  onChangeBasis={setInputField("spouseSalaryBasis")}
                />
              )}
              {advancedMode && <>
                <Slider label="연봉 상승률" value={i.salaryGrowthRate} {...UI_RANGES.salaryGrowthRate} fieldKey="salaryGrowthRate" onChange={setInputField("salaryGrowthRate")} format={v => `${v.toFixed(1)}%`} hint="명목 기준. 물가상승률을 빼면 실질 상승률이 됩니다." />
                <Slider label="브릿지 소득 (퇴직~연금전)" value={i.postRetireSideIncome} {...UI_RANGES.postRetireSideIncome} fieldKey="postRetireSideIncome" onChange={setInputField("postRetireSideIncome")} format={v => `${v}만/월`} showAnnual hint="퇴직 후 재취업·프리랜서 등으로 버는 월 소득 (세후)" />
                {/* 국민연금 — 본인 */}
                <div className="mt-1 mb-1">
                  <Toggle label="본인 국민연금 직접 입력"
                    value={i.selfNpInputMode === "manual"}
                    onChange={v => setInputField("selfNpInputMode")(v ? "manual" : "auto")}
                    hint="국민연금공단 예상 수령액을 직접 입력" />
                </div>
                {i.selfNpInputMode === "manual" ? (
                  <Slider label="본인 예상 수령액" value={i.selfNpManualMonthly} {...UI_RANGES.selfNpManualMonthly} fieldKey="selfNpManualMonthly" onChange={setInputField("selfNpManualMonthly")} format={v => `${v}만/월`} />
                ) : (
                  <>
                    <Toggle label="가입연수 자동 계산" value={i.selfNpAutoMode} fieldKey="selfNpAutoMode" onChange={setInputField("selfNpAutoMode")} hint={`자동: 퇴직나이${i.retireAge}−25 = ${autoNpYears(i.retireAge)}년`} />
                    {!i.selfNpAutoMode && (
                      <Slider label="본인 가입연수" value={i.selfNpYears} {...UI_RANGES.selfNpYears} fieldKey="selfNpYears" onChange={setInputField("selfNpYears")} format={v => `${v}년`} />
                    )}
                  </>
                )}
                {/* 국민연금 — 배우자 */}
                {i.spouseEnabled && <>
                  <div className="mt-1 mb-1">
                    <Toggle label="배우자 국민연금 직접 입력"
                      value={i.spouseNpInputMode === "manual"}
                      onChange={v => setInputField("spouseNpInputMode")(v ? "manual" : "auto")}
                      hint={(i.spouseCurrentSalary ?? 0) <= 0 ? "소득이 0이면 자동 추정 연금은 0입니다. 가입 이력이 있다면 직접 입력하세요." : "국민연금공단 예상 수령액을 직접 입력"} />
                  </div>
                  {i.spouseNpInputMode === "manual" ? (
                    <Slider label="배우자 예상 수령액" value={i.spouseNpManualMonthly} {...UI_RANGES.spouseNpManualMonthly} fieldKey="spouseNpManualMonthly" onChange={setInputField("spouseNpManualMonthly")} format={v => `${v}만/월`} />
                  ) : (
                    <>
                      <Toggle label="배우자 가입연수 자동" value={i.spouseNpAutoMode} fieldKey="spouseNpAutoMode" onChange={setInputField("spouseNpAutoMode")} hint={`자동: 배우자 퇴직나이${i.spouseRetireAge}−25 = ${autoNpYears(i.spouseRetireAge)}년`} />
                      {!i.spouseNpAutoMode && (
                        <Slider label="배우자 가입연수" value={i.spouseNpYears} {...UI_RANGES.spouseNpYears} fieldKey="spouseNpYears" onChange={setInputField("spouseNpYears")} format={v => `${v}년`} />
                      )}
                    </>
                  )}
                </>}
              </>}
            </Section>

            {/* 자산 */}
            <Section title="자산" summary={`금융 ${fmt만원(i.investmentBalance + i.savingsBalance)}`}>
              <Slider label="저축성 자산 (예금·MMF 등)" value={i.savingsBalance} {...UI_RANGES.savingsBalance} fieldKey="savingsBalance" onChange={setInputField("savingsBalance")} format={fmt만원} changed={changedFrom("savingsBalance")} hint="안정적 수익. 스트레스 테스트 미적용." />
              <Slider label="투자성 자산 (DC/IRP·주식·ETF)" value={i.investmentBalance} {...UI_RANGES.investmentBalance} fieldKey="investmentBalance" onChange={setInputField("investmentBalance")} format={fmt만원} hint="DC/IRP를 별도 자산에 중복 합산하지 마세요. 현재 잔액만 입력하세요. 근로 기간에는 회사 적립(세전 연봉÷12)이 자동으로 더해집니다. 스트레스 테스트 적용." changed={changedFrom("investmentBalance")} />
              {advancedMode && (
                <Slider label="월 투자 적립 (잉여현금 중)" value={i.monthlyAddSaving} {...UI_RANGES.monthlyAddSaving} fieldKey="monthlyAddSaving" onChange={setInputField("monthlyAddSaving")} format={v => `${v}만/월`} showAnnual hint="생활비·대출을 내고 남는 돈 중 투자성 자산으로 보내는 금액. 남는 돈은 모두 저축성에 쌓이므로 총액은 같고 수익률 차이만 반영됩니다." />
              )}
            </Section>

            {/* 주거 */}
            <Section title="주거" summary={
              i.housingMode === "own" ? `자가 ${fmt만원(i.housePrice)}` :
              i.housingMode === "jeonse" ? `전세 ${fmt만원(i.deposit)}` :
              `월세 ${i.monthlyRent}만/월`
            }>
              {/* 주거 모드 선택 */}
              <div className="flex gap-1 mb-3 text-xs" role="group" aria-label="주거 형태">
                {[["own","🏠 자가"],["jeonse","🔑 전세"],["monthly_rent","🏢 월세"]].map(([mode, label]) => (
                  <button key={mode} type="button"
                    aria-pressed={i.housingMode === mode}
                    onClick={() => setInputPatch({ housingMode: mode })}
                    className={`flex-1 py-2 rounded-lg border text-xs font-medium transition-colors ${i.housingMode === mode ? "border-slate-800 bg-slate-900 text-white" : "border-slate-200 text-slate-600 hover:border-slate-300"}`}
                  >{label}</button>
                ))}
              </div>
              {/* 자가 전용 */}
              {i.housingMode === "own" && <>
                <Slider label="주택 시세" value={i.housePrice} {...UI_RANGES.housePrice} fieldKey="housePrice" onChange={setInputField("housePrice")} format={fmt만원} changed={changedFrom("housePrice")} />
                <Toggle label="주택 대출 보유" value={i.hasMortgage} onChange={(v) => setInputPatch({ hasMortgage: v })} />
                {i.hasMortgage && <>
                  <Slider label="대출 잔액" value={i.mortgageBalance} {...UI_RANGES.mortgageBalance} fieldKey="mortgageBalance" onChange={setInputField("mortgageBalance")} format={fmt만원} />
                  <Slider label="월 원리금" value={i.monthlyMortgagePayment} {...UI_RANGES.monthlyMortgagePayment} fieldKey="monthlyMortgagePayment" onChange={setInputField("monthlyMortgagePayment")} format={v => `${v}만/월`} hint="명목 고정 금액으로 상환합니다 (물가가 오르면 실질 부담은 줄어듦)." />
                  {advancedMode && (
                    <Slider label="대출 금리" value={i.mortgageRate ?? 4.0} {...UI_RANGES.mortgageRate} fieldKey="mortgageRate" onChange={setInputField("mortgageRate")} format={v => `${v.toFixed(1)}%`} hint="명목 금리로 잔액에 이자 부과" />
                  )}
                </>}
              </>}
              {/* 전세 전용 */}
              {i.housingMode === "jeonse" && (
                <Slider label="전세 보증금" value={i.deposit} {...UI_RANGES.deposit} fieldKey="deposit" onChange={setInputField("deposit")} format={fmt만원} />
              )}
              {/* 월세 전용 */}
              {i.housingMode === "monthly_rent" && <>
                <Slider label="보증금" value={i.deposit} {...UI_RANGES.deposit} fieldKey="deposit" onChange={setInputField("deposit")} format={fmt만원} />
                <Slider label="월세" value={i.monthlyRent} {...UI_RANGES.monthlyRent} fieldKey="monthlyRent" onChange={setInputField("monthlyRent")} format={v => `${v}만/월`} showAnnual />
              </>}
              {/* 공통: 관리비 */}
              <Slider label="월 관리비" value={i.housingMaintenance ?? 20} {...UI_RANGES.housingMaintenance} fieldKey="housingMaintenance" onChange={setInputField("housingMaintenance")} format={v => `${v}만/월`} showAnnual />
            </Section>

            {/* 생활비 */}
            <Section title="생활비 (현재가치)" summary={`${i.workingLivingCost}/${i.bridgeLivingCost}/${i.retirementLivingCost}만`}>
              <Slider label="근로기" value={i.workingLivingCost} {...UI_RANGES.workingLivingCost} fieldKey="workingLivingCost" onChange={setInputField("workingLivingCost")} format={v => `${v}만/월`} changed={changedFrom("workingLivingCost")} showAnnual hint="대출·주거·양육비 제외. 차량·여행·경조사·부모 부양 같은 비정기 지출도 포함하세요. 남는 돈은 전부 저축된다고 가정합니다." />
              <Slider label="브릿지 기간 (퇴직~연금 개시)" value={i.bridgeLivingCost} {...UI_RANGES.bridgeLivingCost} fieldKey="bridgeLivingCost" onChange={setInputField("bridgeLivingCost")} format={v => `${v}만/월`} changed={changedFrom("bridgeLivingCost")} showAnnual />
              <Slider label="연금 수령기 (기준액)" value={i.retirementLivingCost} {...UI_RANGES.retirementLivingCost} fieldKey="retirementLivingCost" onChange={setInputField("retirementLivingCost")} format={v => `${v}만/월`} changed={changedFrom("retirementLivingCost")} showAnnual hint={retireLivingHint} />
              <p className="text-[11px] text-slate-500 leading-snug">
                참고: 국민연금연구원 노후보장패널(50세 이상 응답) — 부부 최소 216.6만 · 적정 298.1만/월, 개인 최소 139.2만 · 적정 197.6만/월.
              </p>
              <div className="mt-2 pt-2 border-t border-slate-100">
                <Slider label="노년기 의료비 ×배율" value={i.medicalCostMultiplier} {...UI_RANGES.medicalCostMultiplier} fieldKey="medicalCostMultiplier" onChange={setInputField("medicalCostMultiplier")} format={v => `${v.toFixed(1)}×`} hint="1.0 = 기본 (50대 15만→65세 30만→75세 60만→85세 100만/월, 1인). 민영보험 두텁 ↓ · 중증질환 대비 ↑" />
              </div>
            </Section>

            {advancedMode && i.housingMode === "own" && (
              <Section title="이벤트 — 다운사이징" summary={i.downsizeEnabled ? `${i.downsizeAge}세` : "OFF"}>
                <Toggle label="주택 다운사이징 사용" value={i.downsizeEnabled} fieldKey="downsizeEnabled" onChange={setInputField("downsizeEnabled")} />
                {i.downsizeEnabled && <>
                  <Slider label="매각 나이" value={i.downsizeAge} min={i.retireAge} max={i.selfLifeExpectancy - 1} step={UI_RANGES.downsizeAge.step} unit="세" fieldKey="downsizeAge" onChange={setInputField("downsizeAge")} format={v => `${v}세`} />
                  <Slider label="매각 후 보유비율" value={i.downsizeRatio} {...UI_RANGES.downsizeRatio} fieldKey="downsizeRatio" onChange={setInputField("downsizeRatio")} format={v => `${Math.round(v*100)}%`} hint="0.6 = 60% 가치 주택으로 다운사이즈, 40% 현금화" />
                </>}
              </Section>
            )}

            {/* 시장 가정 */}
            <Section title="시장 가정" summary={`투자 ${i.investmentReturnRate.toFixed(1)}% / 저축 ${i.savingsReturnRate?.toFixed(1) ?? 3.0}% / 물가 ${i.inflationRate.toFixed(1)}%`}>
              <Toggle label="시장 충격을 기본 결과에 반영" value={i.projectionStress === true} onChange={setInputField("projectionStress")} hint="켜면 선택한 충격 가정을 기본 지표·그래프와 몬테카를로 표본에 함께 적용합니다." />
              <Slider label="투자성 수익률" value={i.investmentReturnRate} {...UI_RANGES.investmentReturnRate} fieldKey="investmentReturnRate" onChange={setInputField("investmentReturnRate")} format={v => `${v.toFixed(1)}%`} changed={changedFrom("investmentReturnRate")} hint="연복리(CAGR) 기준 명목 수익률. DC/IRP·주식·ETF 등에 적용, 스트레스 테스트 적용." />
              <Slider label="저축성 수익률" value={i.savingsReturnRate ?? 3.0} {...UI_RANGES.savingsReturnRate} fieldKey="savingsReturnRate" onChange={setInputField("savingsReturnRate")} format={v => `${v.toFixed(1)}%`} hint="예금·MMF 등 안정 자산. 시장 충격 미적용." />
              <Slider label="물가상승률 (기준)" value={i.inflationRate} {...UI_RANGES.inflationRate} fieldKey="inflationRate" onChange={setInputField("inflationRate")} format={v => `${v.toFixed(1)}%`} />
              {advancedMode && <>
                <Slider label="수익률 밴드 ±" value={i.scenarioBandSpread} {...UI_RANGES.scenarioBandSpread} fieldKey="scenarioBandSpread" onChange={setInputField("scenarioBandSpread")} format={v => `±${v.toFixed(1)}%p`} />
                <Slider label="수익률 변동성 (몬테카를로)" value={i.returnVolatility ?? 12} {...UI_RANGES.returnVolatility} fieldKey="returnVolatility" onChange={setInputField("returnVolatility")} format={v => `±${v.toFixed(1)}%`} hint="연 수익률 표준편차. 주식 위주 15~20 / 혼합 10~12 / 채권 위주 5~8" />
                {i.housingMode === "own" && <Slider label="주택 상승률" value={i.houseInflationRate} {...UI_RANGES.houseInflationRate} fieldKey="houseInflationRate" onChange={setInputField("houseInflationRate")} format={v => `${v.toFixed(1)}%`} />}
                {i.housingMode !== "own" && (
                  <div className="mb-3">
                    <span className="text-xs text-slate-600 font-medium">주거비 인플레이션 시나리오</span>
                    <div className="flex gap-1 mt-1" role="group" aria-label="주거비 인플레이션 시나리오">
                      {[["stable","안정"],["realistic","현실"],["stress","스트레스"]].map(([s,l]) => (
                        <button key={s} type="button"
                          aria-pressed={(i.housingInflationScenario ?? "realistic") === s}
                          onClick={() => setInputPatch({ housingInflationScenario: s })}
                          className={`flex-1 py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${(i.housingInflationScenario ?? "realistic") === s ? "border-slate-800 bg-slate-900 text-white" : "border-slate-200 text-slate-600 hover:border-slate-300"}`}
                        >{l}</button>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      {(i.housingInflationScenario ?? "realistic") === "stable" ? "월세 +3.5%/년, 전세 갱신 +6.5%" :
                       (i.housingInflationScenario ?? "realistic") === "realistic" ? "월세 +4%/년, 전세 갱신 +8.5%+10년충격" :
                       "월세 +6%/년, 전세 갱신 +12%+8년충격"}. 75세+ 추가 +1.5%p.
                    </p>
                  </div>
                )}
                {/* C1: 시퀀스 리스크 스트레스 테스트 */}
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-600 font-medium">시퀀스 리스크 충격</span>
                    <span className="text-[11px] text-slate-500">차트에서 토글로 표시</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {Object.entries(STRESS_PRESETS).map(([key, preset]) => (
                      <label key={key}
                        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-[11px] cursor-pointer transition-colors ${i.stressTest === key ? "border-slate-800 bg-slate-50 font-medium" : "border-slate-200 hover:border-slate-300"}`}>
                        <input type="radio" name="stressTest" value={key}
                          checked={i.stressTest === key}
                          onChange={() => setInputField("stressTest")(key)}
                          className="accent-slate-900 w-3 h-3 shrink-0"
                        />
                        <span style={{ color: key !== "none" ? preset.color : undefined }}>{preset.label}</span>
                      </label>
                    ))}
                  </div>
                  {i.stressTest !== "none" && (
                    <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                      {STRESS_PRESETS[i.stressTest]?.desc}
                    </p>
                  )}
                </div>
              </>}
            </Section>

            {advancedMode && (
              <>
              <Section title="세제·건보·의료">
                <Toggle label="건강보험료 적용" value={i.applyHealthInsurance} fieldKey="applyHealthInsurance" onChange={setInputField("applyHealthInsurance")} hint="퇴직 후 지역가입자 추정 (배우자가 근로 중이면 피부양자 가능)" />
                <Toggle label="기초연금 반영" value={i.applyBasicPension !== false} fieldKey="applyBasicPension" onChange={setInputField("applyBasicPension")} hint="65세+ 소득인정액 하위 단순 추정 (월 최대 34.97만, 부부 각 −20%)" />
                <Toggle label="퇴직금 일시금 별도 반영" value={i.includeSeveranceLumpSum} fieldKey="includeSeveranceLumpSum" onChange={setInputField("includeSeveranceLumpSum")} hint="DC 매년 적립과 중복될 수 있어 기본값은 OFF" />
                <Toggle label="노년기 의료비 반영" value={i.applyMedicalCost !== false} onChange={v => setInputField("applyMedicalCost")(v)} hint="생활비 섹션 배율 슬라이더와 연동" />
              </Section>

              {/* C5: 인출 전략 */}
              <Section title="인출 전략" summary={
                { bucket: "버킷", "4pct": "4% 룰", vpw: "VPW" }[i.withdrawalStrategy] ?? "버킷"
              }>
                <p className="text-[11px] text-slate-500 mb-2 leading-relaxed">
                  퇴직 후 금융자산에서 생활비를 충당하는 방식을 선택합니다.
                </p>
                {[
                  { value: "bucket",  label: "버킷 전략", desc: "부족한 만큼 저축성 → 투자성 순으로 인출. 투자성 자산을 오래 유지." },
                  { value: "4pct",    label: "4% 룰",     desc: "퇴직 시 자산의 4%를 매년 인출(물가 반영). 쓰고 남는 돈은 저축성에 보관 (Trinity Study 기반)." },
                  { value: "vpw",     label: "VPW (가변 비율 인출)", desc: "남은 수명에 맞춰 매년 자산의 일정 비율을 인출. 자산이 줄면 인출액도 함께 줄어듦." },
                ].map(opt => (
                  <label key={opt.value} className={`flex items-start gap-2 mb-2 p-2 rounded-lg border cursor-pointer transition-colors ${i.withdrawalStrategy === opt.value ? "border-slate-800 bg-slate-50" : "border-slate-200 hover:border-slate-300"}`}>
                    <input type="radio" name="withdrawalStrategy" value={opt.value}
                      checked={i.withdrawalStrategy === opt.value}
                      onChange={() => setInputField("withdrawalStrategy")(opt.value)}
                      className="mt-0.5 accent-slate-900"
                    />
                    <div>
                      <div className="text-xs font-semibold text-slate-800">{opt.label}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </Section>
              </>
            )}

            <button
              onClick={resetActive}
              className={`w-full mt-2 px-3 py-2 text-xs rounded-md border transition-colors ${resetArmed ? "border-red-300 bg-red-50 text-red-700 font-medium" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
            >{resetArmed ? "정말 리셋할까요? 한 번 더 누르면 초기화됩니다" : "이 시나리오 기본값으로 리셋"}</button>
          </div>
        </aside>

        {/* 결과 패널 */}
        <section
          id="results-panel"
          role={isStacked ? "tabpanel" : undefined}
          aria-labelledby={isStacked ? "results-tab" : undefined}
          className={`lg:col-span-8 xl:col-span-9 space-y-5 min-w-0 ${isStacked && mobileView !== "results" ? "hidden" : ""}`}
        >

          {/* 마이그레이션 토스트 */}
          {toast && (
            <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800" role="status" aria-live="polite">
              <span className="shrink-0 font-bold">ℹ</span>
              <span className="flex-1">{toast}</span>
              <button onClick={() => setToast(null)} aria-label="알림 닫기" className="text-blue-500 hover:text-blue-700 text-base leading-none shrink-0 w-6 h-6">×</button>
            </div>
          )}

          {/* C9: 검증 경고 배너 */}
          {validationWarnings.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-1" role="alert" aria-live="polite">
              {validationWarnings.map(w => (
                <div key={w.key} className={`flex items-start gap-2 text-xs ${w.level === "error" ? "text-red-700" : "text-amber-800"}`}>
                  <span className="shrink-0 font-bold">{w.level === "error" ? "⚠" : "!"}</span>
                  <span>{w.msg}</span>
                </div>
              ))}
            </div>
          )}

          {/* C9: 디버그 배너 */}
          {debugMode && (
            <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-xs text-violet-700 font-mono space-y-0.5">
              <div className="font-semibold mb-1">🛠 Debug Mode</div>
              <div>준비율: {activeResult.readinessRatio}% | 자산소진: {activeResult.depletionAge ?? "없음"} | 인출전략: {i.withdrawalStrategy}</div>
              <div>퇴직시자산: {fmt만원(activeResult.totalAssetsAtRetirement)} | 브릿지인출: {fmt만원(activeResult.bridgeShortfall)}</div>
              <div>시뮬종료나이: {activeResult.simEndAge} | 가입연수: {npYearsFor(i)}년</div>
              <div>MC 성공확률: {mcResult ? `${mcResult.successRate}%` : "계산 중"} | 실패 중앙 고갈: {mcResult?.medianDepletionAge ?? "없음"} | P50 최종: {fmt만원(mcResult?.p50Final)}</div>
              <div className="text-violet-400">console에 상세 데이터 출력됨 (F12)</div>
            </div>
          )}

          <div className={`transition-opacity ${mcStale ? "opacity-60" : ""}`} aria-busy={mcStale}>
            <ResultBanner input={i} result={activeResult} npMonthly={activeResult.selfNpMonthly} mc={mcResult} onApplyLife90={() => applyLifespan(90)} />
          </div>

          {/* 조정 제안 — 결론 바로 아래에서 행동으로 이어지도록 */}
          {insights && insights.items.length > 0 && (
            <div className={`transition-opacity ${mcStale ? "opacity-60" : ""}`}>
              <ActionSuggestions insights={insights} onExplore={applyInsightAsNewScenario} scenarioCount={scenarios.length} />
            </div>
          )}

          {/* 요약 카드 */}
          <div className="grid grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] gap-3">
            <SummaryCard
              label="퇴직 시 금융자산"
              value={fmt만원(activeResult.totalAssetsAtRetirement)}
              color={(() => { const w = getVerdict(activeResult).weight; return w === "strong" ? "blue" : w === "ok" ? "green" : (w === "tight" || w === "marginal") ? "amber" : "red"; })()}
              sub={`${i.retireAge}세 시점 · 오늘 가치 기준`}
              large
              title="퇴직하는 해에 가진 저축성+투자성 금융자산(주택 제외). 퇴직금 일시금을 켠 경우 포함됩니다."
            />
            <SummaryCard
              label="자산 소진 시점"
              value={activeResult.depletionAge ? `${activeResult.depletionAge}세` : "없음"}
              color={activeResult.depletionAge ? "red" : "green"}
              sub={activeResult.depletionAge
                ? `수명(${activeResult.simEndAge}세)보다 ${activeResult.simEndAge - activeResult.depletionAge}년 일찍`
                : `${activeResult.simEndAge}세까지 유지 (준비율 ${activeResult.readinessRatio}%)`}
              title="중간 시나리오(고정 수익률)에서 금융자산이 바닥나는 나이. 준비율은 100% 이상이면 수명까지 유지, 미만이면 수명 대비 버틴 비율입니다. 수익률 변동을 고려한 확률은 위 성공확률을 보세요."
            />
            <SummaryCard
              label="브릿지 기간"
              value={`${activeResult.bridgeYears}년`}
              color={activeResult.bridgeYears >= 10 ? "red" : activeResult.bridgeYears >= 5 ? "amber" : "green"}
              sub={`${i.retireAge}세 → ${i.selfPensionStartAge}세 · 자산 인출 ${fmt만원(activeResult.bridgeShortfall)}`}
              title="퇴직 후 국민연금이 시작되기 전까지 근로소득·연금이 모두 없는 공백 기간입니다. 인출액은 이 기간 생활비를 충당하느라 금융자산에서 빠져나가는 누적 금액입니다."
            />
            <SummaryCard
              label="본인 국민연금"
              value={fmt만원월(activeResult.selfNpMonthly)}
              color="blue"
              sub={`${i.selfPensionStartAge}세 개시 · 가입 ${npYearsFor(i)}년${i.spouseEnabled ? ` · 배우자 ${fmt만원월(activeResult.spouseNpMonthly)}` : ""}`}
              title="오늘 가치 기준 월 수령액 추정(2026 소득대체율 43%). 연금소득세 반영 전 금액입니다."
            />
          </div>

          {/* 탐색 프리셋 칩 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-600 shrink-0">비교 탐색</span>
            {EXPLORE_PRESETS.map(p => (
              <button key={p.id}
                onClick={() => activePresetId === p.id ? clearPreset() : applyPreset(p)}
                title={p.description}
                aria-pressed={activePresetId === p.id}
                className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                  activePresetId === p.id
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                }`}>
                {p.label}
              </button>
            ))}
            {activePresetId && (
              <button onClick={clearPreset}
                className="text-xs text-slate-500 hover:text-slate-700 ml-1">✕ 초기화</button>
            )}
          </div>

          {/* 자산흐름 그래프 */}
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
              <h2 className="text-sm font-semibold">자산 흐름 <span className="font-normal text-slate-500">금융자산 실선 / 순자산 점선 · 오늘 가치 기준</span></h2>
              <div className="flex items-center gap-3 text-[11px] text-slate-500 flex-wrap">
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500"></span>근로기</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400"></span>
                  <span title="퇴직 후 국민연금 개시 전까지 근로소득·연금이 모두 없는 공백 기간">브릿지 <span className="cursor-help opacity-60">ⓘ</span></span>
                </span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400"></span>연금기</span>
                <span className="text-slate-300">|</span>
                <span className="text-slate-500">음영 = ±{i.scenarioBandSpread}%p 밴드</span>
                {i.stressTest !== "none" && (
                  <label className="inline-flex items-center gap-1 cursor-pointer select-none">
                    <input type="checkbox" checked={showSeqShock} onChange={e => setShowSeqShock(e.target.checked)}
                      className="w-3 h-3 rounded accent-red-600" />
                    <span style={{ color: STRESS_PRESETS[i.stressTest]?.color ?? "#ef4444" }}
                      title={STRESS_PRESETS[i.stressTest]?.desc ?? ""}>
                      {STRESS_PRESETS[i.stressTest]?.label ?? "시퀀스 리스크"}
                    </span>
                  </label>
                )}
              </div>
            </div>
            <div style={{ width: "100%", height: isMobile ? 220 : 360 }} role="img" aria-label="자산 흐름 차트">
              <ResponsiveContainer>
                <ComposedChart data={chartData} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#f1f5f9" />
                  <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => fmt만원(v)} width={60} />

                  <ReferenceArea x1={minAge} x2={i.retireAge} fill="#10b981" fillOpacity={0.05} />
                  <ReferenceArea x1={i.retireAge} x2={i.selfPensionStartAge} fill="#ef4444" fillOpacity={0.07} />
                  <ReferenceArea x1={i.selfPensionStartAge} x2={maxAge} fill="#3b82f6" fillOpacity={0.05} />

                  {activeResult.childEventList.map((e, idx) => (
                    <ReferenceLine key={`c${idx}`} x={e.age} stroke="#cbd5e1" strokeDasharray="3 3" />
                  ))}
                  {activeResult.downsizeEvents.map((e, idx) => (
                    <ReferenceLine key={`d${idx}`} x={e.age} stroke="#8b5cf6" strokeDasharray="4 2" />
                  ))}

                  <Tooltip
                    formatter={(v, name) => [fmt만원(v), name]}
                    labelFormatter={(age) => `${age}세`}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />

                  {/* 활성 시나리오 밴드 */}
                  <Area type="monotone" dataKey={`band_${active.id}`} name="수익률 밴드"
                    stroke="none" fill={active.color} fillOpacity={0.10} />

                  {/* 시나리오별 중간 라인 */}
                  {scenarios.map(s => (
                    <Line key={s.id}
                      type="monotone"
                      dataKey={`mid_${s.id}`}
                      name={s.name}
                      stroke={s.color}
                      strokeWidth={s.id === active.id ? 2.5 : 1.5}
                      strokeDasharray={s.id === active.id ? undefined : "5 3"}
                      dot={false}
                    />
                  ))}

                  {/* C1: 시퀀스 리스크 라인 — 토글 ON + stressTest !== none 시에만 */}
                  {showSeqShock && i.stressTest !== "none" && activeBand.sequenceShock && (
                    <Line type="monotone" dataKey="seq_shock"
                      name={`충격: ${STRESS_PRESETS[i.stressTest]?.label ?? ""}`}
                      stroke={STRESS_PRESETS[i.stressTest]?.color ?? "#dc2626"}
                      strokeWidth={1.5} strokeDasharray="3 3" dot={false} />
                  )}

                  {/* 순자산 점선 (활성 시나리오만, 주택+보증금 포함) */}
                  <Line type="monotone" dataKey="net_worth"
                    name="순자산(주택 포함)"
                    stroke={active.color}
                    strokeWidth={1.2}
                    strokeDasharray="4 3"
                    strokeOpacity={0.45}
                    dot={false}
                    legendType="none"
                  />

                  {scenarios.map(s => {
                    const res = bandsById.get(s.id).mid;
                    if (!res.depletionAge) return null;
                    return (
                      <ReferenceDot key={`dep-${s.id}`}
                        x={res.depletionAge} y={0} r={5}
                        fill={s.color} stroke="#fff" strokeWidth={2}
                        label={{ value: `⚠ ${res.depletionAge}세 소진`, position: "top", fontSize: 11, fill: s.color }}
                      />
                    );
                  })}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {/* 이벤트 타임라인 strip */}
            {(activeResult.childEventList.length > 0 || activeResult.downsizeEvents.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 border-t border-slate-100 pt-2">
                <span className="font-medium text-slate-500 mr-1">이벤트</span>
                {activeResult.childEventList.map((e, idx) => (
                  <span key={`tc${idx}`} className="inline-flex items-center gap-1">
                    <span className="text-slate-300">│</span>
                    <span className="text-[11px] font-medium text-slate-700">{e.age}세</span>
                    <span>{e.label}</span>
                  </span>
                ))}
                {activeResult.downsizeEvents.map((e, idx) => (
                  <span key={`td${idx}`} className="inline-flex items-center gap-1">
                    <span className="text-slate-300">│</span>
                    <span className="text-[11px] font-medium text-violet-700">{e.age}세</span>
                    <span className="text-violet-600">🏠 다운사이징</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {analysis.error && <div role="alert" className="text-sm text-amber-800 border rounded p-3">{analysis.error}<button type="button" className="underline ml-3" onClick={analysis.retry}>다시 계산</button></div>}
          {i.projectionStress === true && <p role="status" className="text-sm bg-amber-50 border border-amber-200 rounded-lg p-3">기본 결과·그래프·성공 비율에 시장 충격({STRESS_PRESETS[i.stressTest]?.label ?? "없음"})을 반영한 비교 계획입니다.</p>}
          <DecisionAnalysis input={i} result={activeResult} targets={targets} onCompare={applyInsightAsNewScenario} canCompare={scenarios.length < SCENARIO_COLORS.length} />

          {/* 자산 구성 변화 차트 */}
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
              <h2 className="text-sm font-semibold">자산 구성 변화 — <span style={{color: active.color}}>{active.name}</span></h2>
              <div className="flex items-center gap-3 text-[11px] text-slate-500 flex-wrap">
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-400"></span>저축성</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500"></span>투자성</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400"></span>주택</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-teal-400"></span>보증금</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500"></span>대출</span>
              </div>
            </div>
            <div style={{ width: "100%", height: isMobile ? 200 : 320 }} role="img" aria-label="자산 구성 변화 차트">
              <ResponsiveContainer>
                <ComposedChart data={bucketData} margin={{ top: 10, right: 16, bottom: 0, left: 0 }} stackOffset="sign">
                  <CartesianGrid stroke="#f1f5f9" />
                  <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => fmt만원(v)} width={60} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload) return null;
                      const items = payload.filter(p => p.value !== 0);
                      if (items.length === 0) return null;
                      return (
                        <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-2 text-xs">
                          <div className="font-semibold text-slate-700 mb-1">{label}세</div>
                          {items.map(p => (
                            <div key={p.dataKey} className="flex justify-between gap-4">
                              <span style={{color: p.color}}>{p.dataKey}</span>
                              <span className="num">{fmt만원(Math.abs(p.value))}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="저축성 자산"  stackId="b" stroke="#64748b" fill="#94a3b8" fillOpacity={0.8} />
                  <Area type="monotone" dataKey="투자성 자산"  stackId="b" stroke="#2563eb" fill="#3b82f6" fillOpacity={0.8} />
                  <Area type="monotone" dataKey="주택"         stackId="b" stroke="#d97706" fill="#f59e0b" fillOpacity={0.8} />
                  <Area type="monotone" dataKey="보증금"       stackId="b" stroke="#0d9488" fill="#2dd4bf" fillOpacity={0.8} />
                  <Area type="monotone" dataKey="대출"         stackId="b" stroke="#dc2626" fill="#ef4444" fillOpacity={0.7} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 시나리오 비교 카드 */}
          {scenarios.length > 1 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">시나리오 비교</h2>
              <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                {scenarios.map(s => {
                  const res = bandsById.get(s.id)?.mid;
                  if (!res) return null;
                  return (
                    <ExploreCard
                      key={s.id}
                      scenario={s}
                      result={res}
                      isActive={s.id === activeId}
                      onActivate={() => setActiveId(s.id)}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* 월 현금흐름 */}
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="text-sm font-semibold mb-2">월 현금흐름 — <span style={{color: active.color}}>{active.name}</span></h2>
            <div style={{ width: "100%", height: isMobile ? 180 : 300 }} role="img" aria-label="월 현금흐름 차트">
              <ResponsiveContainer>
                <ComposedChart data={cashflowData} margin={{ top: 10, right: 16, bottom: 0, left: 0 }} stackOffset="sign">
                  <CartesianGrid stroke="#f1f5f9" />
                  <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={50} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload) return null;
                      const items = payload.filter(p => p.value !== 0 && p.dataKey !== "순현금흐름");
                      const cfLine = payload.find(p => p.dataKey === "순현금흐름");
                      return (
                        <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-2 text-xs">
                          <div className="font-semibold text-slate-700 mb-1">{label}세</div>
                          {items.map(p => (
                            <div key={p.dataKey} className="flex justify-between gap-4">
                              <span style={{color: p.color}}>{p.dataKey}</span>
                              <span className="num">{Math.abs(p.value).toLocaleString()}만</span>
                            </div>
                          ))}
                          {cfLine && (
                            <div className="flex justify-between gap-4 border-t border-slate-100 mt-1 pt-1 font-semibold">
                              <span>순현금흐름</span>
                              <span className="num">{cfLine.value.toLocaleString()}만</span>
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={0} stroke="#94a3b8" />
                  <Bar dataKey="본인 근로"      stackId="a" fill="#10b981" />
                  <Bar dataKey="배우자 근로"    stackId="a" fill="#34d399" />
                  <Bar dataKey="본인 국민연금"  stackId="a" fill="#3b82f6" />
                  <Bar dataKey="배우자 국민연금" stackId="a" fill="#60a5fa" />
                  <Bar dataKey="기초연금"      stackId="a" fill="#818cf8" />
                  <Bar dataKey="브릿지 월소득"  stackId="a" fill="#06b6d4" />
                  <Bar dataKey="생활비"        stackId="a" fill="#f59e0b" />
                  <Bar dataKey="양육비"        stackId="a" fill="#a855f7" />
                  <Bar dataKey="대출 상환"      stackId="a" fill="#64748b" />
                  <Bar dataKey="건강보험료"     stackId="a" fill="#ef4444" />
                  <Bar dataKey="의료비"        stackId="a" fill="#dc2626" />
                  <Bar dataKey="관리비·주거"    stackId="a" fill="#78716c" />
                  <Bar dataKey="추가저축"      stackId="a" fill="#0ea5e9" />
                  <Line type="monotone" dataKey="순현금흐름" stroke="#0f172a" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 자동 인사이트 */}
          <details className="bg-white rounded-xl border border-slate-200">
            <summary className="text-sm font-semibold p-4 cursor-pointer select-none">자동 인사이트 (상세)</summary>
            <div className="px-4 pb-4">
            <ul className="text-sm text-slate-700 space-y-1.5 leading-relaxed">
              <li>• 브릿지 기간 <b>{activeResult.bridgeYears}년</b> 동안 자산에서 인출 필요: <b className="text-red-600">{fmt만원(activeResult.bridgeShortfall)}</b> <span className="text-xs text-slate-500">(생활비 충당을 위한 금융자산 인출액)</span></li>
              {activeResult.depletionAge ? (
                <li>• <b className="text-red-600">⚠ {activeResult.depletionAge}세 자산소진</b> — 수명({activeResult.simEndAge}세)까지 <b>{activeResult.simEndAge - activeResult.depletionAge}년</b> 부족{i.spouseEnabled ? " (부부 최대 수명 기준)" : ""}</li>
              ) : (
                <li>• <span className="text-emerald-700">✓ 수명({activeResult.simEndAge}세)까지 자산이 유지됩니다.</span>{i.spouseEnabled ? " (부부 최대 수명 기준)" : ""} 수익률 비관 시나리오에서도 확인 권장.</li>
              )}
              {activeBand.pessimistic.depletionAge && !activeResult.depletionAge && (
                <li>• 비관 시나리오(수익률 −{i.scenarioBandSpread}%p)에서는 <b className="text-amber-600">{activeBand.pessimistic.depletionAge}세 소진</b> — 시장 변동성에 취약합니다.</li>
              )}
              {activeBand.sequenceShock && i.stressTest !== "none" && (
                activeBand.sequenceShock.depletionAge
                  ? <li>• <b className="text-red-700">⚡ {STRESS_PRESETS[i.stressTest]?.label}</b>: <b className="text-red-700">{activeBand.sequenceShock.depletionAge}세 자산소진</b> (준비율 {activeBand.sequenceShock.readinessRatio}%) — {STRESS_PRESETS[i.stressTest]?.desc}</li>
                  : !activeResult.depletionAge && <li>• <span className="text-emerald-700">충격({STRESS_PRESETS[i.stressTest]?.label}) 시나리오에서도 자산이 유지됩니다.</span> (준비율 {activeBand.sequenceShock.readinessRatio}%)</li>
              )}
              {activeResult.selfNpMonthly > 0 && (
                <li>• 본인 국민연금 예상: <b className="text-blue-700">{fmt만원월(activeResult.selfNpMonthly)}</b>
                  {activeResult.spouseNpMonthly > 0 && <span> / 배우자: <b className="text-blue-500">{fmt만원월(activeResult.spouseNpMonthly)}</b></span>}
                </li>
              )}
              {insights && insights.items.length > 0 && (
                <li className="pt-2 mt-2 border-t border-slate-100">
                  <div className="text-xs text-slate-500 mb-1.5">
                    {insights.mode === "relax" ? "▷ 여유가 있을 때의 선택지 (성공확률):" : "▷ 가장 효과적인 개선책:"}
                  </div>
                  <div className="space-y-1">
                    {insights.items.map(ins => (
                      <div key={ins.key} className="flex items-center justify-between gap-2 text-sm">
                        <span>{ins.label}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`num font-medium ${insights.mode === "relax" ? "text-slate-700" : "text-emerald-600"}`}>
                            {insightMetric(ins, insights.mode)}
                          </span>
                          {scenarios.length < SCENARIO_COLORS.length && (
                            <button
                              onClick={() => applyInsightAsNewScenario(ins)}
                              className="text-xs px-1.5 py-0.5 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50 whitespace-nowrap"
                              title="이 조건으로 새 시나리오 추가"
                            >+ 추가</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </li>
              )}
              {i.withdrawalStrategy !== "bucket" && (
                <li className="pt-2 mt-2 border-t border-slate-100 text-xs text-slate-500">
                  인출 전략: <b className="text-slate-700">{{ bucket: "버킷 전략", "4pct": "4% 룰 (SWR)", vpw: "VPW" }[i.withdrawalStrategy]}</b> 적용 중 (고급 {'>'} 인출 전략에서 변경)
                </li>
              )}
              {scenarios.length > 1 && (
                <li className={`${i.withdrawalStrategy !== "bucket" ? "" : "pt-2 mt-2 border-t border-slate-100"} text-xs text-slate-500`}>
                  탭의 <b className="text-slate-700">+ 비교</b> 버튼은 퇴직 나이를 +5세 → −5세 → +10세 순으로 바꾼 시나리오를 추가합니다. 편집 중인 시나리오 이름을 눌러 이름도 바꿀 수 있어요.
                </li>
              )}
            </ul>
            </div>
          </details>

          <footer className="text-xs text-slate-500 pb-8 leading-relaxed space-y-2">
            <p>
              ※ 모든 금액은 <b className="text-slate-600">현재가치(오늘 돈)</b> 기준입니다. 수익률·연봉상승률·주택상승률·대출금리는 연 % 명목 값으로 입력하며 내부에서 물가를 반영해 환산합니다.
            </p>
            <p>
              국민연금(2026 개혁안 소득대체율 43%)·기초연금·건강보험료·세금은 모두 <b className="text-slate-600">단순화한 추정</b>이며 실제와 다를 수 있습니다.
              세부 가정과 반영하지 않은 항목은 <button type="button" onClick={() => setShowAssumptions(true)} className="underline hover:text-slate-700">ⓘ 가정</button>에서 확인하세요.
            </p>
            <p>
              이 도구는 교육·참고용이며 투자·세무·연금 자문이 아닙니다. 중요한 결정 전에는 국민연금공단 '내 연금 알아보기'와 전문가 상담으로 확인하세요.
            </p>
            <details>
              <summary className="cursor-pointer select-none text-slate-600 hover:text-slate-800">용어·계산 방식 자세히</summary>
              <div className="mt-2 space-y-1.5">
                <p><b className="text-slate-600">성공확률</b>: 몬테카를로 {ASSUMPTIONS.monteCarlo.runs.toLocaleString()}회에서 수명까지 금융자산이 유지된 비율. 수익률 변동성은 고급 {'>'} 시장 가정에서 조정합니다.</p>
                <p><b className="text-slate-600">준비율</b>: 중간(고정 수익률) 시나리오에서 수명까지 자산이 남으면 100%+(남는 자산 비율에 따라 최대 300%), 중간에 바닥나면 수명 대비 버틴 비율.</p>
                <p><b className="text-slate-600">브릿지</b>: 퇴직 후 국민연금 개시 전까지 근로소득·연금이 모두 없는 기간.</p>
                <p><b className="text-slate-600">시퀀스 리스크</b>: 퇴직 직후 시장이 나빠지면 같은 평균 수익률이어도 자산이 더 빨리 줄어드는 위험. 경미(-5%p, 3년) / 중간(-10%p, 5년) / 2008(-30%→반등) 중 선택, 차트에서 토글.</p>
                <p><b className="text-slate-600">인출 전략</b>: 버킷=저축성→투자성 순 인출. 4% 룰=퇴직 자산×4% 고정. VPW=남은 수명 기준 비율 인출.</p>
                <p><b className="text-slate-600">본인·배우자 최대 수명</b> 기준으로 계산합니다. 디버그: URL에 ?debug=1 추가 시 상세 로그.</p>
              </div>
            </details>
          </footer>
        </section>
      </main>

      {/* 세로 배치(<1024px) 입력 화면 하단 바 — 입력하면서 결과 변화를 바로 확인 */}
      {isStacked && mobileView === "inputs" && (
        <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur border-t border-slate-200 px-4 pt-2.5 flex items-center justify-between gap-3"
          style={{ paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))" }}>
          <div className={`min-w-0 transition-opacity ${mcStale ? "opacity-60" : ""}`}>
            {mcResult ? (
              <>
                <span className="text-xl font-bold num align-middle">{mcResult.successRate}%</span>
                <span className="text-xs text-slate-600 ml-1.5 align-middle">성공확률 · {mcVerdict(mcResult.successRate).text}</span>
              </>
            ) : (
              <span className="text-xs text-slate-500">성공확률 계산 중…</span>
            )}
          </div>
          <button
            onClick={() => switchMobileView("results")}
            className="shrink-0 bg-slate-900 text-white rounded-full px-5 py-2.5 text-sm font-semibold shadow-lg flex items-center gap-2 active:scale-95 transition-transform"
          >
            결과 보기 →
          </button>
        </div>
      )}
    </div>
    </FieldContext.Provider>
  );
}


export { App };
