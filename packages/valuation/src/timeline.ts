/**
 * Statement figures as they were known on a date (Phase 2 step D3), for valuation inputs and
 * the history of multiples. A figure counts from the day after the filing that reported it,
 * never from its period end.
 */

const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / DAY;

/** One statement value with the date of the filing it came from. */
export interface FiledValue {
  value: number;
  filed: string;
}

export interface PeriodValue {
  frequency: "annual" | "quarterly";
  periodEnd: string;
  value: FiledValue | null;
}

export interface KnownValue {
  value: number;
  /** The last period end the figure covers. */
  periodEnd: string;
  /** The latest filing date among its parts: when it became complete. */
  filed: string;
  /** How it was formed: four quarters summed, a fiscal year, or one period's value. */
  basis: "four_quarters" | "fiscal_year" | "period";
}

const knownOn = (v: FiledValue | null, asOf: string) => v !== null && v.filed < asOf;

/**
 * Trailing twelve months known on `asOf`, with the screener's rule: the four latest quarters
 * when they are consecutive and the latest ended within 200 days, else the latest fiscal year
 * that ended within 460 days. All four quarters need a value.
 */
export function ttmAsOf(rows: readonly PeriodValue[], asOf: string): KnownValue | null {
  const quarters = rows
    .filter((r) => r.frequency === "quarterly" && knownOn(r.value, asOf))
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .slice(0, 4);
  const consecutive =
    quarters.length === 4 &&
    quarters.every(
      (q, i) =>
        i === 0 ||
        (days(quarters[i - 1]!.periodEnd, q.periodEnd) >= 80 &&
          days(quarters[i - 1]!.periodEnd, q.periodEnd) <= 100),
    );
  if (consecutive && days(asOf, quarters[0]!.periodEnd) <= 200) {
    return {
      value: quarters.reduce((s, q) => s + q.value!.value, 0),
      periodEnd: quarters[0]!.periodEnd,
      filed: quarters
        .map((q) => q.value!.filed)
        .sort()
        .at(-1)!,
      basis: "four_quarters",
    };
  }
  const annual = rows
    .filter((r) => r.frequency === "annual" && knownOn(r.value, asOf))
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  if (annual && days(asOf, annual.periodEnd) <= 460) {
    return {
      value: annual.value!.value,
      periodEnd: annual.periodEnd,
      filed: annual.value!.filed,
      basis: "fiscal_year",
    };
  }
  return null;
}

/**
 * The latest period's value known on `asOf` (balance-sheet instants, or per-period figures
 * such as diluted shares), from whichever frequency reported the latest period end.
 */
export function latestAsOf(rows: readonly PeriodValue[], asOf: string): KnownValue | null {
  const latest = rows
    .filter((r) => knownOn(r.value, asOf))
    .sort(
      (a, b) => b.periodEnd.localeCompare(a.periodEnd) || (a.frequency === "quarterly" ? -1 : 1),
    )[0];
  return latest
    ? {
        value: latest.value!.value,
        periodEnd: latest.periodEnd,
        filed: latest.value!.filed,
        basis: "period",
      }
    : null;
}

/** The last session of each calendar month, from ascending sessions. */
export function monthEnds(sessions: readonly string[]): string[] {
  return sessions.filter(
    (d, i) => i === sessions.length - 1 || sessions[i + 1]!.slice(0, 7) !== d.slice(0, 7),
  );
}
