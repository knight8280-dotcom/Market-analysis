/**
 * Form 4 transaction codes with SEC's own wording (Form 4, General Instruction 8, from
 * https://www.sec.gov/files/form4.pdf, read 2026-10-02). Shown as the legend beside insider
 * tables (spec §5.13).
 */

export type CodeGroup = "general" | "rule16b3" | "derivative" | "exempt" | "other";

export interface CodeInfo {
  code: string;
  /** Short label for a table cell. */
  label: string;
  /** SEC's description, verbatim. */
  description: string;
  group: CodeGroup;
}

export const CODE_GROUPS: Readonly<Record<CodeGroup, string>> = {
  general: "General transaction codes",
  rule16b3: "Rule 16b-3 transaction codes",
  derivative: "Derivative securities codes (except transactions exempted under Rule 16b-3)",
  exempt: "Other Section 16(b) exempt transaction and small acquisition codes",
  other: "Other transaction codes",
};

const info = (code: string, label: string, description: string, group: CodeGroup): CodeInfo => ({
  code,
  label,
  description,
  group,
});

export const TRANSACTION_CODES: readonly CodeInfo[] = [
  info(
    "P",
    "Purchase",
    "Open market or private purchase of non-derivative or derivative security",
    "general",
  ),
  info(
    "S",
    "Sale",
    "Open market or private sale of non-derivative or derivative security",
    "general",
  ),
  info("V", "Reported early", "Transaction voluntarily reported earlier than required", "general"),
  info("A", "Award", "Grant, award or other acquisition pursuant to Rule 16b-3(d)", "rule16b3"),
  info(
    "D",
    "Disposed to issuer",
    "Disposition to the issuer of issuer equity securities pursuant to Rule 16b-3(e)",
    "rule16b3",
  ),
  info(
    "F",
    "Tax or exercise payment",
    "Payment of exercise price or tax liability by delivering or withholding securities incident to the receipt, exercise or vesting of a security issued in accordance with Rule 16b-3",
    "rule16b3",
  ),
  info(
    "I",
    "Discretionary",
    "Discretionary transaction in accordance with Rule 16b-3(f) resulting in acquisition or disposition of issuer securities",
    "rule16b3",
  ),
  info(
    "M",
    "Exercise or conversion",
    "Exercise or conversion of derivative security exempted pursuant to Rule 16b-3",
    "rule16b3",
  ),
  info("C", "Conversion", "Conversion of derivative security", "derivative"),
  info("E", "Short expiration", "Expiration of short derivative position", "derivative"),
  info(
    "H",
    "Long expiration",
    "Expiration (or cancellation) of long derivative position with value received",
    "derivative",
  ),
  info(
    "O",
    "Out-of-the-money exercise",
    "Exercise of out-of-the-money derivative security",
    "derivative",
  ),
  info(
    "X",
    "In-the-money exercise",
    "Exercise of in-the-money or at-the-money derivative security",
    "derivative",
  ),
  info("G", "Gift", "Bona fide gift", "exempt"),
  info("L", "Small acquisition", "Small acquisition under Rule 16a-6", "exempt"),
  info(
    "W",
    "Will or inheritance",
    "Acquisition or disposition by will or the laws of descent and distribution",
    "exempt",
  ),
  info("Z", "Voting trust", "Deposit into or withdrawal from voting trust", "exempt"),
  info("J", "Other", "Other acquisition or disposition (describe transaction)", "other"),
  info(
    "K",
    "Equity swap",
    "Transaction in equity swap or instrument with similar characteristics",
    "other",
  ),
  info(
    "U",
    "Tender in change of control",
    "Disposition pursuant to a tender of shares in a change of control transaction",
    "other",
  ),
];

const BY_CODE = new Map(TRANSACTION_CODES.map((c) => [c.code, c]));

/** The legend entry for a code; an unknown code says so rather than guessing a meaning. */
export function codeInfo(code: string): CodeInfo {
  return (
    BY_CODE.get(code) ?? {
      code,
      label: `Code ${code}`,
      description: "Not a code listed in SEC's Form 4 instructions",
      group: "other",
    }
  );
}
