import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, ProviderResponseError, RateLimiterUnavailableError } from "../src/errors";
import { HttpClient, type HttpClientOptions } from "../src/http";
import { json, startServer, type TestServer } from "./helpers/server";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function client(host: string, extra: Partial<HttpClientOptions> = {}) {
  const delays: number[] = [];
  const http = new HttpClient({
    provider: "fred",
    allowedHosts: [host],
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    redactQueryParams: ["api_key"],
    ...extra,
  });
  return { http, delays };
}

describe("HttpClient", () => {
  it("returns parsed JSON and sends gzip and JSON accept headers", async () => {
    server = await startServer((_req, res) => json(res, 200, { ok: true }));
    const { http } = client(server.host, {
      headers: { "user-agent": "Example admin@example.com" },
    });
    expect(await http.getJson(server.url("/x"))).toEqual({ ok: true });
    const headers = server.requests[0]!.headers;
    expect(headers["accept-encoding"]).toBe("gzip, deflate");
    expect(headers["accept"]).toBe("application/json");
    expect(headers["user-agent"]).toBe("Example admin@example.com");
  });

  it("retries retryable statuses with exponential backoff and full jitter", async () => {
    server = await startServer((_req, res, n) =>
      n < 3 ? json(res, 503, {}) : json(res, 200, [1]),
    );
    const { http, delays } = client(server.host);
    expect(await http.getJson(server.url("/x"))).toEqual([1]);
    expect(server.requests).toHaveLength(3);
    // random() = 0.5 of min(maxDelay, 500 * 2^attempt)
    expect(delays).toEqual([250, 500]);
    expect(http.statusCounts.get(503)).toBe(2);
    expect(http.statusCounts.get(200)).toBe(1);
  });

  it("keeps defaults when an option is passed as undefined", async () => {
    server = await startServer((_req, res, n) =>
      n === 1 ? json(res, 503, {}) : json(res, 200, {}),
    );
    const { http } = client(server.host, { maxRetries: undefined, fetch: undefined });
    await expect(http.getJson(server.url("/x"))).resolves.toEqual({});
    expect(server.requests).toHaveLength(2);
  });

  it("honors Retry-After", async () => {
    server = await startServer((_req, res, n) =>
      n === 1 ? json(res, 429, {}, { "retry-after": "2" }) : json(res, 200, {}),
    );
    const { http, delays } = client(server.host);
    await http.getJson(server.url("/x"));
    expect(delays).toEqual([2000]);
  });

  it("gives up after maxRetries and reports the status", async () => {
    server = await startServer((_req, res) => json(res, 503, {}));
    const { http } = client(server.host, { maxRetries: 2 });
    const err = await http.getJson(server.url("/x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(503);
    expect((err as ProviderError).retryable).toBe(true);
    expect(server.requests).toHaveLength(3);
  });

  it("does not retry non-retryable statuses", async () => {
    server = await startServer((_req, res) => json(res, 404, {}));
    const { http } = client(server.host);
    await expect(http.getJson(server.url("/x"))).rejects.toMatchObject({
      status: 404,
      retryable: false,
    });
    expect(server.requests).toHaveLength(1);
  });

  it("retries network errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const { http } = client("api.example.com", { fetch: fetchImpl });
    expect(await http.getJson("https://api.example.com/x")).toEqual({ ok: 1 });
    expect(http.statusCounts.get(0)).toBe(1);
  });

  it("refuses hosts that are not allowlisted, without sending anything", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { http } = client("api.example.com", { fetch: fetchImpl });
    await expect(http.getJson("https://evil.example.net/x")).rejects.toThrow(/non-allowlisted/);
    await expect(http.getJson("https://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /non-allowlisted/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires HTTPS except on loopback", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { http } = client("api.example.com", { fetch: fetchImpl });
    await expect(http.getJson("http://api.example.com/x")).rejects.toThrow(/non-allowlisted/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses redirects instead of following them", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example.com/" });
      res.end();
    });
    const { http } = client(server.host, { maxRetries: 0 });
    await expect(http.getJson(server.url("/x"))).rejects.toBeInstanceOf(ProviderError);
  });

  it("redacts secret query parameters from errors and callbacks", async () => {
    server = await startServer((_req, res) => json(res, 500, {}));
    const seen: string[] = [];
    const { http } = client(server.host, {
      maxRetries: 0,
      onResponse: (info) => seen.push(info.url),
    });
    const err = (await http
      .getJson(server.url("/fred/series?series_id=DGS10&api_key=supersecretkey123"))
      .then(
        () => null,
        (e: unknown) => e,
      )) as Error;
    expect(err.message).toContain("api_key=REDACTED");
    expect(err.message).not.toContain("supersecretkey123");
    expect(seen.join(" ")).not.toContain("supersecretkey123");
    // The real key still went to the server.
    expect(server.requests[0]!.url).toContain("api_key=supersecretkey123");
  });

  it("rejects invalid JSON as a response-shape error", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>not json</html>");
    });
    const { http } = client(server.host);
    await expect(http.getJson(server.url("/x"))).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("acquires a rate-limit slot before every attempt", async () => {
    server = await startServer((_req, res, n) =>
      n === 1 ? json(res, 503, {}) : json(res, 200, {}),
    );
    const acquire = vi.fn(() => Promise.resolve(0));
    const { http } = client(server.host, { rateLimiter: { acquire } });
    await http.getJson(server.url("/x"));
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the rate limiter is unavailable", async () => {
    server = await startServer((_req, res) => json(res, 200, {}));
    const { http } = client(server.host, {
      rateLimiter: { acquire: () => Promise.reject(new RateLimiterUnavailableError("down")) },
    });
    await expect(http.getJson(server.url("/x"))).rejects.toBeInstanceOf(
      RateLimiterUnavailableError,
    );
    expect(server.requests).toHaveLength(0);
  });
});
