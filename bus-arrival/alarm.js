/* 도착 N분 전 알람 엔진 (순수 함수).
 *
 * DOM/Notification/Audio 는 index.html 이 맡고, 여기서는 "언제 무엇을 울릴지"만 결정한다.
 * 현재 시각은 항상 nowMs 로 주입받는다 (Date.now() 를 직접 쓰지 않는다).
 * 브라우저에서는 globalThis.BusAlarm, Node 에서는 module.exports 로 노출한다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BusAlarm = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MIN = 60000;
  var LEAD_MIN = 1, LEAD_MAX = 20, MAX_LEADS = 4, DEFAULT_LEADS = [5];
  var ONTIME_GRACE_MS = 90 * 1000;   // 계획 시각보다 이만큼 넘게 늦으면 'late'
  var CLOCK_SKEW_MS = 90 * 1000;     // last_poll 이 이보다 미래면 PC 시계 이상
  var MISSED_SEC = 60;               // 남은 시간이 이보다 짧으면 이미 정류장 앞이라 울리지 않는다
  var TRIP_TTL_MS = 20 * MIN;        // 같은 차량이 이보다 뒤에 다시 오면 새 운행으로 본다
  var LEDGER_LIMIT = 40;


  // ---- KST 시간 유틸 (KST 는 서머타임이 없어 고정 +9시간) ----
  var KST_MS = 9 * 3600000, DAY_MS = 86400000;
  var DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
  var WEEKDAYS = [1, 2, 3, 4, 5];
  var MAX_WINDOWS = 3, MAX_CLOCKS = 20, MAX_TIMERS = 10;
  var CLOCK_CATCHUP_MS = 10 * MIN;    // 예정 시각을 이만큼까지 지나서 확인해도 늦게라도 울린다
  var CLOCK_MISSED_MS = 12 * 60 * MIN; // 그보다 오래 지났으면 '놓친 알람' 으로만 알린다
  var TIMER_MAX_MIN = 720;

  function kstParts(ms) {
    var d = new Date(ms + KST_MS);
    return { date: d.toISOString().slice(0, 10), day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  function parseTime(text) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? "" : text).trim());
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    return h > 23 || mi > 59 ? null : h * 60 + mi;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function formatTime(minutes) { return pad2(Math.floor(minutes / 60)) + ":" + pad2(minutes % 60); }
  function dayOfDate(date) { return new Date(date + "T00:00:00Z").getUTCDay(); }
  function kstMs(date, minutes) {
    var p = date.split("-");
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Math.floor(minutes / 60), minutes % 60) - KST_MS;
  }
  function sanitizeDays(raw, fallback) {
    var seen = {}, out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (v) {
      var n = Math.round(Number(v));
      if (Number.isFinite(n) && n >= 0 && n <= 6 && !seen[n]) { seen[n] = true; out.push(n); }
    });
    out.sort(function (a, b) { return a - b; });
    return out.length || !fallback ? out : fallback.slice();
  }
  function daysLabel(days) {
    var d = sanitizeDays(days);
    if (!d.length) return "한 번만";
    if (d.length === 7) return "매일";
    if (d.join() === WEEKDAYS.join()) return "평일";
    if (d.join() === "0,6") return "주말";
    return d.map(function (n) { return DAY_NAMES[n]; }).join("·");
  }

  // ---- 알림 시간대: 버스 도착 시각이 이 안에 있을 때만 알린다 ----
  function defaultWindows() { return [{ start: "17:30", end: "19:30", days: WEEKDAYS.slice() }]; }
  function sanitizeWindows(raw) {
    var out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (w) {
      if (!w || typeof w !== "object" || out.length >= MAX_WINDOWS) return;
      var s = parseTime(w.start), e = parseTime(w.end);
      if (s === null || e === null || e <= s) return;
      out.push({ start: formatTime(s), end: formatTime(e), days: sanitizeDays(w.days, WEEKDAYS) });
    });
    return out;
  }
  // 시간대가 하나도 없으면 제한 없음
  function inWindows(windows, ms) {
    if (!windows || !windows.length) return true;
    var p = kstParts(ms);
    return windows.some(function (w) {
      return w.days.indexOf(p.day) !== -1 && p.minutes >= parseTime(w.start) && p.minutes < parseTime(w.end);
    });
  }
  function windowsText(windows) {
    if (!windows || !windows.length) return "제한 없음";
    return windows.map(function (w) { return daysLabel(w.days) + " " + w.start + "~" + w.end; }).join(", ");
  }

  function emptyLedger() { return { fired: {}, skipped: {} }; }

  function sanitizeConfig(raw) {
    var src = raw && typeof raw === "object" ? raw : {};
    var seen = {}, leads = [];
    (Array.isArray(src.leads) ? src.leads : []).forEach(function (v) {
      var n = Math.round(Number(v));
      if (Number.isFinite(n) && n >= LEAD_MIN && n <= LEAD_MAX && !seen[n]) { seen[n] = true; leads.push(n); }
    });
    leads.sort(function (a, b) { return b - a; });
    leads = leads.slice(0, MAX_LEADS);
    var armed = Number(src.armedAtMs);
    return {
      enabled: src.enabled === true,
      leads: leads.length ? leads : DEFAULT_LEADS.slice(),
      windows: Array.isArray(src.windows) ? sanitizeWindows(src.windows) : defaultWindows(),
      armedAtMs: Number.isFinite(armed) && armed > 0 ? armed : null
    };
  }

  function sanitizeLedger(raw) {
    var out = emptyLedger();
    var src = raw && typeof raw === "object" ? raw : {};
    Object.keys(src.fired || {}).forEach(function (k) {
      var e = src.fired[k];
      if (e && Number.isFinite(Number(e.a))) out.fired[k] = { a: Number(e.a), k: String(e.k || "ontime") };
    });
    Object.keys(src.skipped || {}).forEach(function (k) {
      if (Number.isFinite(Number(src.skipped[k]))) out.skipped[k] = Number(src.skipped[k]);
    });
    return out;
  }

  function pruneLedger(ledger, nowMs) {
    var src = sanitizeLedger(ledger), out = emptyLedger();
    Object.keys(src.fired).forEach(function (k) {
      if (src.fired[k].a + TRIP_TTL_MS >= nowMs) out.fired[k] = src.fired[k];
    });
    Object.keys(src.skipped).forEach(function (k) {
      if (src.skipped[k] + TRIP_TTL_MS >= nowMs) out.skipped[k] = src.skipped[k];
    });
    [out.fired, out.skipped].forEach(function (bucket) {
      var keys = Object.keys(bucket);
      if (keys.length > LEDGER_LIMIT) {
        var val = function (k) { return typeof bucket[k] === "object" ? bucket[k].a : bucket[k]; };
        keys.sort(function (x, y) { return val(x) - val(y); })
          .slice(0, keys.length - LEDGER_LIMIT).forEach(function (k) { delete bucket[k]; });
      }
    });
    return out;
  }

  // 수집 최신성 임계값(분). 게시 주기 + 조회 간격이 길수록 넉넉히 잡는다.
  // 조회 간격 60초일 때 fresh = publish + 3, aging = publish * 2 + 3.
  function freshnessLimits(publishMinutes, pollIntervalSec) {
    var interval = Number(pollIntervalSec);
    var extra = Number.isFinite(interval) && interval > 60 ? (interval - 60) / 60 : 0;
    return { fresh: publishMinutes + 3 + extra, aging: publishMinutes * 2 + 3 + extra };
  }

  // status.json 한 건을 알람 판단용 스냅샷으로 바꾼다.
  function assessStatus(st, nowMs, opts) {
    var maxAgeMin = opts && Number.isFinite(opts.maxAgeMin) ? opts.maxAgeMin : null;
    var snap = { usable: false, why: "bad", pollMs: null, ageMin: null, vehId: null,
                 arrivalAtMs: null, stopsAway: null, next: null };
    if (!st || typeof st !== "object") return snap;
    var pollMs = Date.parse(st.last_poll);
    if (!Number.isFinite(pollMs)) return snap;
    snap.pollMs = pollMs;
    snap.ageMin = (nowMs - pollMs) / MIN;
    if (pollMs > nowMs + CLOCK_SKEW_MS) { snap.why = "clock_skew"; return snap; }
    if (maxAgeMin != null && snap.ageMin > maxAgeMin) { snap.why = "too_old"; return snap; }
    if (st.error && st.error !== "no_bus") { snap.why = "api_error"; return snap; }
    var veh = Number(st.current_veh_id || 0);
    if (st.error === "no_bus" || !veh) { snap.why = "no_bus"; return snap; }
    var predict = Number(st.predict_sec);
    if (!Number.isFinite(predict) || predict < 0 || st.predict_sec === null || st.predict_sec === "") return snap;
    snap.usable = true;
    snap.why = "ok";
    snap.vehId = veh;
    snap.arrivalAtMs = pollMs + predict * 1000;
    var stops = Number(st.location_no);
    snap.stopsAway = st.location_no === null || st.location_no === "" || !Number.isFinite(stops) ? null : stops;
    var nextVeh = Number(st.next_veh_id || 0), nextPredict = Number(st.next_predict_sec);
    if (nextVeh && Number.isFinite(nextPredict) && nextPredict >= 0 && st.next_predict_sec !== null && st.next_predict_sec !== "") {
      snap.next = { vehId: nextVeh, arrivalAtMs: pollMs + nextPredict * 1000 };
    }
    return snap;
  }

  function isSkipped(ledger, vehId, arrivalAtMs) {
    var a = ledger.skipped[String(vehId)];
    return a !== undefined && arrivalAtMs < a + TRIP_TTL_MS;
  }

  function firedEntry(ledger, vehId, lead, arrivalAtMs) {
    var e = ledger.fired[vehId + "|" + lead];
    return e && arrivalAtMs < e.a + TRIP_TTL_MS ? e : null;
  }

  // 알람 대상 차량: 건너뛰지 않았고 알림 시간대 안에 도착하는 첫 차량 (현재 차량, 없으면 다음 차량).
  // outsideWindow: 대상은 없지만 시간대 밖이라서 그런 경우
  function pickTargetInfo(snap, ledger, windows) {
    if (!snap || !snap.usable) return { target: null, outsideWindow: false };
    var led = sanitizeLedger(ledger);
    var candidates = [{ vehId: snap.vehId, arrivalAtMs: snap.arrivalAtMs, source: "current" }];
    if (snap.next) candidates.push({ vehId: snap.next.vehId, arrivalAtMs: snap.next.arrivalAtMs, source: "next" });
    var outside = false;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (isSkipped(led, c.vehId, c.arrivalAtMs)) continue;
      if (!inWindows(windows, c.arrivalAtMs)) { outside = true; continue; }
      return { target: c, outsideWindow: false };
    }
    return { target: null, outsideWindow: outside };
  }
  function pickTarget(snap, ledger, nowMs, windows) {
    return pickTargetInfo(snap, ledger, windows).target;
  }

  // 이 차량은 못 탄다: 이후 알람은 다음 차량 기준으로 다시 잡는다
  function skipTarget(ledger, target) {
    var out = sanitizeLedger(ledger);
    if (target) out.skipped[String(target.vehId)] = target.arrivalAtMs;
    return out;
  }

  function evaluate(input) {
    var cfg = sanitizeConfig(input.cfg);
    var nowMs = input.nowMs;
    var snap = input.snap || assessStatus(null, nowMs);
    var ledger = pruneLedger(input.ledger, nowMs);
    var prev = input.prevTarget || null;
    var actions = [];
    var view = { state: "off", why: snap.why, nextFireAtMs: null, etaMin: null, target: null,
                 done: false, skipped: [], outside: false };

    if (!cfg.enabled) return { actions: actions, view: view, ledger: ledger, prevTarget: null };

    var picked = pickTargetInfo(snap, ledger, cfg.windows);
    var target = picked.target;
    view.outside = picked.outsideWindow;
    var reliable = snap.why === "ok" || snap.why === "no_bus";

    // 알람 없이 차량이 사라짐/교체됨 (신뢰할 수 있는 스냅샷에서만 판단한다)
    if (prev && reliable && (!target || target.vehId !== prev.vehId)) {
      var stillListed = snap.vehId === prev.vehId || (snap.next && snap.next.vehId === prev.vehId);
      var userSkipped = stillListed || isSkipped(ledger, prev.vehId, prev.arrivalAtMs);
      var unfired = cfg.leads.some(function (n) { return !firedEntry(ledger, prev.vehId, n, prev.arrivalAtMs); });
      if (unfired && !userSkipped) actions.push({ type: "passed", vehId: prev.vehId });
    }

    if (!target) {
      // 정보는 정상인데 대상이 없는 경우(버스 없음, 시간대 밖, 모두 건너뜀)는 대기 상태다
      view.state = snap.why === "no_bus" || snap.usable ? "armed" : "unavailable";
      return { actions: actions, view: view, ledger: ledger, prevTarget: reliable ? null : prev };
    }

    view.target = target;
    var remainingSec = (target.arrivalAtMs - nowMs) / 1000;
    view.etaMin = remainingSec / 60;
    if (remainingSec <= 0) {
      view.state = "passed";
      return { actions: actions, view: view, ledger: ledger, prevTarget: target };
    }

    var armedAt = cfg.armedAtMs || 0;
    var due = [];
    var pendingFireAts = [];
    cfg.leads.forEach(function (n) {
      var e = firedEntry(ledger, target.vehId, n, target.arrivalAtMs);
      if (e) { if (e.k === "skipped") view.skipped.push(n); return; }
      var fireAt = target.arrivalAtMs - n * MIN;
      if (fireAt <= nowMs) due.push({ n: n, fireAt: fireAt });
      else pendingFireAts.push(fireAt);
    });

    if (due.length) {
      var mark = function (n, kind) {
        ledger.fired[target.vehId + "|" + n] = { a: target.arrivalAtMs, k: kind };
      };
      var loud = [];
      due.forEach(function (d) {
        if (d.fireAt < armedAt) { mark(d.n, "skipped"); view.skipped.push(d.n); }   // 켜기 전에 이미 지난 시점: 조용히 넘김
        else if (remainingSec < MISSED_SEC) mark(d.n, "missed");                    // 이미 정류장 앞
        else loud.push(d);
      });
      if (loud.length) {
        var first = loud.reduce(function (a, b) { return b.n > a.n ? b : a; });
        var kind = nowMs - first.fireAt > ONTIME_GRACE_MS ? "late" : "ontime";
        loud.forEach(function (d) { mark(d.n, kind); });
        actions.push({
          type: "fire", kind: kind, vehId: target.vehId, arrivalAtMs: target.arrivalAtMs,
          leads: loud.map(function (d) { return d.n; }).sort(function (a, b) { return b - a; }),
          remainingSec: remainingSec
        });
      }
    }

    view.state = "armed";
    view.nextFireAtMs = pendingFireAts.length ? Math.min.apply(null, pendingFireAts) : null;
    view.done = view.nextFireAtMs === null;
    return { actions: actions, view: view, ledger: ledger, prevTarget: target };
  }

  function formatFireMessage(fire) {
    var leads = Array.isArray(fire.leads) ? fire.leads : [fire.lead];
    var lead = Math.max.apply(null, leads);
    var m = Math.max(1, Math.round(fire.remainingSec / 60));
    var title = "3100번 도착 " + lead + "분 전";
    if (fire.kind === "late") {
      return { title: title, body: "이미 " + lead + "분 이내입니다 (약 " + m + "분 남음)" };
    }
    return { title: title, body: "약 " + m + "분 후 도착 예정" };
  }


  // ---- 시각 알람 (확장 프로그램의 '알람'): 매일/요일 반복 또는 한 번만 ----
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

  // ---- 지난 주 같은 요일의 도착 기록으로 보는 '오늘 이 시간대에 올 버스' (안내용, 알람 발화와 무관) ----
  var HISTORY_WEEKS = 4;      // arrival_log 는 30일만 보관하므로 최대 4주
  var SLOT_GAP_MIN = 10;      // 도착 시각이 이보다 벌어지면 다른 차로 본다 (배차 간격 약 30분)
  function weeklyArrivalSlots(input) {
    var nowMs = input.nowMs;
    var weeks = Math.min(HISTORY_WEEKS, Math.max(1, Math.round(Number(input.weeks)) || HISTORY_WEEKS));
    var today = kstParts(nowMs);
    var windows = sanitizeWindows(input.windows);
    var active = windows.filter(function (w) { return w.days.indexOf(today.day) !== -1; });
    var out = { slots: [], weeksWithData: 0, weeksRequested: weeks, day: today.day, noWindowToday: windows.length > 0 && !active.length };
    if (out.noWindowToday) return out;

    var dates = {};
    for (var k = 1; k <= weeks; k++) dates[kstParts(nowMs - 7 * k * DAY_MS).date] = false;   // 값: 그 날 기록이 있었는지
    var points = [];
    (Array.isArray(input.rows) ? input.rows : []).forEach(function (r) {
      if (!r) return;
      var seen = String(r.ts_kst || "").slice(0, 10);
      if (Object.prototype.hasOwnProperty.call(dates, seen)) dates[seen] = true;   // 공휴일 등 기록이 아예 없는 주는 분모에서 뺀다
      var at = Date.parse(r.est_arrival_ts);
      if (!Number.isFinite(at)) return;                                           // 도착이 확인/추정되지 않은 행은 제외
      var p = kstParts(at);
      if (!Object.prototype.hasOwnProperty.call(dates, p.date)) return;
      if (active.length && !active.some(function (w) { return p.minutes >= parseTime(w.start) && p.minutes < parseTime(w.end); })) return;
      points.push({ min: p.minutes, date: p.date });
    });
    out.weeksWithData = Object.keys(dates).filter(function (d) { return dates[d]; }).length;

    points.sort(function (a, b) { return a.min - b.min; });
    var slots = [], cur = null;
    points.forEach(function (pt) {
      if (!cur || pt.min - cur.maxMin > SLOT_GAP_MIN) {
        cur = { minMin: pt.min, maxMin: pt.min, count: 0, _dates: {} };
        slots.push(cur);
      }
      cur.maxMin = pt.min;
      cur.count += 1;
      cur._dates[pt.date] = true;
    });
    var nextFound = false;
    out.slots = slots.map(function (s) {
      var status = s.maxMin < today.minutes ? "passed" : nextFound ? "upcoming" : "next";
      if (status === "next") nextFound = true;
      return { minMin: s.minMin, maxMin: s.maxMin, count: s.count, weeks: Object.keys(s._dates).length, status: status };
    });
    return out;
  }
  function formatSlot(slot, weeksWithData) {
    var range = slot.minMin === slot.maxMin ? formatTime(slot.minMin) : formatTime(slot.minMin) + "~" + formatTime(slot.maxMin);
    return range + " 도착 · " + slot.weeks + "/" + weeksWithData + "주 관측";
  }

  // ---- 타이머 (확장 프로그램의 '타이머'): N분 뒤에 한 번 ----
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

  // 발화 시점에 한 번에 예약할 비프음: 3연속 비프 + 휴지를 duration 동안 반복 (최대 60초)
  function beepSchedule(durationSec) {
    var total = Math.min(60, Math.max(1, Number(durationSec) || 1));
    var out = [];
    for (var cycle = 0; cycle * 2.2 < total; cycle++) {
      for (var i = 0; i < 3; i++) {
        var t = cycle * 2.2 + i * 0.3;
        if (t < total) out.push({ t: Math.round(t * 100) / 100, freq: 880, dur: 0.18 });
      }
    }
    return out;
  }

  return {
    LEAD_MIN: LEAD_MIN, LEAD_MAX: LEAD_MAX, MAX_LEADS: MAX_LEADS, TRIP_TTL_MS: TRIP_TTL_MS,
    emptyLedger: emptyLedger, sanitizeConfig: sanitizeConfig, sanitizeLedger: sanitizeLedger,
    pruneLedger: pruneLedger, freshnessLimits: freshnessLimits, assessStatus: assessStatus,
    pickTarget: pickTarget, pickTargetInfo: pickTargetInfo, skipTarget: skipTarget, evaluate: evaluate,
    formatFireMessage: formatFireMessage, beepSchedule: beepSchedule,
    MAX_WINDOWS: MAX_WINDOWS, MAX_CLOCKS: MAX_CLOCKS, MAX_TIMERS: MAX_TIMERS, TIMER_MAX_MIN: TIMER_MAX_MIN,
    kstParts: kstParts, parseTime: parseTime, formatTime: formatTime, daysLabel: daysLabel, sanitizeDays: sanitizeDays,
    defaultWindows: defaultWindows, sanitizeWindows: sanitizeWindows, inWindows: inWindows, windowsText: windowsText,
    sanitizeClocks: sanitizeClocks, newClock: newClock, rearmClock: rearmClock, clockOccurrenceText: clockOccurrenceText,
    evaluateClocks: evaluateClocks, pruneClockLedger: pruneClockLedger, busHint: busHint, formatClockMessage: formatClockMessage,
    HISTORY_WEEKS: HISTORY_WEEKS, weeklyArrivalSlots: weeklyArrivalSlots, formatSlot: formatSlot,
    sanitizeTimers: sanitizeTimers, newTimer: newTimer, evaluateTimers: evaluateTimers, formatTimerMessage: formatTimerMessage
  };
});
