import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../bus-arrival/alarm.js");

const MIN = 60000;
const T0 = Date.parse("2026-09-30T18:00:00+09:00");
const iso = (ms) => new Date(ms).toISOString();

// status.json 한 건. pollAt 에 조회했고 predictSec 초 뒤 도착 예정.
const status = (pollAt, predictSec, extra = {}) => ({
  last_poll: iso(pollAt), current_veh_id: 111, current_plate: "경기70아1111",
  predict_sec: predictSec, location_no: 3, ...extra,
});
const DAY = 24 * 60 * MIN;
// 기본 시나리오는 알림 시간대 제한 없음(windows: [])으로 시험한다. 시간대는 아래 별도 테스트에서 다룬다.
const cfg = (extra = {}) => ({ enabled: true, leads: [5], windows: [], armedAtMs: T0 - 60 * MIN, ...extra });
const step = (state, nowMs, st, opts = {}) => {
  const snap = A.assessStatus(st, nowMs, { maxAgeMin: 13 });
  const out = A.evaluate({ cfg: state.cfg, snap, ledger: state.ledger, nowMs, prevTarget: state.prev, ...opts });
  return { cfg: state.cfg, ledger: out.ledger, prev: out.prevTarget, actions: out.actions, view: out.view };
};
const fresh = (c = cfg()) => ({ cfg: c, ledger: A.emptyLedger(), prev: null });
const fires = (r) => r.actions.filter((a) => a.type === "fire");

test("도착 예정 시각은 절대값이라 스냅샷 나이와 무관하다", () => {
  const arrival = T0 + 12 * MIN;
  const a = A.assessStatus(status(T0, 720), T0, {});
  const b = A.assessStatus(status(T0 - 4 * MIN, 720 + 240), T0, {});
  assert.equal(a.arrivalAtMs, arrival);
  assert.equal(b.arrivalAtMs, arrival);
  const r = step(fresh(), T0, status(T0 - 4 * MIN, 960));
  assert.equal(r.view.nextFireAtMs, arrival - 5 * MIN);
});

test("fireAt 1초 전에는 울리지 않고 fireAt 에 울린 뒤 원장이 재발화를 막는다", () => {
  const st = status(T0, 600);           // 도착 T0+10분, 5분 전 = T0+5분
  const fireAt = T0 + 5 * MIN;
  let r = step(fresh(), fireAt - 1000, st);
  assert.equal(fires(r).length, 0);
  r = step(r, fireAt, st);
  assert.equal(fires(r).length, 1);
  assert.equal(fires(r)[0].kind, "ontime");
  assert.deepEqual(fires(r)[0].leads, [5]);
  r = step(r, fireAt + 1000, st);
  assert.equal(fires(r).length, 0);
  assert.equal(r.view.done, true);
});

test("여러 리드는 각각 제시간에 울린다", () => {
  const st = status(T0, 900);           // 도착 T0+15분
  let r = step(fresh(cfg({ leads: [10, 5] })), T0 + 5 * MIN, st);
  assert.deepEqual(fires(r).map((f) => f.leads), [[10]]);
  r = step(r, T0 + 10 * MIN, st);
  assert.deepEqual(fires(r).map((f) => f.leads), [[5]]);
});

test("늦게 알게 되면 지난 리드를 한 번으로 합쳐 late 로 울린다", () => {
  const st = status(T0, 240);           // 처음 보는데 이미 4분 남음
  const r = step(fresh(cfg({ leads: [10, 5] })), T0, st);
  assert.equal(fires(r).length, 1);
  assert.equal(fires(r)[0].kind, "late");
  assert.deepEqual(fires(r)[0].leads, [10, 5]);
  assert.match(A.formatFireMessage(fires(r)[0]).body, /이미 10분 이내/);
  assert.equal(step(r, T0 + 5000, st).actions.length, 0);
});

test("알람을 켜기 전에 이미 지난 시점은 조용히 넘긴다 (skipped_late)", () => {
  const st = status(T0, 240);
  const r = step(fresh(cfg({ armedAtMs: T0 })), T0, st);
  assert.equal(r.actions.length, 0);
  assert.deepEqual(r.view.skipped, [5]);
  assert.equal(step(r, T0 + 10000, st).actions.length, 0);
});

test("켠 뒤에 처음 관측된 차량은 이미 지났어도 late 로 한 번 울린다", () => {
  const armed = fresh(cfg({ armedAtMs: T0 - 30 * MIN }));
  const r = step(armed, T0, status(T0, 200));
  assert.equal(fires(r)[0].kind, "late");
});

