'use strict';

(() => {
  const SUMMARY_URL = './data/summary.json';
  const CONFIG_URL = './config.json';

  const state = {
    summary: null,
    config: null,
    range: 60,
    scenario: 'base',
    visible: { ma7: true, ma14: false, prediction: false },
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
    const coverage = diagnostics.coverage || s.coverage || {};
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

    setText('trendWeight', Number.isFinite(trendKg) ? `${trendKg.toFixed(1)} kg` : '–');
    setText('toTarget', Number.isFinite(s.goal?.remainingKg) ? `${s.goal.remainingKg.toFixed(1)} kg` : '–');
    {
      const elLast = el('lastEntry');
      if (elLast) {
        const daysSince = coverage.daysSinceLastMeasurement;
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
    if (badge) {
      badge.textContent = confidenceLevel === 'low' ? '예측 보류' : (weeklyChange < -0.05 ? '감량 중' : '유지');
      badge.className = `hero-badge hero-badge--${confidenceLevel === 'low' ? 'paused' : (weeklyChange < -0.05 ? 'losing' : 'neutral')}`;
    }
    if (reason) {
      reason.textContent = confidenceLevel === 'low'
        ? `LATEST 30 DAYS (LOW RELIABILITY)`
        : `MONITORING TREND`;
    }

    if (startVal && lastVal && Number.isFinite(target)) {
      const totalKg = startVal - target;
      const done = startVal - lastVal;
      const pctGoal = totalKg > 0 ? Math.max(0, Math.min(100, (done / totalKg) * 100)) : 0;
    setText('goalProgressBig', `${pctGoal.toFixed(0)}%`);
    el('heroProgressFill').style.width = pctGoal + '%';
    el('heroProgressMarker').style.left = pctGoal + '%';
    setText('heroProgressStart', `${fmtKgBare(startVal)} kg (Start)`);
    setText('heroProgressTarget', `${fmtKgBare(target)} kg (Target)`);
  }

    const rangeVal = s.rolling?.last7WeightRangeKg;
    setText('summaryRangeBox', Number.isFinite(rangeVal) ? `${rangeVal.toFixed(1)} kg` : '–');
    {
      setText('summaryCoverageText', `${Math.min(measured,30)}/30`);
      setText('summaryCoveragePct', `(${pct}%)`);
    }
    drawCoverageDots('summaryDots', daily.slice(-15));

    const trend7 = trendWindows['7d']?.weeklyLossKg;
    const trend28 = trendWindows['28d']?.weeklyLossKg;
    const trend7Text = Number.isFinite(trend7) ? `${trend7 >= 0 ? '+' : '−'}${Math.abs(trend7).toFixed(2)}/w` : '–';
    const trend28Text = Number.isFinite(trend28) ? `${trend28 >= 0 ? '+' : '−'}${Math.abs(trend28).toFixed(2)}/w` : '–';
    const maeText = bt14?.status === 'ok' && Number.isFinite(bt14.maeKg) ? `${bt14.maeKg.toFixed(2)} kg` : '–';
    setText('summaryChange7d', trend7Text);
    setText('summaryChange28d', trend28Text);
    setText('summaryMae14d', maeText);
    setText('summaryLastEntry', last?.date ? fmtDateShort(last.date) : '–');

    const minutes = s.rolling?.last7ExerciseMinutes ?? 0;
    setText('exerciseMinutes', Math.round(minutes));
    setText('activeDays', `${s.rolling?.last7ActiveDays ?? 0}`);
    setText('stepsAvg', (s.rolling?.last7StepsAvg ?? 0) >= 1000 ? `${((s.rolling?.last7StepsAvg ?? 0) / 1000).toFixed(1)}K` : `${Math.round(s.rolling?.last7StepsAvg ?? 0)}`);

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

    renderScenarioSparklines(s);
  }

  function renderScenarioSparklines(s) {
    const data = s.series?.exerciseCaloriesDaily || [];
    if (!data.length) return;
    const vals = data.map(p => p.value ?? 0);
    const maxV = Math.max(...vals, 1);
    const minV = Math.min(...vals, 0);
    const range = maxV - minV || 1;
    const optPct = s.predictions?.scenarios?.optimistic?.extraWeeklyLossKg != null ? (s.predictions.scenarios.optimistic.weeklyKcalDelta / 7 / (s.rolling?.exerciseTrend?.recent7Avg || 1)) : 0.30;
    const conPct = s.predictions?.scenarios?.conservative?.extraWeeklyLossKg != null ? (s.predictions.scenarios.conservative.weeklyKcalDelta / 7 / (s.rolling?.exerciseTrend?.recent7Avg || 1)) : -0.30;
    const scenarios = { optimistic: { pct: optPct, color: '#A0522D' }, base: { pct: 0, color: '#3C2F2F' }, conservative: { pct: conPct, color: '#A89F99' } };
    const W = 100, H = 22, PAD = 1;
    Object.entries(scenarios).forEach(([key, cfg]) => {
      const svg = document.querySelector(`.scenario-sparkline[data-spark="${key}"]`);
      if (!svg) return;
      const n = vals.length;
      const toX = (i) => PAD + (i / Math.max(n - 1, 1)) * (W - 2 * PAD);
      const toY = (v) => H - PAD - ((v - minV) / range) * (H - 2 * PAD);
      const actualPts = vals.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
      const paths = `<polyline points="${actualPts}" stroke="${cfg.color}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
      svg.innerHTML = paths;
    });
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

  function buildCiBands(s, scenario) {
    const ci = s.predictionCI?.series || [];
    if (!ci.length) return { upper: [], lower: [] };
    const prediction = buildPredictionFromScenario(s, scenario);
    const predictionByDate = new Map(prediction.map(p => [p.date, p.valueKg]));
    return {
      upper: ci.map((p) => { const central = predictionByDate.get(p.date) ?? p.central; return { date: p.date, valueKg: +(central + Math.abs(p.upper80 - p.central)).toFixed(2) }; }),
      lower: ci.map((p) => { const central = predictionByDate.get(p.date) ?? p.central; return { date: p.date, valueKg: +(central - Math.abs(p.central - p.lower80)).toFixed(2) }; }),
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
        ctx.fillStyle = `rgba(160,82,45,0.10)`;
        ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
        ctx.restore();
      },
    };
  }

  function ensureChart() {
    if (state.chart) return true;
    const canvas = el('weightChart');
    if (!canvas) return false;
    if (!window.Chart) return false;
    state.chart = new Chart(canvas, { type: 'line', data: { labels: [], datasets: [] }, options: { responsive: true, maintainAspectRatio: false } });
    return true;
  }

  function renderChart() {
    if (!ensureChart()) return;
    const s = state.summary;
    const cfg = state.config;
    const target = cfg?.targetWeightKg ?? 80;
    const yMin = Math.floor(target - 2);

    const toDaily = (arr) => sliceByRange(arr, state.range);
    const daily = sliceByRange(s.series?.daily || [], state.range);
    const ewma = sliceByRange(s.series?.ewma || [], state.range);
    const ma14 = sliceByRange(s.series?.ma14 || [], state.range);
    const prediction = buildPredictionFromScenario(s, state.scenario);
    const ci = buildCiBands(s, state.scenario);

    const labelSet = new Set();
    [daily, ewma, ma14, prediction, ci.upper, ci.lower].forEach(arr => arr.forEach(p => labelSet.add(p.date)));
    const labels = Array.from(labelSet).sort();
    const align = (arr, key = 'valueKg') => { const m = new Map(arr.map(p => [p.date, p[key] ?? p.valueKg])); return labels.map(d => m.has(d) ? m.get(d) : null); };

    state.chart.data.labels = labels;
    state.chart.data.datasets = [];

    if (state.visible.prediction) {
      state.chart.data.datasets.push({ label: 'ciUpper', data: align(ci.upper), borderColor: 'transparent', borderWidth: 0, pointRadius: 0, spanGaps: true, fill: '+1', backgroundColor: 'rgba(255,111,97,0.10)', tension: 0.25, order: 2 });
      state.chart.data.datasets.push({ label: 'ciLower', data: align(ci.lower), borderColor: 'transparent', borderWidth: 0, pointRadius: 0, spanGaps: true, fill: false, tension: 0.25, order: 2 });
      state.chart.data.datasets.push({ label: '예측', data: align(prediction), borderColor: '#FF6F61', borderWidth: 1.75, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 4, pointBackgroundColor: '#FF6F61', tension: 0.25, spanGaps: true, fill: false, order: 1 });
    }

    if (state.visible.ma7) {
      state.chart.data.datasets.push({ label: '추세', data: align(ewma), borderColor: '#3C2F2F', borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 3, tension: 0.35, spanGaps: true, fill: false, order: 3 });
    }
    if (state.visible.ma14) {
      state.chart.data.datasets.push({ label: '14일 평균', data: align(ma14), borderColor: '#A89F99', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.35, spanGaps: true, fill: false, order: 4 });
    }

    state.chart.data.datasets.push({ label: '실제', data: align(daily), borderColor: '#3C2F2F', backgroundColor: 'rgba(60,47,47,0.06)', borderWidth: 2.5, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: '#A0522D', pointBorderColor: '#fff', pointBorderWidth: 1.5, tension: 0.3, spanGaps: true, fill: true, order: 0 });

    state.chart.update();
  }

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
    const upper = state.chart.data.datasets.find(d => d.label === 'ciUpper');
    if (upper) upper.data = remap(toMap(ci.upper));
    const lower = state.chart.data.datasets.find(d => d.label === 'ciLower');
    if (lower) lower.data = remap(toMap(ci.lower));
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
        updatePrediction();
      });
    });
    el('reloadBtn').addEventListener('click', () => load());
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.key === 'r' || e.key === 'R') load();
      if (e.key === '1') document.querySelector('.seg-btn[data-range="30"]')?.click();
      if (e.key === '2') document.querySelector('.seg-btn[data-range="60"]')?.click();
      if (e.key === '3') document.querySelector('.seg-btn[data-range="all"]')?.click();
    });
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

      const gen = state.summary.generatedAt ? new Date(state.summary.generatedAt) : null;
      const cov = state.summary.coverage;
      const covText = cov ? ` · 측정 ${cov.last30Measured}/${cov.last30Total}일 (${cov.last30Pct}%)` : '';
      const daysSince = cov?.daysSinceLastMeasurement;
      const stale = Number.isFinite(daysSince) && daysSince >= 3;
      const lowCoverage = cov && cov.last30Pct < 70;
      const syncPill = el('lastSync');
      const syncDot = syncPill?.querySelector('.sync-dot');
      if (syncDot) syncDot.style.background = stale ? THEME.syncStale : (lowCoverage ? THEME.syncWarn : '');
      const staleText = stale ? ` · 마지막 측정 ${Math.round(daysSince)}일 전` : '';
      syncPill.querySelector('.sync-text').innerHTML = `<span class="sync-dot"></span>${gen ? `동기화 ${gen.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${covText}${staleText}` : '데이터 로드됨'}`;
      if (stale) syncPill.title = `Garmin 동기화 후 ${Math.round(daysSince)}일째 미갱신 — 체중계 동기화를 확인해 주세요.`;
      else syncPill.removeAttribute('title');
      setText('statusLine', `${state.config?.displayName || '체중 트래커'} · 목표 ${fmtKg(state.config?.targetWeightKg)} · ${(state.summary.series?.daily || []).length}일 기록`);

      window.dispatchEvent(new CustomEvent('garmin-weight:summary-ready', { detail: { summary: state.summary, config: state.config } }));
      appRoot.dataset.state = 'ready';
    } catch (err) {
      appRoot.dataset.state = 'error';
      const errorSync = el('lastSync');
      if (errorSync) errorSync.querySelector('.sync-text').textContent = '로드 실패';
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
