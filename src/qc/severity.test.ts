import { describe, expect, it } from "vitest";
import { compareSeverity, DEFAULT_SEVERITY_MAPPING, maxSeverity, normalizeSeverity } from "./severity.js";

describe("normalizeSeverity", () => {
  it("maps exact provider labels to Polaris levels", () => {
    expect(normalizeSeverity("critical")).toBe("critical");
    expect(normalizeSeverity("high")).toBe("high");
    expect(normalizeSeverity("medium")).toBe("medium");
    expect(normalizeSeverity("low")).toBe("low");
    expect(normalizeSeverity("info")).toBe("info");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeSeverity("  HIGH  ")).toBe("high");
    expect(normalizeSeverity("Critical")).toBe("critical");
  });

  it("falls back to info for unknown labels", () => {
    expect(normalizeSeverity("weird")).toBe("info");
    expect(normalizeSeverity("")).toBe("info");
    expect(normalizeSeverity(undefined)).toBe("info");
  });

  it("uses substring matching for noisy labels", () => {
    expect(normalizeSeverity("high-priority")).toBe("high");
    expect(normalizeSeverity("low-impact")).toBe("low");
    expect(normalizeSeverity("info-note")).toBe("info");
  });

  it("honors provider-specific overrides", () => {
    const mapping = { custom: "high" as const };
    expect(normalizeSeverity("custom", mapping)).toBe("high");
  });

  it("provider overrides take precedence over defaults", () => {
    const mapping = { high: "low" as const };
    expect(normalizeSeverity("high", mapping)).toBe("low");
  });

  it("ignores inherited prototype properties when normalizing severities", () => {
    expect(normalizeSeverity("constructor")).toBe("info");
    expect(normalizeSeverity("toString")).toBe("info");
  });
});

describe("DEFAULT_SEVERITY_MAPPING", () => {
  it("covers the full Polaris severity spectrum", () => {
    const values = new Set(Object.values(DEFAULT_SEVERITY_MAPPING));
    expect(values.has("critical")).toBe(true);
    expect(values.has("high")).toBe(true);
    expect(values.has("medium")).toBe(true);
    expect(values.has("low")).toBe(true);
    expect(values.has("info")).toBe(true);
  });
});

describe("severity comparison", () => {
  it("orders info < low < medium < high < critical", () => {
    expect(compareSeverity("info", "critical")).toBeLessThan(0);
    expect(compareSeverity("critical", "info")).toBeGreaterThan(0);
    expect(compareSeverity("medium", "medium")).toBe(0);
  });

  it("maxSeverity returns the more severe level", () => {
    expect(maxSeverity("low", "high")).toBe("high");
    expect(maxSeverity("medium", "low")).toBe("medium");
    expect(maxSeverity("critical", "critical")).toBe("critical");
  });
});
