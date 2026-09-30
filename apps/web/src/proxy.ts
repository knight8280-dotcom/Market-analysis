import { loadWebEnv } from "@market/config";
import { NextResponse, type NextRequest } from "next/server";
import { checkBasicAuth } from "./server/basic-auth";

/**
 * Guards the internal admin pages until real auth arrives in Phase 1: HTTP Basic auth against
 * env credentials, never indexed, never cached.
 */
const PRIVATE_HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };

export function proxy(request: NextRequest): NextResponse {
  let credentials: { user: string; password: string };
  try {
    const env = loadWebEnv();
    credentials = { user: env.ADMIN_BASIC_AUTH_USER, password: env.ADMIN_BASIC_AUTH_PASSWORD };
  } catch {
    return new NextResponse("Admin access is not configured.", {
      status: 503,
      headers: PRIVATE_HEADERS,
    });
  }
  if (!checkBasicAuth(request.headers.get("authorization"), credentials)) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { ...PRIVATE_HEADERS, "WWW-Authenticate": 'Basic realm="admin", charset="UTF-8"' },
    });
  }
  const response = NextResponse.next();
  for (const [k, v] of Object.entries(PRIVATE_HEADERS)) response.headers.set(k, v);
  return response;
}

export const config = { matcher: ["/admin/:path*"] };
