'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const isFiniteNumber = (v) => Number.isFinite(Number(v));
  const fmtKg = (v, digits = 1) => isFiniteNumber(v) ? `${Number(v).toFixed(digits)}kg` : '–';

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value;
  }

  function pct(value) {
    return isFiniteNumber(value) ? `${Math.round(Number(value))}%` : '–';
  }

  function formatDays(days) {
    if (!isFiniteNumber(days)) return '측정 없음';
    const n = Number(days);
    if (n <= 0) return '오늘 측정';
    if (n === 1) return '1일 전 측정';
    return `${n}일 전 측정`;
  }

  function compactReasons(reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) return '신뢰도 저하 사유 없음';
    return reasons.slice(0, 2).join(' · ');
  }

  function isLowConfidence(summary) {
    return summary?.modelDiagnostics?.confidence?.level === 'low';
  }

  function getSeriesValue(point) {
    if (!point) return null;
    if (isFiniteNumber(point.valueKg)) return Number(point.valueKg);
    if (isFiniteNumber(point.value)) return Number(point.value);
    return null;
  }

  function summarizeMissing(series, label) {
    const points = Array.isArray(series) ? series.slice(-30) : [];
    if (!points.length) return null;
    const missing = points.filter((p) => !isFiniteNumber(getSeriesValue(p))).length;
    if (missing < 10) return null;
    return `${label} ${missing}/30일 누락`;
  }

  function inferSeriesQuality(summary) {
    const warnings = [];
    const s = summary?.series || {};
    const stepWarn = summarizeMissing(s.steps, '걸음');
    if (stepWarn) warnings.push(stepWarn);
    const exerciseWarn = summarizeMissing(s.exerciseMinutes, '운동 시간');
    if (exerciseWarn) warnings.push(exerciseWarn);
    const dailyWarn = summarizeMissing(s.daily, '체중');
    if (dailyWarn) warnings.push(dailyWarn);
    return warnings;
  }

  function renderQuality(summary) {
    const coverage = summary?.coverage || {};
    const confidence = summary?.modelDiagnostics?.confidence || {};
    const backtest14 = summary?.modelDiagnostics?.backtest?.['14d'];
    const seriesWarnings = inferSeriesQuality(summary);

    const targets = ['qualityStatus', 'qualityCoverage', 'qualitySync', 'qualityBacktest', 'qualityReason'];
    if (!targets.some(id => document.getElementById(id))) return;

    setText('qualityStatus', (confidence.label || '낮음').toUpperCase());
    setText('qualityCoverage', `측정률 ${pct(coverage.last30Pct)}`);
    setText('qualitySync', formatDays(coverage.daysSinceLastMeasurement));

    const backtestText = backtest14?.status === 'ok' && isFiniteNumber(backtest14.maeKg)
      ? `14일 오차 ${Number(backtest14.maeKg).toFixed(2)}kg`
      : '14일 검증 표본 부족';
    setText('qualityBacktest', backtestText);

    const reason = seriesWarnings.length
      ? seriesWarnings.slice(0, 2).join(' · ')
      : compactReasons(confidence.reasons);
    setText('qualityReason', reason);
  }

  function renderScenarioSub(summary) {
    const scenarios = summary?.predictions?.scenarios || {};
    document.querySelectorAll('.scenario').forEach((card) => {
      const key = card.dataset.scenario;
      const data = scenarios[key];
      const sub = card.querySelector('.scenario-sub');
      if (!sub || !data) return;

      const delta = isFiniteNumber(data.weeklyKcalDelta) ? Number(data.weeklyKcalDelta) : null;
      const kcalText = delta === null || Math.abs(delta) < 1
        ? '현재 운동량 유지'
        : `${delta > 0 ? '+' : '−'}주 ${Math.abs(Math.round(delta)).toLocaleString('ko-KR')} kcal`;
      sub.textContent = kcalText;

      if (data.description) card.setAttribute('title', data.description);
    });
  }

  function scenarioSpreadKg(summary) {
    const values = Object.values(summary?.predictions?.scenarios || {})
      .map((scenario) => scenario?.threeMonthWeightKg)
      .filter(isFiniteNumber)
      .map(Number);
    if (values.length < 2) return 0;
    return Math.max(...values) - Math.min(...values);
  }

  function renderScenarioState(summary) {
    const scenarios = document.querySelector('.scenarios');
    if (!scenarios) return;

    const spread = scenarioSpreadKg(summary);
    const muted = isLowConfidence(summary) || spread < 0.2;
    scenarios.classList.toggle('is-muted', muted);

    const hint = scenarios.querySelector('.scenarios-hint');
    if (hint && muted) {
      hint.textContent = '현재 추세가 불안정해 시나리오 차이를 계산하기 어렵습니다';
    } else if (hint) {
      hint.textContent = '선택한 강도가 차트 예측선과 신뢰 띠에 반영됩니다';
    }
  }

  function setPredictionVisibility(enabled) {
    const predictionChip = document.querySelector('.chip[data-series="prediction"] input');
    if (predictionChip && predictionChip.checked !== enabled) {
      predictionChip.checked = enabled;
      predictionChip.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function applyConfidenceMode(summary) {
    const low = isLowConfidence(summary);
    const app = document.querySelector('.app');
    if (app) app.classList.toggle('is-low-confidence', low);
    if (low) setPredictionVisibility(false);
  }

  function renderInsightSupport(summary) {
    const card = $('insightCard');
    if (!card || !isLowConfidence(summary)) return;

    let support = card.querySelector('.insight-support');
    if (!support) {
      support = document.createElement('p');
      support.className = 'insight-support';
      card.appendChild(support);
    }

    const current = summary?.current || {};
    const currentWeight = fmtKg(current.weightKg);
    const trendWeight = fmtKg(current.weightEwmaKg);
    const reasons = summary?.modelDiagnostics?.confidence?.reasons || [];
    const reason = reasons[0] ? ` · ${reasons[0]}` : '';
    support.textContent = `오늘 ${currentWeight}, 추세 ${trendWeight}. 예측보다 측정 누적이 우선입니다${reason}`;
  }

  function renderModelExplanation(summary) {
    const confidence = summary?.modelDiagnostics?.confidence || {};
    setText('modelSummary', confidence.level === 'low' ? '측정률이 낮아 목표일 예측은 보류합니다.' : '최근 체중 추세를 중심으로 계산합니다.');
  }

  function readMae(backtest, horizon) {
    const value = backtest?.[horizon]?.maeKg;
    return isFiniteNumber(value) ? Number(value) : null;
  }

  function inferBaselineComparison(summary) {
    const diagnostics = summary?.modelDiagnostics || {};
    if (diagnostics.baselineComparison) return diagnostics.baselineComparison;

    const backtest = diagnostics.backtest || {};
    const kalman = diagnostics.modelComparison?.kalmanBacktest || {};
    const out = {};

    ['7d', '14d', '28d'].forEach((horizon) => {
      const currentMae = readMae(backtest, horizon);
      const kalmanMae = readMae(kalman, horizon);
      const values = { current: currentMae, kalman: kalmanMae };
      const valid = Object.entries(values).filter(([, v]) => isFiniteNumber(v));
      const winner = valid.length ? valid.reduce((best, next) => Number(next[1]) < Number(best[1]) ? next : best)[0] : null;
      out[horizon] = { currentMaeKg: currentMae, kalmanMaeKg: kalmanMae, winner };
    });

    return out;
  }

  function renderModelAudit(summary) {
    const strip = $('modelStrip');
    if (!strip) return;

    let audit = $('modelAudit');
    if (!audit) {
      audit = document.createElement('div');
      audit.id = 'modelAudit';
      audit.className = 'model-audit';
      strip.appendChild(audit);
    }

    const comparison = inferBaselineComparison(summary);
    const parts = ['7d', '14d', '28d'].map((horizon) => {
      const row = comparison[horizon] || {};
      const mae = isFiniteNumber(row.currentMaeKg) ? `${Number(row.currentMaeKg).toFixed(2)}kg` : '표본 부족';
      const win = row.winner ? ` · 우세 ${row.winner}` : '';
      return `${horizon} ${mae}${win}`;
    });

    audit.innerHTML = `
      <p class="label">모델 검증</p>
      <p class="model-audit-main" style="margin:6px 0 0;color:var(--ink);font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;text-transform:uppercase;letter-spacing:0.03em;">${parts.join(' · ')}</p>
    `;
  }

  function renderPredictionGuard(summary) {
    const guard = $('predictionGuard');
    if (!guard) return;
    if (isLowConfidence(summary)) {
      guard.hidden = false;
      guard.querySelector('#predictionGuardText').textContent = '최근 측정률이 낮아 현재는 실제 체중과 추세를 먼저 봅니다.';
    } else {
      guard.hidden = true;
    }
  }

  function renderSummaryMode(summary) {
    applyConfidenceMode(summary);
    renderInsightSupport(summary);
    renderScenarioState(summary);
    renderModelAudit(summary);
    renderPredictionGuard(summary);
  }

  function renderDetails(s) {
    const diagnostics = s.modelDiagnostics || {};
    const trendWindows = diagnostics.trendWindows || {};
    const tw = trendWindows;
    const order = ['3d', '7d', '14d', '28d'];
    const rows = order.map(k => ({ key: k, v: Number.isFinite(tw[k]?.weeklyLossKg) ? tw[k].weeklyLossKg : null })).filter(r => r.v !== null);
    const maxAbs = rows.length ? Math.max(...rows.map(r => Math.abs(r.v)), 0.0001) : 1;
    const trendBars = rows.map((r) => {
      const pct = Math.min(100, (Math.abs(r.v) / maxAbs) * 100);
      const sign = r.v >= 0 ? '+' : '−';
      const recent = r.key === '3d' ? ' is-recent' : '';
      return `<div class="windows-row${recent}"><span>${r.key}</span><span class="windows-bar-track"><span class="windows-bar-fill" style="width:${pct.toFixed(0)}%"></span></span><span class="windows-val">${sign}${Math.abs(r.v).toFixed(2)}</span></div>`;
    }).join('');
    const detailTrend = $('detailTrend');
    if (detailTrend) detailTrend.innerHTML = trendBars ? `<div class="windows-bars">${trendBars}</div>` : '<p class="detail-note">Insufficient data</p>';

    const coverage = diagnostics.coverage || s.coverage || {};
    const confidence = diagnostics.confidence || {};
    const backtest14 = diagnostics.backtest?.['14d'];
    const detailQuality = $('detailQuality');
    if (detailQuality) {
      const dq = diagnostics.dataQuality || {};
      const outliers = dq.outlierCandidates ?? 0;
      const variancePct = dq.recentCoveragePct ?? (coverage.last30Pct ?? 0);
      const outlierLevel = outliers <= 3 ? 'LOW' : (outliers <= 8 ? 'MED' : 'HIGH');
      const varianceLevel = variancePct >= 80 ? 'LOW' : (variancePct >= 50 ? 'MED' : 'HIGH');
      const outlierWidth = Math.max(0, Math.min(100, outliers * 10));
      const varianceWidth = Math.max(0, Math.min(100, variancePct));
      detailQuality.innerHTML = `
        <div class="quality-section">
          <div class="quality-row">
            <span class="quality-row-label">Noise</span>
            <div class="quality-bar-track"><span class="quality-bar-fill" style="width:${outlierWidth.toFixed(0)}%"></span></div>
            <span class="quality-val">${outlierLevel}${outliers > 0 ? ` ${outliers}` : ''}</span>
          </div>
          <div class="quality-row">
            <span class="quality-row-label">Variance</span>
            <div class="quality-bar-track"><span class="quality-bar-fill quality-bar-fill--accent" style="width:${varianceWidth.toFixed(0)}%"></span></div>
            <span class="quality-val">${varianceLevel} ${variancePct.toFixed(0)}%</span>
          </div>
        </div>
      `;
    }

    const diag = diagnostics;
    const calib = diag.calibration || {};
    const eff = calib.exerciseEfficiency;
    const kcal = diag.kcalPerKg;
    const src = diag.kcalPerKgSource;
    const detailMetabolic = $('detailMetabolic');
    if (detailMetabolic) detailMetabolic.innerHTML = `<p>Signal: ${Number.isFinite(eff) ? (eff < 0.7 ? 'Slow' : 'Standard') : '–'}</p><p>Signature: ${Number.isFinite(kcal) ? `${Math.round(kcal).toLocaleString('ko-KR')} kcal` : '–'}</p><p>${calib.interpretation || ''}</p>`;

    const detailMae = $('detailMae');
    if (detailMae) {
      const bt7 = diagnostics.backtest?.['7d'];
      const ciHitRate = s.predictionCI?.hitRate || {};
      const ci7 = Number.isFinite(ciHitRate['7d']) ? `${Math.round(Number(ciHitRate['7d']) * 100)}%` : 'pending';
      detailMae.innerHTML = `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);"><span>7d mae</span><span>${bt7?.status === 'ok' ? `${Number(bt7.maeKg).toFixed(2)}kg` : 'no sample'}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);"><span>14d mae</span><span>${backtest14?.status === 'ok' ? `${Number(backtest14.maeKg).toFixed(2)}kg` : 'no sample'}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;color:var(--accent);"><span>CI Hit Rate</span><span>${ci7}</span></div>`;
    }
  }

  window.addEventListener('garmin-weight:summary-ready', (event) => {
    renderQuality(event.detail.summary);
    renderScenarioSub(event.detail.summary);
    renderModelExplanation(event.detail.summary);
    renderSummaryMode(event.detail.summary);
    renderDetails(event.detail.summary);
  });
})();
