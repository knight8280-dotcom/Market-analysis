import {
  Badge,
  Button,
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
import { ChannelChoice } from "../../../../components/alert-form";
import { EVENT_STATUS, PUSH_STATUS } from "../../../../components/alert-status";
import { CHANNEL_LABELS } from "../../../../lib/alert-form";
import { getAlert, recentAlertEvents, type AlertRow } from "../../../../server/alerts";
import { requireOwner } from "../../../../server/auth/owner";
import { enabledFlags } from "../../../../server/flags";
import { setAlertChannels } from "../actions";

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const label = (a: AlertRow) => (a.target.type === "screen" ? a.target.name : a.target.ticker);

// A fixed title: metadata that waits on the database is streamed after the page, so the
// document can briefly have no title (axe document-title).
export const metadata: Metadata = { title: "Alert" };

/**
 * One alert (Phase 2 step E3): what it watches, its state, snooze, pause and delete, and what it
 * fired. Alert emails link here ("Manage this alert").
 */
export default async function AlertPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await requireOwner();
  const alert = await getAlert((await params).id);
  if (!alert) notFound();
  const [events, flags, q] = await Promise.all([
    recentAlertEvents({ alertId: alert.id, limit: 50 }),
    enabledFlags(),
    searchParams,
  ]);
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
            <dt className="text-muted-foreground">Sent by</dt>
            <dd data-testid="alert-channels">
              {[...alert.channels.map((c) => CHANNEL_LABELS[c]), "in the app"].join(", ")}
            </dd>
          </dl>
          {flags.push ? (
            <form action={setAlertChannels} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={alert.id} />
              <input type="hidden" name="returnTo" value={`/alerts/${alert.id}`} />
              <ChannelChoice chosen={alert.channels} />
              <Button type="submit" variant="secondary" size="sm">
                Save
              </Button>
            </form>
          ) : null}
          {q.error === "channels" ? (
            <p role="alert" className="text-sm text-down">
              Choose how to be told: email, push or both.
            </p>
          ) : q.saved === "channels" ? (
            <p role="status" className="text-sm text-up">
              Saved.
            </p>
          ) : null}
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
                  {flags.push ? <Th>Push</Th> : null}
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
                    {flags.push ? (
                      <Td>
                        <Badge
                          tone={PUSH_STATUS[e.push.status].tone}
                          className="w-fit"
                          title={e.push.error ?? undefined}
                        >
                          {PUSH_STATUS[e.push.status].label}
                        </Badge>
                      </Td>
                    ) : null}
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
