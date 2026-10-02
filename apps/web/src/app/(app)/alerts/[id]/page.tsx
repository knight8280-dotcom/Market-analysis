import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  formatDate,
  formatDateTimeET,
  Table,
  Td,
  Th,
} from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertControls } from "../../../../components/alert-controls";
import { EVENT_STATUS } from "../../../../components/alert-status";
import { getAlert, recentAlertEvents, type AlertRow } from "../../../../server/alerts";
import { requireOwner } from "../../../../server/auth/owner";

type Params = Promise<{ id: string }>;

const label = (a: AlertRow) => (a.target.type === "screen" ? a.target.name : a.target.ticker);

// A fixed title: metadata that waits on the database is streamed after the page, so the
// document can briefly have no title (axe document-title).
export const metadata: Metadata = { title: "Alert" };

/**
 * One alert (Phase 2 step E3): what it watches, its state, snooze, pause and delete, and what it
 * fired. Alert emails link here ("Manage this alert").
 */
export default async function AlertPage({ params }: { params: Params }) {
  await requireOwner();
  const alert = await getAlert((await params).id);
  if (!alert) notFound();
  const events = await recentAlertEvents({ alertId: alert.id, limit: 50 });
  const name = `${label(alert)} alert: ${alert.condition}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm">
          <Link href="/alerts" className="text-primary hover:underline">
            Alerts
          </Link>
        </p>
        <h1 className="mt-1 text-xl font-semibold">
          {alert.target.type === "screen" ? (
            <>
              Screen{" "}
              <Link
                href={`/screener?saved=${encodeURIComponent(alert.target.screenId)}`}
                className="text-primary hover:underline"
              >
                {alert.target.name}
              </Link>
            </>
          ) : (
            <Link
              href={`/stocks/${encodeURIComponent(alert.target.ticker)}`}
              className="font-mono text-primary hover:underline"
            >
              {alert.target.ticker}
            </Link>
          )}
        </h1>
        <p className="mt-1 text-sm" data-testid="alert-condition">
          {alert.condition}
        </p>
      </div>

      <Card>
        <CardHeader
          title="Status"
          description={
            alert.active
              ? alert.snoozedUntil
                ? "Snoozed: changes in filings or screen results are kept and reported afterwards; price and indicator crossings during the snooze are not."
                : "Active: checked as new data arrives and at 18:50 ET."
              : "Paused: not checked until you resume it."
          }
        />
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={alert.active ? "info" : "neutral"}>
              {alert.active ? "Active" : "Paused"}
            </Badge>
          </div>
          <AlertControls alert={alert} name={name} returnTo={`/alerts/${alert.id}`} />
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatDateTimeET(alert.createdAt)}</dd>
            <dt className="text-muted-foreground">Cooldown after firing</dt>
            <dd>{alert.cooldownHours === 0 ? "None" : `${alert.cooldownHours} hours`}</dd>
            <dt className="text-muted-foreground">Last fired</dt>
            <dd>{alert.lastFiredAt ? formatDateTimeET(alert.lastFiredAt) : "Never"}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="What it fired" description="The latest 50 events" />
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing has fired yet.</p>
          ) : (
            <Table aria-label="Events of this alert" scrollLabel="Events, scrollable">
              <thead>
                <tr>
                  <Th>Data date</Th>
                  <Th>Event</Th>
                  <Th className="hidden md:table-cell">Fired</Th>
                  <Th>Email</Th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap">{formatDate(e.date)}</Td>
                    <Td>{e.subject}</Td>
                    <Td className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                      {formatDateTimeET(e.firedAt)}
                    </Td>
                    <Td>
                      <Badge tone={EVENT_STATUS[e.status].tone} className="w-fit">
                        {EVENT_STATUS[e.status].label}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
