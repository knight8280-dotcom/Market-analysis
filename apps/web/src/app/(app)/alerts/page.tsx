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
import { EVENT_STATUS, PUSH_STATUS } from "../../../components/alert-status";
import { CONDITION_HELP, isAlertKind } from "../../../lib/alert-form";
import { listAlerts, recentAlertEvents, type AlertRow } from "../../../server/alerts";
import { requireOwner } from "../../../server/auth/owner";
import { enabledFlags } from "../../../server/flags";
import { savedScreens } from "../../../server/screens";
import { deleteAlert, setAlertActive } from "./actions";

export const metadata: Metadata = { title: "Alerts" };

type Search = Promise<Record<string, string | string[] | undefined>>;

const ERRORS: Record<string, string> = {
  ticker: "No security with that ticker is loaded.",
  cik: "That security has no SEC CIK, so its Form 4 filings cannot be matched to it.",
  screen: "Pick one of your saved screens.",
  cooldown: "The cooldown must be between 0 and 720 hours.",
  channels: "Choose how to be told: email, push or both.",
};

const label = (a: AlertRow) => (a.target.type === "screen" ? a.target.name : a.target.ticker);

/**
 * Alerts (Phase 1 step I, Phase 2 group E): conditions checked as end-of-day data, filings and
 * screener results arrive, emailed to the owner and listed under Notifications.
 */
export default async function AlertsPage({ searchParams }: { searchParams: Search }) {
  await requireOwner();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
  const kind = one("kind");
  const error =
    one("error") === "condition"
      ? `Check the condition.${kind && isAlertKind(kind) ? ` ${CONDITION_HELP[kind]}` : ""}`
      : ERRORS[one("error") ?? ""];
  const [alerts, events, flags, screens] = await Promise.all([
    listAlerts(),
    recentAlertEvents(),
    enabledFlags(),
    savedScreens(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Alerts</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Checked on end-of-day data as soon as it loads, and again at 18:50 ET. Price, RSI and
          moving-average alerts fire when a value crosses your level, once per crossing; filing and
          screen alerts report what is new since they last fired. Emails go to your own address when
          the worker has <code>RESEND_API_KEY</code> and <code>ALERT_EMAIL_TO</code>; every event is
          listed here either way
          {flags.notifications ? (
            <>
              {" "}
              and under{" "}
              <Link href="/notifications" className="text-primary underline">
                Notifications
              </Link>
            </>
          ) : null}
          .
        </p>
      </div>

      <Card>
        <CardHeader title="New alert" />
        <CardContent className="flex flex-col gap-3">
          <AlertForm
            ticker={one("ticker")}
            kind={kind}
            moreKinds={flags.alert_types}
            ownership={flags.ownership}
            push={flags.push}
            screens={screens.map((s) => ({ id: s.id, name: s.name }))}
          />
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
                    <Th>Watches</Th>
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
                        {a.target.type === "screen" ? (
                          <Link
                            href={`/screener?saved=${encodeURIComponent(a.target.screenId)}`}
                            className="text-primary hover:underline"
                          >
                            Screen: {a.target.name}
                          </Link>
                        ) : (
                          <Link
                            href={`/stocks/${encodeURIComponent(a.target.ticker)}`}
                            className="font-mono font-medium text-primary hover:underline"
                          >
                            {a.target.ticker}
                          </Link>
                        )}
                      </Td>
                      <Td>{a.condition}</Td>
                      <Td className="hidden md:table-cell">
                        {a.cooldownHours === 0 ? "None" : `${a.cooldownHours} h`}
                      </Td>
                      <Td className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                        {a.lastFiredAt ? formatDateTimeET(a.lastFiredAt) : "Never"}
                      </Td>
                      <Td>
                        <span className="flex flex-col gap-0.5">
                          <Badge
                            tone={!a.active ? "neutral" : a.snoozedUntil ? "warning" : "info"}
                            className="w-fit"
                          >
                            {!a.active ? "Paused" : a.snoozedUntil ? "Snoozed" : "Active"}
                          </Badge>
                          {a.active && a.snoozedUntil ? (
                            <span className="text-xs whitespace-nowrap text-muted-foreground">
                              until {formatDateTimeET(a.snoozedUntil)}
                            </span>
                          ) : null}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex justify-end gap-1">
                          <Link
                            href={`/alerts/${a.id}`}
                            className="inline-flex min-h-8 items-center px-2 text-sm text-primary hover:underline"
                            aria-label={`Manage ${label(a)} alert: ${a.condition}`}
                          >
                            Manage
                          </Link>
                          <form action={setAlertActive}>
                            <input type="hidden" name="id" value={a.id} />
                            <input type="hidden" name="active" value={String(!a.active)} />
                            <Button
                              type="submit"
                              variant="ghost"
                              size="sm"
                              aria-label={`${a.active ? "Pause" : "Resume"} ${label(a)} alert: ${a.condition}`}
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
                              aria-label={`Delete ${label(a)} alert: ${a.condition}`}
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
                    {flags.push ? <Th>Push</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} data-testid={`event-${e.id}`}>
                      <Td className="whitespace-nowrap">{formatDate(e.date)}</Td>
                      <Td>
                        <Link href={`/alerts/${e.alertId}`} className="hover:underline">
                          {e.subject}
                        </Link>
                      </Td>
                      <Td>
                        <span className="flex flex-col gap-0.5">
                          <Badge tone={EVENT_STATUS[e.status].tone} className="w-fit">
                            {EVENT_STATUS[e.status].label}
                          </Badge>
                          {e.error ? (
                            <span className="text-xs text-muted-foreground">{e.error}</span>
                          ) : null}
                        </span>
                      </Td>
                      {flags.push ? (
                        <Td>
                          <span className="flex flex-col gap-0.5">
                            <Badge tone={PUSH_STATUS[e.push.status].tone} className="w-fit">
                              {PUSH_STATUS[e.push.status].label}
                            </Badge>
                            {e.push.error ? (
                              <span className="text-xs text-muted-foreground">{e.push.error}</span>
                            ) : null}
                          </span>
                        </Td>
                      ) : null}
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
