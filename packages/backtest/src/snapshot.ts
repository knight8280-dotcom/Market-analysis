import { createHash } from "node:crypto";
import type { BacktestData } from "./data";
import { ENGINE_VERSION } from "./engine";

/**
 * Reproducibility (Phase 2 step B7): a run records the engine version and a fingerprint of the
 * exact data it used. Same version and fingerprint, same results. Node-only (hashing), so it is
 * a separate entry point from the browser-safe schema.
 */

export const PACKAGE_VERSION = "0.1.0";

export function codeVersion(gitSha?: string | null): string {
  return `backtest ${PACKAGE_VERSION}, engine ${ENGINE_VERSION}${gitSha ? `, ${gitSha.slice(0, 12)}` : ""}`;
}

/**
 * SHA-256 of the data in a canonical form: object keys sorted, numbers in their shortest
 * round-trip form. Streams into the hash, so large universes do not build one huge string.
 */
export function dataSnapshotId(data: BacktestData): string {
  const hash = createHash("sha256");
  const feed = (v: unknown): void => {
    if (v === null || v === undefined) {
      hash.update("null");
    } else if (typeof v === "number") {
      hash.update(Number.isFinite(v) ? String(v) : "NaN");
    } else if (typeof v === "string") {
      hash.update(JSON.stringify(v));
    } else if (typeof v === "boolean") {
      hash.update(v ? "true" : "false");
    } else if (Array.isArray(v)) {
      hash.update("[");
      v.forEach((x, i) => {
        if (i) hash.update(",");
        feed(x);
      });
      hash.update("]");
    } else if (typeof v === "object") {
      hash.update("{");
      Object.keys(v)
        .sort()
        .forEach((k, i) => {
          if (i) hash.update(",");
          hash.update(JSON.stringify(k));
          hash.update(":");
          feed((v as Record<string, unknown>)[k]);
        });
      hash.update("}");
    }
  };
  feed(data);
  return hash.digest("hex");
}
