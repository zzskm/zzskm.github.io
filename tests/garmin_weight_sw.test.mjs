// garmin-weight 서비스 워커(sw.js)의 캐시 동작 (P8 W2, W3).
// 브라우저 없이 Cache API와 fetch를 흉내 내어 sw.js를 그대로 실행한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../garmin-weight/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://zzskm.github.io';
const SCOPE = `${ORIGIN}/garmin-weight/`;

class FakeResponse {
  constructor(body, { ok = true, type = 'basic' } = {}) { this.body = body; this.ok = ok; this.type = type; }
  clone() { return new FakeResponse(this.body, { ok: this.ok, type: this.type }); }
}

class FakeCache {
  constructor() { this.entries = new Map(); }
  static key(request) { return typeof request === 'string' ? request : request.url; }
  async put(request, response) { this.entries.set(FakeCache.key(request), response); }
  async match(request, options = {}) {
    const key = FakeCache.key(request);
    if (this.entries.has(key)) return this.entries.get(key);
    if (options.ignoreSearch) {
      const bare = key.split('?')[0];
      for (const [k, v] of this.entries) if (k.split('?')[0] === bare) return v;
    }
    return undefined;
  }
  async addAll() {}
}

function loadWorker(fetchImpl) {
  const caches = new Map();
  const listeners = {};
  const context = {
    URL,
    console,
    caches: {
      async open(name) { if (!caches.has(name)) caches.set(name, new FakeCache()); return caches.get(name); },
      async keys() { return [...caches.keys()]; },
      async delete(name) { return caches.delete(name); },
    },
    fetch: (request) => fetchImpl(request),
    self: {
      location: { origin: ORIGIN },
      registration: { scope: SCOPE },
      addEventListener(type, fn) { listeners[type] = fn; },
      skipWaiting() {},
      clients: { claim() {} },
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  const request = (url) => ({ url, method: 'GET' });
  const fetchThroughWorker = (url) => new Promise((resolve, reject) => {
    let handled = false;
    listeners.fetch({ request: request(url), respondWith(promise) { handled = true; promise.then(resolve, reject); } });
    if (!handled) resolve(null);
  });
  const version = vm.runInContext('CACHE_VERSION', context);
  return { caches, fetchThroughWorker, dataCache: () => caches.get(`${version}-data`), runtimeCache: () => caches.get(`${version}-runtime`) };
}

test('data requests are cached without their query, so reloads do not pile up', async () => {
  let n = 0;
  const worker = loadWorker(async (req) => new FakeResponse(`v${++n} ${req.url}`));
  for (let i = 0; i < 5; i += 1) {
    await worker.fetchThroughWorker(`${SCOPE}data/summary.json?ts=${1000 + i}`);
    await worker.fetchThroughWorker(`${SCOPE}config.json?ts=${1000 + i}`);
  }
  assert.deepEqual([...worker.dataCache().entries.keys()].sort(), [`${SCOPE}config.json`, `${SCOPE}data/summary.json`]);
});

test('offline falls back to the most recently fetched summary, not the first one', async () => {
  let online = true;
  let generation = 0;
  const worker = loadWorker(async () => {
    if (!online) throw new TypeError('offline');
    generation += 1;
    return new FakeResponse(`generatedAt=2030-0${generation}-01`);
  });
  for (let i = 0; i < 3; i += 1) await worker.fetchThroughWorker(`${SCOPE}data/summary.json?ts=${i}`);
  online = false;
  const fallback = await worker.fetchThroughWorker(`${SCOPE}data/summary.json?ts=99`);
  assert.equal(fallback.body, 'generatedAt=2030-03-01');
});

test('CORS responses from the CDN are stored in the runtime cache; opaque ones are not', async () => {
  const worker = loadWorker(async (req) => (req.url.includes('opaque')
    ? new FakeResponse('x', { ok: false, type: 'opaque' })
    : new FakeResponse('chart', { ok: true, type: 'cors' })));
  await worker.fetchThroughWorker('https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js');
  await worker.fetchThroughWorker('https://cdn.jsdelivr.net/opaque.js');
  assert.deepEqual([...worker.runtimeCache().entries.keys()], ['https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js']);
});
