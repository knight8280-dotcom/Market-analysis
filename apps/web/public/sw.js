/*
 * Market Analysis service worker (spec §6, ADR-037).
 *
 * Pages always come from the network. When a page cannot be loaded (this device is offline, or
 * the computer running the app cannot be reached), the worker answers with a small offline page
 * built here. Nothing the app shows is cached: the only thing stored is the time a page last
 * loaded (a full load, or a page the app reports showing), so the offline page can say how old
 * the last view on this device is. Requests other than page loads (data, live updates, scripts)
 * are left alone.
 */
const VERSION = "v1";
const META_CACHE = `market-analysis-meta-${VERSION}`;
const LAST_LOADED = "/__sw/last-loaded";
// Kept in step with apps/web/src/brand.ts; e2e/pwa.spec.ts checks the offline page's title.
const BRAND = "Market Analysis";

self.addEventListener("install", () => {
  // Nothing to fetch ahead: the offline page is built on demand.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== META_CACHE) await caches.delete(key);
      }
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
      // The page that installed this worker has just loaded.
      await rememberLoad();
    })(),
  );
});

// The app reports each page it shows (soft navigations load data without a page load).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "page-shown") event.waitUntil(rememberLoad());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  event.respondWith(loadPage(event));
});

async function loadPage(event) {
  try {
    const response = (await event.preloadResponse) || (await fetch(event.request));
    if (response.ok) event.waitUntil(rememberLoad());
    return response;
  } catch {
    return offlinePage(event.request.url, await lastLoaded());
  }
}

async function rememberLoad() {
  const cache = await caches.open(META_CACHE);
  await cache.put(LAST_LOADED, new Response(new Date().toISOString()));
}

async function lastLoaded() {
  try {
    const hit = await (await caches.open(META_CACHE)).match(LAST_LOADED);
    const at = hit ? new Date(await hit.text()) : null;
    return at && !Number.isNaN(at.getTime()) ? at : null;
  } catch {
    return null;
  }
}

function formatET(at) {
  const text = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(at);
  return `${text} ET`;
}

function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function offlinePage(url, loadedAt) {
  const target = new URL(url);
  const retry = escapeHtml(target.pathname + target.search);
  const last = loadedAt
    ? `A page last loaded on this device at ${escapeHtml(formatET(loadedAt))}.`
    : "No page has loaded on this device yet.";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Offline · ${BRAND}</title>
<style>
:root { color-scheme: dark; --bg: #0d1117; --fg: #f0f6fc; --muted: #9198a1; --link: #4493f8; }
@media (prefers-color-scheme: light) {
  :root { color-scheme: light; --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --link: #0969da; }
}
body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
  box-sizing: border-box; padding: 24px; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 32rem; }
h1 { margin: 0 0 8px; font-size: 1.25rem; }
p { margin: 8px 0; }
.muted { color: var(--muted); font-size: 0.875rem; }
a { display: inline-flex; align-items: center; min-height: 44px; color: var(--link); }
a:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>You're offline</h1>
<p>${BRAND} can't be reached from this device right now. It runs on your computer: check that this device is online (and on Tailscale when you are away from home) and that the computer is on.</p>
<p class="muted">${last} Nothing from the app is kept offline.</p>
<p><a href="${retry}">Try again</a></p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
