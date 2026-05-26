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
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runParentLoop } from "./parent.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./adapters/types.js";

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
      // Rewrite child_id in the summary to match the dispatched child so the
      // parent loop's mismatch guard doesn't reject a valid mock result.
      try {
        const parsed = JSON.parse(base.summary ?? "{}") as Record<string, unknown>;
        if ("child_id" in parsed) {
          return { ...base, summary: JSON.stringify({ ...parsed, child_id: packet.active_child }) };
        }
      } catch {
        // Summary is not JSON — leave as-is
      }
      return base;
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
    next_open_child: (overrides.open_children ?? ["POL-100", "POL-101", "POL-102"])[0] ?? null,
    completed_children: overrides.completed_children ?? [],
    open_children: overrides.open_children ?? ["POL-100", "POL-101", "POL-102"],
    open_children_meta: {},
    context_budget: {
      children_completed: overrides.children_completed ?? 0,
      files_touched_total: 0,
      max_children_per_session: overrides.max_children_per_session ?? 3,
    },
    updated_at: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
  return stateFile;
}

function makeStateFileWithMeta(
  dir: string,
  openChildren: string[],
  meta: Record<string, { type?: string; title?: string; labels?: string[] }>,
  maxChildren: number = 10,
): string {
  const stateFile = join(dir, "current-state.json");
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
    updated_at: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
  return stateFile;
}

// ── Mock registry so tests can inject a mock adapter ────────────────────────

vi.mock("./adapters/registry.js", () => ({
  createAdapter: vi.fn(),
}));
vi.mock("../config/loader.js", () => ({
  loadConfig: vi.fn(() => ({
    execution: {
      adapter: "mock",
      providers: { mock: { command: "mock-worker" } },
      rotation: ["mock"],
    },
  })),
}));

import { createAdapter } from "./adapters/registry.js";

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
    // Only one dispatch attempt before halt
    expect(calls).toHaveLength(1);
    // POL-101 never dispatched
    expect(calls[0].packet.active_child).toBe("POL-100");
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

  it("does not double-count when worker already persisted child completion", async () => {
    const stateFile = makeStateFile(tmpDir, {
      open_children: ["POL-100"],
      children_completed: 0,
      max_children_per_session: 10,
    });

    const mockAdapter: ExecutionAdapter = {
      name: "mock",
      async dispatch() {
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
        return {
          exit_code: 0,
          provider_used: "mock",
          command_run: "mock-worker",
          summary: JSON.stringify({ child_id: "POL-100", status: "done", commit: "abc1234" }),
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
    expect(result.childrenDispatched).toBe(0);
    expect(finalState.completed_children).toEqual(["POL-100"]);
    expect(finalState.context_budget.children_completed).toBe(1);
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

    // Parent now dispatches compiled WorkerPackets (schema_version 2.0)
    // instead of raw v1 BootstrapPackets. WorkerPacket is a structural
    // superset of BootstrapPacket so all adapter contracts remain valid.
    expect(calls[0].packet).toMatchObject({
      schema_version: "2.0",
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
      { "POL-200": { title: "Analyze: scheduler behavior" } },
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
      { "POL-200": { title: "Implement: add budget guardrail", labels: ["feature"] } },
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
      { "POL-200": { title: "Analyze: scheduler behavior" } },
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
      { "POL-200": { title: "Analyze: scheduler behavior" } },
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
});
