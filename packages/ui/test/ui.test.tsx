import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  cn,
  Delta,
  formatCompact,
  formatDate,
  formatDateTimeET,
  formatPercent,
  formatPrice,
} from "../src";

describe("format", () => {
  it("formats prices, keeping sub-dollar precision", () => {
    expect(formatPrice("227.5")).toBe("$227.50");
    expect(formatPrice(0.1234)).toBe("$0.1234");
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice("not a number")).toBe("—");
  });

  it("formats signed percentages with a real minus sign", () => {
    expect(formatPercent(0.0123)).toBe("+1.23%");
    expect(formatPercent(-0.0123)).toBe("−1.23%");
    expect(formatPercent(0)).toBe("0.00%");
  });

  it("formats compact numbers and calendar dates without a zone shift", () => {
    expect(formatCompact(1_234_567)).toBe("1.23M");
    expect(formatDate("2026-09-29")).toBe("Sep 29, 2026");
    expect(formatDate(null)).toBe("—");
  });

  it("formats instants in exchange time", () => {
    expect(formatDateTimeET(new Date("2026-09-29T20:31:00Z"))).toBe("Sep 29, 2026, 4:31 PM ET");
  });
});

describe("Delta", () => {
  it("never relies on color alone", () => {
    const up = renderToStaticMarkup(<Delta fraction={0.0123} />);
    expect(up).toContain("+1.23%");
    expect(up).toContain("text-up");
    expect(up).toContain(">up </span>");
    expect(up).toContain("<svg");
    const down = renderToStaticMarkup(<Delta fraction="-0.5" />);
    expect(down).toContain("−50.00%");
    expect(down).toContain(">down </span>");
    expect(renderToStaticMarkup(<Delta fraction={null} />)).toContain("—");
  });
});

describe("cn", () => {
  it("lets later utilities win", () => {
    expect(cn("px-2 text-sm", false, "px-4")).toBe("text-sm px-4");
  });
});
