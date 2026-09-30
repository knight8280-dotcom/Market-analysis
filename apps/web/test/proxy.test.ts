import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, proxy } from "../src/proxy";

const url = "http://localhost/admin/data-health";
const auth = (u: string, p: string) => ({
  authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`,
});
const saved = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, {
    APP_ENV: "test",
    DATABASE_URL: "postgres://localhost/unused",
    ADMIN_BASIC_AUTH_USER: "ops",
    ADMIN_BASIC_AUTH_PASSWORD: "a-long-enough-password",
  });
});
afterEach(() => {
  process.env = { ...saved };
});

describe("admin proxy", () => {
  it("only guards /admin", () => {
    expect(config.matcher).toEqual(["/admin/:path*"]);
  });

  it("challenges requests without credentials, never indexed or cached", () => {
    const res = proxy(new NextRequest(url));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm="admin"/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects wrong credentials", () => {
    expect(
      proxy(new NextRequest(url, { headers: auth("ops", "nope-nope-nope-nope") })).status,
    ).toBe(401);
  });

  it("passes the right credentials through with noindex and no-store", () => {
    const res = proxy(new NextRequest(url, { headers: auth("ops", "a-long-enough-password") }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed when admin credentials are not configured", () => {
    delete process.env.ADMIN_BASIC_AUTH_PASSWORD;
    const res = proxy(new NextRequest(url, { headers: auth("ops", "a-long-enough-password") }));
    expect(res.status).toBe(503);
  });
});