test("남은 시간이 60초 미만이면 울리지 않고 missed 로 처리한다", () => {
  const r = step(fresh(), T0, status(T0, 45));
  assert.equal(r.actions.length, 0);
  assert.equal(r.ledger.fired["111|5"].k, "missed");
});

test("울리면 안 되는 상태: 오래됨, no_bus, api_error, 미래 poll, 차량 0, 잘못된 예측, 이미 지난 도착", () => {
  const cases = {
    too_old: [status(T0 - 20 * MIN, 900), "too_old"],
    no_bus: [{ last_poll: iso(T0), error: "no_bus" }, "no_bus"],
    api_error: [{ last_poll: iso(T0), error: "api_error" }, "api_error"],
    clock_skew: [status(T0 + 10 * MIN, 100), "clock_skew"],
    veh0: [status(T0, 100, { current_veh_id: 0 }), "no_bus"],
    nan: [status(T0, "abc"), "bad"],
    negative: [status(T0, -5), "bad"],
    empty: [status(T0, ""), "bad"],
    missing: [null, "bad"],
  };
  for (const [name, [st, why]] of Object.entries(cases)) {
    const r = step(fresh(), T0, st);
    assert.equal(r.actions.length, 0, name);
    assert.equal(r.view.why, why, name);
  }
  const passed = step(fresh(), T0 + 10 * MIN, status(T0, 100));
  assert.equal(passed.actions.length, 0);
  assert.equal(passed.view.state, "passed");
});

test("알람 없이 차량이 사라지거나 교체되면 passed 를 한 번 낸다", () => {
  let r = step(fresh(), T0, status(T0, 900));
  r = step(r, T0 + MIN, { last_poll: iso(T0 + MIN), error: "no_bus" });
  assert.deepEqual(r.actions, [{ type: "passed", vehId: 111 }]);
  assert.equal(step(r, T0 + 2 * MIN, { last_poll: iso(T0 + 2 * MIN), error: "no_bus" }).actions.length, 0);

  r = step(fresh(), T0, status(T0, 900));
  r = step(r, T0 + MIN, status(T0 + MIN, 700, { current_veh_id: 222 }));
  assert.deepEqual(r.actions, [{ type: "passed", vehId: 111 }]);
});

test("이미 울린 차량이 사라져도 passed 는 없다", () => {
  let r = step(fresh(), T0, status(T0, 600));
  r = step(r, T0 + 5 * MIN, status(T0, 600));
  assert.equal(fires(r).length, 1);
  r = step(r, T0 + 6 * MIN, { last_poll: iso(T0 + 6 * MIN), error: "no_bus" });
  assert.equal(r.actions.length, 0);
});

test("신뢰할 수 없는 스냅샷(오래됨/오류)은 대상 차량을 지우지 않는다", () => {
  let r = step(fresh(), T0, status(T0, 900));
  r = step(r, T0 + 30 * MIN, status(T0, 900));   // too_old
  assert.equal(r.view.state, "unavailable");
  assert.equal(r.actions.length, 0);
  assert.equal(r.prev.vehId, 111);
});

test("예측이 늦춰지거나 다시 커져도 이미 울린 알람은 재발화하지 않는다", () => {
  let r = step(fresh(), T0 + 5 * MIN, status(T0, 600));
  assert.equal(fires(r).length, 1);
  r = step(r, T0 + 6 * MIN, status(T0 + 6 * MIN, 900));  // ETA 가 15분으로 밀림
  assert.equal(r.actions.length, 0);
  r = step(r, T0 + 12 * MIN, status(T0 + 6 * MIN, 900));  // 다시 5분 이내
  assert.equal(r.actions.length, 0);
});

test("ETA 가 바뀌면 fireAt 도 따라 움직인다", () => {
  let r = step(fresh(), T0, status(T0, 900));
  assert.equal(r.view.nextFireAtMs, T0 + 10 * MIN);
  r = step(r, T0 + MIN, status(T0 + MIN, 1200));
  assert.equal(r.view.nextFireAtMs, T0 + MIN + 15 * MIN);
});

test("같은 차량이 20분 넘게 뒤에 다시 오면 새 운행으로 다시 무장한다", () => {
  let r = step(fresh(), T0 + 5 * MIN, status(T0, 600));
  assert.equal(fires(r).length, 1);
  const later = T0 + 3 * 60 * MIN;
  r = step(r, later, status(later, 900));
  assert.equal(r.actions.length, 0);
  r = step(r, later + 10 * MIN, status(later, 900));
  assert.equal(fires(r).length, 1);
});

