'use strict';

(() => {
  // Light paper theme — style.css의 :root 변수와 동기화 유지
  const THEME = {
    ink: '#3C2F2F',
    inkSoft: 'rgba(60,47,47,0.78)',
    muted: 'rgba(60,47,47,0.58)',
    muted2: 'rgba(60,47,47,0.32)',
    line: 'rgba(60,47,47,0.14)',
    panel: '#FCF9F7',
    bg: '#F5F2F0',
    accent: '#FF6F61',
    accentInk: '#A0522D',
    accentTint: 'rgba(255,111,97,0.12)',
    actual: '#3C2F2F',
    actualFill: 'rgba(60,47,47,0.06)',
    ma7: 'rgba(60,47,47,0.35)',
    ma14: 'rgba(60,47,47,0.22)',
    predict: '#FF6F61',
    predictFill: 'rgba(255,111,97,0.10)',
    grid: 'rgba(60,47,47,0.08)',
    tooltipBg: '#FCF9F7',
    tooltipBorder: 'rgba(60,47,47,0.22)',
    tooltipBody: '#3C2F2F',
    plateauShade: 'rgba(160,82,45,0.10)',
    activityBar: 'rgba(160,82,45,0.28)',
    activityBarStroke: '#A0522D',
    activitySteps: 'rgba(60,47,47,0.36)',
    syncStale: '#A0522D',
    syncWarn: '#8B6F5E',
  };

  const fmtKg = (v, d=1) => Number.isFinite(v) ? `${v.toFixed(d)} kg` : '–';
  const fmtKgBare = (v, d=1) => Number.isFinite(v) ? v.toFixed(d) : '–';
  const fmtSteps = (v) => Number.isFinite(v) ? Math.round(v).toLocaleString('ko-KR') : '–';
  const fmtDate = (iso) => {
    if (!iso) return '–';
    const d = new Date(iso + 'T00:00:00');
    return `${d.getMonth()+1}월 ${d.getDate()}일`;
  };
  const fmtDateShort = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return `${d.getMonth()+1}/${d.getDate()}`;
  };
  
  function fmtEta(goal) {
    if (!goal || !Number.isFinite(goal.etaDays)) return '계산 불가';
    if (goal.etaDays <= 0) return '도달';
    const weeks = Math.floor(goal.etaDays / 7);
    const days = goal.etaDays % 7;
    if (weeks > 0 && days > 0) return `${weeks}주 ${days}일`;
    if (weeks > 0) return `${weeks}주`;
    return `${days}일`;
  }
  
  function fmtEtaRange(goal) {
    const range = goal?.etaRangeDays;
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return null;
    if (range.min === range.max) return `${range.min}일`;
    const minWeeks = Math.round(range.min / 7);
    const maxWeeks = Math.round(range.max / 7);
    return `약 ${minWeeks}~${maxWeeks}주 범위`;
  }
  
  function fmtMae(backtest) {
    return backtest?.status === 'ok' && Number.isFinite(backtest.maeKg)
      ? `MAE ${backtest.maeKg.toFixed(2)} kg`
      : '표본 부족';
  }
  
  function firstValidDaily(points) {
    for (const p of points) if (Number.isFinite(p.valueKg)) return p;
    return null;
  }
  function lastValidDaily(points) {
    for (let i = points.length - 1; i >= 0; i--) if (Number.isFinite(points[i].valueKg)) return points[i];
    return null;
  }
  
  function sliceByRange(points, rangeDays) {
    if (rangeDays === 'all' || !Array.isArray(points)) return points || [];
    const lastDate = points.length ? new Date(points[points.length - 1].date + 'T00:00:00') : new Date();
    const cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - rangeDays);
    return points.filter((p) => new Date(p.date + 'T00:00:00') >= cutoff);
  }
  
  function buildPredictionFromScenario(summary, scenario) {
    const baseSeries = summary.series?.prediction || [];
    if (!baseSeries.length) return [];
    const sc = summary.predictions?.scenarios?.[scenario];
    const baseSc = summary.predictions?.scenarios?.base;
    const scLoss = sc?.effectiveWeeklyLossKg;
    const baseLoss = baseSc?.effectiveWeeklyLossKg;
    // effectiveWeeklyLossKg 기반으로 시나리오별 예측선 스케일
    if (Number.isFinite(scLoss) && Number.isFinite(baseLoss) && baseLoss !== 0) {
      const ratio = scLoss / baseLoss;
      const start = baseSeries[0].valueKg;
      return baseSeries.map((p) => ({
        date: p.date,
        valueKg: +(start + (p.valueKg - start) * ratio).toFixed(2),
      }));
    }
    // fallback: multiplier 방식 (base 시나리오이거나 새 필드 없을 때)
    const mult = sc?.multiplier ?? 1;
    const baseMult = baseSc?.multiplier ?? 0.8;
    const start = baseSeries[0].valueKg;
    const factor = baseMult > 0 ? mult / baseMult : 1;
    return baseSeries.map((p) => ({
      date: p.date,
      valueKg: start + (p.valueKg - start) * factor,
    }));
  }

  // ---------- plateau card ----------
  // Phase 4: 정체기 type에 따라 메시지/액션 분기
  const PLATEAU_CONTENT = {
    glycogen: {
      tag: '글리코겐 정체기',
      msg: '훈련 부하 급증으로 글리코겐·수분이 일시적으로 저장된 상태일 수 있어요. 진짜 정체기가 아닐 가능성이 높습니다.',
      actions: [
        '훈련 부하 안정화 후 2~3일 재측정',
        '수분 섭취 충분히 유지',
        '주간 부하를 갑자기 늘리지 않기',
      ],
    },
    metabolic: {
      tag: '대사 정체기 감지',
      msg: '대사 적응 과정의 정상적인 현상입니다. 의지의 문제가 아니에요.',
      actions: [
        '운동 강도 또는 시간 10% 늘리기',
        '탄수화물 비중 일시 조정 (재공급)',
        '수면 7시간 이상 확보',
      ],
    },
  };

  window.GWAppHelpers = {
    THEME,
    PLATEAU_CONTENT,
    fmtKg,
    fmtKgBare,
    fmtSteps,
    fmtDate,
    fmtDateShort,
    fmtEta,
    fmtEtaRange,
    fmtMae,
    firstValidDaily,
    lastValidDaily,
    sliceByRange,
    buildPredictionFromScenario,
  };
})();
