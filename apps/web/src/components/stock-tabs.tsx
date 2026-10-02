"use client";

import { cn } from "@market/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export function StockTabs({
  ticker,
  valuation,
  ownership,
  news,
}: {
  ticker: string;
  valuation: boolean;
  ownership: boolean;
  news: boolean;
}) {
  const pathname = usePathname();
  const base = `/stocks/${encodeURIComponent(ticker)}`;
  const on = (tab: string) => pathname.endsWith(`/${tab}`);
  const tabs = [
    {
      href: base,
      label: "Chart",
      active: !on("financials") && !on("valuation") && !on("ownership") && !on("news"),
    },
    { href: `${base}/financials`, label: "Financials", active: on("financials") },
    ...(valuation
      ? [{ href: `${base}/valuation`, label: "Valuation", active: on("valuation") }]
      : []),
    ...(ownership
      ? [{ href: `${base}/ownership`, label: "Ownership", active: on("ownership") }]
      : []),
    ...(news ? [{ href: `${base}/news`, label: "News", active: on("news") }] : []),
  ];
  // On a narrow screen the tabs scroll sideways; keep the current one in view.
  const current = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  return (
    <nav aria-label={`${ticker} sections`} className="flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          ref={t.active ? current : undefined}
          aria-current={t.active ? "page" : undefined}
          className={cn(
            "-mb-px flex min-h-9 shrink-0 items-center border-b-2 border-transparent px-3 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground",
            t.active && "border-primary font-medium text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
