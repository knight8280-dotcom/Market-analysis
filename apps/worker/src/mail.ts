import type { WorkerEnv } from "@market/config";
import type { AlertDelivery } from "./context";

/** Outgoing alert email (Phase 1 step I3). Plain text: no tracking pixels, no remote content. */
export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** The same key never sends twice (Resend keeps it for 24 hours). */
  idempotencyKey: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

export class MailError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "MailError";
  }
}

/**
 * Sends through Resend's HTTP API (`POST /emails`). The API key goes in the Authorization header
 * and never into errors or logs.
 */
export class ResendMailer implements Mailer {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl?: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    this.baseUrl = (opts.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async send(email: OutgoingEmail): Promise<{ id: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new MailError(
        `Resend request failed: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    const body = await res.text();
    if (!res.ok) {
      let detail = body.slice(0, 200);
      try {
        const parsed = JSON.parse(body) as { message?: unknown };
        if (typeof parsed.message === "string") detail = parsed.message.slice(0, 200);
      } catch {
        // not JSON; keep the truncated text
      }
      throw new MailError(`Resend HTTP ${res.status}: ${detail}`, res.status);
    }
    try {
      const parsed = JSON.parse(body) as { id?: unknown };
      return { id: typeof parsed.id === "string" ? parsed.id : "" };
    } catch {
      return { id: "" };
    }
  }
}

/** Alert delivery from the worker's env: Resend when RESEND_API_KEY is set, else none. */
export function alertDeliveryFromEnv(env: WorkerEnv): AlertDelivery {
  return {
    mailer: env.RESEND_API_KEY
      ? new ResendMailer({ apiKey: env.RESEND_API_KEY, baseUrl: env.RESEND_API_URL })
      : null,
    to: env.ALERT_EMAIL_TO ?? null,
    from: env.ALERT_EMAIL_FROM,
    dailyCap: env.ALERT_DAILY_CAP,
    appUrl: env.APP_BASE_URL,
  };
}
