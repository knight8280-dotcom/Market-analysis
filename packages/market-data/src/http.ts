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
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(this.opts.timeoutMs),
          headers: {
            accept: init.accept ?? "*/*",
            "accept-encoding": "gzip, deflate",
            ...this.opts.headers,
            ...init.headers,
          },
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

      if (response.ok) return await response.text();

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
