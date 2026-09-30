/**
 * Minimal iCalendar (RFC 5545) writer for all-day events: CRLF line endings, text escaping and
 * 75-octet line folding.
 */
export interface IcsEvent {
  uid: string;
  date: string; // YYYY-MM-DD
  summary: string;
  description?: string;
}

function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Folds a content line so no physical line exceeds 75 octets (UTF-8 safe). */
export function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + n > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

export function buildIcs(
  name: string,
  events: readonly IcsEvent[],
  now: Date = new Date(),
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Market Analysis//Personal calendar//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const e of events) {
    const start = e.date.replace(/-/g, "");
    const next = new Date(Date.parse(e.date) + 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(e.uid)}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${escapeText(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