test("건너뛰면 다음 차량 기준으로 다시 잡고, 다음 운행에는 이어지지 않는다", () => {
  const st = status(T0, 600, { next_veh_id: 222, next_predict_sec: 2400 });
  let r = step(fresh(), T0, st);
  assert.equal(r.view.target.vehId, 111);
  r.ledger = A.skipTarget(r.ledger, r.view.target);
  r = step(r, T0 + 1000, st);
  assert.equal(r.view.target.vehId, 222);
  assert.equal(r.view.target.source, "next");
  assert.equal(r.actions.length, 0);     // 건너뛴 차량은 passed 도 아님
  // 3시간 뒤 같은 차량이 다시 오면 건너뛰기는 유효하지 않다
  const later = T0 + 3 * 60 * MIN;
  const pruned = A.pruneLedger(r.ledger, later);
  assert.deepEqual(pruned.skipped, {});
});

test("sanitizeConfig / pruneLedger", () => {
  assert.deepEqual(A.sanitizeConfig(null), { enabled: false, leads: [5], windows: A.defaultWindows(), armedAtMs: null });
  const c = A.sanitizeConfig({ enabled: true, leads: [5, "10", 5, 0, 99, "x", 7.4, 3, 2], armedAtMs: "abc" });
  assert.deepEqual(c.leads, [10, 7, 5, 3]);
  assert.equal(c.armedAtMs, null);
  assert.deepEqual(A.sanitizeConfig({ leads: [] }).leads, [5]);
  assert.equal(A.sanitizeConfig({ enabled: "yes" }).enabled, false);

  const ledger = { fired: { "1|5": { a: T0, k: "ontime" }, "2|5": { a: T0 - 60 * MIN, k: "late" }, bad: "x" },
                   skipped: { 3: T0 - 60 * MIN, 4: T0 } };
  const p = A.pruneLedger(ledger, T0 + 10 * MIN);
  assert.deepEqual(Object.keys(p.fired), ["1|5"]);
  assert.deepEqual(Object.keys(p.skipped), ["4"]);
  assert.deepEqual(A.pruneLedger(undefined, T0), { fired: {}, skipped: {} });
});

test("formatFireMessage / beepSchedule / freshnessLimits", () => {
  assert.deepEqual(A.formatFireMessage({ kind: "ontime", leads: [5], remainingSec: 290 }),
    { title: "3100번 도착 5분 전", body: "약 5분 후 도착 예정" });
  assert.equal(A.formatFireMessage({ kind: "late", leads: [10, 5], remainingSec: 200 }).body,
    "이미 10분 이내입니다 (약 3분 남음)");
  const beeps = A.beepSchedule(30);
  assert.ok(beeps.length >= 30 && beeps.every((b) => b.t < 30));
  assert.ok(A.beepSchedule(9999).every((b) => b.t < 60));
  assert.deepEqual(A.freshnessLimits(5, 60), { fresh: 8, aging: 13 });
  assert.deepEqual(A.freshnessLimits(5, 120), { fresh: 9, aging: 14 });
  assert.deepEqual(A.freshnessLimits(5, undefined), { fresh: 8, aging: 13 });
});

test("알람이 꺼져 있으면 아무 것도 하지 않는다", () => {
  const r = step(fresh(cfg({ enabled: false })), T0 + 5 * MIN, status(T0, 600));
  assert.equal(r.view.state, "off");
  assert.equal(r.actions.length, 0);
  assert.equal(r.prev, null);
});


// ---------------- 알림 시간대 ----------------
const KST = (text) => Date.parse(text + "+09:00");
const COMMUTE = [{ start: "17:30", end: "19:30", days: [1, 2, 3, 4, 5] }];   // 평일 퇴근 시간대
const WED_1800 = KST("2026-09-30T18:00:00");                                  // 수요일

test("sanitizeConfig: windows 키가 없으면 기본 퇴근 시간대, 빈 배열이면 제한 없음", () => {
  assert.deepEqual(A.sanitizeConfig({}).windows, [{ start: "17:30", end: "19:30", days: [1, 2, 3, 4, 5] }]);
  assert.deepEqual(A.sanitizeConfig({ windows: [] }).windows, []);
  const w = A.sanitizeWindows([{ start: "8:05", end: "09:00", days: [6, 0, 0, 9] }, { start: "10:00", end: "09:00" },
    { start: "x", end: "11:00" }, null, { start: "12:00", end: "13:00" }]);
  assert.deepEqual(w, [{ start: "08:05", end: "09:00", days: [0, 6] }, { start: "12:00", end: "13:00", days: [1, 2, 3, 4, 5] }]);
  assert.equal(A.sanitizeWindows(Array.from({ length: 9 }, () => ({ start: "01:00", end: "02:00" }))).length, A.MAX_WINDOWS);
});

