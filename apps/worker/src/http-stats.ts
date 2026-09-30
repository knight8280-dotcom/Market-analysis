import type { MarketDataProvider } from "@market/market-data";

type WithHttp = { http: { statusCounts: Map<number, number> } };

function counts(provider: MarketDataProvider): Map<number, number> | null {
  return "http" in provider ? (provider as unknown as WithHttp).http.statusCounts : null;
}

/** Copy of the provider's HTTP status counters (adapters without HTTP have none). */
export function statusSnapshot(provider: MarketDataProvider): Map<number, number> {
  return new Map(counts(provider) ?? []);
}

/** Responses by status since `before`, for one ingestion run record. */
export function statusDelta(
  provider: MarketDataProvider,
  before: ReadonlyMap<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [status, n] of counts(provider) ?? []) {
    const d = n - (before.get(status) ?? 0);
    if (d > 0) out.set(status, d);
  }
  return out;
}
