import type { IsoDate } from "@market/calendar";
import { z } from "zod";
import { HttpClient, type HttpClientOptions, type RateLimiter } from "../http";
import { BaseProvider } from "../provider";
import { EarningsEvent } from "../types";
import { parseVendor } from "./common";

/**
 * Finnhub earnings calendar (Phase 1 step H1), on the owner's free personal key (ADR-015).
 * The key goes in the X-Finnhub-Token header, never the URL.
 *
 * SHAPE UNVERIFIED: the payload schema follows Finnhub's public documentation (checked
 * 2026-09-30); the fixtures hold made-up values. Verify with a live key before relying on it.
 */
export const FINNHUB_HOST = "finnhub.io";

const Num = z.number().finite().nullable().optional();
const CalendarPayload = z.object({
  earningsCalendar: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      symbol: z.string().min(1),
      hour: z.string().nullable().optional(),
      quarter: z.number().int().nullable().optional(),
      year: z.number().int().nullable().optional(),
      epsEstimate: Num,
      epsActual: Num,
      revenueEstimate: Num,
      revenueActual: Num,
    }),
  ),
});

export interface FinnhubOptions extends Pick<
  HttpClientOptions,
  "fetch" | "sleep" | "random" | "onResponse"
> {
  apiKey: string;
  /** Shared quota limiter (free plan: 60 calls/minute; we stay at 30). */
  rateLimiter?: RateLimiter;
  baseUrl?: string;
  now?: () => Date;
}

export class FinnhubProvider extends BaseProvider {
  readonly id = "finnhub" as const;
  readonly http: HttpClient;
  private readonly base: string;
  private readonly now: () => Date;

  constructor(opts: FinnhubOptions) {
    super();
    const override = opts.baseUrl ? new URL(opts.baseUrl) : null;
    this.base = override ? override.origin : `https://${FINNHUB_HOST}`;
    this.now = opts.now ?? (() => new Date());
    this.http = new HttpClient({
      provider: this.id,
      allowedHosts: [override ? override.host : FINNHUB_HOST],
      headers: { "x-finnhub-token": opts.apiKey },
      redactQueryParams: ["token"],
      rateLimiter: opts.rateLimiter,
      fetch: opts.fetch,
      sleep: opts.sleep,
      random: opts.random,
      onResponse: opts.onResponse,
    });
  }

  override async getEarningsCalendar(req: {
    from: IsoDate;
    to: IsoDate;
  }): Promise<EarningsEvent[]> {
    const fetchedAt = this.now();
    const url = new URL("/api/v1/calendar/earnings", this.base);
    url.searchParams.set("from", req.from);
    url.searchParams.set("to", req.to);
    const payload = parseVendor(
      this.id,
      CalendarPayload,
      await this.http.getJson(url),
      "earnings calendar",
    );
    return payload.earningsCalendar.map((e) =>
      parseVendor(
        this.id,
        EarningsEvent,
        {
          source: this.id,
          source_symbol: e.symbol,
          fetched_at: fetchedAt,
          as_of: fetchedAt,
          license_tier: "personal_dev",
          report_date: e.date,
          hour: e.hour === "bmo" || e.hour === "amc" || e.hour === "dmh" ? e.hour : null,
          fiscal_year: e.year ?? null,
          fiscal_quarter: e.quarter && e.quarter >= 1 && e.quarter <= 4 ? e.quarter : null,
          eps_estimate: e.epsEstimate ?? null,
          eps_actual: e.epsActual ?? null,
          revenue_estimate: e.revenueEstimate ?? null,
          revenue_actual: e.revenueActual ?? null,
        },
        "earnings event",
      ),
    );
  }

  override async healthCheck(): Promise<void> {
    const today = this.now().toISOString().slice(0, 10);
    await this.getEarningsCalendar({ from: today, to: today });
  }
}
