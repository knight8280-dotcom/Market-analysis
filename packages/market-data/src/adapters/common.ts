import { sessionFor, zonedTimeToUtc, type IsoDate } from "@market/calendar";
import type { z } from "zod";
import { ProviderResponseError } from "../errors";
import type { ProviderId } from "../types";

/** Parses a vendor payload; a mismatch means the vendor changed shape (spec rule 9). */
export function parseVendor<S extends z.ZodType>(
  provider: ProviderId,
  schema: S,
  data: unknown,
  what: string,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ProviderResponseError(
      provider,
      `Unexpected ${what} response shape: ${detail}`,
      result.error,
    );
  }
  return result.data;
}

const closeCache = new Map<IsoDate, Date>();

/** as_of for a daily bar: the session close, or 16:00 ET if the calendar says the market was shut. */
export function sessionCloseOf(date: IsoDate): Date {
  let close = closeCache.get(date);
  if (!close) {
    close = sessionFor(date)?.close ?? zonedTimeToUtc(date, "16:00");
    closeCache.set(date, close);
  }
  return close;
}

/** Exchange names used by EDGAR and Tiingo, mapped to ISO 10383 MICs. Unknown names map to null. */
const EXCHANGE_MICS: Record<string, string> = {
  NASDAQ: "XNAS",
  NYSE: "XNYS",
  "NYSE ARCA": "ARCX",
  NYSEARCA: "ARCX",
  "NYSE MKT": "XASE",
  "NYSE AMERICAN": "XASE",
  AMEX: "XASE",
  BATS: "BATS",
  CBOE: "BATS",
};

export function exchangeMic(name: string | null | undefined): string | null {
  if (!name) return null;
  return EXCHANGE_MICS[name.trim().toUpperCase()] ?? null;
}
