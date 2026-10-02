/**
 * Records 8-K press-release exhibits from EDGAR as test fixtures (Phase 2 step I1). SEC filings
 * are public; each exhibit is cut soon after what the reader takes from it (or after the first
 * 150 text blocks when it takes nothing) so the fixtures stay small. Expected headlines live in the test, checked by
 * hand against the filed documents.
 *
 *   APP_NAME=… SEC_CONTACT_EMAIL=… pnpm --filter @market/market-data exec tsx scripts/record-press-releases.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  filingIndexDocuments,
  pressReleaseExhibit,
  readPressRelease,
} from "../src/adapters/sec-press";
import { SecEdgarProvider } from "../src/adapters/sec-edgar";
import { htmlBlocks } from "../src/html-text";

/** [CIK, accession]: releases in the layouts seen, and documents without a headline to read. */
const FILINGS: [string, string][] = [
  ["1045810", "0001045810-26-000073"], // NVIDIA: headline first
  ["2488", "0000002488-26-000121"], // AMD: contacts first
  ["12927", "0001628280-26-049929"], // Boeing
  ["18230", "0000018230-26-000040"], // Caterpillar: kicker lines, dateline after tables
  ["27419", "0000027419-26-000034"], // Target: Exhibit 99, phone numbers
  ["40545", "0000040545-26-000059"], // GE Aerospace: headline broken by <br>
  ["50863", "0001193125-26-346806"], // Intel: address block
  ["51143", "0000051143-26-000077"], // IBM: short dateline
  ["60667", "0000060667-26-000113"], // Lowe's: release-time line
  ["63908", "0000063908-26-000076"], // McDonald's: capitals, a sub-headline
  ["72971", "0000072971-26-000288"], // Wells Fargo: no dateline, "News Release" marker
  ["104169", "0000104169-26-000145"], // Walmart: headline in a table cell
  ["354950", "0000354950-26-000145"], // Home Depot: headline over two lines
  ["773840", "0000773840-26-000130"], // Honeywell: contact block
  ["858877", "0000858877-26-000106"], // Cisco: contacts and "News Summary"
  ["1141391", "0001141391-26-000081"], // Mastercard: city not in capitals
  ["1090727", "0001628280-26-059609"], // UPS: headline over two lines
  ["1341439", "0001193125-26-389753"], // Oracle: short release
  ["310158", "0001104659-26-090045"], // Merck: long headline
  ["80424", "0000080424-26-000094"], // P&G: company name and address above the headline
  ["829224", "0000829224-26-000129"], // Starbucks: "SEATTLE; July 29, 2026"
  ["1403161", "0001403161-26-000103"], // Visa: a dateline of eight words
  ["320187", "0000320187-26-000068"], // Nike: "(Beaverton, OR) --"
  ["886982", "0000886982-26-000294"], // Goldman Sachs: laid out line by line, period kicker
  ["1730168", "0001193125-26-266777"], // Broadcom: a headline broken after "its"
  ["1108524", "0001108524-26-000187"], // Salesforce: a sub-headline starting in lower case
  ["51143", "0000051143-26-000070"], // IBM: a letter with a short dateline
  ["731766", "0000731766-26-000191"], // UnitedHealth: one block per page (no headline read)
  ["789019", "0001193125-26-380280"], // Microsoft: slide deck (no headline)
  ["1744489", "0001744489-26-000056"], // Disney: shareholder letter (no headline)
  ["1318605", "0001628280-26-049213"], // Tesla: update deck (no headline)
];
/** Index pages recorded whole: three exhibits, one, and none. */
const INDEX_PAGES = new Set(["0001045810-26-000073", "0000072971-26-000288"]);
const NO_EXHIBIT: [string, string] = ["1045810", "0001045810-26-000078"];

const OUT = fileURLToPath(new URL("../test/fixtures/sec-edgar/recorded/press/", import.meta.url));

/** The shortest prefix that reads the same as the whole document, ending at a tag. */
function trim(html: string): string {
  const full = readPressRelease(html);
  let length = html.length;
  if (full.headline === null && full.lead === null) {
    // Nothing read: keep the 150 blocks the reader looks through.
    for (let n = 4096; n < html.length; n += 4096) {
      if (htmlBlocks(html.slice(0, n), { maxBlocks: 151 }).length > 150) {
        length = n;
        break;
      }
    }
  } else {
    for (let n = 4096; n < html.length; n += 4096) {
      const r = readPressRelease(html.slice(0, n));
      if (r.headline === full.headline && r.lead === full.lead) {
        length = Math.min(html.length, n + 2048);
        break;
      }
    }
  }
  const end = html.indexOf(">", length);
  return end < 0 ? html : html.slice(0, end + 1);
}

async function main() {
  const appName = process.env.APP_NAME;
  const contactEmail = process.env.SEC_CONTACT_EMAIL;
  if (!appName || !contactEmail) throw new Error("Set APP_NAME and SEC_CONTACT_EMAIL");
  const sec = new SecEdgarProvider({
    appName,
    contactEmail,
    // Well under SEC's 10 requests a second.
    rateLimiter: { acquire: () => new Promise((resolve) => setTimeout(resolve, 250)) },
  });
  mkdirSync(OUT, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  for (const [cik, accession] of [...FILINGS, NO_EXHIBIT]) {
    const index = await sec.getArchiveDocument({ cik, accession, file: `${accession}-index.htm` });
    if (INDEX_PAGES.has(accession) || accession === NO_EXHIBIT[1]) {
      writeFileSync(`${OUT}${accession}-index.htm`, index);
    }
    const exhibit = pressReleaseExhibit(filingIndexDocuments(index));
    if (!exhibit) {
      console.log(`${accession}: no EX-99 exhibit`);
      continue;
    }
    const html = await sec.getArchiveDocument({ cik, accession, file: exhibit.file });
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll("-", "")}/${exhibit.file}`;
    const kept = trim(html);
    writeFileSync(
      `${OUT}${accession}.htm`,
      `<!-- ${exhibit.type} recorded from ${url} on ${today}; ${kept.length} of ${html.length} characters kept. -->\n${kept}`,
    );
    console.log(`${accession}: ${exhibit.file}, kept ${kept.length} of ${html.length}`);
  }
}

await main();
