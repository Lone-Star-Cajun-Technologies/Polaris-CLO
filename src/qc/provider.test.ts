import { describe, it, expect } from "vitest";
import { QcProviderRegistry } from "./provider.js";
import { CodeRabbitQcProvider } from "./providers/coderabbit.js";

describe("QcProviderRegistry", () => {
  it("registers and retrieves providers by name", () => {
    const registry = new QcProviderRegistry();
    const provider = new CodeRabbitQcProvider();
    registry.register(provider);

    expect(registry.has("coderabbit")).toBe(true);
    expect(registry.get("coderabbit")).toBe(provider);
  });

  it("lists all registered providers", () => {
    const registry = new QcProviderRegistry();
    const provider = new CodeRabbitQcProvider();
    registry.register(provider);

    expect(registry.list()).toEqual([provider]);
  });

  it("returns candidates that can review a PR scope", () => {
    const registry = new QcProviderRegistry();
    registry.register(new CodeRabbitQcProvider());

    const candidates = registry.candidatesFor({
      clusterId: "POL-470",
      runId: "polaris-run-pol-470",
      prUrl: "https://github.com/org/repo/pull/1",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("coderabbit");
  });

  it("returns no candidates for a scope without branch or PR URL", () => {
    const registry = new QcProviderRegistry();
    registry.register(new CodeRabbitQcProvider());

    const candidates = registry.candidatesFor({
      clusterId: "POL-470",
      runId: "polaris-run-pol-470",
    });

    expect(candidates).toHaveLength(0);
  });
});

describe("CodeRabbitQcProvider", () => {
  it("advertises all expected capabilities", () => {
    const provider = new CodeRabbitQcProvider();

    expect(provider.capabilities).toContain("diff-review");
    expect(provider.capabilities).toContain("pr-review");
    expect(provider.capabilities).toContain("result-parsing");
    expect(provider.capabilities).toContain("auto-fix");
    expect(provider.capabilities).toContain("metrics-import");
  });

  it("supports local and pr modes", () => {
    const provider = new CodeRabbitQcProvider();

    expect(provider.supportedModes).toContain("local");
    expect(provider.supportedModes).toContain("pr");
  });

  it("builds a PR review command when prUrl is provided", () => {
    const provider = new CodeRabbitQcProvider();
    const command = provider.buildReviewCommand({
      clusterId: "POL-470",
      runId: "polaris-run-pol-470",
      prUrl: "https://github.com/org/repo/pull/1",
    });

    expect(command.command).toBe("coderabbit");
    expect(command.args).toEqual(["review", "--pr-url", "https://github.com/org/repo/pull/1"]);
  });

  it("builds a local review command when branch is provided", () => {
    const provider = new CodeRabbitQcProvider();
    const command = provider.buildReviewCommand({
      clusterId: "POL-470",
      runId: "polaris-run-pol-470",
      branch: "feature-branch",
    });

    expect(command.command).toBe("coderabbit");
    expect(command.args).toEqual(["review", "--branch", "feature-branch"]);
  });

  it("parses raw output into a stub result without findings", () => {
    const provider = new CodeRabbitQcProvider();
    const result = provider.parse({
      provider: "coderabbit",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(result.provider).toBe("coderabbit");
    expect(result.status).toBe("passed");
    expect(result.findings).toHaveLength(0);
    expect(result.policyDecision.blocksDelivery).toBe(false);
  });

  it("imports metrics into a stub skipped result", () => {
    const provider = new CodeRabbitQcProvider();
    const result = provider.importMetrics({
      provider: "coderabbit",
      format: "coderabbit",
      data: {},
    });

    expect(result.providerMode).toBe("metrics-import");
    expect(result.status).toBe("skipped");
    expect(result.findings).toHaveLength(0);
  });
});
