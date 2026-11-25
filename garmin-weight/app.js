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
  } = window.GWAppHelpers;

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

    const trendKg = Number.isFinite(current.weightEwmaKg) ? current.weightEwmaKg : (start ? start.valueKg - (rolling.lossRateDetail?.blended ?? 0) * 30 : null);
    const weeklyChange = Number.isFinite(rolling.lossRateDetail?.blended) ? rolling.lossRateDetail.blended : null;
    const confidenceLevel = confidence.level || 'low';
    const confidenceLabel = (confidence.label || 'LOW').toUpperCase();

    const startVal = start ? start.valueKg : null;
    const lastVal = last ? last.valueKg : null;
    setText('currentWeight', fmtKgBare(s.current?.weightKg));

    // weeklyLossKg 계열은 양수 = 감량. 표시할 땐 체중 변화 방향(감량 = −)으로 뒤집는다.
    setText('heroWeeklyChange', Number.isFinite(weeklyChange) ? `${weeklyChange > 0 ? '−' : '+'}${Math.abs(weeklyChange).toFixed(2)} kg/w` : '–');
    setText('predictionConfidence', confidenceLabel);
    setText('predictionError', bt14?.status === 'ok' && Number.isFinite(bt14.maeKg) ? `±${bt14.maeKg.toFixed(2)} kg (14D MAE)` : '–');
    setText('trendWeight', Number.isFinite(trendKg) ? `${trendKg.toFixed(1)} kg` : '–');
    setText('toTarget', Number.isFinite(s.goal?.remainingKg) ? `${s.goal.remainingKg.toFixed(1)} kg` : '–');

    setText('etaValue', fmtEta(s.goal));
    {
      const etaDate = s.goal?.etaDate ? fmtDateShort(s.goal.etaDate) : null;
      const etaRange = fmtEtaRange(s.goal);
      setText('etaSub', etaDate ? (etaRange ? `${etaDate} · ${etaRange}` : etaDate) : '–');
    }

    setText('bodyFat', Number.isFinite(current.bodyFatPercent) ? current.bodyFatPercent.toFixed(1) : '–');
    setText('bodyFatDelta', Number.isFinite(current.bodyFatDelta30d)
      ? `${current.bodyFatDelta30d > 0 ? '+' : ''}${current.bodyFatDelta30d.toFixed(1)}%p / 30d` : '');
    setText('visceralFat', Number.isFinite(current.visceralFat) ? String(current.visceralFat) : '–');
    setText('restingHr', Number.isFinite(rolling.last7RestingHrAvg) ? String(Math.round(rolling.last7RestingHrAvg)) : '–');
    {
      const elLast = el('lastEntry');
      if (elLast) {
        const daysSince = topCoverage.daysSinceLastMeasurement;
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
      badge.textContent = trendDir === 'losing' ? '감량 중'
        : trendDir === 'gaining' ? '증량 중'
        : trendDir === 'warming_up' ? '추세 판단 중'
        : '유지';
      badge.className = `hero-badge hero-badge--${trendDir === 'losing' ? 'losing' : trendDir === 'gaining' ? 'gaining' : 'neutral'}`;
    }
    if (reason) {
      reason.textContent = confidenceLevel === 'low' ? 'LOW RELIABILITY · PROVISIONAL' : 'MONITORING TREND';
    }

    // 진행률은 "To Target"(goal.remainingKg)과 같은 기준인 추세 체중으로 계산한다. 일별 실측은 수분 변동이 크다.
    const progressKg = Number.isFinite(trendKg) ? trendKg : lastVal;
    if (Number.isFinite(startVal) && Number.isFinite(progressKg) && Number.isFinite(target)) {
      const totalKg = startVal - target;
      const done = startVal - progressKg;
      const pctGoal = totalKg > 0 ? Math.max(0, Math.min(100, (done / totalKg) * 100)) : 0;
      setText('goalProgressBig', `${pctGoal.toFixed(0)}%`);
      el('heroProgressFill').style.width = pctGoal + '%';
      el('heroProgressMarker').style.left = pctGoal + '%';
      setText('heroProgressStart', `${fmtKgBare(startVal)} kg (Start)`);
      setText('heroProgressTarget', `${fmtKgBare(target)} kg (Target)`);
    }

    const rangeVal = s.rolling?.last7WeightRangeKg;
    setText('summaryRangeBox', Number.isFinite(rangeVal) ? `${rangeVal.toFixed(1)} kg` : '–');
    // 분모와 점은 백엔드가 센 실제 창(최근 30일, 이력이 짧으면 그만큼)과 같게 맞춘다.
    setText('summaryCoverageText', `${measured}/${total}`);
    setText('summaryCoveragePct', `(${pct}%)`);
    drawCoverageDots('summaryDots', total > 0 ? daily.slice(-total) : []);

    const trend7 = trendWindows['7d']?.weeklyLossKg;
    const trend28 = trendWindows['28d']?.weeklyLossKg;
    // 표시 컨벤션: 체중 변화 방향 (감량 = −). weeklyLossKg는 양수 = 감량.
    const trend7Text = Number.isFinite(trend7) ? `${trend7 > 0 ? '−' : '+'}${Math.abs(trend7).toFixed(2)}/w` : '–';
    const trend28Text = Number.isFinite(trend28) ? `${trend28 > 0 ? '−' : '+'}${Math.abs(trend28).toFixed(2)}/w` : '–';
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
      const tag = card?.querySelector('.scenario-tag');
      if (data?.uiLabel && tag) tag.textContent = data.uiLabel;
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
      const points = vals.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
      svg.innerHTML = `<polyline points="${points}" stroke="${strokeColor}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
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
      confEl.textContent = `${level.toUpperCase()} · ${score}점 · ${operating}`;
      confEl.className = `model-strip-main model-strip-main--${level}`;
      const shadow = diag.selectedModel?.name;
      if (shadow && shadow !== 'current') confEl.title = `섀도 후보 ${shadow} — 참고용 비교이며 예측에는 쓰지 않습니다.`;
      else confEl.removeAttribute('title');
    }

    const trendEl = el('modelTrend');
    if (trendEl) {
      const parts = ['7d', '14d', '28d'].map((k) => {
        const v = trend[k]?.weeklyLossKg;
        return Number.isFinite(v) ? `${k} ${v > 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}/w` : `${k} –`;
      });
      trendEl.textContent = parts.join('  ');
    }

    const valEl = el('modelValidate');
    if (valEl) {
      const mae = backtest['14d'];
      const maeText = mae?.status === 'ok' && Number.isFinite(mae.maeKg)
        ? `14d MAE ${mae.maeKg.toFixed(2)}kg`
        : '14d 표본 부족';
      const cov = Number.isFinite(quality.recentCoveragePct)
        ? ` · 측정 ${quality.recentCoveragePct.toFixed(0)}%`
        : '';
      valEl.textContent = maeText + cov;
    }
  }

  function drawCoverageDots(id, last30) {
    const host = el(id);
    if (!host) return;
    const todayIso = last30.length ? last30[last30.length - 1].date : null;
    host.innerHTML = last30.map((p) => {
      const has = Number.isFinite(p.valueKg);
      const cls = has ? (p.date === todayIso ? 'dot-cell has-today' : 'dot-cell has') : 'dot-cell';
      const ariaLabel = `${p.date}${has ? ' · ' + p.valueKg.toFixed(1) + 'kg' : ' · 기록 없음'}`;
      return `<span class="${cls}" role="img" aria-label="${ariaLabel}" title="${ariaLabel}"></span>`;
    }).join('');
  }

  function buildCiBands(s, scenario) {
    const series = scenarioSeries(s, scenario);
    return {
      upper: series.map((p) => ({ date: p.date, valueKg: p.upper80 })),
      lower: series.map((p) => ({ date: p.date, valueKg: p.lower80 })),
    };
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

  function ensureChart() {
    if (state.chart) return true;
    const canvas = el('weightChart');
    if (!canvas) return false;
    if (!window.Chart) return false;
    Chart.defaults.font.family = THEME.font;
    Chart.defaults.color = THEME.tick;
    const dateTick = (value) => fmtDateShort(dayIso(value));
    state.chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: [] },
      plugins: [targetLinePlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // 선형 가로축에서는 데이터셋마다 점의 날짜가 달라 index 모드를 쓸 수 없다. 같은 날짜(x)의 점을 모은다.
        interaction: { mode: 'x', intersect: false },
        plugins: {
          // 범례는 패널 머리(index.html)에 직접 그린다. 기본 범례는 내부 라벨(ciUpper 등)까지 보여 준다.
          legend: { display: false },
          tooltip: {
            filter: (item) => !String(item.dataset.label || '').startsWith('ci'),
            callbacks: { title: (items) => (items.length ? fmtDate(dayIso(items[0].parsed.x)) : '') },
            backgroundColor: THEME.tooltipBg,
            borderColor: THEME.tooltipBorder,
            borderWidth: 1,
            titleColor: THEME.tooltipBody,
            bodyColor: THEME.tooltipBody,
          },
          targetLine: { value: null },
        },
        scales: {
          x: { type: 'linear', ticks: { autoSkip: true, maxTicksLimit: 8, precision: 0, callback: dateTick }, grid: { color: THEME.grid } },
          y: { grid: { color: THEME.grid } },
        },
      },
    });
    return true;
  }

  function renderChart() {
    if (!ensureChart()) return;
    const s = state.summary;
    const cfg = state.config;
    const target = Number(cfg?.targetWeightKg);
    state.chart.options.plugins.targetLine.value = Number.isFinite(target) ? target : null;

    const daily = sliceByRange(s.series?.daily || [], state.range);
    const ewma = sliceByRange(s.series?.ewma || [], state.range);
    const ma14 = sliceByRange(s.series?.ma14 || [], state.range);
    const prediction = buildPredictionFromScenario(s, state.scenario);
    const ci = buildCiBands(s, state.scenario);

    const all = [daily, ewma, ma14, prediction, ci.upper, ci.lower].flat().map((p) => dayNumber(p.date));
    state.chart.options.scales.x.min = all.length ? Math.min(...all) : undefined;
    state.chart.options.scales.x.max = all.length ? Math.max(...all) : undefined;
    state.chart.data.datasets = [];

    if (state.visible.prediction) {
      state.chart.data.datasets.push({ label: 'ciUpper', data: toXY(ci.upper), borderColor: 'transparent', borderWidth: 0, pointRadius: 0, spanGaps: true, fill: '+1', backgroundColor: THEME.predictFill, tension: 0.25, order: 2 });
      state.chart.data.datasets.push({ label: 'ciLower', data: toXY(ci.lower), borderColor: 'transparent', borderWidth: 0, pointRadius: 0, spanGaps: true, fill: false, tension: 0.25, order: 2 });
      state.chart.data.datasets.push({ label: '예측', data: toXY(prediction), borderColor: THEME.predict, borderWidth: 1.75, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 4, pointBackgroundColor: THEME.predict, tension: 0.25, spanGaps: true, fill: false, order: 1 });
    }

    if (state.visible.ma7) {
      state.chart.data.datasets.push({ label: '추세', data: toXY(ewma), borderColor: THEME.ma7, borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 3, tension: 0.35, spanGaps: true, fill: false, order: 3 });
    }
    if (state.visible.ma14) {
      state.chart.data.datasets.push({ label: '14일 평균', data: toXY(ma14), borderColor: THEME.ma14, borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.35, spanGaps: true, fill: false, order: 4 });
    }

    state.chart.data.datasets.push({ label: '실제', data: toXY(daily), borderColor: THEME.actual, backgroundColor: THEME.actualFill, borderWidth: 2.5, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: THEME.actualPoint, pointBorderColor: '#fff', pointBorderWidth: 1.5, tension: 0.3, spanGaps: true, fill: true, order: 0 });

    state.chart.update();
  }

  function updatePrediction() {
    if (!state.chart) return;
    const s = state.summary;
    const prediction = buildPredictionFromScenario(s, state.scenario);
    const ci = buildCiBands(s, state.scenario);
    const predDataset = state.chart.data.datasets.find(d => d.label === '예측');
    if (predDataset) predDataset.data = toXY(prediction);
    const upper = state.chart.data.datasets.find(d => d.label === 'ciUpper');
    if (upper) upper.data = toXY(ci.upper);
    const lower = state.chart.data.datasets.find(d => d.label === 'ciLower');
    if (lower) lower.data = toXY(ci.lower);
    state.chart.update('none');
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
        updatePrediction();
      });
    });
    el('reloadBtn').addEventListener('click', () => load());
    document.addEventListener('keydown', (e) => {
      // Ctrl+R(브라우저 새로고침), Ctrl+1(탭 전환) 같은 조합은 브라우저에 맡긴다.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'r' || e.key === 'R') {
        if (appRoot.dataset.state !== 'loading') load();
        return;
      }
      if (e.key === '1') document.querySelector('.seg-btn[data-range="30"]')?.click();
      if (e.key === '2') document.querySelector('.seg-btn[data-range="60"]')?.click();
      if (e.key === '3') document.querySelector('.seg-btn[data-range="all"]')?.click();
    });
  }

  // 점 색은 내용을 다 만든 뒤에 정한다. 예전에는 색을 칠한 점을 innerHTML이 새 점으로 바꿔 색이 사라졌다.
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

  async function waitForChart() {
    if (window.Chart && el('weightChart')) return true;
    await new Promise(r => setTimeout(r, 50));
    return waitForChart();
  }

  async function load() {
    const reload = el('reloadBtn');
    if (reload) { reload.classList.add('is-spinning'); reload.disabled = true; }
    appRoot.dataset.state = 'loading';
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
      if (state.visible.prediction === false) {
        const chip = document.querySelector('.chip[data-series="prediction"] input');
        if (chip) { chip.checked = false; }
      }
      await waitForChart();
      renderChart();

      // 동기화 시각은 Garmin에서 마지막으로 받아 온 시각이다. 요약을 다시 만든 시각(generatedAt)은 sync 블록이 없던 요약에서만 쓴다.
      const sync = state.summary.sync || null;
      const syncStamp = sync?.lastSuccessAt || state.summary.generatedAt;
      const syncAt = syncStamp ? new Date(syncStamp) : null;
      const syncAgeHours = syncAt && Number.isFinite(syncAt.getTime()) ? (Date.now() - syncAt.getTime()) / 3600000 : null;
      const syncLate = syncAgeHours != null && syncAgeHours > SYNC_LATE_HOURS;
      const failedEndpoints = Array.isArray(sync?.failedEndpoints) ? sync.failedEndpoints : [];
      const cov = state.summary.coverage;
      const daysSince = cov?.daysSinceLastMeasurement;
      const stale = Number.isFinite(daysSince) && daysSince >= 3;
      const lowCoverage = cov && cov.last30Pct < 70;
      const syncText = syncAgeHours != null
        ? `동기화 ${syncAt.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
        : '데이터 로드됨';
      const notes = [];
      if (syncLate) notes.push(`마지막 수집 성공 후 ${Math.floor(syncAgeHours)}시간이 지났습니다. GitHub Actions의 garmin weight sync 실행 결과를 확인해 주세요.`);
      if (failedEndpoints.length) notes.push(`지난 수집에서 일부 항목을 받지 못해 이전 값을 유지했습니다: ${failedEndpoints.join(', ')}`);
      if (stale) notes.push(`마지막 체중 측정 후 ${Math.round(daysSince)}일째 새 측정이 없습니다. 체중계 동기화를 확인해 주세요.`);
      renderSyncPill({
        text: syncText,
        cov: cov ? ` · 측정 ${cov.last30Measured}/${cov.last30Total}일 (${cov.last30Pct}%)` : '',
        extra: (syncLate ? ` · ${Math.floor(syncAgeHours)}시간째 수집 없음` : '') + (stale ? ` · 마지막 측정 ${Math.round(daysSince)}일 전` : ''),
        tone: (syncLate || stale) ? THEME.syncStale : ((lowCoverage || failedEndpoints.length) ? THEME.syncWarn : ''),
        title: notes.join(' '),
      });
      setText('statusLine', `${state.config?.displayName || '체중 트래커'} · 목표 ${fmtKg(state.config?.targetWeightKg)} · ${(state.summary.series?.daily || []).length}일 기록`);

      window.dispatchEvent(new CustomEvent('garmin-weight:summary-ready', { detail: { summary: state.summary, config: state.config } }));
      appRoot.dataset.state = 'ready';
    } catch (err) {
      appRoot.dataset.state = 'error';
      renderSyncPill({ text: '로드 실패', tone: THEME.syncStale });
      setText('statusLine', `데이터를 불러오지 못했습니다: ${err.message}`);
      console.error('[garmin-weight load]', err);
    } finally {
      if (reload) { reload.classList.remove('is-spinning'); reload.disabled = false; }
    }
  }

  document.querySelectorAll('.scenario[data-scenario]').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.classList.contains('is-active') ? 'true' : 'false');
  });

  bindControls();
  load();
})();
