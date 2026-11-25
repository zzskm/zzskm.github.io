import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadShanghaiTrip() {
  const filename = 'trip_2026_dec_china.data.js';
  const code = fs.readFileSync(path.join(ROOT, filename), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { filename });
  return sandbox.window.SHANGHAI_TRIP;
}

const CHINA_FILES = [
  'trip_2026_dec_china.html',
  'trip_2026_dec_china.field.js',
  'trip_2026_dec_china.data.js',
  'trip_2026_dec_china.styles.css',
  'trip_2026_dec_china.sw.js',
];
const readChina = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

test('generated Japan trip page is in sync with the shared template', () => {
  assert.doesNotThrow(
    () => execFileSync(process.execPath, ['scripts/build_trip_pages.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' }),
    'trip_2026_dec_japan.html is out of date; run: node scripts/build_trip_pages.mjs',
  );
});

test('Shanghai page is one on-site itinerary shell: five tabs, no quote mode', () => {
  const html = readChina('trip_2026_dec_china.html');
  for (const token of [
    'trip_2026_dec.styles.css',
    'trip_2026_dec_china.styles.css',
    'trip_2026_dec_china.data.js',
    'trip_2026_dec_china.field.js',
    'id="field-app"',
    'id="taxi-modal"',
    'id="phrase-modal"',
    '请带我去这里',
    '9C7050 12:00 → 13:15',
    '9C7049 11:00 → 14:05',
    '<title>상하이 4박 5일 여행 · 청주 출발 (11/28–12/02)</title>',
  ]) {
    assert.ok(html.includes(token), `Missing expected token in trip_2026_dec_china.html: ${token}`);
  }
  // The quote calculator, its shared script and the mode switch are gone.
  for (const token of ['trip_2026_dec.app.js', 'id="plan-mode"', 'data-mode=', 'mode-switch', 'id="cards-panel"', 'id="result-panel"', 'id="evidence-modal"']) {
    assert.equal(html.includes(token), false, `Removed piece still in the page: ${token}`);
  }

  // Five entries in each nav, in this order, each with a panel; no entry without a panel and no panel without an entry.
  const tabs = ['schedule', 'map', 'phrases', 'budget', 'notes'];
  for (const cls of ['field-nav-btn', 'field-mnav-btn']) {
    const found = Array.from(html.matchAll(new RegExp(`class="${cls}[^"]*" data-ftab="([a-z]+)"`, 'g')), (m) => m[1]);
    assert.deepEqual(found, tabs, `${cls}: tab entries`);
  }
  assert.deepEqual(Array.from(html.matchAll(/data-fpanel="([a-z]+)"/g), (m) => m[1]), tabs, 'panels');
  const field = readChina('trip_2026_dec_china.field.js');
  assert.ok(field.includes('const FIELD_TABS = ["schedule", "map", "phrases", "budget", "notes"];'));
  // Every id the script looks up exists: in the page, or in the markup the script itself draws.
  for (const [, id] of field.matchAll(/byId\("([a-z0-9-]+)"\)/g)) {
    assert.ok(html.includes(`id="${id}"`) || field.includes(`id="${id}"`), `Element #${id} is looked up but never created`);
  }
});

test('Shanghai page files carry no leftover of the removed prescription, customs and quote parts', () => {
  for (const name of CHINA_FILES) {
    const text = readChina(name);
    for (const word of ['처방', '마운자로', '관세', '준비 · 견적', '견적', 'Mounjaro', 'TRIP_APP_BRIDGE', 'TRIP_DATA']) {
      assert.equal(text.includes(word), false, `"${word}" is still in ${name}`);
    }
  }
  const field = readChina('trip_2026_dec_china.field.js');
  for (const word of ['state.reservations', 'state.checklistDone', 'state.customChecks', 'state.hotelInquiry', 'state.mode', 'planMode', 'bookSub']) {
    assert.equal(field.includes(word), false, `Unused state "${word}" is still in field.js`);
  }
});

