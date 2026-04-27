'use strict';

(() => {
  const SUMMARY_URL = './data/summary.json';
  const CONFIG_URL = './config.json';

  const state = {
    summary: null,
    config: null,
    range: 60,
    scenario: 'base',
    visible: { ma7: true, ma14: false, prediction: true },
    chart: null,
    activityChart: null,
  };

  const el = (id) => document.getElementById(id);
  const appRoot = document.querySelector('.app');

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

  function setText(id, v) { const n = el(id); if (n) n.textContent = v; }

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
    const base = summary.series?.prediction || [];
    if (!base.length) return [];
    const mult = summary.predictions?.scenarios?.[scenario]?.multiplier ?? 1;
    const baseMult = summary.predictions?.scenarios?.base?.multiplier ?? 0.8;
    const start = base[0].valueKg;
    const factor = baseMult > 0 ? mult / baseMult : 1;
    return base.map((p) => ({
      date: p.date,
      valueKg: start + (p.valueKg - start) * factor,
    }));
  }

  function weekdayAverages(points) {
    const sums = Array(7).fill(0);
    const counts = Array(7).fill(0);
    for (const p of points) {
      if (!Number.isFinite(p.valueKg)) continue;
      const d = new Date(p.date + 'T00:00:00');
      const w = d.getDay();
      sums[w] += p.valueKg;
      counts[w] += 1;
    }
    return sums.map((s, i) => counts[i] ? s / counts[i] : null);
  }

  // ---------- hero ----------
  function renderHero() {
    const s = state.summary;
    const cfg = state.config;
    const daily = s.series?.daily || [];
    const start = firstValidDaily(daily);
    const last = lastValidDaily(daily);
    const target = cfg?.targetWeightKg ?? 80;

    setText('currentWeight', fmtKgBare(s.current?.weightKg));
    setText('currentDate', s.current?.weightDate ? fmtDate(s.current.weightDate) + ' 측정' : '–');

    if (start && last) {
      const delta = last.valueKg - start.valueKg;
      const de = el('currentDelta');
      de.textContent = `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} kg 시작 대비`;
      de.className = 'delta ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : '');
    }

    // EWMA 추세 체중
    const ewmaKg = s.current?.weightEwmaKg;
    setText('trendWeight', Number.isFinite(ewmaKg) ? `${ewmaKg.toFixed(1)} kg` : '–');

    setText('ma7Weight', fmtKgBare(s.current?.weightMa7Kg));
    const ma7Diff = (s.current?.weightKg ?? 0) - (s.current?.weightMa7Kg ?? 0);
    if (Number.isFinite(ma7Diff)) {
      setText('ma7Delta', `현재 ${ma7Diff >= 0 ? '+' : '−'}${Math.abs(ma7Diff).toFixed(1)} kg`);
    }

    // 감량 강도 게이지
    const rate = s.rolling?.weeklyLossRateKg;
    setText('weeklyLossRate', Number.isFinite(rate) ? `−${rate.toFixed(2)} kg/주` : '–');
    renderIntensityGauge(s.lossIntensity);

    setText('goalEta', fmtEta(s.goal));
    setText('goalEtaDate', s.goal?.etaDate ? `${fmtDate(s.goal.etaDate)} 예상` : '–');

    if (start && last) {
      const total = start.valueKg - target;
      const done = start.valueKg - last.valueKg;
      const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
      setText('goalProgressPct', pct.toFixed(0));
      el('progressFill').style.width = pct + '%';
      el('progressMarker').style.left = pct + '%';

      setText('startWeight', fmtKg(start.valueKg));
      setText('targetWeight', fmtKg(target));

      const remaining = s.goal?.remainingKg ?? (last.valueKg - target);
      setText('goalSubtitle', remaining > 0
        ? `목표까지 ${remaining.toFixed(1)} kg · 현 속도로 ${fmtEta(s.goal)} 소요`
        : `목표 도달 — 현재 ${last.valueKg.toFixed(1)} kg`);
    }

    // Scenarios
    const sc = s.predictions?.scenarios || {};
    setText('scenarioOpt', sc.optimistic ? fmtKg(sc.optimistic.threeMonthWeightKg) : '–');
    setText('scenarioBase', sc.base ? fmtKg(sc.base.threeMonthWeightKg) : '–');
    setText('scenarioCon', sc.conservative ? fmtKg(sc.conservative.threeMonthWeightKg) : '–');
    renderScenarioCompare(s.lossIntensity, state.scenario);
  }

  // ---------- intensity gauge ----------
  const INTENSITY_LEVELS = ['maintaining', 'conservative', 'standard', 'aggressive'];
  const INTENSITY_LABELS = {
    maintaining: '유지 중',
    conservative: '보수적',
    standard: '표준',
    aggressive: '공격적',
  };

  function renderIntensityGauge(intensity) {
    const gauge = el('intensityGauge');
    if (!gauge) return;
    const level = intensity?.level ?? null;
    gauge.querySelectorAll('.intensity-dot').forEach(dot => {
      dot.classList.toggle('is-active', dot.dataset.level === level);
    });
    const pct = intensity?.weeklyPct;
    const label = level ? `${INTENSITY_LABELS[level] ?? level}${Number.isFinite(pct) ? ` · ${pct.toFixed(2)}%/주` : ''}` : '–';
    setText('intensityLabel', label);
    const metric = el('intensityMetric');
    if (metric && intensity) {
      const deficit = intensity.dailyDeficitKcal;
      metric.title = Number.isFinite(deficit) ? `일일 결핍 추정 약 ${deficit} kcal` : '';
    }
  }

  // ---------- insight card ----------
  function renderInsight(insight) {
    const card = el('insightCard');
    if (!card) return;
    const headline = insight?.headline;
    if (!headline) { card.hidden = true; return; }
    setText('insightHeadline', headline);
    card.hidden = false;
  }

  // ---------- plateau card ----------
  function renderPlateau(plateau) {
    const card = el('plateauCard');
    if (!card) return;
    if (!plateau?.detected) { card.hidden = true; return; }
    setText('plateauDuration', `${plateau.durationDays}일째`);
    card.hidden = false;
  }

  // ---------- scenario compare label ----------
  function renderScenarioCompare(intensity, scenario) {
    const label = el('scenariosCurrent');
    if (!label) return;
    if (!intensity) { label.hidden = true; return; }
    const currentLabel = INTENSITY_LABELS[intensity.level] ?? intensity.level;
    const scenarioMap = { optimistic: '공격적', base: '표준', conservative: '보수적' };
    const selectedLabel = scenarioMap[scenario] ?? scenario;
    if (currentLabel === selectedLabel) {
      label.hidden = true;
      return;
    }
    label.textContent = `현재 ${currentLabel} · 시나리오 ${selectedLabel}`;
    label.hidden = false;
  }

  // ---------- bottom: variability + coverage ----------
  function renderBottom() {
    const s = state.summary;

    const range = s.rolling?.last7WeightRangeKg;
    setText('weightRange', Number.isFinite(range) ? `${range.toFixed(1)} kg` : '–');
    setText('weightRangeHint',
      Number.isFinite(range)
        ? range < 1 ? '매우 안정적 — 수분/식사 변동 범위' : range < 2 ? '정상 범위 내' : '변동이 큼 — 측정 시각 확인 권장'
        : '–');
    const validDaily = (s.series?.daily || []).filter(p => Number.isFinite(p.valueKg)).slice(-14);
    drawSparkline('sparkRange', validDaily.map(d => d.valueKg));

    const last30 = (s.series?.daily || []).slice(-30);
    const logged = last30.filter(p => Number.isFinite(p.valueKg)).length;
    const pct = last30.length ? Math.round((logged / last30.length) * 100) : 0;
    setText('logCoverage', `${pct}%`);
    setText('coverageHint', `■ ${logged}일 측정  □ ${last30.length - logged}일 없음 · 각 칸 = 하루`);
    drawCoverageDots('coverageDots', last30);

    // Activity summary
    const minutes = s.rolling?.last7ExerciseMinutes ?? 0;
    setText('exerciseMinutes', fmtSteps(minutes));
    setText('activeDays', `${s.rolling?.last7ActiveDays ?? 0}`);
    setText('stepsAvg', fmtSteps(s.rolling?.last7StepsAvg));
    setText('stepsTotal', `총 ${fmtSteps(s.rolling?.last7StepsTotal)} 걸음`);
  }

  function drawSparkline(id, values) {
    const host = el(id);
    if (!host || !values.length) { if (host) host.innerHTML = ''; return; }
    const w = 100, h = 32, pad = 2;
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 1;
    const pts = values.map((v, i) => {
      const x = pad + (i / (values.length - 1 || 1)) * (w - pad * 2);
      const y = pad + (1 - (v - min) / range) * (h - pad * 2);
      return [x, y];
    });
    const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const area = d + ` L${w - pad},${h - pad} L${pad},${h - pad} Z`;
    const last = pts[pts.length - 1];
    host.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <path d="${area}" fill="rgba(17,17,17,0.05)" />
        <path d="${d}" fill="none" stroke="#2b2b2b" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${last[0]}" cy="${last[1]}" r="2" fill="#c25a31"/>
      </svg>`;
  }

  function drawCoverageDots(id, last30) {
    const host = el(id);
    if (!host) return;
    const todayIso = last30.length ? last30[last30.length - 1].date : null;
    host.innerHTML = last30.map((p) => {
      const has = Number.isFinite(p.valueKg);
      const cls = has ? (p.date === todayIso ? 'dot-cell has-today' : 'dot-cell has') : 'dot-cell';
      return `<span class="${cls}" title="${p.date}${has ? ' · ' + p.valueKg.toFixed(1) + 'kg' : ' · 기록 없음'}"></span>`;
    }).join('');
  }

  // ---------- weekday ----------
  function renderWeekday() {
    const host = el('weekdayChart');
    if (!host) return;
    const daily = state.summary.series?.daily || [];
    const avgs = weekdayAverages(daily);
    const valid = avgs.filter(v => v !== null);
    if (!valid.length) { host.innerHTML = '<p class="insight-text" style="margin:auto">데이터 없음</p>'; return; }
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const r = max - min || 1;
    const labels = ['일', '월', '화', '수', '목', '금', '토'];

    host.innerHTML = avgs.map((v, i) => {
      if (v === null) return `
        <div class="weekday-col">
          <div class="weekday-bar" style="height:2%; opacity:0.3"></div>
          <span class="weekday-label">${labels[i]}</span>
        </div>`;
      const heightPct = 20 + ((v - min) / r) * 80;
      const isHi = v === max;
      return `
        <div class="weekday-col">
          <span class="weekday-val">${v.toFixed(1)}</span>
          <div class="weekday-bar ${isHi ? 'is-hi' : ''}" style="height:${heightPct}%"></div>
          <span class="weekday-label">${labels[i]}</span>
        </div>`;
    }).join('');

    const hiIdx = avgs.indexOf(max);
    const loIdx = avgs.indexOf(min);
    if (hiIdx >= 0 && loIdx >= 0) {
      const diff = (max - min).toFixed(1);
      setText('insightText',
        `${labels[hiIdx]}요일이 평균 ${fmtKgBare(max)} kg로 가장 무겁고, ${labels[loIdx]}요일이 ${fmtKgBare(min)} kg로 가장 가볍습니다. 요일 간 차이 ${diff} kg.`);
    }
  }

  // ---------- weight chart ----------
  function buildCiBands(s, scenario) {
    const ci = s.predictionCI?.series || [];
    if (!ci.length) return { upper: [], lower: [] };
    const mult = s.predictions?.scenarios?.[scenario]?.multiplier ?? 0.8;
    const baseMult = s.predictions?.scenarios?.base?.multiplier ?? 0.8;
    const factor = baseMult > 0 ? mult / baseMult : 1;
    const ewmaLast = s.series?.ewma?.slice(-1)[0]?.valueKg ?? null;
    return {
      upper: ci.map(p => ({ date: p.date, valueKg: ewmaLast !== null ? ewmaLast + (p.upper80 - p.central) * factor : p.upper80 })),
      lower: ci.map(p => ({ date: p.date, valueKg: ewmaLast !== null ? ewmaLast + (p.lower80 - p.central) * factor : p.lower80 })),
    };
  }

  function makePlateauPlugin(s, labels) {
    const plateau = s.plateau;
    if (!plateau?.detected || !plateau.startDate) return null;
    return {
      id: 'plateauShade',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        const xScale = scales.x;
        if (!xScale) return;
        const startIdx = labels.indexOf(plateau.startDate);
        const endIdx = labels.length - 1;
        if (startIdx < 0) return;
        const x1 = xScale.getPixelForValue(startIdx);
        const x2 = xScale.getPixelForValue(endIdx);
        ctx.save();
        ctx.fillStyle = 'rgba(217,119,6,0.06)';
        ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
        ctx.restore();
      },
    };
  }

  function renderChart() {
    const canvas = el('weightChart');
    if (!canvas || !window.Chart) return;

    const s = state.summary;
    const cfg = state.config; // config 데이터 참조
    
    const target = cfg?.targetWeightKg ?? 80; 
    const yMin = Math.floor(target - 2);

    const daily = sliceByRange(s.series?.daily || [], state.range);
    const ewma = sliceByRange(s.series?.ewma || [], state.range);
    const ma14 = sliceByRange(s.series?.ma14 || [], state.range);
    const prediction = buildPredictionFromScenario(s, state.scenario);
    const ci = buildCiBands(s, state.scenario);

    const labelSet = new Set();
    [daily, ewma, ma14, prediction, ci.upper, ci.lower].forEach(arr => arr.forEach(p => labelSet.add(p.date)));
    const labels = Array.from(labelSet).sort();

    const align = (arr, key = 'valueKg') => {
      const m = new Map(arr.map(p => [p.date, p[key] ?? p.valueKg]));
      return labels.map(d => m.has(d) ? m.get(d) : null);
    };

    if (state.chart) state.chart.destroy();

    const datasets = [];

    // MA14 (softest, optional)
    if (state.visible.ma14) {
      datasets.push({
        label: '14일 평균',
        data: align(ma14),
        borderColor: '#d8d8d4',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.35,
        spanGaps: true,
        fill: false,
        order: 4,
      });
    }

    // EWMA 추세선 (MA7 칩으로 제어)
    if (state.visible.ma7) {
      datasets.push({
        label: '추세',
        data: align(ewma),
        borderColor: '#b8b8b4',
        borderWidth: 1.75,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.35,
        spanGaps: true,
        fill: false,
        order: 3,
      });
    }

    // 예측 CI 밴드 (upper80 → lower80 fill)
    if (state.visible.prediction) {
      datasets.push({
        label: '_ciUpper',
        data: align(ci.upper),
        borderColor: 'transparent',
        borderWidth: 0,
        pointRadius: 0,
        spanGaps: true,
        fill: '+1',
        backgroundColor: 'rgba(194,90,49,0.10)',
        tension: 0.25,
        order: 2,
      });
      datasets.push({
        label: '_ciLower',
        data: align(ci.lower),
        borderColor: 'transparent',
        borderWidth: 0,
        pointRadius: 0,
        spanGaps: true,
        fill: false,
        tension: 0.25,
        order: 2,
      });
      // 예측 중앙선 (accent, dashed)
      datasets.push({
        label: '예측',
        data: align(prediction),
        borderColor: '#c25a31',
        borderWidth: 1.75,
        borderDash: [5, 4],
        pointRadius: 0,
        pointHoverRadius: 4,
        pointBackgroundColor: '#c25a31',
        tension: 0.25,
        spanGaps: true,
        fill: false,
        order: 1,
      });
    }

    // 실제 측정값 (항상 표시)
    datasets.push({
      label: '실제',
      data: align(daily),
      borderColor: '#c25a31',
      backgroundColor: 'rgba(194,90,49,0.06)',
      borderWidth: 2.5,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBackgroundColor: '#111111',
      pointBorderColor: '#ffffff',
      pointBorderWidth: 1.5,
      tension: 0.3,
      spanGaps: true,
      fill: true,
      order: 0,
    });

    // 정체기 플러그인
    const ewmaMap = new Map((s.series?.ewma || []).map(p => [p.date, p.valueKg]));
    const plateauPlugin = makePlateauPlugin(s, labels);
    const plugins = plateauPlugin ? [plateauPlugin] : [];

    state.chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      plugins,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 650, easing: 'easeOutCubic' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#111111',
            titleColor: '#ffffff',
            bodyColor: '#e6e6e4',
            padding: 10,
            cornerRadius: 6,
            titleFont: { family: 'Inter Tight', weight: '600', size: 12 },
            bodyFont: { family: 'JetBrains Mono', size: 11.5 },
            boxPadding: 4,
            filter: (item) => !item.dataset.label.startsWith('_'),
            callbacks: {
              title: (items) => items[0] ? fmtDateShort(items[0].label) : '',
              label: (ctx) => {
                if (ctx.dataset.label === '실제') {
                  const dateKey = ctx.label;
                  const ewmaVal = ewmaMap.get(dateKey);
                  const actualVal = ctx.parsed.y;
                  if (Number.isFinite(ewmaVal) && Number.isFinite(actualVal)) {
                    const diff = actualVal - ewmaVal;
                    const sign = diff >= 0 ? '+' : '−';
                    return [
                      ` 실제  ${fmtKg(actualVal)}`,
                      ` 추세  ${fmtKg(ewmaVal)}`,
                      ` 편차  ${sign}${Math.abs(diff).toFixed(1)} kg`,
                    ];
                  }
                  return ` 실제  ${fmtKg(ctx.parsed.y)}`;
                }
                if (ctx.dataset.label === '예측') {
                  const dateKey = ctx.label;
                  const ciPoint = (s.predictionCI?.series || []).find(p => p.date === dateKey);
                  if (ciPoint) {
                    return [
                      ` 예측  ${fmtKg(ctx.parsed.y)}`,
                      ` 80%  ${fmtKgBare(ciPoint.lower80)} – ${fmtKgBare(ciPoint.upper80)} kg`,
                    ];
                  }
                }
                return ` ${ctx.dataset.label}  ${fmtKg(ctx.parsed.y)}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(17,17,17,0.04)', drawTicks: false },
            border: { display: false },
            ticks: {
              color: '#9a9a96',
              font: { family: 'JetBrains Mono', size: 10.5 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
              callback(val) { return fmtDateShort(this.getLabelForValue(val)); },
            },
          },
          y: {
            min: yMin,
            grid: { color: 'rgba(17,17,17,0.04)', drawTicks: false },
            border: { display: false },
            ticks: {
              color: '#9a9a96',
              font: { family: 'JetBrains Mono', size: 10.5 },
              callback: (v) => `${v}`,
              padding: 8,
            },
          },
        },
      },
    });
  }

  // ---------- activity chart: MINUTES primary, STEPS secondary ----------
  function renderActivityChart() {
    const canvas = el('activityChart');
    if (!canvas || !window.Chart) return;

    const s = state.summary;
    const stepsSeries = s.series?.steps || [];
    const minutesSeries = s.series?.exerciseMinutes || [];
    const labels = stepsSeries.map(p => p.date);
    const minutesByDate = new Map(minutesSeries.map(p => [p.date, p.value]));
    const minutesArr = labels.map(d => minutesByDate.get(d) ?? 0);
    const stepsArr = stepsSeries.map(p => p.value ?? 0);
    const hasMinutes = minutesArr.some(v => v > 0);

    setText('activityRange', labels.length ? `${fmtDateShort(labels[0])} – ${fmtDateShort(labels[labels.length-1])}` : '–');

    if (state.activityChart) state.activityChart.destroy();

    const datasets = [
      {
        type: 'bar',
        label: '운동 시간',
        data: minutesArr,
        backgroundColor: 'rgba(31, 90, 116, 0.45)',
        borderColor: '#1f5a74',
        borderWidth: 0,
        borderRadius: 2,
        barPercentage: 0.7,
        categoryPercentage: 0.9,
        yAxisID: 'yMinutes',
        order: 1,
      },
      {
        type: 'line',
        label: '걸음 수',
        data: stepsArr,
        borderColor: '#c8c8c4',
        backgroundColor: 'transparent',
        borderWidth: 1.25,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.35,
        yAxisID: 'ySteps',
        order: 2,
      },
    ];

    state.activityChart = new Chart(canvas, {
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            align: 'end',
            labels: {
              color: '#6b6b68',
              usePointStyle: true,
              boxWidth: 8,
              font: { family: 'Inter Tight', size: 11.5 },
            },
          },
          tooltip: {
            backgroundColor: '#111111',
            titleColor: '#ffffff',
            bodyColor: '#e6e6e4',
            padding: 10,
            cornerRadius: 6,
            callbacks: {
              title: (items) => items[0] ? fmtDateShort(items[0].label) : '',
              label: (ctx) => {
                if (ctx.dataset.label === '운동 시간') return ` 운동: ${ctx.parsed.y}분`;
                return ` 걸음: ${Math.round(ctx.parsed.y).toLocaleString('ko-KR')}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: '#9a9a96',
              font: { family: 'JetBrains Mono', size: 10 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 6,
              callback(val) { return fmtDateShort(this.getLabelForValue(val)); },
            },
          },
          yMinutes: {
            position: 'left',
            beginAtZero: true,
            suggestedMax: hasMinutes ? undefined : 10,
            grid: { color: 'rgba(17,17,17,0.04)', drawTicks: false },
            border: { display: false },
            ticks: {
              color: '#6b6b68',
              font: { family: 'JetBrains Mono', size: 10 },
              stepSize: hasMinutes ? undefined : 2,
              precision: 0,
              callback: (v) => Number.isInteger(v) ? `${v}분` : '',
              padding: 6,
            },
            title: { display: false },
          },
          ySteps: {
            position: 'right',
            beginAtZero: true,
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: '#c8c8c4',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: (v) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v,
              padding: 6,
            },
            title: { display: false },
          },
        },
      },
    });
  }

  // ---------- prediction-only update (scenario switch) ----------
  function updatePrediction() {
    if (!state.chart) return;
    const s = state.summary;
    const prediction = buildPredictionFromScenario(s, state.scenario);
    const ci = buildCiBands(s, state.scenario);
    const labels = state.chart.data.labels;

    const toMap = (arr) => new Map(arr.map(p => [p.date, p.valueKg]));
    const remap = (m) => labels.map(d => m.has(d) ? m.get(d) : null);

    const predDataset = state.chart.data.datasets.find(d => d.label === '예측');
    if (predDataset) predDataset.data = remap(toMap(prediction));

    const upper = state.chart.data.datasets.find(d => d.label === '_ciUpper');
    if (upper) upper.data = remap(toMap(ci.upper));

    const lower = state.chart.data.datasets.find(d => d.label === '_ciLower');
    if (lower) lower.data = remap(toMap(ci.lower));

    state.chart.update('none');
    renderScenarioCompare(s.lossIntensity, state.scenario);
  }

  // ---------- interactions ----------
  function bindControls() {
    document.querySelectorAll('.seg-btn[data-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.range;
        state.range = r === 'all' ? 'all' : parseInt(r, 10);
        document.querySelectorAll('.seg-btn[data-range]').forEach(b => b.classList.toggle('is-active', b === btn));
        renderChart();
      });
    });

    document.querySelectorAll('.chip[data-series]').forEach(chip => {
      const key = chip.dataset.series;
      const input = chip.querySelector('input');
      input.checked = !!state.visible[key];
      input.addEventListener('change', () => {
        state.visible[key] = input.checked;
        renderChart();
      });
    });

    document.querySelectorAll('.scenario[data-scenario]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.scenario = btn.dataset.scenario;
        document.querySelectorAll('.scenario').forEach(b => b.classList.toggle('is-active', b === btn));
        updatePrediction();
      });
    });

    el('reloadBtn').addEventListener('click', () => load());

    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.key === 'r' || e.key === 'R') load();
      if (e.key === '1') document.querySelector('.seg-btn[data-range="30"]').click();
      if (e.key === '2') document.querySelector('.seg-btn[data-range="60"]').click();
      if (e.key === '3') document.querySelector('.seg-btn[data-range="all"]').click();
    });
  }

  async function load() {
    const reload = el('reloadBtn');
    reload.classList.add('is-spinning');
    reload.disabled = true;
    try {
      const [summaryRes, configRes] = await Promise.all([
        fetch(`${SUMMARY_URL}?ts=${Date.now()}`, { cache: 'no-store' }),
        fetch(`${CONFIG_URL}?ts=${Date.now()}`, { cache: 'no-store' }),
      ]);
      if (!summaryRes.ok) throw new Error(`summary.json (${summaryRes.status})`);
      if (!configRes.ok) throw new Error(`config.json (${configRes.status})`);
      state.summary = await summaryRes.json();
      state.config = await configRes.json();

      renderHero();
      renderBottom();
      renderInsight(state.summary.insight);
      renderPlateau(state.summary.plateau);
      renderChart();
      renderActivityChart();

      const gen = state.summary.generatedAt ? new Date(state.summary.generatedAt) : null;
      const cov = state.summary.coverage;
      const covText = cov ? ` · 측정 ${cov.last30Measured}/${cov.last30Total}일 (${cov.last30Pct}%)` : '';
      const lowCoverage = cov && cov.last30Pct < 70;
      const syncPill = el('lastSync');
      const syncDot = syncPill?.querySelector('.sync-dot');
      if (syncDot) syncDot.style.background = lowCoverage ? '#d97706' : '';
      syncPill.querySelector('.sync-text').textContent = gen
        ? `동기화 ${gen.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${covText}`
        : '데이터 로드됨';
      setText('statusLine',
        `${state.config?.displayName || '체중 트래커'} · 목표 ${fmtKg(state.config?.targetWeightKg)} · ${(state.summary.series?.daily || []).length}일 기록`);

      appRoot.dataset.state = 'ready';
    } catch (err) {
      appRoot.dataset.state = 'error';
      el('lastSync').querySelector('.sync-text').textContent = '로드 실패';
      setText('statusLine', `데이터를 불러오지 못했습니다: ${err.message}`);
      console.error(err);
    } finally {
      reload.classList.remove('is-spinning');
      reload.disabled = false;
    }
  }

  bindControls();
  load();
})();
