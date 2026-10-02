import { describe, expect, it } from "vitest";
import { childOf, childrenOf, parseXml, textAt, XmlError } from "../src/xml";

/** The strict XML reader behind Form 4 parsing: what it accepts, and what it refuses. */
describe("parseXml", () => {
  it("builds the element tree with attributes, text, CDATA and comments", () => {
    const root = parseXml(
      `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
      <!-- leading comment -->
      <doc kind='a' n="1">
        <item id="F1">first &amp; &lt;second&gt; &quot;q&quot; &apos;a&apos; &#65;&#x42;</item>
        <item id="F2"/>
        <note><![CDATA[raw <b>not markup</b> & more]]></note>
        <!-- inner comment -->
        <nested><nested><leaf>deep</leaf></nested></nested>
      </doc>
      <!-- trailing comment -->`,
    );
    expect(root.name).toBe("doc");
    expect(root.attrs).toEqual({ kind: "a", n: "1" });
    const items = childrenOf(root, "item");
    expect(items.map((i) => i.attrs.id)).toEqual(["F1", "F2"]);
    expect(items[0]!.text).toBe(`first & <second> "q" 'a' AB`);
    expect(items[1]!.children).toEqual([]);
    expect(childOf(root, "note")!.text).toBe("raw <b>not markup</b> & more");
    expect(textAt(root, "nested", "nested", "leaf")).toBe("deep");
    expect(textAt(root, "missing", "leaf")).toBeNull();
    // Whitespace-only text reads as absent.
    expect(textAt(root, "nested")).toBeNull();
  });

  it.each([
    ["mismatched tags", "<a><b></a></b>", /does not match/],
    ["an unclosed element", "<a><b></b>", /Unclosed element <a>/],
    ["an unknown entity", "<a>&nbsp;</a>", /Unknown entity/],
    ["a bare ampersand", "<a>AT&T</a>", /Bare '&'/],
    ["a DOCTYPE (custom entities)", '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', /DOCTYPE/],
    ["text outside the root", "<a/>junk", /after the root/],
    ["a second root", "<a/><b/>", /after the root/],
    ["a repeated attribute", '<a x="1" x="2"/>', /Repeated attribute/],
    ["no root at all", "  ", /No root element/],
    ["an out-of-range character reference", "<a>&#x110000;</a>", /character reference/],
  ])("refuses %s", (_what, xml, message) => {
    expect(() => parseXml(xml)).toThrow(XmlError);
    expect(() => parseXml(xml)).toThrow(message);
  });

  it("refuses nesting deeper than 64 levels", () => {
    const deep = "<a>".repeat(70) + "</a>".repeat(70);
    expect(() => parseXml(deep)).toThrow(/too deep/);
    const fine = "<a>".repeat(60) + "</a>".repeat(60);
    expect(parseXml(fine).name).toBe("a");
  });
});
