import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ProviderError, ProviderResponseError } from "./errors";
import type { ProviderId } from "./types";

/**
 * The only way adapters reach the network (spec §8 "SSRF-safe fetchers"):
 * - hosts must be on the adapter's allowlist, HTTPS only (plain HTTP only for loopback, which
 *   tests use), redirects are refused;
 * - retries with exponential backoff and full jitter on retryable statuses and network errors,
 *   honoring Retry-After;
 * - an optional shared rate limiter is awaited before every attempt; if it is unreachable the
 *   request fails closed;
 * - secrets in query strings are redacted from every error and callback.
 */

export interface RateLimiter {
  acquire(): Promise<unknown>;
}

export interface ResponseInfo {
  url: string;
  status: number | null;
  latencyMs: number;
  attempt: number;
}

export interface HttpClientOptions {
  provider: ProviderId;
  allowedHosts: readonly string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retries after the first attempt. */
  maxRetries?: number;
  retryStatuses?: readonly number[];
  baseDelayMs?: number;
  maxDelayMs?: number;
  rateLimiter?: RateLimiter;
  /** Query parameters whose values must never be logged (e.g. api_key). */
  redactQueryParams?: readonly string[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onResponse?: (info: ResponseInfo) => void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504] as const;

export class HttpClient {
  private readonly opts: Required<
    Omit<HttpClientOptions, "rateLimiter" | "onResponse" | "headers">
  > &
    Pick<HttpClientOptions, "rateLimiter" | "onResponse" | "headers">;
  /** Responses by HTTP status (0 = network error/timeout), for ingestion run records. */
  readonly statusCounts = new Map<number, number>();

  constructor(opts: HttpClientOptions) {
    this.opts = {
      timeoutMs: 20_000,
      maxRetries: 4,
      retryStatuses: DEFAULT_RETRY_STATUSES,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      redactQueryParams: [],
      fetch: globalThis.fetch.bind(globalThis),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      // Explicit `undefined` (e.g. an adapter forwarding an unset option) must not erase a default.
      ...(Object.fromEntries(
        Object.entries(opts).filter(([, value]) => value !== undefined),
      ) as HttpClientOptions),
    };
  }

  get provider(): ProviderId {
    return this.opts.provider;
  }

  /** `url` with secret query values and any userinfo replaced by REDACTED. */
  redact(url: string | URL): string {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "REDACTED";
      u.password = "";
    }
    for (const param of this.opts.redactQueryParams) {
      if (u.searchParams.has(param)) u.searchParams.set(param, "REDACTED");
    }
    return u.toString();
  }

  private assertAllowed(url: URL): void {
    const allowed = this.opts.allowedHosts.includes(url.host);
    const scheme =
      url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
    if (!allowed || !scheme) {
      throw new ProviderError(
        this.provider,
        `Refusing request to non-allowlisted URL ${this.redact(url)}`,
        {
          retryable: false,
        },
      );
    }
  }

