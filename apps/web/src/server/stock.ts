import "server-only";
import { cache } from "react";
import { db } from "./db";
import { findSecurity } from "./market";

export function tickerOf(raw: string): string {
  return decodeURIComponent(raw).trim().toUpperCase();
}

/** One lookup per request, shared by the ticker layout and its pages. */
export const securityForTicker = cache((ticker: string) => findSecurity(db(), ticker));
