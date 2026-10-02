import { DisclaimerFooter, SampleDataBanner, StaleDataBanner } from "@market/compliance";
import { loadWebEnv } from "@market/config";
import { Button, formatDate, formatDateTimeET } from "@market/ui";
import { LogOut } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { BRAND } from "../../brand";
import { CommandMenu } from "../../components/command-menu";
import { ConnectionStatus } from "../../components/connection-status";
import { BottomNav, Nav } from "../../components/nav";
import { NotificationBell } from "../../components/notification-bell";
import { ThemeToggle } from "../../components/theme-toggle";
import { unreadNotifications } from "../../server/alerts";
import { requireOwner } from "../../server/auth/owner";
import { db } from "../../server/db";
import { enabledFlags } from "../../server/flags";
import { lastUpdated, priceSource, sourceInfo, staleDatasets } from "../../server/market";
import { currentTheme } from "../../server/theme";
import { logout } from "./actions";

/**
 * The signed-in shell: banners, left nav (bottom nav on phones), header with search, and the §12
 * footer.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireOwner();
  const env = loadWebEnv();
  const database = db();
  const source = await priceSource(database);
  const [updated, stale, theme, flags] = await Promise.all([
    source ? lastUpdated(database, source) : null,
    staleDatasets(database),
    currentTheme(),
    enabledFlags(),
  ]);
  const unread = flags.notifications ? await unreadNotifications() : 0;

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <SampleDataBanner appEnv={env.APP_ENV} hasSyntheticData={source === "synthetic"} />
      <StaleDataBanner
        items={stale.map((s) => ({ dataset: s.dataset, since: formatDateTimeET(s.since) }))}
      />
      <ConnectionStatus />
      <div className="flex min-h-dvh flex-col md:flex-row">
        <aside className="border-b p-3 md:w-56 md:shrink-0 md:border-r md:border-b-0">
          <Link href="/" className="block px-3 py-1 text-base font-semibold md:mb-3">
            {BRAND}
          </Link>
          <div className="hidden md:block">
            <Nav flags={flags} />
          </div>
        </aside>
        {/* On phones the bottom navigation is fixed over the page: leave room for it. */}
        <div className="flex min-w-0 flex-1 flex-col pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">
          <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2 md:px-6">
            <CommandMenu flags={flags} />
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {updated?.session ? (
                <>
                  Prices: end-of-day, as of {formatDate(updated.session)} ·{" "}
                  {sourceInfo(updated.source).name}
                  {updated.loadedAt ? <> · loaded {formatDateTimeET(updated.loadedAt)}</> : null}
                </>
              ) : (
                "No prices loaded yet"
              )}
            </p>
            <div className="ml-auto flex items-center gap-1">
              {flags.notifications ? <NotificationBell key={unread} initial={unread} /> : null}
              <ThemeToggle initial={theme} />
              <form action={logout}>
                <Button type="submit" variant="ghost" size="sm">
                  <LogOut aria-hidden />
                  Sign out
                </Button>
              </form>
            </div>
          </header>
          <main id="main" className="flex-1 px-4 py-6 md:px-6">
            {children}
          </main>
          <DisclaimerFooter brand={BRAND} />
        </div>
      </div>
      <BottomNav flags={flags} />
    </>
  );
}
