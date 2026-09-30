import { AlertTriangle, FlaskConical } from "lucide-react";
import { COPY } from "./copy";

/**
 * Visible "SAMPLE DATA" banner (spec rule 6, §6 states). Rendered in every non-production
 * environment, and in any environment whose data includes synthetic records. Production with
 * only licensed data renders nothing.
 */
export function SampleDataBanner(props: { appEnv: string; hasSyntheticData?: boolean }) {
  if (props.appEnv === "production" && !props.hasSyntheticData) return null;
  return (
    <div
      role="note"
      aria-label="Sample data notice"
      className="flex items-center gap-2 bg-banner-sample px-4 py-2 text-sm font-bold tracking-wide text-white"
    >
      <FlaskConical aria-hidden className="size-4 shrink-0" />
      {COPY.sampleDataBanner}
    </div>
  );
}

/** Shown on every page while a dataset's freshness SLO is breached (spec §6 stale-data banner). */
export function StaleDataBanner(props: { items: { dataset: string; since: string }[] }) {
  if (props.items.length === 0) return null;
  return (
    <div
      role="status"
      aria-label="Stale data notice"
      className="flex flex-col gap-1 bg-banner-stale px-4 py-2 text-sm text-white"
    >
      {props.items.map((item) => (
        <p key={item.dataset} className="flex items-center gap-2">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          {COPY.staleDataBanner(item.dataset, item.since)}
        </p>
      ))}
    </div>
  );
}

/** §12 global footer. */
export function DisclaimerFooter(props: { brand: string }) {
  return (
    <footer className="border-t px-4 py-6 text-xs leading-relaxed text-muted-foreground">
      <p className="max-w-4xl">{COPY.footer(props.brand)}</p>
      <p className="mt-2">{COPY.personalUse}</p>
    </footer>
  );
}
