import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AssetClass } from "@market/market-data";
import { z } from "zod";

/** The symbols the worker ingests from the primary price provider (config/universe.json). */
export const Universe = z.object({
  description: z.string().optional(),
  symbols: z
    .array(z.object({ symbol: z.string().regex(/^[A-Z0-9.\-^]{1,15}$/), asset_class: AssetClass }))
    .min(1)
    .refine(
      (list) => new Set(list.map((s) => s.symbol)).size === list.length,
      "symbols must be unique",
    ),
});
export type Universe = z.infer<typeof Universe>;

export const DEFAULT_UNIVERSE_FILE = fileURLToPath(
  new URL("../../../config/universe.json", import.meta.url),
);

export function loadUniverse(path: string = DEFAULT_UNIVERSE_FILE): Universe {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const result = Universe.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid universe file ${path}: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}

export function assetClassMap(universe: Universe): Record<string, AssetClass> {
  return Object.fromEntries(universe.symbols.map((s) => [s.symbol, s.asset_class]));
}
