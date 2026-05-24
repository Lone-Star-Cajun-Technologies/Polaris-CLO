import { describe, it, expect } from "vitest";
import { validateConfig } from "./validator.js";

describe("validateConfig — providers", () => {
  it("accepts config with no providers field", () => {
    const result = validateConfig({ version: "1.0" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts empty providers object", () => {
    const result = validateConfig({ providers: {} });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts valid providers.repoAnalysis with preferred and fallback", () => {
    const result = validateConfig({
      providers: {
        repoAnalysis: {
          preferred: "gitnexus",
          fallback: ["polaris-map", "ripgrep"],
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts providers.repoAnalysis with only preferred", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { preferred: "gitnexus" } },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts providers.repoAnalysis with only fallback", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { fallback: ["polaris-map"] } },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects providers that is not an object", () => {
    const result = validateConfig({ providers: "gitnexus" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("providers must be an object");
  });

  it("rejects providers.repoAnalysis that is not an object", () => {
    const result = validateConfig({ providers: { repoAnalysis: 42 } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("providers.repoAnalysis must be an object");
  });

  it("rejects providers.repoAnalysis.preferred that is not a string", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { preferred: 123 } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "providers.repoAnalysis.preferred must be a string",
    );
  });

  it("rejects providers.repoAnalysis.fallback that is not an array of strings", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { fallback: "polaris-map" } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "providers.repoAnalysis.fallback must be an array of strings",
    );
  });

  it("rejects providers.repoAnalysis.fallback with non-string elements", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { fallback: [1, 2] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "providers.repoAnalysis.fallback must be an array of strings",
    );
  });

  it("does not warn on the providers key", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { preferred: "gitnexus" } },
    });
    expect(result.warnings).not.toContain('Unknown config field: "providers"');
  });
});
