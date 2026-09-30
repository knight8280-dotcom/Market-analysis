import { TX_TYPES, type TxType } from "./types";

/** The import template's header; columns may come in any order, names are case-insensitive. */
export const CSV_COLUMNS = [
  "date",
  "type",
  "ticker",
  "quantity",
  "price",
  "amount",
  "fees",
  "notes",
] as const;
export const CSV_TEMPLATE = `${CSV_COLUMNS.join(",")}
2024-01-02,deposit,,,,10000,,Opening deposit
2024-01-03,buy,SPY,10,472.65,,1.00,
2024-03-21,dividend,SPY,,,18.30,,Quarterly dividend
2024-06-03,sell,SPY,4,527.80,,1.00,
`;
export const MAX_CSV_ROWS = 5000;

export interface CsvTx {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  date: string;
  type: TxType;
  ticker: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fees: number;
  notes: string | null;
}

export interface CsvError {
  line: number;
  message: string;
}

/** RFC 4180 fields: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): { line: number; fields: string[] }[] {
  const src = text.replace(/^\uFEFF/, "");
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      fields.push(field);
      if (fields.some((f) => f.trim() !== "")) records.push({ line: recordLine, fields });
      fields = [];
      field = "";
      line++;
      recordLine = line;
    } else {
      field += c;
    }
  }
  fields.push(field);
  if (fields.some((f) => f.trim() !== "")) records.push({ line: recordLine, fields });
  return records;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s: string): boolean {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "1,234.50", "$12", " 3 " → numbers; "" → null; anything else → NaN. */
function num(raw: string | undefined): number | null {
  const s = (raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (s === "") return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}

/**
 * Validates one transaction from named fields (a CSV row or the manual-entry form), with the
 * same rules for both.
 */
export function readTransaction(
  field: (name: (typeof CSV_COLUMNS)[number]) => string,
  line: number,
  today: string,
): { row: CsvTx } | { error: string } {
  const get = (name: (typeof CSV_COLUMNS)[number]) => field(name).trim();
  const problems: string[] = [];
  const date = get("date");
  if (!validDate(date)) problems.push(`date "${date}" is not a YYYY-MM-DD date`);
  else if (date > today) problems.push(`date ${date} is in the future`);
  const typeRaw = get("type").toLowerCase();
  const type = (TX_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as TxType) : null;
  if (!type) problems.push(`type "${get("type")}" is not one of ${TX_TYPES.join(", ")}`);
  const ticker = get("ticker").toUpperCase() || null;
  const quantity = num(get("quantity"));
  const price = num(get("price"));
  const amount = num(get("amount"));
  const fees = num(get("fees"));
  const notes = get("notes") || null;
  for (const [name, v] of [
    ["quantity", quantity],
    ["price", price],
    ["amount", amount],
    ["fees", fees],
  ] as const) {
    if (v !== null && (Number.isNaN(v) || v < 0))
      problems.push(`${name} must be a number of 0 or more`);
  }
  if (type === "buy" || type === "sell") {
    if (!ticker) problems.push(`a ${type} needs a ticker`);
    if (!(quantity !== null && quantity > 0)) problems.push(`a ${type} needs a quantity above 0`);
    if (price === null || Number.isNaN(price)) problems.push(`a ${type} needs a price`);
    if (
      amount !== null &&
      quantity !== null &&
      price !== null &&
      Math.abs(amount - quantity * price) > 0.01
    ) {
      problems.push(
        `amount ${amount} is not quantity × price (${quantity * price}); leave it empty`,
      );
    }
  } else if (type) {
    if (!(amount !== null && amount > 0)) problems.push(`a ${type} needs an amount above 0`);
    if (quantity !== null || price !== null)
      problems.push(`a ${type} takes an amount, not a quantity or price`);
    if (ticker && type !== "dividend") problems.push(`a ${type} has no ticker`);
  }
  if (notes && notes.length > 500) problems.push("notes are limited to 500 characters");
  if (problems.length) return { error: `${problems.join("; ")}.` };
  return {
    row: {
      line,
      date,
      type: type!,
      ticker,
      quantity: type === "buy" || type === "sell" ? quantity : null,
      price: type === "buy" || type === "sell" ? price : null,
      // Rounded to the database's 6 decimals, so 1.5 × 190.1 stores as 285.15.
      amount:
        type === "buy" || type === "sell" ? Math.round(quantity! * price! * 1e6) / 1e6 : amount,
      fees: fees ?? 0,
      notes,
    },
  };
}

/**
 * Parses and validates a transactions CSV (Phase 1 step J1). Returns every row it could read
 * and every problem found, by line; callers import nothing unless `errors` is empty.
 */
export function parseTransactionsCsv(
  text: string,
  opts: { today: string },
): { rows: CsvTx[]; errors: CsvError[] } {
  const records = parseCsv(text);
  const errors: CsvError[] = [];
  if (records.length === 0)
    return { rows: [], errors: [{ line: 1, message: "The file is empty." }] };
  const header = records[0]!.fields.map((h) => h.trim().toLowerCase());
  const col = new Map(header.map((h, i) => [h, i]));
  const missing = (["date", "type"] as const).filter((c) => !col.has(c));
  const unknown = header.filter((h) => h && !(CSV_COLUMNS as readonly string[]).includes(h));
  if (missing.length || unknown.length) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          message: [
            missing.length
              ? `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`
              : "",
            unknown.length
              ? `Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`
              : "",
            `Expected: ${CSV_COLUMNS.join(",")}.`,
          ]
            .filter(Boolean)
            .join(" "),
        },
      ],
    };
  }
  if (records.length - 1 > MAX_CSV_ROWS) {
    return {
      rows: [],
      errors: [{ line: 1, message: `At most ${MAX_CSV_ROWS} rows per import.` }],
    };
  }

  const rows: CsvTx[] = [];
  for (const { line, fields } of records.slice(1)) {
    const result = readTransaction(
      (name) => {
        const i = col.get(name);
        return i === undefined ? "" : (fields[i] ?? "");
      },
      line,
      opts.today,
    );
    if ("error" in result) errors.push({ line, message: result.error });
    else rows.push(result.row);
  }
  if (records.length === 1) errors.push({ line: 2, message: "No transactions below the header." });
  return { rows, errors };
}
