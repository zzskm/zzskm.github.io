import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../dashboard-alarm.js');
const MIN=60000, DAY=86400000;
const KST = text => Date.parse(text + '+09:00');
const T0=KST('2026-09-30T18:00:00');
const WED_1759=KST('2026-09-30T17:59:00'), WED_1800=T0;
test("반복 알람: 예정 시각에 한 번만 울리고 다음 날 다시 울린다", () => {
  const clock = A.newClock({ time: "18:00", label: "퇴근 준비", days: [1, 2, 3, 4, 5] }, WED_1759 - 60 * MIN);
  let r = A.evaluateClocks({ clocks: [clock], ledger: {}, nowMs: WED_1759 });
  assert.equal(r.actions.length, 0);
  r = A.evaluateClocks({ clocks: r.clocks, ledger: r.ledger, nowMs: WED_1800 });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, "clock");
  assert.equal(r.actions[0].kind, "ontime");
  assert.equal(r.clocks[0].enabled, true);
  const again = A.evaluateClocks({ clocks: r.clocks, ledger: r.ledger, nowMs: WED_1800 + 30000 });
  assert.equal(again.actions.length, 0);
  const next = A.evaluateClocks({ clocks: r.clocks, ledger: again.ledger, nowMs: WED_1800 + DAY });
  assert.equal(next.actions.length, 1);
});

test("요일이 맞지 않으면 울리지 않는다", () => {
  const clock = A.newClock({ time: "18:00", days: [1, 2, 3, 4, 5] }, KST("2026-10-02T09:00:00"));   // 금요일에 생성
  const sat = A.evaluateClocks({ clocks: [clock], ledger: {}, nowMs: KST("2026-10-03T18:00:00") });
  assert.equal(sat.actions.length, 0);
  const mon = A.evaluateClocks({ clocks: [clock], ledger: {}, nowMs: KST("2026-10-05T18:00:00") });
  assert.equal(mon.actions.length, 1);
});

test("한 번짜리 알람: 지난 시각이면 내일로 잡고, 울린 뒤에는 꺼진다", () => {
  const before = KST("2026-09-30T17:00:00");
  const today = A.newClock({ time: "18:00" }, before);
  assert.equal(today.date, "2026-09-30");
  const tomorrow = A.newClock({ time: "16:00" }, before);
  assert.equal(tomorrow.date, "2026-10-01");
  const r = A.evaluateClocks({ clocks: [today], ledger: {}, nowMs: WED_1800 });
  assert.equal(r.actions.length, 1);
  assert.equal(r.clocks[0].enabled, false);
  assert.equal(A.evaluateClocks({ clocks: r.clocks, ledger: r.ledger, nowMs: WED_1800 + DAY }).actions.length, 0);
  // 다시 켜면 다음에 오는 그 시각으로 옮겨진다
  const re = A.rearmClock(r.clocks[0], WED_1800 + 5 * MIN);
  assert.equal(re.enabled, true);
  assert.equal(re.date, "2026-10-01");
});

test("만들기 전에 이미 지난 오늘 시각은 울리지 않는다 (since)", () => {
  const clock = A.newClock({ time: "18:00", days: [3] }, WED_1800 + 30 * MIN);   // 18:30 에 18:00 알람 생성
  const r = A.evaluateClocks({ clocks: [clock], ledger: {}, nowMs: WED_1800 + 31 * MIN });
  assert.deepEqual(r.actions, []);
});

test("스로틀링 등으로 늦게 확인해도 10분까지는 late 로 울리고, 그보다 늦으면 놓친 알람으로만 알린다", () => {
  const clock = A.newClock({ time: "18:00", label: "약속", days: [3] }, WED_1759 - 60 * MIN);
  const late = A.evaluateClocks({ clocks: [clock], ledger: {}, nowMs: WED_1800 + 4 * MIN });
  assert.equal(late.actions[0].type, "clock");
  assert.equal(late.actions[0].kind, "late");
  assert.match(A.formatClockMessage(late.actions[0], "").body, /약 4분 늦게 확인됨/);
  const missed = A.evaluateClocks({ clocks: [clock], ledger: {}, nowMs: WED_1800 + 40 * MIN });
  assert.equal(missed.actions[0].type, "clock_missed");
  assert.match(A.formatClockMessage(missed.actions[0], "").body, /놓쳤습니다/);
  const ancient = A.evaluateClocks({ clocks: [clock], ledger: {}, nowMs: WED_1800 + 13 * 60 * MIN });
  assert.equal(ancient.actions.length, 0);
});

test("꺼진 알람은 울리지 않고 다른 탭이 이미 울린 알람은 원장으로 막힌다", () => {
  const clock = A.newClock({ time: "18:00", days: [3] }, WED_1759 - 60 * MIN);
  assert.equal(A.evaluateClocks({ clocks: [{ ...clock, enabled: false }], ledger: {}, nowMs: WED_1800 }).actions.length, 0);
  const led = { [`${clock.id}|2026-09-30`]: WED_1800 };
  assert.equal(A.evaluateClocks({ clocks: [clock], ledger: led, nowMs: WED_1800 + 1000 }).actions.length, 0);
});

test("자정을 넘겨서 확인해도 어제 23:59 알람이 늦게 울린다", () => {
  const clock = A.newClock({ time: "23:59", days: [3] }, KST("2026-09-30T20:00:00"));
  const r = A.evaluateClocks({ clocks: [clock], ledger: {}, nowMs: KST("2026-10-01T00:03:00") });
  assert.equal(r.actions[0].type, "clock");
});

