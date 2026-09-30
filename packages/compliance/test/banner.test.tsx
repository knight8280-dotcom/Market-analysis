import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY, SampleDataBanner } from "../src";

describe("SampleDataBanner", () => {
  it("renders in every non-production environment", () => {
    for (const appEnv of ["local", "test", "preview", "staging"]) {
      expect(renderToStaticMarkup(<SampleDataBanner appEnv={appEnv} />)).toContain(
        COPY.sampleDataBanner,
      );
    }
  });

  it("renders in production if synthetic data is present", () => {
    expect(
      renderToStaticMarkup(<SampleDataBanner appEnv="production" hasSyntheticData />),
    ).toContain("SAMPLE DATA");
  });

  it("renders nothing in production with licensed data only", () => {
    expect(renderToStaticMarkup(<SampleDataBanner appEnv="production" />)).toBe("");
  });
});
