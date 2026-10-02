import { loadWebEnv } from "@market/config";
import { EmptyState, formatDate } from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { DashboardGrid } from "../../components/dashboard/dashboard-grid";
import { DashboardWidget, type WidgetContext } from "../../components/dashboard/widgets";
import { DEFAULT_LAYOUT, type WidgetId } from "../../lib/dashboard";
import { requireOwner } from "../../server/auth/owner";
import { dashboardLayout } from "../../server/dashboard";
import { db } from "../../server/db";
import { flagEnabled } from "../../server/flags";
import { assertDisplayable, lastUpdated, priceSource } from "../../server/market";
import { savedScreens } from "../../server/screens";

export const metadata: Metadata = { title: "Markets" };

type Search = Promise<Record<string, string | string[] | undefined>>;

/**
 * Markets: the owner's dashboard (Phase 1 step B4; customizable in Phase 2 step F2). Widgets show
 * in the saved order and width; `?edit=1` arranges them.
 */
export default async function MarketsPage({ searchParams }: { searchParams: Search }) {
  await requireOwner();
  const database = db();
  const source = await priceSource(database);
  if (!source) {
    return (
      <EmptyState title="No prices loaded yet">
        Run <code>pnpm worker bootstrap</code> to load the universe (see docs/RUNBOOK.md).
      </EmptyState>
    );
  }
  assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const updated = await lastUpdated(database, source);
  const session = updated.session!;

  const customizable = await flagEnabled("dashboard");
  const editing = customizable && (await searchParams).edit === "1";
  const layout = customizable ? await dashboardLayout() : DEFAULT_LAYOUT;
  const screens = editing ? (await savedScreens()).map((s) => ({ id: s.id, name: s.name })) : [];
  const context: WidgetContext = {
    database,
    source,
    session,
    loadedAt: updated.loadedAt,
    screenId: layout.find((w) => w.id === "screen")?.screenId,
  };
  const widgets: Partial<Record<WidgetId, ReactNode>> = Object.fromEntries(
    layout
      .filter((w) => !w.hidden)
      .map((w) => [w.id, <DashboardWidget key={w.id} id={w.id} c={context} />]),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Markets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Session of {formatDate(session)}. Press <kbd>/</kbd> or ⌘K to look up a ticker.
          </p>
        </div>
        {customizable ? (
          <Link
            href={editing ? "/" : "/?edit=1"}
            className="inline-flex min-h-9 items-center rounded-md border px-3 text-sm hover:bg-muted"
          >
            {editing ? "Done" : "Customize"}
          </Link>
        ) : null}
      </div>
      <DashboardGrid layout={layout} editing={editing} widgets={widgets} screens={screens} />
    </div>
  );
}
