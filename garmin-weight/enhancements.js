'use strict';

(() => {
  const SUMMARY_URL = './data/summary.json';

  const $ = (id) => document.getElementById(id);
  const isFiniteNumber = (v) => Number.isFinite(Number(v));

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

  function summarizeMissing(series, label) {
    const points = Array.isArray(series) ? series.slice(-30) : [];
    if (!points.length) return null;
    const missing = points.filter((p) => !isFiniteNumber(p.value)).length;
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
      ? '데이터 부족. 예측보다 측정 누적이 우선.'
      : '최근 체중 추세 중심 · 장기 예측은 보수 감속';

    const efficiency = isFiniteNumber(calibration.exerciseEfficiency)
      ? `운동 효율 ${Math.round(Number(calibration.exerciseEfficiency) * 100)}%`
      : '운동 효율 표본 부족';

    setText('modelSummary', modelSummary);
    setText('modelCoverage', `${sourceLabel} · ${efficiency}`);
  }

  async function init() {
    try {
      const res = await fetch(SUMMARY_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`summary fetch failed: ${res.status}`);
      const summary = await res.json();
      renderQuality(summary);
      renderScenarioSub(summary);
      renderModelExplanation(summary);
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
