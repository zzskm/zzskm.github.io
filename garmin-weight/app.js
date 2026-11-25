'use strict';

(() => {
  const SUMMARY_URL = './data/summary.json';
  const CONFIG_URL = './config.json';
  // 예약 수집은 하루 2회이고 실행이 몇 시간씩 밀린다. 10월 이후 성공 간격의 최댓값이 23.3시간이었으므로
  // 24시간이 넘으면 한 번 이상 수집에 실패한 것으로 본다.
  const SYNC_LATE_HOURS = 24;

  const state = {
    summary: null,
    config: null,
    range: 60,
    scenario: 'base',
    // index.html의 칩 기본값(14일 평균은 꺼짐)과 같아야 한다.
    visible: { ma7: true, ma14: false, prediction: true },
    chart: null,
  };

  const el = (id) => document.getElementById(id);
  const appRoot = document.querySelector('.app');

  const {
    THEME,
    fmtKg,
    fmtKgBare,
    fmtWeekly,
    endpointLabels,
    modelLabel,
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
  } = window.GWAppHelpers;

  // 날짜에 연도를 붙일지 정하는 기준일: 요약의 마지막 날이다. 이 해와 다른 해의 날짜에만 연도가 붙는다.
  const referenceDate = () => {
    const daily = state.summary?.series?.daily || [];
    return daily.length ? daily[daily.length - 1].date : null;
  };

  function setText(id, v) { const n = el(id); if (n) n.textContent = v; }

  function renderHero() {
    const s = state.summary;
    const cfg = state.config;
    const daily = s.series?.daily || [];
    const start = firstValidDaily(daily);
    const last = lastValidDaily(daily);
    const target = cfg?.targetWeightKg ?? 80;

    const diagnostics = s.modelDiagnostics || {};
    const confidence = diagnostics.confidence || {};
    // modelDiagnostics.coverage(측정일 수)와 최상위 coverage(마지막 측정 경과일 포함)는 키가 다르다.
    const coverage = diagnostics.coverage || s.coverage || {};
    const topCoverage = s.coverage || {};
    const bt14 = diagnostics.backtest?.['14d'];
    const trendWindows = diagnostics.trendWindows || {};
    const rolling = s.rolling || {};
    const current = s.current || {};

    const hasData = Boolean(last);
    const trendKg = Number.isFinite(current.weightEwmaKg) ? current.weightEwmaKg : null;
    const weeklyChange = Number.isFinite(rolling.lossRateDetail?.blended) ? rolling.lossRateDetail.blended : null;
    const confidenceLevel = confidence.level || 'low';
    const confidenceLabel = confidence.label || '낮음';
    // 3개월 예측이 "변화 없음"보다 나은지는 신뢰도 등급과 따로 본다(재검토 MD5). ok가 아니면 장기 값에 표시를 붙인다.
    const longRangeCaveat = hasData && diagnostics.longRange && diagnostics.longRange.status !== 'ok';

    const startVal = start ? start.valueKg : null;
    const lastVal = last ? last.valueKg : null;
    setText('currentWeight', fmtKgBare(s.current?.weightKg));

    // weeklyLossKg 계열은 양수 = 감량. 표시할 땐 체중 변화 방향(감량 = −)으로 뒤집는다.
    setText('heroWeeklyChange', Number.isFinite(weeklyChange) ? `${fmtWeekly(weeklyChange)} kg/주` : '–');
    setText('predictionConfidence', confidenceLabel);
    setText('predictionError', bt14?.status === 'ok' && Number.isFinite(bt14.maeKg) ? `±${bt14.maeKg.toFixed(2)} kg (14일 MAE)` : '–');
    setText('trendWeight', Number.isFinite(trendKg) ? `${trendKg.toFixed(1)} kg` : '–');
    {
      const remaining = s.goal?.remainingKg;
      setText('toTarget', !Number.isFinite(remaining) ? '–' : remaining <= 0 ? '도달' : `${remaining.toFixed(1)} kg`);
    }

    setText('etaValue', fmtEta(s.goal));
    {
      const etaDate = s.goal?.etaDate ? fmtDateShort(s.goal.etaDate, referenceDate()) : null;
      const parts = [etaDate, etaDate ? fmtEtaRange(s.goal) : null];
      if (longRangeCaveat && ['date', 'beyond'].includes(s.goal?.etaStatus)) parts.push('장기 추정');
      setText('etaSub', parts.filter(Boolean).join(' · ') || '–');
    }

    setText('bodyFat', Number.isFinite(current.bodyFatPercent) ? current.bodyFatPercent.toFixed(1) : '–');
    setText('bodyFatDelta', Number.isFinite(current.bodyFatDelta30d)
      ? `${current.bodyFatDelta30d > 0 ? '+' : ''}${current.bodyFatDelta30d.toFixed(1)}%p / 30일` : '');
    setText('visceralFat', Number.isFinite(current.visceralFat) ? String(current.visceralFat) : '–');
    setText('restingHr', Number.isFinite(rolling.last7RestingHrAvg) ? String(Math.round(rolling.last7RestingHrAvg)) : '–');
    {
      const elLast = el('lastEntry');
      if (elLast) {
        const daysSince = measurementAgeDays(topCoverage);
        if (Number.isFinite(daysSince)) {
          elLast.textContent = daysSince <= 0 ? '오늘 측정' : `${Math.round(daysSince)}일 전`;
        } else if (last?.date) {
          elLast.textContent = fmtDateShort(last.date);
        } else {
          elLast.textContent = '–';
        }
      }
    }

    const measured = coverage.measuredDays ?? coverage.last30Measured ?? 0;
    const total = coverage.totalDays ?? coverage.last30Total ?? 30;
    const pct = coverage.pct ?? coverage.last30Pct ?? 0;

    const badge = el('statusBadge');
    const reason = el('statusReason');
    const trendDir = diagnostics.trend?.direction;
    if (badge) {
      badge.textContent = !hasData ? '기록 없음'
        : trendDir === 'losing' ? '감량 중'
        : trendDir === 'gaining' ? '증량 중'
        : trendDir === 'warming_up' ? '추세 판단 중'
        : '유지';
      badge.className = `hero-badge hero-badge--${!hasData ? 'neutral' : trendDir === 'losing' ? 'losing' : trendDir === 'gaining' ? 'gaining' : 'neutral'}`;
    }
    if (reason) {
      reason.textContent = !hasData ? '체중 기록이 아직 없습니다'
        : confidenceLevel === 'low' ? '신뢰도 낮음 · 참고용' : '추세 관찰 중';
    }

    // 진행률은 "목표까지"(goal.remainingKg)과 같은 기준인 추세 체중으로 계산한다. 일별 실측은 수분 변동이 크다.
    const progressKg = Number.isFinite(trendKg) ? trendKg : lastVal;
    if (Number.isFinite(startVal) && Number.isFinite(progressKg) && Number.isFinite(target)) {
      const totalKg = startVal - target;
      const done = startVal - progressKg;
      // 추세가 목표 이하면 100%다. 시작 체중이 이미 목표 아래였던 경우도 "도달"과 함께 0%로 나오지 않게 한다.
      const pctGoal = progressKg <= target ? 100 : (totalKg > 0 ? Math.max(0, Math.min(100, (done / totalKg) * 100)) : 0);
      setText('goalProgressBig', `${pctGoal.toFixed(0)}%`);
      el('heroProgressFill').style.width = pctGoal + '%';
      el('heroProgressMarker').style.left = pctGoal + '%';
      setText('heroProgressStart', `시작 ${fmtKgBare(startVal)} kg`);
      setText('heroProgressTarget', `목표 ${fmtKgBare(target)} kg`);
    }

    const rangeVal = s.rolling?.last7WeightRangeKg;
    setText('summaryRangeBox', Number.isFinite(rangeVal) ? `${rangeVal.toFixed(1)} kg` : '–');
    // 분모와 점은 백엔드가 센 창과 같아야 한다. 창은 완료된 날 30일이고 오늘은 들어가지 않는다(coverage.windowStart~windowEnd).
    // 창 날짜가 없는 예전 요약에서만 마지막 total일을 그린다.
    setText('summaryCoverageText', `${measured}/${total}`);
    setText('summaryCoveragePct', `(${pct}%)`);
    const windowDays = topCoverage.windowStart && topCoverage.windowEnd
      ? daily.filter((p) => p.date >= topCoverage.windowStart && p.date <= topCoverage.windowEnd)
      : (total > 0 ? daily.slice(-total) : []);
    drawCoverageDots('summaryDots', windowDays);

    const trend7 = trendWindows['7d']?.weeklyLossKg;
    const trend28 = trendWindows['28d']?.weeklyLossKg;
    // 표시 컨벤션: 체중 변화 방향 (감량 = −). weeklyLossKg는 양수 = 감량.
    const trend7Text = Number.isFinite(trend7) ? `${fmtWeekly(trend7)}/주` : '–';
    const trend28Text = Number.isFinite(trend28) ? `${fmtWeekly(trend28)}/주` : '–';
    const maeText = bt14?.status === 'ok' && Number.isFinite(bt14.maeKg) ? `${bt14.maeKg.toFixed(2)} kg` : '–';
    setText('summaryChange7d', trend7Text);
    setText('summaryChange28d', trend28Text);
    setText('summaryMae14d', maeText);

    const minutes = s.rolling?.last7ExerciseMinutes ?? 0;
    setText('exerciseMinutes', Math.round(minutes));
    setText('activeDays', `${s.rolling?.last7ActiveDays ?? 0}`);
    setText('stepsAvg', ((s.rolling?.last7StepsAvg ?? 0) / 1000).toFixed(1));

    const sc = s.predictions?.scenarios || {};
    setText('scenarioOpt', sc.optimistic ? fmtKgBare(sc.optimistic.threeMonthWeightKg) : '–');
    setText('scenarioBase', sc.base ? fmtKgBare(sc.base.threeMonthWeightKg) : '–');
    setText('scenarioCon', sc.conservative ? fmtKgBare(sc.conservative.threeMonthWeightKg) : '–');

    [['optimistic','scenarioOptDesc'],['base','scenarioBaseDesc'],['conservative','scenarioConDesc']].forEach(([key, descId]) => {
      const data = sc[key];
      const card = document.querySelector(`.scenario[data-scenario="${key}"]`);
      if (card && data?.description) card.setAttribute('title', data.description);
      setText(descId, data?.description ?? '');
    });

    const insightCard = el('insightCard');
    if (insightCard) insightCard.hidden = !(s.insight?.headline);
    setText('insightHeadline', s.insight?.headline ?? '');
    // headline은 lines[0]이므로 나머지 문장만 덧붙인다.
    setText('insightLines', (s.insight?.lines || []).slice(1).join(' '));

    renderScenarioSparklines(s);
    renderModelStrip(s);
  }

  // F6: 시나리오 카드마다 자기 예측 곡선(13점)을 그린다. 세 카드가 같은 세로 범위를 써서 차이가 보인다.
  function renderScenarioSparklines(s) {
    const keys = ['optimistic', 'base', 'conservative'];
    const colors = { optimistic: '#A0522D', base: '#3C2F2F', conservative: '#A89F99' };
    const curves = Object.fromEntries(keys.map((k) => [k, scenarioSeries(s, k).map((p) => p.valueKg).filter(Number.isFinite)]));
    const all = keys.flatMap((k) => curves[k]);
    if (!all.length) return;
    const maxV = Math.max(...all);
    const minV = Math.min(...all);
    const range = maxV - minV || 1;
    const W = 100, H = 22, PAD = 1;
    keys.forEach((key) => {
      const svg = document.querySelector(`.scenario-sparkline[data-spark="${key}"]`);
      const vals = curves[key];
      if (!svg || !vals.length) return;
      // 선택된 카드는 배경이 짙으므로 흰 선을 쓴다. 선택이 바뀌면 다시 그린다(bindControls).
      const strokeColor = key === state.scenario ? '#ffffff' : colors[key];
      const n = vals.length;
      const toX = (i) => PAD + (i / Math.max(n - 1, 1)) * (W - 2 * PAD);
      const toY = (v) => PAD + ((maxV - v) / range) * (H - 2 * PAD);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', vals.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' '));
      Object.entries({ stroke: strokeColor, 'stroke-width': '1.5', fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })
        .forEach(([k, v]) => line.setAttribute(k, v));
      svg.replaceChildren(line);
    });
  }

  function renderModelStrip(s) {
    const diag = s.modelDiagnostics || {};
    const confidence = diag.confidence || {};
    const trend = diag.trendWindows || {};
    const backtest = diag.backtest || {};
    const quality = diag.dataQuality || {};

    const confEl = el('modelConfidence');
    if (confEl) {
      const level = confidence.level || 'low';
      const score = confidence.score ?? '–';
      // 예측은 항상 운영 모델로 계산한다. selectedModel은 섀도 비교 결과일 뿐 예측에 쓰이지 않는다.
      const operating = diag.trend?.rateSource === 'cold_start_flat' ? '초기 평평 예측' : 'EWMA 혼합';
      confEl.textContent = `${confidence.label || '낮음'} · ${score}점 · ${operating}`;
      confEl.className = `model-strip-main model-strip-main--${level}`;
      const shadow = diag.selectedModel?.name;
      if (shadow && shadow !== 'current') confEl.title = `섀도 후보 ${modelLabel(shadow)} — 참고용 비교이며 예측에는 쓰지 않습니다.`;
      else confEl.removeAttribute('title');
    }

    const trendEl = el('modelTrend');
    if (trendEl) {
      const parts = ['7d', '14d', '28d'].map((k) => {
        const v = trend[k]?.weeklyLossKg;
        const day = k.replace('d', '일');
        return Number.isFinite(v) ? `${day}\u00a0${fmtWeekly(v)}/주` : `${day}\u00a0–`;
      });
      // 항목마다 줄바꿈하지 않는 span으로 넣고, 줄은 항목 사이에서만 바뀌게 한다.
      const nodes = [];
      parts.forEach((text, i) => {
        if (i) nodes.push(document.createTextNode('  '));
        const item = document.createElement('span');
        item.style.whiteSpace = 'nowrap';
        item.textContent = text;
        nodes.push(item);
      });
      trendEl.replaceChildren(...nodes);
    }

    const valEl = el('modelValidate');
    if (valEl) {
      const mae = backtest['14d'];
      const maeText = mae?.status === 'ok' && Number.isFinite(mae.maeKg)
        ? `14일 MAE ${mae.maeKg.toFixed(2)}kg`
        : '14일 표본 부족';
      const cov = Number.isFinite(quality.recentCoveragePct)
        ? ` · 측정 ${quality.recentCoveragePct.toFixed(0)}%`
        : '';
      valEl.textContent = maeText + cov;
    }
  }

  // 측정률 창의 날마다 점 하나. 창의 마지막 날(가장 최근에 끝난 날)은 색을 달리한다.
  function drawCoverageDots(id, last30) {
    const host = el(id);
    if (!host) return;
    const latestIso = last30.length ? last30[last30.length - 1].date : null;
    host.replaceChildren(...last30.map((p) => {
      const has = Number.isFinite(p.valueKg);
      const dot = document.createElement('span');
      dot.className = has ? (p.date === latestIso ? 'dot-cell has-today' : 'dot-cell has') : 'dot-cell';
      const label = `${p.date}${has ? ' · ' + p.valueKg.toFixed(1) + 'kg' : ' · 기록 없음'}`;
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', label);
      dot.title = label;
      return dot;
    }));
  }

  // F3: {x: 일 번호, y: kg} 점. 값이 없는 날은 빼고 spanGaps로 잇는다.
  const toXY = (arr) => arr.filter((p) => Number.isFinite(p.valueKg)).map((p) => ({ x: dayNumber(p.date), y: p.valueKg }));

  // 목표 체중 가로선. 데이터셋으로 넣으면 세로축이 목표까지 늘어나 실측선이 납작해지므로 플러그인으로 그린다.
  // 목표가 축 범위 밖이면 그쪽 가장자리에 표식만 남긴다.
  const targetLinePlugin = {
    id: 'targetLine',
    afterDatasetsDraw(chart, _args, opts) {
      const target = opts?.value;
      const y = chart.scales.y;
      if (!Number.isFinite(target) || !y) return;
      const { ctx, chartArea: area } = chart;
      const label = `목표 ${target.toFixed(1)}kg`;
      ctx.save();
      ctx.strokeStyle = THEME.target;
      ctx.fillStyle = THEME.target;
      ctx.font = `800 10px ${THEME.font}`;
      ctx.textAlign = 'right';
      if (target >= y.min && target <= y.max) {
        const py = y.getPixelForValue(target);
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(area.left, py);
        ctx.lineTo(area.right, py);
        ctx.stroke();
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, area.right - 4, py - 3);
      } else {
        const below = target < y.min;
        ctx.textBaseline = below ? 'bottom' : 'top';
        ctx.fillText(`${label} ${below ? '↓' : '↑'}`, area.right - 4, below ? area.bottom - 4 : area.top + 4);
      }
      ctx.restore();
    },
  };

  // 툴팁의 한 줄. 예측 점에는 80% 구간을 붙인다(그 값은 화면의 다른 곳에 숫자로 없다).
  // 추세에 일부만 반영한 측정에는 그 사실을 붙인다.
  function tooltipLabel(item) {
    const raw = item.raw || {};
    const base = `${item.dataset.label}: ${item.formattedValue}`;
    if (raw.limited) return `${base} · 추세에 일부만 반영`;
    if (Number.isFinite(raw.lower) && Number.isFinite(raw.upper) && raw.upper - raw.lower >= 0.01) {
      return `${base} (80% 구간 ${raw.lower.toFixed(1)}~${raw.upper.toFixed(1)})`;
    }
    return base;
  }

  // 가로축 눈금 하나(예: 12/29)에 주는 폭. 눈금 수는 차트 폭에서 정한다.
  const TICK_SPACING_PX = 56;
  const MAX_TICKS = 14;

  function ensureChart() {
    if (state.chart) return true;
    const canvas = el('weightChart');
    if (!canvas) return false;
    if (!window.Chart) return false;
    Chart.defaults.font.family = THEME.font;
    Chart.defaults.color = THEME.tick;
    state.chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: [] },
      plugins: [targetLinePlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // 가로 위치에서 가장 가까운 날짜의 점을 모은다. 예전의 'x' 모드는 점 바로 위에서만 툴팁이 떠서,
        // 점이 주 단위로 놓인 예측 구간에서는 거의 뜨지 않았다(재검토 FE1).
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          // 범례는 패널 머리(index.html)에 직접 그린다. 기본 범례는 내부 라벨(ciUpper 등)까지 보여 준다.
          legend: { display: false },
          tooltip: {
            filter: (item) => !String(item.dataset.label || '').startsWith('ci'),
            callbacks: {
              title: (items) => (items.length ? fmtDate(dayIso(items[0].parsed.x), referenceDate()) : ''),
              label: tooltipLabel,
            },
            backgroundColor: THEME.tooltipBg,
            borderColor: THEME.tooltipBorder,
            borderWidth: 1,
            titleColor: THEME.tooltipBody,
            bodyColor: THEME.tooltipBody,
          },
          targetLine: { value: null },
        },
        scales: {
          x: {
            type: 'linear',
            // 눈금은 주·달의 경계에 직접 놓는다. 기본 눈금은 일 번호의 배수라 달력과 맞지 않는다.
            afterBuildTicks: (axis) => {
              const count = Math.min(MAX_TICKS, Math.floor(axis.width / TICK_SPACING_PX));
              axis.ticks = dateTicks(axis.min, axis.max, count).map((value) => ({ value }));
            },
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              callback(value, index, ticks) {
                const spansYears = yearOf(dayIso(this.min)) !== yearOf(dayIso(this.max));
                return tickLabel(value, index > 0 ? ticks[index - 1].value : null, spansYears);
              },
            },
            grid: { color: THEME.grid },
          },
          y: { grid: { color: THEME.grid } },
        },
      },
    });
    return true;
  }

  // 지금 보기에서 그릴 예측. 선택한 시나리오의 시계열(13점)을 보기 범위에 맞는 주 수까지만 남긴다.
  function visibleForecast(s, pastDays) {
    const series = scenarioSeries(s, state.scenario);
    if (!series.length) return { weeks: 0, points: [] };
    const weeks = forecastWeeks(pastDays);
    const limit = dayNumber(series[0].date) + weeks * 7;
    return { weeks, points: series.filter((p) => dayNumber(p.date) <= limit) };
  }

  // mode는 Chart.js의 update 모드다. 시나리오만 바꿀 때는 'none'(애니메이션 없음)을 준다.
  function renderChart(mode) {
    if (!ensureChart()) return;
    const s = state.summary;
    const cfg = state.config;
    const target = Number(cfg?.targetWeightKg);
    state.chart.options.plugins.targetLine.value = Number.isFinite(target) ? target : null;

    const daily = sliceByRange(s.series?.daily || [], state.range);
    // 추세에서 크게 벗어나 추세에 일부만 반영한 측정(재검토 MD8). 속이 빈 점으로 그린다.
    const limitedDates = new Set(s.modelDiagnostics?.dataQuality?.limitedDates || []);
    const actual = toXY(daily).map((point) => (limitedDates.has(dayIso(point.x)) ? { ...point, limited: true } : point));
    document.querySelectorAll('[data-legend="limited"]').forEach((item) => { item.hidden = !actual.some((point) => point.limited); });
    const ewma = sliceByRange(s.series?.ewma || [], state.range);
    const ma14 = sliceByRange(s.series?.ma14 || [], state.range);
    // 예측은 보이는 과거의 절반까지만 그린다. 12주를 늘 그리면 30일 보기에서 과거가 차트 폭의 26%뿐이었다(재검토 FE1).
    const pastDays = daily.length ? dayNumber(daily[daily.length - 1].date) - dayNumber(daily[0].date) : NaN;
    const forecast = visibleForecast(s, pastDays);
    document.querySelectorAll('[data-legend="forecast"]').forEach((item) => {
      item.textContent = forecast.weeks ? `예측 · ${forecast.weeks}주` : '예측';
    });

    const datasets = [];
    if (state.visible.prediction) {
      const band = forecast.points.filter((p) => Number.isFinite(p.upper80) && Number.isFinite(p.lower80));
      const line = forecast.points.filter((p) => Number.isFinite(p.valueKg));
      datasets.push({ label: 'ciUpper', data: band.map((p) => ({ x: dayNumber(p.date), y: p.upper80 })), borderColor: 'transparent', borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, spanGaps: true, fill: '+1', backgroundColor: THEME.predictFill, tension: 0.25, order: 2 });
      datasets.push({ label: 'ciLower', data: band.map((p) => ({ x: dayNumber(p.date), y: p.lower80 })), borderColor: 'transparent', borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, spanGaps: true, fill: false, tension: 0.25, order: 2 });
      datasets.push({ label: '예측', data: line.map((p) => ({ x: dayNumber(p.date), y: p.valueKg, lower: p.lower80, upper: p.upper80 })), borderColor: THEME.predict, borderWidth: 1.75, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 4, pointBackgroundColor: THEME.predict, tension: 0.25, spanGaps: true, fill: false, order: 1 });
    }

    if (state.visible.ma7) {
      datasets.push({ label: '추세', data: toXY(ewma), borderColor: THEME.ma7, borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 3, tension: 0.35, spanGaps: true, fill: false, order: 3 });
    }
    if (state.visible.ma14) {
      datasets.push({ label: '14일 평균', data: toXY(ma14), borderColor: THEME.ma14, borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.35, spanGaps: true, fill: false, order: 4 });
    }

    const whenLimited = (limitedValue, value) => (ctx) => (ctx.raw?.limited ? limitedValue : value);
    datasets.push({ label: '실제', data: actual, borderColor: THEME.actual, backgroundColor: THEME.actualFill, borderWidth: 2.5, pointRadius: whenLimited(4, 3), pointHoverRadius: 5, pointBackgroundColor: whenLimited('#fff', THEME.actualPoint), pointBorderColor: whenLimited(THEME.predict, '#fff'), pointBorderWidth: whenLimited(2, 1.5), tension: 0.3, spanGaps: true, fill: true, order: 0 });

    // 가로축은 지금 보이는 계열의 날짜로 정한다. 예전에는 꺼 둔 계열까지 넣어서 예측을 꺼도 오른쪽이 비어 있었다.
    const days = datasets.flatMap((dataset) => dataset.data.map((point) => point.x));
    let first = days.length ? Math.min(...days) : undefined;
    let last = days.length ? Math.max(...days) : undefined;
    if (days.length && last - first < 1) { first -= 1; last += 1; }  // 점이 하루뿐이면 축의 폭이 0이 된다
    state.chart.options.scales.x.min = first;
    state.chart.options.scales.x.max = last;
    state.chart.data.datasets = datasets;
    state.chart.update(mode);
  }

  function bindControls() {
    document.querySelectorAll('.seg-btn[data-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.range = btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range, 10);
        document.querySelectorAll('.seg-btn[data-range]').forEach(b => { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
        renderChart();
      });
    });
    document.querySelectorAll('.chip[data-series]').forEach(chip => {
      const key = chip.dataset.series;
      const input = chip.querySelector('input');
      input.checked = !!state.visible[key];
      input.addEventListener('change', () => { state.visible[key] = input.checked; renderChart(); });
    });
    document.querySelectorAll('.scenario[data-scenario]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.scenario = btn.dataset.scenario;
        document.querySelectorAll('.scenario').forEach(b => { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
        if (state.summary) renderScenarioSparklines(state.summary);
        renderChart('none');
      });
    });
    el('reloadBtn').addEventListener('click', () => load());
    document.addEventListener('keydown', (e) => {
      // Ctrl+R(브라우저 새로고침), Ctrl+1(탭 전환) 같은 조합은 브라우저에 맡긴다.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'r' || e.key === 'R') {
        if (!appRoot.dataset.busy) load();
        return;
      }
      if (e.key === '1') document.querySelector('.seg-btn[data-range="30"]')?.click();
      if (e.key === '2') document.querySelector('.seg-btn[data-range="60"]')?.click();
      if (e.key === '3') document.querySelector('.seg-btn[data-range="all"]')?.click();
    });
  }

  // 점 색은 내용을 다 만든 뒤에 정한다. 예전에는 색을 칠한 점을 내용 교체가 새 점으로 바꿔 색이 사라졌다.
  function renderSyncPill({ text, cov = '', extra = '', tone = '', title = '' }) {
    const pill = el('lastSync');
    const host = pill?.querySelector('.sync-text');
    if (!host) return;
    const dot = document.createElement('span');
    dot.className = 'sync-dot';
    if (tone) dot.style.background = tone;
    const nodes = [dot, document.createTextNode(text)];
    if (cov) {
      const covSpan = document.createElement('span');
      covSpan.className = 'sync-cov';
      covSpan.textContent = cov;
      nodes.push(covSpan);
    }
    if (extra) nodes.push(document.createTextNode(extra));
    host.replaceChildren(...nodes);
    if (title) pill.title = title;
    else pill.removeAttribute('title');
  }

  function setChartNotice(text) {
    const notice = el('chartNotice');
    if (!notice) return;
    notice.textContent = text || '';
    notice.hidden = !text;
  }

  // Chart.js(CDN)가 준비되면 true, 받지 못했으면 false. 화면은 이 결과를 기다리지 않는다.
  // 실패한 <script>는 다시 실행되지 않는다. 그래서 다시 받을 때는 같은 주소와 무결성 값으로 새 태그를 넣는다
  // (재검토 FE6: 예전에는 "네트워크가 돌아오면 차트가 나타납니다"라고 적고 다시 받지 않았다).
  function chartLibrary() {
    if (window.Chart) return Promise.resolve(true);
    let script = el('chartLib');
    if (!script) return Promise.resolve(false);
    if (script.dataset.failed) {
      const fresh = document.createElement('script');
      fresh.id = script.id;
      fresh.async = true;
      fresh.integrity = script.integrity;
      fresh.crossOrigin = script.crossOrigin;
      fresh.src = script.src;
      script.replaceWith(fresh);
      script = fresh;
    }
    return new Promise((resolve) => {
      const settle = (ok) => {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        if (!ok) script.dataset.failed = 'true';
        resolve(ok);
      };
      const onLoad = () => settle(Boolean(window.Chart));
      const onError = () => settle(false);
      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
    });
  }

  // 차트를 그린다. 숫자가 화면에 나온 뒤에 부른다(재검토 FE2: 예전에는 Chart.js를 5초까지 기다린 뒤에야 화면을 보여 줬다).
  // .app의 data-chart가 지금 상태다: empty(그릴 자료 없음) / loading / unavailable(라이브러리를 못 받음) / drawn.
  let chartRequest = 0;
  async function drawChart() {
    const request = ++chartRequest;
    const hasWeights = (state.summary?.series?.daily || []).some((p) => Number.isFinite(p.valueKg));
    if (!hasWeights) {
      // 그릴 점이 없으면 0~1.0 눈금만 있는 빈 차트 대신 안내를 둔다.
      setChartNotice('표시할 체중 기록이 아직 없습니다.');
      appRoot.dataset.chart = 'empty';
      return;
    }
    if (!window.Chart) {
      appRoot.dataset.chart = 'loading';
      setChartNotice('차트를 불러오는 중입니다.');
      const ok = await chartLibrary();
      if (request !== chartRequest) return;  // 그 사이에 다시 불러왔다. 나중 요청이 그린다.
      if (!ok) {
        setChartNotice('차트 라이브러리를 불러오지 못했습니다. 숫자는 최신입니다. 다시 불러오기를 누르거나 네트워크가 돌아오면 차트를 다시 받습니다.');
        appRoot.dataset.chart = 'unavailable';
        return;
      }
    }
    setChartNotice('');
    renderChart();
    appRoot.dataset.chart = 'drawn';
  }

  function requestChart() {
    drawChart().catch((err) => {
      setChartNotice('차트를 그리지 못했습니다.');
      console.error('[garmin-weight chart]', err);
    });
  }

  async function load() {
    const reload = el('reloadBtn');
    if (reload) { reload.classList.add('is-spinning'); reload.disabled = true; }
    // W1: 화면을 투명하게 가리는 것은 첫 로드뿐이다. 새로고침 때는 내용을 그대로 두고 busy만 표시한다.
    const firstLoad = !appRoot.dataset.loadedOnce;
    if (firstLoad) appRoot.dataset.state = 'loading';
    appRoot.dataset.busy = 'true';
    try {
      const [summaryRes, configRes] = await Promise.all([
        fetch(`${SUMMARY_URL}?ts=${Date.now()}`, { cache: 'no-store' }),
        fetch(`${CONFIG_URL}?ts=${Date.now()}`, { cache: 'no-store' }),
      ]);
      if (!summaryRes.ok) throw new Error(`summary.json (${summaryRes.status})`);
      if (!configRes.ok) throw new Error(`config.json (${configRes.status})`);
      // 서비스 워커는 새 요약을 받지 못하면(오프라인, 404·5xx) 마지막으로 저장한 사본에 이 표시를 붙여 준다.
      const offlineCopy = summaryRes.headers.get('X-GW-From-Cache') === '1';
      state.summary = await summaryRes.json();
      state.config = await configRes.json();

      renderHero();
      if (state.visible.prediction === false) {
        const chip = document.querySelector('.chip[data-series="prediction"] input');
        if (chip) { chip.checked = false; }
      }
      // 동기화 시각은 Garmin에서 마지막으로 받아 온 시각이다. 요약을 다시 만든 시각(generatedAt)은 sync 블록이 없던 요약에서만 쓴다.
      const sync = state.summary.sync || null;
      const syncStamp = sync?.lastSuccessAt || state.summary.generatedAt;
      const syncAt = syncStamp ? new Date(syncStamp) : null;
      const syncAgeHours = syncAt && Number.isFinite(syncAt.getTime()) ? (Date.now() - syncAt.getTime()) / 3600000 : null;
      const syncLate = syncAgeHours != null && syncAgeHours > SYNC_LATE_HOURS;
      const failedEndpoints = Array.isArray(sync?.failedEndpoints) ? sync.failedEndpoints : [];
      // 엔드포인트 이름은 내부 이름이라 화면에는 항목 이름으로 적는다(체성분, 수면 등).
      const failedItems = endpointLabels(failedEndpoints);
      const cov = state.summary.coverage;
      const daysSince = measurementAgeDays(cov);
      const stale = Number.isFinite(daysSince) && daysSince >= 3;
      const lowCoverage = cov && cov.last30Pct < 70;
      const syncText = syncAgeHours != null
        ? `동기화 ${syncAt.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
        : '데이터 로드됨';
      const notes = [];
      if (offlineCopy) notes.push('새 요약을 받지 못해 이 기기에 저장된 마지막 요약을 보여 줍니다.');
      if (syncLate) notes.push(`마지막 수집 성공 후 ${Math.floor(syncAgeHours)}시간이 지났습니다. GitHub Actions의 garmin weight sync 실행 결과를 확인해 주세요.`);
      if (failedItems.length) notes.push(`지난 수집에서 일부 항목을 받지 못해 이전 값을 유지했습니다: ${failedItems.join(', ')} (${failedEndpoints.join(', ')})`);
      if (stale) notes.push(`마지막 체중 측정 후 ${Math.round(daysSince)}일째 새 측정이 없습니다. 체중계 동기화를 확인해 주세요.`);
      renderSyncPill({
        text: syncText,
        cov: cov ? ` · 측정 ${cov.last30Measured}/${cov.last30Total}일 (${cov.last30Pct}%)` : '',
        // 점 색만 바꾸면 거의 보이지 않고 터치 기기에는 툴팁이 없다. 일부 실패도 글자로 적는다(재검토 FE4).
        extra: (offlineCopy ? ' · 오프라인 사본' : '')
          + (syncLate ? ` · ${Math.floor(syncAgeHours)}시간째 수집 없음` : '')
          + (failedItems.length ? ` · 일부 수집 실패(${failedItems.join(', ')})` : '')
          + (stale ? ` · 마지막 측정 ${Math.round(daysSince)}일 전` : ''),
        tone: (syncLate || stale || offlineCopy) ? THEME.syncStale : ((lowCoverage || failedItems.length) ? THEME.syncWarn : ''),
        title: notes.join(' '),
      });
      setText('statusLine', `${state.config?.displayName || '체중 트래커'} · 목표 ${fmtKg(state.config?.targetWeightKg)} · ${(state.summary.series?.daily || []).length}일 기록`);

      window.dispatchEvent(new CustomEvent('garmin-weight:summary-ready', { detail: { summary: state.summary, config: state.config } }));
      appRoot.dataset.state = 'ready';
      appRoot.dataset.loadedOnce = 'true';
      lastLoadOk = true;
      // 숫자를 먼저 보여 주고 차트는 그 뒤에 그린다. 라이브러리가 이미 와 있으면 같은 순간에 그려진다.
      requestChart();
    } catch (err) {
      lastLoadOk = false;
      const why = describeLoadError(err);
      if (firstLoad) {
        // 보여 줄 자료가 없다. HTML의 기본값("–")이 남은 채로 원인을 위쪽 배지와 아래 줄에 적는다.
        appRoot.dataset.state = 'error';
        const badge = el('statusBadge');
        if (badge) { badge.textContent = '불러오지 못함'; badge.className = 'hero-badge hero-badge--neutral'; }
        setText('statusReason', `${why} · 다시 불러오기를 눌러 주세요`);
        renderSyncPill({ text: '로드 실패', tone: THEME.syncStale });
        setText('statusLine', `데이터를 불러오지 못했습니다(${why}).`);
      } else {
        // 새로고침만 실패했다. 화면의 자료는 그대로이고 동기화 표시에만 알린다.
        renderSyncPill({ text: `새로고침 실패(${why}) · 이전 자료 표시 중`, tone: THEME.syncStale });
      }
      console.error('[garmin-weight load]', err);
    } finally {
      lastLoadAt = Date.now();
      if (reload) { reload.classList.remove('is-spinning'); reload.disabled = false; }
      delete appRoot.dataset.busy;
    }
  }

  // 사용자에게 보일 실패 이유. 오류 원문(Failed to fetch 등)은 콘솔에만 남긴다.
  function describeLoadError(err) {
    const status = /\((\d{3})\)/.exec(String(err?.message || ''))?.[1];
    if (status) return `서버 응답 ${status}`;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return '오프라인';
    if (err instanceof SyntaxError) return '자료 형식 오류';
    return '네트워크 오류';
  }

  // 열어 둔 화면(홈 화면 앱 포함)은 스스로 갱신되지 않는다. 다시 보이거나 네트워크가 돌아왔을 때,
  // 마지막 시도가 실패했거나 오래됐으면 다시 받는다.
  const REFRESH_AFTER_MS = 10 * 60 * 1000;
  let lastLoadAt = 0;
  let lastLoadOk = false;
  function refreshIfStale() {
    if (document.visibilityState !== 'visible' || appRoot.dataset.busy) return;
    if (!lastLoadOk || Date.now() - lastLoadAt >= REFRESH_AFTER_MS) load();
  }
  document.addEventListener('visibilitychange', refreshIfStale);
  window.addEventListener('online', () => {
    refreshIfStale();
    // 요약을 다시 받지 않는 경우에도, 받지 못한 차트 라이브러리는 다시 받는다.
    if (state.summary && appRoot.dataset.chart === 'unavailable') requestChart();
  });

  document.querySelectorAll('.scenario[data-scenario]').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.classList.contains('is-active') ? 'true' : 'false');
  });

  // 글꼴 CSS를 화면을 막지 않게 읽으므로 차트가 글꼴보다 먼저 그려질 수 있다. 캔버스의 글자(눈금, 목표 라벨)는
  // 글꼴이 도착해도 스스로 다시 그려지지 않으니 그때 한 번 다시 그린다.
  document.fonts?.addEventListener?.('loadingdone', () => { if (state.chart) state.chart.update('none'); });

  bindControls();
  load();
})();
