import { fieldValue, type SnapshotRow } from "./fields";
import type { Condition, Screen } from "./schema";

/**
 * A plain in-memory evaluation of a screen, written independently of the SQL compiler. Tests run
 * random screens through both and require identical results (Phase 1 step F2).
 */
function holds(row: SnapshotRow, c: Condition): boolean {
  const v = fieldValue(row, c.field);
  if (c.op === "is_null") return v === null;
  if (c.op === "not_null") return v !== null;
  if (v === null) return false;
  if (c.op === "between") {
    const [lo, hi] = c.value as [number, number];
    return (v as number) >= lo && (v as number) <= hi;
  }
  if (c.op === "in") {
    return (c.value as string[]).some((x) => x.toLowerCase() === String(v).toLowerCase());
  }
  let other: number | string | null;
  if (c.ref) other = fieldValue(row, c.ref);
  else other = c.value as number | string;
  if (other === null) return false;
  if (typeof v === "string") {
    const a = v.toLowerCase();
    const b = String(other).toLowerCase();
    return c.op === "eq" ? a === b : c.op === "neq" ? a !== b : false;
  }
  const a = v;
  const b = other as number;
  switch (c.op) {
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    default:
      return false;
  }
}

export function evaluateScreen(rows: readonly SnapshotRow[], screen: Screen): SnapshotRow[] {
  const matched = rows.filter((r) => screen.conditions.every((c) => holds(r, c)));
  const { field, dir } = screen.sort;
  return matched.sort((x, y) => {
    const a = fieldValue(x, field);
    const b = fieldValue(y, field);
    if (a === null && b !== null) return 1;
    if (b === null && a !== null) return -1;
    if (a !== null && b !== null && a !== b) {
      const cmp = typeof a === "number" ? a - (b as number) : String(a) < String(b) ? -1 : 1;
      return dir === "asc" ? cmp : -cmp;
    }
    return String(x.ticker) < String(y.ticker) ? -1 : String(x.ticker) > String(y.ticker) ? 1 : 0;
  });
}
