/** A rectangle in any unit (the heatmap lays out in pixels and renders in percentages). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placed<T> {
  item: T;
  rect: Rect;
}

/**
 * Squarified treemap (Bruls, Huizing and van Wijk, 2000): tiles with areas proportional to
 * their values, laid out in rows that keep aspect ratios close to 1. Items with a missing, zero
 * or negative value are left out. Larger values come first; ties keep their input order.
 */
export function squarify<T>(
  items: readonly T[],
  value: (item: T) => number,
  bounds: Rect,
): Placed<T>[] {
  const entries = items
    .map((item, index) => ({ item, index, v: value(item) }))
    .filter((e) => Number.isFinite(e.v) && e.v > 0)
    .sort((a, b) => b.v - a.v || a.index - b.index);
  const total = entries.reduce((s, e) => s + e.v, 0);
  if (entries.length === 0 || bounds.w <= 0 || bounds.h <= 0) return [];
  const scale = (bounds.w * bounds.h) / total;
  const areas = entries.map((e) => e.v * scale);

  const out: Placed<T>[] = [];
  const free = { ...bounds };
  let start = 0;
  while (start < areas.length) {
    const side = Math.min(free.w, free.h);
    // Grow the row while its worst aspect ratio improves.
    let end = start + 1;
    let sum = areas[start]!;
    let worst = worstRatio(sum, areas[start]!, areas[start]!, side);
    while (end < areas.length) {
      const nextSum = sum + areas[end]!;
      const nextWorst = worstRatio(nextSum, areas[start]!, areas[end]!, side);
      if (nextWorst > worst) break;
      sum = nextSum;
      worst = nextWorst;
      end++;
    }
    const last = end === areas.length;
    if (free.w >= free.h) {
      // A column on the left; the final row takes the rest of the width exactly.
      const width = last ? free.w : sum / free.h;
      let y = free.y;
      for (let i = start; i < end; i++) {
        const h = i === end - 1 ? free.y + free.h - y : areas[i]! / width;
        out.push({ item: entries[i]!.item, rect: { x: free.x, y, w: width, h } });
        y += h;
      }
      free.x += width;
      free.w -= width;
    } else {
      // A row along the top.
      const height = last ? free.h : sum / free.w;
      let x = free.x;
      for (let i = start; i < end; i++) {
        const w = i === end - 1 ? free.x + free.w - x : areas[i]! / height;
        out.push({ item: entries[i]!.item, rect: { x, y: free.y, w, h: height } });
        x += w;
      }
      free.y += height;
      free.h -= height;
    }
    start = end;
  }
  return out;
}

/** The worst aspect ratio in a row with total area `sum`, largest area `max` and smallest `min`. */
function worstRatio(sum: number, max: number, min: number, side: number): number {
  const s2 = sum * sum;
  const w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}
