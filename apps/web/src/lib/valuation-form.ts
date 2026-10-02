import { DcfInputs } from "@market/valuation";

/**
 * The DCF calculator's form (Phase 2 step D2): money in millions, rates in percent, converted
 * to and from the model's inputs. Plain TypeScript, shared by the component and its tests.
 */

export type FieldKey =
  | "revenue0"
  | "years"
  | "growth"
  | "ebitMargin"
  | "taxRate"
  | "daPct"
  | "capexPct"
  | "nwcPct"
  | "wacc"
  | "terminalGrowth"
  | "evEbitda"
  | "netDebt"
  | "shares";
export type FormValues = Record<FieldKey, string> & { method: "growth" | "multiple" };

/** Where a prefilled value came from, shown under its input. */
export type Sources = Partial<Record<FieldKey, string>>;

const PERCENT: FieldKey[] = [
  "growth",
  "ebitMargin",
  "taxRate",
  "daPct",
  "capexPct",
  "nwcPct",
  "wacc",
  "terminalGrowth",
];
const MILLIONS: FieldKey[] = ["revenue0", "netDebt", "shares"];

export const FIELDS: { key: FieldKey; label: string; unit: string }[] = [
  { key: "revenue0", label: "Revenue, last twelve months", unit: "$M" },
  { key: "years", label: "Forecast years", unit: "years" },
  { key: "growth", label: "Revenue growth a year", unit: "%" },
  { key: "ebitMargin", label: "Operating (EBIT) margin", unit: "%" },
  { key: "taxRate", label: "Tax rate", unit: "%" },
  { key: "daPct", label: "Depreciation and amortization", unit: "% of revenue" },
  { key: "capexPct", label: "Capital expenditure", unit: "% of revenue" },
  { key: "nwcPct", label: "Working capital", unit: "% of revenue growth" },
  { key: "wacc", label: "Discount rate (WACC)", unit: "%" },
  { key: "netDebt", label: "Net debt", unit: "$M" },
  { key: "shares", label: "Diluted shares", unit: "millions" },
];

function toNumber(key: FieldKey, raw: string): number | null {
  const t = raw.replace(/,/g, "").trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return Number.NaN;
  if (PERCENT.includes(key)) return n / 100;
  if (MILLIONS.includes(key)) return n * 1e6;
  return n;
}

/** The model's input object from the form, or the problems with it. */
export function inputsOf(v: FormValues): { inputs: DcfInputs | null; problems: string[] } {
  const n = (k: FieldKey) => toNumber(k, v[k]);
  const candidate = {
    revenue0: n("revenue0"),
    years: n("years"),
    growth: n("growth"),
    ebitMargin: n("ebitMargin"),
    taxRate: n("taxRate"),
    daPct: n("daPct"),
    capexPct: n("capexPct"),
    nwcPct: n("nwcPct"),
    wacc: n("wacc"),
    terminal:
      v.method === "growth"
        ? { method: "growth", growth: n("terminalGrowth") }
        : { method: "multiple", evEbitda: n("evEbitda") },
    netDebt: n("netDebt"),
    shares: n("shares"),
  };
  const parsed = DcfInputs.safeParse(candidate);
  if (parsed.success) return { inputs: parsed.data, problems: [] };
  const label = (path: PropertyKey[]) => {
    const k = String(path[0]);
    if (k === "terminal") return v.method === "growth" ? "Terminal growth" : "Exit multiple";
    return FIELDS.find((f) => f.key === k)?.label ?? k;
  };
  return {
    inputs: null,
    problems: parsed.error.issues.map((i) =>
      i.message.startsWith("Invalid input") || i.message.startsWith("Too")
        ? `${label(i.path)}: enter a number in range`
        : `${label(i.path)}: ${i.message}`,
    ),
  };
}

/** Form values from saved inputs (as stored in a scenario). */
export function formOf(inputs: DcfInputs): FormValues {
  const pct = (x: number) => String(Number((x * 100).toFixed(6)));
  const mil = (x: number) => String(Number((x / 1e6).toFixed(6)));
  return {
    revenue0: mil(inputs.revenue0),
    years: String(inputs.years),
    growth: pct(inputs.growth),
    ebitMargin: pct(inputs.ebitMargin),
    taxRate: pct(inputs.taxRate),
    daPct: pct(inputs.daPct),
    capexPct: pct(inputs.capexPct),
    nwcPct: pct(inputs.nwcPct),
    wacc: pct(inputs.wacc),
    method: inputs.terminal.method,
    terminalGrowth: inputs.terminal.method === "growth" ? pct(inputs.terminal.growth) : "2.5",
    evEbitda: inputs.terminal.method === "multiple" ? String(inputs.terminal.evEbitda) : "12",
    netDebt: mil(inputs.netDebt),
    shares: inputs.shares === null ? "" : mil(inputs.shares),
  };
}
