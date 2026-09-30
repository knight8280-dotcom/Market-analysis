import { SampleDataBanner } from "@market/compliance";
import { loadWebEnv } from "@market/config";
import type { Metadata } from "next";
import { connection } from "next/server";
import type { CSSProperties, ReactNode } from "react";
import { db } from "../../../server/db";
import { getDataHealth } from "../../../server/health";

export const metadata: Metadata = {
  title: "Data health (internal)",
  robots: { index: false, follow: false },
};

const cell: CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid #2a2f3a",
  textAlign: "left",
  verticalAlign: "top",
};
const severityColor: Record<string, string> = {
  critical: "#ff6b6b",
  warning: "#f5b041",
  info: "#5dade2",
  error: "#ff6b6b",
};

function Table(props: { caption: string; head: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <table
      style={{
        borderCollapse: "collapse",
        width: "100%",
        marginBottom: 28,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <caption style={{ textAlign: "left", fontWeight: 700, fontSize: 18, padding: "8px 0" }}>
        {props.caption}
      </caption>
      <thead>
        <tr>
          {props.head.map((h) => (
            <th key={h} scope="col" style={{ ...cell, color: "#9aa0a6" }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <tr>
            <td style={cell} colSpan={props.head.length}>
              {props.empty}
            </td>
          </tr>
        ) : (
          props.rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} style={cell}>
                  {c}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

const when = (v: string | null) => v ?? "never";

/** Internal data-health page (Phase 0): freshness, runs, routing, alerts. Metadata only. */
export default async function DataHealthPage() {
  await connection();
  const env = loadWebEnv();
  const h = await getDataHealth(db());
  const t = h.totals;

  return (
    <>
      <SampleDataBanner appEnv={env.APP_ENV} hasSyntheticData={h.hasSyntheticData} />
      <main style={{ padding: "24px 32px", maxWidth: 1200 }}>
        <h1 style={{ marginTop: 0 }}>Data health</h1>
        <p style={{ color: "#9aa0a6" }}>
          Generated {h.generatedAt}. Internal page: counts, dates and statuses only.
        </p>

        {h.openAlerts.map((a) => (
          <div
            key={`${a.kind}-${a.dataset}-${a.source ?? ""}`}
            role="alert"
            style={{
              border: `2px solid ${severityColor[a.severity] ?? "#9aa0a6"}`,
              padding: "10px 14px",
              marginBottom: 12,
              borderRadius: 6,
            }}
          >
            <strong>
              {a.severity.toUpperCase()} · {a.kind} · {a.dataset}
            </strong>
            <div>{a.message}</div>
            <small style={{ color: "#9aa0a6" }}>
              since {a.openedAt}, last seen {a.lastSeenAt}
            </small>
          </div>
        ))}

        <Table
          caption="Totals"
          head={[
            "Securities",
            "Active",
            "Latest bar date",
            "Securities with latest bar",
            "Rows in DEFAULT partition",
            "Corrections (7d)",
            "Filings",
            "Macro series",
          ]}
          rows={[
            [
              t.securities,
              t.activeSecurities,
              t.latestBarDate ?? "none",
              t.securitiesWithLatestBar,
              t.defaultPartitionRows,
              t.correctionsLast7Days,
              t.fundamentalsFilings,
              t.macroSeries,
            ],
          ]}
          empty=""
        />
        <Table
          caption="Routing"
          head={["Dataset", "Primary", "Fallback", "Active", "Failed over at", "Reason"]}
          rows={h.routes.map((r) => [
            r.dataset,
            r.primary,
            r.fallback ?? "none",
            r.active ?? "NONE (serving last-good data)",
            r.failedOverAt ?? "",
            r.reason ?? "",
          ])}
          empty="No routing state yet (written on the first ingest)."
        />
        <Table
          caption="Ingestion runs"
          head={[
            "Dataset",
            "Last success",
            "Last status",
            "Succeeded 24h",
            "Failed 24h",
            "Last error",
          ]}
          rows={h.lastRuns.map((r) => [
            r.dataset,
            when(r.lastSuccessAt),
            r.lastStatus,
            r.succeeded24h,
            r.failed24h,
            r.lastError ?? "",
          ])}
          empty="No ingestion runs yet."
        />
        <Table
          caption="Provider health"
          head={[
            "Source",
            "Dataset",
            "Last success",
            "Last failure",
            "Consecutive failures",
            "Last error",
          ]}
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
        <Table
          caption="Open data-quality issues"
          head={["Rule", "Severity", "Count"]}
          rows={h.openIssues.map((i) => [i.rule, i.severity, i.count])}
          empty="No open issues."
        />
      </main>
    </>
  );
}
