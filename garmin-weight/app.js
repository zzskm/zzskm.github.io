'use strict';

(() => {
  const SUMMARY_URL = './data/summary.json';
  const CONFIG_URL = './config.json';

  // Light paper theme — style.css의 :root 변수와 동기화 유지
  const THEME = {
    ink: '#262626',
    inkSoft: 'rgba(38,38,38,0.78)',
    muted: 'rgba(38,38,38,0.62)',
    muted2: 'rgba(38,38,38,0.38)',
    line: 'rgba(38,38,38,0.14)',
    panel: '#f4f4f4',
    bg: '#e8e8e8',
    accent: '#4F81BD',
    accentInk: '#3a5d8a',
    accentTint: 'rgba(79,129,189,0.10)',
    actual: '#262626',
    actualFill: 'rgba(38,38,38,0.04)',
    ma7: 'rgba(38,38,38,0.32)',
    ma14: 'rgba(38,38,38,0.20)',
    predict: '#4F81BD',
    predictFill: 'rgba(79,129,189,0.10)',
    grid: 'rgba(38,38,38,0.06)',
    tooltipBg: '#f4f4f4',
    tooltipBorder: 'rgba(38,38,38,0.28)',
    tooltipBody: '#262626',
    plateauShade: 'rgba(176,135,80,0.10)',
    activityBar: 'rgba(79,129,189,0.30)',
    activityBarStroke: '#4F81BD',
    activitySteps: 'rgba(38,38,38,0.38)',
    syncStale: '#b91c1c',
    syncWarn: '#b08750',
  };

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
    const etaRange = fmtEtaRange(s.goal);
    setText('goalEtaDate', etaRange || (s.goal?.etaDate ? `${fmtDate(s.goal.etaDate)} 예상` : '–'));

    const diagnostics = s.modelDiagnostics || {};
    const confidence = diagnostics.confidence || {};
    setText('predictionConfidence', confidence.label || '–');
    const bt14 = diagnostics.backtest?.['14d'];
    setText('predictionError', bt14?.status === 'ok' ? `14일 ${fmtMae(bt14)}` : '검증 표본 부족');

    // 목표 진행률 계산: 노이즈가 있는 경우 EWMA 추세 체중 사용
    const ewma = s.series?.ewma || [];
    const startEwma = ewma.find(p => Number.isFinite(p.valueKg));
    const lastEwma = [...ewma].reverse().find(p => Number.isFinite(p.valueKg));

    if (startEwma && lastEwma) {
      const total = startEwma.valueKg - target;
      const done = startEwma.valueKg - lastEwma.valueKg;
      const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
      setText('goalProgressPct', pct.toFixed(0));
      el('progressFill').style.width = pct + '%';
      el('progressMarker').style.left = pct + '%';

      setText('startWeight', fmtKg(startEwma.valueKg));
      setText('targetWeight', fmtKg(target));

      const remaining = s.goal?.remainingKg ?? (lastEwma.valueKg - target);
      setText('goalSubtitle', remaining > 0
        ? `목표까지 ${remaining.toFixed(1)} kg · 현 속도로 ${fmtEta(s.goal)} 소요`
        : `목표 도달, 현재 ${lastEwma.valueKg.toFixed(1)} kg`);
    }

    // Scenarios
    const sc = s.predictions?.scenarios || {};
    setText('scenarioOpt', sc.optimistic ? fmtKg(sc.optimistic.threeMonthWeightKg) : '–');
    setText('scenarioBase', sc.base ? fmtKg(sc.base.threeMonthWeightKg) : '–');
    setText('scenarioCon', sc.conservative ? fmtKg(sc.conservative.threeMonthWeightKg) : '–');

    // Scenario description tooltips + desc text
    [['optimistic','scenarioOptDesc'],['base','scenarioBaseDesc'],['conservative','scenarioConDesc']].forEach(([key, descId]) => {
      const data = sc[key];
      const card = document.querySelector(`.scenario[data-scenario="${key}"]`);
      if (card && data?.description) card.setAttribute('title', data.description);
      setText(descId, data?.description ?? '');
    });

    // Sparklines
    renderScenarioSparklines(s);
    renderModelDiagnostics(s);
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

  // ---------- C1: 가속 신호 (다중 윈도우 감량률) ----------
  function renderTrendWindows(s) {
    const card = el('windowsCard');
    if (!card) return;
    const tw = s.modelDiagnostics?.trendWindows || {};
    const order = ['3d', '7d', '14d', '28d'];
    const rows = order.map(k => ({
      key: k,
      v: Number.isFinite(tw[k]?.weeklyLossKg) ? tw[k].weeklyLossKg : null,
    })).filter(r => r.v !== null);

    if (rows.length < 2) { card.hidden = true; return; }
    const maxAbs = Math.max(...rows.map(r => Math.abs(r.v)), 0.0001);

    const host = el('windowsBars');
    host.innerHTML = rows.map((r, i) => {
      const pct = Math.min(100, (Math.abs(r.v) / maxAbs) * 100);
      const sign = r.v >= 0 ? '+' : '−';
      const recent = i === 0 ? ' is-recent' : '';
      return `<div class="windows-row${recent}">
        <span>${r.key}</span>
        <span class="windows-bar-track"><span class="windows-bar-fill" style="width:${pct.toFixed(0)}%"></span></span>
        <span class="windows-val">${sign}${Math.abs(r.v).toFixed(2)}</span>
      </div>`;
    }).join('');

    // 가속 시그널: 7d > 28d?
    const v7 = tw['7d']?.weeklyLossKg, v28 = tw['28d']?.weeklyLossKg;
    if (Number.isFinite(v7) && Number.isFinite(v28)) {
      const ratio = v28 !== 0 ? v7 / v28 : 1;
      if (ratio >= 1.3) {
        setText('windowsCaption', '최근 추세 가속');
        setText('windowsHint', `7d가 28d 대비 ${(ratio).toFixed(1)}× — 단기 흐름이 더 빠릅니다.`);
      } else if (ratio <= 0.7 && v28 > 0.05) {
        setText('windowsCaption', '최근 추세 둔화');
        setText('windowsHint', `7d가 28d의 ${(ratio * 100).toFixed(0)}% — 단기 흐름이 느려졌어요.`);
      } else {
        setText('windowsCaption', '일정한 페이스');
        setText('windowsHint', '단기·장기 추세가 비슷하게 유지됩니다.');
      }
    } else {
      setText('windowsCaption', '윈도우별 감량률');
      setText('windowsHint', 'kg/주 · 양수=감량');
    }
    card.hidden = false;
  }

  // ---------- C2: Kalman vs V1 비교 strip ----------
  function renderKalmanStrip(s) {
    const strip = el('kalmanStrip');
    if (!strip) return;
    const mc = s.modelDiagnostics?.modelComparison;
    const perHorizon = mc?.perHorizon || {};
    const horizons = ['7d', '14d', '28d'].filter(h => perHorizon[h]);
    if (horizons.length === 0) { strip.hidden = true; return; }

    const parts = horizons.map(h => {
      const r = perHorizon[h];
      const sign = r.deltaKg >= 0 ? '+' : '−';
      const cls = r.kalmanWins ? 'is-win' : '';
      return `<span class="kalman-item ${cls}">${h} ${sign}${Math.abs(r.deltaKg).toFixed(2)}kg</span>`;
    }).join('<span class="kalman-sep">·</span>');

    strip.classList.toggle('is-recommended', !!mc.recommendKalman);
    strip.innerHTML = `<span class="kalman-tag">Kalman vs V1</span>${parts}`;
    strip.hidden = false;
  }

  // ---------- C3: 대사 시그니처 카드 ----------
  function renderMetabolicCard(s) {
    const card = el('metabolicCard');
    if (!card) return;
    const diag = s.modelDiagnostics || {};
    const calib = diag.calibration || {};
    const eff = calib.exerciseEfficiency;
    const kcal = diag.kcalPerKg;
    const src = diag.kcalPerKgSource;

    if (!Number.isFinite(eff) && !Number.isFinite(kcal)) {
      card.hidden = true;
      return;
    }

    setText('metabolicEfficiency', Number.isFinite(eff) ? `${Math.round(eff * 100)}%` : '–');
    setText('metabolicKcal', Number.isFinite(kcal) ? `${Math.round(kcal).toLocaleString('ko-KR')}` : '–');
    setText('metabolicKcalSrc', src === 'body_fat' ? 'kcal/kg · 체지방' : src === 'bmi' ? 'kcal/kg · BMI' : 'kcal/kg');

    // body_fat 가장 최근 값
    const daily = s.series?.daily || [];
    const allRows = s.series?.daily || [];  // body_fat은 daily 시리즈에 없으므로 별도 데이터 없으면 숨김
    const bfWrap = el('metabolicBodyFatWrap');
    if (bfWrap) bfWrap.hidden = true;
    // 추후 summary.json에 body_fat 노출되면 여기 채울 수 있음

    setText('metabolicHint', calib.interpretation || '');
    card.hidden = false;
  }

  function renderModelDiagnostics(s) {
    const diagnostics = s.modelDiagnostics || {};
    const confidence = diagnostics.confidence || {};
    const bt7 = diagnostics.backtest?.['7d'];
    const bt14 = diagnostics.backtest?.['14d'];
    const bt28 = diagnostics.backtest?.['28d'];
    const coverage = diagnostics.coverage || s.coverage;
    const trend28 = diagnostics.trendWindows?.['28d']?.weeklyLossKg;

    const confidenceText = confidence.label
      ? `예측 신뢰도 ${confidence.label}`
      : '예측 신뢰도 계산 전';
    const trendText = Number.isFinite(trend28)
      ? `EWMA 28일 추세 ${trend28 >= 0 ? '−' : '+'}${Math.abs(trend28).toFixed(2)} kg/주`
      : 'EWMA 28일 추세 표본 부족';
    setText('modelSummary', `${confidenceText} · ${trendText}`);

    const btParts = [`7일 ${fmtMae(bt7)}`, `14일 ${fmtMae(bt14)}`];
    if (bt28?.status === 'ok') btParts.push(`28일 ${fmtMae(bt28)}`);
    else btParts.push('28일 표본 부족');
    setText('modelBacktest', btParts.join(' · '));

    if (coverage) {
      const measured = coverage.measuredDays ?? coverage.last30Measured;
      const total = coverage.totalDays ?? coverage.last30Total;
      const pct = coverage.pct ?? coverage.last30Pct;
      setText('modelCoverage', `최근 ${total}일 중 ${measured}일 측정 · ${pct}%`);
    } else {
      setText('modelCoverage', '측정 커버리지 없음');
    }
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

  function renderPlateau(plateau) {
    const card = el('plateauCard');
    if (!card) return;
    if (!plateau?.detected) { card.hidden = true; return; }
    setText('plateauDuration', `${plateau.durationDays}일째`);
    const content = PLATEAU_CONTENT[plateau.type] || PLATEAU_CONTENT.metabolic;
    setText('plateauTag', content.tag);
    setText('plateauMsg', content.msg);
    const actions = el('plateauActions');
    if (actions) {
      actions.innerHTML = content.actions.map(a => `<li>${a}</li>`).join('');
    }
    card.hidden = false;
  }

  // ---------- scenario sparklines ----------
  function renderScenarioSparklines(s) {
    const data = s.series?.exerciseCaloriesDaily || [];
    if (!data.length) return;

    const vals = data.map(p => p.value ?? 0);
    const maxV = Math.max(...vals, 1);
    const minV = Math.min(...vals, 0);
    const range = maxV - minV || 1;

    // pct deltas from scenarios
    const optPct = s.predictions?.scenarios?.optimistic?.extraWeeklyLossKg != null
      ? (s.predictions.scenarios.optimistic.weeklyKcalDelta / 7 / (s.rolling?.exerciseTrend?.recent7Avg || 1))
      : 0.30;
    const conPct = s.predictions?.scenarios?.conservative?.extraWeeklyLossKg != null
      ? (s.predictions.scenarios.conservative.weeklyKcalDelta / 7 / (s.rolling?.exerciseTrend?.recent7Avg || 1))
      : -0.30;

    const scenarios = {
      optimistic: { pct: optPct, color: 'var(--accent-ink)' },
      base:       { pct: 0,      color: 'var(--ink-soft)' },
      conservative: { pct: conPct, color: 'var(--muted)' },
    };

    const W = 100, H = 22, PAD = 1;

    Object.entries(scenarios).forEach(([key, cfg]) => {
      const svg = document.querySelector(`.scenario-sparkline[data-spark="${key}"]`);
      if (!svg) return;

      const n = vals.length;
      // actual line
      const toX = (i) => PAD + (i / Math.max(n - 1, 1)) * (W - 2 * PAD);
      const toY = (v) => H - PAD - ((v - minV) / range) * (H - 2 * PAD);

      const actualPts = vals.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
      let paths = `<polyline class="spark-actual" points="${actualPts}" stroke="${cfg.color}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;

      // future projection (last 14 days dotted)
      if (cfg.pct !== 0 && n > 0) {
        const lastVal = vals[n - 1];
        const projVal = Math.max(lastVal * (1 + cfg.pct), 0);
        const projY = toY(Math.min(projVal, maxV + range * 0.2));
        const x1 = toX(n - 1).toFixed(1);
        const y1 = toY(lastVal).toFixed(1);
        const x2 = W - PAD;
        paths += `<line class="spark-future" x1="${x1}" y1="${y1}" x2="${x2}" y2="${projY.toFixed(1)}" stroke="${cfg.color}" stroke-width="1.5" stroke-dasharray="2 2" opacity="0.7"/>`;
      }

      svg.innerHTML = paths;
    });
  }


  // ---------- bottom: variability + coverage ----------
  function renderBottom() {
    const s = state.summary;

    const range = s.rolling?.last7WeightRangeKg;
    setText('weightRange', Number.isFinite(range) ? `${range.toFixed(1)} kg` : '–');
    setText('weightRangeHint',
      Number.isFinite(range)
        ? range < 1 ? '매우 안정적, 수분/식사 변동 범위' : range < 2 ? '정상 범위 내' : '변동이 큼, 측정 시각 확인 권장'
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
        <path d="${area}" fill="${THEME.actualFill}" />
        <path d="${d}" fill="none" stroke="${THEME.ink}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${last[0]}" cy="${last[1]}" r="2" fill="${THEME.accent}"/>
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

  // ---------- weight chart ----------
  function buildCiBands(s, scenario) {
    const ci = s.predictionCI?.series || [];
    if (!ci.length) return { upper: [], lower: [] };
    const prediction = buildPredictionFromScenario(s, scenario);
    const predictionByDate = new Map(prediction.map(p => [p.date, p.valueKg]));
    return {
      upper: ci.map((p) => {
        const central = predictionByDate.get(p.date) ?? p.central;
        return { date: p.date, valueKg: +(central + Math.abs(p.upper80 - p.central)).toFixed(2) };
      }),
      lower: ci.map((p) => {
        const central = predictionByDate.get(p.date) ?? p.central;
        return { date: p.date, valueKg: +(central - Math.abs(p.central - p.lower80)).toFixed(2) };
      }),
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
        ctx.fillStyle = THEME.plateauShade;
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
        borderColor: THEME.ma14,
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
        borderColor: THEME.ma7,
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
        backgroundColor: THEME.predictFill,
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
        borderColor: THEME.predict,
        borderWidth: 1.75,
        borderDash: [5, 4],
        pointRadius: 0,
        pointHoverRadius: 4,
        pointBackgroundColor: THEME.predict,
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
      borderColor: THEME.actual,
      backgroundColor: THEME.actualFill,
      borderWidth: 2.5,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBackgroundColor: THEME.accent,
      pointBorderColor: THEME.panel,
      pointBorderWidth: 1.5,
      tension: 0.3,
      spanGaps: true,
      fill: true,
      order: 0,
    });

    // 정체기 플러그인
    const ewmaMap = new Map((s.series?.ewma || []).map(p => [p.date, p.valueKg]));
    const ciUpperMap = new Map(ci.upper.map(p => [p.date, p.valueKg]));
    const ciLowerMap = new Map(ci.lower.map(p => [p.date, p.valueKg]));
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
            backgroundColor: THEME.tooltipBg,
            borderColor: THEME.tooltipBorder,
            borderWidth: 1,
            titleColor: THEME.ink,
            bodyColor: THEME.tooltipBody,
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
                  const lower = ciLowerMap.get(dateKey);
                  const upper = ciUpperMap.get(dateKey);
                  if (Number.isFinite(lower) && Number.isFinite(upper)) {
                    return [
                      ` 예측  ${fmtKg(ctx.parsed.y)}`,
                      ` 80%  ${fmtKgBare(lower)} – ${fmtKgBare(upper)} kg`,
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
            grid: { color: THEME.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: THEME.muted,
              font: { family: 'JetBrains Mono', size: 10.5 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
              callback(val) { return fmtDateShort(this.getLabelForValue(val)); },
            },
          },
          y: {
            min: yMin,
            grid: { color: THEME.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: THEME.muted,
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
        backgroundColor: THEME.activityBar,
        borderColor: THEME.activityBarStroke,
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
        borderColor: THEME.activitySteps,
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
              color: THEME.muted,
              usePointStyle: true,
              boxWidth: 8,
              font: { family: 'Inter Tight', size: 11.5 },
            },
          },
          tooltip: {
            backgroundColor: THEME.tooltipBg,
            borderColor: THEME.tooltipBorder,
            borderWidth: 1,
            titleColor: THEME.ink,
            bodyColor: THEME.tooltipBody,
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
              color: THEME.muted,
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
            grid: { color: THEME.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: THEME.muted,
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
              color: THEME.muted2,
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
      renderTrendWindows(state.summary);
      renderMetabolicCard(state.summary);
      renderKalmanStrip(state.summary);
      renderInsight(state.summary.insight);
      renderPlateau(state.summary.plateau);
      renderChart();
      renderActivityChart();

      const gen = state.summary.generatedAt ? new Date(state.summary.generatedAt) : null;
      const cov = state.summary.coverage;
      const covText = cov ? ` · 측정 ${cov.last30Measured}/${cov.last30Total}일 (${cov.last30Pct}%)` : '';
      const daysSince = cov?.daysSinceLastMeasurement;
      const stale = Number.isFinite(daysSince) && daysSince >= 3;
      const lowCoverage = cov && cov.last30Pct < 70;
      const syncPill = el('lastSync');
      const syncDot = syncPill?.querySelector('.sync-dot');
      if (syncDot) syncDot.style.background = stale ? THEME.syncStale : (lowCoverage ? THEME.syncWarn : '');
      const staleText = stale ? ` · 마지막 측정 ${daysSince}일 전` : '';
      syncPill.querySelector('.sync-text').textContent = gen
        ? `동기화 ${gen.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${covText}${staleText}`
        : '데이터 로드됨';
      if (stale) {
        syncPill.title = `Garmin 앱에서 최근 동기화 후 측정값이 ${daysSince}일째 갱신되지 않았습니다. 체중계 동기화를 확인해 주세요.`;
      } else {
        syncPill.removeAttribute('title');
      }
      setText('statusLine',
        `${state.config?.displayName || '체중 트래커'} · 목표 ${fmtKg(state.config?.targetWeightKg)} · ${(state.summary.series?.daily || []).length}일 기록`);

      // V2: 운동 효율 캘리브레이션 메시지
      const calib = state.summary.modelDiagnostics?.calibration;
      const calibLine = el('calibrationLine');
      if (calibLine) {
        if (calib?.interpretation && Number.isFinite(calib.exerciseEfficiency)) {
          calibLine.textContent = calib.interpretation;
          calibLine.hidden = false;
        } else {
          calibLine.hidden = true;
        }
      }

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
