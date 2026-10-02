import { z } from "zod";

/**
 * The Markets dashboard's layout (Phase 2 step F2, spec §6): which widgets show, in what order
 * and how wide. Plain TypeScript shared by the page, the editor and the server action.
 */
export const WIDGETS = {
  indices: { title: "Index ETFs", size: "full" },
  watchlists: { title: "Your watchlists", size: "half" },
  alerts: { title: "Recent alerts", size: "half" },
  gainers: { title: "Top gainers", size: "half" },
  losers: { title: "Top losers", size: "half" },
  portfolio: { title: "Portfolios", size: "half" },
  calendar: { title: "Coming up", size: "half" },
  screen: { title: "Screen results", size: "full" },
} as const satisfies Record<string, { title: string; size: "half" | "full" }>;

export type WidgetId = keyof typeof WIDGETS;
export const WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[];

const Id = z.enum(WIDGET_IDS as [WidgetId, ...WidgetId[]]);
const ScreenId = z.string().regex(/^\d{1,18}$/);

export const LayoutItem = z.object({
  id: Id,
  size: z.enum(["half", "full"]),
  hidden: z.boolean(),
  /** For the screen widget: which saved screen it shows (the first one by name when unset). */
  screenId: ScreenId.optional(),
});
export type LayoutItem = z.infer<typeof LayoutItem>;
export type Layout = LayoutItem[];

export const DEFAULT_LAYOUT: Layout = WIDGET_IDS.map((id) => ({
  id,
  size: WIDGETS[id].size,
  hidden: false,
}));

/**
 * A stored layout made safe to use: unreadable items dropped, each widget once, and widgets
 * added since it was saved appended in their default form.
 */
export function normalizeLayout(raw: unknown): Layout {
  const out: Layout = [];
  const seen = new Set<WidgetId>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = LayoutItem.safeParse(item);
      if (parsed.success && !seen.has(parsed.data.id)) {
        seen.add(parsed.data.id);
        out.push(parsed.data);
      }
    }
  }
  for (const d of DEFAULT_LAYOUT) if (!seen.has(d.id)) out.push({ ...d });
  return out;
}

/** One change from the editor. */
export const LayoutChange = z.discriminatedUnion("type", [
  /** Swap with the next visible widget before (-1) or after (1). */
  z.object({ type: z.literal("move"), id: Id, delta: z.union([z.literal(-1), z.literal(1)]) }),
  /** The visible widgets in a new order (drag and drop); hidden ones keep their places after. */
  z.object({ type: z.literal("order"), ids: z.array(Id).min(1).max(WIDGET_IDS.length) }),
  z.object({ type: z.literal("size"), id: Id, size: z.enum(["half", "full"]) }),
  z.object({ type: z.literal("hidden"), id: Id, hidden: z.boolean() }),
  z.object({ type: z.literal("screen"), screenId: ScreenId }),
  z.object({ type: z.literal("reset") }),
]);
export type LayoutChange = z.infer<typeof LayoutChange>;

export function applyChange(layout: Layout, change: LayoutChange): Layout {
  switch (change.type) {
    case "reset":
      return DEFAULT_LAYOUT.map((d) => ({ ...d }));
    case "size":
    case "hidden": {
      const patch = change.type === "size" ? { size: change.size } : { hidden: change.hidden };
      return layout.map((w) => (w.id === change.id ? { ...w, ...patch } : w));
    }
    case "screen":
      return layout.map((w) => (w.id === "screen" ? { ...w, screenId: change.screenId } : w));
    case "move": {
      const visible = layout.filter((w) => !w.hidden).map((w) => w.id);
      const i = visible.indexOf(change.id);
      const j = i + change.delta;
      if (i < 0 || j < 0 || j >= visible.length) return layout;
      const a = layout.findIndex((w) => w.id === visible[i]);
      const b = layout.findIndex((w) => w.id === visible[j]);
      const out = [...layout];
      [out[a], out[b]] = [out[b]!, out[a]!];
      return out;
    }
    case "order": {
      const byId = new Map(layout.map((w) => [w.id, w]));
      const ordered = [...new Set(change.ids)]
        .map((id) => byId.get(id))
        .filter((w): w is LayoutItem => w !== undefined && !w.hidden);
      const placed = new Set(ordered.map((w) => w.id));
      return [...ordered, ...layout.filter((w) => !placed.has(w.id))];
    }
  }
}

/** The visible widgets with `dragged` moved to just before `target` (drag and drop). */
export function dropOrder(layout: Layout, dragged: WidgetId, target: WidgetId): WidgetId[] {
  const visible = layout.filter((w) => !w.hidden).map((w) => w.id);
  if (dragged === target || !visible.includes(dragged) || !visible.includes(target)) return visible;
  const rest = visible.filter((id) => id !== dragged);
  rest.splice(rest.indexOf(target), 0, dragged);
  return rest;
}
