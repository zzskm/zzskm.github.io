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
    // 차트 선 색 — style.css의 --ma7/--ma14/--predict/--target과 같아야 범례 견본이 맞는다.
    actual: '#3C2F2F',
    actualFill: 'rgba(60,47,47,0.06)',
    actualPoint: '#A0522D',
    ma7: '#3C2F2F',
    ma14: '#A89F99',
    predict: '#FF6F61',
    predictFill: 'rgba(255,111,97,0.10)',
    target: '#A0522D',
    tick: '#5A4D4D',
    font: '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
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
  
  // etaStatus: reached / date / beyond(2년 안에 닿지 않음) / no_loss / unknown (P7)
  function fmtEta(goal) {
    if (goal?.etaStatus === 'beyond') return '2년 이후';
    if (goal?.etaStatus === 'no_loss') return '감량 추세 아님';
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
    if (!range || !Number.isFinite(range.min)) return null;
    const minWeeks = Math.round(range.min / 7);
    if (range.maxBeyond) return `약 ${minWeeks}주~2년 이후 범위`;
    if (!Number.isFinite(range.max)) return null;
    if (range.min === range.max) return `${range.min}일`;
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
  
  // M6: 백엔드가 시나리오마다 곡선(13점)과 80% 구간을 만든다. 그대로 쓰고, 없으면(예전 요약) 기준 예측선을 쓴다.
  function scenarioSeries(summary, scenario) {
    const series = summary?.predictions?.scenarios?.[scenario]?.series;
    if (Array.isArray(series) && series.length) return series;
    const ci = new Map((summary?.predictionCI?.series || []).map((p) => [p.date, p]));
    return (summary?.series?.prediction || []).map((p) => ({
      date: p.date,
      valueKg: p.valueKg,
      lower80: ci.get(p.date)?.lower80 ?? p.valueKg,
      upper80: ci.get(p.date)?.upper80 ?? p.valueKg,
    }));
  }

  function buildPredictionFromScenario(summary, scenario) {
    return scenarioSeries(summary, scenario).map((p) => ({ date: p.date, valueKg: p.valueKg }));
  }

  // F3: 날짜를 일 단위 숫자로 바꿔 선형 축에 그린다(시간에 비례하는 가로축). UTC 자정 기준이라 시간대와 무관하다.
  const DAY_MS = 86400000;
  function dayNumber(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d) / DAY_MS;
  }
  function dayIso(n) {
    return new Date(Math.round(n) * DAY_MS).toISOString().slice(0, 10);
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
    scenarioSeries,
    dayNumber,
    dayIso,
  };
})();
