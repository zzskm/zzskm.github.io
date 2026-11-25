'use strict';

(() => {
  // 차트와 동기화 표시에 쓰는 색. 화면의 나머지 색은 style.css의 :root 변수다.
  const THEME = {
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
    syncStale: '#A0522D',
    syncWarn: '#8B6F5E',
  };

  const fmtKg = (v, d=1) => Number.isFinite(v) ? `${v.toFixed(d)} kg` : '–';
  const fmtKgBare = (v, d=1) => Number.isFinite(v) ? v.toFixed(d) : '–';

  // 주간 감량률(양수 = 감량)을 체중 변화 방향으로 적는다: 감량은 −, 증량은 +.
  // 반올림하면 0인 값은 ±0.00이다. 예전에는 −0.00이나 +0.00으로 나왔다.
  function fmtWeekly(lossKg, digits = 2) {
    if (!Number.isFinite(lossKg)) return '–';
    const magnitude = Math.abs(lossKg).toFixed(digits);
    if (Number(magnitude) === 0) return `±${magnitude}`;
    return `${lossKg > 0 ? '−' : '+'}${magnitude}`;
  }

  // 수집 엔드포인트의 화면용 이름(sync.failedEndpoints).
  const ENDPOINT_LABELS = {
    get_stats: '일일 요약',
    get_heart_rates: '심박',
    get_sleep_data: '수면',
    get_body_composition: '체성분',
    get_activities_fordate: '활동',
    get_activities_by_date: '활동',
    get_training_readiness: '훈련 준비도',
    get_training_status: '훈련 상태',
  };
  const endpointLabels = (names) => [...new Set((names || []).map((name) => ENDPOINT_LABELS[name] || String(name)))];

  // 백테스트 모델의 화면용 이름(modelDiagnostics.modelAudit의 키).
  const MODEL_LABELS = {
    current: '운영 · EWMA 혼합',
    ewma_flat: '변화 없음',
    ma7: '최근 7회 평균',
    linreg_28d: '28일 회귀',
    linreg_56d: '56일 회귀',
    linreg_84d: '84일 회귀',
    weighted_linreg_56d: '56일 가중 회귀',
    robust_56d: '56일 강건 회귀',
    kalman: 'Kalman',
  };
  const modelLabel = (name) => MODEL_LABELS[name] || String(name);

  // 오늘 날짜(KST, YYYY-MM-DD). 요약의 날짜가 모두 KST 기준이다.
  const todayKst = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

  // 마지막 체중 측정 후 지난 날 수. 요약이 센 값(요약의 마지막 날 기준)과 실제 오늘 기준 중 큰 쪽이다.
  // 수집이 멈추면 요약의 마지막 날이 오늘이 아니므로, 요약의 값만 보면 며칠 전 측정이 "오늘 측정"으로 남는다.
  function measurementAgeDays(coverage, today = todayKst()) {
    const fromSummary = coverage?.daysSinceLastMeasurement;
    const last = coverage?.lastMeasurementAt;
    const fromToday = last ? Math.round((Date.parse(today) - Date.parse(last)) / 86400000) : NaN;
    const candidates = [fromSummary, fromToday].filter(Number.isFinite);
    return candidates.length ? Math.max(0, ...candidates) : null;
  }
  // 날짜 글자. reference(YYYY-MM-DD)를 주면 그 해와 다른 해의 날짜에 연도를 붙인다.
  // 연도가 없어서 460일 뒤의 도달일이 "2/28"로만 나왔다(재검토 FE1).
  const yearOf = (iso) => Number(String(iso).slice(0, 4));
  const fmtDate = (iso, reference) => {
    if (!iso) return '–';
    const d = new Date(iso + 'T00:00:00');
    const text = `${d.getMonth()+1}월 ${d.getDate()}일`;
    return reference && yearOf(reference) !== d.getFullYear() ? `${d.getFullYear()}년 ${text}` : text;
  };
  const fmtDateShort = (iso, reference) => {
    const d = new Date(iso + 'T00:00:00');
    const text = `${d.getMonth()+1}/${d.getDate()}`;
    return reference && yearOf(reference) !== d.getFullYear() ? `${d.getFullYear()}/${text}` : text;
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

  // F3: 날짜를 일 단위 숫자로 바꿔 선형 축에 그린다(시간에 비례하는 가로축). UTC 자정 기준이라 시간대와 무관하다.
  const DAY_MS = 86400000;
  function dayNumber(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d) / DAY_MS;
  }
  function dayIso(n) {
    return new Date(Math.round(n) * DAY_MS).toISOString().slice(0, 10);
  }

  // 차트에 그릴 예측 주 수. 보이는 과거가 pastDays일이면 예측은 그 절반까지라서 차트 폭의 1/3을 넘지 않는다
  // (재검토 FE1의 결정). 예측 점이 주 단위라 주 단위로 자른다. 이력이 2주에 못 미쳐도 1주는 그린다.
  const FORECAST_MAX_WEEKS = 12;
  function forecastWeeks(pastDays) {
    if (!Number.isFinite(pastDays)) return FORECAST_MAX_WEEKS;
    return Math.max(1, Math.min(FORECAST_MAX_WEEKS, Math.floor(pastDays / 14)));
  }

  // 가로축 눈금(일 번호). 날, 주(월요일), 달(1일)의 경계에만 놓고, maxTicks개를 넘지 않는 가장 촘촘한 간격을 고른다.
  // 예전 눈금은 일 번호의 배수라서 9/25, 10/24, 12/13처럼 달력과 맞지 않았다(재검토 FE1).
  const MONDAY = 4; // 1970-01-05(일 번호 4)가 월요일이다
  function dateTicks(min, max, maxTicks) {
    const first = Math.ceil(min);
    const last = Math.floor(max);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
    const everyDays = (step, anchor) => {
      const out = [];
      for (let n = first + ((((anchor - first) % step) + step) % step); n <= last; n += step) out.push(n);
      return out;
    };
    const everyMonths = (step) => {
      const out = [];
      const start = new Date(first * DAY_MS);
      let year = start.getUTCFullYear();
      let month = start.getUTCMonth();
      for (;;) {
        const n = Date.UTC(year, month, 1) / DAY_MS;
        if (n > last) break;
        if (n >= first && month % step === 0) out.push(n);
        month += 1;
        if (month > 11) { month = 0; year += 1; }
      }
      return out;
    };
    const limit = Math.max(2, Math.floor(maxTicks) || 2);
    const candidates = [
      () => everyDays(1, 0), () => everyDays(2, 0), () => everyDays(7, MONDAY), () => everyDays(14, MONDAY),
      () => everyMonths(1), () => everyMonths(2), () => everyMonths(3), () => everyMonths(6), () => everyMonths(12),
    ];
    let widest = [];
    for (const build of candidates) {
      const ticks = build();
      if (!ticks.length) continue;
      if (ticks.length <= limit) return ticks;
      widest = ticks;
    }
    // 몇 해에 걸친 좁은 차트: 해의 첫날 눈금을 고르게 솎는다.
    const stride = Math.ceil(widest.length / limit);
    return widest.filter((_, index) => index % stride === 0);
  }

  // 눈금 글자. 해가 바뀌는 눈금에는 둘째 줄에 연도를 적는다. 축이 두 해에 걸치면 첫 눈금에도 적는다.
  function tickLabel(value, previous, spansYears) {
    const iso = dayIso(value);
    const year = yearOf(iso);
    const marksYear = previous == null ? Boolean(spansYears) : yearOf(dayIso(previous)) !== year;
    return marksYear ? [fmtDateShort(iso), String(year)] : fmtDateShort(iso);
  }

  window.GWAppHelpers = {
    THEME,
    fmtKg,
    fmtKgBare,
    fmtWeekly,
    endpointLabels,
    modelLabel,
    todayKst,
    measurementAgeDays,
    fmtDate,
    fmtDateShort,
    fmtEta,
    fmtEtaRange,
    firstValidDaily,
    lastValidDaily,
    sliceByRange,
    scenarioSeries,
    dayNumber,
    dayIso,
    yearOf,
    forecastWeeks,
    dateTicks,
    tickLabel,
  };
})();
