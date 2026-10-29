'use strict';

(() => {
  const M = window.PersonalDashboard;
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const time = t => `${pad(t.h)}:${pad(t.m)}`;
  const duration = mins => `${mins < 0 ? '−' : ''}${Math.floor(Math.abs(mins) / 60)}시간 ${pad(Math.abs(mins) % 60)}분`;
  const set = (id, text) => { if ($(id).textContent !== String(text)) $(id).textContent = text; };
  function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  let state = M.normalize(read('wht.state.v2'));
  let summary = null, config = null, range = 30, showPrediction = true, weightLoading = null, lastWeightAttempt = 0;
  let previousWork = null;
  // Colors follow the OS light/dark preference only; the bus widget inherits them across its shadow boundary.

  // General alarms, the shared banner and sound/permission state never wait for the bus widget.
  const R = window.AlertRuntime;
  R.init(document);
  window.ClockView.mount($('clock-view'), {simple:true});
  function readinessIssues() {
    const r = R.readiness(), issues = [];
    if (R.state.permissionError) issues.push('OS 알림 권한 요청 실패');
    else if (r.permission === 'default') issues.push('OS 알림 허용 필요');
    else if (r.permission === 'denied') issues.push('OS 알림 차단 · 화면 알림만');
    else if (r.permission === 'unsupported') issues.push('OS 알림 미지원 · 화면 알림만');
    if (R.state.audioError) issues.push('소리 활성화 실패');
    else if (r.sound === 'locked') issues.push('소리 켜기 필요');
    else if (r.sound === 'unsupported') issues.push('소리 미지원');
    return {r, issues};
  }
  function renderReadiness() {
    const {issues} = readinessIssues();
    set('alert-ready', issues.length ? issues.join(' · ') : '알림 준비됨');
    $('alert-ready').classList.toggle('is-ready', !issues.length);
  }
  $('alert-ready').addEventListener('click', () => {
    const {r} = readinessIssues();
    if (r.sound === 'locked' || R.state.audioError) R.ensureAudio();
    if (r.permission === 'default') R.requestPermission();
    const note = r.permission === 'denied' ? '알림이 차단되어 있습니다. 브라우저 주소창의 사이트 설정에서 알림을 허용해 주세요.'
      : r.permission === 'unsupported' ? '이 브라우저는 OS 알림을 지원하지 않아 화면 배너와 소리로만 알립니다.' : '';
    set('alert-ready-note', note); $('alert-ready-note').hidden = !note;
    setTimeout(renderReadiness, 200);
  });
  R.subscribe(renderReadiness); renderReadiness();

  function syncInputs() {
    $('work-start').value = time(state.start);
    $('work-end').value = time(state.end);
    $('work-base').value = state.baseH * 60 + state.baseM;
    $('work-rest').value = state.breakH * 60 + state.breakM;
    const enabled = state.notifyEnabled;
    set('work-notify', `퇴근 알림 ${enabled ? '켜짐' : '꺼짐'}`);
    $('work-notify').setAttribute('aria-pressed', String(enabled));
  }
  function commit(message = '설정을 저장했습니다.') {
    const saved = save('wht.state.v2', state);
    set('work-message', saved ? message : '브라우저 저장소를 사용할 수 없어 이 탭에서만 적용됩니다.');
    previousWork = null;
    syncInputs(); tick();
  }
  for (const [id, key] of [['work-start','start'],['work-end','end']]) {
    $(id).addEventListener('change', () => {
      if (!$(id).reportValidity()) return;
      const [h,m] = $(id).value.split(':').map(Number);
      state[key] = {h,m}; commit();
    });
  }
  for (const key of ['start','end']) {
    document.querySelectorAll(`[data-${key}-nudge]`).forEach(button => button.addEventListener('click', () => {
      const delta = Number(button.getAttribute(`data-${key}-nudge`));
      state[key] = M.nudgeTime(state[key], delta);
      commit(`${key === 'start' ? '출근' : '퇴근'} ${time(state[key])} · ${Math.abs(delta)}분 ${delta < 0 ? '앞당겼습니다' : '늦췄습니다'}.`);
    }));
  }
  for (const [id, prefix] of [['work-base','base'],['work-rest','break']]) {
    $(id).addEventListener('change', () => {
      if (!$(id).reportValidity()) return;
      const n = Number($(id).value);
      state[`${prefix}H`] = Math.floor(n / 60);
      state[`${prefix}M`] = n % 60;
      commit();
    });
  }
  $('start-now').addEventListener('click', () => {
    const now = new Date();
    state.start = {h:now.getHours(),m:now.getMinutes()}; commit();
  });
  $('work-notify').addEventListener('click', async () => {
    if (state.notifyEnabled) { state.notifyEnabled = false; commit(); return; }
    if (!('Notification' in window)) { set('work-message', '이 브라우저에서는 OS 알림을 지원하지 않습니다.'); return; }
    try {
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission !== 'granted') { set('work-message', '브라우저의 사이트 설정에서 알림을 허용해 주세요.'); return; }
      state.notifyEnabled = true; commit();
    } catch { set('work-message', '알림 권한을 확인할 수 없습니다.'); }
  });
  function notifyWork(view) {
    const prev = previousWork;
    previousWork = view;
    if (!prev || prev.end.getTime() !== view.end.getTime() || !state.notifyEnabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const threshold = [0,60,300].find(n => prev.remain > n && view.remain <= n);
    if (threshold === undefined) return;
    const title = threshold === 0 ? '퇴근 시각입니다' : `${threshold / 60}분 뒤 퇴근`;
    try { new Notification(title, {body:'오늘 하루 수고하셨습니다.',tag:'wht'}); } catch { /* OS notification unavailable */ }
  }
  function tick() {
    const now = new Date(), view = M.work(state, now);
    notifyWork(view);
    if (document.hidden) return;
    set('clock', `${pad(now.getHours())}:${pad(now.getMinutes())}`);
    $('clock').dateTime = now.toISOString();
    set('today', new Intl.DateTimeFormat('ko-KR', {year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(now));
    set('work-state', {waiting:'출근 전',working:'근무 중',done:'오늘 근무 완료'}[view.phase]);
    $('work-panel').dataset.phase = view.phase;
    set('remain-label', view.phase === 'waiting' ? '오늘 예정된 근무 시간 · 휴게 포함' : view.phase === 'done' ? '오늘도 수고하셨습니다' : '퇴근까지 남은 시간');
    set('remain', `${pad(Math.floor(view.remain / 3600))}:${pad(Math.floor(view.remain % 3600 / 60))}`);
    set('remain-seconds', pad(view.remain % 60));
    set('work-elapsed', `${duration(Math.floor(view.elapsed / 60))} 경과`);
    set('work-percent', `${view.percent.toFixed(1)}%`);
    $('work-fill').style.width = `${view.percent}%`;
    $('work-progress').setAttribute('aria-valuenow', String(Math.round(view.percent)));
    set('work-total', duration(view.workM));
    set('work-extra', `${view.extraM >= 0 ? '+' : ''}${duration(view.extraM)}`);
    set('work-break', duration(view.breakM));
    if (view.workM < 0) set('work-message', '휴게시간이 전체 근무시간보다 깁니다. 설정을 확인해 주세요.');
    document.title = view.phase === 'working' ? `${$('remain').textContent} · 오늘의 대시보드` : '오늘의 대시보드';
  }
  syncInputs(); tick();
  setInterval(tick, 1000);

  const fmt = (value, digits = 1) => Number.isFinite(value) ? value.toLocaleString('ko-KR', {minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
  function renderChart() {
    const {actual:points,trend,prediction,band} = M.weightChart(summary, range, showPrediction), host = $('weight-chart');
    document.querySelectorAll('[data-days]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === range)));
    $('weight-prediction-toggle').setAttribute('aria-pressed', String(showPrediction));
    set('weight-prediction-toggle', `예측 ${showPrediction ? '켜짐' : '꺼짐'}`);
    document.querySelector('.legend-trend').hidden = !trend.length;
    document.querySelector('.legend-prediction').hidden = !prediction.length;
    document.querySelector('.legend-band').hidden = !band.length;
    if (!points.length) {
      host.textContent = '이 기간에 측정 기록이 없습니다.';
      host.setAttribute('aria-label', '선택 기간에 체중 측정 기록 없음');
      set('chart-start','—'); set('chart-end','—'); set('chart-caption','측정 기록 없음'); return;
    }
    const all = [...points,...trend,...prediction];
    const values = [...all.map(p => p.valueKg),...band.flatMap(p => [p.lower,p.upper])];
    const low = Math.min(...values) - .3, high = Math.max(...values) + .3;
    const dates = all.map(p => p.date).sort();
    const first = Date.parse(dates[0]), last = Date.parse(dates.at(-1));
    const x = p => 8 + (Date.parse(p.date) - first) / (last - first || 1) * 432;
    const y = value => 170 - (value - low) / (high - low) * 150;
    const xy = list => list.map(p => `${x(p).toFixed(2)},${y(p.valueKg).toFixed(2)}`).join(' ');
    const chartDate = value => value.slice(5).replace('-', '.');
    const label = `${points[0].date}부터 ${points.at(-1).date}까지 실측 ${points.length}건.${trend.length ? ' 추세선 포함.' : ''}${prediction.length ? ` ${prediction.at(-1).date} 예측 ${fmt(prediction.at(-1).valueKg)}kg.${band.length ? ' 80% 신뢰띠 포함.' : ''}` : ''}`;
    const line = (list, cls) => list.length ? `<polyline class="${cls}" points="${xy(list)}"/>${list.length === 1 ? `<circle class="${cls}" cx="${x(list[0])}" cy="${y(list[0].valueKg)}" r="3"/>` : ''}` : '';
    const bandPoints = [...band.map(p => `${x(p)},${y(p.upper)}`),...band.slice().reverse().map(p => `${x(p)},${y(p.lower)}`)].join(' ');
    const ticks = [high,(high + low) / 2,low];
    // Every interpolated value is a finite number or an ISO date from validated points.
    host.innerHTML = `<svg viewBox="0 0 500 190" preserveAspectRatio="none" aria-hidden="true">
      ${ticks.map(v => `<path class="chart-grid" d="M0 ${y(v)}H448"/><text class="chart-axis" x="458" y="${y(v)+4}">${v.toFixed(1)}</text>`).join('')}
      ${band.length > 1 ? `<polygon class="chart-band" points="${bandPoints}"/>` : ''}
      <polygon class="chart-area" points="${x(points[0])},178 ${xy(points)} ${x(points.at(-1))},178"/>
      ${line(points,'chart-line')}${line(trend,'chart-trend')}${line(prediction,'chart-prediction')}
      ${points.map(p => `<circle class="chart-dot" cx="${x(p)}" cy="${y(p.valueKg)}" r="2.5"/>`).join('')}
      ${prediction.length ? `<path class="chart-boundary" d="M${x(prediction[0])} 12V178"/>` : ''}
      </svg>`;
    host.setAttribute('aria-label', label);
    set('chart-start', chartDate(dates[0])); set('chart-end', chartDate(dates.at(-1)));
    set('chart-caption', prediction.length ? `과거 ${range}일 · 향후 3개월 예측` : `최근 ${range}일 기록`);
  }
  function renderPrediction() {
    const diag = summary.modelDiagnostics || {}, forecast = summary.predictions || {};
    const enabled = diag.trend?.predictionEnabled !== false;
    const loss = summary.rolling?.lossRateDetail?.blended;
    set('weight-trend', Number.isFinite(loss) ? `${loss > 0 ? '−' : loss < 0 ? '+' : ''}${fmt(Math.abs(loss),2)} kg/주` : '자료 부족');
    set('weight-month', enabled && Number.isFinite(forecast.oneMonthWeightKg) ? `${fmt(forecast.oneMonthWeightKg)} kg` : '예측 보류');
    set('weight-quarter', enabled && Number.isFinite(forecast.threeMonthWeightKg) ? `${fmt(forecast.threeMonthWeightKg)} kg` : '예측 보류');
    const available = enabled && (M.weightChart(summary).prediction.length > 0 || Number.isFinite(forecast.oneMonthWeightKg) || Number.isFinite(forecast.threeMonthWeightKg));
    const confidence = diag.confidence || {};
    const confidenceLabel = {low:'낮음',medium:'보통',high:'높음'}[confidence.level] || '미확인';
    const reasons = Array.isArray(confidence.reasons) ? confidence.reasons.filter(r => typeof r === 'string').join(' · ') : '';
    set('weight-prediction-note', available ? `현재 운동량 유지 기준 · 신뢰도 ${confidenceLabel}${reasons ? ` — ${reasons}` : ''}. 자료 생성 시점의 참고용 예측입니다.` : `예측 보류 · ${diag.trend?.disabledReason || '예측에 필요한 자료가 부족합니다.'}`);
    $('weight-prediction-note').classList.toggle('is-caution', !available || confidence.level !== 'high');
    const activity = summary.rolling?.exerciseTrend;
    set('weight-activity-trend', Number.isFinite(activity?.deltaPct) ? `운동 칼로리 ${activity.deltaPct > 0 ? '+' : activity.deltaPct < 0 ? '−' : ''}${fmt(Math.abs(activity.deltaPct * 100),1)}% · 최근 7일 평균 / 이전 21일 평균` : '운동량 비교 자료가 아직 없습니다.');
  }
  function renderWeight() {
    const c = summary.current || {}, r = summary.rolling || {}, change = M.weightChange(summary);
    set('weight', fmt(c.weightKg));
    set('weight-change', Number.isFinite(change) ? `${change > 0 ? '+' : change < 0 ? '−' : ''}${fmt(Math.abs(change))} kg` : '—');
    const p = M.points(summary, 30);
    set('weight-period', p.length > 1 ? `${p[0].date.slice(5).replace('-','.')} → ${p.at(-1).date.slice(5).replace('-','.')}` : '최근 30일 변화');
    const age = c.weightDate ? Math.floor((Date.parse(new Date().toLocaleDateString('sv-SE', {timeZone:'Asia/Seoul'})) - Date.parse(c.weightDate)) / 86400000) : null;
    set('weight-measured', c.weightDate ? `${c.weightDate} 측정${age > 1 ? ` · ${age}일 전 기록` : ''}` : '측정 기록 없음');
    set('weight-goal', config ? `${fmt(config.targetWeightKg)} kg` : '—');
    set('weight-fat', `${fmt(c.bodyFatPercent)} %`);
    set('weight-steps', `${fmt(r.last7StepsAvg,0)} 보`);
    set('weight-exercise', `${fmt(r.last7ExerciseMinutes,0)} 분`);
    const stamp = Date.parse(summary.generatedAt);
    const generated = Number.isFinite(stamp) ? new Intl.DateTimeFormat('ko-KR', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'}).format(stamp) : '시각 미확인';
    set('weight-status', `자료 생성 ${generated}${config ? '' : ' · 목표 설정 조회 실패'}`);
    renderPrediction(); renderChart();
  }
  async function get(url, asText = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, {cache:'no-cache',signal:controller.signal});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await (asText ? res.text() : res.json());
    } finally { clearTimeout(timer); }
  }
  function loadWeight() {
    if (weightLoading) return weightLoading;
    lastWeightAttempt = Date.now();
    $('weight-refresh').disabled = true;
    weightLoading = (async () => {
      const [s,c] = await Promise.allSettled([get('garmin-weight/data/summary.json'),get('garmin-weight/config.json')]);
      if (c.status === 'fulfilled') config = c.value;
      if (s.status === 'fulfilled' && s.value && typeof s.value.current === 'object') {
        summary = s.value; renderWeight();
      } else {
        set('weight-status', summary ? '새로고침 실패 · 마지막으로 받은 자료를 표시합니다.' : '체중 자료를 불러오지 못했습니다. 다시 시도해 주세요.');
        if (!summary) { $('weight-chart').textContent = '자료 연결을 기다리고 있습니다.'; set('weight-measured', '자료 조회 실패'); set('weight-prediction-note','추세·예측 자료를 불러오지 못했습니다. 새로고침해 주세요.'); }
      }
    })().finally(() => { weightLoading = null; $('weight-refresh').disabled = false; });
    return weightLoading;
  }
  $('weight-refresh').addEventListener('click', loadWeight);
  $('weight-prediction-toggle').addEventListener('click', () => { showPrediction = !showPrediction; renderChart(); });
  document.querySelectorAll('[data-days]').forEach(b => b.addEventListener('click', () => { range = Number(b.dataset.days); renderChart(); }));

  let busLoading = false;
  async function loadBus() {
    if (busLoading || $('bus-widget').shadowRoot) return;
    busLoading = true; $('bus-error').hidden = true;
    try {
      const html = await get('bus-arrival/index.html', true);
      const source = new DOMParser().parseFromString(html, 'text/html');
      const main = source.querySelector('main');
      if (!main || !window.BusApp || !window.BusAlarm || !window.BusDashboard) throw new Error('버스 구성요소 없음');
      const css = source.querySelector('style').textContent.replace(/:root/g, ':host').replace(/\bbody\b/g, '.bus-body');
      const body = document.createElement('div');
      body.className = 'bus-body loading';
      // Keep the original controls and IDs so the shared alarm controller works unchanged.
      const details = document.createElement('details');
      details.className = 'dashboard-bus-details';
      const toggle = document.createElement('summary'); toggle.textContent = '버스 상세 · 도보·알림 설정'; details.append(toggle);
      // Alarms/timers and the ringing banner live in the dashboard document, shared with the bus.
      main.querySelector('#clock-panel')?.remove(); main.querySelector('#alarm-banner')?.remove();
      let afterHero = false;
      for (const child of [...main.children]) {
        if (afterHero && child.id !== 'cards' && child.id !== 'error-card') details.append(child);
        if (child.id === 'hero') afterHero = true;
      }
      main.append(details); body.append(main);
      const styles = document.createElement('style');
      styles.textContent = css + `
        :host { --bg:var(--dash-surface); --surface:var(--dash-surface); --surface-2:var(--dash-soft); --ink:var(--dash-ink); --muted:var(--dash-muted); --line:var(--dash-line); --brand:var(--dash-accent); --on-brand:var(--dash-bg); --hero-from:var(--dash-soft); --hero-to:var(--dash-soft); --hero-sub:var(--dash-muted); color:var(--ink); }
        .hero { color:var(--ink); }
        /* OS permission and sound are shown once, in the dashboard header. */
        #hero-alarm-perm, #hero-alarm-sound { display:none; }
        .bus-body { padding:0; background:none; color:inherit; font:14px/1.5 "Malgun Gothic",system-ui,sans-serif; }
        main { max-width:none; } header { display:flex; align-items:center; justify-content:space-between; margin:0 0 12px; gap:8px; flex-wrap:wrap; }
        header h1, header .detail-link { display:none; } header .muted { font-size:11px; } header #refresh-status { flex-basis:100%; margin:0; }
        header #refresh { font-size:11px; min-height:32px; padding:5px 9px; }
        .hero { border-radius:12px; padding:18px; box-shadow:none; }
        .verdict { font-size:21px; padding:11px 12px; border-radius:8px; }
        .departure-context { font-size:16px; margin:10px 0; }
        .readiness { display:flex; align-items:center; flex-wrap:wrap; gap:6px 12px; margin-top:8px; }
        .readiness .alarm-state, .readiness p { margin:0; }
        .readiness > .hero-time-label { flex-basis:100%; }
        .hero-next { font-size:12px; }
        .freshness, .hero-detail { font-size:12px; margin-top:8px; }
        .hero button, .hero summary { min-height:44px; }
        .hero .pill, .hero-settings { background:var(--surface); color:var(--ink); border-color:var(--line); }
        .hero :focus-visible { outline-color:var(--accent); }
        .hero-evidence { font-size:12px; } .hero-time-label { font-size:11px; }
        .hero-evidence { margin-top:8px; }
        .hero-evidence summary { display:flex; align-items:center; }
        .hero-evidence summary::before { content:'▸'; margin-right:6px; }
        .hero-evidence[open] summary::before { content:'▾'; }
        .hero-evidence summary::-webkit-details-marker { display:none; }
        .cards { gap:7px; } .card { border-radius:9px; padding:10px; } .card-value { font-size:18px; }
        .cards { grid-template-columns:repeat(3,minmax(0,1fr)); }
        .cards .next-card { grid-column:auto; }
        .card-label, .card-sub { font-size:11px; }
        .dashboard-bus-details { border-top:1px solid var(--line); margin-top:18px; padding-top:10px; }
        .dashboard-bus-details > summary { cursor:pointer; padding:8px 0; font-size:12px; color:var(--muted); }
        .dashboard-bus-details h2 { font-size:15px; } .dashboard-bus-details .panel { padding:12px; }
        .alarm-banner { top:8px; } input { max-width:100%; } .clock-list { overflow-wrap:anywhere; }
        @media(max-width:599px) { .card{padding:10px 7px} .card-value{font-size:16px} .hero-settings{font-size:12px} }
        @media(max-width:380px) { .hero{padding:14px} .verdict{font-size:19px} }
      `;
      // Preserve document-level h1/main semantics in the containing dashboard.
      const content = document.createElement('div'); content.append(...main.childNodes); body.replaceChildren(content);
      const shadow = $('bus-widget').attachShadow({mode:'open'});
      shadow.append(styles, body);
      window.BusApp.mount(shadow, {body,baseUrl:'bus-arrival/',manageTitle:false,pauseHiddenPaint:true,revealSettings:() => { details.open = true; }});
      $('bus-widget').querySelector('p')?.remove();
    } catch (error) {
      $('bus-error').hidden = false;
      $('bus-widget').querySelector('p')?.remove();
    } finally { busLoading = false; }
  }
  $('bus-retry').addEventListener('click', loadBus);
  loadBus(); loadWeight();
  // Garmin publishes infrequently. Avoid polling it every minute alongside the bus.
  setInterval(() => { if (!document.hidden) loadWeight(); }, 30 * 60000);
  function onResume() {
    tick();
    if (Date.now() - lastWeightAttempt >= 30 * 60000) loadWeight();
  }
  document.addEventListener('visibilitychange', () => {
    set('page-status', document.hidden ? '화면 갱신 대기 · 알림 유지' : '한 화면에 필요한 일상만.');
    if (!document.hidden) onResume();
  });
  window.addEventListener('online', () => { loadWeight(); loadBus(); });
  window.addEventListener('pageshow', e => { if (e.persisted) onResume(); });
  window.addEventListener('storage', e => {
    if (e.key === 'wht.state.v2' || e.key === null) { state = M.normalize(read('wht.state.v2')); previousWork = null; syncInputs(); tick(); }
  });
})();