  private count(status: number): void {
    this.statusCounts.set(status, (this.statusCounts.get(status) ?? 0) + 1);
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, this.opts.maxDelayMs);
    const ceiling = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** attempt);
    return Math.floor(this.opts.random() * ceiling);
  }

  async getJson(
    input: string | URL,
    init: { headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const text = await this.getText(input, { ...init, accept: "application/json" });
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new ProviderResponseError(
        this.provider,
        `Response from ${this.redact(new URL(input))} is not valid JSON`,
        err,
      );
    }
  }

  /** Same allowlist, limiter, retries and redaction as getJson, for HTML and XML documents. */
  async getText(
    input: string | URL,
    init: { headers?: Record<string, string>; accept?: string } = {},
  ): Promise<string> {
    const response = await this.send(input, { method: "GET", ...init });
    return await response.text();
  }

  /**
   * POST with a JSON body (or none), for query APIs that take their filters in the body (FINRA).
   * Retried like a GET, so use it only for requests that are safe to repeat.
   */
  async postJson(
    input: string | URL,
    body: unknown,
    init: { headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const response = await this.send(input, {
      method: "POST",
      accept: "application/json",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    // Some query APIs answer "no records" with an empty body.
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new ProviderResponseError(
        this.provider,
        `Response from ${this.redact(new URL(input))} is not valid JSON`,
        err,
      );
    }
  }

  /**
   * Streams a large file (an SEC bulk zip) to `path`, refusing anything over `maxBytes`. Same
   * allowlist, limiter and redaction; a failure part-way through starts the file again.
   */
  async download(
    input: string | URL,
    path: string,
    opts: { maxBytes: number; timeoutMs?: number },
  ): Promise<{ bytes: number }> {
    const url = new URL(input);
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.send(url, { method: "GET" }, opts.timeoutMs);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        await response.body?.cancel();
        throw new ProviderError(
          this.provider,
          `${this.redact(url)} is ${declared} bytes, over the ${opts.maxBytes}-byte limit`,
          { retryable: false },
        );
      }
      let bytes = 0;
      const limit = new Transform({
        transform: (chunk: Buffer, _enc, done) => {
          bytes += chunk.length;
          if (bytes > opts.maxBytes) {
            done(
              new ProviderError(
                this.provider,
                `${this.redact(url)} exceeded the ${opts.maxBytes}-byte limit`,
                { retryable: false },
              ),
            );
          } else done(null, chunk);
        },
      });
      try {
        if (!response.body) throw new ProviderResponseError(this.provider, "Empty response body");
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path));
        return { bytes };
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        if (attempt >= this.opts.maxRetries) {
          throw new ProviderError(
            this.provider,
            `Download failed after ${attempt + 1} attempts: ${this.redact(url)}`,
            { retryable: true, cause: err instanceof Error ? new Error(err.message) : undefined },
          );
        }
        await this.opts.sleep(this.backoff(attempt, null));
      }
    }
  }

  /** One request with the allowlist, limiter, retries and redaction; returns a 2xx response. */
  private async send(
    input: string | URL,
    init: {
      method: "GET" | "POST";
      headers?: Record<string, string>;
      accept?: string;
      body?: string;
    },
    timeoutMs = this.opts.timeoutMs,
  ): Promise<Response> {
    const url = new URL(input);
    this.assertAllowed(url);
    const safeUrl = this.redact(url);

    for (let attempt = 0; ; attempt += 1) {
      // Fail closed: a limiter error propagates and no request is sent.
      await this.opts.rateLimiter?.acquire();
      const started = Date.now();
      let response: Response;
      try {
        response = await this.opts.fetch(url, {
          method: init.method,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            accept: init.accept ?? "*/*",
            "accept-encoding": "gzip, deflate",
            ...this.opts.headers,
            ...init.headers,
          },
          body: init.body,
        });
      } catch (err) {
        this.count(0);
        this.opts.onResponse?.({
          url: safeUrl,
          status: null,
          latencyMs: Date.now() - started,
          attempt,
        });
        if (attempt < this.opts.maxRetries) {
          await this.opts.sleep(this.backoff(attempt, null));
          continue;
        }
        throw new ProviderError(
          this.provider,
          `Request failed after ${attempt + 1} attempts: ${safeUrl}`,
          {
            retryable: true,
            cause: err instanceof Error ? new Error(err.message) : undefined,
          },
        );
      }

      this.count(response.status);
      this.opts.onResponse?.({
        url: safeUrl,
        status: response.status,
        latencyMs: Date.now() - started,
        attempt,
      });

      if (response.ok) return response;

      // Drain the body so the connection can be reused.
      await response.body?.cancel();
      const retryable = this.opts.retryStatuses.includes(response.status);
      if (retryable && attempt < this.opts.maxRetries) {
        await this.opts.sleep(this.backoff(attempt, response.headers.get("retry-after")));
        continue;
      }
      throw new ProviderError(this.provider, `HTTP ${response.status} from ${safeUrl}`, {
        status: response.status,
        retryable,
      });
    }
  }
}
