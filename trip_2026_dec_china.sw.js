/* trip_2026_dec_china.sw.js - offline copy of the Shanghai trip page.

   Network first: while online every load fetches the current files and refreshes the copy,
   so an edit that was pushed is never hidden behind an old cache. The copy is only served
   when the network fails or does not answer within NETWORK_TIMEOUT_MS (weak roaming signal).
   Every file is handed to the page marked "no-cache" (see forPage), so a reload of an open tab
   asks this worker again instead of reusing what the browser still holds in memory.

   The page registers this worker with the scope "./trip_2026_dec_china", a URL prefix that
   matches only the Shanghai page, so no other page of the site is controlled by it. */
"use strict";

// Raise this when a file is added to or removed from ASSETS. Older caches are deleted on activate.
const CACHE_NAME = "trip-china-v2";
const CACHE_PREFIX = "trip-china-";
const NETWORK_TIMEOUT_MS = 3000;
// After one timeout the rest of that page load is answered from the copy straight away, so a hanging
// network costs one wait instead of one per file, and the page is drawn from one consistent set of files.
const SLOW_WINDOW_MS = 20000;
let slowUntil = 0;

const PAGE = "trip_2026_dec_china.html";
const ASSETS = [
  PAGE,
  "trip_2026_dec.styles.css",
  "trip_2026_dec_china.styles.css",
  "trip_2026_dec_china.data.js",
  "trip_2026_dec_china.field.js",
  "favicon.svg",
];

const assetUrl = (name) => new URL(name, self.location).href;
const ASSET_URLS = new Set(ASSETS.map(assetUrl));
const PAGE_URL = assetUrl(PAGE);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((name) => new Request(assetUrl(name), { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The cache key is the file URL without its query string. A page load (with or without ".html") maps to the page.
function cacheKeyFor(request) {
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  if (ASSET_URLS.has(url.href)) return url.href;
  if (request.mode === "navigate" && url.href === PAGE_URL.replace(/\.html$/, "")) return PAGE_URL;
  return null;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;
  const key = cacheKeyFor(request);
  if (!key) return; // not one of this page's files: the browser handles it as usual
  event.respondWith(networkFirst(event, key));
});

// What the page receives is marked "no-cache". A browser keeps a file it has just loaded in memory and, on a
// reload, reuses it for as long as the server's max-age allows (10 minutes on GitHub Pages) without asking this
// worker, so a pushed edit would stay hidden on a tab that is already open. The body is the decoded file, so
// the transfer headers of the original answer do not apply to it.
function forPage(response, body) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-cache");
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

async function fromCopy(cache, key) {
  const cached = await cache.match(key);
  return cached ? forPage(cached, await cached.blob()) : null;
}

async function networkFirst(event, key) {
  const cache = await caches.open(CACHE_NAME);
  // "no-cache" revalidates with the server, so the browser's own HTTP cache cannot serve an old file either.
  // The whole file is read before it counts as an answer: a connection that stalls half-way is treated as slow.
  const fromNetwork = fetch(key, { cache: "no-cache" }).then(async (response) => {
    if (!response || !response.ok) return response;
    const body = await response.blob();
    await cache.put(key, forPage(response, body));
    return forPage(response, body);
  });
  // A slow answer still refreshes the copy after the cached one has been shown.
  event.waitUntil(fromNetwork.catch(() => undefined));

  if (Date.now() < slowUntil) {
    const cached = await fromCopy(cache, key);
    if (cached) return cached;
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([fromNetwork, timeout]);
    if (response && response.ok) return response;
    if (!response) slowUntil = Date.now() + SLOW_WINDOW_MS;
    const cached = await fromCopy(cache, key);
    if (cached) return cached;
    // Nothing saved yet: wait for the network however long it takes.
    return response || (await fromNetwork);
  } catch (err) {
    const cached = await fromCopy(cache, key);
    if (cached) return cached;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
