"use client";

import { cn, formatCompact, formatPercent } from "@market/ui";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  GROUP_HEADER_PX,
  layoutHeatmap,
  neighbor,
  type HeatTile,
  type NavKey,
} from "../lib/heatmap/layout";
import { heatColor } from "../lib/heatmap/scale";

/** The size the server lays out for; the client re-lays out for the real size after mounting. */
const DEFAULT = { w: 1200, h: 675 };
const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/**
 * Treemap of securities grouped by sector (Phase 1 step H3). Tile area is the size measure,
 * color the change over the period; every tile also shows its signed change. One tile is in
 * the tab order at a time; arrow keys move between tiles, Home and End jump to the first and
 * last, and Enter opens the ticker page.
 */
export function Heatmap({
  tiles,
  full,
  periodLabel,
  sizeLabel,
}: {
  tiles: HeatTile[];
  /** The change that gets the strongest color. */
  full: number;
  periodLabel: string;
  sizeLabel: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(DEFAULT);
  const [active, setActive] = useState(0);
  const links = useRef<(HTMLAnchorElement | null)[]>([]);
  const router = useRouter();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setSize({ w: el.clientWidth, h: el.clientHeight });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const groups = useMemo(() => layoutHeatmap(tiles, size.w, size.h), [tiles, size]);
  const flat = useMemo(() => groups.flatMap((g) => g.tiles), [groups]);
  const current = Math.min(active, Math.max(0, flat.length - 1));

  const move = (next: number) => {
    setActive(next);
    links.current[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = links.current.indexOf(e.target as HTMLAnchorElement);
    if (from < 0) return;
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(e.key === "Home" ? 0 : flat.length - 1);
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      move(
        neighbor(
          flat.map((t) => t.rect),
          from,
          e.key as NavKey,
        ),
      );
    }
  };

  if (flat.length === 0) return null;
  let index = 0;
  return (
    <div className="flex flex-col gap-2">
      <p id="heatmap-help" className="text-xs text-muted-foreground">
        Area: {sizeLabel}. Color: change over {periodLabel.toLowerCase()}. Arrow keys move between
        tiles; Enter opens one.
      </p>
      <div
        ref={box}
        onKeyDown={onKeyDown}
        role="group"
        aria-label={`Heatmap: ${flat.length} securities`}
        aria-describedby="heatmap-help"
        className="relative aspect-[3/4] w-full overflow-hidden rounded-md bg-background select-none sm:aspect-[16/9]"
      >
        {groups.map((g) => (
          <div
            key={g.name}
            role="group"
            aria-label={`${g.name}: ${g.count} ${g.count === 1 ? "security" : "securities"}, ${formatPercent(g.change)} weighted`}
            className="absolute"
            style={{
              left: pct(g.rect.x, size.w),
              top: pct(g.rect.y, size.h),
              width: pct(g.rect.w, size.w),
              height: pct(g.rect.h, size.h),
            }}
          >
            {g.header ? (
              <div
                aria-hidden
                className="absolute inset-x-px top-px flex items-center justify-between gap-2 truncate px-1.5 text-[11px] font-medium text-foreground"
                style={{ height: GROUP_HEADER_PX }}
              >
                <span className="truncate">{g.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatPercent(g.change)}
                </span>
              </div>
            ) : null}
            {g.tiles.map(({ tile: t, rect: r }) => {
              const i = index++;
              const change = formatPercent(t.change);
              // Text only where it fits whole (monospace ticker: about 0.62em per character).
              const big = r.w >= Math.max(110, t.ticker.length * 10 + 12) && r.h >= 64;
              const label = big || (r.w >= t.ticker.length * 7 + 6 && r.h >= 16);
              const detail = label && r.w >= 48 && r.h >= 32;
              return (
                <a
                  key={t.securityId}
                  ref={(el) => {
                    links.current[i] = el;
                  }}
                  href={`/stocks/${encodeURIComponent(t.ticker)}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    router.push(`/stocks/${encodeURIComponent(t.ticker)}`);
                  }}
                  onFocus={() => setActive(i)}
                  tabIndex={i === current ? 0 : -1}
                  aria-label={`${t.ticker} ${change}, ${t.name}`}
                  title={`${t.ticker} · ${t.name}\n${change} over ${periodLabel.toLowerCase()} · ${sizeLabel} ${formatCompact(t.size)}`}
                  data-testid={`tile-${t.ticker}`}
                  className={cn(
                    "absolute flex flex-col items-center justify-center overflow-hidden text-center leading-tight text-white outline-none",
                    "border border-background hover:brightness-110 focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white",
                  )}
                  style={{
                    left: pct(r.x - g.rect.x, g.rect.w),
                    top: pct(r.y - g.rect.y, g.rect.h),
                    width: pct(r.w, g.rect.w),
                    height: pct(r.h, g.rect.h),
                    backgroundColor: heatColor(t.change, full),
                  }}
                >
                  {label ? (
                    <span
                      aria-hidden
                      className={cn("font-mono font-semibold", big ? "text-base" : "text-[11px]")}
                    >
                      {t.ticker}
                    </span>
                  ) : null}
                  {detail ? (
                    <span
                      aria-hidden
                      className={cn("tabular-nums", big ? "text-sm" : "text-[10px]")}
                    >
                      {change}
                    </span>
                  ) : null}
                </a>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
