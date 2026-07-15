import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { IQcProvider } from "./provider.js";
import type { QcReviewScope, QcProviderOutput, QcMetricsPayload } from "./provider.js";
import type { QcResult } from "./types.js";
import { QcProviderRegistry } from "./provider.js";
import { runQcAtTrigger } from "./orchestration.js";
import type { QcConfig } from "../config/schema.js";

function makeProvider(result: Partial<QcResult> = {}): IQcProvider {
  return {
    name: "test",
    supportedModes: ["local", "pr"] as const,
    capabilities: ["diff-review"] as const,
    canReview: () => true,
    buildReviewCommand: (scope: QcReviewScope) => ({
      command: scope.prUrl ? "echo" : "echo",
      args: scope.prUrl ? [scope.prUrl] : ["local"],
    }),
    parse: (): QcResult => ({
      schemaVersion: "1.0",
      qcRunId: "test-1",
      runId: "run-1",
      clusterId: "POL-1",
      trigger: "completed-cluster",
      provider: "test",
      providerMode: "local",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "passed",
      findings: [],
      rawArtifactPaths: [],
      parserVersion: "test-1.0",
      policyDecision: {
        blocksDelivery: false,
        requiresOperatorReview: false,
        routedToRepair: false,
        summary: "ok",
      },
      ...result,
    }),
    importMetrics: (payload: QcMetricsPayload): QcResult => ({
      schemaVersion: "1.0",
      qcRunId: "test-metrics-1",
      runId: "run-1",
      clusterId: "POL-1",
      trigger: "completed-cluster",
      provider: payload.provider,
      providerMode: "metrics-import",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "passed",
      findings: [],
      rawArtifactPaths: [],
      parserVersion: "test-1.0",
      policyDecision: {
        blocksDelivery: false,
        requiresOperatorReview: false,
        routedToRepair: false,
        summary: "ok",
      },
    }),
  };
}

function makeConfig(overrides?: Partial<QcConfig>): QcConfig {
  return {
    enabled: true,
    defaultTrigger: "completed-cluster",
    providers: {
      test: { name: "test", mode: "local" },
    },
    severityThresholds: { block: "high", repair: "medium", followUp: "low" },
    autoFix: "disabled",
    repairRouting: "route",
    artifactRetention: { retainRawOutput: false, maxRuns: 10 },
    routes: {},
    ...overrides,
  } as QcConfig;
}

function writeClusterState(dir: string, clusterId: string): void {
  const clusterDir = join(dir, ".polaris", "clusters", clusterId);
  mkdirSync(clusterDir, { recursive: true });
  writeFileSync(
    join(clusterDir, "cluster-state.json"),
    JSON.stringify({
      schema_version: "1.0",
      cluster_id: clusterId,
      state_generation: 1,
      child_states: [],
      claim_metadata: {},
      packet_pointers: {},
      result_pointers: {},
      validation_results: {},
      commits: {},
      tracker_mutations: {},
      blockers: [],
      qc_runs: {},
    }),
  );
}

