/* General alarms are loaded only by the personal dashboard. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./bus-arrival/alarm.js'));
  else root.DashboardAlarm = factory(root.BusAlarm);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(BA) {
  'use strict';
  const {kstParts, parseTime, formatTime, sanitizeDays, daysLabel} = BA;
  const MIN=60000, DAY_MS=86400000, KST_MS=9*3600000, ONTIME_GRACE_MS=90000;
  const MAX_CLOCKS=20, MAX_TIMERS=10, TIMER_MAX_MIN=720;
  const CLOCK_CATCHUP_MS=10*MIN, CLOCK_MISSED_MS=12*60*MIN;
  function dayOfDate(date) { return new Date(date + "T00:00:00Z").getUTCDay(); }
  function kstMs(date, minutes) {
    var p = date.split("-");
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Math.floor(minutes / 60), minutes % 60) - KST_MS;
  }
  function sanitizeClocks(raw) {
    var out = [], ids = {};
    (Array.isArray(raw) ? raw : []).forEach(function (c) {
      if (!c || typeof c !== "object" || out.length >= MAX_CLOCKS) return;
      var minutes = parseTime(c.time), id = String(c.id || "");
      if (minutes === null || !id || ids[id]) return;
      var days = sanitizeDays(c.days), date = /^\d{4}-\d{2}-\d{2}$/.test(String(c.date || "")) ? String(c.date) : null;
      if (!days.length && !date) return;
      var since = Number(c.since);
      ids[id] = true;
      out.push({ id: id, time: formatTime(minutes), label: String(c.label || "").slice(0, 30), days: days,
                 date: days.length ? null : date, enabled: c.enabled !== false,
                 since: Number.isFinite(since) && since > 0 ? since : 0, bus: c.bus !== false });
    });
    return out;
  }
  function nextDate(minutes, nowMs) {
    var p = kstParts(nowMs);
    return minutes > p.minutes ? p.date : kstParts(nowMs + DAY_MS).date;
  }
  var idCounter = 0;
  function makeId(prefix, nowMs) { idCounter += 1; return prefix + nowMs.toString(36) + idCounter.toString(36); }
  // 새 알람. days 가 비어 있으면 다음에 오는 그 시각에 한 번만 울린다.
  function newClock(input, nowMs) {
    var minutes = parseTime(input.time);
    if (minutes === null) return null;
    var days = sanitizeDays(input.days);
    return { id: makeId("c", nowMs), time: formatTime(minutes), label: String(input.label || "").slice(0, 30), days: days,
             date: days.length ? null : nextDate(minutes, nowMs), enabled: true, since: nowMs, bus: input.bus !== false };
  }
  // 다시 켤 때: 켜기 전에 이미 지난 시각은 울리지 않고, 한 번짜리는 다음 그 시각으로 옮긴다.
  function rearmClock(clock, nowMs) {
    var minutes = parseTime(clock.time);
    return Object.assign({}, clock, { enabled: true, since: nowMs,
      date: clock.days.length ? null : nextDate(minutes, nowMs) });
  }
  function clockOccurrenceText(clock, nowMs) {
    var minutes = parseTime(clock.time), p = kstParts(nowMs), label;
    if (clock.days.length) {
      label = daysLabel(clock.days);
    } else {
      var date = clock.date;
      label = date === p.date ? "오늘" : date === kstParts(nowMs + DAY_MS).date ? "내일" : date.slice(5).replace("-", "/");
    }
    return label + " " + formatTime(minutes);
  }
  function pruneClockLedger(ledger, nowMs) {
    var src = ledger && typeof ledger === "object" ? ledger : {}, out = {};
    var oldest = kstParts(nowMs - 3 * DAY_MS).date;
    Object.keys(src).forEach(function (k) {
      if (k.split("|")[1] >= oldest) out[k] = src[k];
    });
    return out;
  }
  // 예정 시각이 (어제/오늘) 지났는데 아직 울리지 않은 알람을 찾는다.
  function evaluateClocks(input) {
    var nowMs = input.nowMs;
    var clocks = sanitizeClocks(input.clocks).map(function (c) { return Object.assign({}, c); });
    var ledger = pruneClockLedger(input.ledger, nowMs);
    var actions = [];
    var dates = [kstParts(nowMs - DAY_MS).date, kstParts(nowMs).date];
    clocks.forEach(function (c) {
      if (!c.enabled) return;
      var minutes = parseTime(c.time);
      dates.forEach(function (date) {
        var applies = c.days.length ? c.days.indexOf(dayOfDate(date)) !== -1 : c.date === date;
        var scheduled = kstMs(date, minutes), key = c.id + "|" + date;
        if (!applies || scheduled > nowMs || scheduled < c.since || ledger[key]) return;
        var late = nowMs - scheduled;
        if (late <= CLOCK_MISSED_MS) {
          ledger[key] = nowMs;
          actions.push({ type: late <= CLOCK_CATCHUP_MS ? "clock" : "clock_missed", id: c.id, label: c.label, time: c.time,
                         bus: c.bus, scheduledMs: scheduled, lateMs: late,
                         kind: late > ONTIME_GRACE_MS ? "late" : "ontime" });
          if (!c.days.length) c.enabled = false;   // 한 번짜리는 울린 뒤 꺼 둔다
        }
      });
    });
    return { actions: actions, clocks: clocks, ledger: ledger };
  }
  function busHint(snap, nowMs) {
    if (!snap || !snap.usable || snap.arrivalAtMs <= nowMs) return "";
    return "3100번 약 " + Math.max(1, Math.round((snap.arrivalAtMs - nowMs) / MIN)) + "분 후 도착 예정";
  }
  function formatClockMessage(action, hint) {
    var body = action.time;
    if (action.type === "clock_missed") body += " 알람을 놓쳤습니다 (탭이 닫혀 있었을 수 있어요)";
    else if (action.kind === "late") body += " (약 " + Math.max(1, Math.round(action.lateMs / MIN)) + "분 늦게 확인됨)";
    if (hint && action.bus !== false) body += " · " + hint;
    return { title: action.label || "알람", body: body };
  }

  function sanitizeTimers(raw) {
    var out = [], ids = {};
    (Array.isArray(raw) ? raw : []).forEach(function (t) {
      if (!t || typeof t !== "object" || out.length >= MAX_TIMERS) return;
      var ends = Number(t.endsAtMs), minutes = Number(t.minutes), id = String(t.id || "");
      if (!Number.isFinite(ends) || ends <= 0 || !id || ids[id]) return;
      ids[id] = true;
      out.push({ id: id, label: String(t.label || "").slice(0, 30), minutes: Number.isFinite(minutes) ? minutes : 0, endsAtMs: ends });
    });
    return out;
  }
  function newTimer(minutes, label, nowMs) {
    var n = Math.round(Number(minutes));
    if (!Number.isFinite(n) || n < 1 || n > TIMER_MAX_MIN) return null;
    return { id: makeId("t", nowMs), label: String(label || "").slice(0, 30), minutes: n, endsAtMs: nowMs + n * MIN };
  }
  function evaluateTimers(input) {
    var timers = sanitizeTimers(input.timers), actions = [], keep = [];
    timers.forEach(function (t) {
      if (t.endsAtMs <= input.nowMs) actions.push({ type: "timer", id: t.id, label: t.label, minutes: t.minutes });
      else keep.push(t);
    });
    return { actions: actions, timers: keep };
  }
  function formatTimerMessage(action) {
    return { title: action.label || "타이머", body: action.minutes ? action.minutes + "분 타이머가 끝났습니다" : "타이머가 끝났습니다" };
  }

  return Object.assign({}, BA, {MAX_CLOCKS, MAX_TIMERS, TIMER_MAX_MIN, sanitizeClocks, newClock, rearmClock, clockOccurrenceText, evaluateClocks, pruneClockLedger, busHint, formatClockMessage, sanitizeTimers, newTimer, evaluateTimers, formatTimerMessage});
});
