import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptions,
} from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IQcProvider, QcReviewScope } from "./provider.js";
import { QcProviderRegistry } from "./provider.js";
import { executeQcProvider } from "./runner.js";
import { CodeRabbitQcProvider } from "./providers/coderabbit.js";
import type { QcConfig, QcProviderConfig } from "../config/schema.js";

function loadFixtureText(name: string): string {
  return readFileSync(join("src/qc/fixtures", name), "utf-8");
}

const FIXTURES = {
  rateLimited: "Rate limit exceeded: 429 Too Many Requests",
  authFailure: "Authentication failed: 401 Unauthorized",
  unavailableProvider: "Error: connect ECONNREFUSED 503 Service Unavailable",
};

type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => ChildProcess;

function makeProvider(
  overrides: Partial<IQcProvider> & { parseError?: boolean } = {},
): IQcProvider {
  return {
    name: "test",
    supportedModes: ["local"],
    capabilities: ["diff-review"],
    canReview: () => true,
    buildReviewCommand: () => ({ command: "echo", args: ["ok"] }),
    parse: () => {
      if (overrides.parseError) {
        throw new Error("bad parse");
      }
      throw new Error("unexpected parse");
    },
    importMetrics: () => {
      throw new Error("unused");
    },
    ...overrides,
  };
}

function makeExecFileImpl(stdout: string, stderr: string, exitCode: number): ExecFileImpl {
  return (_file, _args, _options, callback) => {
    callback(
      exitCode === 0 ? null : ({ code: exitCode } as ExecFileException),
      stdout,
      stderr,
    );
    return {} as ChildProcess;
  };
}

function makeQcConfig(
  providerOverrides?: Partial<QcProviderConfig>,
): QcConfig {
  const providerName = providerOverrides?.name ?? "test";
  return {
    enabled: true,
    defaultTrigger: "completed-cluster",
    providers: {
      [providerName]: {
        name: providerName,
        mode: "local",
        ...providerOverrides,
      } as QcProviderConfig,
    },
    severityThresholds: { block: "high", repair: "medium", followUp: "low" },
    autoFix: "disabled",
    repairRouting: "route",
    artifactRetention: { retainRawOutput: false, maxRuns: 10 },
    routes: {},
  };
}

