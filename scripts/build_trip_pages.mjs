#!/usr/bin/env node
// Single source for the December 2026 trip pages.
//
//   node scripts/build_trip_pages.mjs           regenerate the HTML files
//   node scripts/build_trip_pages.mjs --check   fail if a file is out of date
//
// The shared page shell lives in scripts/trip_page.template.html. Only the
// per-page copy below differs between Japan and China, so a shell change is
// made once in the template and both pages are rebuilt together. Run the build
// after editing the template or this config, then commit the generated HTML.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "scripts", "trip_page.template.html");

const PAGES = [
  {
    file: "trip_2026_dec_japan.html",
    title: "12월 일본 처방 여행",
    metaDescription:
      "마운자로 처방을 넣은 2026년 12월 후쿠오카·오사카·도쿄·쓰시마 금요일 밤 포함 여행 일정과 1인 평균 견적",
    ogTitle: "12월 일본 처방 여행",
    ogDescription: "후쿠오카·오사카·도쿄·쓰시마 4개 도시 비교, 1인 평균 견적",
    dataSrc: "trip_2026_dec_japan.data.js",
    h1: "12월 일본 처방 여행 · 후쿠오카 / 오사카 / 도쿄 / 쓰시마",
    intro:
      '금요일 밤을 끼고 떠나 마운자로를 처방받는 일정과 예상 비용입니다. 처방 전에는 캡슐·도미토리·게하, 처방받은 날부터는 2인 1실에 묵고, 시장·관청 식당 같은 이색 식사와 가벼운 관광을 넣었습니다. 카드를 바꾸면 일정과 금액이 바로 바뀝니다. 가격은 <span id="head-asof">2026-11-13</span> 기준 추정치입니다.',
    otherHref: "trip_2026_dec_china.html",
    otherLabel: "중국 · 칭다오 / 톈진 / 상하이 / 다롄 / 웨이하이 / 옌타이",
    costNote:
      "인원·일정·시기·환율은 공통, 나머지는 각 도시에서 고른 카드 기준입니다. 도시 이름을 누르면 그 도시로 전환합니다. 용량·수량이 다르면 총액보다 ‘1개월분당’으로 비교하세요.",
  },
  {
    file: "trip_2026_dec_china.html",
    title: "12월 중국 처방 여행",
    metaDescription:
      "마운자로 처방을 넣은 2026년 12월 칭다오·톈진·상하이·다롄·웨이하이·옌타이 금요일 밤 포함 여행 일정과 1인 평균 견적",
    ogTitle: "12월 중국 처방 여행",
    ogDescription: "칭다오·톈진·상하이·다롄·웨이하이·옌타이 6개 도시 비교, 1인 평균 견적",
    dataSrc: "trip_2026_dec_china.data.js",
    h1: "12월 중국 처방 여행 · 칭다오 / 톈진 / 상하이 / 다롄 / 웨이하이 / 옌타이",
    intro:
      '금요일 밤을 끼고 떠나 마운자로를 처방받는 일정과 예상 비용입니다. 중국 6개 도시를 같은 조건으로 비교합니다. 처방 전에는 캡슐·도미토리·게하, 처방받은 날부터는 2인 1실에 묵고, 시장·관청 식당 같은 이색 식사와 가벼운 관광을 넣었습니다. 카드를 바꾸면 일정과 금액이 바로 바뀝니다. 가격은 <span id="head-asof">2026-11-13</span> 기준 추정치입니다.',
    otherHref: "trip_2026_dec_japan.html",
    otherLabel: "일본 · 후쿠오카 / 오사카 / 도쿄 / 쓰시마",
    costNote:
      "인원·일정·시기·환율은 공통, 나머지는 각 도시에서 고른 카드 기준입니다. 도시 이름을 누르면 그 도시로 전환합니다. 총액보다 ‘1개월분당’으로 비교하세요(중국 펜은 4주분이라 24주 = 6개월분).",
  },
];

const PLACEHOLDER_TO_KEY = {
  TITLE: "title",
  META_DESCRIPTION: "metaDescription",
  OG_TITLE: "ogTitle",
  OG_DESCRIPTION: "ogDescription",
  DATA_SRC: "dataSrc",
  H1: "h1",
  INTRO: "intro",
  OTHER_HREF: "otherHref",
  OTHER_LABEL: "otherLabel",
  COST_NOTE: "costNote",
};

function render(page) {
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  return tpl.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    const key = PLACEHOLDER_TO_KEY[name];
    if (!key) throw new Error(`Unknown placeholder {{${name}}}`);
    return page[key];
  });
}

const check = process.argv.includes("--check");
let drift = 0;

for (const page of PAGES) {
  const out = render(page);
  const dest = path.join(ROOT, page.file);
  if (check) {
    const current = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
    if (current === out) {
      console.log(`ok       ${page.file}`);
    } else {
      drift += 1;
      console.error(`STALE    ${page.file} (run: node scripts/build_trip_pages.mjs)`);
    }
  } else {
    fs.writeFileSync(dest, out);
    console.log(`wrote    ${page.file} (${out.length} bytes)`);
  }
}

if (check && drift > 0) {
  console.error(`\n${drift} page(s) out of date.`);
  process.exit(1);
}