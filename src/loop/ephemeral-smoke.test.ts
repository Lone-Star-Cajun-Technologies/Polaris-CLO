import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runParentLoop } from "./parent.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./adapters/types.js";

interface AdapterCall {
  packet: BootstrapPacket;
  options: DispatchOptions;
}

vi.mock("./adapters/registry.js", () => ({
  createAdapter: vi.fn(),
}));

vi.mock("../config/loader.js", () => ({
  loadConfig: vi.fn(() => ({
    execution: {
      adapter: "terminal-cli",
      providers: { "agent-subtask": { command: "native-subtask" } },
      rotation: ["terminal-cli"],
    },
    budget: {
      max_children_per_session: 5,
      allow_analyze_children: false,
    },
  })),
}));

import { createAdapter } from "./adapters/registry.js";

function writeState(dir: string, overrides: Record<string, unknown>): string {
  const stateFile = join(dir, "current-state.json");
  const state = {
    schema_version: "1.0",
    run_id: "ephemeral-smoke-run",
    cluster_id: "POL-105",
    skill: "polaris-run",
    artifact_dir: dir,
    branch: "feature/pol-105",
    current_step_id: "03-execute-child",
    step_cursor: "dispatching",
    status: "executing",
    session_type: "implementation",
    active_child: "",
    last_commit: "",
    next_open_child: null,
    completed_children: [],
    open_children: [],
    open_children_meta: {},
    context_budget: {
      children_completed: 0,
      files_touched_total: 0,
      max_children_per_session: 5,
    },
    updated_at: "2026-05-26T00:00:00.000Z",
    ...overrides,
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

function makeAdapter(calls: AdapterCall[]): ExecutionAdapter {
  const result: DispatchResult = {
    exit_code: 0,
    provider_used: "agent-subtask",
    command_run: "agent-subtask:POL-112",
    summary: JSON.stringify({
      child_id: "POL-112",
      status: "done",
      commit_hash: "abc1120",
      validation_summary: "ephemeral smoke passed",
      next_action: "resume-parent",
    }),
  };

  return {
    name: "agent-subtask",
    async dispatch(packet, options) {
      calls.push({ packet, options });
      return result;
    },
  };
}

describe("ephemeral execution smoke", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "polaris-ephemeral-smoke-"));
    mkdirSync(join(tmpDir, "runs", "ephemeral-smoke-run"), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects an ANALYZE parent before dispatch", async () => {
    const calls: AdapterCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeAdapter(calls));
    const stateFile = writeState(tmpDir, {
      cluster_id: "POL-200",
      open_children: ["POL-201"],
      next_open_child: "POL-201",
      open_children_meta: {
        "POL-200": { title: "ANALYZE: Ephemeral execution split" },
        "POL-201": { title: "IMPLEMENT: unreachable child" },
      },
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("analyze-parent");
    expect(result.childrenDispatched).toBe(0);
    expect(result.message).toBe(
      "polaris-run targets IMPLEMENT parents, not ANALYZE issues. Run polaris-analyze first to create an IMPLEMENT parent.",
    );
    expect(calls).toHaveLength(0);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("dispatches one child through the ephemeral adapter and records state plus telemetry", async () => {
    const calls: AdapterCall[] = [];
    vi.mocked(createAdapter).mockReturnValue(makeAdapter(calls));
    const stateFile = writeState(tmpDir, {
      orchestration_mode: "ephemeral",
      open_children: ["POL-112"],
      next_open_child: "POL-112",
      open_children_meta: {
        "POL-105": { title: "IMPLEMENT: Issue hierarchy and ephemeral execution refactor" },
        "POL-112": { title: "IMPLEMENT: Write Polaris ephemeral execution smoke test and validation harness" },
      },
    });

    const result = await runParentLoop({ stateFile, repoRoot: tmpDir });

    expect(result.haltReason).toBe("cluster-complete");
    expect(result.childrenDispatched).toBe(1);
    expect(createAdapter).toHaveBeenCalledWith(
      "agent-subtask",
      expect.objectContaining({ adapter: "agent-subtask" }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].packet.active_child).toBe("POL-112");
    expect(calls[0].options.provider).toBe("agent-subtask");

    const updatedState = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(updatedState.status).toBe("cluster-complete");
    expect(updatedState.completed_children).toEqual(["POL-112"]);
    expect(updatedState.open_children).toEqual([]);
    expect(updatedState.next_open_child).toBeNull();
    expect(updatedState.last_commit).toBe("abc1120");
    expect(updatedState.context_budget).toMatchObject({ children_completed: 1 });

    const telemetry = readJsonLines(join(tmpDir, "runs", "ephemeral-smoke-run", "telemetry.jsonl"));
    expect(telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "child-dispatch",
          child_id: "POL-112",
          adapter: "agent-subtask",
          orchestration_mode: "ephemeral",
          provider: "agent-subtask",
        }),
        expect.objectContaining({
          event: "child-complete",
          child_id: "POL-112",
          children_completed: 1,
        }),
      ]),
    );
  });
});