describe("runQcAtTrigger", () => {
  let testDir: string;
  let registry: QcProviderRegistry;

  beforeEach(() => {
    testDir = join(tmpdir(), `polaris-qc-orchestration-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    writeClusterState(testDir, "POL-1");
    registry = new QcProviderRegistry();
    registry.register(makeProvider());
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("passes with no providers when QC is disabled", async () => {
    const result = await runQcAtTrigger({
      config: makeConfig({ enabled: false }),
      registry,
      trigger: "completed-cluster",
      repoRoot: testDir,
      runId: "run-1",
      clusterId: "POL-1",
      branch: "main",
    });
    expect(result.action).toBe("pass");
    expect(result.results).toHaveLength(0);
    expect(result.summary).toContain("disabled");
  });

  it("passes passively when repairRouting is log", async () => {
    const failingProvider = makeProvider({
      status: "findings",
      findings: [
        {
          findingId: "f-1",
          severity: "high",
          title: "Issue",
          fixAvailable: false,
          autofixEligible: false,
          attribution: { confidence: "unattributed", reason: "provider-uncertain" },
          status: "open",
        },
      ],
      policyDecision: {
        blocksDelivery: false,
        requiresOperatorReview: true,
        routedToRepair: true,
        summary: "issues found",
      },
    });
    registry = new QcProviderRegistry();
    registry.register(failingProvider);

    const result = await runQcAtTrigger({
      config: makeConfig({ repairRouting: "log" }),
      registry,
      trigger: "completed-cluster",
      repoRoot: testDir,
      runId: "run-1",
      clusterId: "POL-1",
      branch: "main",
    });
    expect(result.action).toBe("pass");
    expect(result.summary).toContain("findings");
  });

  it("blocks when repairRouting is block and findings exist", async () => {
    const failingProvider = makeProvider({
      status: "findings",
      findings: [
        {
          findingId: "f-1",
          severity: "high",
          title: "Issue",
          fixAvailable: false,
          autofixEligible: false,
          attribution: { confidence: "unattributed", reason: "provider-uncertain" },
          status: "open",
        },
      ],
    });
    registry = new QcProviderRegistry();
    registry.register(failingProvider);

    const result = await runQcAtTrigger({
      config: makeConfig({ repairRouting: "block" }),
      registry,
      trigger: "completed-cluster",
      repoRoot: testDir,
      runId: "run-1",
      clusterId: "POL-1",
      branch: "main",
    });
    expect(result.action).toBe("block");
  });

  it("routes to follow-up when repairRouting is route", async () => {
    const failingProvider = makeProvider({
      status: "findings",
      findings: [
        {
          findingId: "f-1",
          severity: "medium",
          title: "Issue",
          fixAvailable: false,
          autofixEligible: false,
          attribution: { confidence: "unattributed", reason: "provider-uncertain" },
          status: "open",
        },
      ],
    });
    registry = new QcProviderRegistry();
    registry.register(failingProvider);

    const result = await runQcAtTrigger({
      config: makeConfig({ repairRouting: "route" }),
      registry,
      trigger: "completed-cluster",
      repoRoot: testDir,
      runId: "run-1",
      clusterId: "POL-1",
      branch: "main",
    });
    expect(result.action).toBe("follow-up");
  });

  it("produces a failed result on provider timeout", async () => {
    const slowProvider: IQcProvider = {
      ...makeProvider(),
      buildReviewCommand: () => ({ command: "sleep", args: ["10"] }),
    };
    registry = new QcProviderRegistry();
    registry.register(slowProvider);

    const result = await runQcAtTrigger({
      config: makeConfig(),
      registry,
      trigger: "completed-cluster",
      repoRoot: testDir,
      runId: "run-1",
      clusterId: "POL-1",
      branch: "main",
      timeoutMs: 50,
    });
    expect(result.results[0]!.status).toBe("failed");
    expect(result.results[0]!.policyDecision.requiresOperatorReview).toBe(true);
  });

  it("blocks when no providers run successfully", async () => {
    const failingProvider = makeProvider({
      status: "failed",
      policyDecision: {
        blocksDelivery: false,
        requiresOperatorReview: true,
        routedToRepair: false,
        summary: "provider failed",
      },
    });
    registry = new QcProviderRegistry();
    registry.register(failingProvider);

    const result = await runQcAtTrigger({
      config: makeConfig({ repairRouting: "log" }),
      registry,
      trigger: "completed-cluster",
      repoRoot: testDir,
      runId: "run-1",
      clusterId: "POL-1",
      branch: "main",
    });

    expect(result.action).toBe("block");
  });

  it("blocks when a configured provider is missing from the registry", async () => {
    registry = new QcProviderRegistry();
    const result = await runQcAtTrigger({
      config: makeConfig(),
      registry,
      trigger: "completed-cluster",
      repoRoot: testDir,
      runId: "run-1",
      clusterId: "POL-1",
      branch: "main",
    });

    expect(result.action).toBe("block");
    expect(result.summary).toContain('Unknown QC provider "test"');
  });

  it("runs the pr trigger with a PR URL", async () => {
    let capturedUrl: string | undefined;
    const prProvider: IQcProvider = {
      ...makeProvider({
        providerMode: "pr",
        trigger: "pr",
      }),
      buildReviewCommand: (scope: QcReviewScope) => {
        capturedUrl = scope.prUrl;
        return { command: "echo", args: [scope.prUrl ?? "none"] };
      },
    };
    registry = new QcProviderRegistry();
    registry.register(prProvider);

    const result = await runQcAtTrigger({
      config: makeConfig({
        providers: { test: { name: "test", mode: "pr", trigger: "pr" } },
      }),
      registry,
      trigger: "pr",
      prUrl: "https://github.com/org/repo/pull/42",
      repoRoot: testDir,
      runId: "run-1",
      clusterId: "POL-1",
      branch: "main",
    });
    expect(result.action).toBe("pass");
    expect(capturedUrl).toBe("https://github.com/org/repo/pull/42");
    expect(result.results[0]!.trigger).toBe("pr");
  });

  it("captures the current HEAD as headSha", async () => {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: testDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: testDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir, stdio: "pipe" });
    writeFileSync(join(testDir, "README.md"), "test\n");
    execFileSync("git", ["add", "."], { cwd: testDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: testDir, stdio: "pipe" });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: testDir,
      encoding: "utf-8",
    }).trim();

    const result = await runQcAtTrigger({
      config: makeConfig(),
      registry,
      trigger: "completed-cluster",
      repoRoot: testDir,
      runId: "run-1",
      clusterId: "POL-1",
      branch: "main",
    });

    expect(result.action).toBe("pass");
    expect(result.results[0]?.headSha).toBe(headSha);
  });
});
