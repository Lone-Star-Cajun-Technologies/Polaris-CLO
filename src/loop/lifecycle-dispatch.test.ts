import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dispatchLifecyclePhase,
  resolveLifecycleProvider,
  type LifecycleDispatchAdapter,
} from "./lifecycle-dispatch.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult } from "./adapters/types.js";
import type { PolarisConfig } from "../config/schema.js";

function makeDir(): string {
  const dir = join(tmpdir(), `polaris-lifecycle-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseConfig(): Required<PolarisConfig> {
  return {
    version: "1.0",
    repo: {
      name: "",
      sourceRoots: ["src"],
      docsRoots: [],
      taskchainRoots: [],
      generatedRoots: [],
      sidecarOutputPath: ".polaris/map",
    },
    map: {
      confidenceThreshold: 0.75,
      autoWriteAbove: 0.85,
      reviewRequiredBelow: 0.75,
      inferenceRules: [],
      onLowConfidence: "warn",
    },
    loop: {
      bootstrapOutputPath: ".polaris/bootstrap",
      analyzeImplBoundaryEnforced: true,
      sessionTerminationMode: "emit-marker",
      allowBranchDivergence: false,
    },
    orchestration: {
      mode: "auto",
      auto_finalize: false,
      notification_format: "terse",
    },
    execution: {
      adapter: "terminal-cli",
      providers: {
        worker: { command: "worker-cli" },
        startup: { command: "startup-cli" },
        finalizer: { command: "finalizer-cli" },
      },
      rotation: ["worker"],
      allowCrossAgentFallback: false,
      roles: {
        worker: { provider: "worker" },
        startup: { provider: "startup", model: "gpt-startup" },
        finalizer: { provider: "finalizer", model: "gpt-finalizer" },
      },
    },
    finalize: {
      targetBranch: "main",
      prDraft: true,
      runChecks: [],
      requireMapValidation: true,
      requireSchemaValidation: true,
      archiveRunSnapshot: true,
    },
    tracker: {
      linear: {
        enabled: false,
        teamId: "",
        projectId: "",
      },
    },
    integrations: {
      github: {
        owner: "",
        repo: "",
      },
    },
    canon: {
      checkOnContinue: true,
      checkOnFinalize: true,
    },
    providers: {
      repoAnalysis: {
        preferred: undefined,
        fallback: ["polaris-map", "ripgrep"],
      },
      compactionProviders: [],
    },
    budget: {
      mode: "fixed-cap",
      max_children: 3,
      stop_on_fail: false,
      allow_analyze_children: false,
    },
    compact: {
      orchestratorMode: "standard",
      workerMode: "standard",
      level: "standard",
    },
    skill_packet: {
      analysis_confidence_threshold: 85,
      auto_deep_analysis: false,
      allow_cross_provider_delegation: false,
    },
  };
}

function makeAdapter(writeResult: (packet: BootstrapPacket) => unknown): LifecycleDispatchAdapter {
  return {
    name: "mock",
    async dispatch(packet: BootstrapPacket, options: DispatchOptions): Promise<DispatchResult> {
      const resultFile = (packet as { result_file_contract?: { result_file: string } }).result_file_contract?.result_file;
      const result = writeResult(packet);
      if (resultFile && result !== undefined) {
        writeFileSync(resultFile, typeof result === "string" ? result : JSON.stringify(result, null, 2));
      }
      return {
        exit_code: 0,
        provider_used: options.provider,
        command_run: `mock:${options.provider}`,
        summary: JSON.stringify({ status: "done" }),
      };
    },
  };
}

describe("resolveLifecycleProvider", () => {
  it("selects role-specific provider and model before default worker rotation", () => {
    const resolved = resolveLifecycleProvider(baseConfig(), "startup");
    expect(resolved).toEqual({
      adapter: "terminal-cli",
      provider: "startup",
      model: "gpt-startup",
    });
  });
});

describe("dispatchLifecyclePhase", () => {
  it("executes startup as a sealed dispatch phase and records role telemetry", async () => {
    const dir = makeDir();
    try {
      const telemetryFile = join(dir, "telemetry.jsonl");
      const result = await dispatchLifecyclePhase({
        phase: "startup",
        runId: "run-1",
        clusterId: "POL-188",
        branch: "polaris/POL-188",
        stateFile: join(dir, "current-state.json"),
        telemetryFile,
        config: baseConfig(),
        adapter: makeAdapter((packet) => ({
          run_id: packet.run_id,
          role: "startup",
          status: "success",
          execution_plan: ["POL-198"],
          first_child: "POL-198",
        })),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.role).toBe("startup");
        expect(result.provider).toBe("startup");
        expect(result.result.first_child).toBe("POL-198");
      }
      const telemetry = readFileSync(telemetryFile, "utf-8");
      expect(telemetry).toContain("\"event\":\"lifecycle-dispatched\"");
      expect(telemetry).toContain("\"role\":\"startup\"");
      expect(telemetry).toContain("\"event\":\"lifecycle-result-accepted\"");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes finalization as a sealed dispatch phase", async () => {
    const dir = makeDir();
    try {
      const result = await dispatchLifecyclePhase({
        phase: "finalize",
        runId: "run-1",
        clusterId: "POL-188",
        branch: "polaris/POL-188",
        stateFile: join(dir, "current-state.json"),
        telemetryFile: join(dir, "telemetry.jsonl"),
        config: baseConfig(),
        adapter: makeAdapter((packet) => ({
          run_id: packet.run_id,
          role: "finalize",
          status: "success",
          branch_validated: true,
          commits_validated: true,
          tests_validated: true,
          tracker_reconciliation_ready: true,
        })),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.role).toBe("finalize");
        expect(result.provider).toBe("finalizer");
        expect(result.result.tracker_reconciliation_ready).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("halts safely when the sealed result file is missing", async () => {
    const dir = makeDir();
    try {
      const result = await dispatchLifecyclePhase({
        phase: "finalize",
        runId: "run-1",
        clusterId: "POL-188",
        branch: "polaris/POL-188",
        stateFile: join(dir, "current-state.json"),
        telemetryFile: join(dir, "telemetry.jsonl"),
        config: baseConfig(),
        adapter: makeAdapter(() => undefined),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("missing_result");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("halts safely on malformed sealed result JSON", async () => {
    const dir = makeDir();
    try {
      const result = await dispatchLifecyclePhase({
        phase: "startup",
        runId: "run-1",
        clusterId: "POL-188",
        branch: "polaris/POL-188",
        stateFile: join(dir, "current-state.json"),
        telemetryFile: join(dir, "telemetry.jsonl"),
        config: baseConfig(),
        adapter: makeAdapter(() => "{not json"),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("malformed_result");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("halts safely on mismatched result role", async () => {
    const dir = makeDir();
    try {
      const result = await dispatchLifecyclePhase({
        phase: "startup",
        runId: "run-1",
        clusterId: "POL-188",
        branch: "polaris/POL-188",
        stateFile: join(dir, "current-state.json"),
        telemetryFile: join(dir, "telemetry.jsonl"),
        config: baseConfig(),
        adapter: makeAdapter((packet) => ({
          run_id: packet.run_id,
          role: "finalize",
          status: "success",
        })),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("mismatched_result");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
