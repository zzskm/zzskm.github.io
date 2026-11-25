// garmin-weight 화면의 순수 함수(app.helpers.js): 날짜 글자, 차트의 예측 주 수, 가로축 눈금 (재검토 FE1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../garmin-weight/app.helpers.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, Date, Math, Number, String, Set, Map, Array, Object });
vm.runInContext(SOURCE, context);
const helpers = context.window.GWAppHelpers;
const { dayNumber, dayIso, forecastWeeks, dateTicks, tickLabel, fmtDate, fmtDateShort } = helpers;

const iso = (ticks) => Array.from(ticks, (n) => dayIso(n));
const weekday = (n) => new Date(n * 86400000).getUTCDay(); // 1 = 월요일

test('예측은 보이는 과거의 절반까지만 그린다(차트 폭의 1/3 이하)', () => {
  assert.deepEqual([30, 60, 90, 168, 257, 2000].map(forecastWeeks), [2, 4, 6, 12, 12, 12]);
  for (const past of [14, 20, 30, 45, 60, 100, 167, 168, 400]) {
    const forecastDays = forecastWeeks(past) * 7;
    assert.ok(forecastDays / (past + forecastDays) <= 1 / 3 + 1e-9, `past ${past}: ${forecastDays} days of forecast`);
  }
  // 이력이 2주에 못 미쳐도 1주는 그린다. 과거 길이를 모르면 전부 그린다.
  assert.deepEqual([0, 5, 13].map(forecastWeeks), [1, 1, 1]);
  assert.equal(forecastWeeks(NaN), 12);
});

test('눈금은 월요일이나 1일에 놓인다', () => {
  const from = dayNumber('2026-09-26');
  const weekly = dateTicks(from, dayNumber('2026-12-23'), 14);
  assert.deepEqual(iso(weekly).slice(0, 3), ['2026-09-28', '2026-10-05', '2026-10-12']);
  assert.ok(weekly.every((n) => weekday(n) === 1));
  assert.equal(weekly.length, 13);

  // 자리가 모자라면 2주, 달, 두 달, 분기 순으로 성기게 한다.
  const fortnightly = dateTicks(from, dayNumber('2026-12-23'), 8);
  assert.deepEqual(iso(fortnightly), ['2026-09-28', '2026-10-12', '2026-10-26', '2026-11-09', '2026-11-23', '2026-12-07', '2026-12-21']);
  assert.deepEqual(iso(dateTicks(from, dayNumber('2026-12-23'), 4)), ['2026-10-01', '2026-11-01', '2026-12-01']);
  assert.deepEqual(iso(dateTicks(dayNumber('2026-03-13'), dayNumber('2027-02-17'), 6)),
    ['2026-05-01', '2026-07-01', '2026-09-01', '2026-11-01', '2027-01-01']);
  assert.deepEqual(iso(dateTicks(dayNumber('2026-03-13'), dayNumber('2027-02-17'), 4)),
    ['2026-04-01', '2026-07-01', '2026-10-01', '2027-01-01']);
});

test('2주 간격 눈금은 보기 범위를 바꿔도 같은 월요일에 놓인다', () => {
  const a = iso(dateTicks(dayNumber('2026-09-26'), dayNumber('2026-12-23'), 8));
  const b = iso(dateTicks(dayNumber('2026-10-20'), dayNumber('2026-12-23'), 8));
  assert.ok(b.every((day) => a.includes(day)), `${b} within ${a}`);
});

test('짧은 범위와 긴 범위에서도 눈금이 나온다', () => {
  const short = dateTicks(dayNumber('2026-11-20'), dayNumber('2026-11-27'), 10);
  assert.deepEqual(iso(short), ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
  assert.deepEqual(iso(dateTicks(dayNumber('2026-11-20'), dayNumber('2026-11-27'), 3)), ['2026-11-23']);
  const decade = dateTicks(dayNumber('2020-06-01'), dayNumber('2031-06-01'), 5);
  assert.ok(decade.length >= 2 && decade.length <= 5, `${decade.length} ticks`);
  assert.ok(iso(decade).every((day) => day.endsWith('-01-01')));
  assert.deepEqual(Array.from(dateTicks(10, 5, 8)), []);
  // 눈금 수는 한도를 넘지 않는다.
  for (const limit of [2, 3, 5, 8, 14]) {
    for (const days of [10, 44, 88, 341, 800, 3000]) {
      const ticks = dateTicks(dayNumber('2026-03-13'), dayNumber('2026-03-13') + days, limit);
      assert.ok(ticks.length >= 1 && ticks.length <= limit, `${days} days, limit ${limit}: ${ticks.length}`);
    }
  }
});

test('해가 바뀌는 눈금에 연도를 적는다', () => {
  const dec = dayNumber('2026-12-01');
  const jan = dayNumber('2027-01-01');
  const feb = dayNumber('2027-02-01');
  // 한 해 안의 축: 연도가 없다.
  assert.equal(tickLabel(dec, null, false), '12/1');
  // 두 해에 걸친 축: 첫 눈금과 해가 바뀐 눈금에만 연도가 붙는다(둘째 줄).
  assert.deepEqual(Array.from(tickLabel(dec, null, true)), ['12/1', '2026']);
  assert.deepEqual(Array.from(tickLabel(jan, dec, true)), ['1/1', '2027']);
  assert.equal(tickLabel(feb, jan, true), '2/1');
});

test('기준일과 해가 다른 날짜에는 연도를 붙인다', () => {
  // 460일 뒤의 도달일이 "2/28"로만 나오던 경우다.
  assert.equal(fmtDateShort('2028-02-28', '2026-11-25'), '2028/2/28');
  assert.equal(fmtDateShort('2026-12-20', '2026-11-25'), '12/20');
  assert.equal(fmtDateShort('2026-12-20'), '12/20');
  assert.equal(fmtDate('2025-12-30', '2026-11-25'), '2025년 12월 30일');
  assert.equal(fmtDate('2026-11-24', '2026-11-25'), '11월 24일');
  assert.equal(fmtDate('2026-11-24'), '11월 24일');
  assert.equal(fmtDate(null, '2026-11-25'), '–');
});
