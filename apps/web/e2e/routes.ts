/**
 * Every page and API route, with a sample URL. `test/routes.test.ts` fails when a route is added
 * under src/app without being listed here, so the session check in shell.spec.ts covers it.
 */
export const PAGE_ROUTES: Record<string, string> = {
  "/": "/",
  "/admin/data-health": "/admin/data-health",
  "/alerts": "/alerts",
  "/alerts/[id]": "/alerts/1",
  "/backtests": "/backtests",
  "/backtests/[id]": "/backtests/1",
  "/backtests/new": "/backtests/new",
  "/calendar": "/calendar",
  "/heatmap": "/heatmap",
  "/notifications": "/notifications",
  "/portfolio": "/portfolio",
  "/screener": "/screener",
  "/settings": "/settings",
  "/stocks/[ticker]": "/stocks/TEST_DIV",
  "/stocks/[ticker]/financials": "/stocks/TEST_FIN/financials",
  "/stocks/[ticker]/valuation": "/stocks/TEST_FIN/valuation",
  "/watchlists": "/watchlists",
};

export const API_ROUTES: Record<string, string> = {
  "/api/calendar": "/api/calendar?tab=earnings",
  "/api/notifications/unread": "/api/notifications/unread",
  "/api/search": "/api/search?q=TEST",
  "/api/stocks/[ticker]/series": "/api/stocks/TEST_DIV/series",
  "/api/stream": "/api/stream?ids=1",
};

/** Reachable without a session by design. */
export const PUBLIC_ROUTES = ["/login", "/robots.txt"];
