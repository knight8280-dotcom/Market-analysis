/**
 * Ties CUSIPs (how 13F filers identify securities) to our securities through SEC's
 * fails-to-deliver files, which list each CUSIP with its ticker and issue name (Phase 2 step
 * H2, ADR-032). A match needs the same ticker, ignoring separators (SEC writes BRK-B as BRKB),
 * and issue names that agree, so a reused ticker cannot attach one company's holdings to
 * another. Anything else is reported, not guessed.
 */

export interface CusipSeen {
  cusip: string;
  symbol: string;
  description: string;
  first_seen: string;
  last_seen: string;
}

export interface SecurityNamed {
  security_id: string;
  ticker: string;
  name: string;
}

export interface CusipMatch extends CusipSeen {
  security_id: string;
}

export interface CusipRejection extends CusipSeen {
  security_id: string;
  ticker: string;
  name: string;
}

/** BRK-B, BRK.B, BRK/B and BRKB are one ticker. */
export const compactTicker = (ticker: string): string =>
  ticker.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Words that say what kind of security or company it is, not which one. */
const GENERIC = new Set([
  "ADR",
  "ADS",
  "AND",
  "CAP",
  "CLASS",
  "COM",
  "COMMON",
  "COMPANY",
  "CORP",
  "CORPORATION",
  "DEL",
  "ETF",
  "FDS",
  "FUND",
  "FUNDS",
  "GROUP",
  "GRP",
  "HLDG",
  "HLDGS",
  "HOLDING",
  "HOLDINGS",
  "INC",
  "INCORPORATED",
  "INDEX",
  "LIMITED",
  "LLC",
  "LTD",
  "NEW",
  "NPV",
  "ORD",
  "PAR",
  "PLC",
  "SER",
  "SERIES",
  "SHARES",
  "SHS",
  "SPONSORED",
  "STK",
  "STOCK",
  "THE",
  "TRUST",
  "UNIT",
  "UNITS",
]);

/** The words of a name that identify it: three or more letters, not generic. */
export function nameWords(name: string): Set<string> {
  return new Set(
    name
      .toUpperCase()
      .split(/[^A-Z0-9&]+/)
      .filter((w) => /^[A-Z&]{3,}$/.test(w) && !GENERIC.has(w)),
  );
}

/** Letters and digits only: "WAL-MART INC (DE)" is "WALMARTINCDE". */
const compactName = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Names agree when they share an identifying word, or when they begin with the same four or
 * more letters and digits once punctuation and spaces are gone ("WAL-MART INC (DE)" and
 * "Walmart Inc."; "3M COMPANY" and "3M Co").
 */
export function namesAgree(a: string, b: string): boolean {
  const words = nameWords(a);
  for (const w of nameWords(b)) if (words.has(w)) return true;
  const [x, y] = [compactName(a), compactName(b)];
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return n >= 4;
}

/** Matches CUSIPs to securities by ticker, confirmed by name. */
export function matchCusips(
  seen: readonly CusipSeen[],
  securities: readonly SecurityNamed[],
): { matched: CusipMatch[]; rejected: CusipRejection[] } {
  const byTicker = new Map<string, SecurityNamed[]>();
  for (const s of securities) {
    const key = compactTicker(s.ticker);
    byTicker.set(key, [...(byTicker.get(key) ?? []), s]);
  }
  const matched: CusipMatch[] = [];
  const rejected: CusipRejection[] = [];
  for (const c of seen) {
    for (const s of byTicker.get(compactTicker(c.symbol)) ?? []) {
      if (namesAgree(c.description, s.name)) matched.push({ ...c, security_id: s.security_id });
      else rejected.push({ ...c, security_id: s.security_id, ticker: s.ticker, name: s.name });
    }
  }
  return { matched, rejected };
}
