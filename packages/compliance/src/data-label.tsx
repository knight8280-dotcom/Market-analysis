"use client";

import { cn, formatDateTimeET } from "@market/ui";
import { Tooltip } from "@market/ui/client";
import { COPY, type DelayKind } from "./copy";

export interface SourceInfo {
  /** Display name, e.g. "Tiingo" or "SEC EDGAR". */
  name: string;
  /** The provider's required attribution text, from DATA_LICENSES. */
  attribution: string;
  url?: string;
}

/**
 * The label every displayed data point carries (spec MUST DO #7): delay label and source,
 * always visible, with fetch time and attribution in a keyboard-reachable tooltip.
 */
export function DataLabel({
  source,
  kind,
  asOf,
  fetchedAt,
  className,
}: {
  source: SourceInfo;
  kind: DelayKind;
  /** Session date, filing date or observation date (YYYY-MM-DD). */
  asOf: string | null;
  fetchedAt?: Date | string | null;
  className?: string;
}) {
  const visible = `${COPY.delay(kind, asOf)} · ${COPY.source(source.name)}`;
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1">
          <span>{source.attribution}</span>
          {fetchedAt ? <span>Fetched {formatDateTimeET(fetchedAt)}</span> : null}
          {source.url ? <span className="text-muted-foreground">{source.url}</span> : null}
        </span>
      }
    >
      <span
        tabIndex={0}
        className={cn(
          "inline-block cursor-help rounded text-xs text-muted-foreground underline decoration-dotted underline-offset-2",
          className,
        )}
      >
        {visible}
      </span>
    </Tooltip>
  );
}
