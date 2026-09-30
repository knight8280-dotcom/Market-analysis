/**
 * The heatmap's periods and color scale. Blue for gains and orange for losses (distinguishable
 * with the common forms of color blindness), through a neutral gray; every tile also shows a
 * signed percentage, so color is never the only cue. Every color keeps white text at a contrast
 * of at least 4.5:1 (WCAG AA), checked in the unit tests.
 */
export const HEATMAP_PERIODS = [
  { id: "1d", label: "1 day", field: "change_1d", full: 0.03 },
  { id: "1w", label: "1 week", field: "return_1w", full: 0.06 },
  { id: "1m", label: "1 month", field: "return_1m", full: 0.1 },
  { id: "3m", label: "3 months", field: "return_3m", full: 0.2 },
  { id: "ytd", label: "Year to date", field: "return_ytd", full: 0.3 },
  { id: "1y", label: "1 year", field: "return_1y", full: 0.4 },
] as const;

export type HeatmapPeriod = (typeof HEATMAP_PERIODS)[number];
export type HeatmapPeriodId = HeatmapPeriod["id"];

const NEUTRAL = [82, 82, 91] as const; // #52525b
const UP = [29, 78, 216] as const; // #1d4ed8
const DOWN = [194, 65, 12] as const; // #c2410c

const hex = (rgb: readonly number[]) =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

/**
 * Tile color for a change (a fraction). Changes at or beyond `full` get the strongest color;
 * missing changes are neutral.
 */
export function heatColor(change: number | null, full: number): string {
  if (change === null || !Number.isFinite(change) || change === 0) return hex(NEUTRAL);
  const t = Math.min(1, Math.abs(change) / full);
  const end = change > 0 ? UP : DOWN;
  return hex(NEUTRAL.map((n, i) => n + (end[i]! - n) * t));
}

/** WCAG relative luminance of a #rrggbb color. */
export function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(color.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio of white text on a #rrggbb background. */
export function contrastWithWhite(color: string): number {
  return 1.05 / (luminance(color) + 0.05);
}
