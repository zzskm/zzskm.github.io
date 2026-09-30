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

  // 알람 대상 차량: 현재 차량, 건너뛴 차량이면 다음 차량
  function pickTarget(snap, ledger, nowMs) {
    if (!snap || !snap.usable) return null;
    var led = sanitizeLedger(ledger);
    if (!isSkipped(led, snap.vehId, snap.arrivalAtMs)) {
      return { vehId: snap.vehId, arrivalAtMs: snap.arrivalAtMs, source: "current" };
    }
    if (snap.next && !isSkipped(led, snap.next.vehId, snap.next.arrivalAtMs)) {
      return { vehId: snap.next.vehId, arrivalAtMs: snap.next.arrivalAtMs, source: "next" };
    }
    return null;
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
                 done: false, skipped: [] };

    if (!cfg.enabled) return { actions: actions, view: view, ledger: ledger, prevTarget: null };

    var target = pickTarget(snap, ledger, nowMs);
    var reliable = snap.why === "ok" || snap.why === "no_bus";

    // 알람 없이 차량이 사라짐/교체됨 (신뢰할 수 있는 스냅샷에서만 판단한다)
    if (prev && reliable && (!target || target.vehId !== prev.vehId)) {
      var userSkipped = isSkipped(ledger, prev.vehId, prev.arrivalAtMs);
      var unfired = cfg.leads.some(function (n) { return !firedEntry(ledger, prev.vehId, n, prev.arrivalAtMs); });
      if (unfired && !userSkipped) actions.push({ type: "passed", vehId: prev.vehId });
    }

    if (!target) {
      view.state = snap.why === "no_bus" ? "armed" : "unavailable";
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
    pickTarget: pickTarget, skipTarget: skipTarget, evaluate: evaluate,
    formatFireMessage: formatFireMessage, beepSchedule: beepSchedule
  };
});
