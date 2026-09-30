import type { ProviderId } from "./types";

export interface ProviderErrorOptions {
  status?: number;
  retryable: boolean;
  cause?: unknown;
}

/** A provider call failed. `retryable` tells the job runner whether another attempt can help. */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(provider: ProviderId, message: string, opts: ProviderErrorOptions) {
    super(message, { cause: opts.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

/** The adapter does not implement this dataset (yet). */
export class NotSupportedError extends ProviderError {
  constructor(provider: ProviderId, method: string) {
    super(provider, `${provider} does not support ${method}`, { retryable: false });
    this.name = "NotSupportedError";
  }
}

/**
 * The vendor's response did not match the documented shape. Never "fixed up": the adapter's
 * fixtures probably need re-recording (spec rule 9).
 */
export class ProviderResponseError extends ProviderError {
  constructor(provider: ProviderId, message: string, cause?: unknown) {
    super(provider, message, { retryable: false, cause });
    this.name = "ProviderResponseError";
  }
}

/** The shared rate limiter could not be reached. Requests fail closed rather than go unmetered. */
export class RateLimiterUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RateLimiterUnavailableError";
  }
}

/** The data exists but our license does not cover it (e.g. a third-party copyrighted FRED series). */
export class LicenseRestrictedError extends ProviderError {
  constructor(provider: ProviderId, message: string) {
    super(provider, message, { retryable: false });
    this.name = "LicenseRestrictedError";
  }
}
