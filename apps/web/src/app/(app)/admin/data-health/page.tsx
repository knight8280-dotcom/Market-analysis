import { Badge, Card, CardContent, CardHeader, formatDateTimeET, Table, Td, Th } from "@market/ui";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireOwner } from "../../../../server/auth/owner";
import { db } from "../../../../server/db";
import { getDataHealth } from "../../../../server/health";

export const metadata: Metadata = { title: "Data health" };

const TONE: Record<string, "down" | "warning" | "info"> = {
  critical: "down",
  error: "down",
  warning: "warning",
  info: "info",
};

function Section(props: {
  title: string;
  head: string[];
  numeric?: number[];
  rows: ReactNode[][];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader title={props.title} />
      <CardContent>
        {props.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{props.empty}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                {props.head.map((h, i) => (
                  <Th key={h} numeric={props.numeric?.includes(i)}>
                    {h}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <Td key={j} numeric={props.numeric?.includes(j)} className="align-top">
                      {c}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const when = (v: string | null) => (v ? formatDateTimeET(v) : "never");

/** Freshness, runs, routing and alerts. Metadata only: no price or fundamental values. */
export default async function DataHealthPage() {
  await requireOwner();
  const h = await getDataHealth(db());
  const t = h.totals;
  const stats: [string, ReactNode][] = [
    ["Securities", `${t.activeSecurities} active / ${t.securities}`],
    ["Latest bar date", t.latestBarDate ?? "none"],
    ["Securities with latest bar", t.securitiesWithLatestBar],
    ["Rows in DEFAULT partition", t.defaultPartitionRows],
    ["Corrections (7 days)", t.correctionsLast7Days],
    ["Filings", t.fundamentalsFilings],
    ["Macro series", t.macroSeries],
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Data health</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Generated {formatDateTimeET(h.generatedAt)}. Counts, dates and statuses only.
        </p>
      </div>

      {h.openAlerts.map((a) => (
        <div
          key={`${a.kind}-${a.dataset}-${a.source ?? ""}`}
          role="alert"
          className="rounded-lg border border-l-4 bg-surface p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[a.severity] ?? "neutral"}>{a.severity.toUpperCase()}</Badge>
            <strong>
              {a.kind} · {a.dataset}
            </strong>
          </div>
          <p className="mt-1 text-sm">{a.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            since {when(a.openedAt)}, last seen {when(a.lastSeenAt)}
          </p>
        </div>
      ))}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-surface p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      <Section
        title="Routing"
        head={["Dataset", "Primary", "Fallback", "Active", "Failed over", "Reason"]}
        rows={h.routes.map((r) => [
          r.dataset,
          r.primary,
          r.fallback ?? "none",
          r.active ?? <Badge tone="down">NONE: serving last-good data</Badge>,
          r.failedOverAt ? when(r.failedOverAt) : "",
          r.reason ?? "",
        ])}
        empty="No routing state yet (written on the first ingest)."
      />
      <Section
        title="Ingestion runs"
        head={["Dataset", "Last success", "Last status", "OK (24h)", "Failed (24h)", "Last error"]}
        numeric={[3, 4]}
        rows={h.lastRuns.map((r) => [
          r.dataset,
          when(r.lastSuccessAt),
          <Badge key="s" tone={r.lastStatus === "succeeded" ? "up" : "down"}>
            {r.lastStatus}
          </Badge>,
          r.succeeded24h,
          r.failed24h,
          r.lastError ?? "",
        ])}
        empty="No ingestion runs yet."
      />
      <Section
        title="Provider health"
        head={[
          "Source",
          "Dataset",
          "Last success",
          "Last failure",
          "Failures in a row",
          "Last error",
        ]}
        numeric={[4]}
        rows={h.providers.map((p) => [
          p.source,
          p.dataset,
          when(p.lastSuccessAt),
          when(p.lastFailureAt),
          p.consecutiveFailures,
          p.lastError ?? "",
        ])}
        empty="No provider calls recorded yet."
      />
      <Section
        title="Open data-quality issues"
        head={["Rule", "Severity", "Count"]}
        numeric={[2]}
        rows={h.openIssues.map((i) => [i.rule, i.severity, i.count])}
        empty="No open issues."
      />
    </div>
  );
}
