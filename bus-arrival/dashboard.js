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
    const poll = stamp(st && st.last_poll), veh = Number(st && st.current_veh_id || 0);
    const walk = Math.min(60, Math.max(0, Number(input.walkMinutes) || 0));
    const margin = Math.min(600, Math.max(0, Number(input.marginSec) || 0));
    const sameTarget = av && av.target && Number(av.target.vehId) === veh;
    const out = { state:'unknown', title:'출발 시각 확인 중', tone:'danger', departureAtMs:null,
      safeAtMs:null, correctedAtMs:null, apiAtMs:null, nextFireAtMs:null, timeline:[], changeMinutes:null,
      ageSec:valid(poll) ? Math.max(0, Math.floor((now - poll) / 1000)) : null, uncertain:false };
    if (input.off) { out.state='off'; out.title=input.holiday ? '휴일 · 수집하지 않습니다' : '수집 시간 외'; out.tone='wait'; }
    else if (input.loadError || !st) { out.title='정보를 불러올 수 없습니다'; }
    else if (snap && snap.why === 'no_bus') { out.state='no_bus'; out.title='실시간에서 확인된 차량 없음'; out.tone='wait'; }
    else if (snap && snap.usable && snap.arrivalAtMs <= now) { out.state='elapsed'; out.title='도착 예정 시각 지남 · 통과 미확인'; out.tone='warn'; }
    else if (snap && snap.usable) {
      out.safeAtMs = snap.safeArrivalAtMs;
      out.correctedAtMs = snap.correctedArrivalAtMs;
      out.apiAtMs = snap.arrivalAtMs;
      out.departureAtMs = out.safeAtMs - walk * MIN - margin * 1000;
      const mins = Math.max(0, Math.ceil((out.departureAtMs - now) / MIN));
      out.state = mins ? 'waiting' : 'due'; out.tone=mins ? 'wait' : 'go';
      out.title = mins ? mins + '분 뒤 출발 권장' : '출발 권장 시점입니다';
      if (sameTarget && av.target.pollMs === poll && valid(av.nextFireAtMs)) out.nextFireAtMs = av.nextFireAtMs;
    } else if (av && av.pendingUncertain && av.target && valid(av.safeDepartureAtMs)) {
      out.state='reserved'; out.title='최신 정보 없음 · 이전 정보 기준 예약 경고'; out.tone='warn'; out.uncertain=true;
      out.departureAtMs=av.safeDepartureAtMs; out.safeAtMs=av.target.safeArrivalAtMs;
      out.nextFireAtMs=av.nextFireAtMs;
    } else { out.state='unavailable'; out.title='출발 판단 보류 · 최신 정보가 필요합니다'; }

    const timelineVeh = out.uncertain ? Number(av.target.vehId) : veh;
    out.targetVehId = timelineVeh;
    const series = timelineVeh === veh ? currentSeries(st, input.predictions) : [];
    const first = timelineVeh === veh ? stamp(st && st.first_seen_ts) : NaN;
    if (timelineVeh !== veh && out.uncertain && valid(av.target.pollMs)) {
      out.timeline.push({kind:'observed',atMs:av.target.pollMs,label:'후속 알림 대상 차량 확인'});
    }
    if (timelineVeh === veh && veh && valid(poll) && poll <= now + 90000) {
      if (valid(first) && first <= poll) out.timeline.push({kind:'observed',atMs:first,label:'차량 최초 확인'});
      else if (series.length) out.timeline.push({kind:'observed',atMs:series[0].t,label:'표시 가능한 기록 시작'});
      out.timeline.push({kind:'observed',atMs:poll,label:'마지막 차량 정보 확인'});
    }
    const since = valid(first) ? first : (series[0] ? series[0].t : poll);
    (input.events || []).filter(e => e && e.type === 'fire' && Number(e.vehId) === timelineVeh
      && valid(e.atMs) && e.atMs >= since && e.atMs <= now && now - e.atMs < 2 * 60 * MIN)
      .forEach(e => out.timeline.push({kind:'observed',atMs:e.atMs,label:e.uncertain ? '예약 경고 실행 · 당시 최신 정보 없음' : '이 브라우저에서 알림 실행'}));
    out.timeline.push({kind:'now',atMs:now,label:'지금'});
    if (valid(out.nextFireAtMs)) out.timeline.push({kind:'planned',atMs:out.nextFireAtMs,label:out.uncertain ? '예약 경고 · 마지막 확인 기준' : '다음 알림'});
    if (valid(out.departureAtMs)) out.timeline.push({kind:'planned',atMs:out.departureAtMs,label:out.uncertain ? '출발 권장 · 마지막 확인 기준' : '출발 권장',elapsed:out.departureAtMs <= now});
    if (valid(out.safeAtMs)) out.timeline.push({kind:'planned',atMs:out.safeAtMs,label:out.uncertain ? '조기 도착 대비 · 마지막 확인 기준' : '조기 도착 대비 기준',elapsed:out.safeAtMs <= now});
    if (valid(out.correctedAtMs)) out.timeline.push({kind:'planned',atMs:out.correctedAtMs,label:'보정 도착 예상 · 실제 도착 미측정',elapsed:out.correctedAtMs <= now});
    out.timeline.sort((a, b) => a.atMs - b.atMs || ({now:0,observed:1,planned:2}[a.kind] - {now:0,observed:1,planned:2}[b.kind]));
    const prev = input.previous;
    if (prev && prev.vehId === veh && prev.pollMs < poll && valid(prev.departureAtMs) && valid(out.departureAtMs) && !out.uncertain) {
      out.changeMinutes = Math.round((out.departureAtMs - prev.departureAtMs) / MIN);
    }
    return out;
  }

  function historyPoints(rows, nowMs) {
    const today = new Date(nowMs + 9 * 60 * MIN).toISOString().slice(0,10);
    const weekday = new Date(nowMs + 9 * 60 * MIN).getUTCDay();
    const seen = new Set(), points = [];
    (rows || []).forEach(r => {
      if (!['observed_arrival','estimated_arrival'].includes(r.departure_reason)) return;
      const at = stamp(r.est_arrival_ts), first = stamp(r.first_seen_ts);
      if (!valid(at) || at >= nowMs || nowMs-at > 28*24*60*MIN) return;
      const d = new Date(at + 9*60*MIN), date = d.toISOString().slice(0,10);
      if (date === today || d.getUTCDay() !== weekday || !Number(r.vehId)) return;
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
  return { currentSeries, buildView, splitGaps, historyPoints };
});
