import { describe, expect, it } from "vitest";
import { layoutHeatmap, neighbor, weightedChange, type HeatTile } from "../src/lib/heatmap/layout";
import { contrastWithWhite, heatColor, HEATMAP_PERIODS } from "../src/lib/heatmap/scale";
import { squarify, type Rect } from "../src/lib/heatmap/treemap";

/** Deterministic pseudo-random numbers (mulberry32), so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const area = (r: Rect) => r.w * r.h;
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

describe("squarify", () => {
  const bounds = { x: 10, y: 20, w: 900, h: 500 };
  const rand = rng(7);
  // Market-cap-like sizes: a few giants and a long tail.
  const values = Array.from({ length: 200 }, () => Math.exp(rand() * 8));

  const placed = squarify(values, (v) => v, bounds);
  const total = values.reduce((s, v) => s + v, 0);

  it("gives every tile an area proportional to its value", () => {
    expect(placed).toHaveLength(values.length);
    for (const p of placed) {
      expect(area(p.rect) / area(bounds)).toBeCloseTo(p.item / total, 9);
    }
  });

  it("fills the bounds exactly, without overlaps", () => {
    const sum = placed.reduce((s, p) => s + area(p.rect), 0);
    expect(sum).toBeCloseTo(area(bounds), 6);
    for (const { rect: r } of placed) {
      expect(r.x).toBeGreaterThanOrEqual(bounds.x - 1e-9);
      expect(r.y).toBeGreaterThanOrEqual(bounds.y - 1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(bounds.x + bounds.w + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(bounds.y + bounds.h + 1e-6);
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlap(placed[i]!.rect, placed[j]!.rect)).toBeLessThan(1e-6);
      }
    }
  });

  it("keeps tiles close to square", () => {
    // Slice-and-dice would give ratios in the hundreds for this input.
    const ratios = placed
      .map(({ rect: r }) => Math.max(r.w / r.h, r.h / r.w))
      .sort((a, b) => a - b);
    expect(ratios[Math.floor(ratios.length / 2)]).toBeLessThan(2.5);
  });

  it("orders by value and drops missing, zero and negative values", () => {
    const out = squarify([3, 0, -1, Number.NaN, 5, 3], (v) => v, bounds);
    expect(out.map((p) => p.item)).toEqual([5, 3, 3]);
    expect(squarify([], (v: number) => v, bounds)).toEqual([]);
    expect(squarify([1], (v) => v, { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
  });

  it("lays out 5,000 tiles in well under the 500 ms budget", () => {
    const many = Array.from({ length: 5000 }, () => Math.exp(rand() * 10));
    const t0 = performance.now();
    squarify(many, (v) => v, bounds);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("layoutHeatmap", () => {
  const rand = rng(11);
  const sectors = ["Technology", "Energy", "Finance", "Health care", "Utilities"];
  const tiles: HeatTile[] = Array.from({ length: 500 }, (_, i) => ({
    securityId: String(i),
    ticker: `T${i}`,
    name: `Test ${i}`,
    group: sectors[i % sectors.length]!,
    size: Math.exp(rand() * 9),
    change: i % 17 === 0 ? null : (rand() - 0.5) * 0.1,
  }));

  it("nests every tile inside its group and sizes groups by their totals", () => {
    const groups = layoutHeatmap(tiles, 1200, 675);
    expect(groups.map((g) => g.name).sort()).toEqual([...sectors].sort());
    expect(groups.reduce((s, g) => s + g.tiles.length, 0)).toBe(500);
    const total = tiles.reduce((s, t) => s + t.size, 0);
    for (const g of groups) {
      const groupTotal = g.tiles.reduce((s, t) => s + t.tile.size, 0);
      expect(area(g.rect) / (1200 * 675)).toBeCloseTo(groupTotal / total, 9);
      for (const { tile, rect } of g.tiles) {
        expect(tile.group).toBe(g.name);
        expect(rect.x).toBeGreaterThanOrEqual(g.rect.x);
        expect(rect.y).toBeGreaterThanOrEqual(g.rect.y + (g.header ? 18 : 0));
        expect(rect.x + rect.w).toBeLessThanOrEqual(g.rect.x + g.rect.w + 1e-6);
        expect(rect.y + rect.h).toBeLessThanOrEqual(g.rect.y + g.rect.h + 1e-6);
      }
    }
  });

  it("leaves out tiles without a size", () => {
    const groups = layoutHeatmap(
      [
        { ...tiles[0]!, size: 0 },
        { ...tiles[1]!, size: Number.NaN },
        { ...tiles[2]!, size: 5 },
      ],
      400,
      300,
    );
    expect(groups.flatMap((g) => g.tiles.map((t) => t.tile.securityId))).toEqual(["2"]);
  });

  it("weights a group's change by size and skips unknown changes", () => {
    const t = (size: number, change: number | null) => ({ ...tiles[0]!, size, change });
    expect(weightedChange([t(3, 0.01), t(1, -0.03), t(10, null)])).toBeCloseTo(0, 12);
    expect(weightedChange([t(1, 0.02), t(1, 0.04)])).toBeCloseTo(0.03, 12);
    expect(weightedChange([t(1, null)])).toBeNull();
  });
});

describe("neighbor (arrow-key navigation)", () => {
  // 0 1 2
  // 3 4 4   (4 spans two columns)
  // 5 5 6
  const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const rects = [
    R(0, 0, 10, 10),
    R(10, 0, 10, 10),
    R(20, 0, 10, 10),
    R(0, 10, 10, 10),
    R(10, 10, 20, 10),
    R(0, 20, 20, 10),
    R(20, 20, 10, 10),
  ];

  it("moves to the adjacent tile on each side", () => {
    expect(neighbor(rects, 0, "ArrowRight")).toBe(1);
    expect(neighbor(rects, 0, "ArrowDown")).toBe(3);
    expect(neighbor(rects, 3, "ArrowRight")).toBe(4);
    expect(neighbor(rects, 4, "ArrowLeft")).toBe(3);
    expect(neighbor(rects, 2, "ArrowDown")).toBe(4);
    expect(neighbor(rects, 4, "ArrowDown")).toBe(6);
    expect(neighbor(rects, 6, "ArrowLeft")).toBe(5);
    expect(neighbor(rects, 5, "ArrowUp")).toBe(3);
  });

  it("stays put at an edge", () => {
    expect(neighbor(rects, 0, "ArrowLeft")).toBe(0);
    expect(neighbor(rects, 0, "ArrowUp")).toBe(0);
    expect(neighbor(rects, 6, "ArrowRight")).toBe(6);
    expect(neighbor(rects, 6, "ArrowDown")).toBe(6);
  });

  it("reaches every tile of a real layout", () => {
    const rand = rng(3);
    const tiles: HeatTile[] = Array.from({ length: 60 }, (_, i) => ({
      securityId: String(i),
      ticker: `T${i}`,
      name: `T${i}`,
      group: `G${i % 4}`,
      size: 1 + rand() * 50,
      change: 0,
    }));
    const flat = layoutHeatmap(tiles, 800, 450).flatMap((g) => g.tiles.map((t) => t.rect));
    const seen = new Set([0]);
    const queue = [0];
    while (queue.length) {
      const i = queue.shift()!;
      for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const) {
        const j = neighbor(flat, i, key);
        if (!seen.has(j)) {
          seen.add(j);
          queue.push(j);
        }
      }
    }
    expect(seen.size).toBe(flat.length);
  });
});

describe("heatColor", () => {
  it("keeps white text readable (WCAG AA 4.5:1) across the whole scale", () => {
    for (let c = -0.05; c <= 0.05; c += 0.001) {
      expect(contrastWithWhite(heatColor(c, 0.03))).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastWithWhite(heatColor(null, 0.03))).toBeGreaterThanOrEqual(4.5);
  });

  it("is neutral at zero or unknown, blue for gains, orange for losses, and saturates at full", () => {
    expect(heatColor(0, 0.03)).toBe("#52525b");
    expect(heatColor(null, 0.03)).toBe("#52525b");
    expect(heatColor(0.03, 0.03)).toBe("#1d4ed8");
    expect(heatColor(0.2, 0.03)).toBe("#1d4ed8");
    expect(heatColor(-0.03, 0.03)).toBe("#c2410c");
    const half = heatColor(0.015, 0.03);
    expect(half).not.toBe("#52525b");
    expect(half).not.toBe("#1d4ed8");
  });

  it("has a scale for every period, widening with the horizon", () => {
    const fulls = HEATMAP_PERIODS.map((p) => p.full);
    expect([...fulls].sort((a, b) => a - b)).toEqual(fulls);
  });
});
