'use strict';

// 자산 버전은 여기 한 곳에서 정한다. index.html과 manifest의 ?v= 값이 이것과 같아야 한다
// (tests/test_garmin_weight.py가 검사한다). 자산을 바꾸면 이 값을 올린다. 셸 캐시 이름만 이 값에서 나온다.
const ASSET_VERSION = '20261125i';
const CACHE_PREFIX = 'gw-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${ASSET_VERSION}`;
// 요약·설정(data)과 CDN 자산(runtime)의 캐시는 버전을 올려도 남긴다. 버전과 함께 지우면 버전을 올린 직후의
// 오프라인에서 보여 줄 요약이 없다(재검토 FE5). CDN 주소는 스스로 버전을 가진다. 형식이 바뀔 때만 숫자를 올린다.
const DATA_CACHE = `${CACHE_PREFIX}data-v1`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-v1`;
const CURRENT_CACHES = [SHELL_CACHE, DATA_CACHE, RUNTIME_CACHE];

const INDEX_URL = './index.html';
const SHELL_ASSETS = [
  './',
  INDEX_URL,
  `./app.helpers.js?v=${ASSET_VERSION}`,
  `./app.js?v=${ASSET_VERSION}`,
  `./style.css?v=${ASSET_VERSION}`,
  `./enhancements.js?v=${ASSET_VERSION}`,
  `./manifest.webmanifest?v=${ASSET_VERSION}`,
  `./icons/icon.svg?v=${ASSET_VERSION}`,
  `./icons/icon-maskable.svg?v=${ASSET_VERSION}`,
  `./icons/icon-192.png?v=${ASSET_VERSION}`,
  `./icons/icon-512.png?v=${ASSET_VERSION}`,
  `./icons/icon-maskable-512.png?v=${ASSET_VERSION}`,
  `./icons/apple-touch-icon-180.png?v=${ASSET_VERSION}`,
];
// 설치할 때 미리 받아 두는 것. 첫 방문의 요청은 워커가 맡기 전에 나가므로, 미리 받지 않으면 한 번 방문한 직후의
// 오프라인에서 요약도 차트도 없다. 받지 못해도 설치는 계속한다.
const DATA_ASSETS = ['./data/summary.json', './config.json'];
// index.html이 쓰는 주소와 글자 하나까지 같아야 한다(tests/garmin_weight_sw.test.mjs가 검사한다).
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js',
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css',
];
// 캐시에서 꺼낸 요약에 붙이는 표시. 화면이 "오프라인 사본"이라고 알린다.
const FROM_CACHE_HEADER = 'X-GW-From-Cache';

const scopeUrl = (path) => new URL(path, self.registration.scope).toString();
const scopePath = () => new URL(self.registration.scope).pathname;

async function precacheOptional() {
  const data = await caches.open(DATA_CACHE);
  const runtime = await caches.open(RUNTIME_CACHE);
  const jobs = [
    ...DATA_ASSETS.map(async (path) => {
      const url = scopeUrl(path);
      const res = await fetch(new Request(url, { cache: 'no-store' }));
      if (res && res.ok) await data.put(url, res);
    }),
    ...CDN_ASSETS.map(async (url) => {
      if (await runtime.match(url)) return;
      // 페이지는 crossorigin="anonymous"와 integrity로 받는다. 같은 방식(CORS, 자격 증명 없음)으로 받아야 그 응답을 쓸 수 있다.
      const res = await fetch(new Request(url, { mode: 'cors', credentials: 'omit' }));
      if (res && res.ok) await runtime.put(url, res);
    }),
  ];
  await Promise.all(jobs.map((job) => job.catch(() => undefined)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // HTTP 캐시를 거치지 않고 받는다. Pages는 max-age=600이라, 거치면 배포 직후 10분 동안 예전 index.html이
    // 새 셸 캐시에 들어가 그 뒤의 방문이 계속 예전 화면을 본다.
    await shell.addAll(SHELL_ASSETS.map((url) => new Request(url, { cache: 'reload' })));
    await precacheOptional();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // 이 앱의 예전 캐시만 지운다. 캐시 저장소는 출처(zzskm.github.io) 전체가 함께 쓰므로 다른 앱의 캐시는 건드리지 않는다.
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.includes(key))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function inScope(url) {
  return url.origin === self.location.origin && url.pathname.startsWith(scopePath());
}

function isDataRequest(url) {
  if (!inScope(url)) return false;
  const rest = url.pathname.slice(scopePath().length);
  return rest === 'config.json' || (rest.startsWith('data/') && rest.endsWith('.json'));
}

function isFontOrChartCDN(url) {
  return url.hostname === 'fonts.googleapis.com'
    || url.hostname === 'fonts.gstatic.com'
    || url.hostname === 'cdn.jsdelivr.net';
}

let shellUrls = null;

// 셸 캐시의 키. 셸이 아니면 null이다(이 폴더의 CSV나 문서 같은 다른 파일은 워커가 맡지 않는다).
// 화면 자체(폴더 주소와 index.html)는 쿼리가 붙어 와도 같은 화면이므로 쿼리를 뗀 주소가 키다.
function shellKey(req, url) {
  if (!inScope(url)) return null;
  if (url.pathname === scopePath() || url.pathname === `${scopePath()}index.html`) return cacheKey(req);
  if (!shellUrls) shellUrls = new Set(SHELL_ASSETS.map(scopeUrl));
  return shellUrls.has(req.url) ? req.url : null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isDataRequest(url)) {
    event.respondWith(networkFirst(req));
    return;
  }

  const key = shellKey(req, url);
  if (key) {
    event.respondWith(staleWhileRevalidate(event, key));
    return;
  }

  if (isFontOrChartCDN(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }
});

// W2: 앱은 summary.json?ts=…로 요청한다. 쿼리를 뗀 URL을 키로 써서 항목이 쌓이지 않게 하고,
// 오프라인일 때는 마지막으로 받은 것을 돌려준다(예전에는 가장 처음 저장한 것이 나왔다).
function cacheKey(req) {
  const url = new URL(req.url);
  url.search = '';
  return url.toString();
}

async function markFromCache(res) {
  const headers = new Headers(res.headers);
  headers.set(FROM_CACHE_HEADER, '1');
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

// 요약과 설정: 네트워크 먼저. 네트워크가 안 되거나 응답이 정상이 아니면(404·5xx) 마지막으로 받은 사본을 준다.
async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  const key = cacheKey(req);
  let fresh = null;
  let failure = null;
  try {
    fresh = await fetch(req);
  } catch (err) {
    failure = err;
  }
  if (fresh && fresh.ok) {
    await cache.put(key, fresh.clone());
    return fresh;
  }
  const cached = await cache.match(key);
  if (cached) return markFromCache(cached);
  if (fresh) return fresh;
  throw failure;
}

// 셸: 캐시에 있으면 바로 주고 뒤에서 새로 받아 둔다. 새로 받을 때는 HTTP 캐시에 재검증을 요구한다(no-cache).
// 그러지 않으면 배포 뒤 10분 동안 HTTP 캐시의 예전 파일로 셸 캐시를 다시 덮는다.
async function staleWhileRevalidate(event, key) {
  const req = event.request;
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(key);
  const refresh = fetch(new Request(req.url, { cache: 'no-cache' }))
    .then(async (res) => {
      if (res && res.ok) await cache.put(key, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const fresh = await refresh;
  if (fresh) return fresh;
  // 캐시에도 없고 네트워크도 안 된다. 원래 요청을 그대로 보내 브라우저의 오류가 나오게 한다.
  // 예전에는 여기서 null로 응답해 쿼리가 붙은 주소의 오프라인 방문이 ERR_FAILED가 됐다.
  return fetch(req);
}

// W3: CDN 자산은 crossorigin으로 받으므로 응답이 불투명하지 않고(ok) 여기에 저장된다.
async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}
