/**
 * Route handlers that change data accept requests from this app's own pages and service worker
 * only (CSRF, spec §8): the browser's Origin must be the host the request came to, as Next
 * checks for Server Actions (`x-forwarded-host` first, behind a proxy such as Tailscale Serve).
 * A browser sends Origin on every cross-site POST, so a missing one is refused too.
 */
export function isSameOrigin(headers: Headers): boolean {
  if (headers.get("sec-fetch-site") && headers.get("sec-fetch-site") !== "same-origin") {
    return false;
  }
  const origin = headers.get("origin");
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.split(",")[0]!.trim();
  } catch {
    return false;
  }
}
