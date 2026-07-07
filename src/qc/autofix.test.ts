import { describe, it, expect } from "vitest";
import type { QcFinding } from "./types.js";
import type { QcConfig } from "../config/schema.js";
import { isAutofixEligible, QC_SAFE_FIX_MODES } from "./autofix.js";

function makeFinding(overrides: Partial<QcFinding> = {}): QcFinding {
  return {
    findingId: "f-1",
    severity: "low",
    category: "style",
    title: "Test finding",
    fixAvailable: true,
    autofixEligible: false,
    attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-472" },
    status: "open",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<QcConfig> = {}): QcConfig {
  return {
    enabled: true,
    providers: {
      coderabbit: { name: "coderabbit", mode: "pr", autoFixEligible: true },
    },
    autoFix: "apply",
    ...overrides,
  };
}

describe("isAutofixEligible", () => {
  it("allows safe auto-fix for eligible provider, low severity, safe mode", () => {
    const finding = makeFinding({ suggestedAction: "style" });
    const result = isAutofixEligible(finding, makeConfig(), { provider: "coderabbit" });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("auto-fix eligible");
  });

  it("blocks auto-fix when globally disabled", () => {
    const finding = makeFinding();
    const result = isAutofixEligible(finding, makeConfig({ autoFix: "disabled" }), { provider: "coderabbit" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("auto-fix disabled globally");
  });

  it("blocks auto-fix when provider is not eligible", () => {
    const finding = makeFinding();
    const result = isAutofixEligible(finding, makeConfig(), { provider: "unknown" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("provider not auto-fix eligible");
  });

  it("blocks auto-fix for high severity", () => {
    const finding = makeFinding({ severity: "high" });
    const result = isAutofixEligible(finding, makeConfig(), { provider: "coderabbit" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("exceeds auto-fix threshold");
  });

  it("blocks auto-fix for security category", () => {
    const finding = makeFinding({ category: "security" });
    const result = isAutofixEligible(finding, makeConfig(), { provider: "coderabbit" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("security-sensitive finding");
  });

  it("blocks auto-fix for unsafe fix mode", () => {
    const finding = makeFinding({ suggestedAction: "rewrite-logic" });
    const result = isAutofixEligible(finding, makeConfig(), { provider: "coderabbit" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("not in safe list");
  });

  it("blocks auto-fix on dirty branch", () => {
    const finding = makeFinding({ suggestedAction: "typo" });
    const result = isAutofixEligible(finding, makeConfig(), { provider: "coderabbit", branchDirty: true });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("branch has uncommitted changes");
  });

  it("reports dry-run mode when policy is dry-run", () => {
    const finding = makeFinding({ suggestedAction: "format" });
    const result = isAutofixEligible(finding, makeConfig({ autoFix: "dry-run" }), { provider: "coderabbit" });
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain("dry-run");
  });
});

export { QC_SAFE_FIX_MODES };