test('Shanghai itinerary shell: no manual reorder, offline worker covers the page files', () => {
  const html = readChina('trip_2026_dec_china.html');
  const field = readChina('trip_2026_dec_china.field.js');
  const sw = readChina('trip_2026_dec_china.sw.js');

  // Items follow the data's time order: the reorder buttons and the saved order are gone.
  assert.equal(field.includes('data-move-item'), false, 'reorder buttons must not be rendered');
  assert.equal(field.includes('itemOrder'), false, 'saved manual order must not be used');
  // The saved state keeps its key, so spending and notes survive an update of the page.
  assert.ok(field.includes('const FIELD_KEY = "trip_2026_dec_china.field.v1";'));

  // Every script, stylesheet and icon the page loads is in the worker's asset list, and so is the page.
  const loaded = new Set(Array.from(html.matchAll(/(?:src|href)="([^":]+\.(?:js|css|svg))"/g), (m) => m[1]));
  assert.equal(loaded.size, 5, 'the page loads two stylesheets, two scripts and the icon');
  for (const file of [...loaded, 'trip_2026_dec_china.html']) {
    assert.ok(sw.includes(`"${file}"`), `Offline worker does not cache ${file}`);
    assert.ok(fs.existsSync(path.join(ROOT, file)), `Missing file ${file}`);
  }
  // Nothing is cached that the page does not load.
  const listStart = sw.indexOf('const ASSETS = [');
  const assets = Array.from(sw.slice(listStart, sw.indexOf('];', listStart)).matchAll(/"([^"]+)"/g), (m) => m[1]);
  assert.deepEqual(assets.sort(), [...loaded].sort(), 'asset list (besides the page) equals the files the page loads');
  // Network first (revalidating), registered with a scope that matches this page only.
  assert.ok(sw.includes('cache: "no-cache"'), 'worker must revalidate with the network first');
  assert.ok(field.includes('register("trip_2026_dec_china.sw.js", { scope: "./trip_2026_dec_china" })'));
  // The phrases are static data: the page makes no network request of its own.
  assert.equal(/\bfetch\(|XMLHttpRequest|WebSocket/.test(field + readChina('trip_2026_dec_china.data.js')), false, 'no network calls');
});

test('Shanghai page keeps the flat look: tone-layered surfaces, no gradients, pill shapes, drop shadows or emoji icons', () => {
  const css = readChina('trip_2026_dec_china.styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const html = readChina('trip_2026_dec_china.html');
  const field = readChina('trip_2026_dec_china.field.js');

  assert.equal(/gradient\(/.test(css), false, 'no gradients');
  assert.equal(/999px/.test(css), false, 'no pill radius');
  assert.equal(/backdrop-filter/.test(css), false, 'no blur');
  // The only shadows allowed are "none" and a flat inset bar.
  for (const [, value] of css.matchAll(/box-shadow:\s*([^;]+);/g)) {
    assert.ok(value === 'none' || value.startsWith('inset '), `Unexpected box-shadow: ${value}`);
  }
  // The shared palette is re-declared for this page so the gradient background of the shared sheet is replaced:
  // a light grey page with white blocks on it.
  assert.match(css, /\.shanghai-shell\s*\{[^}]*--bg:\s*#f5f6f8;[^}]*--panel:\s*#ffffff;[^}]*background:\s*var\(--bg\);/);
  // Figures line up, the page fits the visible viewport, dialogs do not scroll the page behind them.
  assert.match(css, /\.shanghai-shell\s*\{[^}]*min-height:\s*100dvh;[^}]*font-variant-numeric:\s*tabular-nums;/);
  assert.ok(css.includes('overscroll-behavior: contain'), 'dialogs contain their scroll');
  assert.ok(css.includes('env(safe-area-inset-bottom'), 'bottom bar clears the home indicator');
  // Five tabs across both navs.
  assert.equal((css.match(/grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/g) || []).length, 2, 'both navs are five columns');
  // Chinese text breaks between characters (the shared sheet keeps Korean words whole).
  assert.match(css, /\[lang="zh-CN"\]\s*\{[^}]*word-break:\s*normal;/);

  const pictographs = /\p{Extended_Pictographic}/gu;
  const allowed = new Set(['↗', '▾', '▴', '★', '©', '®', '™', '↔', '↓', '↑']);
  for (const [name, text] of [['html', html], ['field.js', field]]) {
    const found = (text.match(pictographs) || []).filter((ch) => !allowed.has(ch));
    assert.deepEqual(found, [], `Emoji icons found in ${name}`);
  }

  // All-days view, print, tonight's stay, fixed-time markers, and the phrase controls.
  for (const token of [
    'data-select-view="all"',
    'data-print-page',
    'class="day-stay"',
    'class="tl-fixed"',
    'class="tl-checkwrap"',
    'data-phrase-set=',
    'data-phrase-open=',
    'data-phrase-copy=',
    'data-phrase-cat=',
    'data-word=',
  ]) {
    assert.ok(field.includes(token), `Missing in field.js: ${token}`);
  }
  assert.ok(css.includes('@media print'), 'print styles');
});

test('Shanghai itinerary data: booked flights and hotels, the five days in order, valid references', () => {
  const sh = loadShanghaiTrip();
  assert.equal(sh.tripMeta.flights.out, '9C7050 · 11/28(토) 청주 12:00 → 푸둥 13:15');
  assert.equal(sh.tripMeta.flights.back, '9C7049 · 12/02(수) 푸둥 11:00 → 청주 14:05');

  // The two booked hotels keep their Chinese names and addresses.
  assert.equal(sh.places.hotel_ymca.nameZh, '锦江都城经典上海青年会酒店');
  assert.equal(sh.places.hotel_ymca.addressZh, '上海市黄浦区西藏南路123号');
  assert.equal(sh.places.hotel_ssaw.nameZh, '上海伊林君亭酒店');
  assert.equal(sh.places.hotel_ssaw.addressZh, '上海市徐汇区宜山路645号');
  const categories = ['transport', 'stay', 'food', 'sight', 'shopping'];
  for (const [id, place] of Object.entries(sh.places)) {
    assert.equal(place.id, id, `place id mismatch on ${id}`);
    for (const key of ['nameKo', 'nameZh', 'addressZh', 'area', 'category']) assert.ok(place[key], `Missing ${key} on place ${id}`);
    assert.ok(categories.includes(place.category), `Unknown category on place ${id}`);
    for (const d of place.dayIndices) assert.ok(d >= 0 && d < 5, `Bad day index on place ${id}`);
  }
  // Addresses given for the new route.
  assert.equal(sh.places.chiikawa_flagship.addressZh, '上海市黄浦区南京东路139号 外滩中央广场');
  assert.equal(sh.places.new_world_city.addressZh, '上海市黄浦区南京西路2-68号 新世界城');
  assert.equal(sh.places.xuyan.addressZh, '上海市静安区汶水路40号');
  assert.equal(sh.places.wukang_mansion.nameZh, '武康大楼');
  assert.equal(sh.places.anfu_road.nameZh, '安福路');
  assert.equal(sh.places.jingan_temple.nameZh, '静安寺');
  assert.equal(sh.places.xujiahui_library.nameZh, '徐家汇书院');
  assert.ok(sh.places.yuyuan_bridge.nameZh.includes('豫园九曲桥'));

  // 5-day itinerary (2026-11-28..2026-12-02)
  assert.deepEqual(
    Array.from(sh.itinerary, (d) => d.date),
    ['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'],
  );
  assert.deepEqual(Array.from(sh.itinerary, (d) => d.weekday), ['토', '일', '월', '화', '수']);
  assert.deepEqual(
    Array.from(sh.itinerary, (d) => d.stayPlaceId),
    ['hotel_ymca', 'hotel_ymca', 'hotel_ssaw', 'hotel_ssaw', null],
  );

  const phraseIds = new Set(sh.phrases.map((p) => p.id));
  const seenItemIds = new Set();
  const usedPlaces = new Set();
  const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  for (const day of sh.itinerary) {
    assert.equal(sh.itinerary.indexOf(day), day.dayIndex, 'dayIndex matches the position');
    if (day.stayPlaceId) {
      assert.ok(sh.places[day.stayPlaceId], `Unknown stayPlaceId on day ${day.dayIndex + 1}`);
      usedPlaces.add(day.stayPlaceId);
    }
    let prevStart = -1;
    for (const item of day.items) {
      assert.equal(seenItemIds.has(item.id), false, `Duplicate itinerary item id ${item.id}`);
      seenItemIds.add(item.id);
      if (item.placeId !== null) assert.ok(sh.places[item.placeId], `Unknown placeId ${item.placeId} on ${item.id}`);
      else assert.ok((item.candidates || []).length, `${item.id} has no place and no candidate places`);
      assert.match(item.startTime, /^\d{2}:\d{2}$/, `Bad startTime on ${item.id}`);
      assert.match(item.endTime, /^\d{2}:\d{2}$/, `Bad endTime on ${item.id}`);
      assert.equal(item.durationMin, toMin(item.endTime) - toMin(item.startTime), `durationMin on ${item.id}`);
      assert.ok(item.durationMin > 0, `End before start on ${item.id}`);
      assert.ok(toMin(item.startTime) >= prevStart, `Items out of time order at ${item.id}`);
      prevStart = toMin(item.startTime);
      assert.ok(categories.includes(item.category), `Unknown category on ${item.id}`);
      assert.ok(Number.isFinite(item.estCostCNY) && item.estCostLabel, `Missing cost on ${item.id}`);
      if (item.planB) assert.ok(sh.places[item.planB.placeId], `Unknown planB placeId on ${item.id}`);
      for (const id of [item.placeId, item.planB && item.planB.placeId, ...(item.candidates || [])]) {
        if (!id) continue;
        assert.ok(sh.places[id], `Unknown place ${id} on ${item.id}`);
        assert.ok(sh.places[id].dayIndices.includes(day.dayIndex), `Place ${id} is used on day ${day.dayIndex + 1} but not listed for it`);
        usedPlaces.add(id);
      }
      for (const step of item.steps || []) assert.ok(step.time && step.title && step.detail, `Incomplete step on ${item.id}`);
      for (const block of item.guide || []) assert.ok(block.title && Array.isArray(block.lines) && block.lines.length, `Incomplete guide block on ${item.id}`);
      if (item.phraseIds) {
        assert.ok(item.phraseLabel, `phraseLabel missing on ${item.id}`);
        for (const id of item.phraseIds) assert.ok(phraseIds.has(id), `Unknown phrase ${id} on ${item.id}`);
      }
      if (item.placeId === 'kpg_xintiandi' || item.placeId === 'yuyuan_garden') {
        assert.notEqual(day.weekday, '월', 'Monday-closed sites must not be on Monday');
      }
    }
  }
  // The map lists only places of this plan.
  for (const d of sh.diningGuide) usedPlaces.add(d.placeId);
  assert.deepEqual(Object.keys(sh.places).filter((id) => !usedPlaces.has(id)), ['pvg_airport'], 'places not used by any item');

  // The times of the given plan, day by day (the first item of day 1 is the booked outbound flight).
  const starts = (i) => Array.from(sh.itinerary[i].items, (it) => it.startTime);
  assert.deepEqual(starts(0), ['09:30', '13:15', '15:30', '16:15', '17:45', '19:30']);
  assert.deepEqual(starts(1), ['09:45', '12:10', '12:30', '21:40']);
  assert.deepEqual(starts(2), ['10:30', '12:00', '13:30', '16:00', '18:30', '21:00']);
  assert.deepEqual(starts(3), ['10:30', '14:30', '17:15', '19:30']);
  assert.deepEqual(starts(4), ['07:30', '08:45', '11:00']);

  const itemById = (id) => sh.itinerary.flatMap((d) => d.items).find((it) => it.id === id);
  assert.equal(itemById('d2_wuzhen_tour').endTime, '21:40');
  assert.equal(itemById('d3_xuyan').endTime, '20:30');
  assert.equal(itemById('d5_to_airport').durationMin, 75);
  assert.equal(itemById('d5_return_flight').placeId, 'cjj_airport');
  // Items that cannot slip are marked.
  for (const id of ['d1_cjj_flight', 'd2_tour_meet', 'd2_wuzhen_tour', 'd3_xuyan', 'd5_to_airport', 'd5_airport', 'd5_return_flight']) {
    assert.equal(itemById(id).fixedTime, true, `${id} must be marked fixedTime`);
  }
  // Disneyland and Tianzifang are not part of this plan.
  const all = JSON.stringify(sh);
  for (const word of ['디즈니랜드', '迪士尼乐园', '톈쯔팡', '티엔즈팡', '田子坊']) {
    assert.equal(all.includes(word), false, `Excluded place found: ${word}`);
  }

  assert.ok(sh.paymentGuide.methods.length >= 5 && sh.paymentGuide.atmTips.length >= 3);
  assert.ok(sh.emergencyContacts.length >= 4);
  assert.ok(sh.fxKrwPerCny >= 150 && sh.fxKrwPerCny <= 250);
  assert.ok(Array.isArray(sh.diningGuide) && sh.diningGuide.length >= 6);
  for (const d of sh.diningGuide) {
    assert.ok(sh.places[d.placeId], `Unknown diningGuide placeId: ${d.placeId}`);
  }
});

test('Shanghai phrase data: 17 quick words, 20 sentences in five groups, linked to the right items', () => {
  const sh = loadShanghaiTrip();
  assert.equal(sh.quickWords.length, 17);
  assert.equal(sh.phrases.length, 20);
  assert.deepEqual(Array.from(sh.phraseCategories, (c) => c.label), ['호텔·택배', '식당·카페', '결제·쇼핑', '디디·이동', '기본·돌발']);

  const catIds = new Set(sh.phraseCategories.map((c) => c.id));
  const ids = new Set();
  for (const p of sh.phrases) {
    assert.equal(ids.has(p.id), false, `Duplicate phrase id ${p.id}`);
    ids.add(p.id);
    assert.ok(catIds.has(p.cat), `Unknown category on ${p.id}`);
    for (const key of ['title', 'zh', 'ko', 'pron']) assert.ok(p[key] && p[key].trim() === p[key], `Missing ${key} on ${p.id}`);
    assert.match(p.zh, /\p{Script=Han}/u, `No Chinese text on ${p.id}`);
    assert.match(p.pron, /\p{Script=Hangul}/u, `No Korean reading on ${p.id}`);
  }
  const count = (cat) => sh.phrases.filter((p) => p.cat === cat).length;
  assert.deepEqual(['hotel', 'food', 'pay', 'didi', 'basic'].map(count), [5, 4, 4, 4, 3]);
  const wordIds = new Set();
  for (const w of sh.quickWords) {
    assert.equal(wordIds.has(w.id), false, `Duplicate word id ${w.id}`);
    wordIds.add(w.id);
    for (const key of ['cat', 'ko', 'pron', 'zh']) assert.ok(w[key], `Missing ${key} on ${w.id}`);
  }
  assert.deepEqual([...new Set(sh.quickWords.map((w) => w.cat))], ['기본', '식당', '카페', '결제·쇼핑', '이동·호텔']);

  // The sentences as given.
  const zh = (id) => sh.phrases.find((p) => p.id === id).zh;
  assert.equal(zh('hotel_checkin_parcel'), '您好，我来办理入住。请问有我提前寄到酒店的快递吗？我想一起领取，谢谢！');
  assert.equal(zh('hotel_luggage_parcel'), '您好，我预订了今天的房间，想先寄存行李。另外，请问有提前寄到酒店的快递吗？可以先帮我保管或现在领取吗？');
  assert.equal(zh('hotel_parcel_count'), '快递不止一件，麻烦帮我确认一下一共有几件，谢谢。');
  assert.equal(zh('hotel_parcel_waybill'), '这是快递单号和收件信息，请您核对一下。');
  assert.equal(zh('food_xuyan'), '您好，我预订了今天的晚餐叙宴，只包含用餐和演出，不需要汉服和妆造体验。');
  assert.equal(zh('didi_airport_t2'), '请送我去浦东国际机场2号航站楼（T2）出发层，谢谢。');
  assert.equal(zh('didi_message'), '您好，我是外国人，接听中文电话不太方便，请发消息联系我，谢谢！');

  // The first sentence of an item's button is the one for that moment.
  const itemById = (id) => sh.itinerary.flatMap((d) => d.items).find((it) => it.id === id);
  assert.equal(itemById('d1_checkin').phraseIds[0], 'hotel_checkin_parcel');
  assert.equal(itemById('d3_move_hotel').phraseIds[0], 'hotel_luggage_parcel');
  assert.equal(itemById('d3_checkin_ssaw').phraseIds[0], 'hotel_checkin_parcel');
  assert.equal(itemById('d3_xuyan').phraseIds[0], 'food_xuyan');
  assert.equal(itemById('d5_to_airport').phraseIds[0], 'didi_airport_t2');
  // The four hotel-desk situations can be reached from the day 1 and the day 3 hotel items.
  for (const id of ['d1_checkin', 'd3_move_hotel']) {
    for (const need of ['hotel_parcel_count', 'hotel_parcel_waybill']) {
      assert.ok(itemById(id).phraseIds.includes(need), `${need} missing on ${id}`);
    }
  }
});
