"use client";

import { Button, Input } from "@market/ui";
import { useState, type FormEvent } from "react";
import {
  describeDrawing,
  DRAWING_KINDS,
  DRAWING_LABELS,
  POINTS,
  sessionIndex,
  type Drawing,
  type DrawingInput,
  type DrawingKind,
  type DrawingPoint,
} from "../../lib/chart/drawings";

const field = "flex flex-col gap-1 text-xs text-muted-foreground";
const select =
  "min-h-8 rounded-md border bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export type NewDrawing = Omit<DrawingInput, "basis">;

/** Tool buttons above the chart, and the text box a text label asks for. */
export function DrawingToolbar({
  tool,
  onTool,
  textAt,
  onSaveText,
  message,
}: {
  tool: DrawingKind | null;
  onTool: (tool: DrawingKind | null) => void;
  textAt: DrawingPoint | null;
  onSaveText: (text: string | null) => void;
  message: string;
}) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSaveText(text.trim() || null);
    setText("");
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        <div role="group" aria-label="Drawing tools" className="flex flex-wrap gap-1">
          {DRAWING_KINDS.map((k) => (
            <Button
              key={k}
              size="sm"
              variant={tool === k ? "secondary" : "ghost"}
              aria-pressed={tool === k}
              onClick={() => onTool(tool === k ? null : k)}
            >
              {DRAWING_LABELS[k]}
            </Button>
          ))}
        </div>
        {tool ? (
          <Button size="sm" variant="ghost" onClick={() => onTool(null)}>
            Stop drawing
          </Button>
        ) : null}
        <p
          aria-live="polite"
          className="text-xs text-muted-foreground"
          data-testid="drawing-status"
        >
          {message}
        </p>
      </div>
      {textAt ? (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <label className={field}>
            Text for the label
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={100}
              required
              autoFocus
              className="w-64"
            />
          </label>
          <Button type="submit" size="sm" variant="secondary">
            Save text
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => onSaveText(null)}>
            Cancel
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The drawings in words, each with a delete button, and a form to add one from the keyboard
 * (spec §6: every chart feature works without a pointer; WCAG 2.5.7: no drag-only actions).
 */
export function DrawingList({
  drawings,
  hidden,
  otherBasis,
  times,
  lastClose,
  onAdd,
  onDelete,
}: {
  drawings: readonly Drawing[];
  /** Drawings made on the other price basis, not shown on this chart. */
  hidden: number;
  otherBasis: string;
  times: readonly string[];
  lastClose: number;
  onAdd: (d: NewDrawing) => Promise<string | null>;
  onDelete: (d: Drawing) => void;
}) {
  const [kind, setKind] = useState<DrawingKind>("horizontal");
  const [error, setError] = useState<string | null>(null);
  const first = times[0] ?? "";
  const last = times.at(-1) ?? "";

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => {
      const v = form.get(name);
      return typeof v === "string" ? v.trim() : "";
    };
    const point = (n: 1 | 2): DrawingPoint | string => {
      const date = text(`date${n}`);
      const price = Number(text(`price${n}`).replace(/[$,\s]/g, ""));
      const i = sessionIndex(times, date);
      if (i < 0) return `Point ${n}: pick a date from ${first} on.`;
      if (!(price > 0)) return `Point ${n}: enter a price above zero.`;
      return { time: times[i]!, price };
    };
    const points = [point(1), ...(POINTS[kind] === 2 ? [point(2)] : [])];
    const problem = points.find((p): p is string => typeof p === "string");
    if (problem) {
      setError(problem);
      return;
    }
    const label = text("label");
    const failed = await onAdd({
      kind,
      points: points as DrawingPoint[],
      ...(label ? { label } : {}),
    });
    setError(failed);
  };

  return (
    <details className="rounded-lg border">
      <summary className="flex min-h-9 cursor-pointer items-center px-3 text-sm">
        Drawings ({drawings.length})
      </summary>
      <div className="flex flex-col gap-4 border-t p-3">
        {drawings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None on this chart. Pick a tool above and click on the chart, or add one below.
          </p>
        ) : (
          <ul aria-label="Drawings on this chart" className="flex flex-col gap-1 text-sm">
            {drawings.map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-2">
                <span>{describeDrawing(d)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${describeDrawing(d)}`}
                  onClick={() => onDelete(d)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 ? (
          <p className="text-xs text-muted-foreground">
            {hidden} {hidden === 1 ? "drawing was" : "drawings were"} made on the {otherBasis} chart
            and {hidden === 1 ? "shows" : "show"} there.
          </p>
        ) : null}
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
          <h3 className="text-sm font-semibold">Add a drawing</h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className={field}>
              Kind
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as DrawingKind)}
                className={select}
              >
                {DRAWING_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {DRAWING_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            {([1, 2] as const)
              .filter((n) => n <= POINTS[kind])
              .map((n) => (
                <fieldset key={n} className="flex items-end gap-2">
                  <legend className="sr-only">
                    {POINTS[kind] === 1 ? "Point" : n === 1 ? "First point" : "Second point"}
                  </legend>
                  <label className={field}>
                    {POINTS[kind] === 1 ? "Date" : n === 1 ? "From date" : "To date"}
                    <Input
                      type="date"
                      name={`date${n}`}
                      min={first}
                      max={last}
                      defaultValue={n === 1 && POINTS[kind] === 2 ? first : last}
                      required
                      className="w-40"
                    />
                  </label>
                  <label className={field}>
                    {POINTS[kind] === 1 ? "Price" : n === 1 ? "From price" : "To price"}
                    <Input
                      name={`price${n}`}
                      inputMode="decimal"
                      defaultValue={String(lastClose)}
                      required
                      className="w-28"
                    />
                  </label>
                </fieldset>
              ))}
            {kind === "text" || kind === "horizontal" ? (
              <label className={field}>
                {kind === "text" ? "Text" : "Label (optional)"}
                <Input name="label" maxLength={100} required={kind === "text"} className="w-48" />
              </label>
            ) : null}
            <Button type="submit" size="sm" variant="secondary">
              Add drawing
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-down">
              {error}
            </p>
          ) : null}
        </form>
      </div>
    </details>
  );
}
