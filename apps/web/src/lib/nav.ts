import type { FlagKey } from "@market/config";
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

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only while this feature flag is on. */
  flag?: FlagKey;
}

/** Navigation (spec §6). Sections are added as features ship; flagged ones can be hidden. */
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

/** Sections kept in the phone's bottom bar; the rest open from "More". */
const BAR = new Set(["/", "/screener", "/watchlists", "/portfolio"]);

export function splitNav(items: NavItem[]): { bar: NavItem[]; more: NavItem[] } {
  return {
    bar: items.filter((item) => BAR.has(item.href)),
    more: items.filter((item) => !BAR.has(item.href)),
  };
}
