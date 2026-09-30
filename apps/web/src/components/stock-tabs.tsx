"use client";

import { cn } from "@market/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function StockTabs({ ticker }: { ticker: string }) {
  const pathname = usePathname();
  const base = `/stocks/${encodeURIComponent(ticker)}`;
  const tabs = [
    { href: base, label: "Chart", active: !pathname.endsWith("/financials") },
    { href: `${base}/financials`, label: "Financials", active: pathname.endsWith("/financials") },
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
