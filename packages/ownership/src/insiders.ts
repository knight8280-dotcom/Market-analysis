/**
 * Descriptive views of Form 4 data (spec §5.13): who the insiders are, open-market purchases
 * and sales, and clusters of purchases by several insiders. Nothing here is a signal or a
 * recommendation; the wording says what was filed.
 */

export interface OwnerLike {
  cik: string | null;
  name: string;
  is_director: boolean;
  is_officer: boolean;
  officer_title: string | null;
  is_ten_percent_owner: boolean;
  is_other: boolean;
  other_text: string | null;
}

/** One transaction line with what it needs from its filing. */
export interface InsiderLine {
  accession_no: string;
  form_type: string;
  owners: readonly OwnerLike[];
  transaction_date: string;
  code: string;
  derivative: boolean;
  acquired_disposed: "A" | "D" | null;
  shares: number | null;
  price: number | null;
}

/** "Director, CEO", "10% owner", "Other: Former 10% Owner". */
export function roleOf(owner: OwnerLike): string {
  const parts: string[] = [];
  if (owner.is_director) parts.push("Director");
  if (owner.is_officer) parts.push(owner.officer_title?.trim() || "Officer");
  if (owner.is_ten_percent_owner) parts.push("10% owner");
  if (owner.is_other)
    parts.push(owner.other_text?.trim() ? `Other: ${owner.other_text.trim()}` : "Other");
  return parts.length ? parts.join(", ") : "Reporting person";
}

/** The first reporting owner, and how many joined the filing. */
export function ownersLabel(owners: readonly OwnerLike[]): string {
  const first = owners[0]?.name ?? "Unknown";
  const others = owners.length - 1;
  return others > 0 ? `${first} and ${others} other${others > 1 ? "s" : ""}` : first;
}

/** Joint filers count as one insider: the first reporting owner identifies the filing. */
export function insiderKey(owners: readonly OwnerLike[]): string {
  const first = owners[0];
  return first?.cik ?? first?.name.trim().toUpperCase() ?? "?";
}

export const isOpenMarketPurchase = (l: InsiderLine): boolean =>
  l.code === "P" && !l.derivative && l.acquired_disposed === "A";

export const isOpenMarketSale = (l: InsiderLine): boolean =>
  l.code === "S" && !l.derivative && l.acquired_disposed === "D";

const DAY = 86_400_000;
const dayNumber = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY;

export interface PurchaseCluster {
  from: string;
  to: string;
  /** Insiders (first reporting owner of each filing) who bought, in order of first purchase. */
  insiders: string[];
  filings: string[];
}

/**
 * Periods in which at least `minInsiders` different insiders bought on the open market within
 * `windowDays` of each other. Overlapping periods are merged, so a cluster can span longer than
 * the window; each part of it meets the rule.
 */
export function purchaseClusters(
  lines: readonly InsiderLine[],
  { minInsiders = 3, windowDays = 30 }: { minInsiders?: number; windowDays?: number } = {},
): PurchaseCluster[] {
  const events = lines
    .filter(isOpenMarketPurchase)
    .map((l) => ({
      day: dayNumber(l.transaction_date),
      date: l.transaction_date,
      key: insiderKey(l.owners),
      name: l.owners[0]?.name ?? "Unknown",
      accession: l.accession_no,
    }))
    .sort((a, b) => a.day - b.day || a.key.localeCompare(b.key));

  const windows: { start: number; end: number }[] = [];
  let j = 0;
  for (let i = 0; i < events.length; i += 1) {
    if (j < i) j = i;
    while (j + 1 < events.length && events[j + 1]!.day - events[i]!.day <= windowDays) j += 1;
    const keys = new Set(events.slice(i, j + 1).map((e) => e.key));
    if (keys.size >= minInsiders) windows.push({ start: i, end: j });
  }

  const merged: { start: number; end: number }[] = [];
  for (const w of windows) {
    const last = merged.at(-1);
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }

  return merged.map(({ start, end }) => {
    const slice = events.slice(start, end + 1);
    const insiders: string[] = [];
    const seen = new Set<string>();
    for (const e of slice) {
      if (!seen.has(e.key)) {
        seen.add(e.key);
        insiders.push(e.name);
      }
    }
    return {
      from: slice[0]!.date,
      to: slice.at(-1)!.date,
      insiders,
      filings: [...new Set(slice.map((e) => e.accession))],
    };
  });
}

export interface FlowSummary {
  /** Transaction lines counted. */
  lines: number;
  insiders: number;
  shares: number;
  /** Shares × price over lines that give a price; `priced` says how many did. */
  value: number;
  priced: number;
}

/**
 * Open-market purchases and sales on or after `from`. Amendments (4/A) are left out, because
 * one repeats the lines it corrects and the totals would count them twice.
 */
export function insiderFlows(
  lines: readonly InsiderLine[],
  from: string,
): { purchases: FlowSummary; sales: FlowSummary; amendmentsLeftOut: number } {
  const inRange = lines.filter((l) => l.transaction_date >= from);
  const originals = inRange.filter((l) => l.form_type === "4");
  const sum = (pick: (l: InsiderLine) => boolean): FlowSummary => {
    const list = originals.filter(pick);
    const priced = list.filter((l) => l.shares !== null && l.price !== null);
    return {
      lines: list.length,
      insiders: new Set(list.map((l) => insiderKey(l.owners))).size,
      shares: list.reduce((s, l) => s + (l.shares ?? 0), 0),
      value: priced.reduce((s, l) => s + l.shares! * l.price!, 0),
      priced: priced.length,
    };
  };
  return {
    purchases: sum(isOpenMarketPurchase),
    sales: sum(isOpenMarketSale),
    amendmentsLeftOut: inRange.filter(
      (l) => l.form_type !== "4" && (isOpenMarketPurchase(l) || isOpenMarketSale(l)),
    ).length,
  };
}
