/**
 * A small, strict XML reader for EDGAR's structured documents (Form 4 ownership XML). It builds
 * an element tree and fails on anything it does not understand, rather than guessing:
 * - elements, attributes (either quote style), self-closing tags, text, CDATA and comments;
 * - the five predefined entities and numeric character references; any other entity, and any
 *   DOCTYPE (where custom entities would be declared), is an error;
 * - mismatched or unclosed tags are errors; nesting deeper than 64 levels is refused.
 */

export interface XmlElement {
  name: string;
  attrs: Readonly<Record<string, string>>;
  children: XmlElement[];
  /** The element's own text (CDATA included), entity-decoded; children's text is not included. */
  text: string;
}

export class XmlError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} (at character ${offset})`);
    this.name = "XmlError";
  }
}

const NAME = /[A-Za-z_][\w.:-]*/y;
const ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const MAX_DEPTH = 64;
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(raw: string, offset: number): string {
  return raw.replace(/&([^;&\s]{1,10});|&/g, (match, entity: string | undefined) => {
    if (entity === undefined) throw new XmlError("Bare '&' in text", offset);
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (!/^[0-9a-f]+$/i.test(entity.slice(2)) || code > 0x10ffff) {
        throw new XmlError(`Bad character reference ${match}`, offset);
      }
      return String.fromCodePoint(code);
    }
    if (entity.startsWith("#")) {
      const code = Number(entity.slice(1));
      if (!/^\d+$/.test(entity.slice(1)) || code > 0x10ffff) {
        throw new XmlError(`Bad character reference ${match}`, offset);
      }
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[entity];
    if (value === undefined) throw new XmlError(`Unknown entity ${match}`, offset);
    return value;
  });
}

/** Parses a document and returns its root element. */
export function parseXml(xml: string): XmlElement {
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const skipMisc = () => {
    for (;;) {
      while (i < xml.length && /\s/.test(xml[i]!)) i += 1;
      if (xml.startsWith("<?", i)) {
        const end = xml.indexOf("?>", i + 2);
        if (end < 0) throw new XmlError("Unclosed processing instruction", i);
        i = end + 2;
      } else if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i + 4);
        if (end < 0) throw new XmlError("Unclosed comment", i);
        i = end + 3;
      } else if (xml.startsWith("<!DOCTYPE", i) || xml.startsWith("<!doctype", i)) {
        throw new XmlError("DOCTYPE declarations are not accepted", i);
      } else {
        return;
      }
    }
  };

  // Byte-order mark, declaration, comments before the root.
  if (xml.charCodeAt(0) === 0xfeff) i = 1;
  skipMisc();

  while (i < xml.length) {
    const top = stack.at(-1);
    if (!top) {
      if (root) {
        skipMisc();
        if (i < xml.length) throw new XmlError("Content after the root element", i);
        break;
      }
      if (xml[i] !== "<") throw new XmlError("Expected the root element", i);
    }

    if (xml[i] !== "<") {
      const end = xml.indexOf("<", i);
      const raw = xml.slice(i, end < 0 ? xml.length : end);
      if (!top) throw new XmlError("Text outside the root element", i);
      top.text += decode(raw, i);
      i = end < 0 ? xml.length : end;
      continue;
    }

    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) throw new XmlError("Unclosed comment", i);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end < 0 || !top) throw new XmlError("Bad CDATA section", i);
      top.text += xml.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", i) || xml.startsWith("<!", i)) {
      throw new XmlError("Unexpected markup declaration", i);
    }

    if (xml[i + 1] === "/") {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(xml);
      if (!m) throw new XmlError("Bad closing tag", i);
      const name = m[0];
      let j = i + 2 + name.length;
      while (j < xml.length && /\s/.test(xml[j]!)) j += 1;
      if (xml[j] !== ">") throw new XmlError(`Bad closing tag </${name}`, i);
      const open = stack.pop();
      if (!open || open.name !== name) {
        throw new XmlError(`Closing tag </${name}> does not match <${open?.name ?? "none"}>`, i);
      }
      i = j + 1;
      continue;
    }

    NAME.lastIndex = i + 1;
    const m = NAME.exec(xml);
    if (!m) throw new XmlError("Bad tag", i);
    const el: XmlElement = { name: m[0], attrs: {}, children: [], text: "" };
    let j = i + 1 + m[0].length;
    const attrs: Record<string, string> = {};
    for (;;) {
      ATTR.lastIndex = j;
      const a = ATTR.exec(xml);
      if (!a) break;
      const key = a[1]!;
      if (Object.hasOwn(attrs, key)) throw new XmlError(`Repeated attribute ${key}`, j);
      attrs[key] = decode(a[2] ?? a[3] ?? "", j);
      j = ATTR.lastIndex;
    }
    el.attrs = attrs;
    while (j < xml.length && /\s/.test(xml[j]!)) j += 1;
    const selfClosing = xml.startsWith("/>", j);
    if (!selfClosing && xml[j] !== ">") throw new XmlError(`Bad tag <${el.name}`, i);
    i = j + (selfClosing ? 2 : 1);

    if (top) top.children.push(el);
    else root = el;
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new XmlError("Nesting too deep", i);
      stack.push(el);
    }
  }

  if (stack.length > 0) throw new XmlError(`Unclosed element <${stack.at(-1)!.name}>`, i);
  if (!root) throw new XmlError("No root element", 0);
  return root;
}

/** The first child element with this name. */
export function childOf(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

/** Every child element with this name, in document order. */
export function childrenOf(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

/** The trimmed text at a path of child names, or null when absent or empty. */
export function textAt(el: XmlElement | undefined, ...path: string[]): string | null {
  let cur = el;
  for (const name of path) cur = childOf(cur, name);
  const text = cur?.text.trim();
  return text ? text : null;
}
