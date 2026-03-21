const CACHE_NAME = "trancy-shell-v2";
const PRECACHE_ASSETS = [
  "/styles.css",
  "/manifest.webmanifest",
  "/icons/app-icon.svg",
  "/icons/app-icon-512.png",
  "/icons/apple-touch-icon.png"
];
const NETWORK_FIRST_PATHS = new Set(["/", "/index.html", "/app.js", "/styles.css"]);

function isCacheableResponse(response) {
  return response && response.ok && response.type !== "opaque";
}

function normalizePathname(url) {
  if (url.pathname === "") {
    return "/";
  }

  return url.pathname;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (isCacheableResponse(response)) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  if (isCacheableResponse(response)) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  const pathname = normalizePathname(url);
  const isNavigationRequest = request.mode === "navigate";

  if (isNavigationRequest || NETWORK_FIRST_PATHS.has(pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
