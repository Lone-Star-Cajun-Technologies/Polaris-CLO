import { describe, it, expect } from "vitest";
import type { QcFinding } from "./types.js";
import type { QcConfig } from "../config/schema.js";
import { decideRepairRouting } from "./routing.js";

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
    severityThresholds: { block: "high", repair: "medium", followUp: "low" },
    ...overrides,
  };
}

describe("decideRepairRouting", () => {
  it("routes auto-fix eligible findings with clear attribution back to the original worker", () => {
    const finding = makeFinding({ severity: "medium", suggestedAction: "style" });
    const routing = decideRepairRouting(finding, makeConfig(), true);
    expect(routing).toBe("original-worker");
  });

  it("escalates high severity findings to operator review", () => {
    const finding = makeFinding({ severity: "high" });
    const routing = decideRepairRouting(finding, makeConfig(), false);
    expect(routing).toBe("operator-review");
  });

  it("escalates critical findings to operator review", () => {
    const finding = makeFinding({ severity: "critical" });
    const routing = decideRepairRouting(finding, makeConfig(), false);
    expect(routing).toBe("operator-review");
  });

  it("creates follow-up issues for low severity findings", () => {
    const finding = makeFinding({ severity: "low", autofixEligible: false });
    const routing = decideRepairRouting(finding, makeConfig(), false);
    expect(routing).toBe("follow-up");
  });

  it("hands shared ownership to a repair worker", () => {
    const finding = makeFinding({
      severity: "medium",
      attribution: { confidence: "low", reason: "shared-file", childId: "POL-472" },
    });
    const routing = decideRepairRouting(finding, makeConfig(), false);
    expect(routing).toBe("repair-worker");
  });

  it("escalates blocked auto-fix security findings to operator review", () => {
    const finding = makeFinding({ severity: "medium", category: "security", suggestedAction: "safe" });
    const routing = decideRepairRouting(finding, makeConfig(), false);
    expect(routing).toBe("operator-review");
  });

  it("escalates medium unattributed findings to operator review", () => {
    const finding = makeFinding({
      severity: "medium",
      attribution: { confidence: "unattributed", reason: "unattributed" },
    });
    const routing = decideRepairRouting(finding, makeConfig(), false);
    expect(routing).toBe("operator-review");
  });
});
