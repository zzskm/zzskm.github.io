'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const isFiniteNumber = (v) => Number.isFinite(Number(v));

  function isLowConfidence(summary) {
    return summary?.modelDiagnostics?.confidence?.level === 'low';
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
    if (low) setPredictionVisibility(false);
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
      <p class="audit-label">모델 검증</p>
      <div class="model-audit-grid">
        <div class="audit-cell">
          <p class="audit-value">${parts[0]}</p>
        </div>
        <div class="audit-cell">
          <p class="audit-value">${parts[1]}</p>
        </div>
        <div class="audit-cell">
          <p class="audit-value">${parts[2]}</p>
        </div>
      </div>
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
      const sign = r.v > 0 ? '−' : '+';
      const recent = r.key === '3d' ? ' is-recent' : '';
      return `<div class="windows-row${recent}"><span>${r.key}</span><span class="windows-bar-track"><span class="windows-bar-fill" style="width:${pct.toFixed(0)}%"></span></span><span class="windows-val">${sign}${Math.abs(r.v).toFixed(2)}</span></div>`;
    }).join('');
    const detailTrend = $('detailTrend');
    if (detailTrend) detailTrend.innerHTML = trendBars ? `<div class="windows-bars">${trendBars}</div>` : '<p class="detail-note">표본 부족</p>';

    const coverage = diagnostics.coverage || s.coverage || {};
    const confidence = diagnostics.confidence || {};
    const backtest14 = diagnostics.backtest?.['14d'];
    const detailQuality = $('detailQuality');
    if (detailQuality) {
      const dq = diagnostics.dataQuality || {};
      const outliers = dq.outlierCandidates ?? 0;
      const variancePct = dq.recentCoveragePct ?? (coverage.last30Pct ?? 0);
      const outlierLevel = outliers <= 3 ? '낮음' : (outliers <= 8 ? '중간' : '높음');
      const varianceLevel = variancePct >= 80 ? '좋음' : (variancePct >= 50 ? '보통' : '부족');
      const outlierWidth = Math.max(0, Math.min(100, outliers * 10));
      const varianceWidth = Math.max(0, Math.min(100, variancePct));
      detailQuality.innerHTML = `
        <div class="quality-section">
          <div class="quality-row">
            <span class="quality-row-label">이상치</span>
            <div class="quality-bar-track"><span class="quality-bar-fill" style="width:${outlierWidth.toFixed(0)}%"></span></div>
            <span class="quality-val">${outlierLevel}${outliers > 0 ? ` ${outliers}` : ''}</span>
          </div>
          <div class="quality-row">
            <span class="quality-row-label">측정률</span>
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
    if (detailMetabolic) detailMetabolic.innerHTML = `<p>감량 반응: ${Number.isFinite(eff) ? (eff < 0.7 ? '운동 대비 변화 느림' : '운동 대비 변화 안정적') : '–'}</p><p>1kg 변화 기준: ${Number.isFinite(kcal) ? `${Math.round(kcal).toLocaleString('ko-KR')} kcal` : '–'}</p><p>${calib.interpretation || ''}</p>`;

    const detailMae = $('detailMae');
    if (detailMae) {
      const bt7 = diagnostics.backtest?.['7d'];
      const ciHitRate = s.predictionCI?.hitRate || {};
      const ci7 = Number.isFinite(ciHitRate['7d']) ? `${Math.round(Number(ciHitRate['7d']) * 100)}%` : '검증 대기';
      detailMae.innerHTML = `<div class="detail-row"><span class="detail-row-label">7일 예측 오차</span><span class="detail-row-value">${bt7?.status === 'ok' ? `${Number(bt7.maeKg).toFixed(2)}kg` : '표본 부족'}</span></div><div class="detail-row"><span class="detail-row-label">14일 예측 오차</span><span class="detail-row-value">${backtest14?.status === 'ok' ? `${Number(backtest14.maeKg).toFixed(2)}kg` : '표본 부족'}</span></div><div class="detail-row detail-row-accent"><span class="detail-row-label">신뢰구간 적중률</span><span class="detail-row-value">${ci7}</span></div>`;
    }
  }

  window.addEventListener('garmin-weight:summary-ready', (event) => {
    renderScenarioSub(event.detail.summary);
    renderSummaryMode(event.detail.summary);
    renderDetails(event.detail.summary);
  });
})();
