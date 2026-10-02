import { Badge, Button, cn, EmptyState, formatDateTimeET } from "@market/ui";
import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AlertControls } from "../../../components/alert-controls";
import { MarkSeen } from "../../../components/notification-bell";
import { listNotifications, type NotificationRow } from "../../../server/alerts";
import { requireOwner } from "../../../server/auth/owner";
import { requireFlag } from "../../../server/flags";
import { dismissNotification, markNotificationsRead } from "./actions";

export const metadata: Metadata = { title: "Notifications" };

function Title({ n }: { n: NotificationRow }) {
  if (!n.href) return <>{n.title}</>;
  if (n.href.startsWith("https://www.sec.gov/")) {
    return (
      <a
        href={n.href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-primary hover:underline"
      >
        {n.title}
        <ExternalLink aria-hidden className="size-3.5" />
        <span className="sr-only">(opens the filing on sec.gov in a new tab)</span>
      </a>
    );
  }
  return (
    <Link href={n.href} className="text-primary hover:underline">
      {n.title}
    </Link>
  );
}

/**
 * In-app notifications (Phase 2 step E3): one per alert event, newest first. Each can snooze,
 * pause or delete its alert where it stands (spec §5.14). Showing the page marks them read.
 */
export default async function NotificationsPage() {
  await requireOwner();
  await requireFlag("notifications");
  const items = await listNotifications();
  const unread = items.filter((n) => !n.read).map((n) => n.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Alerts that fired, newest first (the latest 100). Snoozing keeps an alert quiet for a
          while; deleting an alert removes its notifications too. Opening this page marks them read.
          Set alerts up under{" "}
          <Link href="/alerts" className="text-primary underline">
            Alerts
          </Link>
          .
        </p>
      </div>
      <MarkSeen ids={unread} action={markNotificationsRead} />
      {items.length === 0 ? (
        <EmptyState title="No notifications yet">
          Alerts you create show up here when they fire.{" "}
          <Link href="/alerts" className="text-primary underline">
            Create an alert
          </Link>
        </EmptyState>
      ) : (
        <ul aria-label="Notifications" className="flex flex-col gap-3">
          {items.map((n) => (
            <li
              key={n.id}
              data-testid={`notification-${n.id}`}
              className={cn(
                "rounded-lg border bg-surface p-4",
                !n.read && "border-primary/60 bg-primary/5",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {!n.read ? <Badge tone="info">New</Badge> : null}
                  <Title n={n} />
                </h2>
                <time
                  dateTime={n.createdAt.toISOString()}
                  className="text-xs whitespace-nowrap text-muted-foreground"
                >
                  {formatDateTimeET(n.createdAt)}
                </time>
              </div>
              <p className="mt-2 text-sm whitespace-pre-line text-muted-foreground">{n.body}</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <AlertControls
                  alert={n.alert}
                  name={`alert of “${n.title}”`}
                  returnTo="/notifications"
                />
                <span className="flex items-center gap-1">
                  <Link
                    href={`/alerts/${n.alert.id}`}
                    className="inline-flex min-h-8 items-center px-2 text-sm text-primary hover:underline"
                    aria-label={`Manage the alert of “${n.title}”`}
                  >
                    Manage alert
                  </Link>
                  <form action={dismissNotification}>
                    <input type="hidden" name="id" value={n.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      aria-label={`Dismiss “${n.title}”`}
                    >
                      Dismiss
                    </Button>
                  </form>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
