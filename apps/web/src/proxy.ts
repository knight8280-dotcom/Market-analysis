import { loadWebEnv, type WebEnv } from "@market/config";
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedHost } from "./server/auth/hosts";
import { safeNext } from "./server/auth/next-path";
import { SESSION_COOKIE, verifySessionToken } from "./server/auth/session";

/**
 * Guards every route (personal use, ADR-015/018): only the owner, with a valid session cookie,
 * sees anything but the login page. Fails closed: without login configured the app serves
 * nothing. Pages and API routes also check the session themselves (`requireOwner`), so this is
 * not the only line of defence.
 */
const PRIVATE_HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };
const PUBLIC_PATHS = new Set(["/login", "/robots.txt"]);

function withPrivateHeaders(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
  return res;
}

export function proxy(request: NextRequest): NextResponse {
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

  if (PUBLIC_PATHS.has(pathname)) {
    if (signedIn && pathname === "/login" && request.method === "GET") {
      const to = new URL(safeNext(request.nextUrl.searchParams.get("next")), request.url);
      return withPrivateHeaders(NextResponse.redirect(to));
    }
    return withPrivateHeaders(NextResponse.next());
  }
  if (signedIn) return withPrivateHeaders(NextResponse.next());

  if (pathname.startsWith("/api/")) {
    return withPrivateHeaders(NextResponse.json({ error: "Sign in required" }, { status: 401 }));
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return withPrivateHeaders(NextResponse.redirect(login));
}

// Everything except Next's own build assets and dev-server endpoints.
export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
