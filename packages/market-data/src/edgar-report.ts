import type { LineDef, LineValue } from "./statements";
import { decimalSub } from "./statements";

/**
 * SEC's own rendering of a filing's XBRL statements (the "R" pages listed in FilingSummary.xml).
 * Used to check our statements against an independent presentation (Phase 1 step E4): SEC's
 * renderer picks each statement's rows and columns from the filing's presentation linkbase,
 * which our builder never reads.
 */

export interface FilingReport {
  file: string;
  shortName: string;
  category: string;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1]!.trim() : null;
}

export function parseFilingSummary(xml: string): FilingReport[] {
  const out: FilingReport[] = [];
  for (const m of xml.matchAll(/<Report\b[^>]*>([\s\S]*?)<\/Report>/g)) {
    const body = m[1]!;
    const file = tag(body, "HtmlFileName");
    const shortName = tag(body, "ShortName");
    if (!file || !shortName) continue;
    out.push({
      file,
      shortName: decodeEntities(shortName),
      category: tag(body, "MenuCategory") ?? "",
    });
  }
  return out;
}

export type StatementKindForReport = "income" | "balance" | "cashflow";

/** The primary statement page of each kind (not comprehensive income, not parentheticals). */
export function findStatementReport(
  reports: readonly FilingReport[],
  kind: StatementKindForReport,
): FilingReport | undefined {
  const statements = reports.filter(
    (r) => r.category === "Statements" && !/parenthetical/i.test(r.shortName),
  );
  const test: Record<StatementKindForReport, (name: string) => boolean> = {
    income: (n) =>
      /(OPERATIONS|INCOME|EARNINGS)/i.test(n) && !/COMPREHENSIVE|EQUITY|CASH FLOW|BALANCE/i.test(n),
    balance: (n) => /(BALANCE SHEET|FINANCIAL CONDITION|FINANCIAL POSITION)/i.test(n),
    cashflow: (n) => /CASH FLOW/i.test(n),
  };
  return statements.find((r) => test[kind](r.shortName));
}

export interface ReportRow {
  /** "us-gaap:Revenues", or a filer's own extension concept. */
  concept: string;
  label: string;
  /** Presented numbers as decimal strings (not yet scaled); null for an empty cell. */
  cells: (string | null)[];
}

export interface StatementReport {
  title: string;
  /** Multipliers from the title, e.g. "$ in Millions" → 1e6 (as a power of ten). */
  usdPower: number;
  sharesPower: number;
  /** ISO date of each value column, in order. */
  dates: string[];
  rows: ReportRow[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;/g, " ");
}

const stripTags = (s: string) =>
  decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

/** "Sep. 27, 2025" → "2025-09-27". */
export function parseReportDate(text: string): string | null {
  const m = /\b([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})\b/.exec(text);
  if (!m || !MONTHS[m[1]!]) return null;
  return `${m[3]}-${MONTHS[m[1]!]}-${m[2]!.padStart(2, "0")}`;
}

const POWERS: Record<string, number> = { Thousands: 3, Millions: 6, Billions: 9 };

/** "$ 1,234" → "1234"; "(56.7)" → "-56.7"; blanks and text → null. */
export function parseCell(text: string): string | null {
  const t = stripTags(text)
    .replace(/\[\d+\]/g, "")
    .replace(/[$\s]/g, "");
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t);
  const digits = t.replace(/[(),]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return null;
  return neg ? `-${digits}` : digits;
}

