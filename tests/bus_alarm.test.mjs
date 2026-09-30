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
const cfg = (extra = {}) => ({ enabled: true, leads: [5], armedAtMs: T0 - 60 * MIN, ...extra });
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
  assert.deepEqual(A.sanitizeConfig(null), { enabled: false, leads: [5], armedAtMs: null });
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
