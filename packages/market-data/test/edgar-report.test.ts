import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkAgainstReport,
  findStatementReport,
  parseCell,
  parseFilingSummary,
  parseReportDate,
  parseStatementReport,
  shiftDecimal,
} from "../src/edgar-report";
import { STATEMENTS, type LineValue } from "../src/statements";

const recorded = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/sec-edgar/recorded/${name}`, import.meta.url)),
    "utf8",
  );
const ACC = "0000320193-25-000079";

describe("FilingSummary.xml", () => {
  const reports = parseFilingSummary(recorded(`FilingSummary-${ACC}.trimmed.xml`));

  it("lists the reports and finds each primary statement", () => {
    expect(reports.map((r) => r.file)).toContain("R3.htm");
    expect(findStatementReport(reports, "income")?.file).toBe("R3.htm");
    expect(findStatementReport(reports, "balance")?.file).toBe("R5.htm");
    expect(findStatementReport(reports, "cashflow")?.file).toBe("R8.htm");
  });
});

describe("statement pages", () => {
  it("reads the title's scale, the period columns and each row's concept", () => {
    const r = parseStatementReport(recorded(`R3-${ACC}.trimmed.htm`));
    expect(r.usdPower).toBe(6);
    expect(r.sharesPower).toBe(3);
    expect(r.dates).toEqual(["2025-09-27", "2024-09-28", "2023-09-30"]);
    expect(r.rows[0]).toEqual({
      concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
      label: "Net sales",
      cells: ["416161", "391035", "383285"],
    });
  });

  it("reads a balance sheet's instant columns", () => {
    const r = parseStatementReport(recorded(`R5-${ACC}.trimmed.htm`));
    expect(r.dates).toEqual(["2025-09-27", "2024-09-28"]);
    expect(r.rows.find((x) => x.concept === "us-gaap:Assets")?.cells[0]).toBe("359241");
  });

  it("parses dates and cells defensively", () => {
    expect(parseReportDate("Sep. 27, 2025")).toBe("2025-09-27");
    expect(parseReportDate("May 3, 2025")).toBe("2025-05-03");
    expect(parseReportDate("12 Months Ended")).toBeNull();
    expect(parseCell("$ 416,161<span></span>")).toBe("416161");
    expect(parseCell("(12,715)")).toBe("-12715");
    expect(parseCell("$ 7.46")).toBe("7.46");
    expect(parseCell(" [1] ")).toBeNull();
    expect(parseCell("Yes")).toBeNull();
    expect(shiftDecimal("416161", 6)).toBe("416161000000");
    expect(shiftDecimal("-1.5", 3)).toBe("-1500");
    expect(shiftDecimal("7.46", 0)).toBe("7.46");
  });
});

describe("our statements against SEC's rendering (Apple FY2025)", () => {
  const ours = JSON.parse(recorded("statements-0000320193-fy2025.json")) as {
    statements: Record<string, Record<string, Omit<LineValue, "accession" | "filed">>>;
  };
  const pages = { income: "R3", balance: "R5", cashflow: "R8" } as const;

  it.each(Object.entries(pages))("%s: every value presented matches to the unit", (kind, page) => {
    const def = STATEMENTS.find((s) => s.kind === kind)!;
    const items = Object.fromEntries(
      Object.entries(ours.statements[kind]!).map(([k, v]) => [
        k,
        { ...v, accession: ACC, filed: "2025-10-31" },
      ]),
    );
    const results = checkAgainstReport(
      items,
      def.lines,
      parseStatementReport(recorded(`${page}-${ACC}.trimmed.htm`)),
      "2025-09-27",
    );
    expect(results.filter((r) => r.status === "mismatch")).toEqual([]);
    expect(results.filter((r) => r.status.startsWith("match")).length).toBeGreaterThanOrEqual(5);
  });

  it("flags a wrong value", () => {
    const def = STATEMENTS.find((s) => s.kind === "income")!;
    const [result] = checkAgainstReport(
      {
        revenue: {
          value: "416161000001",
          concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
          unit: "USD",
          accession: ACC,
          filed: "2025-10-31",
        },
      },
      def.lines,
      parseStatementReport(recorded(`R3-${ACC}.trimmed.htm`)),
      "2025-09-27",
    );
    expect(result?.status).toBe("mismatch");
  });
});
