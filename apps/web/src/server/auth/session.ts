import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed owner session tokens, stored in an httpOnly cookie: `v1.<payload>.<signature>`, where
 * the signature is HMAC-SHA256 over the payload. The key is derived from SESSION_SECRET and the
 * owner's password hash, so changing either signs every session out.
 */
export const SESSION_COOKIE = "ma_session";
export const SESSION_TTL_SECONDS = 14 * 24 * 3600;

export interface SessionKeys {
  sessionSecret: string;
  passwordHash: string;
}

interface Payload {
  sub: "owner";
  iat: number;
  exp: number;
}

function key(keys: SessionKeys): Buffer {
  return createHmac("sha256", keys.sessionSecret)
    .update(`owner-session:v1:${keys.passwordHash}`)
    .digest();
}

function sign(body: string, keys: SessionKeys): Buffer {
  return createHmac("sha256", key(keys)).update(`v1.${body}`).digest();
}

export function createSessionToken(keys: SessionKeys, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: Payload = { sub: "owner", iat, exp: iat + SESSION_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `v1.${body}.${sign(body, keys).toString("base64url")}`;
}

/** True only for an unexpired token signed with the current keys. */
export function verifySessionToken(
  token: string | undefined,
  keys: SessionKeys,
  now: Date = new Date(),
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const [, body, signature] = parts as [string, string, string];
  const actual = Buffer.from(signature, "base64url");
  const expected = sign(body, keys);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  let payload: Partial<Payload>;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<Payload>;
  } catch {
    return false;
  }
  const t = Math.floor(now.getTime() / 1000);
  return (
    payload.sub === "owner" &&
    typeof payload.iat === "number" &&
    typeof payload.exp === "number" &&
    payload.iat <= t + 60 &&
    t < payload.exp
  );
}

/**
 * How the session cookie is set: httpOnly, SameSite=Lax, host-only, for the session's lifetime;
 * Secure when the owner signed in over HTTPS (the Tailscale address), so it is never sent over
 * plain HTTP from then on. A local http://127.0.0.1 server cannot set a Secure cookie.
 */
export function sessionCookieOptions(origin: string | null) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (origin ?? "").startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
