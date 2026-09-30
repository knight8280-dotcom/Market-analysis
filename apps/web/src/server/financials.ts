import type { Database } from "@market/db";
import type {
  FiscalPeriod,
  Frequency,
  LineValue,
  StatementKind,
} from "@market/market-data/statements";

export interface StatementColumn {
  fiscalYear: number;
  fiscalPeriod: FiscalPeriod;
  periodStart: string | null;
  periodEnd: string;
  latest: Record<string, LineValue>;
  asReported: Record<string, LineValue>;
}

/** The most recent `limit` periods of one statement, newest first, with both bases. */
export async function statementColumns(
  db: Database,
  cik: string,
  statement: StatementKind,
  frequency: Frequency,
  limit: number,
): Promise<StatementColumn[]> {
  const rows = await db
    .selectFrom("market.financial_statements")
    .select(["basis", "fiscal_year", "fiscal_period", "period_start", "period_end", "line_items"])
    .where("cik", "=", cik)
    .where("statement", "=", statement)
    .where("frequency", "=", frequency)
    .orderBy("period_end", "desc")
    .limit(limit * 2)
    .execute();
  const byEnd = new Map<string, StatementColumn>();
  for (const r of rows) {
    const col = byEnd.get(r.period_end) ?? {
      fiscalYear: r.fiscal_year,
      fiscalPeriod: r.fiscal_period as FiscalPeriod,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      latest: {},
      asReported: {},
    };
    const items = r.line_items as unknown as Record<string, LineValue>;
    if (r.basis === "latest") col.latest = items;
    else col.asReported = items;
    byEnd.set(r.period_end, col);
  }
  return [...byEnd.values()].slice(0, limit);
}

/** EDGAR filing index page for an accession number. */
export function filingUrl(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/`;
}
