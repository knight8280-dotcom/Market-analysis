import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import yauzl from "yauzl";
import { ProviderResponseError } from "../errors";

/**
 * SEC bulk data sets (spec §2.3, §5.13; Phase 2 step H2): the quarterly Form 13F data sets and
 * the fails-to-deliver files, whose CUSIP-to-symbol columns tie 13F holdings (reported by CUSIP)
 * to our securities. Both are public domain. Files are found from SEC's listing pages, whose
 * links do not follow one URL pattern, then downloaded whole and read here from disk.
 * Trimmed recordings and expected results: test/fixtures/sec-edgar/recorded/{form13f,ftd}
 * (scripts/make_sec_dataset_fixtures.py).
 */

export const SEC_LISTING_PAGES = {
  form13f: "/data-research/sec-markets-data/form-13f-data-sets",
  ftd: "/data-research/sec-markets-data/fails-deliver-data",
} as const;

export interface DataSetFile {
  /** The file name, e.g. "01jun2026-31aug2026_form13f.zip" or "cnsfails202609a.zip". */
  name: string;
  url: string;
  /** Inclusive dates the file covers: filing dates (13F) or settlement dates (fails). */
  from: string;
  to: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** SEC's "30-JUN-2026" (or "30jun2026" in file names) as "2026-06-30". */
export function secDate(text: string): string {
  const m = /^(\d{2})-?([A-Za-z]{3})-?(\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[2]!.toLowerCase()) : -1;
  if (!m || month < 0) throw new Error(`not an SEC date: ${text}`);
  const iso = `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw new Error(`not an SEC date: ${text}`);
  }
  return iso;
}

const lastDay = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

/**
 * The data set files linked from an SEC listing page, newest first. Only links to `base`'s host
 * whose file name has the expected form are kept.
 */
export function dataSetLinks(html: string, kind: "form13f" | "ftd", base: string): DataSetFile[] {
  const origin = new URL(base);
  const seen = new Map<string, DataSetFile>();
  for (const m of html.matchAll(/href="([^"#?]+\.zip)"/gi)) {
    let url: URL;
    try {
      url = new URL(m[1]!, origin);
    } catch {
      continue;
    }
    if (url.host !== origin.host) continue;
    const name = url.pathname.split("/").at(-1)!;
    let from: string;
    let to: string;
    if (kind === "form13f") {
      const f = /^(\d{2}[a-z]{3}\d{4})-(\d{2}[a-z]{3}\d{4})_form13f\.zip$/i.exec(name);
      if (!f) continue;
      from = secDate(f[1]!);
      to = secDate(f[2]!);
    } else {
      const f = /^cnsfails(\d{4})(\d{2})([ab])\.zip$/i.exec(name);
      if (!f) continue;
      const [y, mo, half] = [Number(f[1]), Number(f[2]), f[3]!.toLowerCase()];
      const month = `${f[1]}-${f[2]}`;
      from = half === "a" ? `${month}-01` : `${month}-16`;
      to = half === "a" ? `${month}-15` : lastDay(y, mo);
    }
    if (!seen.has(name)) seen.set(name, { name, url: url.toString(), from, to });
  }
  return [...seen.values()].sort(
    (a, b) => b.to.localeCompare(a.to) || b.name.localeCompare(a.name),
  );
}

// --- Zip files -------------------------------------------------------------------------------

/** Lines of each file in a zip on disk; `close` releases it. */
export interface ZipTables {
  names: string[];
  lines(name: string, encoding?: BufferEncoding): AsyncIterable<string>;
  close(): void;
}

export async function openZip(path: string): Promise<ZipTables> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, z) =>
      err ? reject(err) : resolve(z),
    ),
  );
  const entries = new Map<string, yauzl.Entry>();
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      if (!entry.fileName.endsWith("/")) entries.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.on("end", () => resolve());
    zip.on("error", reject);
    zip.readEntry();
  });
  return {
    names: [...entries.keys()],
    async *lines(name, encoding = "utf8") {
      const entry = entries.get(name);
      if (!entry) throw new ProviderResponseError("sec_edgar", `${path} has no ${name}`);
      const stream = await new Promise<Readable>((resolve, reject) =>
        zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s))),
      );
      stream.setEncoding(encoding);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) yield line;
    },
    close: () => zip.close(),
  };
}

// --- Fails-to-deliver ------------------------------------------------------------------------

export interface FailsRow {
  settlement_date: string;
  cusip: string;
  symbol: string;
  description: string;
  quantity: number;
  /** SEC prints "." when it has no price. */
  price: number | null;
}

const FAILS_HEADER = "SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE";
const CUSIP = /^[0-9A-Z*@#]{9}$/;

/**
 * Rows of one fails-to-deliver text file. The trailer's record count must match the rows read,
 * so a truncated file is an error rather than a smaller map.
 */
export async function readFails(lines: AsyncIterable<string>): Promise<FailsRow[]> {
  const rows: FailsRow[] = [];
  let header = true;
  let trailerCount: number | null = null;
  for await (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (header) {
      if (line.trim() !== FAILS_HEADER) {
        throw new ProviderResponseError("sec_edgar", `Unexpected fails-to-deliver header: ${line}`);
      }
      header = false;
      continue;
    }
    if (!line.trim()) continue;
    const trailer = /^Trailer record count (\d+)$/.exec(line.trim());
    if (trailer) {
      trailerCount = Number(trailer[1]);
      continue;
    }
    if (/^Trailer /.test(line.trim())) continue;
    const parts = line.split("|");
    const [date, cusip, symbol, quantity, description, price] = parts;
    if (
      parts.length !== 6 ||
      !/^\d{8}$/.test(date!) ||
      !CUSIP.test(cusip!.toUpperCase()) ||
      !/^\d+$/.test(quantity!)
    ) {
      throw new ProviderResponseError("sec_edgar", `Unexpected fails-to-deliver row: ${line}`);
    }
    rows.push({
      settlement_date: `${date!.slice(0, 4)}-${date!.slice(4, 6)}-${date!.slice(6)}`,
      cusip: cusip!.toUpperCase(),
      symbol: symbol!.trim(),
      description: description!.trim(),
      quantity: Number(quantity),
      price: /^\d+(\.\d+)?$/.test(price!.trim()) ? Number(price) : null,
    });
  }
  if (trailerCount === null || trailerCount !== rows.length) {
    throw new ProviderResponseError(
      "sec_edgar",
      `Fails-to-deliver file has ${rows.length} rows but its trailer says ${trailerCount ?? "nothing"}`,
    );
  }
  return rows;
}

// --- Form 13F data sets ----------------------------------------------------------------------

export const FORM13F_TYPES = ["13F-HR", "13F-HR/A", "13F-NT", "13F-NT/A"] as const;

export interface Form13fFiling {
  accession_no: string;
  filer_cik: string;
  filer_name: string;
  submission_type: (typeof FORM13F_TYPES)[number];
  /** 13F HOLDINGS REPORT, 13F NOTICE or 13F COMBINATION REPORT. */
  report_type: string;
  report_period: string;
  filed_on: string;
  /** RESTATEMENT or NEW HOLDINGS on an amendment; null otherwise. */
  amendment_type: "RESTATEMENT" | "NEW HOLDINGS" | null;
  table_entry_total: number | null;
  table_value_total: number | null;
}

/** One filing's share rows (not puts, calls or principal amounts) in one CUSIP, summed. */
export interface Form13fHolding {
  accession_no: string;
  cusip: string;
  shares: number;
  value_usd: number;
  rows: number;
}

export interface Form13fDataSet {
  filings: Form13fFiling[];
  holdings: Form13fHolding[];
  /** Information table rows read, and filings whose row count differs from their summary page. */
  infotableRows: number;
  rowCountMismatches: string[];
}

/** Filings on or after this date report value in dollars; earlier ones in thousands. */
export const FORM13F_DOLLARS_FROM = "2023-01-03";

async function* tsv(lines: AsyncIterable<string>, required: readonly string[], table: string) {
  let header: string[] | null = null;
  for await (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (header === null) {
      header = line.split("\t");
      const missing = required.filter((c) => !header!.includes(c));
      if (missing.length) {
        throw new ProviderResponseError(
          "sec_edgar",
          `${table} lacks column(s) ${missing.join(", ")}`,
        );
      }
      continue;
    }
    if (!line) continue;
    const cells = line.split("\t");
    yield Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])) as Record<string, string>;
  }
}

const int = (text: string, what: string): number => {
  if (!/^\d+$/.test(text)) throw new Error(`${what} is not a whole number: "${text}"`);
  return Number(text);
};

/**
 * Reads one Form 13F data set: every filing for a period on or after `fromPeriod`, and the share
 * holdings of those filings in `cusips`.
 */
export async function readForm13f(
  open: (table: string) => AsyncIterable<string>,
  opts: { cusips: ReadonlySet<string>; fromPeriod: string },
): Promise<Form13fDataSet> {
  const cover = new Map<string, Record<string, string>>();
  for await (const r of tsv(
    open("COVERPAGE.tsv"),
    ["ACCESSION_NUMBER", "AMENDMENTTYPE", "FILINGMANAGER_NAME", "REPORTTYPE"],
    "COVERPAGE",
  )) {
    cover.set(r.ACCESSION_NUMBER!, r);
  }
  const summary = new Map<string, Record<string, string>>();
  for await (const r of tsv(
    open("SUMMARYPAGE.tsv"),
    ["ACCESSION_NUMBER", "TABLEENTRYTOTAL", "TABLEVALUETOTAL"],
    "SUMMARYPAGE",
  )) {
    summary.set(r.ACCESSION_NUMBER!, r);
  }

  const filings = new Map<string, Form13fFiling>();
  for await (const r of tsv(
    open("SUBMISSION.tsv"),
    ["ACCESSION_NUMBER", "FILING_DATE", "SUBMISSIONTYPE", "CIK", "PERIODOFREPORT"],
    "SUBMISSION",
  )) {
    const accession = r.ACCESSION_NUMBER!;
    try {
      if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) throw new Error("bad accession number");
      const type = r.SUBMISSIONTYPE as Form13fFiling["submission_type"];
      if (!FORM13F_TYPES.includes(type)) throw new Error(`unknown submission type ${type}`);
      const period = secDate(r.PERIODOFREPORT!);
      if (period < opts.fromPeriod) continue;
      const c = cover.get(accession);
      if (!c) throw new Error("no cover page");
      const s = summary.get(accession);
      const amendment = c.AMENDMENTTYPE?.trim() || null;
      if (amendment !== null && amendment !== "RESTATEMENT" && amendment !== "NEW HOLDINGS") {
        throw new Error(`unknown amendment type ${amendment}`);
      }
      // A few submissions give the CIK without its leading zeros ("1539994").
      const cik = r.CIK!.trim();
      if (!/^\d{1,10}$/.test(cik)) throw new Error(`bad CIK ${r.CIK}`);
      filings.set(accession, {
        accession_no: accession,
        filer_cik: cik.padStart(10, "0"),
        filer_name: c.FILINGMANAGER_NAME!.trim(),
        submission_type: type,
        report_type: c.REPORTTYPE!.trim(),
        report_period: period,
        filed_on: secDate(r.FILING_DATE!),
        amendment_type: amendment,
        table_entry_total: s?.TABLEENTRYTOTAL ? int(s.TABLEENTRYTOTAL, "TABLEENTRYTOTAL") : null,
        table_value_total: s?.TABLEVALUETOTAL ? int(s.TABLEVALUETOTAL, "TABLEVALUETOTAL") : null,
      });
    } catch (err) {
      throw new ProviderResponseError(
        "sec_edgar",
        `13F submission ${accession}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  const sums = new Map<string, Form13fHolding>();
  const rowsPerFiling = new Map<string, number>();
  let infotableRows = 0;
  for await (const r of tsv(
    open("INFOTABLE.tsv"),
    ["ACCESSION_NUMBER", "CUSIP", "VALUE", "SSHPRNAMT", "SSHPRNAMTTYPE", "PUTCALL"],
    "INFOTABLE",
  )) {
    infotableRows += 1;
    const accession = r.ACCESSION_NUMBER!;
    rowsPerFiling.set(accession, (rowsPerFiling.get(accession) ?? 0) + 1);
    const filing = filings.get(accession);
    const cusip = r.CUSIP!.trim().toUpperCase();
    if (!filing || !opts.cusips.has(cusip)) continue;
    if (r.SSHPRNAMTTYPE !== "SH" || r.PUTCALL!.trim() !== "") continue;
    try {
      const shares = int(r.SSHPRNAMT!, "SSHPRNAMT");
      const value = int(r.VALUE!, "VALUE") * (filing.filed_on < FORM13F_DOLLARS_FROM ? 1000 : 1);
      const key = `${accession}|${cusip}`;
      const sum = sums.get(key) ?? {
        accession_no: accession,
        cusip,
        shares: 0,
        value_usd: 0,
        rows: 0,
      };
      sum.shares += shares;
      sum.value_usd += value;
      sum.rows += 1;
      sums.set(key, sum);
    } catch (err) {
      throw new ProviderResponseError(
        "sec_edgar",
        `13F information table ${accession}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  const rowCountMismatches = [...filings.values()]
    .filter(
      (f) =>
        f.table_entry_total !== null &&
        f.submission_type.startsWith("13F-HR") &&
        (rowsPerFiling.get(f.accession_no) ?? 0) !== f.table_entry_total,
    )
    .map((f) => f.accession_no);

  return {
    filings: [...filings.values()].sort((a, b) => a.accession_no.localeCompare(b.accession_no)),
    holdings: [...sums.values()].sort(
      (a, b) => a.accession_no.localeCompare(b.accession_no) || a.cusip.localeCompare(b.cusip),
    ),
    infotableRows,
    rowCountMismatches,
  };
}
