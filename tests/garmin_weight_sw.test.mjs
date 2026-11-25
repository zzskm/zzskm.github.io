// garmin-weight 서비스 워커(sw.js)의 수명 주기와 캐시 동작 (P8 W2·W3, 재검토 FE5).
// 브라우저 없이 Cache API, Request/Response, fetch를 흉내 내어 sw.js를 그대로 실행한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const APP_DIR = new URL('../garmin-weight/', import.meta.url);
const SOURCE = readFileSync(new URL('sw.js', APP_DIR), 'utf8');
const INDEX_HTML = readFileSync(new URL('index.html', APP_DIR), 'utf8');
const ORIGIN = 'https://zzskm.github.io';
const SCOPE = `${ORIGIN}/garmin-weight/`;
const SW_URL = `${SCOPE}sw.js`;
const SUMMARY = `${SCOPE}data/summary.json`;
const CHART = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js';

class FakeHeaders {
  constructor(init) {
    this.map = new Map(init instanceof FakeHeaders ? init.map : Object.entries(init || {}).map(([k, v]) => [k.toLowerCase(), v]));
  }
  get(name) { return this.map.get(name.toLowerCase()) ?? null; }
  set(name, value) { this.map.set(name.toLowerCase(), value); }
}

class FakeResponse {
  constructor(body, { status = 200, ok, type = 'basic', statusText = '', headers } = {}) {
    this.body = body;
    this.status = status;
    this.ok = ok ?? (status >= 200 && status < 300);
    this.type = type;
    this.statusText = statusText;
    this.headers = new FakeHeaders(headers);
  }
  clone() { return new FakeResponse(this.body, this); }
  async blob() { return this.body; }
}

class FakeRequest {
  constructor(input, init = {}) {
    this.url = typeof input === 'string' ? new URL(input, SW_URL).toString() : input.url;
    this.method = 'GET';
    this.cache = init.cache || 'default';
    this.mode = init.mode || 'cors';
    this.credentials = init.credentials || 'same-origin';
  }
}

const keyOf = (request) => (typeof request === 'string' ? new URL(request, SW_URL).toString() : request.url);

class FakeCache {
  constructor(fetchImpl) { this.entries = new Map(); this.fetchImpl = fetchImpl; }
  async put(request, response) { this.entries.set(keyOf(request), response); }
  async match(request) { return this.entries.get(keyOf(request)); }
  async addAll(requests) {
    const responses = await Promise.all(requests.map((request) => this.fetchImpl(request)));
    if (responses.some((response) => !response.ok)) throw new TypeError('Request failed');
    requests.forEach((request, index) => this.entries.set(keyOf(request), responses[index]));
  }
}

