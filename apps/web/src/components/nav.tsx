"use client";

import type { FlagKey } from "@market/config";
import { cn } from "@market/ui";
import {
  Activity,
  Bell,
  Briefcase,
  CalendarDays,
  Filter,
  Grid2x2,
  History,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only while this feature flag is on. */
  flag?: FlagKey;
}

/** Left navigation (spec §6). Sections are added as features ship; flagged ones can be hidden. */
export const NAV: NavItem[] = [
  { href: "/", label: "Markets", icon: LayoutDashboard },
  { href: "/screener", label: "Screener", icon: Filter },
  { href: "/watchlists", label: "Watchlists", icon: ListChecks },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase },
  { href: "/backtests", label: "Backtests", icon: History, flag: "backtests" },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/heatmap", label: "Heatmap", icon: Grid2x2 },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/admin/data-health", label: "Data health", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** The entries to show, given the current feature flags. */
export function visibleNav(flags: Partial<Record<FlagKey, boolean>>): NavItem[] {
  return NAV.filter((item) => !item.flag || flags[item.flag] === true);
}

export function isActive(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/" || pathname.startsWith("/stocks/")
    : pathname.startsWith(href);
}

export function Nav({ flags }: { flags: Partial<Record<FlagKey, boolean>> }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="-mx-1 flex gap-1 overflow-x-auto px-1 md:mx-0 md:flex-col md:px-0"
    >
      {visibleNav(flags).map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
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