test("inWindows: 요일과 KST 시각으로 판단하고 끝 시각은 포함하지 않는다", () => {
  assert.equal(A.inWindows(COMMUTE, KST("2026-09-30T17:30:00")), true);
  assert.equal(A.inWindows(COMMUTE, KST("2026-09-30T19:29:59")), true);
  assert.equal(A.inWindows(COMMUTE, KST("2026-09-30T19:30:00")), false);
  assert.equal(A.inWindows(COMMUTE, KST("2026-09-30T17:29:59")), false);
  assert.equal(A.inWindows(COMMUTE, KST("2026-10-03T18:00:00")), false);   // 토요일
  assert.equal(A.inWindows([], KST("2026-10-03T03:00:00")), true);
  assert.equal(A.windowsText(COMMUTE), "평일 17:30~19:30");
  assert.equal(A.windowsText([]), "제한 없음");
});

test("시간대 밖에 도착하는 버스에는 알리지 않고, 다음 버스가 시간대 안이면 그 차량을 대상으로 한다", () => {
  const c = cfg({ windows: COMMUTE, armedAtMs: WED_1800 - 60 * MIN });
  // 현재 버스는 16:50 도착(시간대 밖) -> 알림 없음
  let now = KST("2026-09-30T16:40:00");
  let r = step(fresh(c), now, status(now, 600));
  assert.equal(r.view.outside, true);
  assert.equal(r.view.target, null);
  assert.equal(r.view.state, "armed");        // 정보가 없는 게 아니라 시간대 밖이라 대기 중
  r = step(r, now + 5 * MIN, status(now, 600));
  assert.equal(fires(r).length, 0);
  // 다음 버스가 17:40 도착(시간대 안) -> 다음 버스가 대상
  const st = status(now, 600, { next_veh_id: 222, next_predict_sec: 3600 });
  r = step(fresh(c), now, st);
  assert.equal(r.view.target.vehId, 222);
  assert.equal(r.view.target.source, "next");
  // 첫 버스가 지나가고 다음 버스(222)가 현재 차량이 되어 17:40 도착 -> 5분 전인 17:35 에 울린다
  const later = KST("2026-09-30T17:34:00");
  r = step(r, later + MIN, status(later, 360, { current_veh_id: 222 }));
  assert.deepEqual(fires(r).map((f) => [f.vehId, f.leads]), [[222, [5]]]);
});

test("시간대 안에 도착하면 시간대 시작 전에 울릴 수도 있다 (도착 시각 기준)", () => {
  const c = cfg({ windows: COMMUTE, armedAtMs: WED_1800 - 120 * MIN });
  const pollAt = KST("2026-09-30T17:20:00");
  const st = status(pollAt, 780);                // 17:33 도착 -> 시간대 안, 5분 전은 17:28
  let r = step(fresh(c), pollAt, st);
  assert.equal(r.view.outside, false);
  r = step(r, KST("2026-09-30T17:28:00"), st);
  assert.equal(fires(r).length, 1);
});

test("시간대 조정으로 대상에서 밀려난 차량은 passed 로 취급하지 않는다", () => {
  const c = cfg({ windows: COMMUTE });
  const pollAt = KST("2026-09-30T19:10:00");
  let r = step(fresh(c), pollAt, status(pollAt, 900));         // 19:25 도착: 시간대 안
  assert.equal(r.view.target.vehId, 111);
  r = step(r, pollAt + MIN, status(pollAt + MIN, 1500));       // 예측이 19:36 으로 밀려 시간대 밖
  assert.equal(r.view.target, null);
  assert.equal(r.actions.length, 0);
});

// ---- 버스 알림 시간대 입력 형식 ----
test("parseTime / formatTime / daysLabel", () => {
  assert.equal(A.parseTime("8:05"), 485);
  assert.equal(A.parseTime("24:00"), null);
  assert.equal(A.parseTime("12:60"), null);
  assert.equal(A.parseTime(""), null);
  assert.equal(A.formatTime(485), "08:05");
  assert.equal(A.daysLabel([]), "한 번만");
  assert.equal(A.daysLabel([1, 2, 3, 4, 5]), "평일");
  assert.equal(A.daysLabel([0, 1, 2, 3, 4, 5, 6]), "매일");
  assert.equal(A.daysLabel([6, 0]), "주말");
  assert.equal(A.daysLabel([1, 3]), "월·수");
});

