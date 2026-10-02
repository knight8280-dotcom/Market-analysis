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
