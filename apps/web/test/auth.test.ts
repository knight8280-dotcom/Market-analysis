import { PASSWORD_HASH_PATTERN } from "@market/config";
import { describe, expect, it } from "vitest";
import { hostnameOf, isAllowedHost } from "../src/server/auth/hosts";
import { hashPassword, verifyPassword } from "../src/server/auth/password";
import {
  createSessionToken,
  SESSION_TTL_SECONDS,
  verifySessionToken,
  sessionCookieOptions,
} from "../src/server/auth/session";
import { LoginThrottle } from "../src/server/auth/throttle";

const FAST = { log2N: 10, r: 8, p: 1 };

describe("owner password hash", () => {
  // Two hashes at the production cost (2^17, 128 MiB each) are slow by design; a parallel run of
  // every package's tests can push them past the default five seconds.
  it("uses OWASP scrypt parameters by default and matches the env pattern", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt:17:8:1:/);
    expect(hash).toMatch(PASSWORD_HASH_PATTERN);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  }, 30_000);

  it("rejects a wrong password and salts every hash", async () => {
    const a = await hashPassword("correct horse battery staple", FAST);
    const b = await hashPassword("correct horse battery staple", FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery stapler", a)).toBe(false);
  });

  it("refuses short passwords", async () => {
    await expect(hashPassword("short", FAST)).rejects.toThrow(/at least 12/);
  });

  it("never matches (or throws on) a malformed hash", async () => {
    for (const bad of [
      "",
      "scrypt",
      "bcrypt:1:2:3:4:5",
      "scrypt:17:8:1:c2FsdA:aGFzaA",
      "scrypt:99:8:1:x:y",
    ]) {
      expect(await verifyPassword("anything at all", bad)).toBe(false);
    }
  });
});

describe("session tokens", () => {
  const keys = { sessionSecret: "s".repeat(32), passwordHash: "scrypt:17:8:1:salt:hash" };
  const now = new Date("2026-09-30T12:00:00Z");

  it("verifies until expiry", () => {
    const token = createSessionToken(keys, now);
    expect(verifySessionToken(token, keys, now)).toBe(true);
    const almost = new Date(now.getTime() + (SESSION_TTL_SECONDS - 1) * 1000);
    expect(verifySessionToken(token, keys, almost)).toBe(true);
    const expired = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
    expect(verifySessionToken(token, keys, expired)).toBe(false);
  });

  it("is invalidated by a new session secret or a new password", () => {
    const token = createSessionToken(keys, now);
    expect(verifySessionToken(token, { ...keys, sessionSecret: "t".repeat(32) }, now)).toBe(false);
    expect(verifySessionToken(token, { ...keys, passwordHash: "scrypt:other" }, now)).toBe(false);
  });

  it("rejects tampered, truncated and future-dated tokens", () => {
    const token = createSessionToken(keys, now);
    const [v, body, sig] = token.split(".") as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ sub: "owner", iat: 0, exp: 4_000_000_000 }),
    ).toString("base64url");
    expect(verifySessionToken(`${v}.${forged}.${sig}`, keys, now)).toBe(false);
    expect(verifySessionToken(`${v}.${body}`, keys, now)).toBe(false);
    expect(verifySessionToken(`${v}.${body}.${sig.slice(0, -2)}`, keys, now)).toBe(false);
    expect(verifySessionToken(undefined, keys, now)).toBe(false);
    const future = createSessionToken(keys, new Date(now.getTime() + 3600_000));
    expect(verifySessionToken(future, keys, now)).toBe(false);
  });
});

describe("allowed hosts", () => {
  it("parses host headers with ports and IPv6", () => {
    expect(hostnameOf("localhost:3000")).toBe("localhost");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
    expect(hostnameOf(null)).toBeNull();
  });

  it("allows loopback and configured names only", () => {
    expect(isAllowedHost("localhost:3000", [])).toBe(true);
    expect(isAllowedHost("127.0.0.1:3000", [])).toBe(true);
    expect(isAllowedHost("[::1]:3000", [])).toBe(true);
    // A DNS-rebinding attacker's name resolving to 127.0.0.1.
    expect(isAllowedHost("evil.example:3000", [])).toBe(false);
    expect(isAllowedHost("box.local:3000", ["box.local"])).toBe(true);
    expect(isAllowedHost("", [])).toBe(false);
    expect(isAllowedHost(null, [])).toBe(false);
  });
});

describe("login throttle", () => {
  it("locks after max failures until the oldest ages out", () => {
    const t = new LoginThrottle(3, 60_000);
    for (let i = 0; i < 3; i += 1) t.recordFailure(1000 + i);
    expect(t.retryAfterMs(2000)).toBe(59_000);
    expect(t.retryAfterMs(61_000)).toBe(0);
    t.reset();
    expect(t.retryAfterMs(2000)).toBe(0);
  });
});

describe("session cookie", () => {
  it("is Secure once the owner signs in over HTTPS, and httpOnly, Lax and host-only always", () => {
    const tailnet = sessionCookieOptions("https://desk.example-tailnet.ts.net");
    expect(tailnet).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    expect(tailnet).not.toHaveProperty("domain");
    expect(sessionCookieOptions("http://127.0.0.1:3000").secure).toBe(false);
    expect(sessionCookieOptions(null).secure).toBe(false);
  });
});
