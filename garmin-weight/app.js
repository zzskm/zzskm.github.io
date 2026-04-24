'use strict';

(() => {
  const SUMMARY_URL = './data/summary.json';
  const CONFIG_URL = './config.json';
  const statusEl = document.getElementById('status');
  const reloadBtn = document.getElementById('reloadBtn');
  let chart;
  let activityChart;

  function fmtKg(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)} kg` : '-';
  }

  function fmtRate(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)} kg/주` : '-';
  }

  function fmtSteps(value) {
    return Number.isFinite(value) ? `${Math.round(value).toLocaleString('ko-KR')} 걸음` : '-';
  }

  function fmtMinutes(value) {
    return Number.isFinite(value) ? `${Math.round(value).toLocaleString('ko-KR')} 분` : '-';
  }

  function fmtKcal(value) {
    return Number.isFinite(value) ? `${Math.round(value).toLocaleString('ko-KR')} kcal` : '-';
  }

  function fmtDays(value) {
    return Number.isFinite(value) ? `${value} / 7일` : '-';
  }

  function fmtEta(goal) {
    if (!goal || !Number.isFinite(goal.etaDays)) {
      return '현 추세로 계산 불가';
    }
    if (goal.etaDays <= 0) {
      return '목표 도달';
    }
    const weeks = Math.floor(goal.etaDays / 7);
    const days = goal.etaDays % 7;
    if (weeks > 0 && days > 0) {
      return `${weeks}주 ${days}일`;
    }
    if (weeks > 0) {
      return `${weeks}주`;
    }
    return `${days}일`;
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) {
      node.textContent = value;
    }
  }

  function valueSeries(points) {
    return Array.isArray(points) ? points.map((point) => point.valueKg) : [];
  }

  function labelsForSummary(summary) {
    const seen = new Set();
    const labels = [];
    for (const group of ['daily', 'ma7', 'ma14', 'prediction']) {
      for (const point of summary.series?.[group] || []) {
        if (!seen.has(point.date)) {
          seen.add(point.date);
          labels.push(point.date);
        }
      }
    }
    return labels;
  }

  function alignPoints(labels, points) {
    const map = new Map((points || []).map((point) => [point.date, point.valueKg]));
    return labels.map((label) => map.has(label) ? map.get(label) : null);
  }

  function renderChart(summary) {
    const ctx = document.getElementById('weightChart');
    const labels = labelsForSummary(summary);

    if (chart) {
      chart.destroy();
    }

    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '실제 체중',
            data: alignPoints(labels, summary.series?.daily),
            borderColor: '#b14d24',
            backgroundColor: 'rgba(177, 77, 36, 0.12)',
            pointRadius: 3,
            pointHoverRadius: 5,
            spanGaps: true,
            tension: 0.25
          },
          {
            label: '7일 이동평균',
            data: alignPoints(labels, summary.series?.ma7),
            borderColor: '#285f79',
            borderWidth: 3,
            pointRadius: 0,
            spanGaps: true,
            tension: 0.25
          },
          {
            label: '14일 이동평균',
            data: alignPoints(labels, summary.series?.ma14),
            borderColor: '#90b9cd',
            borderWidth: 2,
            pointRadius: 0,
            spanGaps: true,
            tension: 0.2
          },
          {
            label: '기본 예측',
            data: alignPoints(labels, summary.series?.prediction),
            borderColor: '#5e4f42',
            borderDash: [8, 6],
            borderWidth: 2,
            pointRadius: 0,
            spanGaps: true,
            tension: 0.15
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            labels: {
              color: '#1b130e',
              usePointStyle: true,
              boxWidth: 10
            }
          },
          tooltip: {
            callbacks: {
              label(context) {
                return `${context.dataset.label}: ${fmtKg(context.parsed.y)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(92, 73, 57, 0.08)'
            },
            ticks: {
              color: '#6f6256',
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8
            }
          },
          y: {
            grid: {
              color: 'rgba(92, 73, 57, 0.08)'
            },
            ticks: {
              color: '#6f6256',
              callback(value) {
                return `${value} kg`;
              }
            }
          }
        }
      }
    });
  }

  function renderActivityChart(summary) {
    const ctx = document.getElementById('activityChart');
    if (!ctx) return;

    const stepsSeries = summary.series?.steps || [];
    const minutesSeries = summary.series?.exerciseMinutes || [];
    const labels = stepsSeries.map((p) => p.date);
    const minutesByDate = new Map(minutesSeries.map((p) => [p.date, p.value]));

    if (activityChart) {
      activityChart.destroy();
    }

    activityChart = new Chart(ctx, {
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: '걸음 수',
            data: stepsSeries.map((p) => p.value ?? 0),
            backgroundColor: 'rgba(40, 95, 121, 0.55)',
            borderColor: '#285f79',
            borderWidth: 1,
            yAxisID: 'ySteps'
          },
          {
            type: 'line',
            label: '운동 시간 (분)',
            data: labels.map((d) => minutesByDate.get(d) ?? 0),
            borderColor: '#b14d24',
            backgroundColor: 'rgba(177, 77, 36, 0.15)',
            pointRadius: 3,
            tension: 0.25,
            yAxisID: 'yMinutes'
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: '#1b130e', usePointStyle: true, boxWidth: 10 }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(92, 73, 57, 0.08)' },
            ticks: { color: '#6f6256', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }
          },
          ySteps: {
            position: 'left',
            beginAtZero: true,
            grid: { color: 'rgba(92, 73, 57, 0.08)' },
            ticks: {
              color: '#285f79',
              callback(value) { return `${(value / 1000).toFixed(0)}k`; }
            },
            title: { display: true, text: '걸음 수', color: '#285f79' }
          },
          yMinutes: {
            position: 'right',
            beginAtZero: true,
            grid: { drawOnChartArea: false },
            ticks: {
              color: '#b14d24',
              callback(value) { return `${value}분`; }
            },
            title: { display: true, text: '운동 시간', color: '#b14d24' }
          }
        }
      }
    });
  }

  function renderSummary(summary, config) {
    setText('currentWeight', fmtKg(summary.current?.weightKg));
    setText('ma7Weight', fmtKg(summary.current?.weightMa7Kg));
    setText('weeklyLossRate', fmtRate(summary.rolling?.weeklyLossRateKg));
    setText('predicted1m', fmtKg(summary.predictions?.oneMonthWeightKg));
    setText('predicted3m', fmtKg(summary.predictions?.threeMonthWeightKg));
    setText('goalEta', fmtEta(summary.goal));

    setText('stepsTotal', fmtSteps(summary.rolling?.last7StepsTotal));
    setText('stepsAvg', fmtSteps(summary.rolling?.last7StepsAvg));
    setText('exerciseMinutes', fmtMinutes(summary.rolling?.last7ExerciseMinutes));
    setText('exerciseCalories', fmtKcal(summary.rolling?.last7ExerciseCalories));
    setText('activeDays', fmtDays(summary.rolling?.last7ActiveDays));
    setText('weightRange', fmtKg(summary.rolling?.last7WeightRangeKg));

    const generatedAt = summary.generatedAt ? new Date(summary.generatedAt) : null;
    const targetText = Number.isFinite(config?.targetWeightKg)
      ? `목표 ${config.targetWeightKg.toFixed(1)} kg`
      : '목표 체중 미설정';

    if (generatedAt && !Number.isNaN(generatedAt.getTime())) {
      statusEl.textContent = `${targetText} · 마지막 생성 ${generatedAt.toLocaleString('ko-KR')}`;
    } else if ((summary.series?.daily || []).length > 0) {
      statusEl.textContent = `${targetText} · 요약 데이터는 로드됐지만 생성 시각은 없습니다.`;
    } else {
      statusEl.textContent = `${targetText} · 데이터가 없습니다. Garmin 동기화가 아직 실행되지 않았거나 인증에 실패했을 수 있습니다.`;
    }

    renderChart(summary);
    renderActivityChart(summary);
  }

  async function load() {
    reloadBtn.disabled = true;
    statusEl.textContent = '요약 데이터를 불러오는 중입니다.';
    try {
      const [summaryRes, configRes] = await Promise.all([
        fetch(`${SUMMARY_URL}?ts=${Date.now()}`, { cache: 'no-store' }),
        fetch(`${CONFIG_URL}?ts=${Date.now()}`, { cache: 'no-store' })
      ]);
      if (!summaryRes.ok) {
        throw new Error(`summary.json 로드 실패 (${summaryRes.status})`);
      }
      if (!configRes.ok) {
        throw new Error(`config.json 로드 실패 (${configRes.status})`);
      }
      const summary = await summaryRes.json();
      const config = await configRes.json();
      renderSummary(summary, config);
    } catch (error) {
      statusEl.textContent = `데이터를 불러오지 못했습니다: ${error.message}`;
      if (chart) {
        chart.destroy();
        chart = null;
      }
      if (activityChart) {
        activityChart.destroy();
        activityChart = null;
      }
    } finally {
      reloadBtn.disabled = false;
    }
  }

  reloadBtn.addEventListener('click', load);
  load();
})();
