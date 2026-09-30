import { describe, expect, it } from "vitest";
import { FredProvider, parseFredTimestamp } from "../src/adapters/fred";
import { LicenseRestrictedError, ProviderResponseError } from "../src/errors";
import { fixtureFetch } from "./helpers/fixtures";

function provider(routes: Parameters<typeof fixtureFetch>[0]) {
  const f = fixtureFetch(routes);
  const p = new FredProvider({
    apiKey: "fred-key-for-tests-only",
    baseUrl: "https://fred.test",
    fetch: f.fetch,
    sleep: () => Promise.resolve(),
    now: () => new Date("2026-09-30T12:00:00Z"),
  });
  return { p, calls: f.calls };
}

describe("FredProvider", () => {
  it("parses FRED's timestamp format", () => {
    expect(parseFredTimestamp("2026-09-29 16:02:05-05")?.toISOString()).toBe(
      "2026-09-29T21:02:05.000Z",
    );
    expect(parseFredTimestamp("yesterday")).toBeNull();
  });

  it("maps series metadata and sends the key only to FRED", async () => {
    const { p, calls } = provider({ "/fred/series": "fred/series-DGS10.json" });
    const s = await p.getMacroSeries({ seriesId: "DGS10" });
    expect(s).toMatchObject({
      source: "fred",
      license_tier: "public_domain",
      series_id: "DGS10",
      units: "Percent",
      frequency: "Daily",
      observation_start: "1962-01-02",
    });
    expect(s.last_updated?.toISOString()).toBe("2026-09-29T21:02:05.000Z");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("series_id")).toBe("DGS10");
    expect(url.searchParams.get("file_type")).toBe("json");
    expect(url.searchParams.get("api_key")).toBe("fred-key-for-tests-only");
  });

  it("refuses third-party copyrighted series", async () => {
    const { p } = provider({ "/fred/series": "fred/series-TESTCOPY.json" });
    await expect(p.getMacroSeries({ seriesId: "TESTCOPY" })).rejects.toBeInstanceOf(
      LicenseRestrictedError,
    );
  });

  it("keeps missing observations as null and real zeros as zero", async () => {
    const { p, calls } = provider({ "/fred/series/observations": "fred/observations-DGS10.json" });
    const obs = await p.getMacroObservations({ seriesId: "DGS10", start: "2026-09-21" });
    expect(new URL(calls[0]!.url).searchParams.get("observation_start")).toBe("2026-09-21");
    expect(obs.map((o) => [o.date, o.value])).toEqual([
      ["2026-09-23", 4.11],
      ["2026-09-24", null],
      ["2026-09-25", 4.09],
      ["2026-09-28", 0],
    ]);
    expect(obs[0]).toMatchObject({ source_symbol: "DGS10", realtime_start: "2026-09-30" });
  });

  it("refuses to silently truncate a paginated response", async () => {
    const body = JSON.stringify({ count: 5, offset: 0, limit: 2, observations: [] });
    const { p } = provider({ "/fred/series/observations": { status: 200, body } });
    await expect(p.getMacroObservations({ seriesId: "DGS10" })).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  it("never leaks the API key in errors", async () => {
    const { p } = provider({ "/fred/series": { status: 400, body: "{}" } });
    const err = (await p.getMacroSeries({ seriesId: "DGS10" }).then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain("api_key=REDACTED");
    expect(err.message).not.toContain("fred-key-for-tests-only");
  });
});
