"use client";

import { cn } from "@market/ui";
import { Activity, Filter, LayoutDashboard, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Left navigation (spec §6). Sections are added here as each Phase 1 group ships. */
export const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Markets", icon: LayoutDashboard },
  { href: "/screener", label: "Screener", icon: Filter },
  { href: "/admin/data-health", label: "Data health", icon: Activity },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/" || pathname.startsWith("/stocks/")
    : pathname.startsWith(href);
}

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 md:flex-col">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
              active && "bg-muted font-medium text-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
