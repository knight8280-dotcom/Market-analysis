/**
 * Failed-login throttle. There is one account, so the limit is global rather than per client
 * address (which a local proxy or spoofed header could vary): after `max` failures inside
 * `windowMs`, every attempt is refused until the oldest failure ages out.
 */
export class LoginThrottle {
  private failures: number[] = [];

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}

  private prune(now: number) {
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
  }

  /** Milliseconds until another attempt is allowed; 0 when allowed now. */
  retryAfterMs(now: number = Date.now()): number {
    this.prune(now);
    if (this.failures.length < this.max) return 0;
    return this.windowMs - (now - this.failures[0]!);
  }

  recordFailure(now: number = Date.now()) {
    this.prune(now);
    this.failures.push(now);
  }

  reset() {
    this.failures = [];
  }
}

const globalForThrottle = globalThis as unknown as { loginThrottle?: LoginThrottle };

/** One throttle per server process (kept across dev hot reloads). */
export function loginThrottle(): LoginThrottle {
  globalForThrottle.loginThrottle ??= new LoginThrottle();
  return globalForThrottle.loginThrottle;
}
