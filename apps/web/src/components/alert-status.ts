import type { AlertEventRow } from "../server/alerts";

/** How an alert event's email delivery reads in lists. */
export const EVENT_STATUS: Record<
  AlertEventRow["status"],
  { label: string; tone: "up" | "down" | "warning" | "neutral" }
> = {
  sent: { label: "Emailed", tone: "up" },
  pending: { label: "Sending", tone: "neutral" },
  failed: { label: "Failed", tone: "down" },
  suppressed: { label: "Not emailed", tone: "warning" },
};

/** How an alert event's push delivery reads in lists (Phase 2 step J2). */
export const PUSH_STATUS: typeof EVENT_STATUS = {
  sent: { label: "Pushed", tone: "up" },
  pending: { label: "Sending", tone: "neutral" },
  failed: { label: "Push failed", tone: "down" },
  suppressed: { label: "Not pushed", tone: "warning" },
};
