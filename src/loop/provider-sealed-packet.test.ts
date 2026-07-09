import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { runParentLoop } from "./parent.js";
import { createBootstrapSeal } from "./run-bootstrap.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./adapters/types.js";
import { SealedWorkerResult, WorkerPacket } from "./worker-packet.js";

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
  const runId = "sealed-packet-smoke-run";
  const clusterId = (overrides["cluster_id"] as string | undefined) ?? "POL-197";
  const openChildren = (overrides["open_children"] as string[] | undefined) ?? [];
  const state = {
    schema_version: "1.0",
    run_id: runId,
    cluster_id: clusterId,
    skill: "polaris-run",
    artifact_dir: dir,
    branch: "feature/pol-197",
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
    dispatch_boundary: { dispatch_epoch: 0, continue_epoch: 0, last_dispatched_child: null },
    run_bootstrap_seal: createBootstrapSeal(runId, clusterId, openChildren),
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

function resolveRepoPath(repoRoot: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(repoRoot, filePath);
}

function makeSealedPacketAdapter(calls: AdapterCall[], repoRoot: string, commit: string): ExecutionAdapter {
  return {
    name: "agent-subtask",
    async dispatch(packet, options) {
      calls.push({ packet, options });

      // Simulate the worker writing its sealed result to the file
      const workerPacket = packet as WorkerPacket;
      if (workerPacket.result_file_contract?.result_file) {
        const sealedResult: SealedWorkerResult = {
          run_id: workerPacket.run_id,
          child_id: workerPacket.active_child,
          status: "success",
          commit,
          validation: { message: "sealed packet validation passed" },
        };
        const resultFilePath = resolveRepoPath(repoRoot, workerPacket.result_file_contract.result_file);
        mkdirSync(dirname(resultFilePath), { recursive: true });
        writeFileSync(resultFilePath, JSON.stringify(sealedResult, null, 2), "utf-8");
      }

      const dispatchResult: DispatchResult = {
        exit_code: 0,
        provider_used: "agent-subtask",
        command_run: `agent-subtask:${packet.active_child}`,
        // No summary returned for sealed packets, result is in file
        summary: "",
      };
      return dispatchResult;
    },
  };
}

describe("provider smoke tests for sealed local packets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "polaris-sealed-packet-smoke-"));
    mkdirSync(join(tmpDir, "runs", "sealed-packet-smoke-run"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "copilot@example.com"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Copilot"], { cwd: tmpDir });
    writeFileSync(join(tmpDir, "README.md"), "test\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir, stdio: "ignore" });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dispatches a child with a sealed packet contract and processes its result file", async () => {
    const calls: AdapterCall[] = [];
    const childId = "POL-200";
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();
    vi.mocked(createAdapter).mockReturnValue(makeSealedPacketAdapter(calls, tmpDir, commit));

    const stateFile = writeState(tmpDir, {
      orchestration_mode: "ephemeral",
      open_children: [childId],
      next_open_child: childId,
      open_children_meta: {
        [childId]: {
          title: "IMPLEMENT: Sealed Packet Test Child",
          body: "## Goal\nImplement the sealed packet test child.\n\n## Scope\n- src/**\n",
        },
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
    const dispatchedPacket = calls[0].packet as WorkerPacket;
    expect(dispatchedPacket.active_child).toBe(childId);
    expect(dispatchedPacket.result_file_contract?.result_file).toContain(
      `.polaris/clusters/POL-197/results/${childId}-`,
    );

    // Verify the mock worker wrote the sealed result file
    expect(readFileSync(resolveRepoPath(tmpDir, dispatchedPacket.result_file_contract!.result_file), "utf-8")).toBe(
      JSON.stringify(
        {
          run_id: "sealed-packet-smoke-run",
          child_id: childId,
          status: "success",
          commit,
          validation: { message: "sealed packet validation passed" },
        },
        null,
        2,
      ),
    );

    // Verify parent processed the sealed result and updated state and telemetry
    const updatedState = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(updatedState.status).toBe("cluster-complete");
    expect(updatedState.completed_children).toEqual([childId]);
    expect(updatedState.open_children).toEqual([]);
    expect(updatedState.next_open_child).toBeNull();
    expect(updatedState.last_commit).toBe(commit);
    expect(updatedState.context_budget).toMatchObject({ children_completed: 1 });

    const telemetry = readJsonLines(join(tmpDir, "runs", "sealed-packet-smoke-run", "telemetry.jsonl"));
    expect(telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "child-dispatched",
          child_id: childId,
          adapter: "agent-subtask",
          orchestration_mode: "ephemeral",
          provider: "agent-subtask",
        }),
        expect.objectContaining({
          event: "child-complete",
          child_id: childId,
          children_completed: 1,
          validation_summary: { message: "sealed packet validation passed" },
          commit_hash: commit,
        }),
      ]),
    );
  });
});