// 지난 주 같은 요일 기록으로 보는 도착 예상 시간대
const NOW_WED = KST("2026-09-30T18:30:00");   // 수요일. 지난 수요일들: 09-23, 09-16, 09-09, 09-02
const arr = (date, hhmm, extra = {}) => ({ ts_kst: `${date}T${hhmm}:30+09:00`, est_arrival_ts: `${date}T${hhmm}:00+09:00`, ...extra });

test("n주 전 같은 요일: 버스별로 도착 시각 min~max 를 묶고 지난 것/다음 것을 구분한다", () => {
  const rows = [
    arr("2026-09-23", "18:02"), arr("2026-09-16", "18:09"), arr("2026-09-09", "18:05"),
    arr("2026-09-23", "18:35"), arr("2026-09-16", "18:41"),
  ];
  const r = A.weeklyArrivalSlots({ rows, windows: A.defaultWindows(), nowMs: NOW_WED });
  assert.equal(r.weeksWithData, 3);
  assert.equal(r.weeksRequested, 4);
  assert.equal(r.slots.length, 2);
  assert.deepEqual(r.slots.map((s) => [A.formatTime(s.minMin), A.formatTime(s.maxMin), s.weeks, s.status]),
    [["18:02", "18:09", 3, "passed"], ["18:35", "18:41", 2, "next"]]);
  assert.equal(A.formatSlot(r.slots[0], r.weeksWithData), "18:02~18:09 도착 · 3/3주 관측");
  assert.equal(A.formatSlot({ minMin: 1085, maxMin: 1085, weeks: 1 }, 2), "18:05 도착 · 1/2주 관측");
  // 아직 아무 슬롯도 지나지 않은 시각이면 첫 슬롯이 next, 나머지는 upcoming
  const early = A.weeklyArrivalSlots({ rows, windows: A.defaultWindows(), nowMs: KST("2026-09-30T17:40:00") });
  assert.deepEqual(early.slots.map((s) => s.status), ["next", "upcoming"]);
});

test("n주 전 같은 요일: 시간대 밖/다른 요일/오늘/4주보다 오래된 기록과 도착 미확인 행은 슬롯에서 뺀다", () => {
  const rows = [
    arr("2026-09-23", "18:02"),
    arr("2026-09-23", "19:45"),                          // 시간대(17:30~19:30) 밖
    arr("2026-09-22", "18:10"),                          // 화요일
    arr("2026-09-30", "18:20"),                          // 오늘은 지난주 기록이 아니다
    arr("2026-09-02", "18:12", { est_arrival_ts: "" }),  // 도착 미확인(차량 변경 등)
    arr("2026-08-26", "18:15"),                          // 5주 전
  ];
  const r = A.weeklyArrivalSlots({ rows, windows: A.defaultWindows(), nowMs: NOW_WED });
  assert.deepEqual(r.slots.map((s) => A.formatTime(s.minMin)), ["18:02"]);
  assert.equal(r.weeksWithData, 2);   // 09-23 과 09-02(행은 있으나 도착 미확인). 기록이 없는 주는 분모에서 빠진다
  // 시간대 제한이 없으면 19:45 도 포함
  const open = A.weeklyArrivalSlots({ rows, windows: [], nowMs: NOW_WED });
  assert.deepEqual(open.slots.map((s) => A.formatTime(s.minMin)), ["18:02", "19:45"]);
});

test("n주 전 같은 요일: 오늘 요일에 해당하는 시간대가 없으면 안내하지 않고, 기록이 없으면 빈 결과", () => {
  const mondayOnly = [{ start: "17:30", end: "19:30", days: [1] }];
  const none = A.weeklyArrivalSlots({ rows: [arr("2026-09-23", "18:02")], windows: mondayOnly, nowMs: NOW_WED });
  assert.equal(none.noWindowToday, true);
  assert.deepEqual(none.slots, []);
  const empty = A.weeklyArrivalSlots({ rows: [], windows: A.defaultWindows(), nowMs: NOW_WED });
  assert.equal(empty.noWindowToday, false);
  assert.equal(empty.weeksWithData, 0);
  assert.deepEqual(empty.slots, []);
  assert.deepEqual(A.weeklyArrivalSlots({ rows: null, windows: [], nowMs: NOW_WED }).slots, []);
});
