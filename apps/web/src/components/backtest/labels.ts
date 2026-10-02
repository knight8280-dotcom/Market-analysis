/** Run status and kind labels shared by the backtest pages. */
export const STATUS: Record<
  string,
  { label: string; tone: "neutral" | "up" | "down" | "warning" | "info" }
> = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Finished", tone: "up" },
  failed: { label: "Failed", tone: "down" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const KIND_LABEL: Record<string, string> = {
  single: "Single run",
  sweep: "Parameter sweep",
  walk_forward: "Walk-forward",
};
