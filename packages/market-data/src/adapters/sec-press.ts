import { decodeHtmlEntities, htmlTextBlocks, type TextBlock } from "../html-text";

/**
 * Company press releases filed with SEC as exhibits to Form 8-K (Phase 2 step I1). A filing's
 * index page lists its documents with their types; the release is usually Exhibit 99.1. The
 * headline and lead paragraph are read from the exhibit's text: the headline is the first line
 * that is not a document label, contact detail or release instruction, before the dateline
 * paragraph ("SANTA CLARA, Calif. — Aug. 26, 2026 — NVIDIA today reported …"). A document
 * without a dateline (a slide deck, a shareholder letter) has no headline here, and the news
 * item says what was filed instead. Checked against 38 exhibits filed in 2026 (recorded
 * fixtures: test/fixtures/sec-edgar/recorded/press).
 */

/** Form 8-K item titles as SEC's Form 8-K prints them (https://www.sec.gov/files/form8-k.pdf, read 2026-10-02). */
export const FORM_8K_ITEMS: Readonly<Record<string, string>> = {
  "1.01": "Entry into a Material Definitive Agreement",
  "1.02": "Termination of a Material Definitive Agreement",
  "1.03": "Bankruptcy or Receivership",
  "1.04": "Mine Safety – Reporting of Shutdowns and Patterns of Violations",
  "1.05": "Material Cybersecurity Incidents",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03":
    "Creation of a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement of a Registrant",
  "2.04":
    "Triggering Events That Accelerate or Increase a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement",
  "2.05": "Costs Associated with Exit or Disposal Activities",
  "2.06": "Material Impairments",
  "3.01":
    "Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing",
  "3.02": "Unregistered Sales of Equity Securities",
  "3.03": "Material Modification to Rights of Security Holders",
  "4.01": "Changes in Registrant’s Certifying Accountant",
  "4.02":
    "Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review",
  "5.01": "Changes in Control of Registrant",
  "5.02":
    "Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers",
  "5.03": "Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year",
  "5.04": "Temporary Suspension of Trading Under Registrant’s Employee Benefit Plans",
  "5.05":
    "Amendments to the Registrant’s Code of Ethics, or Waiver of a Provision of the Code of Ethics",
  "5.06": "Change in Shell Company Status",
  "5.07": "Submission of Matters to a Vote of Security Holders",
  "5.08": "Shareholder Director Nominations",
  "6.01": "ABS Informational and Computational Material",
  "6.02": "Change of Servicer or Trustee",
  "6.03": "Change in Credit Enhancement or Other External Support",
  "6.04": "Failure to Make a Required Distribution",
  "6.05": "Securities Act Updating Disclosure",
  "6.06": "Static Pool",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

export interface FilingDocument {
  sequence: number | null;
  description: string;
  /** File name in the filing's folder. */
  file: string;
  /** EDGAR document type, e.g. "8-K", "EX-99.1", "GRAPHIC". */
  type: string;
}

const cellText = (html: string) =>
  decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** The documents a filing index page (…-index.htm) lists, in its order. */
export function filingIndexDocuments(indexHtml: string): FilingDocument[] {
  const docs: FilingDocument[] = [];
  for (const row of indexHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]!);
    if (cells.length < 4) continue;
    const link = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(cells[2]!);
    if (!link) continue;
    // Inline XBRL documents link through the viewer (/ix?doc=/Archives/…); the link text is the
    // file name either way.
    const file =
      cellText(link[2]!) || decodeHtmlEntities(link[1]!).split(/[?#]/)[0]!.split("/").at(-1)!;
    if (!/^[A-Za-z0-9._-]+$/.test(file)) continue;
    const seq = Number(cellText(cells[0]!));
    docs.push({
      sequence: cellText(cells[0]!) !== "" && Number.isInteger(seq) ? seq : null,
      description: cellText(cells[1]!),
      file,
      type: cellText(cells[3]!).toUpperCase(),
    });
  }
  return docs;
}

/** The exhibit read as the press release: the lowest-numbered EX-99 document in HTML or text. */
export function pressReleaseExhibit(docs: readonly FilingDocument[]): FilingDocument | null {
  const exhibits = docs
    .map((d) => ({ d, n: /^EX-99(?:\.(\d{1,3}))?$/.exec(d.type) }))
    .filter((x) => x.n && /\.(?:html?|txt)$/i.test(x.d.file))
    .map((x) => ({ d: x.d, n: x.n![1] === undefined ? 0 : Number(x.n![1]) }))
    .sort((a, b) => a.n - b.n || (a.d.sequence ?? 0) - (b.d.sequence ?? 0));
  return exhibits[0]?.d ?? null;
}

const MONTH = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?`;
const MONTH_DATE = new RegExp(String.raw`\b${MONTH}\s+\d{1,2},?\s+\d{4}\b`, "i");
const words = (s: string) => s.split(" ").filter((w) => /[A-Za-z0-9]/.test(w)).length;

/** Words that make a line say something happened, as a headline does. */
const HEADLINE_VERB =
  /\b(?:reports?|reported|announc(?:es|ed|ing)|acquir(?:es|ed)|appoints?|appointed|names?|named|elects?|elected|completes?|completed|declares?|increases?|raises?|launch(?:es)?|agrees?|signs?|sells?|buys?|opens?|closes?|files?|prices?|cuts?|expands?|joins?|retires?|delivers?|releases|posts?|beats?|issues?|updates?|provides?|plans?|sets?|wins?|to)\b/i;

const CORPORATE =
  /\b(?:company|corporation|corp\.?|inc\.?|incorporated|co\.?|ltd\.?|limited|llc|l\.p\.|plc|n\.v\.|s\.a\.|ag|se|group|holdings)$/i;
const STREET =
  /\b(?:street|st\.?|avenue|ave\.?|boulevard|blvd\.?|road|rd\.?|drive|dr\.?|way|parkway|pkwy\.?|place|plaza|lane|ln\.?|court|ct\.?|square|suite \d+|floor)$/i;
const PERIOD_START =
  /^(?:(?:first|second|third|fourth)[\s-]+quarter|q[1-4]|[1-4]q|fiscal|full[\s-]+year|fy\s?\d{0,4}|annual|year[\s-]+end)\b/i;
const PERIOD_END = /(?:\b(?:19|20)\d{2}|\bresults|\brelease|\bupdate|\bhighlights)$/i;

/**
 * Lines that label the document or give contacts, addresses and release instructions, the
 * company's own name, or a period kicker ("Second Quarter 2026"): never headlines.
 */
function isBoilerplate(text: string): boolean {
  const n = words(text);
  const verb = HEADLINE_VERB.test(text);
  return (
    !/[A-Za-z]{2}/.test(text) ||
    /^ex(?:hibit)?[\s.-]*99\b/i.test(text) ||
    /^(?:news|press|media)\s+(?:release|summary|advisory)\b/i.test(text) ||
    /^for\b.*\brelease\b/i.test(text) ||
    /^embargoed\b/i.test(text) ||
    (n <= 6 &&
      /\b(?:(?:earnings|news|press)\s+release|contacts?|relations|communications|inquiries)\b/i.test(
        text,
      )) ||
    /\bcontacts?\s*:/i.test(text) ||
    /\S@\S/.test(text) ||
    /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/.test(text) ||
    new RegExp(String.raw`^(?:\w+day,\s*)?${MONTH}\s+\d{1,2},?\s+\d{4}$`, "i").test(text) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text) ||
    (/^\d+\s/.test(text) &&
      (STREET.test(text) || /\b(?:street|avenue|blvd|plaza|road)\b/i.test(text))) ||
    (n <= 4 && !verb && STREET.test(text)) ||
    /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(text) ||
    (n <= 6 && !verb && CORPORATE.test(text)) ||
    (n <= 6 && !verb && PERIOD_START.test(text) && PERIOD_END.test(text)) ||
    /^(?:dear|to our)\b/i.test(text) ||
    /^(?:www\.|https?:)/i.test(text)
  );
}

const BULLET = /^[•■◦▪●○·*–—―-]/;

/** "SANTA CLARA, Calif. —", "DALLAS (Sept. 17, 2026)", "SEATTLE; July 29, 2026". */
const CAPS_CITY = /^\(?[A-Z][A-Z.'’&-]{2,}(?:\s+[A-Z][A-Z.'’&-]*){0,3}\s*(?:[,;)]|\(|[—–―-])/;
/** "Purchase, NY -", "Menlo Park, Calif. –", "(Beaverton, OR) --". */
const CITY_STATE =
  /^\(?[A-Z][A-Za-z.'’-]*(?:\s[A-Z][A-Za-z.'’-]*){0,3},\s*[A-Z][A-Za-z.]{1,12}\)?(?:[,;]|\s*[(—–―-])/;

/**
 * The dateline: the paragraph opening with the place and the date, or saying "today"
 * ("NEW YORK, Tuesday, August 4, 2026 — Pfizer Inc. … reported").
 */
function isDateline(text: string): boolean {
  if (words(text) < 6 || !(CAPS_CITY.test(text) || CITY_STATE.test(text))) return false;
  const head = text.slice(0, 200);
  return /\btoday\b/i.test(head) || MONTH_DATE.test(head);
}

/** A line that marks the document as a release ("NEWS RELEASE", "For immediate release"). */
const RELEASE_MARK = /^(?:(?:news|press|earnings)\s+release|for\s+(?:immediate\s+)?release)\b/i;

/**
 * A headline line continues on the next when it breaks mid-phrase, or when the document is laid
 * out line by line (converted from PDF) and the next line has the same type size.
 */
function continues(current: string, last: TextBlock, next: TextBlock): boolean {
  if (BULLET.test(next.text) || isBoilerplate(next.text) || /[.!?]["”’]?$/.test(current)) {
    return false;
  }
  return (
    /^(?:and|&)\s/i.test(next.text) ||
    /[;,:–—-]$/.test(current) ||
    /\s(?:and|or|of|to|for|the|a|an|with|as|in|on|at|by|from|its|their|his|her|our|this|these)$/i.test(
      current,
    ) ||
    nextLineOf(last, next)
  );
}

/** In a line-by-line layout: the next line, same type size, directly below. */
function nextLineOf(last: TextBlock, next: TextBlock): boolean {
  if (!last.absolute || !next.absolute || last.fontSize === null) return false;
  if (last.fontSize !== next.fontSize || last.top === null || next.top === null) return false;
  const size = Number.parseFloat(last.fontSize);
  return next.top > last.top && next.top - last.top <= 1.6 * size;
}

export interface PressRelease {
  headline: string | null;
  /** The dateline paragraph, cut at a sentence end near 500 characters. */
  lead: string | null;
}

export const HEADLINE_MAX = 300;
const LEAD_MAX = 500;
/** A dateline this short is only the place and date; it is not a summary. */
const LEAD_MIN_WORDS = 12;

function cutLead(text: string): string | null {
  if (words(text) < LEAD_MIN_WORDS) return null;
  if (text.length <= LEAD_MAX) return text;
  const head = text.slice(0, LEAD_MAX);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".” "), head.lastIndexOf('." '));
  return end > 150 ? head.slice(0, end + 1) : `${head.replace(/\s+\S*$/, "")} …`;
}

/** The first headline-like line in blocks[from, to), with its continuation lines. */
function firstHeadline(blocks: readonly TextBlock[], from: number, to: number): string | null {
  for (let i = from; i < to; i += 1) {
    const text = blocks[i]!.text;
    // Names, company names and short labels in the contact block are skipped too.
    if (isBoilerplate(text) || BULLET.test(text) || words(text) < 3) continue;
    let headline = text;
    let last = blocks[i]!;
    for (let j = i + 1; j < to && continues(headline, last, blocks[j]!); j += 1) {
      headline = `${headline} ${blocks[j]!.text}`;
      last = blocks[j]!;
    }
    return headline.length <= HEADLINE_MAX ? headline : null;
  }
  return null;
}

export function readPressRelease(html: string): PressRelease {
  const blocks = htmlTextBlocks(html, { maxBlocks: 150 });
  const d = blocks.findIndex((b) => isDateline(b.text));
  if (d >= 0) {
    return { headline: firstHeadline(blocks, 0, Math.min(d, 40)), lead: cutLead(blocks[d]!.text) };
  }
  // No dateline (some releases open with tables): a release marker near the top still says
  // where the headline is.
  const mark = blocks.slice(0, 12).findIndex((b) => RELEASE_MARK.test(b.text));
  if (mark < 0) return { headline: null, lead: null };
  const headline = firstHeadline(blocks, mark + 1, Math.min(blocks.length, mark + 6));
  return { headline: headline && words(headline) >= 4 ? headline : null, lead: null };
}

/** Says what was filed when the exhibit has no readable headline. */
export function filedDescription(
  company: string,
  exhibitType: string,
  items: readonly string[],
): string {
  const named = items
    .filter((i) => i !== "9.01")
    .map((i) => FORM_8K_ITEMS[i] ?? `Item ${i}`)
    .slice(0, 2);
  const about = named.length ? `: ${named.join("; ")}` : "";
  return `${company} filed ${exhibitType.replace(/^EX-/, "Exhibit ")} with a Form 8-K${about}`;
}
