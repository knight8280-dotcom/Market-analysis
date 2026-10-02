import type { IsoDate } from "@market/calendar";
import { z } from "zod";
import { HttpClient, type HttpClientOptions, type RateLimiter } from "../http";
import { BaseProvider, type NewsPage } from "../provider";
import { EarningsEvent, NewsItem } from "../types";
import { parseVendor } from "./common";

/**
 * Finnhub earnings calendar (Phase 1 step H1) and company news (Phase 2 step I1), on the
 * owner's free personal key (ADR-015). The key goes in the X-Finnhub-Token header, never the
 * URL.
 *
 * SHAPE UNVERIFIED: the payload schemas follow Finnhub's public documentation (earnings checked
 * 2026-09-30, company news 2026-10-02); the fixtures hold made-up values. Verify with a live key
 * before relying on them.
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

/** /company-news: an array of articles; `datetime` is Unix seconds. */
const NewsPayload = z.array(
  z.object({
    id: z.number().int(),
    datetime: z.number().int(),
    headline: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    related: z.string().nullable().optional(),
    image: z.string().nullable().optional(),
  }),
);

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

  /**
   * Company news for one symbol between two dates (inclusive; North American companies, about a
   * year back on the free plan). An article without a headline, without an http(s) link or with
   * an impossible date is left out and reported.
   */
  override async getNews(req: { symbol: string; from: IsoDate; to: IsoDate }): Promise<NewsPage> {
    const fetchedAt = this.now();
    const url = new URL("/api/v1/company-news", this.base);
    url.searchParams.set("symbol", req.symbol);
    url.searchParams.set("from", req.from);
    url.searchParams.set("to", req.to);
    const payload = parseVendor(this.id, NewsPayload, await this.http.getJson(url), "company news");
    const items: NewsItem[] = [];
    const skipped: NewsPage["skipped"] = [];
    const latest = fetchedAt.getTime() + 86_400_000;
    for (const a of payload) {
      const id = String(a.id);
      const publishedAt = new Date(a.datetime * 1000);
      const parsed = NewsItem.safeParse({
        source: this.id,
        source_symbol: req.symbol,
        fetched_at: fetchedAt,
        as_of: publishedAt,
        license_tier: "personal_dev",
        source_id: id,
        url: a.url?.trim(),
        headline: a.headline ?? "",
        described: false,
        summary: a.summary?.trim() ? a.summary : null,
        publisher: a.source?.trim() ? a.source : null,
        category: a.category?.trim() ? a.category : null,
        published_at: publishedAt,
        symbols: [
          ...new Set(
            [req.symbol, ...(a.related ?? "").split(",")].map((x) => x.trim()).filter(Boolean),
          ),
        ].slice(0, 50),
      });
      if (a.datetime < 946_684_800 || publishedAt.getTime() > latest) {
        skipped.push({ id, reason: `publication time ${a.datetime} is not plausible` });
      } else if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        skipped.push({ id, reason: `${issue.path.join(".")}: ${issue.message}` });
      } else {
        items.push(parsed.data);
      }
    }
    return { items, skipped };
  }

  override async healthCheck(): Promise<void> {
    const today = this.now().toISOString().slice(0, 10);
    await this.getEarningsCalendar({ from: today, to: today });
  }
}
