import { z } from "zod";

/**
 * Chart drawings (Phase 2 step F1, spec §5.2): trend lines, horizontal lines, Fibonacci
 * retracements, rectangles and text, saved per security on the price basis they were drawn on.
 * Plain TypeScript shared by the chart, the server actions and the tests.
 */
export const DRAWING_KINDS = ["trendline", "horizontal", "fibonacci", "rectangle", "text"] as const;
export type DrawingKind = (typeof DRAWING_KINDS)[number];

export const DRAWING_LABELS: Record<DrawingKind, string> = {
  trendline: "Trend line",
  horizontal: "Horizontal line",
  fibonacci: "Fibonacci retracement",
  rectangle: "Rectangle",
  text: "Text",
};

/** Points each kind takes: where to click, or which fields the form asks for. */
export const POINTS: Record<DrawingKind, 1 | 2> = {
  trendline: 2,
  horizontal: 1,
  fibonacci: 2,
  rectangle: 2,
  text: 1,
};

/** The standard retracement levels, as fractions of the move. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/** Drawings kept per security and price basis. */
export const MAX_DRAWINGS = 100;

export const DrawingPoint = z.object({
  time: z.iso.date(),
  price: z.number().finite().positive().max(10_000_000),
});
export type DrawingPoint = z.infer<typeof DrawingPoint>;

export const DrawingInput = z
  .object({
    kind: z.enum(DRAWING_KINDS),
    basis: z.enum(["raw", "adjusted"]),
    points: z.array(DrawingPoint).min(1).max(2),
    label: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.points.length !== POINTS[d.kind]) {
      ctx.addIssue({
        code: "custom",
        path: ["points"],
        message: `${DRAWING_LABELS[d.kind]} takes ${POINTS[d.kind] === 1 ? "one point" : "two points"}`,
      });
    }
    const [a, b] = d.points;
    if (a && b && a.time === b.time && a.price === b.price) {
      ctx.addIssue({ code: "custom", path: ["points"], message: "the two points are the same" });
    }
    if (d.kind === "text" && !d.label) {
      ctx.addIssue({ code: "custom", path: ["label"], message: "enter the text" });
    }
  });
export type DrawingInput = z.infer<typeof DrawingInput>;

export interface Drawing extends DrawingInput {
  id: string;
}

/**
 * Retracement prices from the first point (the start of the move) to the second (its end):
 * 0% is the end of the move and 100% its start, as charting tools draw them.
 */
export function fibLevels(start: number, end: number): { level: number; price: number }[] {
  return FIB_LEVELS.map((level) => ({ level, price: end - (end - start) * level }));
}

/**
 * The index of the session a date falls on, or of the last session before it (dates on weekends
 * and holidays snap back); -1 before the first session. `times` is ascending.
 */
export function sessionIndex(times: readonly string[], date: string): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d)));
};
const price = (p: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(p);
const at = (p: DrawingPoint) => `${day(p.time)} at ${price(p.price)}`;

/** The drawing in words, for the list beside the chart and for screen readers. */
export function describeDrawing(d: DrawingInput): string {
  const [a, b] = d.points as [DrawingPoint, DrawingPoint | undefined];
  switch (d.kind) {
    case "horizontal":
      return `Horizontal line at ${price(a.price)}${d.label ? ` (“${d.label}”)` : ""}`;
    case "text":
      return `Text “${d.label ?? ""}” on ${at(a)}`;
    case "trendline":
      return `Trend line from ${at(a)} to ${at(b!)}`;
    case "rectangle":
      return `Rectangle from ${at(a)} to ${at(b!)}`;
    case "fibonacci": {
      const levels = fibLevels(a.price, b!.price)
        .filter((l) => l.level > 0 && l.level < 1)
        .map((l) => `${(l.level * 100).toFixed(1)}% ${price(l.price)}`)
        .join(", ");
      return `Fibonacci retracement from ${at(a)} to ${at(b!)}: ${levels}`;
    }
  }
}
