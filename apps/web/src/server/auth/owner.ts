import "server-only";
import { loadWebEnv } from "@market/config";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken, type SessionKeys } from "./session";

export function sessionKeys(): SessionKeys {
  const env = loadWebEnv();
  return { sessionSecret: env.SESSION_SECRET, passwordHash: env.OWNER_PASSWORD_HASH };
}

export async function isOwner(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySessionToken(token, sessionKeys());
}

/**
 * Second line of defence behind the proxy: every page and API route that reads data calls this
 * first, so a routing mistake in the proxy matcher cannot expose data.
 */
export async function requireOwner(): Promise<void> {
  if (!(await isOwner())) redirect("/login");
}

/** For route handlers: a 401 response to return, or null when the owner is signed in. */
export async function ownerOr401(): Promise<Response | null> {
  if (await isOwner()) return null;
  return Response.json(
    { error: "Sign in required" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
