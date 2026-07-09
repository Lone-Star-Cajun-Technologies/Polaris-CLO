/**
 * Unit tests for the scheduler-only parent loop (src/loop/parent.ts).
 *
 * Uses a mock adapter that returns valid compact JSON; verifies that:
 * - The parent loops N times then halts at budget exhaustion.
 * - Each iteration dispatches exactly one child (no inline child work).
 * - ADAPTER HANDOFF semantics: dispatch + continue, not halt.
 * - Blocked children halt immediately with a clear blocker description.
 * - Cluster-complete halts cleanly when all children are done.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runParentLoop } from "./parent.js";
import { createLoopCommand } from "./index.js";
import { createBootstrapSeal } from "./run-bootstrap.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./adapters/types.js";
import { isWorkerPacket } from "./worker-packet.js";
import type { Command } from "commander";

// ── Mock adapter factory ─────────────────────────────────────────────────────

interface MockCall {
  packet: BootstrapPacket;
  options: DispatchOptions;
}

function makeMockAdapter(
  responses: DispatchResult[],
  calls: MockCall[] = [],
): ExecutionAdapter {
  let callIndex = 0;
  return {
    name: "mock",
    async dispatch(packet, options) {
      calls.push({ packet, options });
      const base = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex += 1;
      let parsedSummary: Record<string, unknown> | undefined;
      // Rewrite child_id in the summary to match the dispatched child so the
      // parent loop's mismatch guard doesn't reject a valid mock result.
      try {
        parsedSummary = JSON.parse(base.summary ?? "{}") as Record<string, unknown>;
        if ("child_id" in parsedSummary) {
          parsedSummary = { ...parsedSummary, child_id: packet.active_child };
        }
      } catch {
        // Summary is not JSON — leave as-is
      }

      const resultFile = isWorkerPacket(packet) ? packet.result_file_contract?.result_file : undefined;
      if (resultFile) {
        mkdirSync(dirname(resultFile), { recursive: true });
        const sealedResult =
          parsedSummary ??
          ({
            child_id: packet.active_child,
            status: base.exit_code === 0 ? "done" : "failed",
            error: base.summary,
          } satisfies Record<string, unknown>);
        writeFileSync(resultFile, JSON.stringify(sealedResult, null, 2), "utf-8");
      }

      return parsedSummary ? { ...base, summary: JSON.stringify(parsedSummary) } : base;
    },
  };
}

// ── Test fixtures ────────────────────────────────────────────────────────────

const SUCCESS_RESULT: DispatchResult = {
  exit_code: 0,
  provider_used: "mock",
  command_run: "mock-worker",
  summary: JSON.stringify({ child_id: "POL-99", status: "done", commit: "abc1234" }),
};

const BLOCKED_RESULT: DispatchResult = {
  exit_code: 0,
  provider_used: "mock",
  command_run: "mock-worker",
  summary: JSON.stringify({
    child_id: "POL-99",
    status: "blocked",
    blocker: "Waiting for POL-98 to merge",
  }),
};

const ERROR_RESULT: DispatchResult = {
  exit_code: 1,
  provider_used: "mock",
  command_run: "mock-worker",
  summary: "Worker process exited with code 1",
};

const SUCCESS_RESULT_NO_COMMIT: DispatchResult = {
  exit_code: 0,
  provider_used: "mock",
  command_run: "mock-worker",
  summary: JSON.stringify({ child_id: "POL-99", status: "done" }),
};

const SUCCESS_RESULT_WITH_MODEL: DispatchResult = {
  exit_code: 0,
  provider_used: "mock",
  command_run: "mock-worker",
  summary: JSON.stringify({
    child_id: "POL-99",
    status: "done",
    commit: "abc1234",
    provider_used: "mock",
    model: "gpt-5.3-codex",
    validation: "build: pass",
  }),
};

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeStateFile(
  dir: string,
  overrides: Partial<{
    open_children: string[];
    completed_children: string[];
    children_completed: number;
    max_children_per_session: number;
  }> = {},
): string {
  const stateFile = join(dir, "current-state.json");
  const openChildren = overrides.open_children ?? ["POL-100", "POL-101", "POL-102"];
  const completedChildren = overrides.completed_children ?? [];
  const state = {
    schema_version: "1.0",
    run_id: "test-run-001",
    cluster_id: "POL-99",
    skill: "polaris-run",
    artifact_dir: dir,
    branch: "feature/test",
    current_step_id: "03-execute-child",
    step_cursor: "dispatching",
    status: "executing",
    session_type: "implementation",
    active_child: "",
    last_commit: "",
    next_open_child: openChildren[0] ?? null,
    completed_children: completedChildren,
    open_children: openChildren,
    open_children_meta: Object.fromEntries(openChildren.map((id) => [id, { title: id, body: `## Goal\nDefault test body for ${id}.\n\n## Scope\n- src/**\n` }])),
    context_budget: {
      children_completed: overrides.children_completed ?? 0,
      files_touched_total: 0,
      max_children_per_session: overrides.max_children_per_session ?? 3,
    },
    dispatch_boundary: { dispatch_epoch: 0, continue_epoch: 0, last_dispatched_child: null },
    run_bootstrap_seal: createBootstrapSeal("test-run-001", "POL-99", openChildren),
    updated_at: new Date().toISOString(),
  };
  makeClusterStateFile(dir, "POL-99", [...new Set([...openChildren, ...completedChildren])]);
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
  return stateFile;
}

function makeClusterStateFile(
  dir: string,
  clusterId: string,
  childIds: string[],
): string {
  const clusterDir = join(dir, ".polaris", "clusters", clusterId);
  mkdirSync(clusterDir, { recursive: true });
  const clusterStateFile = join(clusterDir, "cluster-state.json");
  writeFileSync(
    clusterStateFile,
    JSON.stringify(
      {
        schema_version: "1.0",
        cluster_id: clusterId,
        state_generation: 1,
        child_states: childIds.map((id) => ({ id, status: "ready" })),
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
  return clusterStateFile;
}

function makeStateFileWithMeta(
  dir: string,
  openChildren: string[],
  meta: Record<string, { type?: string; title?: string; body?: string; labels?: string[] }>,
  maxChildren: number = 10,
): string {
  const stateFile = join(dir, "current-state.json");
  makeClusterStateFile(dir, "POL-99", openChildren);
  const state = {
    schema_version: "1.0",
    run_id: "test-run-001",
    cluster_id: "POL-99",
    skill: "polaris-run",
    artifact_dir: dir,
    branch: "feature/test",
    current_step_id: "03-execute-child",
    step_cursor: "dispatching",
    status: "executing",
    session_type: "implementation",
    active_child: "",
    last_commit: "",
    next_open_child: openChildren[0] ?? null,
    completed_children: [],
    open_children: openChildren,
    open_children_meta: meta,
    context_budget: {
      children_completed: 0,
      files_touched_total: 0,
      max_children_per_session: maxChildren,
    },
    dispatch_boundary: { dispatch_epoch: 0, continue_epoch: 0, last_dispatched_child: null },
    run_bootstrap_seal: createBootstrapSeal("test-run-001", "POL-99", openChildren),
    updated_at: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
  return stateFile;
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function configureCommandForTest(command: Command, output: { stdout: string; stderr: string }): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (value) => {
      output.stdout += value;
    },
    writeErr: (value) => {
      output.stderr += value;
    },
  });
  for (const child of command.commands) {
    configureCommandForTest(child, output);
  }
}

async function runLoopCommand(command: Command, argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const output = { stdout: "", stderr: "" };
  let exitCode = 0;
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  configureCommandForTest(command, output);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: string | number | null | undefined) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error("process.exit called");
  }) as typeof process.exit;

  try {
    await command.parseAsync(["node", "polaris", ...argv], { from: "node" });
  } catch (error) {
    if (
      !(error instanceof Error && "exitCode" in error) &&
      !(error instanceof Error && error.message === "process.exit called")
    ) {
      throw error;
    }
    if (error instanceof Error && "exitCode" in error) {
      exitCode = Number(error.exitCode);
    }
  } finally {
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  return { ...output, exitCode };
}

function createImplementationCommit(dir: string, relativePath: string = "src/self-complete.ts"): string {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Polaris Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "polaris-test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  const absolutePath = join(dir, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, "export const selfComplete = true;\n", "utf-8");
  execFileSync("git", ["add", relativePath], { cwd: dir });
  execFileSync("git", ["commit", "-m", "test commit"], { cwd: dir, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
}

// ── Mock registry so tests can inject a mock adapter ────────────────────────

vi.mock("./adapters/registry.js", () => ({
  createAdapter: vi.fn(),
}));
vi.mock("../config/loader.js", () => ({
  loadConfig: vi.fn(() => ({
    orchestration: {
      mode: "auto",
      notification_format: "verbose",
      auto_finalize: false,
    },
    execution: {
      adapter: "mock",
      providers: { mock: { command: "mock-worker" } },
      rotation: ["mock"],
    },
  })),
}));
vi.mock("../qc/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../qc/index.js")>();
  return {
    ...actual,
    runQcAtTrigger: vi.fn(),
    createQcRegistry: vi.fn(() => ({})),
  };
});
vi.mock("../qc/repair-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../qc/repair-loop.js")>();
  return {
    ...actual,
    runQcRepairLoop: vi.fn(),
  };
});

import { createAdapter } from "./adapters/registry.js";
import { runQcAtTrigger } from "../qc/index.js";
import { runQcRepairLoop } from "../qc/repair-loop.js";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runParentLoop", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `polaris-parent-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "runs", "test-run-001"), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("loops N times then halts at budget exhaustion", async () => {
    // Budget: 3 max children, 0 completed, 3 open children
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT, SUCCESS_RESULT, SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100", "POL-101", "POL-102"],
      children_completed: 0,
      max_children_per_session: 2, // budget of 2, 3 children → exhaust after 2
    });

    const result = await runParentLoop({
      stateFile,
      repoRoot: tmpDir,
    });

    expect(result.haltReason).toBe("budget-exhausted");
    expect(result.childrenDispatched).toBe(2);
    // Adapter dispatched exactly 2 children before budget was exhausted
    expect(calls).toHaveLength(2);
    expect(calls[0].packet.active_child).toBe("POL-100");
    expect(calls[1].packet.active_child).toBe("POL-101");
  });

  it("dispatches each child exactly once (no inline child work)", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT, SUCCESS_RESULT, SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100", "POL-101", "POL-102"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    // All 3 children done, no budget exhaustion
    expect(result.haltReason).toBe("cluster-complete");
    expect(result.childrenDispatched).toBe(3);
    // Each child dispatched exactly once
    const dispatchedIds = calls.map((c) => c.packet.active_child);
    expect(dispatchedIds).toEqual(["POL-100", "POL-101", "POL-102"]);
  });

  it("selects next child by dependency readiness when graph data is available", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT, SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-402", "POL-401"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const clusterDir = join(tmpDir, ".polaris", "clusters", "POL-99");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "clusters.json"),
      JSON.stringify({
        schemaVersion: "v2",
        source: { id: "POL-99", type: "Linear", analysis: { id: "test", doc: "test" } },
        nodes: {
          "POL-99": { id: "POL-99", title: "Cluster root", status: "Todo" },
          "POL-401": { id: "POL-401", title: "First", status: "Todo" },
          "POL-402": { id: "POL-402", title: "Second", status: "Todo" },
        },
        dependencies: {
          "POL-402": ["POL-401"],
        },
        clusters: {
          "POL-99": { id: "POL-99", title: "Cluster", children: ["POL-402", "POL-401"] },
        },
        activeCluster: "POL-99",
      }),
      "utf-8",
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });
    expect(result.haltReason).toBe("cluster-complete");
    expect(calls.map((call) => call.packet.active_child)).toEqual(["POL-401", "POL-402"]);
  });

  it("appends run-started to the global ledger on entry", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    const events = readFileSync(join(tmpDir, ".polaris", "runs", "ledger.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      event: "run-started",
      run_id: "test-run-001",
      run_type: "implement",
      cluster_id: "POL-99",
      issue_id: null,
      branch: "feature/test",
      status: "running",
      completed_children: [],
      open_children: ["POL-100"],
      next_child: "POL-100",
      last_commit: null,
      pr_url: null,
    });
  });

  it("emits bootstrap-context-size telemetry before each dispatch", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT, SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100", "POL-101"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");
    expect(calls).toHaveLength(2);

    const telemetryFile = join(tmpDir, "runs", "test-run-001", "telemetry.jsonl");
    const events = readJsonLines(telemetryFile);
    const contextSizeEvents = events.filter((e) => e.event === "bootstrap-context-size");
    expect(contextSizeEvents).toHaveLength(2);

    const dispatchedChildIds = contextSizeEvents.map((e) => e.child_id);
    expect(dispatchedChildIds).toEqual(["POL-100", "POL-101"]);

    for (const event of contextSizeEvents) {
      expect(event).toMatchObject({
        event: "bootstrap-context-size",
        run_id: "test-run-001",
      });
      expect(typeof event.state_file_bytes).toBe("number");
      expect(typeof event.bootstrap_packet_bytes).toBe("number");
      expect(event.state_file_bytes).toBeGreaterThan(0);
      expect(event.bootstrap_packet_bytes).toBeGreaterThan(0);
      expect(event.state_estimated_tokens).toBe(Math.round((event.state_file_bytes as number) / 4));
      expect(event.bootstrap_estimated_tokens).toBe(Math.round((event.bootstrap_packet_bytes as number) / 4));
      expect(event.combined_estimated_tokens).toBe(
        (event.state_estimated_tokens as number) + (event.bootstrap_estimated_tokens as number),
      );
      expect(typeof event.timestamp).toBe("string");
    }
  });

  it("does not emit bootstrap-context-size telemetry in dry-run mode", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir, dryRun: true });

    expect(result.haltReason).toBe("cluster-complete");
    expect(calls).toHaveLength(1);

    const telemetryFile = join(tmpDir, "runs", "test-run-001", "telemetry.jsonl");
    if (existsSync(telemetryFile)) {
      const events = readJsonLines(telemetryFile);
      expect(events.some((e) => e.event === "bootstrap-context-size")).toBe(false);
    }
  });

  it("ADAPTER HANDOFF: dispatch + continue, not halt", async () => {
    // Verify that after each dispatch the loop continues to the next child
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT, SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100", "POL-101"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    // The loop continued after the first dispatch (ADAPTER HANDOFF = continue)
    expect(result.haltReason).toBe("cluster-complete");
    expect(calls).toHaveLength(2);
  });

  it("halts after one successful child in supervised mode", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT, SUCCESS_RESULT], calls));

    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: {
        mode: "supervised",
        notification_format: "verbose",
        auto_finalize: false,
      },
      execution: {
        adapter: "mock",
        providers: { mock: { command: "mock-worker" } },
        rotation: ["mock"],
      },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100", "POL-101"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("supervised-mode-child-complete");
    expect(result.childrenDispatched).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("continues through eligible children in auto mode", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT, SUCCESS_RESULT], calls));

    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: {
        mode: "auto",
        notification_format: "verbose",
        auto_finalize: false,
      },
      execution: {
        adapter: "mock",
        providers: { mock: { command: "mock-worker" } },
        rotation: ["mock"],
      },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100", "POL-101"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");
    expect(result.childrenDispatched).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("halts immediately when a child reports blocked", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([BLOCKED_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100", "POL-101"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("blocked");
    expect(result.haltingChild).toBe("POL-100");
    expect(result.message).toContain("POL-98 to merge");
  });

  it("halts on worker error with non-zero exit code", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([ERROR_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("worker-error");
    expect(result.haltingChild).toBe("POL-100");
  });

  it("halts cleanly with cluster-complete when all children are done", async () => {
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT]);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");
    expect(result.childrenDispatched).toBe(1);
    expect(result.message).toContain("Cluster complete");
  });

  it("records the full Role Evidence Contract in completed_children_results", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");

    const finalState = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    const completedResults = finalState["completed_children_results"] as Record<string, Record<string, unknown>> | undefined;
    const evidence = completedResults?.["POL-100"];
    expect(evidence).toBeDefined();
    if (!evidence) return;

    expect(evidence["child_id"]).toBe("POL-100");
    expect(evidence["status"]).toBe("done");
    expect(evidence["validation"]).toBe("skipped");
    expect(evidence["commit"]).toBe("abc1234");
    expect(evidence["next_recommended_action"]).toBe("continue");
    expect(evidence["role"]).toBe("worker");
    expect(evidence["provider"]).toBe("mock");
    expect(evidence["cluster_id"]).toBe("POL-99");
    expect(evidence["skill_name"]).toBe("polaris-run");
    expect(typeof evidence["packet_hash"]).toBe("string");
    expect(typeof evidence["worker_id"]).toBe("string");
    expect(evidence["escalation_count"]).toBe(0);
    expect(evidence["heartbeat_count"]).toBe(0);
    expect(typeof evidence["result_artifact_path"]).toBe("string");
    expect(typeof evidence["packet_path"]).toBe("string");
    expect(typeof evidence["telemetry_path"]).toBe("string");
    expect(evidence["user_intervened"]).toBeNull();
    expect(evidence["foreman_intervened"]).toBeNull();
    expect(evidence["dispatch_epoch"]).toBe(1);

    const packetRaw = readFileSync(String(evidence["packet_path"]), "utf-8");
    const expectedHash = createHash("sha256").update(packetRaw, "utf-8").digest("hex");
    expect(evidence["packet_hash"]).toBe(expectedHash);
  });

  it("correlates child completion telemetry and ledger with dispatch/provider/model evidence", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT_WITH_MODEL], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });
    expect(result.haltReason).toBe("cluster-complete");

    const telemetry = readJsonLines(join(tmpDir, "runs", "test-run-001", "telemetry.jsonl"));
    const childComplete = telemetry.find((event) => event["event"] === "child-complete");
    expect(childComplete).toBeDefined();
    expect(childComplete).toMatchObject({
      child_id: "POL-100",
      completion_status: "done",
      provider: "mock",
      model: "gpt-5.3-codex",
      router_selection_reason: "config-rotation",
    });
    expect(Array.isArray(childComplete?.["providers_tried"])).toBe(true);
    expect(childComplete?.["dispatch_id"]).toBeDefined();
    expect(childComplete?.["elapsed_seconds"] as number).toBeGreaterThanOrEqual(0);

    const ledgerEvents = readFileSync(join(tmpDir, ".polaris", "runs", "ledger.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const childCompleted = ledgerEvents.find((event) => event["event"] === "child-completed");
    expect(childCompleted).toBeDefined();
    expect(childCompleted).toMatchObject({
      issue_id: "POL-100",
      completion_status: "done",
      provider: "mock",
      model: "gpt-5.3-codex",
      router_selection_reason: "config-rotation",
    });
    expect(Array.isArray(childCompleted?.["providers_tried"])).toBe(true);
    expect(Array.isArray(childCompleted?.["commit_files"]) || childCompleted?.["commit_files"] === null).toBe(true);
  });

  it("workerWroteCompletion accepts valid commit evidence and does not double-count", async () => {
    const commit = createImplementationCommit(tmpDir);
    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const mockAdapter: ExecutionAdapter = {
      name: "mock",
      async dispatch(packet) {
        const state = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
        const contextBudget = state.context_budget as Record<string, unknown>;
        writeFileSync(
          stateFile,
          JSON.stringify(
            {
              ...state,
              open_children: [],
              completed_children: ["POL-100"],
              context_budget: {
                ...contextBudget,
                children_completed: 1,
              },
              next_open_child: null,
              status: "cluster-complete",
            },
            null,
            2,
          ),
          "utf-8",
        );
        const resultFile = isWorkerPacket(packet) ? packet.result_file_contract?.result_file : undefined;
        if (resultFile) {
          mkdirSync(dirname(resultFile), { recursive: true });
          writeFileSync(
            resultFile,
            JSON.stringify({ child_id: "POL-100", status: "done", commit }, null, 2),
            "utf-8",
          );
        }
        return {
          exit_code: 0,
          provider_used: "mock",
          command_run: "mock-worker",
          summary: JSON.stringify({ child_id: "POL-100", status: "done", commit }),
        };
      },
    };
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });
    const finalState = JSON.parse(readFileSync(stateFile, "utf-8")) as {
      completed_children: string[];
      context_budget: { children_completed: number };
    };

    expect(result.haltReason).toBe("cluster-complete");
    expect(result.childrenDispatched).toBe(1);
    expect(finalState.completed_children).toEqual(["POL-100"]);
    expect(finalState.context_budget.children_completed).toBe(1);
  });

  it("workerWroteCompletion halts with worker-error when commit evidence is empty", async () => {
    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const mockAdapter: ExecutionAdapter = {
      name: "mock",
      async dispatch(packet) {
        const state = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
        const contextBudget = state.context_budget as Record<string, unknown>;
        writeFileSync(
          stateFile,
          JSON.stringify(
            {
              ...state,
              open_children: [],
              completed_children: ["POL-100"],
              context_budget: {
                ...contextBudget,
                children_completed: 1,
              },
              next_open_child: null,
              status: "cluster-complete",
            },
            null,
            2,
          ),
          "utf-8",
        );
        const resultFile = isWorkerPacket(packet) ? packet.result_file_contract?.result_file : undefined;
        if (resultFile) {
          mkdirSync(dirname(resultFile), { recursive: true });
          writeFileSync(
            resultFile,
            JSON.stringify({ child_id: "POL-100", status: "done", commit: "" }, null, 2),
            "utf-8",
          );
        }
        return {
          exit_code: 0,
          provider_used: "mock",
          command_run: "mock-worker",
          summary: JSON.stringify({ child_id: "POL-100", status: "done", commit: "" }),
        };
      },
    };
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("worker-error");
    expect(result.haltingChild).toBe("POL-100");
    expect(result.message).toContain("without commit evidence");
  });

  it("returns state-invalid when current-state.json is malformed", async () => {
    const stateFile = join(tmpDir, "current-state.json");
    writeFileSync(stateFile, '{"not_valid": true}', "utf-8");
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("state-invalid");
    expect(result.childrenDispatched).toBe(0);
  });

  it("passes the correct bootstrap packet to the adapter", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    // Parent now dispatches compiled WorkerPackets (schema_version 2.1)
    // instead of raw v1 BootstrapPackets. WorkerPacket is a structural
    // superset of BootstrapPacket so all adapter contracts remain valid.
    expect(calls[0].packet).toMatchObject({
      schema_version: "2.1",
      run_id: "test-run-001",
      cluster_id: "POL-99",
      active_child: "POL-100",
      // parent.ts normalizes via realpathSync to resolve macOS /var → /private/var symlinks
      state_file: realpathSync(stateFile),
    });
  });

  it("halts with analyze-parent when cluster root title starts with 'ANALYZE:'", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-99": { title: "ANALYZE: Split execution architecture" } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("analyze-parent");
    expect(result.childrenDispatched).toBe(0);
    expect(result.message).toBe(
      "polaris-run targets IMPLEMENT parents, not ANALYZE issues. Run polaris-analyze first to create an IMPLEMENT parent.",
    );
    expect(calls).toHaveLength(0);
  });

  it("halts with analyze-parent when cluster root has 'analyze' label", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-99": { title: "Plan issue hierarchy", labels: ["analyze"] } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("analyze-parent");
    expect(calls).toHaveLength(0);
  });

  // ── Analyze-drift guardrail tests ──────────────────────────────────────────

  it("halts with analyze-drift when next child title starts with 'Analyze:'", async () => {
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT]);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-200"],
      { "POL-200": { title: "Analyze: scheduler behavior", body: "Analyze the scheduler." } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("analyze-drift");
    expect(result.haltingChild).toBe("POL-200");
    expect(result.message).toContain("POL-200");
    expect(result.message).toContain("allow_analyze_children");
  });

  it("halts with analyze-drift when next child title starts with 'polaris-analyze'", async () => {
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT]);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-200"],
      { "POL-200": { title: "polaris-analyze worker adapters" } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("analyze-drift");
    expect(result.haltingChild).toBe("POL-200");
  });

  it("halts with analyze-drift when next child has 'analyze' label", async () => {
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT]);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-200"],
      { "POL-200": { labels: ["analyze", "spike"] } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("analyze-drift");
    expect(result.haltingChild).toBe("POL-200");
  });

  it("does NOT halt for an implementation/fix child", async () => {
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT]);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-200"],
      { "POL-200": { title: "Implement: add budget guardrail", body: "## Goal\nAdd a guardrail.\n\n## Scope\n- src/**\n", labels: ["feature"] } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");
  });

  it("does NOT halt when allowAnalyzeChildren flag is set", async () => {
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT]);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-200"],
      { "POL-200": { title: "Analyze: scheduler behavior", body: "Analyze the scheduler." } },
    );

    const result = await runParentLoop({
      stateFile,
      repoRoot: tmpDir,
      allowAnalyzeChildren: true,
    });

    expect(result.haltReason).toBe("cluster-complete");
  });

  it("does NOT halt when budget.allow_analyze_children is true in config", async () => {
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT]);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    // Override config mock to include allow_analyze_children: true
    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: {
        mode: "auto",
        notification_format: "verbose",
        auto_finalize: false,
      },
      execution: {
        adapter: "mock",
        providers: { mock: { command: "mock-worker" } },
        rotation: ["mock"],
      },
      budget: {
        allow_analyze_children: true,
      },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-200"],
      { "POL-200": { title: "Analyze: scheduler behavior", body: "Analyze the scheduler." } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");
  });

  it("uses the agent-subtask adapter when orchestration_mode is ephemeral", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: {
        mode: "auto",
        notification_format: "verbose",
        auto_finalize: false,
      },
      execution: {
        adapter: "terminal-cli",
        providers: { terminal: { command: "terminal-worker" } },
        rotation: ["terminal"],
      },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });
    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      stateFile,
      JSON.stringify({ ...state, orchestration_mode: "ephemeral" }, null, 2),
      "utf-8",
    );

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(createAdapter).toHaveBeenCalledWith(
      "agent-subtask",
      expect.objectContaining({ adapter: "agent-subtask" }),
    );
    expect(calls[0].options.provider).toBe("agent-subtask");
  });

  it("uses the configured adapter when orchestration_mode is persistent-parent", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });
    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      stateFile,
      JSON.stringify({ ...state, orchestration_mode: "persistent-parent" }, null, 2),
      "utf-8",
    );

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(createAdapter).toHaveBeenCalledWith(
      "mock",
      expect.objectContaining({ adapter: "mock" }),
    );
    expect(calls[0].options.provider).toBe("mock");
  });

  it("halts when a worker reports done without commit evidence", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT_NO_COMMIT], calls));
    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("worker-error");
    expect(result.message).toContain("without commit evidence");
    const updatedState = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(updatedState.active_child).toBe("POL-100");
    expect(updatedState.completed_children).toEqual([]);
  });

  it("syncs route-local cluster state after a successful child completion", async () => {
    vi.mocked(createAdapter).mockReturnValue(
      makeMockAdapter([
        {
          ...SUCCESS_RESULT,
          summary: JSON.stringify({
            child_id: "POL-99",
            status: "done",
            commit: "abc1234",
            validation: "typecheck: pass",
          }),
        },
      ]),
    );
    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });
    const clusterStateFile = makeClusterStateFile(tmpDir, "POL-99", ["POL-100"]);

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");
    const clusterState = JSON.parse(readFileSync(clusterStateFile, "utf-8")) as Record<string, unknown>;
    expect(clusterState.state_generation).toBe(3);
    expect(clusterState.child_states).toEqual([
      {
        id: "POL-100",
        status: "done",
        commit: "abc1234",
      },
    ]);
    expect(clusterState.commits).toEqual({ "POL-100": "abc1234" });
    expect(clusterState.validation_results).toEqual({
      "POL-100": {
        passed: true,
        output: "typecheck: pass",
      },
    });
    const packetPath = (clusterState.packet_pointers as Record<string, string>)["POL-100"];
    const resultPath = (clusterState.result_pointers as Record<string, string>)["POL-100"];
    expect(packetPath).toContain(".polaris/clusters/POL-99/packets/POL-100-");
    expect(resultPath).toContain(".polaris/clusters/POL-99/results/POL-100-");
    expect(existsSync(packetPath)).toBe(true);
    expect(existsSync(resultPath)).toBe(true);
  });

  it("records an explicit auto-finalize handoff in auto mode", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = makeStateFile(tmpDir, {
      open_children: [],
      completed_children: ["POL-100"],
      children_completed: 1,
      max_children_per_session: 10,
    });

    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: {
        mode: "auto",
        notification_format: "verbose",
        auto_finalize: true,
      },
      execution: {
        adapter: "mock",
        providers: { mock: { command: "mock-worker" } },
        rotation: ["mock"],
      },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");
    expect(result.message).toContain("Auto-finalize handoff requested");

    const telemetry = readJsonLines(join(tmpDir, "runs", "test-run-001", "telemetry.jsonl"));
    expect(telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "cluster-complete" }),
        expect.objectContaining({
          event: "auto-finalize-requested",
          next_action: "polaris finalize run",
        }),
      ]),
    );
  });

  it("CLI loop run dry-run with a valid state file runs to cluster-complete and exits 0", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);
    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });
    const command = createLoopCommand({ repoRoot: tmpDir });

    const result = await runLoopCommand(command, [
      "run",
      "POL-99",
      "--state-file",
      stateFile,
      "--adapter",
      "mock",
      "--provider",
      "mock",
      "--dry-run",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Polaris parent loop halted: cluster-complete");
    expect(result.stdout).toContain("Cluster complete");
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ provider: "mock", dryRun: true });
  });

  it("CLI loop run exits 1 when state file is invalid", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = join(tmpDir, "current-state.json");
    writeFileSync(stateFile, '{"not_valid": true}', "utf-8");
    const command = createLoopCommand({ repoRoot: tmpDir });

    const result = await runLoopCommand(command, [
      "run",
      "POL-99",
      "--state-file",
      stateFile,
      "--dry-run",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Polaris parent loop halted: state-invalid");
    expect(result.stderr).toContain("current-state.json is invalid");
  });

  it("CLI loop run exits 1 with an ANALYZE parent message", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-99": { title: "ANALYZE: Split execution architecture" } },
    );
    const command = createLoopCommand({ repoRoot: tmpDir });

    const result = await runLoopCommand(command, [
      "run",
      "POL-99",
      "--state-file",
      stateFile,
      "--dry-run",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Polaris parent loop halted: analyze-parent");
    expect(result.stderr).toContain("polaris-run targets IMPLEMENT parents");
    expect(calls).toHaveLength(0);
  });

  // ── Body preflight gate ───────────────────────────────────────────────────

  it("halts with preflight-failed when next child has no body", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo" } }, // no body
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("preflight-failed");
    expect(result.haltingChild).toBe("POL-100");
    expect(result.message).toContain("POL-100");
    expect(result.message).toContain("no body/description");
  });

  it("halts with preflight-failed when next child body is whitespace-only", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo", body: "   " } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("preflight-failed");
    expect(result.message).toContain("no body/description");
  });

  it("does NOT halt preflight when child has a body", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo", body: "## Goal\nAs a user I want...\n\n## Scope\n- src/**\n" } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).not.toBe("preflight-failed");
    expect(calls).toHaveLength(1);
  });

  it("preflight gate does not fire in dry-run mode (body check skipped)", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo" } }, // no body — but dry-run skips the gate
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir, dryRun: true });

    expect(result.haltReason).not.toBe("preflight-failed");
  });

  it("emits preflight-body-missing telemetry event when child has no body", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo" } },
    );

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    const telemetry = readJsonLines(join(tmpDir, "runs", "test-run-001", "telemetry.jsonl"));
    const event = telemetry.find((e) => e["event"] === "preflight-body-missing");
    expect(event).toBeDefined();
    expect(event?.["child_id"]).toBe("POL-100");
  });

  it("does not mutate state when preflight gate fires", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo" } },
    );
    const stateBefore = readFileSync(stateFile, "utf-8");

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    const stateAfter = readFileSync(stateFile, "utf-8");
    expect(stateAfter).toBe(stateBefore);
  });

  // ── Scope preflight gate ──────────────────────────────────────────────────

  it("halts with preflight-failed when child body has no scope section", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo", body: "## Goal\nFix the thing.\n" } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("preflight-failed");
    expect(result.haltingChild).toBe("POL-100");
    expect(result.message).toContain("POL-100");
    expect(result.message).toContain("scope section");
  });

  it("emits preflight-scope-missing telemetry when scope section is absent", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo", body: "## Goal\nFix the thing.\n" } },
    );

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    const telemetry = readJsonLines(join(tmpDir, "runs", "test-run-001", "telemetry.jsonl"));
    const event = telemetry.find((e) => e["event"] === "preflight-scope-missing");
    expect(event).toBeDefined();
    expect(event?.["child_id"]).toBe("POL-100");
  });

  it("passes scope preflight when child body has a ## Scope section", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo", body: "## Goal\nFix.\n\n## Scope\n- src/loop/**\n" } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).not.toBe("preflight-failed");
    expect(calls).toHaveLength(1);
  });

  it("inherits scope from parent cluster body when child body has no scope section", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const parentBody = "## Goal\nParent plan.\n\n## Scope\n- src/loop/**\n- src/finalize/**\n";
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      {
        // cluster root (POL-99) has scope; child has body but no scope section
        "POL-99": { title: "Parent cluster", body: parentBody },
        "POL-100": { title: "Implement foo", body: "## Goal\nFix the thing.\n" },
      },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).not.toBe("preflight-failed");
    expect(calls).toHaveLength(1);
  });

  it("scope preflight gate does not fire in dry-run mode", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo", body: "## Goal\nFix the thing.\n" } },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir, dryRun: true });

    expect(result.haltReason).not.toBe("preflight-failed");
  });

  // ── Scope inheritance: packet-level assertions ────────────────────────────
  //
  // These tests assert that the dispatched WorkerPacket's allowed_scope reflects
  // the correct precedence: child scope overrides parent; parent is fallback only.

  it("dispatched packet allowed_scope comes from child body ## Scope section", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      {
        "POL-99": { title: "Parent", body: "## Goal\nPlan.\n\n## Scope\n- src/parent/**\n" },
        "POL-100": { title: "Implement foo", body: "## Goal\nFix.\n\n## Scope\n- src/loop/worker-packet.ts\n- src/loop/dispatch.ts\n" },
      },
    );

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(calls).toHaveLength(1);
    const packet = calls[0].packet;
    expect(isWorkerPacket(packet)).toBe(true);
    if (isWorkerPacket(packet)) {
      // Child scope wins — parent scope items must not appear
      expect(packet.instructions.allowed_scope).toContain("src/loop/worker-packet.ts");
      expect(packet.instructions.allowed_scope).toContain("src/loop/dispatch.ts");
      expect(packet.instructions.allowed_scope).not.toContain("src/parent/**");
    }
  });

  it("dispatched packet allowed_scope falls back to parent body when child has no scope section", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      {
        "POL-99": { title: "Parent", body: "## Goal\nPlan.\n\n## Scope\n- src/loop/**\n- src/finalize/**\n" },
        "POL-100": { title: "Implement foo", body: "## Goal\nFix the thing.\n" },
      },
    );

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(calls).toHaveLength(1);
    const packet = calls[0].packet;
    expect(isWorkerPacket(packet)).toBe(true);
    if (isWorkerPacket(packet)) {
      // Parent scope is the fallback source
      expect(packet.instructions.allowed_scope).toContain("src/loop/**");
      expect(packet.instructions.allowed_scope).toContain("src/finalize/**");
    }
  });

  it("child scope overrides parent scope — parent items absent from packet", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      {
        "POL-99": { title: "Parent", body: "## Goal\nPlan.\n\n## Scope\n- src/parent-only/**\n" },
        "POL-100": { title: "Implement foo", body: "## Goal\nFix.\n\n## Scope\n- src/child-only/**\n" },
      },
    );

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(calls).toHaveLength(1);
    const packet = calls[0].packet;
    expect(isWorkerPacket(packet)).toBe(true);
    if (isWorkerPacket(packet)) {
      expect(packet.instructions.allowed_scope).toContain("src/child-only/**");
      expect(packet.instructions.allowed_scope).not.toContain("src/parent-only/**");
    }
  });

  it("parent scope is not merged with child scope — only child scope appears", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      {
        "POL-99": { title: "Parent", body: "## Goal\nPlan.\n\n## Scope\n- src/loop/**\n- src/finalize/**\n" },
        "POL-100": { title: "Implement foo", body: "## Goal\nFix.\n\n## Scope\n- src/loop/worker-packet.ts\n" },
      },
    );

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    const packet = calls[0].packet;
    if (isWorkerPacket(packet)) {
      // Parent's broader scope items must NOT be merged in
      expect(packet.instructions.allowed_scope).toEqual(["src/loop/worker-packet.ts"]);
      expect(packet.instructions.allowed_scope).not.toContain("src/finalize/**");
    }
  });

  // ── Sealed result contract / pre-dispatch-failure regressions ─────────────

  it("halts with preflight-failed when packet primary goal is placeholder text", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      {
        "POL-100": {
          title: "Implement foo",
          body: "## Goal\nTBD\n\n## Scope\n- src/**\n",
        },
      },
    );

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("preflight-failed");
    expect(result.haltingChild).toBe("POL-100");
    expect(result.message).toContain("placeholder primary goal");
  });

  it("halts with worker-error when worker commit contains only artifact files", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    // Inject a mock that reports the commit only touches artifact paths
    const result = await runParentLoop({
      stateFile,
      repoRoot: tmpDir,
      getCommitFiles: (_commit, _repoRoot) => [
        ".polaris/clusters/POL-99/results/POL-100-dispatch.json",
        ".polaris/clusters/POL-99/packets/POL-100-dispatch.json",
      ],
    });

    expect(result.haltReason).toBe("worker-error");
    expect(result.haltingChild).toBe("POL-100");
    expect(result.message).toContain("only artifact files");
  });

  it("adapter with pre_dispatch_failure rolls back active_child and returns worker-error", async () => {
    // Regression for: loop run --adapter agent-subtask ENOENT when no dispatcher.
    // When adapter sets pre_dispatch_failure: true it never launched a worker.
    // Parent must roll back state (active_child stays empty) and halt cleanly.
    const preDispatchFailureAdapter: ExecutionAdapter = {
      name: "mock-no-dispatcher",
      async dispatch(_packet, _options): Promise<DispatchResult> {
        return {
          exit_code: 1,
          pre_dispatch_failure: true,
          provider_used: "none",
          command_run: "mock-no-dispatcher",
          summary: "Native subtask dispatch unavailable in this host environment.",
          stderr: "Native subtask dispatch unavailable in this host environment.",
        };
      },
    };
    vi.mocked(createAdapter).mockReturnValue(preDispatchFailureAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const { readState } = await import("./checkpoint.js");
    const stateBefore = readState(stateFile);
    expect(stateBefore.active_child).toBe("");

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("worker-error");
    expect(result.haltingChild).toBe("POL-100");
    expect(result.message).toContain("cannot dispatch");

    // State must be rolled back — active_child cleared, dispatch epoch not advanced
    const stateAfter = readState(stateFile);
    expect(stateAfter.active_child).toBe("");
    expect(stateAfter.dispatch_boundary?.dispatch_epoch).toBe(
      stateBefore.dispatch_boundary?.dispatch_epoch ?? 0,
    );
  });

  it("adapter returning exit_code=1 without pre_dispatch_failure does NOT read sealed result file (no ENOENT)", async () => {
    // Regression: parent.ts previously tried to readFileSync the sealed result file
    // even when the adapter returned exit_code=1. This caused ENOENT because no
    // worker ran. Now it must skip the read and return worker-error cleanly.
    const failingAdapter: ExecutionAdapter = {
      name: "mock-fail",
      async dispatch(_packet, _options): Promise<DispatchResult> {
        // Return failure WITHOUT writing the sealed result file and WITHOUT
        // setting pre_dispatch_failure (simulates a worker that crashed mid-run).
        return {
          exit_code: 1,
          provider_used: "mock-fail",
          command_run: "mock-fail-worker",
          summary: "Worker process exited with code 1",
          stderr: "Worker process exited with code 1",
        };
      },
    };
    vi.mocked(createAdapter).mockReturnValue(failingAdapter);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    // Should not throw (no ENOENT) — must return a structured result
    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("worker-error");
    expect(result.haltingChild).toBe("POL-100");
    // active_child is left set (dispatch was partially recorded) — that is expected
    // for non-pre_dispatch_failure failures where the worker may have partially run.
  });

  // ── Cluster snapshot body hydration ──────────────────────────────────────
  //
  // Packet generation must resolve body from .polaris/clusters/<id>/clusters.json
  // when open_children_meta lacks body. current-state.json is ephemeral cursor
  // state; clusters.json is the durable local body snapshot.

  function makeClusterSnapshotWithBodies(
    dir: string,
    clusterId: string,
    nodes: Record<string, { title?: string; body?: string }>,
  ): void {
    const snapshotDir = join(dir, ".polaris", "clusters", clusterId);
    mkdirSync(snapshotDir, { recursive: true });
    const snapshot = {
      schemaVersion: "v2",
      source: { id: clusterId, type: "Linear" },
      nodes: Object.fromEntries(
        Object.entries(nodes).map(([id, n]) => [
          id,
          { id, title: n.title ?? id, status: "Todo", ...(n.body ? { body: n.body } : {}) },
        ]),
      ),
      dependencies: {},
      clusters: {
        [clusterId]: { id: clusterId, title: clusterId, children: Object.keys(nodes) },
      },
      activeCluster: clusterId,
    };
    writeFileSync(join(snapshotDir, "clusters.json"), JSON.stringify(snapshot, null, 2), "utf-8");
  }

  it("resolves body from clusters.json when open_children_meta has no body", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo" } }, // no body in state
    );
    makeClusterSnapshotWithBodies(tmpDir, "POL-99", {
      "POL-99": { title: "Parent cluster" },
      "POL-100": { title: "Implement foo", body: "## Goal\nFix the thing.\n\n## Scope\n- src/loop/**\n" },
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).not.toBe("preflight-failed");
    expect(calls).toHaveLength(1);
    const packet = calls[0].packet;
    expect(isWorkerPacket(packet)).toBe(true);
    if (isWorkerPacket(packet)) {
      expect(packet.instructions.issue_context?.body).toContain("## Goal");
      expect(packet.instructions.allowed_scope).toContain("src/loop/**");
    }
  });

  it("halts with preflight-failed and sync-in message when neither state nor clusters.json has body", async () => {
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT]));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      { "POL-100": { title: "Implement foo" } }, // no body
    );
    // No clusters.json written — snapshot is absent

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("preflight-failed");
    expect(result.haltingChild).toBe("POL-100");
    expect(result.message).toContain("no body/description");
    expect(result.message).toContain("tracker sync-in");
    expect(result.message).toContain("POL-99");
  });

  it("resolves parent scope from clusters.json when child body lacks scope and state has no parent body", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      {
        // Child body present in state but no scope; parent body absent from state
        "POL-100": { title: "Implement foo", body: "## Goal\nFix the thing.\n" },
      },
    );
    makeClusterSnapshotWithBodies(tmpDir, "POL-99", {
      "POL-99": { title: "Parent cluster", body: "## Goal\nParent plan.\n\n## Scope\n- src/finalize/**\n" },
      "POL-100": { title: "Implement foo" },
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).not.toBe("preflight-failed");
    expect(calls).toHaveLength(1);
    const packet = calls[0].packet;
    if (isWorkerPacket(packet)) {
      expect(packet.instructions.allowed_scope).toContain("src/finalize/**");
    }
  });

  it("resolves body from clusters.json when open_children_meta entry is entirely absent", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));
    // State has no entry for POL-100 in open_children_meta at all
    const stateFile = makeStateFileWithMeta(
      tmpDir,
      ["POL-100"],
      {}, // no meta entry for POL-100
    );
    makeClusterSnapshotWithBodies(tmpDir, "POL-99", {
      "POL-99": { title: "Parent cluster" },
      "POL-100": { title: "Implement foo", body: "## Goal\nFix the thing.\n\n## Scope\n- src/loop/**\n" },
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).not.toBe("preflight-failed");
    expect(calls).toHaveLength(1);
    const packet = calls[0].packet;
    expect(isWorkerPacket(packet)).toBe(true);
    if (isWorkerPacket(packet)) {
      expect(packet.instructions.issue_context?.body).toContain("## Goal");
      expect(packet.instructions.allowed_scope).toContain("src/loop/**");
    }
  });

  // Regression: POL-510 — six-of-six children complete with budget exhausted at cluster size
  // When open_children empties after the final child, the loop must proceed to cluster-complete
  // and the QC repair-loop gate, not halt with budget-exhausted.
  it("reaches cluster-complete when all six children complete and budget equals cluster size (POL-510)", async () => {
    const calls: MockCall[] = [];
    const sixChildren = ["POL-101", "POL-102", "POL-103", "POL-104", "POL-105", "POL-106"];
    const mockAdapter = makeMockAdapter(
      sixChildren.map(() => SUCCESS_RESULT),
      calls,
    );
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    // Budget == cluster size: max_children_per_session === 6, open children === 6
    const stateFile = makeStateFile(tmpDir, {
      open_children: sixChildren,
      children_completed: 0,
      max_children_per_session: 6,
    });

    // QC enabled but no findings — repair loop should not be invoked
    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: { mode: "auto", notification_format: "verbose", auto_finalize: false },
      execution: {
        adapter: "mock",
        providers: { mock: { command: "mock-worker" } },
        rotation: ["mock"],
      },
      qc: { enabled: true, providers: [] },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    vi.mocked(runQcAtTrigger).mockResolvedValueOnce({
      results: [],
      trigger: "completed-cluster",
    } as unknown as Awaited<ReturnType<typeof runQcAtTrigger>>);

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    // Must reach cluster-complete, not budget-exhausted
    expect(result.haltReason).toBe("cluster-complete");
    expect(result.childrenDispatched).toBe(6);
    expect(calls).toHaveLength(6);
    // QC was triggered (completed-cluster gate was reached)
    expect(vi.mocked(runQcAtTrigger)).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "completed-cluster" }),
    );
    // Repair loop was not invoked (no findings)
    expect(vi.mocked(runQcRepairLoop)).not.toHaveBeenCalled();

    // Verify no budget-exhausted event in telemetry
    const telemetryFile = join(tmpDir, "runs", "test-run-001", "telemetry.jsonl");
    const events = readJsonLines(telemetryFile);
    const budgetEvents = events.filter((e) => e.event === "budget-exhausted");
    expect(budgetEvents).toHaveLength(0);
  });

  // Regression: POL-485 — final child completion must reach cluster-complete and
  // enter the QC repair loop when findings are present, not emit budget-exhausted
  // with next_child: null or skip repair-loop processing.
  it("reaches cluster-complete and QC repair loop when final child completes (POL-485)", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));

    // Budget equals cluster size and only one child remains. The buggy POL-485 path
    // would halt with budget-exhausted after the final child; the fixed path must
    // detect that open_children is empty and proceed to cluster-complete/QC handling.
    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-485"],
      completed_children: ["POL-485-a", "POL-485-b", "POL-485-c"],
      children_completed: 3,
      max_children_per_session: 4,
    });

    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: { mode: "auto", notification_format: "verbose", auto_finalize: false },
      execution: {
        adapter: "mock",
        providers: { mock: { command: "mock-worker" } },
        rotation: ["mock"],
      },
      qc: { enabled: true, repairRouting: "route", maxRepairRounds: 2, providers: {} },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    // Completed-cluster QC returns one actionable finding → repair loop must run.
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce({
      trigger: "completed-cluster",
      results: [
        {
          schemaVersion: "1.0",
          qcRunId: "qc-485",
          runId: "test-run-001",
          clusterId: "POL-99",
          trigger: "completed-cluster",
          provider: "coderabbit",
          providerMode: "local",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "findings",
          findings: [
            {
              findingId: "f-485",
              severity: "medium",
              category: "style",
              title: "POL-485 finding",
              fixAvailable: true,
              autofixEligible: false,
              attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-485" },
              status: "open",
              filePath: "src/foo.ts",
            },
          ],
          rawArtifactPaths: [],
          parserVersion: "coderabbit-1.0",
          policyDecision: {
            blocksDelivery: false,
            requiresOperatorReview: false,
            routedToRepair: true,
            summary: "findings",
          },
        },
      ],
      action: "follow-up",
      summary: "findings",
    } as unknown as Awaited<ReturnType<typeof runQcAtTrigger>>);

    vi.mocked(runQcRepairLoop).mockResolvedValueOnce({
      outcome: "pass",
      rounds_completed: 1,
      final_qc_results: [],
      loop_state: {
        current_round: 1,
        max_rounds: 2,
        source_qc_run_ids: ["qc-485"],
        manifest_path: null,
        pending_packet_ids: [],
        completed_packet_ids: [],
        rerun_requested: false,
        rerun_qc_run_ids: {},
        terminal_outcome: "pass",
        initiated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      summary: "QC repair loop passed",
    } as unknown as Awaited<ReturnType<typeof runQcRepairLoop>>);

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");
    expect(result.childrenDispatched).toBe(1);
    expect(result.message).not.toContain("budget-exhausted");
    expect(calls).toHaveLength(1);
    expect(calls[0].packet.active_child).toBe("POL-485");

    // QC completed-cluster trigger was reached and repair loop was entered.
    expect(vi.mocked(runQcAtTrigger)).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "completed-cluster" }),
    );
    expect(vi.mocked(runQcRepairLoop)).toHaveBeenCalled();

    // No budget-exhausted telemetry was emitted.
    const telemetryFile = join(tmpDir, "runs", "test-run-001", "telemetry.jsonl");
    const events = readJsonLines(telemetryFile);
    expect(events.some((e) => e.event === "budget-exhausted")).toBe(false);
  });
});

// ── Provider policy enforcement ──────────────────────────────────────────────

describe("runParentLoop — provider policy enforcement", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `polaris-parent-policy-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "runs", "test-run-001"), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("selects codex when rotation has claude first but providerPolicy.worker excludes claude", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: { mode: "auto", notification_format: "verbose", auto_finalize: false },
      execution: {
        adapter: "mock",
        providers: {
          claude: { command: "claude-worker" },
          codex: { command: "codex-worker" },
          copilot: { command: "copilot-worker" },
        },
        rotation: ["claude", "codex", "copilot"],
        providerPolicy: {
          worker: { providers: ["copilot", "codex"] },
        },
      },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    // Loop should dispatch successfully (not halt with worker-error)
    expect(result.haltReason).toBe("cluster-complete");
    expect(calls).toHaveLength(1);
    // Provider dispatched must NOT be claude — must be one allowed by policy
    expect(calls[0].options.provider).not.toBe("claude");
    expect(["copilot", "codex"]).toContain(calls[0].options.provider);
  });

  it("halts with worker-error when explicit --provider claude is excluded by providerPolicy.worker", async () => {
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT]);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: { mode: "auto", notification_format: "verbose", auto_finalize: false },
      execution: {
        adapter: "mock",
        providers: {
          claude: { command: "claude-worker" },
          codex: { command: "codex-worker" },
        },
        rotation: ["codex"],
        providerPolicy: {
          worker: { providers: ["codex"] },
        },
      },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      max_children_per_session: 10,
    });

    const result = await runParentLoop({
      stateFile,
      repoRoot: tmpDir,
      provider: "claude", // explicit --provider flag
    });

    expect(result.haltReason).toBe("worker-error");
    expect(result.message).toContain("forbidden");
    expect(result.message).toContain("claude");
  });

  it("dispatches successfully when explicit --provider matches providerPolicy.worker", async () => {
    const calls: MockCall[] = [];
    const mockAdapter = makeMockAdapter([SUCCESS_RESULT], calls);
    vi.mocked(createAdapter).mockReturnValue(mockAdapter);

    const { loadConfig } = await import("../config/loader.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      orchestration: { mode: "auto", notification_format: "verbose", auto_finalize: false },
      execution: {
        adapter: "mock",
        providers: {
          claude: { command: "claude-worker" },
          codex: { command: "codex-worker" },
        },
        rotation: ["claude"],
        providerPolicy: {
          worker: { providers: ["codex"] },
        },
      },
    } as unknown as Required<import("../config/schema.js").PolarisConfig>);

    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      max_children_per_session: 10,
    });

    const result = await runParentLoop({
      stateFile,
      repoRoot: tmpDir,
      provider: "codex", // explicit --provider that IS in policy
    });

    expect(result.haltReason).toBe("cluster-complete");
    expect(calls[0].options.provider).toBe("codex");
  });
});

// ── run-health symptom ingestion ──────────────────────────────────────────────

import { readRunHealthReport } from "../run-health/index.js";
import type { WorkerRunHealthSymptom } from "../types/result-packet.js";

describe("run-health symptom ingestion", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempDir());
    vi.mocked(createAdapter).mockReset();
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function mkdtempDir(): string {
    const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    return mkdtempSync(join(tmpdir(), "polaris-parent-rh-"));
  }

  /**
   * Build a mock adapter that writes a sealed result containing symptoms.
   */
  function makeSymptomAdapter(symptoms: WorkerRunHealthSymptom[]): ExecutionAdapter {
    return {
      name: "mock",
      async dispatch(packet, _options) {
        const resultSummary = {
          child_id: packet.active_child,
          status: "done",
          commit: "a".repeat(40),
          validation: { passed: ["npm run build"] },
          next_recommended_action: "continue",
          run_health_symptoms: symptoms,
        };
        if (isWorkerPacket(packet)) {
          mkdirSync(dirname(packet.result_file_contract.result_file), { recursive: true });
          writeFileSync(
            packet.result_file_contract.result_file,
            JSON.stringify(resultSummary),
            "utf-8",
          );
        }
        return {
          exit_code: 0,
          provider_used: "mock",
          command_run: "mock",
          summary: JSON.stringify(resultSummary),
        };
      },
    };
  }

  it("creates a run-health report when worker reports validation-failed symptom", async () => {
    vi.mocked(createAdapter).mockReturnValue(
      makeSymptomAdapter([
        {
          category: "validation-failed",
          message: "tsc exited with code 1 after 2 attempts",
          occurred_at: new Date().toISOString(),
        },
      ]),
    );

    stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });
    expect(result.haltReason).toBe("cluster-complete");

    const report = readRunHealthReport("test-run-001", tmpDir);
    expect(report).not.toBeNull();
    expect(report?.symptoms).toHaveLength(1);
    expect(report?.symptoms[0].code).toBe("validation-failed");
  });

  it("creates a run-health report when worker reports worker-blocked symptom", async () => {
    vi.mocked(createAdapter).mockReturnValue(
      makeSymptomAdapter([
        {
          category: "worker-blocked",
          message: "Cannot proceed without approval for out-of-scope file",
          occurred_at: new Date().toISOString(),
        },
      ]),
    );

    stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });
    expect(result.haltReason).toBe("cluster-complete");

    const report = readRunHealthReport("test-run-001", tmpDir);
    expect(report?.symptoms[0].code).toBe("worker-blocked");
    expect(report?.symptoms[0].severity).toBe("high");
  });

  it("creates a run-health report when worker reports repeated-rework symptom", async () => {
    vi.mocked(createAdapter).mockReturnValue(
      makeSymptomAdapter([
        {
          category: "repeated-rework",
          message: "Attempted the same type fix 4 times without progression",
          occurred_at: new Date().toISOString(),
        },
      ]),
    );

    stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    await runParentLoop({ stateFile, repoRoot: tmpDir });
    const report = readRunHealthReport("test-run-001", tmpDir);
    expect(report?.symptoms[0].code).toBe("repeated-rework");
  });

  it("creates a run-health report when worker reports unclear-requirements symptom", async () => {
    vi.mocked(createAdapter).mockReturnValue(
      makeSymptomAdapter([
        {
          category: "unclear-requirements",
          message: "AC says append-only and overwrite — contradictory",
          occurred_at: new Date().toISOString(),
        },
      ]),
    );

    stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    await runParentLoop({ stateFile, repoRoot: tmpDir });
    const report = readRunHealthReport("test-run-001", tmpDir);
    expect(report?.symptoms[0].code).toBe("unclear-requirements");
  });

  it("creates a run-health report when worker reports unusual-assumption symptom", async () => {
    vi.mocked(createAdapter).mockReturnValue(
      makeSymptomAdapter([
        {
          category: "unusual-assumption",
          message: "Assumed zod is available; not in package.json",
          occurred_at: new Date().toISOString(),
        },
      ]),
    );

    stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    await runParentLoop({ stateFile, repoRoot: tmpDir });
    const report = readRunHealthReport("test-run-001", tmpDir);
    expect(report?.symptoms[0].code).toBe("unusual-assumption");
    expect(report?.symptoms[0].severity).toBe("low");
  });

  it("does NOT create a run-health report when worker reports no symptoms", async () => {
    const calls: MockCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeMockAdapter([SUCCESS_RESULT], calls));

    stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    const report = readRunHealthReport("test-run-001", tmpDir);
    expect(report).toBeNull();
  });

  it("appends symptoms from multiple workers to the same report", async () => {
    let callCount = 0;
    const twoWorkerAdapter: ExecutionAdapter = {
      name: "mock",
      async dispatch(packet, _options) {
        callCount += 1;
        const category: WorkerRunHealthSymptom['category'] =
          callCount === 1 ? "validation-failed" : "unusual-assumption";
        const resultSummary = {
          child_id: packet.active_child,
          status: "done",
          commit: "a".repeat(40),
          validation: { passed: ["npm run build"] },
          next_recommended_action: "continue",
          run_health_symptoms: [
            { category, message: `symptom from child ${callCount}`, occurred_at: new Date().toISOString() },
          ],
        };
        if (isWorkerPacket(packet)) {
          mkdirSync(dirname(packet.result_file_contract.result_file), { recursive: true });
          writeFileSync(packet.result_file_contract.result_file, JSON.stringify(resultSummary), "utf-8");
        }
        return { exit_code: 0, provider_used: "mock", command_run: "mock", summary: JSON.stringify(resultSummary) };
      },
    };

    vi.mocked(createAdapter).mockReturnValue(twoWorkerAdapter);

    stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100", "POL-101"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    const report = readRunHealthReport("test-run-001", tmpDir);
    expect(report?.symptoms).toHaveLength(2);
    expect(report?.symptoms.map((s) => s.code)).toContain("validation-failed");
    expect(report?.symptoms.map((s) => s.code)).toContain("unusual-assumption");
  });

  it("appends run-health-symptoms-ingested to telemetry when symptoms reported", async () => {
    vi.mocked(createAdapter).mockReturnValue(
      makeSymptomAdapter([
        { category: "validation-failed", message: "build failed", occurred_at: new Date().toISOString() },
      ]),
    );

    stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    await runParentLoop({ stateFile, repoRoot: tmpDir });

    const telemetryPath = join(tmpDir, "runs", "test-run-001", "telemetry.jsonl");
    const events = readFileSync(telemetryPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const ingestEvent = events.find((e) => e["event"] === "run-health-symptoms-ingested");
    expect(ingestEvent).toBeDefined();
    expect(ingestEvent?.["symptom_count"]).toBe(1);
    expect(ingestEvent?.["child_id"]).toBe("POL-100");
  });
});
