import { describe, expect, it } from "vitest";
import {
  codeInfo,
  insiderFlows,
  ownersLabel,
  purchaseClusters,
  roleOf,
  TRANSACTION_CODES,
  type InsiderLine,
  type OwnerLike,
} from "../src";

const owner = (name: string, extra: Partial<OwnerLike> = {}): OwnerLike => ({
  cik: null,
  name,
  is_director: false,
  is_officer: false,
  officer_title: null,
  is_ten_percent_owner: false,
  is_other: false,
  other_text: null,
  ...extra,
});

let n = 0;
const line = (
  who: OwnerLike | OwnerLike[],
  date: string,
  extra: Partial<InsiderLine> = {},
): InsiderLine => ({
  accession_no: `0000000000-26-${String((n += 1)).padStart(6, "0")}`,
  form_type: "4",
  owners: Array.isArray(who) ? who : [who],
  transaction_date: date,
  code: "P",
  derivative: false,
  acquired_disposed: "A",
  shares: 100,
  price: 10,
  ...extra,
});

describe("transaction codes", () => {
  it("lists SEC's twenty codes once each, with SEC's wording", () => {
    expect(TRANSACTION_CODES).toHaveLength(20);
    expect(new Set(TRANSACTION_CODES.map((c) => c.code)).size).toBe(20);
    expect(codeInfo("P").description).toBe(
      "Open market or private purchase of non-derivative or derivative security",
    );
    expect(codeInfo("F").group).toBe("rule16b3");
  });

  it("says when a code is not SEC's rather than guessing", () => {
    expect(codeInfo("Q")).toMatchObject({ label: "Code Q", group: "other" });
    expect(codeInfo("Q").description).toMatch(/Not a code listed/);
  });
});

describe("insiders", () => {
  it("describes roles and joint filers", () => {
    expect(roleOf(owner("A", { is_director: true, is_officer: true, officer_title: "CEO" }))).toBe(
      "Director, CEO",
    );
    expect(roleOf(owner("B", { is_officer: true }))).toBe("Officer");
    expect(roleOf(owner("C", { is_ten_percent_owner: true }))).toBe("10% owner");
    expect(roleOf(owner("D", { is_other: true, other_text: "Former 10% Owner" }))).toBe(
      "Other: Former 10% Owner",
    );
    expect(roleOf(owner("E"))).toBe("Reporting person");
    expect(ownersLabel([owner("FUND LP")])).toBe("FUND LP");
    expect(ownersLabel([owner("FUND LP"), owner("GP LLC"), owner("ADVISER")])).toBe(
      "FUND LP and 2 others",
    );
  });
});

describe("purchaseClusters", () => {
  const a = owner("Alice", { cik: "0000000001" });
  const b = owner("Bob", { cik: "0000000002" });
  const c = owner("Carol", { cik: "0000000003" });
  const d = owner("Dan", { cik: "0000000004" });

  it("finds three different insiders buying within 30 days", () => {
    const clusters = purchaseClusters([
      line(a, "2026-03-02"),
      line(b, "2026-03-10"),
      line(c, "2026-04-01"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      from: "2026-03-02",
      to: "2026-04-01",
      insiders: ["Alice", "Bob", "Carol"],
    });
    expect(clusters[0]!.filings).toHaveLength(3);
  });

  it("needs different insiders, open-market purchases, and the window", () => {
    // The same person three times.
    expect(
      purchaseClusters([line(a, "2026-03-02"), line(a, "2026-03-03"), line(a, "2026-03-04")]),
    ).toEqual([]);
    // Joint filers are one insider.
    expect(
      purchaseClusters([
        line([a, b], "2026-03-02"),
        line([a, c], "2026-03-03"),
        line(d, "2026-03-04"),
      ]),
    ).toEqual([]);
    // Spread over more than 30 days.
    expect(
      purchaseClusters([line(a, "2026-03-01"), line(b, "2026-03-20"), line(c, "2026-04-01")]),
    ).toEqual([]);
    // Awards, derivative purchases and sales are not open-market purchases.
    expect(
      purchaseClusters([
        line(a, "2026-03-02", { code: "A" }),
        line(b, "2026-03-03", { derivative: true }),
        line(c, "2026-03-04", { code: "S", acquired_disposed: "D" }),
        line(d, "2026-03-05"),
      ]),
    ).toEqual([]);
  });

  it("merges overlapping periods into one cluster", () => {
    const clusters = purchaseClusters([
      line(a, "2026-01-01"),
      line(b, "2026-01-15"),
      line(c, "2026-01-25"),
      line(d, "2026-02-20"),
      line(a, "2026-02-21"),
      line(b, "2026-07-01"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ from: "2026-01-01", to: "2026-02-21" });
    expect(clusters[0]!.insiders).toEqual(["Alice", "Bob", "Carol", "Dan"]);
  });
});

describe("insiderFlows", () => {
  it("totals open-market purchases and sales from original filings only", () => {
    const a = owner("Alice", { cik: "0000000001" });
    const b = owner("Bob", { cik: "0000000002" });
    const flows = insiderFlows(
      [
        line(a, "2026-05-01", { shares: 100, price: 10 }),
        line(b, "2026-05-02", { shares: 50, price: null }),
        line(a, "2026-05-03", { form_type: "4/A", shares: 100, price: 10 }),
        line(a, "2026-05-04", { code: "S", acquired_disposed: "D", shares: 30, price: 12 }),
        line(b, "2026-05-05", { code: "A", shares: 1000, price: 0 }),
        line(b, "2026-03-01", { shares: 999, price: 1 }),
      ],
      "2026-04-01",
    );
    expect(flows.purchases).toEqual({ lines: 2, insiders: 2, shares: 150, value: 1000, priced: 1 });
    expect(flows.sales).toEqual({ lines: 1, insiders: 1, shares: 30, value: 360, priced: 1 });
    expect(flows.amendmentsLeftOut).toBe(1);
  });
});
