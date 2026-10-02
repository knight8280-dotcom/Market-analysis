"use client";

import { cn } from "@market/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function StockTabs({ ticker, valuation }: { ticker: string; valuation: boolean }) {
  const pathname = usePathname();
  const base = `/stocks/${encodeURIComponent(ticker)}`;
  const on = (tab: string) => pathname.endsWith(`/${tab}`);
  const tabs = [
    { href: base, label: "Chart", active: !on("financials") && !on("valuation") },
    { href: `${base}/financials`, label: "Financials", active: on("financials") },
    ...(valuation
      ? [{ href: `${base}/valuation`, label: "Valuation", active: on("valuation") }]
      : []),
  ];
  return (
    <nav aria-label={`${ticker} sections`} className="flex gap-1 border-b">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cn(
            "-mb-px flex min-h-9 items-center border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground",
            t.active && "border-primary font-medium text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
