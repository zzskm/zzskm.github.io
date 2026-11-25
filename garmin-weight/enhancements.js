'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  // null과 빈 문자열은 숫자가 아니다(Number(null)은 0이라 그대로 넘기면 참이 된다).
  const isFiniteNumber = (v) => v !== null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
  const { fmtWeekly, modelLabel } = window.GWAppHelpers;

  function isLowConfidence(summary) {
    return summary?.modelDiagnostics?.confidence?.level === 'low';
  }

  function hasWeights(summary) {
    return (summary?.series?.daily || []).some((p) => Number.isFinite(p.valueKg));
  }

  // 3개월 예측이 "변화 없음"보다 나은지(modelDiagnostics.longRange). ok가 아니면 3개월 값은 장기 추정이다.
  function longRangeCaveat(summary) {
    const longRange = summary?.modelDiagnostics?.longRange;
    if (!longRange || longRange.status === 'ok' || !hasWeights(summary)) return null;
    if (longRange.status === 'worse_than_flat' && isFiniteNumber(longRange.maeKg) && isFiniteNumber(longRange.flatMaeKg)) {
      return `3개월 값은 장기 추정입니다 · 84일 검증 오차 ${Number(longRange.maeKg).toFixed(2)}kg, 변화 없음 가정 ${Number(longRange.flatMaeKg).toFixed(2)}kg`;
    }
    return '3개월 값은 장기 추정입니다 · 84일 검증 표본이 아직 모자랍니다';
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

    // P7: 시나리오마다 자기 곡선을 쓰므로 차이가 작은 것은 계산 실패가 아니라 활동량 변화의 효과가 작다는 뜻이다.
    const spread = scenarioSpreadKg(summary);
    const lowConfidence = isLowConfidence(summary);
    const caveat = longRangeCaveat(summary);
    const muted = lowConfidence || spread < 0.2;
    scenarios.classList.toggle('is-muted', muted);

    // 안내 문구는 .scenarios 밖(패널 머리)에 있다. 예전에는 .scenarios 안에서 찾아 문구가 한 번도 바뀌지 않았다(재검토 FE3).
    const hint = $('scenariosHint');
    if (!hint) return;
    if (!hasWeights(summary)) {
      hint.textContent = '체중 기록이 쌓이면 시나리오를 보여 줍니다';
    } else if (lowConfidence) {
      hint.textContent = '예측 신뢰도가 낮아 시나리오는 참고용입니다';
    } else if (caveat) {
      hint.textContent = caveat;
    } else if (spread < 0.2) {
      hint.textContent = '시나리오 간 3개월 차이가 0.2kg 미만입니다';
    } else {
      hint.textContent = '선택한 강도가 차트 예측선과 신뢰 띠에 반영됩니다';
    }
    hint.classList.toggle('is-caution', !hasWeights(summary) || lowConfidence || Boolean(caveat) || spread < 0.2);
  }

  function readMae(backtest, horizon) {
    const value = backtest?.[horizon]?.maeKg;
    return isFiniteNumber(value) ? Number(value) : null;
  }

  // P6(M1): 운영 / 섀도 후보 / Kalman / 변화 없음을 같은 기준 시점(n)으로 한 표에 보여 준다.
  // 모델 이름표(modelLabel)는 app.helpers.js에 있다.
  const AUDIT_HORIZONS = ['7d', '14d', '28d', '84d'];

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
    if (!hasWeights(summary)) {
      guard.hidden = false;
      guard.querySelector('.prediction-guard-title').textContent = '기록 없음';
      guard.querySelector('#predictionGuardText').textContent = '체중을 재면 추세와 예측을 보여 줍니다.';
      const note = $('predictionGuardNote');
      if (note) note.textContent = '';
    } else if (isLowConfidence(summary)) {
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

  // F7: 문자열을 HTML로 끼워 넣지 않고 요소를 만들어 textContent로 채운다.
  function node(tag, className, text, children = []) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = text;
    children.forEach((child) => n.appendChild(child));
    return n;
  }
  function bar(trackClass, fillClass, pct) {
    const fill = node('span', fillClass);
    fill.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(0)}%`;
    return node(trackClass === 'windows-bar-track' ? 'span' : 'div', trackClass, null, [fill]);
  }
  function detailRow(label, value, accent = false) {
    return node('div', accent ? 'detail-row detail-row-accent' : 'detail-row', null, [
      node('span', 'detail-row-label', label),
      node('span', 'detail-row-value', value),
    ]);
  }

  function renderDetails(s) {
    const diagnostics = s.modelDiagnostics || {};
    const tw = diagnostics.trendWindows || {};
    // trendWindows에는 7·14·28일 창이 있다. 가장 짧은 창(7일)이 추세 배지의 기준이라 색을 달리한다.
    const rows = ['7d', '14d', '28d']
      .map((k) => ({ key: k, v: Number.isFinite(tw[k]?.weeklyLossKg) ? tw[k].weeklyLossKg : null }))
      .filter((r) => r.v !== null);
    const maxAbs = rows.length ? Math.max(...rows.map((r) => Math.abs(r.v)), 0.0001) : 1;
    const detailTrend = $('detailTrend');
    if (detailTrend) {
      // weeklyLossKg는 양수 = 감량. 표시는 체중 변화 방향(감량 = −)이다.
      const bars = rows.map((r) => node('div', r.key === '7d' ? 'windows-row is-recent' : 'windows-row', null, [
        node('span', null, r.key.replace('d', '일')),
        bar('windows-bar-track', 'windows-bar-fill', (Math.abs(r.v) / maxAbs) * 100),
        node('span', 'windows-val', fmtWeekly(r.v)),
      ]));
      detailTrend.replaceChildren(bars.length ? node('div', 'windows-bars', null, bars) : node('p', 'detail-note', '표본 부족'));
    }

    const coverage = diagnostics.coverage || s.coverage || {};
    const detailQuality = $('detailQuality');
    if (detailQuality) {
      const dq = diagnostics.dataQuality || {};
      // 최근 창(기본 60일)에서 직전 측정과 크게 벌어진 측정 수. 창 길이가 없는 예전 요약은 전체 이력에서 센 값이다.
      const outliers = dq.outlierCandidates ?? 0;
      const outlierLabel = isFiniteNumber(dq.outlierWindowDays) ? `이상치 · ${dq.outlierWindowDays}일` : '이상치';
      const coveragePct = dq.recentCoveragePct ?? (coverage.last30Pct ?? 0);
      const outlierLevel = outliers <= 3 ? '낮음' : (outliers <= 8 ? '중간' : '높음');
      const coverageLevel = coveragePct >= 80 ? '좋음' : (coveragePct >= 50 ? '보통' : '부족');
      detailQuality.replaceChildren(node('div', 'quality-section', null, [
        node('div', 'quality-row', null, [
          node('span', 'quality-row-label', outlierLabel),
          bar('quality-bar-track', 'quality-bar-fill', outliers * 10),
          node('span', 'quality-val', `${outlierLevel}${outliers > 0 ? ` ${outliers}` : ''}`),
        ]),
        node('div', 'quality-row', null, [
          node('span', 'quality-row-label', '측정률'),
          bar('quality-bar-track', 'quality-bar-fill quality-bar-fill--accent', coveragePct),
          node('span', 'quality-val', `${coverageLevel} ${Number(coveragePct).toFixed(0)}%`),
        ]),
      ]));
    }

    const calib = diagnostics.calibration || {};
    const eff = calib.exerciseEfficiency;
    const kcal = diagnostics.kcalPerKg;
    const detailMetabolic = $('detailMetabolic');
    if (detailMetabolic) {
      detailMetabolic.replaceChildren(
        node('p', null, `감량 반응: ${Number.isFinite(eff) ? (eff < 0.7 ? '운동 대비 변화 느림' : '운동 대비 변화 안정적') : '–'}`),
        node('p', null, `1kg 변화 기준: ${Number.isFinite(kcal) ? `${Math.round(kcal).toLocaleString('ko-KR')} kcal` : '–'}`),
        node('p', null, calib.interpretation || ''),
      );
    }

    const detailMae = $('detailMae');
    if (detailMae) {
      const mae = (h) => {
        const bt = diagnostics.backtest?.[h];
        return bt?.status === 'ok' ? `${Number(bt.maeKg).toFixed(2)}kg` : '표본 부족';
      };
      const ciHitRate = s.predictionCI?.hitRate || {};
      const ci7 = Number.isFinite(ciHitRate['7d']) ? `${Math.round(Number(ciHitRate['7d']) * 100)}%` : '검증 대기';
      // 3개월 값의 근거. "변화 없음" 가정의 오차와 나란히 적는다(modelDiagnostics.longRange).
      const longRange = diagnostics.longRange || {};
      const flatMae = isFiniteNumber(longRange.flatMaeKg) ? ` · 변화 없음 ${Number(longRange.flatMaeKg).toFixed(2)}kg` : '';
      detailMae.replaceChildren(
        detailRow('7일 예측 오차', mae('7d')),
        detailRow('14일 예측 오차', mae('14d')),
        detailRow('84일 예측 오차', `${mae('84d')}${diagnostics.backtest?.['84d']?.status === 'ok' ? flatMae : ''}`, longRange.status === 'worse_than_flat'),
        detailRow('7일 신뢰구간 적중률', ci7, true),
      );
    }
  }

  window.addEventListener('garmin-weight:summary-ready', (event) => {
    renderScenarioSub(event.detail.summary);
    renderSummaryMode(event.detail.summary);
    renderDetails(event.detail.summary);
  });
})();
