import { describe, expect, it } from "vitest";
import { NAV, splitNav, visibleNav } from "../src/lib/nav";

describe("phone navigation", () => {
  it("keeps four sections in the bottom bar and the rest under More, in order", () => {
    const { bar, more } = splitNav(NAV);
    expect(bar.map((i) => i.label)).toEqual(["Markets", "Screener", "Watchlists", "Portfolio"]);
    expect(more.map((i) => i.label)).toEqual(
      NAV.filter((i) => !bar.includes(i)).map((i) => i.label),
    );
  });

  it("never hides a bar section behind a feature switch, so the bar always has five slots", () => {
    expect(splitNav(NAV).bar.every((i) => i.flag === undefined)).toBe(true);
    expect(splitNav(visibleNav({})).bar).toHaveLength(4);
    expect(splitNav(visibleNav({})).more.map((i) => i.label)).not.toContain("Backtests");
  });
});
