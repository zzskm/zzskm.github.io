/* Display-only, deterministic view models. Alarm decisions stay in alarm.js. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BusDashboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MIN = 60000;
  const valid = Number.isFinite;
  const stamp = value => typeof value === 'string' && value ? Date.parse(value) : NaN;

  function relativeTime(atMs, nowMs) {
    const delta = atMs - nowMs;
    if (!valid(delta)) return '시각 미확인';
    if (delta === 0) return '지금';
    const minutes = delta > 0 ? Math.ceil(delta / MIN) : Math.floor(-delta / MIN);
    return Math.abs(delta) < MIN ? (delta > 0 ? '1분 미만 남음' : '1분 미만 지남')
      : minutes + (delta > 0 ? '분 후' : '분 지남');
  }

  function buildReadiness(input) {
    return {
      setting: input.enabled ? '알림 켜짐' : '알림 꺼짐',
      permission: !input.notificationSupported ? 'OS 알림 미지원'
        : input.permission === 'granted' ? 'OS 알림 허용'
        : input.permission === 'denied' ? 'OS 알림 차단' : 'OS 알림 허용 필요',
      sound: !input.audioSupported ? '소리 미지원'
        : input.audioState === 'running' ? '소리 활성화됨' : '소리 활성화 필요',
      permissionAction: input.notificationSupported && input.permission === 'default' ? 'request' : 'guide',
      soundReady: input.audioState === 'running'
    };
  }

  function targetSeries(status, rows, view) {
    if (!view || view.state === 'skipped') return [];
    if (Number(status && status.current_veh_id) === view.targetVehId) return currentSeries(status, rows);
    if (valid(view.observationAtMs) && stamp(status && status.last_poll) !== view.observationAtMs) return [];
    const poll = stamp(status && status.last_poll), sec = Number(status && status.next_predict_sec);
    return Number(status && status.next_veh_id) === view.targetVehId && valid(poll)
      && status.next_predict_sec != null && status.next_predict_sec !== '' && valid(sec) && sec > 0
      ? [{t:poll, remainingSec:sec, arrivalAtMs:poll + sec * 1000}] : [];
  }

  function currentSeries(status, rows) {
    if (!status || !Number(status.current_veh_id)) return [];
    const veh = Number(status.current_veh_id), poll = stamp(status.last_poll);
    if (!valid(poll)) return [];
    const first = stamp(status.first_seen_ts);
    const ordered = (rows || []).map(r => ({ ...r, t:stamp(r.ts_kst) }))
      .filter(r => valid(r.t) && r.t <= poll).sort((a, b) => a.t - b.t);
    // A vehicle ID may return on another run. Never join across another vehicle/no-bus row.
    let boundary = valid(first) && first <= poll ? first : poll - 2 * 60 * MIN;
    ordered.forEach(r => { if (Number(r.vehId || 0) !== veh) boundary = Math.max(boundary, r.t + 1); });
    const points = ordered.filter(r => r.t >= boundary && Number(r.vehId || 0) === veh
        && r.predict_sec !== '' && r.predict_sec != null && Number.isFinite(Number(r.predict_sec)) && Number(r.predict_sec) > 0)
      .map(r => ({ t:r.t, remainingSec:Number(r.predict_sec), arrivalAtMs:r.t + Number(r.predict_sec) * 1000 }));
    if (status.predict_sec !== '' && status.predict_sec != null && Number.isFinite(Number(status.predict_sec)) && Number(status.predict_sec) > 0) {
      const p = { t:poll, remainingSec:Number(status.predict_sec), arrivalAtMs:poll + Number(status.predict_sec) * 1000 };
      const i = points.findIndex(q => q.t === poll);
      if (i >= 0) points[i] = p; else points.push(p);
    }
    return points.filter((p, i, a) => !i || p.t !== a[i - 1].t);
  }

  function buildView(input) {
    const { status:st, snapshot:snap, alarmView:av, nowMs:now } = input;
    const apiFailed = Boolean(st && st.error && st.error !== 'no_bus');
    const savedObservation = input.observationStatus;
    const observed = apiFailed
      ? savedObservation && (!savedObservation.error || savedObservation.error === 'no_bus') ? savedObservation : null
      : st;
    const poll = stamp(st && st.last_poll), observedPoll = stamp(observed && observed.last_poll);
    const veh = Number(st && st.current_veh_id || 0), observedVeh = Number(observed && observed.current_veh_id || 0);
    const samePollTarget = av && av.target && av.target.pollMs === poll;
    const lastSuccessPoll = stamp(st && st.last_success);
    const displayPoll = apiFailed ? valid(lastSuccessPoll) ? lastSuccessPoll : observedPoll : poll;
    const selectedNext = Boolean(input.currentSkipped === true && !input.alarmTargetSkipped && av && ((snap && snap.usable && av.state === 'armed' && samePollTarget) || av.pendingUncertain)
      && Number(av.target.vehId) !== veh && av.target.source === 'next'
      && Number(observed && observed.next_veh_id) === Number(av.target.vehId)
      && valid(av.target.safeArrivalAtMs));
    const walk = Math.min(60, Math.max(0, Number(input.walkMinutes) || 0));
    const margin = Math.min(600, Math.max(0, Number(input.marginSec) || 0));
    const out = { state:'unknown', title:'출발 시각 확인 중', tone:'danger', departureAtMs:null,
      safeAtMs:null, correctedAtMs:null, apiAtMs:null, nextFireAtMs:null, timeline:[], changeMinutes:null,
      ageSec:valid(displayPoll) ? Math.max(0, Math.floor((now - displayPoll) / 1000)) : null, uncertain:false, selectedNext:false,
      observationAtMs:valid(displayPoll) ? displayPoll : null, departureElapsedSec:null };
    out.selectedNext = selectedNext;
    if (input.off) { out.state='off'; out.title=input.holiday ? '휴일 · 수집하지 않습니다' : '수집 시간 외'; out.tone='wait'; }
    else if (input.loadError || !st) { out.title='정보를 불러올 수 없습니다'; }
    else if (snap && snap.why === 'no_bus') { out.state='no_bus'; out.title='실시간에서 확인된 차량 없음'; out.tone='wait'; }
    else if ((input.currentSkipped && !selectedNext) || input.alarmTargetSkipped) {
      out.state='skipped'; out.title='이번 차량 제외됨 · 다음 차량 확인 중'; out.tone='wait';
    }
    else if (snap && snap.usable && snap.arrivalAtMs <= now && !selectedNext) { out.state='elapsed'; out.title='도착 예정 시각 지남 · 통과 미확인'; out.tone='warn'; }
    else if (snap && snap.usable) {
      const target = selectedNext ? av.target : snap;
      out.targetVehId = selectedNext ? Number(target.vehId) : veh;
      out.safeAtMs = target.safeArrivalAtMs;
      out.correctedAtMs = target.correctedArrivalAtMs || target.arrivalAtMs;
      out.apiAtMs = target.arrivalAtMs;
      out.safetyMethod = target.safetyMethod || snap.safetyMethod;
      out.sampleTrips = selectedNext ? Number(target.sampleTrips) || 0 : snap.sampleTrips;
      out.stalled = !selectedNext && snap.stalled === true;
      out.departureAtMs = selectedNext && valid(av.safeDepartureAtMs)
        ? av.safeDepartureAtMs : out.safeAtMs - walk * MIN - margin * 1000;
      const delta = out.departureAtMs - now;
      const mins = Math.max(0, Math.ceil(delta / MIN));
      out.state = delta > 0 ? 'waiting' : delta === 0 ? 'due' : 'overdue';
      out.tone = delta > 0 ? 'wait' : delta === 0 ? 'go' : 'warn';
      out.departureElapsedSec = delta < 0 ? Math.floor(-delta / 1000) : null;
      const prefix = selectedNext ? '다음 차량 · ' : '';
      out.title = prefix + (delta > 0 ? (delta < MIN ? '출발까지 1분 미만' : '출발까지 ' + mins + '분')
        : delta === 0 ? '출발 권장 시점입니다'
        : '권장 시각 ' + relativeTime(out.departureAtMs, now) + ' · 탑승 여부 확인 필요');
      if (samePollTarget && (selectedNext || Number(av.target.vehId) === veh) && valid(av.nextFireAtMs)) out.nextFireAtMs = av.nextFireAtMs;
    } else if (av && av.pendingUncertain && av.target && valid(av.safeDepartureAtMs)) {
      out.state='reserved'; out.title='최신 정보 없음 · 이전 정보 기준 예약 경고'; out.tone='warn'; out.uncertain=true;
      out.safetyMethod=av.target.safetyMethod; out.sampleTrips=Number(av.target.sampleTrips) || 0; out.stalled=false;
      out.departureAtMs=av.safeDepartureAtMs; out.safeAtMs=av.target.safeArrivalAtMs;
      out.nextFireAtMs=av.nextFireAtMs;
    } else { out.state='unavailable'; out.title='출발 판단 보류 · 최신 정보가 필요합니다'; }

    const timelineVeh = out.uncertain || selectedNext ? Number(av.target.vehId) : apiFailed && observedVeh ? observedVeh : veh;
    out.targetVehId = timelineVeh;
    const timelineStatus = observed;
    const timelinePoll = (out.uncertain || selectedNext) && valid(av.target.pollMs) ? av.target.pollMs : observedPoll;
    const isCurrent = timelineVeh === observedVeh;
    const isObservedNext = !isCurrent && Number(timelineStatus && timelineStatus.next_veh_id) === timelineVeh;
    const series = isCurrent ? currentSeries(timelineStatus, input.predictions) : [];
    const first = isCurrent ? stamp(timelineStatus && timelineStatus.first_seen_ts) : NaN;
    if (isObservedNext && valid(timelinePoll) && (out.uncertain || selectedNext)) {
      out.timeline.push({kind:'observed',atMs:timelinePoll,label:'후속 알림 대상 차량 확인'});
    }
    if (isCurrent && timelineVeh && valid(timelinePoll) && timelinePoll <= now + 90000) {
      if (valid(first) && first <= timelinePoll) out.timeline.push({kind:'observed',atMs:first,label:'차량 최초 확인'});
      else if (series.length) out.timeline.push({kind:'observed',atMs:series[0].t,label:'표시 가능한 기록 시작'});
      out.timeline.push({kind:'observed',atMs:timelinePoll,label:apiFailed || out.uncertain ? '마지막 정상 정보에서 차량 확인' : '마지막 차량 정보 확인'});
    }
    const since = valid(first) ? first : (series[0] ? series[0].t : timelinePoll);
    (input.events || []).filter(e => e && e.type === 'fire' && Number(e.vehId) === timelineVeh
      && valid(e.atMs) && e.atMs >= since && e.atMs <= now && now - e.atMs < 2 * 60 * MIN)
      .forEach(e => out.timeline.push({kind:'observed',atMs:e.atMs,label:e.uncertain ? '예약 경고 실행 · 당시 최신 정보 없음' : '이 브라우저에서 알림 실행'}));
    out.timeline.push({kind:'now',role:'now',atMs:now,label:'지금'});
    if (valid(out.nextFireAtMs)) out.timeline.push({kind:'planned',role:'alarm',atMs:out.nextFireAtMs,label:out.uncertain ? '예약 경고 · 마지막 확인 기준' : '다음 알림'});
    if (valid(out.departureAtMs)) out.timeline.push({kind:'planned',role:'departure',atMs:out.departureAtMs,label:out.uncertain ? '출발 권장 · 마지막 확인 기준' : '출발 권장',elapsed:out.departureAtMs < now});
    if (valid(out.safeAtMs)) out.timeline.push({kind:'planned',atMs:out.safeAtMs,label:out.uncertain ? '조기 도착 대비 · 마지막 확인 기준' : '조기 도착 대비 기준',elapsed:out.safeAtMs <= now});
    if (valid(out.correctedAtMs)) out.timeline.push({kind:'planned',role:'arrival',atMs:out.correctedAtMs,label:'도착 예상 · 실제 도착 미측정',elapsed:out.correctedAtMs < now});
    out.timeline.sort((a, b) => a.atMs - b.atMs || ({now:0,observed:1,planned:2}[a.kind] - {now:0,observed:1,planned:2}[b.kind]));
    out.summaryTimeline = out.timeline.filter(e => e.role);
    out.detailTimeline = out.timeline.filter(e => !e.role);
    if ((out.uncertain || selectedNext) && valid(av.target.pollMs)) {
      out.observationAtMs = av.target.pollMs;
      out.ageSec = Math.max(0, Math.floor((now - av.target.pollMs) / 1000));
    }
    out.comparisonKey = [out.targetVehId, selectedNext ? 'next' : 'current', observed && observed.first_seen_ts || '', walk, margin].join('|');
    const prev = input.previous;
    if (prev && prev.vehId === out.targetVehId && (!prev.comparisonKey || prev.comparisonKey === out.comparisonKey)
      && prev.pollMs < poll && valid(prev.departureAtMs) && valid(out.departureAtMs) && !out.uncertain) {
      out.changeMinutes = Math.round((out.departureAtMs - prev.departureAtMs) / MIN);
    }
    return out;
  }

  function historyPoints(rows, nowMs) {
    const nowLocal = new Date(nowMs + 9 * 60 * MIN);
    const today = nowLocal.toISOString().slice(0,10);
    const cutoff = new Date(nowLocal.getTime() - 28 * 24 * 60 * MIN).toISOString().slice(0,10);
    const weekday = new Date(nowMs + 9 * 60 * MIN).getUTCDay();
    const seen = new Set(), points = [];
    (rows || []).forEach(r => {
      if (!['observed_arrival','estimated_arrival'].includes(r.departure_reason)) return;
      const at = stamp(r.est_arrival_ts), first = stamp(r.first_seen_ts);
      if (!valid(at) || at >= nowMs) return;
      const d = new Date(at + 9*60*MIN), date = d.toISOString().slice(0,10);
      if (date < cutoff || date >= today || d.getUTCDay() !== weekday || !Number(r.vehId)) return;
      const key = r.vehId+'|'+(valid(first) ? first : at);
      if (seen.has(key)) return;
      seen.add(key); points.push({date,atMs:at,minute:d.getUTCHours()*60+d.getUTCMinutes(),vehId:Number(r.vehId),reason:r.departure_reason});
    });
    return points.sort((a,b) => a.atMs-b.atMs);
  }

  function splitGaps(points, intervalSec) {
    const maxGap = Math.max(180000, (Number(intervalSec) || 60) * 2500);
    const groups = [];
    points.forEach((p, i) => {
      if (!i || p.t - points[i - 1].t > maxGap) groups.push([]);
      groups[groups.length - 1].push(p);
    });
    return groups;
  }
  return { currentSeries, targetSeries, buildView, buildReadiness, relativeTime, splitGaps, historyPoints };
});
