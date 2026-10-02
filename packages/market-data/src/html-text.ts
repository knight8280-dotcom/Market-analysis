/**
 * Text blocks from an HTML document, for reading filed documents such as press releases. Not a
 * full HTML parser: scripts, styles and the head are dropped, block-level tags end a block, a
 * line break inside a block reads as a space (headlines are often broken across lines), and
 * character references are decoded. Each block is whitespace-collapsed text.
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  horbar: "―",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  hellip: "…",
  bull: "•",
  middot: "·",
  reg: "®",
  copy: "©",
  trade: "™",
  sect: "§",
  para: "¶",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  cent: "¢",
  pound: "£",
  euro: "€",
  yen: "¥",
  shy: "",
  zwsp: "",
  zwj: "",
  zwnj: "",
};

/** Decodes numeric and common named character references; unknown names stay as written. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});/gi,
    (match, ref: string) => {
      if (ref[0] === "#") {
        const code =
          ref[1] === "x" || ref[1] === "X"
            ? Number.parseInt(ref.slice(2), 16)
            : Number(ref.slice(1));
        if (
          !Number.isFinite(code) ||
          code <= 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          return match;
        }
        return String.fromCodePoint(code);
      }
      return NAMED[ref.toLowerCase()] ?? match;
    },
  );
}

const BLOCK_NAMES =
  "p|div|tr|td|th|li|ul|ol|h[1-6]|table|thead|tbody|tfoot|center|section|article|header|footer|blockquote|pre|dl|dt|dd|hr|title";
/** Captured, so split() keeps each block tag next to the text it opens. */
const BLOCK_TAG = new RegExp(`(<\\/?(?:${BLOCK_NAMES})\\b[^>]*>)`, "i");
const IS_BLOCK_TAG = new RegExp(`^<\\/?(?:${BLOCK_NAMES})\\b[^>]*>$`, "i");

/** Invisible and zero-width characters that some filing tools sprinkle through text. */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;

export interface TextBlock {
  text: string;
  /**
   * Placed line by line at absolute positions, as documents converted from PDF are: a heading
   * there is several blocks with the same font size.
   */
  absolute: boolean;
  /** The first font size given in or around the block, in its unit ("24pt"), if any. */
  fontSize: string | null;
  /** The block's `top` offset when it is placed absolutely, in the font size's unit. */
  top: number | null;
}

export function htmlTextBlocks(html: string, opts: { maxBlocks?: number } = {}): TextBlock[] {
  const max = opts.maxBlocks ?? Number.POSITIVE_INFINITY;
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    // EDGAR's SGML wrapper around a document: <TYPE>EX-99.1 <SEQUENCE>2 <FILENAME>… <TEXT>.
    .replace(/<(?:type|sequence|filename|description)>[^<\n]*/gi, " ")
    .replace(/<br\b[^>]*>/gi, " ");
  const blocks: TextBlock[] = [];
  let opening = "";
  for (const part of body.split(BLOCK_TAG)) {
    if (IS_BLOCK_TAG.test(part)) {
      opening = part.startsWith("</") ? "" : part;
      continue;
    }
    const text = decodeHtmlEntities(part.replace(/<[^>]*>/g, ""))
      .replace(INVISIBLE, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      const size = /font-size\s*:\s*([\d.]+\s*(?:pt|px|em|rem|%))/i.exec(`${opening}${part}`);
      const top = /(?:^|[;"'\s])top\s*:\s*(-?[\d.]+)\s*(?:pt|px)/i.exec(opening);
      blocks.push({
        text,
        absolute: /position\s*:\s*absolute/i.test(opening),
        fontSize: size ? size[1]!.replace(/\s+/g, "") : null,
        top: top ? Number(top[1]) : null,
      });
      if (blocks.length >= max) break;
    }
  }
  return blocks;
}

export function htmlBlocks(html: string, opts: { maxBlocks?: number } = {}): string[] {
  return htmlTextBlocks(html, opts).map((b) => b.text);
}