// storage는 캐시 저장소(이름 → FakeCache)다. 넘겨주면 여러 워커(버전)가 같은 저장소를 쓴다.
function loadWorker(fetchImpl, { storage = new Map(), source = SOURCE } = {}) {
  const net = { fetch: fetchImpl };
  const requests = [];
  const listeners = {};
  const background = [];
  const doFetch = (request) => {
    requests.push(request);
    return net.fetch(request);
  };
  const context = {
    URL,
    console,
    Request: FakeRequest,
    Response: FakeResponse,
    Headers: FakeHeaders,
    caches: {
      async open(name) { if (!storage.has(name)) storage.set(name, new FakeCache(doFetch)); return storage.get(name); },
      async keys() { return [...storage.keys()]; },
      async delete(name) { return storage.delete(name); },
    },
    fetch: doFetch,
    self: {
      location: { origin: ORIGIN },
      registration: { scope: SCOPE },
      addEventListener(type, fn) { listeners[type] = fn; },
      async skipWaiting() {},
      clients: { async claim() {} },
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE === source ? SOURCE : source, context);
  const lifecycle = (type) => new Promise((resolve, reject) => {
    listeners[type]({ waitUntil(promise) { promise.then(resolve, reject); } });
  });
  const fetchThroughWorker = (url, { mode = 'cors' } = {}) => new Promise((resolve, reject) => {
    let handled = false;
    const request = new FakeRequest(url, { mode });
    listeners.fetch({
      request,
      respondWith(promise) { handled = true; promise.then(resolve, reject); },
      waitUntil(promise) { background.push(promise); },
    });
    if (!handled) resolve(null);
  });
  const read = (expression) => vm.runInContext(expression, context);
  const cache = (name) => storage.get(read(name));
  return {
    storage, requests, net, read, fetchThroughWorker,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    settle: () => Promise.all(background.splice(0)),
    shellCache: () => cache('SHELL_CACHE'),
    dataCache: () => cache('DATA_CACHE'),
    runtimeCache: () => cache('RUNTIME_CACHE'),
  };
}

const online = async (request) => new FakeResponse(`body of ${request.url}`, { type: request.url.startsWith(ORIGIN) ? 'basic' : 'cors' });
const offline = async () => { throw new TypeError('Failed to fetch'); };
const keys = (cache) => [...cache.entries.keys()].sort();

test('data requests are cached without their query, so reloads do not pile up', async () => {
  let n = 0;
  const worker = loadWorker(async (req) => new FakeResponse(`v${++n} ${req.url}`));
  for (let i = 0; i < 5; i += 1) {
    await worker.fetchThroughWorker(`${SUMMARY}?ts=${1000 + i}`);
    await worker.fetchThroughWorker(`${SCOPE}config.json?ts=${1000 + i}`);
  }
  assert.deepEqual(keys(worker.dataCache()), [`${SCOPE}config.json`, SUMMARY]);
});

test('offline falls back to the most recently fetched summary, not the first one', async () => {
  let generation = 0;
  const worker = loadWorker(async () => new FakeResponse(`generatedAt=2030-0${++generation}-01`));
  for (let i = 0; i < 3; i += 1) await worker.fetchThroughWorker(`${SUMMARY}?ts=${i}`);
  worker.net.fetch = offline;
  const fallback = await worker.fetchThroughWorker(`${SUMMARY}?ts=99`);
  assert.equal(fallback.body, 'generatedAt=2030-03-01');
  assert.equal(fallback.headers.get('X-GW-From-Cache'), '1');
});

test('CORS responses from the CDN are stored in the runtime cache; opaque ones are not', async () => {
  const worker = loadWorker(async (req) => (req.url.includes('opaque')
    ? new FakeResponse('x', { ok: false, status: 0, type: 'opaque' })
    : new FakeResponse('chart', { type: 'cors' })));
  await worker.fetchThroughWorker(CHART);
  await worker.fetchThroughWorker('https://cdn.jsdelivr.net/opaque.js');
  assert.deepEqual(keys(worker.runtimeCache()), [CHART]);
});

test('install stores the shell past the HTTP cache and precaches the summary, the config and the CDN assets', async () => {
  const worker = loadWorker(online);
  await worker.install();
  // vm 컨텍스트의 배열은 프로토타입이 달라 deepEqual에 걸리므로 이쪽 배열로 옮긴다.
  const shell = Array.from(worker.read('SHELL_ASSETS'), (path) => new URL(path, SW_URL).toString()).sort();
  assert.equal(shell.length, 13);
  assert.deepEqual(keys(worker.shellCache()), shell);
  // Pages는 max-age=600이다. 셸을 HTTP 캐시에서 받으면 배포 직후의 설치가 예전 index.html을 새 캐시에 넣는다.
  const shellRequests = worker.requests.filter((request) => shell.includes(request.url));
  assert.equal(shellRequests.length, 13);
  assert.ok(shellRequests.every((request) => request.cache === 'reload'));
  // 첫 방문의 요청은 워커가 맡기 전에 나간다. 미리 받아 두지 않으면 한 번 방문한 직후의 오프라인에는 요약도 차트도 없다.
  assert.deepEqual(keys(worker.dataCache()), [`${SCOPE}config.json`, SUMMARY]);
  assert.deepEqual(keys(worker.runtimeCache()), [...worker.read('CDN_ASSETS')].sort());
  assert.equal(worker.requests.find((request) => request.url === SUMMARY).cache, 'no-store');
  assert.equal(worker.requests.find((request) => request.url === CHART).mode, 'cors');
});

test('install finishes without the optional precache but fails when a shell file is missing', async () => {
  const flaky = loadWorker(async (request) => {
    if (request.url === SUMMARY || !request.url.startsWith(ORIGIN)) throw new TypeError('Failed to fetch');
    return new FakeResponse('ok');
  });
  await flaky.install();
  assert.equal(flaky.shellCache().entries.size, 13);
  assert.deepEqual(keys(flaky.dataCache()), [`${SCOPE}config.json`]);
  assert.equal(flaky.runtimeCache().entries.size, 0);

  const broken = loadWorker(async (request) => new FakeResponse('x', { status: request.url.includes('app.js') ? 404 : 200 }));
  await assert.rejects(broken.install());
});

test('every shell asset exists on disk and matches what index.html loads', () => {
  const worker = loadWorker(online);
  const shell = Array.from(worker.read('SHELL_ASSETS'));
  for (const path of shell) {
    const file = path.split('?')[0].replace(/^\.\//, '') || 'index.html';
    assert.ok(existsSync(new URL(file, APP_DIR)), `${path} is listed in SHELL_ASSETS but ${file} does not exist`);
  }
  const version = worker.read('ASSET_VERSION');
  const local = [...INDEX_HTML.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((match) => match[1]).filter((url) => url !== './sw.js');
  assert.ok(local.length >= 7);
  const listed = new Set(shell.map((path) => path.replace('${ASSET_VERSION}', version)));
  for (const url of local) assert.ok(listed.has(url), `${url} is loaded by index.html but not precached`);
  for (const url of worker.read('CDN_ASSETS')) assert.ok(INDEX_HTML.includes(`"${url}"`), `${url} is precached but index.html does not load it`);
});

test('activate removes this app\'s old caches and leaves other apps alone', async () => {
  const worker = loadWorker(online);
  await worker.install();
  for (const name of ['gw-20261125f-shell', 'gw-20261125f-data', 'gw-20261125f-runtime', 'gw-v11-shell', 'bus-arrival-v3', 'trip-china-offline']) {
    await (await worker.read('caches').open(name)).put(`${ORIGIN}/x`, new FakeResponse('x'));
  }
  await worker.activate();
  // 캐시 저장소는 출처 전체가 함께 쓴다. 예전 워커는 이름이 다른 캐시를 모두 지워 다른 앱의 캐시까지 지웠다.
  assert.deepEqual([...worker.storage.keys()].sort(),
    ['bus-arrival-v3', worker.read('DATA_CACHE'), worker.read('RUNTIME_CACHE'), worker.read('SHELL_CACHE'), 'trip-china-offline'].sort());
});

test('a version bump keeps the offline summary, the CDN assets and the fonts', async () => {
  const FONT = 'https://fonts.gstatic.com/s/jetbrainsmono/v20/font.woff2';
  const storage = new Map();
  const before = loadWorker(online, { storage });
  await before.install();
  await before.activate();
  await before.fetchThroughWorker(`${SUMMARY}?ts=1`);
  await before.fetchThroughWorker(FONT);  // 미리 받는 목록에 없고 쓰일 때 저장되는 자산
  const oldShell = before.read('SHELL_CACHE');

  const bumped = SOURCE.replace(/const ASSET_VERSION = '[^']+';/, "const ASSET_VERSION = 'next';");
  assert.notEqual(bumped, SOURCE);
  // 새 버전이 설치되는 순간에는 요약과 CDN을 받지 못했다고 하자. 예전에는 버전을 올리면 data·runtime 캐시가
  // 이름째 지워져서, 이런 경우 오프라인에서 보여 줄 것이 없었다.
  const after = loadWorker(async (request) => {
    if (request.url === SUMMARY) return new FakeResponse('down', { status: 503 });
    if (!request.url.startsWith(ORIGIN)) throw new TypeError('Failed to fetch');
    return online(request);
  }, { storage, source: bumped });
  await after.install();
  await after.activate();
  assert.equal(storage.has(oldShell), false);
  assert.ok(storage.has(after.read('SHELL_CACHE')));

  after.net.fetch = offline;
  const summary = await after.fetchThroughWorker(`${SUMMARY}?ts=2`);
  assert.deepEqual([summary.body, summary.ok, summary.headers.get('X-GW-From-Cache')], [`body of ${SUMMARY}?ts=1`, true, '1']);
  assert.equal((await after.fetchThroughWorker(CHART)).body, `body of ${CHART}`);
  assert.equal((await after.fetchThroughWorker(FONT)).body, `body of ${FONT}`);
});

test('a 404 or 5xx for the summary is replaced by the stored copy, and passed through when there is none', async () => {
  const worker = loadWorker(async () => new FakeResponse('good summary'));
  await worker.fetchThroughWorker(`${SUMMARY}?ts=1`);
  for (const status of [404, 500, 503]) {
    worker.net.fetch = async () => new FakeResponse('error page', { status });
    const response = await worker.fetchThroughWorker(`${SUMMARY}?ts=2`);
    assert.deepEqual([response.body, response.ok, response.headers.get('X-GW-From-Cache')], ['good summary', true, '1'], `status ${status}`);
  }
  // 실패한 응답이 저장된 사본을 덮지 않는다.
  assert.equal((await worker.dataCache().match(SUMMARY)).body, 'good summary');

  const empty = loadWorker(async () => new FakeResponse('error page', { status: 404 }));
  const passed = await empty.fetchThroughWorker(`${SUMMARY}?ts=1`);
  assert.deepEqual([passed.status, passed.ok, passed.headers.get('X-GW-From-Cache')], [404, false, null]);
  await assert.rejects(loadWorker(offline).fetchThroughWorker(`${SUMMARY}?ts=1`), /Failed to fetch/);
});

test('fresh summaries are not marked as cached', async () => {
  const worker = loadWorker(async () => new FakeResponse('fresh'));
  const response = await worker.fetchThroughWorker(`${SUMMARY}?ts=1`);
  assert.equal(response.headers.get('X-GW-From-Cache'), null);
});

test('offline visits with a query string still get the app shell', async () => {
  const worker = loadWorker(online);
  await worker.install();
  const stored = keys(worker.shellCache());
  worker.net.fetch = offline;
  for (const url of [SCOPE, `${SCOPE}?utm_source=x`, `${SCOPE}index.html`, `${SCOPE}index.html?x=1`]) {
    const response = await worker.fetchThroughWorker(url, { mode: 'navigate' });
    assert.ok(response && response.ok, url);
    assert.match(response.body, /garmin-weight\/(index\.html)?$/, url);
  }
  await worker.settle();
  assert.deepEqual(keys(worker.shellCache()), stored, 'query variants are not stored');
});

test('a shell file that is neither cached nor reachable fails instead of answering with nothing', async () => {
  const worker = loadWorker(offline);
  const version = worker.read('ASSET_VERSION');
  await assert.rejects(worker.fetchThroughWorker(`${SCOPE}app.js?v=${version}`), /Failed to fetch/);
  await assert.rejects(worker.fetchThroughWorker(`${SCOPE}?x=1`, { mode: 'navigate' }), /Failed to fetch/);
});

test('the shell is served from the cache and refreshed past the HTTP cache', async () => {
  const worker = loadWorker(async () => new FakeResponse('old page'));
  await worker.install();
  worker.net.fetch = async () => new FakeResponse('new page');
  const seen = worker.requests.length;
  const first = await worker.fetchThroughWorker(SCOPE, { mode: 'navigate' });
  assert.equal(first.body, 'old page');
  await worker.settle();
  // 재검증을 요구하지 않으면 배포 뒤 10분 동안 HTTP 캐시의 예전 파일로 셸 캐시를 다시 덮는다.
  const refresh = worker.requests.slice(seen);
  assert.deepEqual(refresh.map((request) => [request.url, request.cache]), [[SCOPE, 'no-cache']]);
  assert.equal((await worker.fetchThroughWorker(SCOPE, { mode: 'navigate' })).body, 'new page');
});

test('other files in the folder and old asset versions are left to the browser', async () => {
  const worker = loadWorker(online);
  await worker.install();
  const seen = worker.requests.length;
  for (const [url, mode] of [[`${SCOPE}data/daily_metrics.csv`, 'navigate'], [`${SCOPE}README.md`, 'navigate'],
    [`${SCOPE}app.js?v=20200101a`, 'cors'], [`${ORIGIN}/dashboard.html`, 'navigate'], [`${ORIGIN}/bus-arrival/data/latest.json`, 'cors']]) {
    assert.equal(await worker.fetchThroughWorker(url, { mode }), null, url);
  }
  assert.equal(worker.requests.length, seen);
});
