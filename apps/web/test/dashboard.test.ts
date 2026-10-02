import { describe, expect, it } from "vitest";
import {
  applyChange,
  DEFAULT_LAYOUT,
  dropOrder,
  LayoutChange,
  normalizeLayout,
  WIDGET_IDS,
  type Layout,
} from "../src/lib/dashboard";

/** The dashboard layout (Phase 2 step F2): stored layouts made safe, and each editor change. */
const ids = (l: Layout) => l.map((w) => w.id);
const visibleIds = (l: Layout) => l.filter((w) => !w.hidden).map((w) => w.id);

describe("normalizeLayout", () => {
  it("starts from the defaults", () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(ids(DEFAULT_LAYOUT)).toEqual(WIDGET_IDS);
  });

  it("keeps a saved order, drops junk and duplicates, and appends widgets added later", () => {
    const saved = [
      { id: "losers", size: "full", hidden: false },
      { id: "nope", size: "half", hidden: false },
      { id: "losers", size: "half", hidden: true },
      { id: "alerts", size: "half", hidden: true, extra: 1 },
      "garbage",
      { id: "screen", size: "full", hidden: false, screenId: "x" },
    ];
    const l = normalizeLayout(saved);
    expect(ids(l).slice(0, 2)).toEqual(["losers", "alerts"]);
    expect(l[0]).toEqual({ id: "losers", size: "full", hidden: false });
    expect(l[1]).toEqual({ id: "alerts", size: "half", hidden: true });
    expect(new Set(ids(l))).toEqual(new Set(WIDGET_IDS));
    // The screen item with a bad id was dropped and comes back as the default.
    expect(l.find((w) => w.id === "screen")).toEqual({ id: "screen", size: "full", hidden: false });
  });
});

describe("applyChange", () => {
  it("moves among the visible widgets, skipping hidden ones", () => {
    const hidden = applyChange(DEFAULT_LAYOUT, { type: "hidden", id: "alerts", hidden: true });
    const moved = applyChange(hidden, { type: "move", id: "gainers", delta: -1 });
    expect(visibleIds(moved).slice(0, 3)).toEqual(["indices", "gainers", "watchlists"]);
    // Already first: nothing changes.
    expect(applyChange(DEFAULT_LAYOUT, { type: "move", id: "indices", delta: -1 })).toEqual(
      DEFAULT_LAYOUT,
    );
    expect(applyChange(DEFAULT_LAYOUT, { type: "move", id: "screen", delta: 1 })).toEqual(
      DEFAULT_LAYOUT,
    );
  });

  it("resizes, hides, shows, picks a screen and resets", () => {
    let l = applyChange(DEFAULT_LAYOUT, { type: "size", id: "alerts", size: "full" });
    expect(l.find((w) => w.id === "alerts")?.size).toBe("full");
    l = applyChange(l, { type: "hidden", id: "calendar", hidden: true });
    expect(visibleIds(l)).not.toContain("calendar");
    l = applyChange(l, { type: "screen", screenId: "42" });
    expect(l.find((w) => w.id === "screen")?.screenId).toBe("42");
    expect(applyChange(l, { type: "reset" })).toEqual(DEFAULT_LAYOUT);
  });

  it("takes a dropped order for the visible widgets and keeps hidden ones", () => {
    const hidden = applyChange(DEFAULT_LAYOUT, { type: "hidden", id: "portfolio", hidden: true });
    const order = dropOrder(hidden, "screen", "indices");
    expect(order.slice(0, 2)).toEqual(["screen", "indices"]);
    const l = applyChange(hidden, { type: "order", ids: order });
    expect(visibleIds(l)).toEqual(order);
    expect(l.find((w) => w.id === "portfolio")?.hidden).toBe(true);
    expect(dropOrder(hidden, "portfolio", "indices")).toEqual(visibleIds(hidden));
  });

  it("validates changes from the browser", () => {
    expect(LayoutChange.safeParse({ type: "move", id: "indices", delta: 2 }).success).toBe(false);
    expect(LayoutChange.safeParse({ type: "hidden", id: "evil", hidden: true }).success).toBe(
      false,
    );
    expect(LayoutChange.safeParse({ type: "screen", screenId: "1; drop" }).success).toBe(false);
    expect(LayoutChange.safeParse({ type: "order", ids: [] }).success).toBe(false);
  });
});
