import { TooltipProvider } from "@market/ui/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY, DisclaimerFooter, HypotheticalDisclosure, StaleDataBanner } from "../src";
import { DataLabel } from "../src/client";

const tiingo = {
  name: "Tiingo",
  attribution: "Data provided by Tiingo",
  url: "https://www.tiingo.com",
};

describe("delay labels (spec §12)", () => {
  it("uses the approved wording", () => {
    expect(COPY.delay("eod", "2026-09-29")).toBe("End-of-day, as of Sep 29, 2026");
    expect(COPY.delay("delayed")).toBe("Delayed 15 min");
    expect(COPY.delay("realtime")).toBe("Real-time");
    expect(COPY.delay("filing", "2025-10-31")).toBe("As filed, Oct 31, 2025");
    expect(COPY.delay("settlement", "2026-09-15")).toBe("Settlement date Sep 15, 2026");
  });
});

describe("ownership copy (spec §2.5, §5.13)", () => {
  it("labels 13F data with its quarter end and filing date, as the spec words it", () => {
    expect(COPY.thirteenF("2026-06-30", "2026-08-14")).toBe(
      "As of quarter end Jun 30, 2026, filed Aug 14, 2026; 13F data is reported up to 45 days after quarter end.",
    );
    expect(COPY.thirteenF("2026-06-30", "2026-07-02", "2026-08-14")).toBe(
      "As of quarter end Jun 30, 2026, filed Jul 2, 2026 to Aug 14, 2026; 13F data is reported up to 45 days after quarter end.",
    );
  });
  it("gives short interest its settlement date", () => {
    expect(COPY.shortInterest("2026-09-15")).toMatch(/^Settlement date Sep 15, 2026\. /);
  });
});

describe("DataLabel", () => {
  it("always shows the delay label and source, and is keyboard focusable", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DataLabel source={tiingo} kind="eod" asOf="2026-09-29" fetchedAt={new Date()} />
      </TooltipProvider>,
    );
    expect(html).toContain("End-of-day, as of Sep 29, 2026 · Source: Tiingo");
    expect(html).toContain('tabindex="0"');
  });
});

describe("StaleDataBanner", () => {
  it("lists each stale dataset and renders nothing when all are fresh", () => {
    const html = renderToStaticMarkup(
      <StaleDataBanner items={[{ dataset: "daily_bars", since: "Sep 29, 2026, 6:30 PM ET" }]} />,
    );
    expect(html).toContain(COPY.staleDataBanner("daily_bars", "Sep 29, 2026, 6:30 PM ET"));
    expect(renderToStaticMarkup(<StaleDataBanner items={[]} />)).toBe("");
  });
});

describe("DisclaimerFooter", () => {
  it("carries the §12 footer with the brand", () => {
    const html = renderToStaticMarkup(<DisclaimerFooter brand="Market Analysis" />);
    expect(html).toContain("Market Analysis provides financial data and analytics");
    expect(html).toContain("Market Analysis is not a registered broker-dealer");
  });
});

describe("backtest disclosure (spec §12)", () => {
  it("fills in the run's assumptions and is shown as a note", () => {
    const text = COPY.backtestDisclosure({
      commissions: "$1.00 per trade",
      slippage: "5 bps",
      fills: "the next session's open",
    });
    expect(text).toBe(
      "Hypothetical results. These results are based on a simulated backtest using historical data and the assumptions shown (commissions $1.00 per trade, slippage 5 bps, fills at the next session's open). They do not represent actual trading, may not reflect the impact of market factors such as liquidity, and benefit from hindsight. Past performance, actual or hypothetical, does not guarantee future results. This tool does not recommend any strategy.",
    );
    const html = renderToStaticMarkup(<HypotheticalDisclosure>{text}</HypotheticalDisclosure>);
    expect(html).toContain('role="note"');
    expect(html).toContain("This tool does not recommend any strategy.");
  });
});

describe("valuation copy (spec §5.6, §12)", () => {
  it("uses the required wording", () => {
    expect(COPY.valuationCalculator).toBe(
      "This model is a calculator driven by your assumptions. It is not a price target or recommendation.",
    );
    expect(COPY.valuationOutput).toBe(
      "Model output depends entirely on your inputs. It is not a price target.",
    );
  });
});
