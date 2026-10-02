import { zonedTimeToUtc, type IsoDate } from "@market/calendar";
import { z } from "zod";
import { ProviderError } from "../errors";
import { HttpClient, type HttpClientOptions } from "../http";
import { BaseProvider } from "../provider";
import { ShortInterestRecord } from "../types";
import { parseVendor } from "./common";

/**
 * FINRA equity short interest (Phase 2 step H3, spec §2.5, ADR-033) from FINRA's Query API,
 * with the owner's free Public credential: an OAuth client-credentials token from FINRA's
 * identity platform, then POST queries with filters in the body. FINRA's terms allow
 * non-commercial personal use, require naming FINRA as owner and source, and count every API
 * call as needing a credential.
 *
 * SHAPE PARTLY VERIFIED: the record's fields and types match FINRA's published short interest
 * as seen on 2026-10-02; the token exchange and the POST filter syntax follow FINRA's developer
 * documentation and are unverified until a credential exists. Fixtures hold made-up values:
 * FINRA's data may not be republished, and this repository is public.
 */
export const FINRA_HOSTS = { token: "ews.fip.finra.org", api: "api.finra.org" } as const;
const TOKEN_PATH = "/fip/rest/ews/oauth2/access_token";
const DATASET_PATH = "/data/group/otcMarket/name/consolidatedShortInterest";
/** FINRA's largest synchronous page. */
export const FINRA_PAGE = 5000;
const SYMBOLS_PER_QUERY = 100;
/** FINRA suggests reusing a token for 30 minutes. */
const TOKEN_REUSE_MS = 30 * 60_000;

const TokenPayload = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().positive().optional(),
});

const Row = z.object({
  symbolCode: z.string().min(1),
  issueName: z.string().nullable().optional(),
  marketClassCode: z.string().nullable().optional(),
  currentShortPositionQuantity: z.number().int().nonnegative(),
  previousShortPositionQuantity: z.number().int().nonnegative().nullable().optional(),
  averageDailyVolumeQuantity: z.number().int().nonnegative().nullable().optional(),
  daysToCoverQuantity: z.number().nonnegative().nullable().optional(),
  revisionFlag: z.string().nullable().optional(),
  stockSplitFlag: z.string().nullable().optional(),
  settlementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface FinraOptions extends Pick<
  HttpClientOptions,
  "fetch" | "sleep" | "random" | "onResponse" | "maxRetries"
> {
  clientId: string;
  clientSecret: string;
  /** Test override for both hosts, e.g. "http://127.0.0.1:1234". */
  baseUrl?: string;
  now?: () => Date;
}

export class FinraProvider extends BaseProvider {
  readonly id = "finra" as const;
  readonly http: HttpClient;
  private readonly tokenBase: string;
  private readonly apiBase: string;
  private readonly basic: string;
  private readonly now: () => Date;
  private token: { value: string; until: number } | null = null;

  constructor(opts: FinraOptions) {
    super();
    const override = opts.baseUrl ? new URL(opts.baseUrl) : null;
    this.tokenBase = override ? override.origin : `https://${FINRA_HOSTS.token}`;
    this.apiBase = override ? override.origin : `https://${FINRA_HOSTS.api}`;
    this.basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    this.now = opts.now ?? (() => new Date());
    this.http = new HttpClient({
      provider: this.id,
      allowedHosts: override ? [override.host] : [FINRA_HOSTS.token, FINRA_HOSTS.api],
      fetch: opts.fetch,
      sleep: opts.sleep,
      random: opts.random,
      onResponse: opts.onResponse,
      maxRetries: opts.maxRetries,
    });
  }

  private async bearer(): Promise<string> {
    const now = this.now().getTime();
    if (this.token && this.token.until > now) return this.token.value;
    const raw = await this.http.postJson(
      `${this.tokenBase}${TOKEN_PATH}?grant_type=client_credentials`,
      undefined,
      { headers: { authorization: `Basic ${this.basic}` } },
    );
    const t = parseVendor(this.id, TokenPayload, raw, "FINRA token");
    const lifetime = t.expires_in ? t.expires_in * 1000 - 60_000 : TOKEN_REUSE_MS;
    this.token = {
      value: t.access_token,
      until: now + Math.max(0, Math.min(lifetime, TOKEN_REUSE_MS)),
    };
    return t.access_token;
  }

  /** One query; an expired token (401) is replaced once. */
  private async query(body: unknown): Promise<unknown> {
    const send = async () =>
      this.http.postJson(`${this.apiBase}${DATASET_PATH}`, body, {
        headers: { authorization: `Bearer ${await this.bearer()}` },
      });
    try {
      return await send();
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401 && this.token) {
        this.token = null;
        return send();
      }
      throw err;
    }
  }

  /** Short interest for FINRA symbol codes with settlement dates in [from, to]. */
  async getShortInterest(req: {
    symbols: readonly string[];
    from: IsoDate;
    to: IsoDate;
  }): Promise<ShortInterestRecord[]> {
    const fetchedAt = this.now();
    const out: ShortInterestRecord[] = [];
    const symbols = [...new Set(req.symbols)].sort();
    for (let i = 0; i < symbols.length; i += SYMBOLS_PER_QUERY) {
      const batch = symbols.slice(i, i + SYMBOLS_PER_QUERY);
      for (let offset = 0; ; offset += FINRA_PAGE) {
        const raw = await this.query({
          limit: FINRA_PAGE,
          offset,
          dateRangeFilters: [{ fieldName: "settlementDate", startDate: req.from, endDate: req.to }],
          domainFilters: [{ fieldName: "symbolCode", values: batch }],
        });
        // An empty body means no records.
        const rows = parseVendor(this.id, z.array(Row), raw ?? [], "short interest");
        for (const r of rows) {
          const volume = r.averageDailyVolumeQuantity ?? null;
          out.push(
            parseVendor(
              this.id,
              ShortInterestRecord,
              {
                source: this.id,
                source_symbol: r.symbolCode,
                fetched_at: fetchedAt,
                as_of: zonedTimeToUtc(r.settlementDate, "16:00"),
                license_tier: "personal_dev",
                settlement_date: r.settlementDate,
                issue_name: r.issueName?.trim() || null,
                market_class: r.marketClassCode?.trim() || null,
                short_interest: r.currentShortPositionQuantity,
                previous_short_interest: r.previousShortPositionQuantity ?? null,
                avg_daily_volume: volume,
                // With no volume there is no ratio; FINRA prints 999.99 there.
                days_to_cover: volume ? (r.daysToCoverQuantity ?? null) : null,
                revised: Boolean(r.revisionFlag?.trim()),
                split_adjusted: Boolean(r.stockSplitFlag?.trim()),
              },
              "short interest row",
            ),
          );
        }
        if (rows.length < FINRA_PAGE) break;
      }
    }
    return out;
  }

  override async healthCheck(): Promise<void> {
    this.token = null;
    await this.bearer();
  }
}
