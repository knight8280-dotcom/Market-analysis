import { describe, expect, it } from "vitest";
import {
  buildRoutingTable,
  initialRouteState,
  onPrimaryFailure,
  onPrimaryProbe,
  onStalenessBreach,
} from "../src/routing";

const now = new Date("2026-09-29T22:31:00Z");

describe("routing table", () => {
  it("routes prices to the configured providers and fundamentals/macro to government sources", () => {
    const table = buildRoutingTable({ primary: "tiingo", fallback: "synthetic" });
    expect(table.daily_bars).toEqual({ primary: "tiingo", fallback: "synthetic" });
    expect(table.fundamentals).toEqual({ primary: "sec_edgar", fallback: null });
    expect(table.macro).toEqual({ primary: "fred", fallback: null });
  });
});

describe("failover decisions", () => {
  const start = initialRouteState("daily_bars", { primary: "tiingo", fallback: "synthetic" });

  it("waits for the failure threshold before failing over", () => {
    expect(onPrimaryFailure(start, 2, "HTTP 503", now).event).toBeUndefined();
    const d = onPrimaryFailure(start, 3, "HTTP 503", now);
    expect(d.state.active).toBe("synthetic");
    expect(d.event).toMatchObject({ type: "provider_failover", from: "tiingo", to: "synthetic" });
  });

  it("fails over immediately on a staleness breach, once", () => {
    const d = onStalenessBreach(start, "no bars for 2026-09-29", now);
    expect(d.state).toMatchObject({ active: "synthetic", failedOverAt: now });
    expect(onStalenessBreach(d.state, "still stale", now).event).toBeUndefined();
  });

  it("routes to no provider when there is no fallback", () => {
    const noFallback = initialRouteState("daily_bars", { primary: "tiingo", fallback: null });
    const d = onStalenessBreach(noFallback, "stale", now);
    expect(d.state.active).toBeNull();
    expect(d.event).toMatchObject({ type: "provider_failover", to: null });
  });

  it("fails back after enough healthy probes of the primary", () => {
    const failed = onStalenessBreach(start, "stale", now).state;
    expect(onPrimaryProbe(failed, 2, now).event).toBeUndefined();
    const d = onPrimaryProbe(failed, 3, now);
    expect(d.state).toMatchObject({ active: "tiingo", failedOverAt: null, reason: null });
    expect(d.event).toMatchObject({ type: "provider_failback", from: "synthetic", to: "tiingo" });
    expect(onPrimaryProbe(d.state, 5, now).event).toBeUndefined();
  });
});
