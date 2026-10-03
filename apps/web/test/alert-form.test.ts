import { describe, expect, it } from "vitest";
import {
  channelsFrom,
  chosenForms,
  definitionFrom,
  safeReturnPath,
  SNOOZE_CHOICES,
} from "../src/lib/alert-form";

/** The new-alert form's fields → definitions (Phase 2 step E1), and safe return paths (E3). */
function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  }
  return f;
}

describe("definitionFrom", () => {
  it("reads every kind's fields as typed", () => {
    expect(definitionFrom(form({ kind: "price_above", price: "$1,200.50" }))).toEqual({
      kind: "price_above",
      params: { price: 1200.5 },
    });
    expect(definitionFrom(form({ kind: "pct_move", pct: "7.5%", direction: "down" }))).toEqual({
      kind: "pct_move",
      params: { pct: 0.075, direction: "down" },
    });
    expect(definitionFrom(form({ kind: "rsi_below", level: "30", period: "14" }))).toEqual({
      kind: "rsi_below",
      params: { level: 30, period: 14 },
    });
    expect(
      definitionFrom(form({ kind: "sma_cross", fast: "1", slow: "200", cross: "below" })),
    ).toEqual({ kind: "sma_cross", params: { fast: 1, slow: 200, direction: "below" } });
    expect(
      definitionFrom(form({ kind: "volume_spike", multiple: "2.5x", lookback: "20" })),
    ).toEqual({ kind: "volume_spike", params: { multiple: 2.5, lookback: 20 } });
    expect(definitionFrom(form({ kind: "screen_membership", change: "enters" }))).toEqual({
      kind: "screen_membership",
      params: { change: "enters" },
    });
    expect(definitionFrom(form({ kind: "insider_purchase", minValue: "$250,000" }))).toEqual({
      kind: "insider_purchase",
      params: { minValue: 250_000 },
    });
    // Blank means any purchase.
    expect(definitionFrom(form({ kind: "insider_purchase", minValue: " " }))).toEqual({
      kind: "insider_purchase",
      params: { minValue: 0 },
    });
  });

  it("collects filing forms from the boxes and the free text, each once", () => {
    const f = form({
      kind: "new_filing",
      forms: ["8-K", "13D", "not-a-choice"],
      otherForms: " 424b2, 8-k ,  sc  13d ",
      amendments: "on",
    });
    expect(chosenForms(f)).toEqual(["8-K", "SC 13D", "SCHEDULE 13D", "424B2"]);
    expect(definitionFrom(f)).toEqual({
      kind: "new_filing",
      params: { forms: ["8-K", "SC 13D", "SCHEDULE 13D", "424B2"], amendments: true },
    });
    expect(definitionFrom(form({ kind: "new_filing", forms: ["10-K"] }))?.params).toEqual({
      forms: ["10-K"],
      amendments: false,
    });
  });

  it("returns null for anything that does not validate", () => {
    const cases: Record<string, string>[] = [
      { kind: "telepathy" },
      { kind: "price_above", price: "" },
      { kind: "price_below", price: "-3" },
      { kind: "rsi_above", level: "101", period: "14" },
      { kind: "sma_cross", fast: "200", slow: "50", cross: "above" },
      { kind: "volume_spike", multiple: "1", lookback: "20" },
      { kind: "new_filing" },
      { kind: "new_filing", otherForms: "10-K/A" },
      { kind: "screen_membership", change: "stays" },
      { kind: "insider_purchase", minValue: "-1" },
      { kind: "insider_purchase", minValue: "lots" },
    ];
    for (const bad of cases) {
      expect(definitionFrom(form(bad)), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("safeReturnPath", () => {
  it("allows only the alert pages and notifications", () => {
    expect(safeReturnPath("/notifications")).toBe("/notifications");
    expect(safeReturnPath("/alerts/42")).toBe("/alerts/42");
    expect(safeReturnPath("/alerts")).toBe("/alerts");
    for (const bad of [
      "https://evil.example/alerts",
      "//evil.example",
      "/alerts/42/../../admin",
      "/notifications?next=//evil",
      "/alerts/x",
      "",
      null,
    ]) {
      expect(safeReturnPath(bad), String(bad)).toBe("/alerts");
    }
  });

  it("offers one day, three days and a week", () => {
    expect(SNOOZE_CHOICES).toEqual([
      { hours: 24, label: "1 day" },
      { hours: 72, label: "3 days" },
      { hours: 168, label: "1 week" },
    ]);
  });
});

describe("channelsFrom", () => {
  it("reads email and push in a fixed order, push only while it is switched on", () => {
    expect(channelsFrom(form({ channels: ["push", "email"] }), true)).toEqual(["email", "push"]);
    expect(channelsFrom(form({ channels: ["push"] }), true)).toEqual(["push"]);
    expect(channelsFrom(form({ channels: ["push"] }), false)).toEqual([]);
    expect(channelsFrom(form({ channels: ["email", "sms"] }), true)).toEqual(["email"]);
    expect(channelsFrom(form({}), true)).toEqual([]);
  });
});
