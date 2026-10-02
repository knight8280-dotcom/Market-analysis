/**
 * News de-duplication (spec §5.12: "Deduplicate by URL/headline similarity"). Two items are the
 * same article when their links agree once tracking parameters and cosmetic differences are
 * dropped; an item is a copy of another when their headlines share nearly all their words and
 * they were published within two days of each other (a syndicated or lightly edited story).
 * Copies are kept and marked, never deleted, so each source still shows.
 */

/** Query parameters that track the reader rather than identify the page. */
const TRACKING =
  /^(?:utm_\w+|ncid|cmpid|cid|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|guccounter|guce_\w+|ref|refsrc|src|siteid|soc_src|soc_trk|taid|yptr|feedtype|ito|smid|smtyp|tpcc|mod|partner|xid|rss|cmp|sr_share|via)$/i;

/**
 * The link as compared: host without "www." or "m.", path without a trailing slash, the
 * remaining query parameters sorted, no fragment. Null for anything but an http(s) link, which
 * is never stored.
 */
export function urlKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./, "");
  if (!host.includes(".")) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  const query = new URLSearchParams(params).toString();
  return `${host}${path}${query ? `?${query}` : ""}`;
}

const STOPWORDS = new Set(
  "a an the of to and or in on for at by with as is are its it from that this be after over into than".split(
    " ",
  ),
);

/** The headline's distinct words: lower case, accents and punctuation dropped, no stopwords. */
export function headlineWords(headline: string): Set<string> {
  const plain = headline
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9$%.]+/g, " ")
    .replace(/(?<![0-9])\.|\.(?![0-9])/g, " ");
  return new Set(plain.split(" ").filter((w) => w && !STOPWORDS.has(w)));
}

/** Words in common over words in either (Jaccard), from 0 to 1. */
export function headlineSimilarity(a: string, b: string): number {
  const x = headlineWords(a);
  const y = headlineWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

export const DUPLICATE_SIMILARITY = 0.8;
export const DUPLICATE_WINDOW_HOURS = 48;
/** Headlines this short ("Stocks rise") say too little to call two stories the same. */
const MIN_WORDS = 4;

export interface Candidate {
  id: string;
  headline: string;
  publishedAt: Date;
}

/**
 * The earlier story this one copies, if any: the most similar headline, at least
 * DUPLICATE_SIMILARITY alike, published within DUPLICATE_WINDOW_HOURS. Ties go to the earliest.
 */
export function findDuplicate(
  item: { headline: string; publishedAt: Date },
  candidates: readonly Candidate[],
): Candidate | null {
  if (headlineWords(item.headline).size < MIN_WORDS) return null;
  const window = DUPLICATE_WINDOW_HOURS * 3_600_000;
  let best: { c: Candidate; score: number } | null = null;
  for (const c of candidates) {
    if (Math.abs(c.publishedAt.getTime() - item.publishedAt.getTime()) > window) continue;
    if (headlineWords(c.headline).size < MIN_WORDS) continue;
    const score = headlineSimilarity(item.headline, c.headline);
    if (score < DUPLICATE_SIMILARITY) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && c.publishedAt.getTime() < best.c.publishedAt.getTime())
    ) {
      best = { c, score };
    }
  }
  return best?.c ?? null;
}
