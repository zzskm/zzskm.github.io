'use strict';

(() => {
  const SUMMARY_URL = './data/summary.json';
  const LOW_CONFIDENCE_MEASUREMENT_TARGET_DAYS = 7;

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

  function confidenceLevel(summary) {
    return summary?.modelDiagnostics?.confidence?.level || 'low';
  }

  function isLowConfidence(summary) {
    return confidenceLevel(summary) === 'low';
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

    setText('qualityStatus', confidence.label || '낮음');
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

    const card = $('qualityCard');
    if (card) {
      card.dataset.level = confidence.level || 'low';
    }
  }

  function renderScenarioSub(summary) {
    const scenarios = summary?.predictions?.scenarios || {};
    document.querySelectorAll('.scenario').forEach((card) => {
      const key = card.dataset.scenario;
      const data = scenarios[key];
      const sub = card.querySelector('.scenario-sub');
      if (!sub || !data) return;

      const delta = isFiniteNumber(data.weeklyKcalDelta)
        ? Number(data.weeklyKcalDelta)
        : null;
      const kcalText = delta === null || Math.abs(delta) < 1
        ? '현재 운동량 유지'
        : `${delta > 0 ? '+' : '−'}주 ${Math.abs(Math.round(delta)).toLocaleString('ko-KR')} kcal`;
      sub.textContent = kcalText;

      if (data.description) {
        card.setAttribute('title', data.description);
      }
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

    if (low) {
      setText('goalEta', '측정 7일 더 필요');
      setText('goalEtaDate', '최근 측정률이 낮아 목표일 예측은 보류합니다');
      setText('goalSubtitle', buildLowConfidenceSubtitle(summary));
      setPredictionVisibility(false);
    }
  }

  function buildLowConfidenceSubtitle(summary) {
    const current = summary?.current || {};
    const coverage = summary?.coverage || {};
    const trend = isFiniteNumber(current.weightEwmaKg) ? `추세 ${fmtKg(current.weightEwmaKg)}` : '추세 계산 중';
    const measured = isFiniteNumber(coverage.last30Pct) ? `측정률 ${pct(coverage.last30Pct)}` : '측정률 부족';
    return `${trend} · ${measured} · 목표일 예측 보류`;
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
    const calibration = summary?.modelDiagnostics?.calibration || {};
    const kcalSource = summary?.modelDiagnostics?.kcalPerKgSource;

    const sourceLabel = {
      body_fat: '체지방률 기반',
      bmi: 'BMI 기반',
      default: '기본값 기반',
    }[kcalSource] || '기본값 기반';

    const modelSummary = confidence.level === 'low'
      ? '측정률이 낮아 목표일 예측은 보류합니다.'
      : '최근 체중 추세를 중심으로 계산합니다.';

    const efficiency = isFiniteNumber(calibration.exerciseEfficiency)
      ? `운동 효율 ${Math.round(Number(calibration.exerciseEfficiency) * 100)}%`
      : '운동 시나리오는 참고용';

    setText('modelSummary', modelSummary);
    setText('modelCoverage', `${sourceLabel} · ${efficiency}`);
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
      const values = {
        current: currentMae,
        kalman: kalmanMae,
      };
      const valid = Object.entries(values).filter(([, v]) => isFiniteNumber(v));
      const winner = valid.length
        ? valid.reduce((best, next) => Number(next[1]) < Number(best[1]) ? next : best)[0]
        : null;
      out[horizon] = {
        currentMaeKg: currentMae,
        kalmanMaeKg: kalmanMae,
        winner,
        note: '클라이언트 추정값. flat/MA7/EWMA baseline은 sync 단계 추가 필요.',
      };
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
    const ciHitRate = summary?.predictionCI?.hitRate || {};
    const parts = ['7d', '14d', '28d'].map((horizon) => {
      const row = comparison[horizon] || {};
      const mae = isFiniteNumber(row.currentMaeKg) ? `${Number(row.currentMaeKg).toFixed(2)}kg` : '표본 부족';
      const win = row.winner ? ` · 우세 ${row.winner}` : '';
      return `${horizon} ${mae}${win}`;
    });

    const ciParts = ['7d', '14d', '28d']
      .filter((horizon) => isFiniteNumber(ciHitRate[horizon]))
      .map((horizon) => `${horizon} ${Math.round(Number(ciHitRate[horizon]) * 100)}%`);

    audit.innerHTML = `
      <p class="label">모델 검증</p>
      <p class="model-audit-main">${parts.join(' · ')}</p>
      <p class="model-audit-sub">${ciParts.length ? `80% 신뢰띠 적중률 ${ciParts.join(' · ')}` : '신뢰띠 적중률은 sync 단계 계산 필요'}</p>
    `;
  }

  function renderPredictionGuard(summary) {
    const panel = document.querySelector('.panel');
    if (!panel) return;

    let guard = $('predictionGuard');
    if (!guard) {
      guard = document.createElement('p');
      guard.id = 'predictionGuard';
      guard.className = 'prediction-guard';
      const chart = panel.querySelector('.chart-wrap');
      if (chart) panel.insertBefore(guard, chart);
    }

    if (isLowConfidence(summary)) {
      guard.hidden = false;
      guard.textContent = '예측선은 기본 숨김입니다. 최근 측정률이 낮아 현재는 실제 체중과 추세를 먼저 봅니다.';
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

  async function init() {
    try {
      const res = await fetch(SUMMARY_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`summary fetch failed: ${res.status}`);
      const summary = await res.json();
      renderQuality(summary);
      renderScenarioSub(summary);
      renderModelExplanation(summary);
      renderSummaryMode(summary);
    } catch (err) {
      console.warn('[garmin-weight enhancements]', err);
      setText('qualityStatus', '불러오기 실패');
      setText('qualityReason', 'summary.json 확인 필요');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
