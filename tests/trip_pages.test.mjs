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

test('Shanghai itinerary shell: mode switch at the bottom, no manual reorder, offline worker covers the page files', () => {
  const html = fs.readFileSync(path.join(ROOT, 'trip_2026_dec_china.html'), 'utf8');
  const field = fs.readFileSync(path.join(ROOT, 'trip_2026_dec_china.field.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'trip_2026_dec_china.sw.js'), 'utf8');

  // The quote mode switch sits in the footer, below both mode shells; the header keeps only a way back.
  const footerAt = html.indexOf('class="sh-footer"');
  assert.ok(footerAt > html.indexOf('id="plan-mode"'), 'footer must come after the plan-mode shell');
  assert.ok(html.indexOf('id="mode-btn-plan"') > footerAt, 'mode switch must be inside the footer');
  assert.ok(html.includes('class="sh-btn is-primary sh-mode-back" data-mode="field"'), 'plan mode needs a way back to the itinerary');

  // Items follow the data's time order: the reorder buttons and the saved order are gone.
  assert.equal(field.includes('data-move-item'), false, 'reorder buttons must not be rendered');
  assert.equal(field.includes('itemOrder'), false, 'saved manual order must not be used');

  // Every script, stylesheet and icon the page loads is in the worker's asset list, and so is the page.
  const loaded = new Set(Array.from(html.matchAll(/(?:src|href)="([^":]+\.(?:js|css|svg))"/g), (m) => m[1]));
  assert.ok(loaded.size >= 6, 'expected the page to load its scripts and styles');
  for (const file of [...loaded, 'trip_2026_dec_china.html']) {
    assert.ok(sw.includes(`"${file}"`), `Offline worker does not cache ${file}`);
    assert.ok(fs.existsSync(path.join(ROOT, file)), `Missing file ${file}`);
  }
  // Network first (revalidating), registered with a scope that matches this page only.
  assert.ok(sw.includes('cache: "no-cache"'), 'worker must revalidate with the network first');
  assert.ok(field.includes('register("trip_2026_dec_china.sw.js", { scope: "./trip_2026_dec_china" })'));
});

test('Shanghai page keeps the flat look: no gradients, pill shapes, drop shadows or emoji icons', () => {
  const css = fs.readFileSync(path.join(ROOT, 'trip_2026_dec_china.styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const html = fs.readFileSync(path.join(ROOT, 'trip_2026_dec_china.html'), 'utf8');
  const field = fs.readFileSync(path.join(ROOT, 'trip_2026_dec_china.field.js'), 'utf8');

  assert.equal(/gradient\(/.test(css), false, 'no gradients');
  assert.equal(/999px/.test(css), false, 'no pill radius');
  assert.equal(/backdrop-filter/.test(css), false, 'no blur');
  // The only shadows allowed are "none" and a flat inset bar.
  for (const [, value] of css.matchAll(/box-shadow:\s*([^;]+);/g)) {
    assert.ok(value === 'none' || value.startsWith('inset '), `Unexpected box-shadow: ${value}`);
  }
  // The shared palette is re-declared for this page so the gradient background of the shared sheet is replaced.
  assert.match(css, /\.shanghai-shell\s*\{[^}]*--bg:\s*#ffffff;[^}]*background:\s*var\(--bg\);/);

  const pictographs = /\p{Extended_Pictographic}/gu;
  const allowed = new Set(['↗', '▾', '▴', '★', '©', '®', '™', '↔', '↓', '↑']);
  for (const [name, text] of [['html', html], ['field.js', field]]) {
    const found = (text.match(pictographs) || []).filter((ch) => !allowed.has(ch));
    assert.deepEqual(found, [], `Emoji icons found in ${name}`);
  }

  // Stage 2 and 3 pieces: all-days view, print, tonight's stay, fixed-time markers.
  for (const token of ['data-select-view="all"', 'data-print-page', 'class="day-stay"', 'class="tl-fixed"', 'class="tl-checkwrap"']) {
    assert.ok(field.includes(token), `Missing in field.js: ${token}`);
  }
  assert.ok(css.includes('@media print'), 'print styles');
});

test('Shanghai master data integrates Cheongju flight, downtown stays, customs, and dining guide', () => {
  const data = loadTripData('trip_2026_dec_china.data.js');
  assert.equal(data.cityOrder[0], 'shanghai');
  assert.equal(data.initial.seasonId, 'w1128');
  assert.equal(data.initial.durationId, 'n4');
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

  // Downtown staysA verification + booked Metropolo YMCA / backup candidates included, no airport stays
  const requiredChecks = ['frontDesk24h', 'foreignerOk', 'parcelReceive', 'parcelHold', 'lateCheckin', 'luggageStore', 'inRoomFridge'];
  assert.equal(sh.staysA.some((s) => s.stayType === 'airport'), false, 'airport stays should not be in staysA');
  assert.ok(sh.staysA.some((s) => s.id === 'metropolo_ymca'), 'booked Metropolo YMCA must be in staysA');
  assert.ok(sh.staysA.some((s) => s.id === 'magnotel_bund'), 'Magnotel Bund must be in staysA');
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
  assert.ok(sh.staysB.some((s) => s.id === 'ssaw_yilin_b'), 'booked SSAW Yilin must be in staysB');
  assert.equal(sh.defaults.stayBId, 'ssaw_yilin_b');
  assert.equal(sh.places.hotel_b.nameZh, '上海伊林君亭酒店');

  // 5-day itinerary (2026-11-28..2026-12-02), valid placeId & reservationId references
  assert.equal(sh.itinerary.length, 5);
  assert.deepEqual(
    Array.from(sh.itinerary, (d) => d.date),
    ['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'],
  );
  const resIds = new Set(sh.reservations.map((r) => r.id));
  const seenItemIds = new Set();
  const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  for (const day of sh.itinerary) {
    let prevStart = -1;
    for (const item of day.items) {
      assert.equal(seenItemIds.has(item.id), false, `Duplicate itinerary item id ${item.id}`);
      seenItemIds.add(item.id);
      assert.ok(sh.places[item.placeId], `Unknown placeId ${item.placeId} on ${item.id}`);
      assert.match(item.startTime, /^\d{2}:\d{2}$/, `Bad startTime on ${item.id}`);
      assert.match(item.endTime, /^\d{2}:\d{2}$/, `Bad endTime on ${item.id}`);
      assert.ok(toMin(item.startTime) >= prevStart, `Items out of time order at ${item.id}`);
      prevStart = toMin(item.startTime);
      if (item.planB) {
        assert.ok(sh.places[item.planB.placeId], `Unknown planB placeId ${item.planB.placeId} on ${item.id}`);
      }
      for (const step of item.steps || []) {
        assert.ok(step.time && step.title && step.detail, `Incomplete step on ${item.id}`);
      }
      for (const block of item.guide || []) {
        assert.ok(block.title && Array.isArray(block.lines) && block.lines.length, `Incomplete guide block on ${item.id}`);
      }
      if (item.reservationId) {
        assert.ok(resIds.has(item.reservationId), `Unknown reservationId ${item.reservationId} on ${item.id}`);
      }
      if (item.placeId === 'yuyuan_tonghanchuntang' || item.placeId === 'kpg_xintiandi') {
        assert.notEqual(day.weekday, '월', 'Monday-closed sites must not be on Monday');
      }
    }
  }

  // Reservations and checklists point at real items, and checklist ids are unique
  for (const r of sh.reservations) {
    if (r.linkedItemId) assert.ok(seenItemIds.has(r.linkedItemId), `Unknown linkedItemId ${r.linkedItemId} on ${r.id}`);
  }
  const checkIds = [...sh.checklists.preTrip, ...Object.values(sh.checklists.byDay).flat()].map((c) => c.id);
  assert.equal(new Set(checkIds).size, checkIds.length, 'Duplicate checklist id');

  // Research (2026-11-25): arrival walkthrough, departure-morning timetable, payment guide
  const itemById = (id) => sh.itinerary.flatMap((d) => d.items).find((it) => it.id === id);
  assert.equal(itemById('d1_pvg_arrival').steps.length, 3);
  assert.equal(itemById('d5_checkout').startTime, '06:40');
  assert.equal(itemById('d5_to_airport').startTime, '07:15');
  assert.ok(itemById('d5_airport').guide.some((g) => g.title === '라운지'));
  assert.equal(sh.places.pvg_t2_departure.nameZh, '浦东国际机场T2航站楼出发');
  assert.ok(sh.airportTransfers.some((a) => a.id === sh.defaults.airportId), 'default airport transfer must exist');
  assert.ok(sh.paymentGuide.methods.length >= 5 && sh.paymentGuide.atmTips.length >= 3);
  assert.equal(JSON.stringify(sh).includes('07:30 디디'), false, 'stale 07:30 departure text');

  // Items that cannot slip are marked, and every day says where the night is spent (none on the return day).
  for (const id of ['d1_cjj_flight', 'd2_crab_dinner', 'd3_benbang_dinner', 'd5_to_airport', 'd5_airport', 'd5_return_flight']) {
    assert.equal(itemById(id).fixedTime, true, `${id} must be marked fixedTime`);
  }
  assert.deepEqual(
    Array.from(sh.itinerary, (d) => d.stayPlaceId),
    ['main_hotel', 'main_hotel', 'hotel_b', 'hotel_b', null],
  );
  for (const d of sh.itinerary) {
    if (d.stayPlaceId) assert.ok(sh.places[d.stayPlaceId], `Unknown stayPlaceId on day ${d.dayIndex + 1}`);
  }

  // Flights, both stays and roaming are settled (2026-11-25): none of them is an open reservation.
  for (const id of ['res_flight', 'res_hotel_a', 'res_hotel_b', 'res_esim']) {
    const r = sh.reservations.find((x) => x.id === id);
    assert.equal(r.confirmed, true, `${id} must be confirmed`);
    assert.equal(r.defaultStatus, 'booked');
    assert.equal(Boolean(r.urgentD8), false);
  }

  // Dining guide
  assert.ok(Array.isArray(sh.diningGuide) && sh.diningGuide.length >= 6);
  for (const d of sh.diningGuide) {
    assert.ok(sh.places[d.placeId], `Unknown diningGuide placeId: ${d.placeId}`);
  }
});
