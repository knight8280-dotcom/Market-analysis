/**
 * Every page and API route, with a sample URL. `test/routes.test.ts` fails when a route is added
 * under src/app without being listed here, so the session check in shell.spec.ts covers it.
 */
export const PAGE_ROUTES: Record<string, string> = {
  "/": "/",
  "/admin/data-health": "/admin/data-health",
  "/alerts": "/alerts",
  "/calendar": "/calendar",
  "/heatmap": "/heatmap",
  "/portfolio": "/portfolio",
  "/screener": "/screener",
  "/settings": "/settings",
  "/stocks/[ticker]": "/stocks/TEST_DIV",
  "/stocks/[ticker]/financials": "/stocks/TEST_FIN/financials",
  "/watchlists": "/watchlists",
};

export const API_ROUTES: Record<string, string> = {
  "/api/calendar": "/api/calendar?tab=earnings",
  "/api/search": "/api/search?q=TEST",
  "/api/stocks/[ticker]/series": "/api/stocks/TEST_DIV/series",
  "/api/stream": "/api/stream?ids=1",
};

/** Reachable without a session by design. */
export const PUBLIC_ROUTES = ["/login", "/robots.txt"];
