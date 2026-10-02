import { ProviderResponseError } from "../errors";
import { InsiderFiling, type InsiderOwner, type InsiderTransaction } from "../types";
import { childOf, childrenOf, parseXml, textAt, XmlError, type XmlElement } from "../xml";
import { parseVendor } from "./common";

/**
 * Form 4 ownership documents (spec §2.3, §5.13). EDGAR keeps each filing's XML next to the
 * rendered page its index points at: the primary document "xslF345X06/form4.xml" is the XSL
 * view of "form4.xml" in the same folder. Recorded filings in
 * test/fixtures/sec-edgar/recorded/form4 pin the parser to the real documents (schemas X0508
 * and X0609).
 */

export const INSIDER_FORMS = ["4", "4/A"] as const;

/**
 * The raw XML file behind a Form 4's primary document, or null when the filing has no XML
 * (paper-era filings).
 */
export function ownershipXmlFile(primaryDocument: string | null): string | null {
  const file = primaryDocument?.split("/").at(-1) ?? "";
  return /^[A-Za-z0-9._-]+\.xml$/i.test(file) ? file : null;
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

function bool(text: string | null): boolean | null {
  if (text === null) return null;
  const t = text.toLowerCase();
  if (t === "1" || t === "true") return true;
  if (t === "0" || t === "false") return false;
  throw new Error(`not a boolean: ${text}`);
}

function num(text: string | null): number | null {
  if (text === null) return null;
  const t = text.replaceAll(",", "");
  if (!DECIMAL.test(t)) throw new Error(`not a number: ${text}`);
  return Number(t);
}

/** EDGAR dates are xs:date and may carry a zone offset ("2026-09-29-04:00"). */
function date(text: string | null): string | null {
  if (text === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!m) throw new Error(`not a date: ${text}`);
  return m[1]!;
}

/** A field that holds its value in <value> and may carry footnotes instead of, or besides, it. */
const valueOf = (el: XmlElement | undefined, name: string) => textAt(childOf(el, name), "value");

function footnoteIds(el: XmlElement, into: Set<string>): Set<string> {
  for (const c of el.children) {
    if (c.name === "footnoteId" && c.attrs.id) into.add(c.attrs.id);
    footnoteIds(c, into);
  }
  return into;
}

function owner(el: XmlElement): InsiderOwner {
  const id = childOf(el, "reportingOwnerId");
  const rel = childOf(el, "reportingOwnerRelationship");
  return {
    cik: textAt(id, "rptOwnerCik"),
    name: textAt(id, "rptOwnerName") ?? "",
    is_director: bool(textAt(rel, "isDirector")) ?? false,
    is_officer: bool(textAt(rel, "isOfficer")) ?? false,
    officer_title: textAt(rel, "officerTitle"),
    is_ten_percent_owner: bool(textAt(rel, "isTenPercentOwner")) ?? false,
    is_other: bool(textAt(rel, "isOther")) ?? false,
    other_text: textAt(rel, "otherText"),
  };
}

function transaction(el: XmlElement, derivative: boolean, line: number): InsiderTransaction {
  const coding = childOf(el, "transactionCoding");
  const amounts = childOf(el, "transactionAmounts");
  const nature = childOf(el, "ownershipNature");
  const underlying = childOf(el, "underlyingSecurity");
  const disposed = valueOf(amounts, "transactionAcquiredDisposedCode");
  const ownership = valueOf(nature, "directOrIndirectOwnership");
  return {
    line,
    derivative,
    security_title: valueOf(el, "securityTitle") ?? "",
    transaction_date: date(valueOf(el, "transactionDate")) ?? "",
    deemed_execution_date: date(valueOf(el, "deemedExecutionDate")),
    code: (textAt(coding, "transactionCode") ?? "") as InsiderTransaction["code"],
    equity_swap: bool(textAt(coding, "equitySwapInvolved")) ?? false,
    shares: num(valueOf(amounts, "transactionShares")),
    price: num(valueOf(amounts, "transactionPricePerShare")),
    acquired_disposed: disposed as InsiderTransaction["acquired_disposed"],
    shares_after: num(
      valueOf(childOf(el, "postTransactionAmounts"), "sharesOwnedFollowingTransaction"),
    ),
    ownership: ownership as InsiderTransaction["ownership"],
    ownership_nature: valueOf(nature, "natureOfOwnership"),
    conversion_price: derivative ? num(valueOf(el, "conversionOrExercisePrice")) : null,
    exercise_date: derivative ? date(valueOf(el, "exerciseDate")) : null,
    expiration_date: derivative ? date(valueOf(el, "expirationDate")) : null,
    underlying_title: derivative ? valueOf(underlying, "underlyingSecurityTitle") : null,
    underlying_shares: derivative ? num(valueOf(underlying, "underlyingSecurityShares")) : null,
    footnote_ids: [...footnoteIds(el, new Set())].sort(),
  };
}

export interface OwnershipMeta {
  accession_no: string;
  /** EDGAR acceptance time of the filing. */
  filed_at: Date;
  fetched_at: Date;
}

/**
 * Parses a Form 4 or 4/A document into the canonical record. Anything that does not fit the
 * schema (an unknown code, a malformed number or date, a missing owner) is an error, never a
 * guess. The caller checks that the issuer is the registrant it expected.
 */
export function parseOwnershipDocument(xml: string, meta: OwnershipMeta): InsiderFiling {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (err) {
    const what = err instanceof XmlError ? err.message : String(err);
    throw new ProviderResponseError("sec_edgar", `Form 4 ${meta.accession_no}: ${what}`, err);
  }
  if (root.name !== "ownershipDocument") {
    throw new ProviderResponseError(
      "sec_edgar",
      `Form 4 ${meta.accession_no}: root element is <${root.name}>, not <ownershipDocument>`,
    );
  }

  let record: unknown;
  try {
    const issuer = childOf(root, "issuer");
    const nonDerivative = childrenOf(
      childOf(root, "nonDerivativeTable"),
      "nonDerivativeTransaction",
    );
    const derivative = childrenOf(childOf(root, "derivativeTable"), "derivativeTransaction");
    const footnotes: Record<string, string> = {};
    for (const f of childrenOf(childOf(root, "footnotes"), "footnote")) {
      if (f.attrs.id) footnotes[f.attrs.id] = f.text.trim().replace(/\s+/g, " ");
    }
    record = {
      source: "sec_edgar",
      source_symbol: textAt(issuer, "issuerCik"),
      fetched_at: meta.fetched_at,
      as_of: meta.filed_at,
      license_tier: "public_domain",
      accession_no: meta.accession_no,
      form_type: textAt(root, "documentType"),
      schema_version: textAt(root, "schemaVersion"),
      period_of_report: date(textAt(root, "periodOfReport")),
      original_filing_date: date(textAt(root, "dateOfOriginalSubmission")),
      issuer_cik: textAt(issuer, "issuerCik"),
      issuer_name: textAt(issuer, "issuerName"),
      issuer_symbol: textAt(issuer, "issuerTradingSymbol"),
      owners: childrenOf(root, "reportingOwner").map(owner),
      aff_10b5_1: bool(textAt(root, "aff10b5One")),
      no_longer_subject_to_section16: bool(textAt(root, "notSubjectToSection16")) ?? false,
      remarks: textAt(root, "remarks"),
      footnotes,
      transactions: [
        ...nonDerivative.map((el, i) => transaction(el, false, i + 1)),
        ...derivative.map((el, i) => transaction(el, true, nonDerivative.length + i + 1)),
      ],
    };
  } catch (err) {
    throw new ProviderResponseError(
      "sec_edgar",
      `Form 4 ${meta.accession_no}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  return parseVendor("sec_edgar", InsiderFiling, record, `Form 4 ${meta.accession_no}`);
}