test("시각 알람 메시지에는 다음 버스 정보를 덧붙일 수 있다", () => {
  const snap = {usable:true, arrivalAtMs:T0 + 420000};
  assert.equal(A.busHint(snap, T0), "3100번 약 7분 후 도착 예정");
  assert.equal(A.busHint(A.assessStatus(null, T0), T0), "");
  const action = { type: "clock", label: "퇴근 준비", time: "18:00", kind: "ontime", bus: true, lateMs: 0 };
  assert.deepEqual(A.formatClockMessage(action, A.busHint(snap, T0)), { title: "퇴근 준비", body: "18:00 · 3100번 약 7분 후 도착 예정" });
  assert.equal(A.formatClockMessage({ ...action, bus: false }, "힌트").body, "18:00");
  assert.equal(A.formatClockMessage({ ...action, label: "" }, "").title, "알람");
});

test("sanitizeClocks: 잘못된 항목과 중복 id 를 걸러낸다", () => {
  const good = { id: "a", time: "7:30", label: "가".repeat(50), days: [1, 1, 2] };
  const clocks = A.sanitizeClocks([good, { ...good }, { id: "b", time: "99:99", days: [1] }, { id: "c", time: "10:00", days: [] },
    { id: "d", time: "10:00", days: [], date: "2026-10-01" }, null]);
  assert.deepEqual(clocks.map((c) => c.id), ["a", "d"]);
  assert.equal(clocks[0].time, "07:30");
  assert.equal(clocks[0].label.length, 30);
  assert.deepEqual(clocks[0].days, [1, 2]);
  assert.equal(A.sanitizeClocks(Array.from({ length: 30 }, (_, i) => ({ id: "x" + i, time: "10:00", days: [1] }))).length, A.MAX_CLOCKS);
});

test("clockOccurrenceText / pruneClockLedger", () => {
  const now = KST("2026-09-30T17:00:00");
  assert.equal(A.clockOccurrenceText({ time: "18:00", days: [1, 2, 3, 4, 5] }, now), "평일 18:00");
  assert.equal(A.clockOccurrenceText({ time: "18:00", days: [], date: "2026-09-30" }, now), "오늘 18:00");
  assert.equal(A.clockOccurrenceText({ time: "09:00", days: [], date: "2026-10-01" }, now), "내일 09:00");
  const pruned = A.pruneClockLedger({ "a|2026-09-30": 1, "a|2026-09-25": 1, "a|2026-09-27": 1 }, now);
  assert.deepEqual(Object.keys(pruned).sort(), ["a|2026-09-27", "a|2026-09-30"]);
});

// ---------------- 타이머 ----------------
test("타이머: 끝나는 시각에 한 번 울리고 목록에서 빠진다", () => {
  const t = A.newTimer(10, "라면", T0);
  assert.equal(t.endsAtMs, T0 + 10 * MIN);
  let r = A.evaluateTimers({ timers: [t], nowMs: T0 + 10 * MIN - 1000 });
  assert.equal(r.actions.length, 0);
  assert.equal(r.timers.length, 1);
  r = A.evaluateTimers({ timers: r.timers, nowMs: T0 + 10 * MIN });
  assert.deepEqual(r.actions, [{ type: "timer", id: t.id, label: "라면", minutes: 10 }]);
  assert.equal(r.timers.length, 0);
  assert.deepEqual(A.formatTimerMessage(r.actions[0]), { title: "라면", body: "10분 타이머가 끝났습니다" });
  assert.equal(A.formatTimerMessage({ label: "", minutes: 5 }).title, "타이머");
});

test("타이머: 범위를 벗어난 분과 잘못된 저장값을 거른다", () => {
  assert.equal(A.newTimer(0, "", T0), null);
  assert.equal(A.newTimer(721, "", T0), null);
  assert.equal(A.newTimer("abc", "", T0), null);
  assert.equal(A.newTimer("7", "", T0).minutes, 7);
  const ids = [A.newTimer(5, "", T0).id, A.newTimer(5, "", T0).id];
  assert.notEqual(ids[0], ids[1]);
  const timers = A.sanitizeTimers([{ id: "a", endsAtMs: T0 }, { id: "a", endsAtMs: T0 }, { id: "b" }, { endsAtMs: T0 }, "x"]);
  assert.deepEqual(timers.map((t) => t.id), ["a"]);
  assert.equal(A.sanitizeTimers(Array.from({ length: 20 }, (_, i) => ({ id: "t" + i, endsAtMs: T0 + i }))).length, A.MAX_TIMERS);
  // 탭이 닫혀 있는 동안 끝난 타이머도 열자마자 울린다
  const late = A.evaluateTimers({ timers: [{ id: "z", endsAtMs: T0 }], nowMs: T0 + 3 * 60 * MIN });
  assert.equal(late.actions.length, 1);
});

test("요일 반복 알람은 일주일 내내 꺼지지 않고 평일에만 울린다", () => {
  let clocks = [A.newClock({ time: "18:00", days: [1, 2, 3, 4, 5] }, KST("2026-09-28T09:00:00"))];   // 월요일에 만듦
  let ledger = {};
  const rang = [];
  for (let d = 0; d < 7; d++) {
    const nowMs = KST("2026-09-28T18:00:00") + d * DAY;
    const r = A.evaluateClocks({ clocks, ledger, nowMs });
    clocks = r.clocks; ledger = r.ledger;
    rang.push(r.actions.length);
    assert.equal(clocks[0].enabled, true);
  }
  assert.deepEqual(rang, [1, 1, 1, 1, 1, 0, 0]);   // 월~금 울림, 토·일 조용
});

// 지난 주 같은 요일 기록으로 보는 도착 예상 시간대
