import type { Dataset, LicenseTier, ProviderId } from "./types";

/**
 * The `data_licenses` config (spec §2.2): what the system may do with each provider's data.
 * docs/DATA_SOURCES.md records the plan, terms URL and verification date for each entry; the
 * two must be updated together.
 *
 * Audiences: "none" (not displayable), "owner" (a personal plan: the owner's own screen only,
 * ADR-015), "public" (anyone). Showing a personal plan's data to anyone else needs a display
 * contract first.
 */

export type DisplayAudience = "none" | "owner" | "public";
export type Viewer = "owner" | "public";

export interface Attribution {
  provider: ProviderId;
  text: string;
  url?: string;
}

export interface DataLicense {
  provider: ProviderId;
  plan: string;
  status: "synthetic" | "public" | "personal" | "contracted" | "not_contracted";
  /** Stamped on every record fetched from this provider. */
  licenseTier: LicenseTier;
  display: {
    /** Who may see this data. */
    audience: DisplayAudience;
    realtime: boolean;
    /** Minimum delay for intraday display to non-entitled users; null = no intraday display. */
    intradayDelayMinutes: number | null;
    datasets: readonly Dataset[];
  };
  exportAllowed: boolean;
  attribution: Attribution;
  termsUrl: string | null;
  verifiedOn: string | null;
}

export const DATA_LICENSES: Readonly<Record<ProviderId, DataLicense>> = {
  synthetic: {
    provider: "synthetic",
    plan: "Generated test data",
    status: "synthetic",
    licenseTier: "synthetic",
    display: {
      audience: "public",
      realtime: false,
      intradayDelayMinutes: null,
      datasets: ["securities", "daily_bars", "corporate_actions"],
    },
    exportAllowed: false,
    attribution: { provider: "synthetic", text: "SAMPLE DATA: synthetic, not real market data" },
    termsUrl: null,
    verifiedOn: null,
  },
  tiingo: {
    provider: "tiingo",
    plan: "Personal plan (free tier or Power): the owner's own use only. Showing it to anyone else needs EOD + IEX display redistribution.",
    status: "personal",
    licenseTier: "personal_dev",
    display: {
      audience: "owner",
      realtime: false,
      intradayDelayMinutes: null,
      datasets: ["securities", "daily_bars", "corporate_actions"],
    },
    exportAllowed: false,
    attribution: {
      provider: "tiingo",
      text: "Data provided by Tiingo",
      url: "https://www.tiingo.com",
    },
    termsUrl: "https://www.tiingo.com/about/pricing",
    verifiedOn: null,
  },
  twelvedata: {
    provider: "twelvedata",
    plan: "Not contracted. Display requires a Business plan (Venture or above).",
    status: "not_contracted",
    licenseTier: "personal_dev",
    display: { audience: "none", realtime: false, intradayDelayMinutes: null, datasets: [] },
    exportAllowed: false,
    attribution: {
      provider: "twelvedata",
      text: "Data provided by Twelve Data",
      url: "https://twelvedata.com",
    },
    termsUrl: "https://twelvedata.com/pricing-business",
    verifiedOn: null,
  },
  massive: {
    provider: "massive",
    plan: "Not contracted. Display requires Stocks Business.",
    status: "not_contracted",
    licenseTier: "personal_dev",
    display: { audience: "none", realtime: false, intradayDelayMinutes: null, datasets: [] },
    exportAllowed: false,
    attribution: {
      provider: "massive",
      text: "Data provided by Massive",
      url: "https://massive.com",
    },
    termsUrl: "https://massive.com/business-stocks",
    verifiedOn: null,
  },
  sec_edgar: {
    provider: "sec_edgar",
    plan: "Public EDGAR APIs (fair-access policy: <=10 req/s, declared User-Agent)",
    status: "public",
    licenseTier: "public_domain",
    display: {
      audience: "public",
      realtime: false,
      intradayDelayMinutes: null,
      datasets: ["fundamentals", "filings"],
    },
    exportAllowed: true,
    attribution: {
      provider: "sec_edgar",
      text: "Source: SEC EDGAR",
      url: "https://www.sec.gov/edgar",
    },
    termsUrl: "https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data",
    verifiedOn: "2026-09-30",
  },
  fred: {
    provider: "fred",
    plan: "FRED API (free key). Only series without third-party copyright notes.",
    status: "public",
    licenseTier: "public_domain",
    display: {
      audience: "public",
      realtime: false,
      intradayDelayMinutes: null,
      datasets: ["macro"],
    },
    exportAllowed: false,
    attribution: {
      provider: "fred",
      // Exact notice required by the FRED API Terms of Use.
      text: "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
      url: "https://fred.stlouisfed.org",
    },
    termsUrl: "https://fred.stlouisfed.org/docs/api/terms_of_use.html",
    verifiedOn: "2026-09-30",
  },
  finnhub: {
    provider: "finnhub",
    plan: "Free personal key: the owner's own use only. Commercial use needs Finnhub's written approval.",
    status: "personal",
    licenseTier: "personal_dev",
    display: {
      audience: "owner",
      realtime: false,
      intradayDelayMinutes: null,
      datasets: ["earnings"],
    },
    exportAllowed: false,
    attribution: { provider: "finnhub", text: "Earnings data: Finnhub", url: "https://finnhub.io" },
    termsUrl: "https://finnhub.io/terms-of-service",
    verifiedOn: null,
  },
  treasury: {
    provider: "treasury",
    plan: "Public Treasury yield curve data",
    status: "public",
    licenseTier: "public_domain",
    display: {
      audience: "public",
      realtime: false,
      intradayDelayMinutes: null,
      datasets: ["macro"],
    },
    exportAllowed: true,
    attribution: { provider: "treasury", text: "Source: U.S. Department of the Treasury" },
    termsUrl: null,
    verifiedOn: null,
  },
};

export function licenseFor(provider: ProviderId): DataLicense {
  return DATA_LICENSES[provider];
}

/**
 * May this provider's data for `dataset` be shown to `viewer` in `appEnv`? Synthetic data is
 * never displayable in production (MUST-NOT #2); personal-plan data only to the owner;
 * uncontracted commercial data to nobody.
 */
export function canDisplay(
  provider: ProviderId,
  dataset: Dataset,
  ctx: { appEnv: string; viewer: Viewer },
): boolean {
  const license = licenseFor(provider);
  if (!license.display.datasets.includes(dataset)) return false;
  if (license.status === "synthetic") return ctx.appEnv !== "production";
  const audience = license.display.audience;
  return audience === "public" || (audience === "owner" && ctx.viewer === "owner");
}

/**
 * Drops intraday records that a non-entitled user may not see yet (spec §2.2): everything newer
 * than now minus the license delay, or everything if the license allows no intraday display.
 * Callers pass `licenseFor(provider)`.
 */
export function enforceDelay<T extends { as_of: Date }>(
  records: readonly T[],
  opts: { license: DataLicense; entitledRealtime: boolean; now: Date },
): T[] {
  const { license } = opts;
  if (license.display.realtime && opts.entitledRealtime) return [...records];
  const delay = license.display.intradayDelayMinutes;
  if (license.display.audience === "none" || delay === null) return [];
  const cutoff = opts.now.getTime() - delay * 60_000;
  return records.filter((r) => r.as_of.getTime() <= cutoff);
}

/** Attribution lines for the providers whose data is on a page, deduplicated, in order. */
export function attributionsFor(providers: Iterable<ProviderId>): Attribution[] {
  const seen = new Set<ProviderId>();
  const out: Attribution[] = [];
  for (const p of providers) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(licenseFor(p).attribution);
  }
  return out;
}
