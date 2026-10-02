import { describe, expect, it } from "vitest";
import { findDuplicate, headlineSimilarity, headlineWords, urlKey } from "../src";

describe("urlKey", () => {
  it("drops tracking parameters, fragments, www and trailing slashes", () => {
    expect(
      urlKey("https://www.Example.com/markets/story-1/?utm_source=x&utm_medium=y&id=7#top"),
    ).toBe("example.com/markets/story-1?id=7");
    expect(urlKey("http://m.example.com/a?b=2&a=1&guccounter=1")).toBe("example.com/a?a=1&b=2");
    expect(urlKey("https://example.com")).toBe("example.com/");
  });

  it("refuses anything but an http(s) link to a named host", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "ftp://example.com/a",
      "not a url",
      "https://localhost/a",
      "https://user:pass@example.com/a",
    ]) {
      expect(urlKey(bad), bad).toBeNull();
    }
  });
});

describe("headline similarity", () => {
  it("compares words, ignoring case, punctuation, accents and stopwords", () => {
    expect([
      ...headlineWords("Café’s Q3 sales rise 4.5% to $1.2 billion, the company says"),
    ]).toEqual(["cafes", "q3", "sales", "rise", "4.5%", "$1.2", "billion", "company", "says"]);
    expect(
      headlineSimilarity(
        "Apple beats estimates as iPhone sales jump",
        "Apple Beats Estimates as iPhone Sales Jump - Report",
      ),
    ).toBeCloseTo(6 / 7);
    expect(
      headlineSimilarity(
        "Apple reports third quarter results",
        "Apple reports fourth quarter results",
      ),
    ).toBeCloseTo(4 / 6);
  });

  it("marks a near-identical story within two days as a copy of the earliest", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 8, 1, h));
    const candidates = [
      {
        id: "1",
        headline: "Example Corp raises dividend 10% to $0.55 a share",
        publishedAt: at(0),
      },
      {
        id: "2",
        headline: "Example Corp raises dividend 10% to $0.55 a share",
        publishedAt: at(1),
      },
      { id: "3", headline: "Example Corp cuts jobs in Europe", publishedAt: at(2) },
    ];
    const copy = {
      headline: "Example Corp Raises Dividend 10% to $0.55 a Share",
      publishedAt: at(5),
    };
    expect(findDuplicate(copy, candidates)?.id).toBe("1");
    expect(findDuplicate({ ...copy, publishedAt: at(60) }, candidates)).toBeNull();
    expect(
      findDuplicate({ headline: "Example Corp reports results", publishedAt: at(3) }, candidates),
    ).toBeNull();
    // Too short to tell apart.
    expect(
      findDuplicate({ headline: "Stocks rise", publishedAt: at(1) }, [
        { id: "9", headline: "Stocks rise", publishedAt: at(0) },
      ]),
    ).toBeNull();
  });
});
