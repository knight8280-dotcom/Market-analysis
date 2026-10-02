"use client";

import { Button, cn } from "@market/ui";
import { GripVertical } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { changeDashboard } from "../../app/(app)/dashboard-actions";
import {
  dropOrder,
  WIDGETS,
  type Layout,
  type LayoutChange,
  type WidgetId,
} from "../../lib/dashboard";

const select =
  "min-h-8 rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

/**
 * The Markets dashboard's grid (Phase 2 step F2, spec §6). While editing, each widget has
 * buttons to move it, change its width or hide it (the keyboard way, WCAG 2.5.7), and a handle
 * to drag it with a mouse. Changes are saved at once without leaving the page, and focus comes
 * back to the button that was used.
 */
export function DashboardGrid({
  layout,
  editing,
  widgets,
  screens,
}: {
  layout: Layout;
  editing: boolean;
  /** Server-rendered content of each visible widget. */
  widgets: Partial<Record<WidgetId, ReactNode>>;
  screens: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState<WidgetId | null>(null);
  // Read in drag events, which can fire before React re-renders with the new state.
  const draggingRef = useRef<WidgetId | null>(null);
  const focusAfter = useRef<string | null>(null);

  const change = (c: LayoutChange, control: string, announce: string) => {
    if (busy) return;
    focusAfter.current = control;
    startTransition(async () => {
      const saved = await changeDashboard(c);
      setMessage(saved ? announce : "That change could not be saved.");
      if (saved) router.refresh();
    });
  };

  // When the new layout arrives, put focus back on the control that was used, or on its
  // widget's other move button when it reached an end (moving reorders the DOM).
  useEffect(() => {
    const control = focusAfter.current;
    if (!control) return;
    focusAfter.current = null;
    const find = (c: string) => document.querySelector<HTMLButtonElement>(`[data-control="${c}"]`);
    const [id] = control.split(":");
    const target = [control, `${id}:down`, `${id}:up`, "reset"]
      .map(find)
      .find((el) => el && !el.disabled);
    target?.focus();
  }, [layout]);

  const visible = layout.filter((w) => !w.hidden);
  const hidden = layout.filter((w) => w.hidden);

  return (
    <div className="flex flex-col gap-4">
      {editing ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3 text-sm">
          <p className="text-muted-foreground">
            Move, resize or hide widgets with their buttons, or drag one by its handle onto another.
            Changes are saved as you make them.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {hidden.length ? (
              <div role="group" aria-label="Hidden widgets" className="flex flex-wrap gap-1">
                {hidden.map((w) => (
                  <Button
                    key={w.id}
                    size="sm"
                    variant="secondary"
                    data-control={`${w.id}:show`}
                    aria-label={`Show ${WIDGETS[w.id].title}`}
                    onClick={() =>
                      change(
                        { type: "hidden", id: w.id, hidden: false },
                        `${w.id}:hide`,
                        `${WIDGETS[w.id].title} shown.`,
                      )
                    }
                  >
                    + {WIDGETS[w.id].title}
                  </Button>
                ))}
              </div>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              data-control="reset"
              onClick={() => change({ type: "reset" }, "reset", "Layout reset.")}
            >
              Reset layout
            </Button>
            <p aria-live="polite" data-testid="dashboard-status" className="text-xs">
              {message}
            </p>
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" data-testid="dashboard">
        {visible.map((w, i) => {
          const title = WIDGETS[w.id].title;
          return (
            <div
              key={w.id}
              id={`widget-${w.id}`}
              data-widget={w.id}
              data-size={w.size}
              className={cn(
                "flex min-w-0 flex-col gap-2",
                w.size === "full" && "lg:col-span-2",
                dragging === w.id && "opacity-50",
              )}
              onDragOver={
                editing
                  ? (e) => {
                      if (draggingRef.current) e.preventDefault();
                    }
                  : undefined
              }
              onDrop={
                editing
                  ? (e) => {
                      e.preventDefault();
                      const from = draggingRef.current;
                      draggingRef.current = null;
                      setDragging(null);
                      if (from && from !== w.id) {
                        change(
                          { type: "order", ids: dropOrder(layout, from, w.id) },
                          `${from}:up`,
                          `${WIDGETS[from].title} moved.`,
                        );
                      }
                    }
                  : undefined
              }
            >
              {editing ? (
                <div
                  role="group"
                  aria-label={`Arrange ${title}`}
                  className="flex flex-wrap items-center gap-1 rounded-md border border-dashed px-2 py-1"
                >
                  <span
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", w.id);
                      e.dataTransfer.effectAllowed = "move";
                      draggingRef.current = w.id;
                      setDragging(w.id);
                    }}
                    onDragEnd={() => {
                      draggingRef.current = null;
                      setDragging(null);
                    }}
                    data-testid={`drag-${w.id}`}
                    title={`Drag ${title}`}
                    className="flex size-8 cursor-grab items-center justify-center text-muted-foreground"
                  >
                    <GripVertical aria-hidden className="size-4" />
                  </span>
                  <span className="mr-auto text-xs font-medium">{title}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={i === 0}
                    data-control={`${w.id}:up`}
                    aria-label={`Move ${title} up`}
                    onClick={() =>
                      change(
                        { type: "move", id: w.id, delta: -1 },
                        `${w.id}:up`,
                        `${title} moved up.`,
                      )
                    }
                  >
                    Up
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={i === visible.length - 1}
                    data-control={`${w.id}:down`}
                    aria-label={`Move ${title} down`}
                    onClick={() =>
                      change(
                        { type: "move", id: w.id, delta: 1 },
                        `${w.id}:down`,
                        `${title} moved down.`,
                      )
                    }
                  >
                    Down
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-control={`${w.id}:size`}
                    aria-label={`Make ${title} ${w.size === "full" ? "half" : "full"} width`}
                    onClick={() =>
                      change(
                        { type: "size", id: w.id, size: w.size === "full" ? "half" : "full" },
                        `${w.id}:size`,
                        `${title} is ${w.size === "full" ? "half" : "full"} width.`,
                      )
                    }
                  >
                    {w.size === "full" ? "Half width" : "Full width"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-control={`${w.id}:hide`}
                    aria-label={`Hide ${title}`}
                    onClick={() =>
                      change(
                        { type: "hidden", id: w.id, hidden: true },
                        `${w.id}:show`,
                        `${title} hidden; show it again from the list above.`,
                      )
                    }
                  >
                    Hide
                  </Button>
                  {w.id === "screen" && screens.length > 0 ? (
                    <select
                      aria-label="Saved screen to show"
                      value={w.screenId ?? screens[0]!.id}
                      onChange={(e) =>
                        change(
                          { type: "screen", screenId: e.target.value },
                          "screen:size",
                          "Screen changed.",
                        )
                      }
                      className={select}
                    >
                      {screens.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              ) : null}
              {widgets[w.id]}
            </div>
          );
        })}
      </div>
    </div>
  );
}
