import { squarify, type Rect } from "./treemap";

export interface HeatTile {
  securityId: string;
  ticker: string;
  name: string;
  group: string;
  /** Tile area weight: market cap or dollar volume. */
  size: number;
  /** Change over the chosen period, as a fraction; null when unknown. */
  change: number | null;
}

export interface LaidTile {
  tile: HeatTile;
  /** Position in the whole map, in pixels. */
  rect: Rect;
}

export interface LaidGroup {
  name: string;
  rect: Rect;
  /** Whether the group is big enough for a visible name strip. */
  header: boolean;
  count: number;
  /** Size-weighted change of the tiles with a known change; null when none has one. */
  change: number | null;
  tiles: LaidTile[];
}

export const GROUP_HEADER_PX = 18;
const GAP_PX = 1;

/** Size-weighted average change; tiles without a change are left out. */
export function weightedChange(tiles: readonly HeatTile[]): number | null {
  let weight = 0;
  let sum = 0;
  for (const t of tiles) {
    if (t.change === null || !Number.isFinite(t.change)) continue;
    weight += t.size;
    sum += t.size * t.change;
  }
  return weight > 0 ? sum / weight : null;
}

/** Tiles by group, in first-seen order; tiles without a positive size are left out. */
export function groupTiles(tiles: readonly HeatTile[]): Map<string, HeatTile[]> {
  const byGroup = new Map<string, HeatTile[]>();
  for (const t of tiles) {
    if (!(t.size > 0) || !Number.isFinite(t.size)) continue;
    const list = byGroup.get(t.group);
    if (list) list.push(t);
    else byGroup.set(t.group, [t]);
  }
  return byGroup;
}

/**
 * Two-level layout: groups (sectors) sized by their total, then each group's tiles inside it,
 * below a name strip when the group has room for one.
 */
export function layoutHeatmap(
  tiles: readonly HeatTile[],
  width: number,
  height: number,
): LaidGroup[] {
  const groups = [...groupTiles(tiles)].map(([name, list]) => ({
    name,
    list,
    total: list.reduce((s, t) => s + t.size, 0),
  }));
  return squarify(groups, (g) => g.total, { x: 0, y: 0, w: width, h: height }).map(
    ({ item: g, rect }) => {
      const inner: Rect = {
        x: rect.x + GAP_PX,
        y: rect.y + GAP_PX,
        w: Math.max(0, rect.w - 2 * GAP_PX),
        h: Math.max(0, rect.h - 2 * GAP_PX),
      };
      const header = inner.h >= GROUP_HEADER_PX * 3 && inner.w >= 72;
      const body: Rect = header
        ? { ...inner, y: inner.y + GROUP_HEADER_PX, h: inner.h - GROUP_HEADER_PX }
        : inner;
      return {
        name: g.name,
        rect,
        header,
        count: g.list.length,
        change: weightedChange(g.list),
        tiles: squarify(g.list, (t) => t.size, body).map(({ item, rect: r }) => ({
          tile: item,
          rect: r,
        })),
      };
    },
  );
}

export type NavKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/**
 * The tile to move to from `from` with an arrow key: the nearest tile on that side, preferring
 * tiles that line up with the current one. Returns `from` when there is none.
 */
export function neighbor(rects: readonly Rect[], from: number, key: NavKey): number {
  const cur = rects[from];
  if (!cur) return from;
  const eps = 0.5;
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  let best = from;
  let bestScore = Infinity;
  rects.forEach((r, i) => {
    if (i === from) return;
    let primary: number;
    switch (key) {
      case "ArrowRight":
        primary = r.x - (cur.x + cur.w);
        break;
      case "ArrowLeft":
        primary = cur.x - (r.x + r.w);
        break;
      case "ArrowDown":
        primary = r.y - (cur.y + cur.h);
        break;
      case "ArrowUp":
        primary = cur.y - (r.y + r.h);
        break;
    }
    if (primary < -eps) return;
    // Distance between the two tiles' spans on the other axis: 0 when they overlap.
    const [a0, a1, b0, b1] = horizontal
      ? [cur.y, cur.y + cur.h, r.y, r.y + r.h]
      : [cur.x, cur.x + cur.w, r.x, r.x + r.w];
    const cross = Math.max(0, b0 - a1, a0 - b1);
    const centerOffset = Math.abs((a0 + a1) / 2 - (b0 + b1) / 2);
    const score = Math.max(0, primary) + 2 * cross + 0.01 * centerOffset;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
