import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadTripData(filename) {
  const code = fs.readFileSync(path.join(ROOT, filename), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { filename });
  return sandbox.window.TRIP_DATA;
}

test('generated Japan trip page is in sync with the shared template', () => {
  assert.doesNotThrow(
    () => execFileSync(process.execPath, ['scripts/build_trip_pages.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' }),
    'trip_2026_dec_japan.html is out of date; run: node scripts/build_trip_pages.mjs',
  );
});

test('standalone China page includes dual-mode shell and required scripts/styles', () => {
  const html = fs.readFileSync(path.join(ROOT, 'trip_2026_dec_china.html'), 'utf8');
  for (const token of [
    'trip_2026_dec.styles.css',
    'trip_2026_dec_china.styles.css',
    'trip_2026_dec_china.data.js',
    'trip_2026_dec.app.js',
    'trip_2026_dec_china.field.js',
    'id="field-mode"',
    'id="plan-mode"',
    'id="cards-panel"',
    'id="result-panel"',
    'id="section-parking"',
    'id="section-data"',
    'id="stayB-nights-controls"',
    'id="taxi-modal"',
    'data-ftab="schedule"',
    'data-ftab="map"',
    'data-ftab="prep"',
    'data-ftab="bookings"',
    'data-ftab="budget"',
    'data-ftab="notes"',
  ]) {
    assert.ok(html.includes(token), `Missing expected token in trip_2026_dec_china.html: ${token}`);
  }
});

test('Shanghai master data integrates Cheongju flight, downtown stays, customs, and dining guide', () => {
  const data = loadTripData('trip_2026_dec_china.data.js');
  assert.equal(data.cityOrder[0], 'shanghai');
  assert.equal(data.initial.seasonId, 'w1128');
  assert.equal(data.initial.durationId, 'n3');
  assert.equal(data.party.travelers.defaultValue, 2);
  assert.equal(data.rx.patients.matchTravelers, true);
  assert.equal(data.rx.dutyFreeLimitUSD, 800);
  assert.equal(data.countries.cn.defaultRxPlanId, 'p10x12');

  const sh = data.cities.shanghai;
  assert.equal(sh.defaults.flightId, 'cjj_pvg');
  assert.equal(sh.defaults.clinicId, 'taobao_cold');
  assert.equal(sh.defaults.stayPreId, 'same_hotel');

  // Bathhouses & immersive shows excluded
  assert.equal(sh.activities.some((a) => a.id === 'tangquan'), false, 'tangquan must be excluded');
  const allItineraryText = JSON.stringify(sh.itinerary);
  for (const forbidden of ['汤泉', '찜질방', 'Sleep No More', 'Immersive Arcane', 'DreamScape', 'New World Manor']) {
    assert.equal(allItineraryText.includes(forbidden), false, `Excluded item found in itinerary: ${forbidden}`);
  }

  // Downtown staysA verification + Magnotel Xintiandi / Metropolo / Campanile included, no airport stays
  const requiredChecks = ['frontDesk24h', 'foreignerOk', 'parcelReceive', 'parcelHold', 'lateCheckin', 'luggageStore', 'inRoomFridge'];
  assert.equal(sh.staysA.some((s) => s.stayType === 'airport'), false, 'airport stays should not be in staysA');
  assert.ok(sh.staysA.some((s) => s.id === 'magnotel_xintiandi'), 'Magnotel Xintiandi must be in staysA');
  assert.ok(sh.staysA.some((s) => s.id === 'metropolo_classiq'), 'Metropolo Classiq must be in staysA');
  assert.ok(sh.staysA.some((s) => s.id === 'campanile_bund'), 'Campanile must be in staysA');
  for (const stay of sh.staysA) {
    assert.ok(stay.verification, `Missing verification on stay ${stay.id}`);
    assert.ok(['A', 'B', 'excluded'].includes(stay.verification.grade), `Invalid grade on ${stay.id}`);
    for (const key of requiredChecks) {
      assert.ok(['ok', 'unverified', 'no'].includes(stay.verification.checks[key]), `Invalid check ${key} on ${stay.id}`);
    }
  }

  // Budget downtown staysB (no Suzhou/Disney/airport)
  assert.equal(sh.staysB.some((s) => ['suzhou_old_town', 'disney_toystory', 'ramada_pvg_b', 'holiday_inn_pvg_b'].includes(s.id)), false);
  assert.ok(sh.staysB.some((s) => s.id === 'dorm_b'));
  assert.ok(sh.staysB.some((s) => s.id === 'guesthouse_private_b'));
  assert.ok(sh.staysB.some((s) => s.id === 'magnotel_xintiandi_b'));

  // 4-day itinerary (2026-11-28..2026-12-01), valid placeId & reservationId references
  assert.equal(sh.itinerary.length, 4);
  assert.deepEqual(
    Array.from(sh.itinerary, (d) => d.date),
    ['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01'],
  );
  const resIds = new Set(sh.reservations.map((r) => r.id));
  for (const day of sh.itinerary) {
    for (const item of day.items) {
      assert.ok(sh.places[item.placeId], `Unknown placeId ${item.placeId} on ${item.id}`);
      if (item.reservationId) {
        assert.ok(resIds.has(item.reservationId), `Unknown reservationId ${item.reservationId} on ${item.id}`);
      }
      if (item.placeId === 'yuyuan_tonghanchuntang' || item.placeId === 'kpg_xintiandi') {
        assert.notEqual(day.weekday, '월', 'Monday-closed sites must not be on Monday');
      }
    }
  }

  // Dining guide
  assert.ok(Array.isArray(sh.diningGuide) && sh.diningGuide.length >= 6);
  for (const d of sh.diningGuide) {
    assert.ok(sh.places[d.placeId], `Unknown diningGuide placeId: ${d.placeId}`);
  }
});
