import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, proxy } from "../src/proxy";
import { safeNext } from "../src/server/auth/next-path";
import { createSessionToken, SESSION_COOKIE } from "../src/server/auth/session";

const saved = { ...process.env };
const ENV = {
  APP_ENV: "test",
  DATABASE_URL: "postgres://localhost/unused",
  OWNER_PASSWORD_HASH: `scrypt:17:8:1:${"s".repeat(22)}:${"h".repeat(43)}`,
  SESSION_SECRET: "x".repeat(32),
};
const keys = { sessionSecret: ENV.SESSION_SECRET, passwordHash: ENV.OWNER_PASSWORD_HASH };

function request(path: string, opts: { cookie?: string; host?: string; method?: string } = {}) {
  const headers: Record<string, string> = { host: opts.host ?? "localhost:3000" };
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  return new NextRequest(`http://localhost:3000${path}`, { headers, method: opts.method });
}

beforeEach(() => {
  Object.assign(process.env, ENV);
});
afterEach(() => {
  process.env = { ...saved };
});

describe("owner proxy", () => {
  it("guards everything except Next's build assets", () => {
    const [pattern] = config.matcher;
    const re = new RegExp(`^${pattern!}$`);
    for (const path of ["/", "/stocks/AAPL", "/api/search", "/admin/data-health", "/login"]) {
      expect(re.test(path), path).toBe(true);
    }
    for (const path of ["/_next/static/chunk.js", "/_next/webpack-hmr", "/favicon.ico"]) {
      expect(re.test(path), path).toBe(false);
    }
  });

  it("sends pages to the login form, keeping the destination", () => {
    const res = proxy(request("/stocks/AAPL?tf=1y"));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe("/stocks/AAPL?tf=1y");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers API calls without a session with 401", async () => {
    const res = proxy(request("/api/search?q=AA"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in required" });
  });

  it("lets a valid session through, private and uncached", () => {
    const res = proxy(request("/stocks/AAPL", { cookie: createSessionToken(keys) }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a forged or stale cookie", () => {
    const other = createSessionToken({ ...keys, sessionSecret: "y".repeat(32) });
    expect(proxy(request("/", { cookie: other })).status).toBe(307);
    expect(proxy(request("/", { cookie: "v1.e30.AAAA" })).status).toBe(307);
  });

  it("serves what a browser needs to install the app without a session, and nothing more", () => {
    const open = [
      "/manifest.webmanifest",
      "/sw.js",
      "/icon/32",
      "/icon/192",
      "/icon/512",
      "/apple-icon",
    ];
    for (const path of open) {
      const res = proxy(request(path));
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
    }
    for (const path of ["/icon/64", "/icon", "/icons/192", "/sw.js/x", "/apple-icon/1"]) {
      expect(proxy(request(path)).status, path).toBe(307);
    }
  });

  it("serves the login form, and skips it when already signed in", () => {
    expect(proxy(request("/login")).headers.get("x-middleware-next")).toBe("1");
    const res = proxy(request("/login?next=/screener", { cookie: createSessionToken(keys) }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/screener");
  });

  it("refuses unknown host names (DNS rebinding)", () => {
    expect(proxy(request("/login", { host: "evil.example:3000" })).status).toBe(421);
    const token = createSessionToken(keys);
    expect(proxy(request("/", { host: "evil.example", cookie: token })).status).toBe(421);
  });

  it("fails closed when login is not configured", () => {
    delete process.env.SESSION_SECRET;
    expect(proxy(request("/login")).status).toBe(503);
    expect(proxy(request("/", { cookie: createSessionToken(keys) })).status).toBe(503);
  });
});

describe("safeNext", () => {
  it("keeps same-site paths and drops everything else", () => {
    expect(safeNext("/stocks/AAPL?tf=1y")).toBe("/stocks/AAPL?tf=1y");
    for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example"]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});
