import { sql, type Database } from "@market/db";
import type { ProviderId } from "@market/market-data";

export interface IssueRow {
  runId: string | null;
  dataset: string;
  source: ProviderId | null;
  securityId: string | null;
  date: string | null;
  rule: string;
  severity: "info" | "warning" | "error";
  action: "rejected" | "flagged" | "skipped";
  message: string;
  payload?: Record<string, unknown>;
}

/** Records issues; an identical open issue (same bar and rule) is not duplicated. */
export async function recordIssues(db: Database, issues: readonly IssueRow[]): Promise<number> {
  let inserted = 0;
  for (const i of issues) {
    const result = await sql`
      insert into ops.data_quality_issues
        (run_id, dataset, source, security_id, date, rule, severity, action, message, payload)
      values (${i.runId}, ${i.dataset}, ${i.source}, ${i.securityId}, ${i.date}, ${i.rule},
              ${i.severity}, ${i.action}, ${i.message}, ${JSON.stringify(i.payload ?? {})}::jsonb)
      on conflict (dataset, source, security_id, date, rule) where status = 'open' do nothing
    `.execute(db);
    inserted += Number(result.numAffectedRows ?? 0);
  }
  return inserted;
}
