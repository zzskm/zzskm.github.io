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

  function readMae(backtest, horizon) {
    const value = backtest?.[horizon]?.maeKg;
    return isFiniteNumber(value) ? Number(value) : null;
  }

  // P6(M1): 운영 / 섀도 후보 / Kalman / 변화 없음을 같은 기준 시점(n)으로 한 표에 보여 준다.
  const AUDIT_HORIZONS = ['7d', '14d', '28d', '84d'];
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

  function okMae(stats, horizon) {
    return stats?.[horizon]?.status === 'ok' ? readMae(stats, horizon) : null;
  }

  // 게이트를 통과한 후보가 있으면 그 후보, 없으면 운영 모델 대비 MAE 비율이 가장 낮은 회귀·평균 후보.
  function shadowRow(diagnostics) {
    const gate = diagnostics.selectedModel || {};
    const audit = diagnostics.modelAudit || {};
    if (gate.status === 'shadow_leader' && audit[gate.name]) return { name: gate.name, passed: true };
    const current = diagnostics.backtest || {};
    let best = null;
    Object.entries(audit).forEach(([name, stats]) => {
      if (name === 'kalman' || name === 'ewma_flat') return;
      const ratios = AUDIT_HORIZONS
        .map((h) => { const base = okMae(current, h); const mae = okMae(stats, h); return base && mae !== null ? mae / base : null; })
        .filter((v) => v !== null);
      if (!ratios.length) return;
      const score = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      if (!best || score < best.score) best = { name, score };
    });
    return best ? { name: best.name, passed: false } : null;
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

    const diagnostics = summary?.modelDiagnostics || {};
    const counts = diagnostics.backtestSampleCounts || {};
    const models = diagnostics.modelAudit || {};
    const shadow = shadowRow(diagnostics);
    const rows = [
      { label: modelLabel('current'), stats: diagnostics.backtest || {}, operational: true },
      shadow && { label: `섀도 · ${modelLabel(shadow.name)}`, stats: models[shadow.name] || {}, note: shadow.passed ? '게이트 통과 · 예측에는 쓰지 않음' : '게이트 미통과' },
      { label: modelLabel('kalman'), stats: models.kalman || {} },
      { label: modelLabel('ewma_flat'), stats: models.ewma_flat || {} },
    ].filter(Boolean);
    const best = Object.fromEntries(AUDIT_HORIZONS.map((h) => {
      const values = rows.map((row) => okMae(row.stats, h)).filter((v) => v !== null);
      return [h, values.length ? Math.min(...values) : null];
    }));

    const table = document.createElement('table');
    table.className = 'audit-table';
    const head = table.createTHead().insertRow();
    const corner = document.createElement('th');
    corner.scope = 'col';
    corner.textContent = '모델';
    head.appendChild(corner);
    AUDIT_HORIZONS.forEach((h) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h.replace('d', '일');
      const n = document.createElement('span');
      n.className = 'audit-n';
      n.textContent = `n=${Number.isFinite(counts[h]) ? counts[h] : '–'}`;
      th.appendChild(n);
      head.appendChild(th);
    });
    const body = table.createTBody();
    rows.forEach((row) => {
      const tr = body.insertRow();
      if (row.operational) tr.className = 'is-operational';
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = row.label;
      if (row.note) {
        const note = document.createElement('span');
        note.className = 'audit-note';
        note.textContent = row.note;
        th.appendChild(note);
      }
      tr.appendChild(th);
      AUDIT_HORIZONS.forEach((h) => {
        const td = tr.insertCell();
        const mae = okMae(row.stats, h);
        td.textContent = mae === null ? '–' : mae.toFixed(2);
        if (mae !== null && mae === best[h]) td.className = 'is-best';
      });
    });

    const label = document.createElement('p');
    label.className = 'audit-label';
    label.textContent = '모델 검증 · 예측 오차(MAE, kg)';
    const wrap = document.createElement('div');
    wrap.className = 'audit-table-wrap';
    wrap.appendChild(table);
    const verdict = document.createElement('p');
    verdict.className = 'audit-sub';
    const leader = diagnostics.selectedModel?.status === 'shadow_leader' ? modelLabel(diagnostics.selectedModel.name) : null;
    verdict.textContent = `${leader ? `섀도 후보 ${leader}이(가) 게이트를 통과했지만` : '게이트를 통과한 섀도 후보가 없고'} 예측은 운영 모델로 계산합니다. 모든 모델을 같은 기준 시점(n)으로 비교했습니다.`;
    audit.replaceChildren(label, wrap, verdict);
  }

  function renderPredictionGuard(summary) {
    const guard = $('predictionGuard');
    if (!guard) return;
    if (isLowConfidence(summary)) {
      const diagnostics = summary?.modelDiagnostics || {};
      const reasons = (diagnostics.confidence?.reasons || []).filter(Boolean);
      guard.hidden = false;
      guard.querySelector('.prediction-guard-title').textContent = '참고용 예측';
      guard.querySelector('#predictionGuardText').textContent = reasons.length
        ? reasons.join(' · ')
        : '최근 측정률이 낮아 예측 신뢰도가 낮습니다.';
      const note = $('predictionGuardNote');
      if (note) {
        const score = diagnostics.confidence?.score ?? 0;
        const measured = diagnostics.coverage?.measuredDays ?? '–';
        const total = diagnostics.coverage?.totalDays ?? 30;
        note.textContent = `신뢰도 ${score}/6 · 측정 ${measured}/${total}일`;
      }
    } else {
      guard.hidden = true;
    }
  }

  function renderSummaryMode(summary) {
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
