import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS, FLAG_KEYS, isFlagKey, resolveFlags } from "../src";

describe("feature flags", () => {
  it("defaults every flag from the registry", () => {
    const flags = resolveFlags([]);
    for (const key of FLAG_KEYS) expect(flags[key]).toBe(FEATURE_FLAGS[key].default);
  });

  it("applies the owner's overrides and ignores keys that are not registered", () => {
    const flags = resolveFlags([
      { key: "backtests", enabled: !FEATURE_FLAGS.backtests.default },
      { key: "not_a_flag", enabled: true },
    ]);
    expect(flags.backtests).toBe(!FEATURE_FLAGS.backtests.default);
    expect(Object.keys(flags)).toEqual(FLAG_KEYS);
  });

  it("recognizes registered keys only, never inherited properties", () => {
    expect(isFlagKey("backtests")).toBe(true);
    expect(isFlagKey("toString")).toBe(false);
    expect(isFlagKey("")).toBe(false);
  });

  it("keeps keys in the format the database accepts", () => {
    for (const key of FLAG_KEYS) expect(key).toMatch(/^[a-z][a-z0-9_]{1,62}$/);
  });
});
