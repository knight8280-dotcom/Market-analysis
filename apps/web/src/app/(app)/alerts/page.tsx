import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  formatDate,
  formatDateTimeET,
  Td,
  Th,
} from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { AlertForm } from "../../../components/alert-form";
import { listAlerts, recentAlertEvents, type AlertEventRow } from "../../../server/alerts";
import { requireOwner } from "../../../server/auth/owner";
import { deleteAlert, setAlertActive } from "./actions";

export const metadata: Metadata = { title: "Alerts" };

type Search = Promise<Record<string, string | string[] | undefined>>;

const ERRORS: Record<string, string> = {
  ticker: "No security with that ticker is loaded.",
  condition: "Check the condition: a positive price, a move between 0% and 100%, or 1 to 30 days.",
  cooldown: "The cooldown must be between 0 and 720 hours.",
};

const STATUS: Record<
  AlertEventRow["status"],
  { label: string; tone: "up" | "down" | "warning" | "neutral" }
> = {
  sent: { label: "Emailed", tone: "up" },
  pending: { label: "Sending", tone: "neutral" },
  failed: { label: "Failed", tone: "down" },
  suppressed: { label: "Not emailed", tone: "warning" },
};

/** Alerts (Phase 1 step I): conditions checked after each end-of-day load, emailed to the owner. */
export default async function AlertsPage({ searchParams }: { searchParams: Search }) {
  await requireOwner();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
  const error = ERRORS[one("error") ?? ""];
  const [alerts, events] = await Promise.all([listAlerts(), recentAlertEvents()]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Alerts</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Checked on end-of-day closes after each session&apos;s data loads (18:50 ET). Price alerts
          fire when the close crosses your level, once per crossing. Emails go to your own address
          when the worker has <code>RESEND_API_KEY</code> and <code>ALERT_EMAIL_TO</code>; every
          event is listed here either way.
        </p>
      </div>

      <Card>
        <CardHeader title="New alert" />
        <CardContent className="flex flex-col gap-3">
          <AlertForm ticker={one("ticker")} />
          {error ? (
            <p role="alert" className="text-sm text-down">
              {error}
            </p>
          ) : null}
          {one("created") ? (
            <p role="status" className="text-sm text-up">
              Alert created.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Your alerts"
          description={`${alerts.filter((a) => a.active).length} active`}
        />
        <CardContent>
          {alerts.length === 0 ? (
            <EmptyState title="No alerts yet">
              Create one above, or from the &quot;Alert&quot; button on any ticker page.
            </EmptyState>
          ) : (
            <div tabIndex={0} role="region" aria-label="Your alerts" className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>Ticker</Th>
                    <Th>Condition</Th>
                    <Th className="hidden md:table-cell">Cooldown</Th>
                    <Th className="hidden md:table-cell">Last fired</Th>
                    <Th>Status</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.id} data-testid={`alert-${a.id}`}>
                      <Td>
                        <Link
                          href={`/stocks/${encodeURIComponent(a.ticker)}`}
                          className="font-mono font-medium text-primary hover:underline"
                        >
                          {a.ticker}
                        </Link>
                      </Td>
                      <Td>{a.condition}</Td>
                      <Td className="hidden md:table-cell">
                        {a.cooldownHours === 0 ? "None" : `${a.cooldownHours} h`}
                      </Td>
                      <Td className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                        {a.lastFiredAt ? formatDateTimeET(a.lastFiredAt) : "Never"}
                      </Td>
                      <Td>
                        <Badge tone={a.active ? "info" : "neutral"}>
                          {a.active ? "Active" : "Paused"}
                        </Badge>
                      </Td>
                      <Td>
                        <span className="flex justify-end gap-1">
                          <form action={setAlertActive}>
                            <input type="hidden" name="id" value={a.id} />
                            <input type="hidden" name="active" value={String(!a.active)} />
                            <Button
                              type="submit"
                              variant="ghost"
                              size="sm"
                              aria-label={`${a.active ? "Pause" : "Resume"} ${a.ticker} alert: ${a.condition}`}
                            >
                              {a.active ? "Pause" : "Resume"}
                            </Button>
                          </form>
                          <form action={deleteAlert}>
                            <input type="hidden" name="id" value={a.id} />
                            <Button
                              type="submit"
                              variant="ghost"
                              size="sm"
                              aria-label={`Delete ${a.ticker} alert: ${a.condition}`}
                            >
                              Delete
                            </Button>
                          </form>
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Recent events" description="The last 50 alerts that fired" />
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing has fired yet.</p>
          ) : (
            <div tabIndex={0} role="region" aria-label="Recent events" className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Event</Th>
                    <Th>Email</Th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} data-testid={`event-${e.id}`}>
                      <Td className="whitespace-nowrap">{formatDate(e.date)}</Td>
                      <Td>{e.subject}</Td>
                      <Td>
                        <span className="flex flex-col gap-0.5">
                          <Badge tone={STATUS[e.status].tone} className="w-fit">
                            {STATUS[e.status].label}
                          </Badge>
                          {e.error ? (
                            <span className="text-xs text-muted-foreground">{e.error}</span>
                          ) : null}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
