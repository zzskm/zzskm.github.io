'use strict';

// 자산 버전은 여기 한 곳에서 정한다. index.html과 manifest의 ?v= 값이 이것과 같아야 한다
// (tests/test_garmin_weight.py가 검사한다). 자산을 바꾸면 이 값을 올린다. 캐시 이름도 이 값에서 나온다.
const ASSET_VERSION = '20261125f';
const CACHE_VERSION = `gw-${ASSET_VERSION}`;
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const SHELL_ASSETS = [
  './',
  './index.html',
  `./app.helpers.js?v=${ASSET_VERSION}`,
  `./app.js?v=${ASSET_VERSION}`,
  `./style.css?v=${ASSET_VERSION}`,
  `./enhancements.js?v=${ASSET_VERSION}`,
  './config.json',
  `./manifest.webmanifest?v=${ASSET_VERSION}`,
  `./icons/icon.svg?v=${ASSET_VERSION}`,
  `./icons/icon-maskable.svg?v=${ASSET_VERSION}`,
  `./icons/icon-192.png?v=${ASSET_VERSION}`,
  `./icons/icon-512.png?v=${ASSET_VERSION}`,
  `./icons/icon-maskable-512.png?v=${ASSET_VERSION}`,
  `./icons/apple-touch-icon-180.png?v=${ASSET_VERSION}`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isDataRequest(url) {
  return url.pathname.includes('/garmin-weight/data/') && url.pathname.endsWith('.json');
}

function isShellRequest(url) {
  return url.origin === self.location.origin && url.pathname.startsWith(self.registration.scope.replace(self.location.origin, ''));
}

function isFontOrChartCDN(url) {
  return url.hostname === 'fonts.googleapis.com'
    || url.hostname === 'fonts.gstatic.com'
    || url.hostname === 'cdn.jsdelivr.net';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isDataRequest(url) || url.pathname.endsWith('/config.json')) {
    event.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }

  if (isShellRequest(url)) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  if (isFontOrChartCDN(url)) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
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

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const key = cacheKey(req);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) await cache.put(key, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || networkPromise || fetch(req);
}

// W3: CDN 자산은 crossorigin으로 받으므로 응답이 불투명하지 않고(ok) 여기에 저장된다.
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}
