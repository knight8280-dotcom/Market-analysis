import { z } from "zod";

/**
 * Two-stage discounted cash flow (Phase 2 step D1; spec §5.6). A calculator driven entirely by
 * the owner's inputs; nothing here is a price target.
 *
 * Conventions (also in docs/DECISIONS.md, ADR-027), mirrored by scripts/make_fixture.py:
 * - Stage 1, years 1..N: revenue grows at `growth`; EBIT = revenue × margin; free cash flow to
 *   the firm = EBIT × (1 − tax) + D&A − capex − change in working capital, with D&A and capex as
 *   shares of revenue and the working-capital change as a share of the revenue change.
 * - Cash flows are discounted at the end of each year: ÷ (1 + WACC)^t.
 * - Stage 2, the terminal value at the end of year N: either a perpetuity on year N+1's cash flow
 *   (revenue grows at the terminal rate, same margins), FCF(N+1) ÷ (WACC − g), or an exit
 *   multiple of year N's EBITDA (EBIT + D&A).
 * - Equity value = enterprise value − net debt; per share ÷ diluted shares.
 */

const rate = (min: number, max: number) => z.number().min(min).max(max);

export const TerminalInput = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("growth"), growth: rate(-0.05, 0.1) }),
  z.strictObject({ method: z.literal("multiple"), evEbitda: z.number().gt(0).max(100) }),
]);
export type TerminalInput = z.infer<typeof TerminalInput>;

export const DcfInputs = z
  .strictObject({
    revenue0: z.number().gt(0),
    years: z.number().int().min(1).max(15),
    growth: rate(-0.5, 1),
    ebitMargin: rate(-1, 1),
    taxRate: rate(0, 0.6),
    daPct: rate(0, 1),
    capexPct: rate(0, 1),
    nwcPct: rate(-1, 1),
    wacc: z.number().gt(0).max(0.5),
    terminal: TerminalInput,
    netDebt: z.number().refine(Number.isFinite, "not a number"),
    shares: z.number().gt(0).nullable(),
  })
  .superRefine((d, ctx) => {
    if (d.terminal.method === "growth" && d.terminal.growth >= d.wacc) {
      ctx.addIssue({
        code: "custom",
        path: ["terminal", "growth"],
        message: "terminal growth must be below the discount rate (WACC)",
      });
    }
  });
export type DcfInputs = z.infer<typeof DcfInputs>;

export interface DcfYear {
  year: number;
  revenue: number;
  ebit: number;
  nopat: number;
  da: number;
  capex: number;
  changeNwc: number;
  fcf: number;
  discountFactor: number;
  presentValue: number;
}

export interface DcfResult {
  rows: DcfYear[];
  pvStage1: number;
  terminalValue: number;
  pvTerminal: number;
  enterpriseValue: number;
  equityValue: number;
  perShare: number | null;
  /** Share of the enterprise value that comes from the terminal value. */
  terminalShare: number;
  /** Cross-checks: the exit multiple a growth terminal implies, or the growth a multiple implies. */
  impliedEvEbitda: number | null;
  impliedGrowth: number | null;
}

function year(inputs: DcfInputs, t: number, prevRevenue: number, growth: number) {
  const revenue = prevRevenue * (1 + growth);
  const ebit = revenue * inputs.ebitMargin;
  const nopat = ebit * (1 - inputs.taxRate);
  const da = revenue * inputs.daPct;
  const capex = revenue * inputs.capexPct;
  const changeNwc = (revenue - prevRevenue) * inputs.nwcPct;
  const fcf = nopat + da - capex - changeNwc;
  const discountFactor = 1 / (1 + inputs.wacc) ** t;
  return {
    year: t,
    revenue,
    ebit,
    nopat,
    da,
    capex,
    changeNwc,
    fcf,
    discountFactor,
    presentValue: fcf * discountFactor,
  };
}

/** Runs the model. Inputs must already satisfy `DcfInputs` (parse them first). */
export function runDcf(inputs: DcfInputs): DcfResult {
  const rows: DcfYear[] = [];
  let revenue = inputs.revenue0;
  for (let t = 1; t <= inputs.years; t++) {
    const row = year(inputs, t, revenue, inputs.growth);
    rows.push(row);
    revenue = row.revenue;
  }
  const last = rows[rows.length - 1]!;
  const ebitdaN = last.ebit + last.da;
  let terminalValue: number;
  if (inputs.terminal.method === "growth") {
    const next = year(inputs, inputs.years + 1, last.revenue, inputs.terminal.growth);
    terminalValue = next.fcf / (inputs.wacc - inputs.terminal.growth);
  } else {
    terminalValue = ebitdaN * inputs.terminal.evEbitda;
  }
  const pvStage1 = rows.reduce((s, r) => s + r.presentValue, 0);
  const pvTerminal = terminalValue * last.discountFactor;
  const enterpriseValue = pvStage1 + pvTerminal;
  const equityValue = enterpriseValue - inputs.netDebt;
  const fcfN = last.fcf;
  return {
    rows,
    pvStage1,
    terminalValue,
    pvTerminal,
    enterpriseValue,
    equityValue,
    perShare: inputs.shares ? equityValue / inputs.shares : null,
    terminalShare: enterpriseValue !== 0 ? pvTerminal / enterpriseValue : 0,
    impliedEvEbitda: ebitdaN > 0 ? terminalValue / ebitdaN : null,
    // TV = FCF(N) × (1 + g) ÷ (WACC − g), solved for g.
    impliedGrowth:
      terminalValue + fcfN !== 0
        ? (terminalValue * inputs.wacc - fcfN) / (terminalValue + fcfN)
        : null,
  };
}

export interface SensitivityGrid {
  /** The column variable: terminal growth, or the exit multiple. */
  kind: "growth" | "multiple";
  waccs: number[];
  columns: number[];
  /** Value per share (or equity value without a share count); null where the model is invalid. */
  values: (number | null)[][];
}

const round = (x: number) => Math.round(x * 1e10) / 1e10;

/** WACC × terminal growth (or × exit multiple) around the inputs, two steps each way. */
export function sensitivity(inputs: DcfInputs): SensitivityGrid {
  const waccs = [-0.02, -0.01, 0, 0.01, 0.02]
    .map((d) => round(inputs.wacc + d))
    .filter((w) => w > 0);
  const t = inputs.terminal;
  const columns =
    t.method === "growth"
      ? [-0.01, -0.005, 0, 0.005, 0.01].map((d) => round(t.growth + d))
      : [-2, -1, 0, 1, 2].map((d) => t.evEbitda + d).filter((m) => m > 0);
  const values = waccs.map((wacc) =>
    columns.map((c) => {
      const terminal: TerminalInput =
        t.method === "growth"
          ? { method: "growth", growth: c }
          : { method: "multiple", evEbitda: c };
      const parsed = DcfInputs.safeParse({ ...inputs, wacc, terminal });
      if (!parsed.success) return null;
      const r = runDcf(parsed.data);
      return r.perShare ?? r.equityValue;
    }),
  );
  return { kind: t.method, waccs, columns, values };
}
