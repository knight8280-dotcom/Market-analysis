import { loadWebEnv, type WebEnv } from "@market/config";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce, viaHttps } from "./server/auth/csp";
import { isAllowedHost } from "./server/auth/hosts";
import { safeNext } from "./server/auth/next-path";
import { isPublicPath } from "./server/auth/public-paths";
import { SESSION_COOKIE, verifySessionToken } from "./server/auth/session";

/**
 * Guards every route (personal use, ADR-015/018): only the owner, with a valid session cookie,
 * sees anything but the login page and what a browser needs to install the app (ADR-037). Fails
 * closed: without login configured the app serves nothing. Pages and API routes also check the
 * session themselves (`requireOwner`), so this is not the only line of defence.
 */
const PRIVATE_HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };

export function proxy(request: NextRequest): NextResponse {
  // Every response carries the CSP (ADR-039); a page's request carries it too, so Next puts the
  // nonce on the scripts it renders. Over HTTPS the browser is also told to stay on HTTPS.
  const https = viaHttps(request.headers, request.nextUrl.protocol);
  const csp = contentSecurityPolicy(newNonce(), {
    dev: process.env.NODE_ENV === "development",
    https,
  });
  const withPrivateHeaders = (res: NextResponse): NextResponse => {
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
    res.headers.set("Content-Security-Policy", csp);
    if (https) res.headers.set("Strict-Transport-Security", "max-age=31536000");
    return res;
  };
  const pass = () => {
    const headers = new Headers(request.headers);
    headers.set("Content-Security-Policy", csp);
    return withPrivateHeaders(NextResponse.next({ request: { headers } }));
  };

  let env: WebEnv;
  try {
    env = loadWebEnv();
  } catch {
    return withPrivateHeaders(
      new NextResponse("Owner login is not configured; see docs/RUNBOOK.md.", { status: 503 }),
    );
  }
  if (!isAllowedHost(request.headers.get("host"), env.WEB_ALLOWED_HOSTS)) {
    return withPrivateHeaders(new NextResponse("Unknown host.", { status: 421 }));
  }

  const { pathname, search } = request.nextUrl;
  const signedIn = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, {
    sessionSecret: env.SESSION_SECRET,
    passwordHash: env.OWNER_PASSWORD_HASH,
  });

  if (isPublicPath(pathname)) {
    if (signedIn && pathname === "/login" && request.method === "GET") {
      const to = new URL(safeNext(request.nextUrl.searchParams.get("next")), request.url);
      return withPrivateHeaders(NextResponse.redirect(to));
    }
    return pass();
  }
  if (signedIn) return pass();

  if (pathname.startsWith("/api/")) {
    return withPrivateHeaders(NextResponse.json({ error: "Sign in required" }, { status: 401 }));
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return withPrivateHeaders(NextResponse.redirect(login));
}

// Everything except Next's own build assets and dev-server endpoints.
export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
