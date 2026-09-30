import type { IsoDate } from "@market/calendar";
import { z } from "zod";
import { LicenseRestrictedError, ProviderResponseError } from "../errors";
import { HttpClient, type HttpClientOptions } from "../http";
import { BaseProvider } from "../provider";
import { MacroObservation, MacroSeries } from "../types";
import { parseVendor } from "./common";

/**
 * FRED adapter (spec §2.4). The API key travels as a query parameter, so HttpClient redacts it
 * from every error and log line. Series whose notes carry a third-party copyright are refused:
 * FRED's terms say only the owner can permit their use (LicenseRestrictedError).
 */

export const FRED_HOST = "api.stlouisfed.org";

const SeriesPayload = z.object({
  seriess: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        observation_start: z.string(),
        observation_end: z.string(),
        frequency: z.string(),
        units: z.string(),
        seasonal_adjustment: z.string(),
        last_updated: z.string(),
        notes: z.string().optional(),
      }),
    )
    .min(1),
});

const ObservationsPayload = z.object({
  count: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  observations: z.array(
    z.object({
      realtime_start: z.string(),
      realtime_end: z.string(),
      date: z.string(),
      value: z.string(),
    }),
  ),
});

export interface FredOptions extends Pick<
  HttpClientOptions,
  "fetch" | "sleep" | "random" | "onResponse"
> {
  apiKey: string;
  /** Test override, e.g. "http://127.0.0.1:1234". */
  baseUrl?: string;
  now?: () => Date;
}

/** FRED writes "2026-09-29 07:46:03-05"; turn it into ISO 8601. */
export function parseFredTimestamp(value: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class FredProvider extends BaseProvider {
  readonly id = "fred" as const;
  readonly http: HttpClient;
  private readonly base: string;
  private readonly apiKey: string;
  private readonly now: () => Date;

  constructor(opts: FredOptions) {
    super();
    const override = opts.baseUrl ? new URL(opts.baseUrl) : null;
    this.base = override ? override.origin : `https://${FRED_HOST}`;
    this.apiKey = opts.apiKey;
    this.now = opts.now ?? (() => new Date());
    this.http = new HttpClient({
      provider: this.id,
      allowedHosts: [override ? override.host : FRED_HOST],
      redactQueryParams: ["api_key"],
      fetch: opts.fetch,
      sleep: opts.sleep,
      random: opts.random,
      onResponse: opts.onResponse,
    });
  }

  private url(path: string, params: Record<string, string>): URL {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("file_type", "json");
    return url;
  }

  override async getMacroSeries(req: { seriesId: string }): Promise<MacroSeries> {
    const fetchedAt = this.now();
    const raw = await this.http.getJson(this.url("/fred/series", { series_id: req.seriesId }));
    const s = parseVendor(this.id, SeriesPayload, raw, "series").seriess[0]!;
    if (/copyright/i.test(s.notes ?? "")) {
      throw new LicenseRestrictedError(
        this.id,
        `FRED series ${s.id} carries a third-party copyright; it needs the owner's permission`,
      );
    }
    return parseVendor(
      this.id,
      MacroSeries,
      {
        source: this.id,
        source_symbol: s.id,
        fetched_at: fetchedAt,
        as_of: parseFredTimestamp(s.last_updated) ?? fetchedAt,
        license_tier: "public_domain",
        series_id: s.id,
        title: s.title,
        units: s.units || null,
        frequency: s.frequency || null,
        seasonal_adjustment: s.seasonal_adjustment || null,
        last_updated: parseFredTimestamp(s.last_updated),
        observation_start: s.observation_start || null,
        observation_end: s.observation_end || null,
      },
      "series",
    );
  }

  override async getMacroObservations(req: {
    seriesId: string;
    start?: IsoDate;
  }): Promise<MacroObservation[]> {
    const fetchedAt = this.now();
    const params: Record<string, string> = { series_id: req.seriesId };
    if (req.start) params.observation_start = req.start;
    const raw = await this.http.getJson(this.url("/fred/series/observations", params));
    const payload = parseVendor(this.id, ObservationsPayload, raw, "observations");
    if (payload.count > payload.offset + payload.observations.length) {
      // Never silently truncate a series.
      throw new ProviderResponseError(
        this.id,
        `FRED returned ${payload.observations.length} of ${payload.count} observations; pagination is not implemented`,
      );
    }
    return payload.observations.map((o) =>
      parseVendor(
        this.id,
        MacroObservation,
        {
          source: this.id,
          source_symbol: req.seriesId,
          fetched_at: fetchedAt,
          as_of: new Date(`${o.realtime_start}T00:00:00Z`),
          license_tier: "public_domain",
          series_id: req.seriesId,
          date: o.date,
          // FRED marks a missing observation with "."; it stays missing (MUST-NOT #1).
          value: o.value === "." ? null : Number(o.value),
          realtime_start: o.realtime_start,
        },
        "observation",
      ),
    );
  }

  override async healthCheck(): Promise<void> {
    await this.http.getJson(this.url("/fred/series", { series_id: "DGS10" }));
  }
}
