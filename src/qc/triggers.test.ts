import { describe, it, expect } from "vitest";
import {
  effectiveProviderTrigger,
  activeProvidersForTrigger,
  isHighRiskScope,
  isChildQcSelected,
  selectChildQcTrigger,
} from "./triggers.js";
import type { QcConfig, QcProviderConfig } from "../config/schema.js";

function makeConfig(overrides?: Partial<QcConfig>): QcConfig {
  const base: QcConfig = {
    enabled: true,
    defaultTrigger: "completed-cluster",
    providers: {
      coderabbit: {
        name: "coderabbit",
        mode: "local",
      } as QcProviderConfig,
    },
    severityThresholds: { block: "high", repair: "medium", followUp: "low" },
    autoFix: "disabled",
    repairRouting: "route",
    artifactRetention: { retainRawOutput: false, maxRuns: 10 },
    routes: {},
  };
  return { ...base, ...overrides };
}

describe("effectiveProviderTrigger", () => {
  it("respects an explicit provider trigger", () => {
    const provider: QcProviderConfig = { name: "x", mode: "local", trigger: "pr" };
    expect(effectiveProviderTrigger(provider, "completed-cluster")).toBe("pr");
  });

  it("derives trigger from provider mode when not explicit", () => {
    const local: QcProviderConfig = { name: "x", mode: "local" };
    const pr: QcProviderConfig = { name: "x", mode: "pr" };
    const metrics: QcProviderConfig = { name: "x", mode: "metrics-import" };
    expect(effectiveProviderTrigger(local, "child")).toBe("completed-cluster");
    expect(effectiveProviderTrigger(pr, "completed-cluster")).toBe("pr");
    expect(effectiveProviderTrigger(metrics, "child")).toBe("completed-cluster");
  });

  it("falls back to the cluster default trigger", () => {
    const provider: QcProviderConfig = { name: "x", mode: "local" };
    expect(effectiveProviderTrigger(provider, "child")).toBe("completed-cluster");
  });
});

describe("activeProvidersForTrigger", () => {
  it("returns no providers when QC is disabled", () => {
    const config = makeConfig({ enabled: false });
    expect(activeProvidersForTrigger(config, "completed-cluster")).toHaveLength(0);
  });

  it("returns providers matching the requested trigger", () => {
    const config = makeConfig({
      providers: {
        local: { name: "local", mode: "local" } as QcProviderConfig,
        pr: { name: "pr", mode: "pr" } as QcProviderConfig,
      },
    });
    const localProviders = activeProvidersForTrigger(config, "completed-cluster");
    expect(localProviders).toHaveLength(1);
    expect(localProviders[0]![0]).toBe("local");

    const prProviders = activeProvidersForTrigger(config, "pr");
    expect(prProviders).toHaveLength(1);
    expect(prProviders[0]![0]).toBe("pr");
  });
});

describe("isHighRiskScope", () => {
  it("returns true for auth/security/payment paths", () => {
    expect(isHighRiskScope(["src/auth/login.ts"])).toBe(true);
    expect(isHighRiskScope(["src/security/permissions.ts"])).toBe(true);
    expect(isHighRiskScope(["src/payments/checkout.ts"])).toBe(true);
  });

  it("returns false for ordinary feature paths", () => {
    expect(isHighRiskScope(["src/feature/widget.ts"])).toBe(false);
    expect(isHighRiskScope([])).toBe(false);
  });
});

describe("child-level QC selection", () => {
  it("is not selected when QC is disabled", () => {
    const config = makeConfig({ enabled: false, providers: { coderabbit: { name: "coderabbit", mode: "local", trigger: "child" } as QcProviderConfig } });
    expect(isChildQcSelected(config, "POL-1", ["src/auth/login.ts"], [])).toBe(false);
  });

  it("is not selected without a child-trigger provider", () => {
    const config = makeConfig();
    expect(isChildQcSelected(config, "POL-1", ["src/auth/login.ts"], [])).toBe(false);
  });

  it("is selected for high-risk scopes when a child provider exists", () => {
    const config = makeConfig({
      providers: { coderabbit: { name: "coderabbit", mode: "local", trigger: "child" } as QcProviderConfig },
    });
    expect(isChildQcSelected(config, "POL-1", ["src/auth/login.ts"], [])).toBe(true);
  });

  it("is selected when route policy enables child-level QC", () => {
    const config = makeConfig({
      providers: { coderabbit: { name: "coderabbit", mode: "local", trigger: "child" } as QcProviderConfig },
      routes: { "POL-1": { childLevel: true } },
    });
    expect(isChildQcSelected(config, "POL-1", ["src/feature/widget.ts"], [], "POL-1")).toBe(true);
  });

  it("is selected with explicit operator request label", () => {
    const config = makeConfig({
      providers: { coderabbit: { name: "coderabbit", mode: "local", trigger: "child" } as QcProviderConfig },
    });
    expect(isChildQcSelected(config, "POL-1", ["src/feature/widget.ts"], ["qc-child"])).toBe(true);
  });

  it("selectChildQcTrigger returns child only when selected", () => {
    const config = makeConfig({
      providers: { coderabbit: { name: "coderabbit", mode: "local", trigger: "child" } as QcProviderConfig },
    });
    expect(selectChildQcTrigger(config, "POL-1", ["src/auth/login.ts"], [])).toBe("child");
    expect(selectChildQcTrigger(config, "POL-2", ["src/feature/widget.ts"], [])).toBe(null);
  });
});
