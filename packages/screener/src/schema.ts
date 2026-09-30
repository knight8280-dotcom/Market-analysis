import { z } from "zod";
import { FIELD_IDS, fieldDef, type FieldId } from "./fields";

/**
 * A screen: conditions joined with AND, a sort and a page size. Stored as JSON in
 * public.saved_screens and passed in the URL, so it is validated on every use.
 */
const Field = z.enum(FIELD_IDS as [FieldId, ...FieldId[]]);
const Finite = z.number().finite();

export const Condition = z
  .object({
    field: Field,
    op: z.enum(["gt", "gte", "lt", "lte", "eq", "neq", "between", "in", "is_null", "not_null"]),
    value: z
      .union([
        Finite,
        z.string().max(100),
        z.tuple([Finite, Finite]),
        z.array(z.string().max(100)).max(50),
      ])
      .optional(),
    /** Compare with another numeric field instead of a constant (e.g. close > sma200). */
    ref: Field.optional(),
  })
  .superRefine((c, ctx) => {
    const def = fieldDef(c.field);
    const fail = (message: string) => ctx.addIssue({ code: "custom", message, path: ["value"] });
    if (c.op === "is_null" || c.op === "not_null") {
      if (c.value !== undefined || c.ref !== undefined) fail("takes no value");
      return;
    }
    if (c.ref !== undefined) {
      if (def.type !== "number" || fieldDef(c.ref).type !== "number") {
        fail("only numeric fields can be compared with each other");
      }
      if (!["gt", "gte", "lt", "lte"].includes(c.op)) fail("use >, ≥, < or ≤ to compare fields");
      if (c.value !== undefined) fail("give either a value or a field to compare with");
      return;
    }
    if (def.type === "number") {
      if (c.op === "between") {
        if (!Array.isArray(c.value) || typeof c.value[0] !== "number") fail("needs [low, high]");
        else if (c.value[0] > (c.value[1] as number)) fail("low must not exceed high");
      } else if (c.op === "in") {
        fail("numeric fields use comparisons, not a list");
      } else if (typeof c.value !== "number") {
        fail("needs a number");
      }
      return;
    }
    // text and enum
    if (c.op === "in") {
      if (!Array.isArray(c.value) || c.value.some((v) => typeof v !== "string")) {
        fail("needs a list of values");
      } else if (def.values && c.value.some((v) => !def.values!.includes(v as string))) {
        fail(`must be one of: ${def.values.join(", ")}`);
      }
    } else if (c.op === "eq" || c.op === "neq") {
      if (typeof c.value !== "string") fail("needs text");
      else if (def.values && !def.values.includes(c.value)) {
        fail(`must be one of: ${def.values.join(", ")}`);
      }
    } else {
      fail("text fields support =, ≠ and one-of");
    }
  });
export type Condition = z.infer<typeof Condition>;

export const Screen = z.object({
  conditions: z.array(Condition).max(20).default([]),
  sort: z
    .object({ field: Field, dir: z.enum(["asc", "desc"]) })
    .default({ field: "market_cap", dir: "desc" }),
});
export type Screen = z.infer<typeof Screen>;

export function parseScreen(raw: unknown): Screen {
  return Screen.parse(raw);
}