export function parseStatementReport(html: string): StatementReport {
  const headerEnd = html.search(/<tr class="r/);
  const header = headerEnd >= 0 ? html.slice(0, headerEnd) : html;
  const titleCell = /<th class="tl"[^>]*>([\s\S]*?)<\/th>/.exec(header);
  const title = titleCell ? stripTags(titleCell[1]!) : "";
  const usd = /\$ in (Thousands|Millions|Billions)/.exec(title);
  const shares = /shares in (Thousands|Millions|Billions)/.exec(title);
  const dates: string[] = [];
  for (const m of header.matchAll(/<th class="th"[^>]*>([\s\S]*?)<\/th>/g)) {
    const d = parseReportDate(stripTags(m[1]!));
    if (d) dates.push(d);
  }
  const rows: ReportRow[] = [];
  const body = headerEnd >= 0 ? html.slice(headerEnd) : "";
  for (const m of body.matchAll(/<tr class="r[^"]*">([\s\S]*?)<\/tr>/g)) {
    const tr = m[1]!;
    const ref = /defref_([A-Za-z0-9-]+?)_([A-Za-z0-9]+)'/.exec(tr);
    if (!ref) continue;
    const label = /<a\s[^>]*>([\s\S]*?)<\/a>/.exec(tr);
    const cells = [...tr.matchAll(/<td class="(?:nump|num|text)"[^>]*>([\s\S]*?)<\/td>/g)].map(
      (c) => parseCell(c[1]!),
    );
    rows.push({
      concept: `${ref[1]}:${ref[2]}`,
      label: label ? stripTags(label[1]!) : "",
      cells,
    });
  }
  return {
    title,
    usdPower: usd ? POWERS[usd[1]!]! : 0,
    sharesPower: shares ? POWERS[shares[1]!]! : 0,
    dates,
    rows,
  };
}

/** Multiplies a decimal string by 10^power exactly. */
export function shiftDecimal(value: string, power: number): string {
  const neg = value.startsWith("-");
  const [int = "0", frac = ""] = value.replace("-", "").split(".");
  const digits = int + frac + "0".repeat(Math.max(0, power - frac.length));
  const point = int.length + power;
  const whole = digits.slice(0, point).replace(/^0+(?=\d)/, "") || "0";
  const rest = digits.slice(point).replace(/0+$/, "");
  const out = rest ? `${whole}.${rest}` : whole;
  return neg && out !== "0" ? `-${out}` : out;
}

export interface CheckResult {
  line: string;
  concept: string;
  ours: string;
  /** Presented values for the concept in the period's column, scaled to units. */
  presented: string[];
  /** "match_negated": equal after SEC's negated-label presentation (e.g. capex shown as (x)). */
  status: "match" | "match_negated" | "mismatch" | "not_presented";
}

/**
 * Compares our values for one period with the presented statement. A value matches when it
 * equals, to the unit, one of the presented cells for the same concept in that period's column
 * (a concept can appear on several rows, e.g. a total and its segment breakdown). Derived values
 * are skipped: the filing does not present them.
 */
export function checkAgainstReport(
  items: Record<string, LineValue>,
  lines: readonly LineDef[],
  report: StatementReport,
  periodEnd: string,
): CheckResult[] {
  const col = report.dates.indexOf(periodEnd);
  if (col < 0) throw new Error(`No ${periodEnd} column in "${report.title}"`);
  const results: CheckResult[] = [];
  for (const line of lines) {
    const v = items[line.id];
    if (!v || v.derived) continue;
    const power =
      line.unit === "USD" ? report.usdPower : line.unit === "shares" ? report.sharesPower : 0;
    const presented = report.rows
      .filter((r) => r.concept === v.concept)
      .map((r) => r.cells[col])
      .filter((c): c is string => c !== null && c !== undefined)
      .map((c) => shiftDecimal(c, power));
    const negated = v.value.startsWith("-") ? v.value.slice(1) : `-${v.value}`;
    const status: CheckResult["status"] =
      presented.length === 0
        ? "not_presented"
        : presented.some((p) => decimalSub(p, v.value) === "0")
          ? "match"
          : presented.some((p) => decimalSub(p, negated) === "0")
            ? "match_negated"
            : "mismatch";
    results.push({ line: line.id, concept: v.concept, ours: v.value, presented, status });
  }
  return results;
}
