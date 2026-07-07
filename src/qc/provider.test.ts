import { describe, it, expect } from "vitest";
import { QcProviderRegistry } from "./provider.js";
import { CodeRabbitQcProvider } from "./providers/coderabbit.js";
import fullFixture from "./fixtures/coderabbit-full.json";
import partialFixture from "./fixtures/coderabbit-partial.json";
import unknownFixture from "./fixtures/coderabbit-unknown.json";

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

  it("supports local, pr, and metrics-import modes", () => {
    const provider = new CodeRabbitQcProvider();

    expect(provider.supportedModes).toContain("local");
    expect(provider.supportedModes).toContain("pr");
    expect(provider.supportedModes).toContain("metrics-import");
  });

  it("builds a PR review command when prUrl is provided", () => {
    const provider = new CodeRabbitQcProvider();
    const command = provider.buildReviewCommand({
      clusterId: "POL-470",
      runId: "polaris-run-pol-470",
      prUrl: "https://github.com/org/repo/pull/1",
    });

    expect(command.command).toBe("coderabbit");
    expect(command.args).toEqual(["review", "--agent", "--pr-url", "https://github.com/org/repo/pull/1"]);
  });

  it("builds a local review command when branch is provided", () => {
    const provider = new CodeRabbitQcProvider();
    const command = provider.buildReviewCommand({
      clusterId: "POL-470",
      runId: "polaris-run-pol-470",
      branch: "feature-branch",
    });

    expect(command.command).toBe("coderabbit");
    expect(command.args).toEqual(["review", "--agent", "--branch", "feature-branch"]);
  });

  it("parses raw output into a passed result without findings", () => {
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

  it("imports metrics into a passed result when no findings are present", () => {
    const provider = new CodeRabbitQcProvider();
    const result = provider.importMetrics({
      provider: "coderabbit",
      format: "coderabbit",
      data: {},
    });

    expect(result.providerMode).toBe("metrics-import");
    expect(result.status).toBe("passed");
    expect(result.findings).toHaveLength(0);
  });

  it("parses a full CodeRabbit report into normalized findings", () => {
    const provider = new CodeRabbitQcProvider();
    const result = provider.importMetrics({
      provider: "coderabbit",
      format: "coderabbit",
      data: fullFixture,
    });

    expect(result.findings).toHaveLength(3);
    expect(result.status).toBe("blocked");
    expect(result.prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(result.policyDecision.blocksDelivery).toBe(true);
    expect(result.policyDecision.requiresOperatorReview).toBe(true);

    const critical = result.findings.find((f) => f.providerFindingId === "cr-finding-1");
    expect(critical).toBeDefined();
    expect(critical!.severity).toBe("critical");
    expect(critical!.category).toBe("security");
    expect(critical!.filePath).toBe("src/auth/token.ts");
    expect(critical!.range).toEqual({ startLine: 42, endLine: 48, startColumn: 10, endColumn: 35 });
    expect(critical!.fixAvailable).toBe(true);
    expect(critical!.confidence).toBe(0.95);

    const partial = result.findings.find((f) => f.providerFindingId === "cr-finding-2");
    expect(partial).toBeDefined();
    expect(partial!.severity).toBe("medium");
    expect(partial!.autofixEligible).toBe(false);
  });

  it("normalizes partial findings without discarding them", () => {
    const provider = new CodeRabbitQcProvider();
    const result = provider.importMetrics({
      provider: "coderabbit",
      format: "coderabbit",
      data: partialFixture,
    });

    expect(result.findings).toHaveLength(2);
    const withFile = result.findings.find((f) => f.severity === "high");
    expect(withFile?.filePath).toBe("src/db/connection.ts");
    expect(withFile?.range).toEqual({ startLine: 15 });

    const withoutFile = result.findings.find((f) => f.severity === "info");
    expect(withoutFile?.title).toBe("Finding #2");
    expect(withoutFile?.category).toBeUndefined();
  });

  it("falls back to info for unknown provider severity labels", () => {
    const provider = new CodeRabbitQcProvider();
    const result = provider.importMetrics({
      provider: "coderabbit",
      format: "coderabbit",
      data: unknownFixture,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("info");
    expect(result.status).toBe("passed");
  });

  it("derives findings status from the highest severity across all findings", () => {
    const provider = new CodeRabbitQcProvider();
    const result = provider.parse({
      provider: "coderabbit",
      exitCode: 0,
      stdout: [
        JSON.stringify({ severity: "low", file: "src/a.ts", line: 1, title: "Issue A" }),
        JSON.stringify({ severity: "high", file: "src/b.ts", line: 2, title: "Issue B" }),
      ].join("\n"),
    });

    expect(result.status).toBe("findings");
  });

  it("handles malformed stdout without throwing", () => {
    const provider = new CodeRabbitQcProvider();
    const result = provider.parse({
      provider: "coderabbit",
      exitCode: 1,
      stdout: "not-json{",
      stderr: "provider error",
    });

    expect(result.findings).toHaveLength(0);
    expect(result.status).toBe("failed");
  });

  it("parses JSONL stdout into findings", () => {
    const provider = new CodeRabbitQcProvider();
    const result = provider.parse({
      provider: "coderabbit",
      exitCode: 0,
      stdout: [
        JSON.stringify({ severity: "high", file: "src/a.ts", line: 1, title: "Issue A" }),
        JSON.stringify({ severity: "low", file: "src/b.ts", line: 2, title: "Issue B" }),
      ].join("\n"),
    });

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].severity).toBe("high");
    expect(result.findings[1].severity).toBe("low");
  });
});