describe("executeQcProvider", () => {
  it("converts parser exceptions into synthetic failed results", async () => {
    const provider = makeProvider({ parseError: true });
    const result = await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl("not-json{", "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("parse-failed");
    expect(result.policyDecision.summary).toContain("parse-failed");
  });

  it("classifies a timeout as a timeout failure", async () => {
    const execFileImpl: ExecFileImpl = (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
      callback(error as ExecFileException, "", "");
      return {} as ChildProcess;
    };

    const result = await executeQcProvider(
      makeProvider(),
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: execFileImpl as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("timeout");
  });

  it("classifies a missing command as command-not-found", async () => {
    const execFileImpl: ExecFileImpl = (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      callback(error as ExecFileException, "", "");
      return {} as ChildProcess;
    };

    const result = await executeQcProvider(
      makeProvider(),
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: execFileImpl as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("command-not-found");
  });

  it("classifies rate-limited stderr", async () => {
    const result = await executeQcProvider(
      makeProvider(),
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl("", FIXTURES.rateLimited, 1) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("rate-limited");
  });

  it("classifies auth-failure stderr", async () => {
    const result = await executeQcProvider(
      makeProvider(),
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl("", FIXTURES.authFailure, 1) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("auth-failure");
  });

  it("classifies unavailable-provider stderr", async () => {
    const result = await executeQcProvider(
      makeProvider(),
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl("", FIXTURES.unavailableProvider, 1) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("unavailable-provider");
  });

  it("classifies empty output with nonzero exit as empty-output", async () => {
    const result = await executeQcProvider(
      makeProvider(),
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl("", "", 1) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("empty-output");
  });

  it("classifies unsupported mode before executing", async () => {
    const provider = makeProvider({ supportedModes: ["pr"] });
    const result = await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl("", "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("unsupported-mode");
  });

  it("returns a passed result with providerAttempt on valid empty output", async () => {
    const provider = makeProvider({
      parse: () => {
        throw new Error("should not be called");
      },
    });
    const result = await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl("", "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("passed");
    expect(result.providerAttempt?.status).toBe("success");
    expect(result.providerAttempt?.rawOutputRetained).toBe(false);
  });

  it("does not misclassify successful runs with failure keywords in output", async () => {
    const provider = makeProvider({
      parse: () => ({
        schemaVersion: "1.0",
        qcRunId: "test-1",
        runId: "unknown",
        clusterId: "unknown",
        trigger: "completed-cluster" as const,
        provider: "test",
        providerMode: "local" as const,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "passed" as const,
        findings: [],
        rawArtifactPaths: [],
        parserVersion: "test-1.0",
        policyDecision: {
          blocksDelivery: false,
          requiresOperatorReview: false,
          routedToRepair: false,
          summary: "no findings",
        },
      }),
    });
    const result = await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl("Success! (no 401 unauthorized or 429 rate limit errors)", "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("passed");
    expect(result.providerAttempt?.status).toBe("success");
    expect(result.providerAttempt?.failureReason).toBeUndefined();
  });

  it("returns normalized findings from a successful provider run", async () => {
    const provider = makeProvider({
      parse: () => ({
        schemaVersion: "1.0",
        qcRunId: "test-1",
        runId: "unknown",
        clusterId: "unknown",
        trigger: "completed-cluster",
        provider: "test",
        providerMode: "local",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "findings" as const,
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
        rawArtifactPaths: [],
        parserVersion: "test-1.0",
        policyDecision: {
          blocksDelivery: false,
          requiresOperatorReview: true,
          routedToRepair: false,
          summary: "findings",
        },
      }),
    });

    const result = await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl(JSON.stringify({ finding: "x" }), "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.providerAttempt?.status).toBe("success");
  });

  it("emits telemetry events to the configured file", async () => {
    const telemetryDir = mkdtempSync(join(tmpdir(), "polaris-qc-runner-"));
    const telemetryFile = join(telemetryDir, "telemetry.jsonl");

    await executeQcProvider(
      makeProvider({ parseError: true }),
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        telemetryFile,
        execFileImpl: makeExecFileImpl("not-json{", "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    const lines = readFileSync(telemetryFile, "utf-8").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((e) => e.event === "qc-provider-attempted")).toBe(true);
    expect(events.some((e) => e.event === "qc-provider-failed" && e.reason === "parse-failed")).toBe(true);
  });

  it("falls back to a configured fallback provider on failure", async () => {
    const primary = makeProvider({
      name: "primary",
      parse: () => {
        throw new Error("bad parse");
      },
    });
    const fallback = makeProvider({
      name: "fallback",
      parse: () => ({
        schemaVersion: "1.0",
        qcRunId: "fallback-1",
        runId: "unknown",
        clusterId: "unknown",
        trigger: "completed-cluster",
        provider: "fallback",
        providerMode: "local",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "passed" as const,
        findings: [],
        rawArtifactPaths: [],
        parserVersion: "fallback-1.0",
        policyDecision: {
          blocksDelivery: false,
          requiresOperatorReview: false,
          routedToRepair: false,
          summary: "fallback ok",
        },
      }),
    });

    const registry = new QcProviderRegistry();
    registry.register(primary);
    registry.register(fallback);

    const config = makeQcConfig({
      name: "primary",
      mode: "local",
      fallback: ["fallback"],
      failurePolicy: { timeout: "fail", parseFailure: "fallback", allProvidersFailed: "block" },
    });

    const result = await executeQcProvider(
      primary,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        config,
        registry,
        execFileImpl: makeExecFileImpl("not-json{", "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("passed");
    expect(result.provider).toBe("fallback");
    expect(result.providerAttempt?.fallbackSource).toBe("primary");
  });

  it("emits all-providers-failed when fallback chain exhausts", async () => {
    const telemetryDir = mkdtempSync(join(tmpdir(), "polaris-qc-runner-"));
    const telemetryFile = join(telemetryDir, "telemetry.jsonl");
    const primary = makeProvider({
      name: "primary",
      parse: () => {
        throw new Error("bad parse");
      },
    });
    const fallback = makeProvider({
      name: "fallback",
      parse: () => {
        throw new Error("also bad");
      },
    });

    const registry = new QcProviderRegistry();
    registry.register(primary);
    registry.register(fallback);

    const config = makeQcConfig({
      name: "primary",
      mode: "local",
      fallback: ["fallback"],
      failurePolicy: { timeout: "fail", parseFailure: "fallback", allProvidersFailed: "block" },
    });

    const result = await executeQcProvider(
      primary,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        telemetryFile,
        config,
        registry,
        execFileImpl: makeExecFileImpl("not-json{", "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.allProvidersFailed).toBe(true);
    expect(result.policyDecision.blocksDelivery).toBe(true);

    const lines = readFileSync(telemetryFile, "utf-8").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((e) => e.event === "qc-fallback-attempted")).toBe(true);
    expect(events.some((e) => e.event === "qc-all-providers-failed")).toBe(true);
  });

  it("classifies progress-only CodeRabbit output as unusable-output", async () => {
    const provider = new CodeRabbitQcProvider();
    const result = await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl(loadFixtureText("coderabbit-progress-only.jsonl"), "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("unusable-output");
    expect(result.providerAttempt?.parserResult).toBe("failed");
  });

  it("classifies status-only CodeRabbit JSONL as unusable-output", async () => {
    const provider = new CodeRabbitQcProvider();
    const result = await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl(loadFixtureText("coderabbit-status-only.jsonl"), "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("unusable-output");
    expect(result.findings).toHaveLength(0);
  });

  it("classifies nonzero exit with empty findings as nonzero-exit", async () => {
    const provider = new CodeRabbitQcProvider();
    const result = await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: makeExecFileImpl(loadFixtureText("coderabbit-empty-findings.json"), "", 1) as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.providerAttempt?.failureReason).toBe("nonzero-exit");
  });

  it("emits unusable-output telemetry for progress-only CodeRabbit output", async () => {
    const telemetryDir = mkdtempSync(join(tmpdir(), "polaris-qc-runner-"));
    const telemetryFile = join(telemetryDir, "telemetry.jsonl");
    const provider = new CodeRabbitQcProvider();

    await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        telemetryFile,
        execFileImpl: makeExecFileImpl(loadFixtureText("coderabbit-progress-only.jsonl"), "", 0) as unknown as typeof import("node:child_process").execFile,
      },
    );

    const lines = readFileSync(telemetryFile, "utf-8").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((e) => e.event === "qc-provider-attempted")).toBe(true);
    expect(events.some((e) => e.event === "qc-provider-failed" && e.reason === "unusable-output")).toBe(true);
  });
});
