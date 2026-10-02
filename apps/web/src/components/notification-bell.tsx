"use client";

import { cn } from "@market/ui";
import { Bell } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** Fired after notifications are marked read, so the bell refreshes at once. */
export const NOTIFICATIONS_CHANGED = "market:notifications-changed";

/**
 * Header bell (Phase 2 step E3): the unread count from the page, refreshed every 30 seconds
 * while the tab is visible and whenever notifications are read. The layout keys it by the count,
 * so a new server value replaces the old one.
 */
export function NotificationBell({ initial }: { initial: number }) {
  const [unread, setUnread] = useState(initial);
  const pathname = usePathname();

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/notifications/unread", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { unread?: unknown };
        if (!stopped && typeof body.unread === "number") setUnread(body.unread);
      } catch {
        // Offline or restarting: keep the last count.
      }
    };
    const onChange = () => void refresh();
    const timer = setInterval(onChange, 30_000);
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener(NOTIFICATIONS_CHANGED, onChange);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener(NOTIFICATIONS_CHANGED, onChange);
    };
  }, []);

  const label = unread === 0 ? "Notifications" : `Notifications, ${unread} unread`;
  return (
    <Link
      href="/notifications"
      aria-label={label}
      title={label}
      aria-current={pathname === "/notifications" ? "page" : undefined}
      data-testid="notification-bell"
      className={cn(
        "relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        pathname === "/notifications" && "bg-muted text-foreground",
      )}
    >
      <Bell aria-hidden className="size-4" />
      {unread > 0 ? (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </Link>
  );
}

/** Marks the notifications shown on the page read, once, after it renders. */
export function MarkSeen({
  ids,
  action,
}: {
  ids: string[];
  action: (ids: string[]) => Promise<number>;
}) {
  const key = ids.join(",");
  useEffect(() => {
    if (!key) return;
    action(key.split(","))
      .then(() => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED)))
      .catch(() => {});
  }, [key, action]);
  return null;
}
