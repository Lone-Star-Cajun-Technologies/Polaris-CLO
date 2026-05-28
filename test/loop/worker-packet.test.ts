import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { ExecutionAdapter, DispatchOptions, DispatchResult } from "../../src/loop/adapters/types.js";
import {
  isWorkerPacket,
  compileImplPacket,
  type WorkerPacket,
  type SealedWorkerResult,
} from "../../src/loop/worker-packet.js";
import type { LoopState } from "../../src/loop/checkpoint.js";
import { makeTempDir, writeStateFile } from "./test-utils.js";

// ──────────────────────────────────────────────────────────────────────────────
// Mock Execution Adapter for WorkerPacket smoke tests
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Test-only stub adapter that simulates a worker processing a WorkerPacket
 * and writing a SealedWorkerResult to the specified result_file.
 */
function makeMockWorkerPacketAdapter(): () => ExecutionAdapter {
  return () => ({
    name: "mock-worker-packet-adapter",
    async dispatch(
      packet: WorkerPacket, // Type assertion as WorkerPacket for this mock
      _options: DispatchOptions,
    ): Promise<DispatchResult> {
      // If it's a WorkerPacket and has a result_file_contract, write the result
      if (isWorkerPacket(packet) && packet.result_file_contract) {
        const resultFile = packet.result_file_contract.result_file;

        const sealedResult: SealedWorkerResult = {
          run_id: packet.run_id,
          child_id: packet.active_child,
          status: "success",
          commit: "test-commit-sha",
          validation: { checks: ["pass"] },
        };

        await mkdir(path.dirname(resultFile), { recursive: true });
        await writeFile(resultFile, JSON.stringify(sealedResult, null, 2), "utf-8");
      }

      return {
        exit_code: 0,
        provider_used: "mock-worker-packet-adapter",
        command_run: "mock-worker-command",
        summary: JSON.stringify({ status: "done", state_updated: true }),
      };
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Smoke tests for WorkerPacket dispatch
// ──────────────────────────────────────────────────────────────────────────────

describe("WorkerPacket Smoke Tests", () => {
  let testDir: string;
  let stateFile: string;
  let resultFilePath: string;

  beforeEach(async () => {
    testDir = makeTempDir();

    // Create a dummy state file (required by runLoopDispatch indirectly)
    const state: LoopState = {
      schema_version: "1.0",
      run_id: "test-run-id",
      cluster_id: "test-cluster-id",
      active_child: "",
      completed_children: [],
      open_children: ["POL-197"],
      step_cursor: null,
      context_budget: { children_completed: 0, max_children_per_session: 5 },
      status: "running",
      next_open_child: "POL-197",
      dispatch_boundary: { dispatch_epoch: 0, continue_epoch: 0, last_dispatched_child: null },
      run_bootstrap_seal: {
        run_id: "test-run-id",
        cluster_id: "test-cluster-id",
        open_children_fingerprint: "abc",
        telemetry_file: path.join(testDir, "telemetry.jsonl"),
      },
    };
    stateFile = writeStateFile(testDir, state);

    // Define a path for the sealed result file
    resultFilePath = path.join(testDir, "sealed-results", "pol-197-result.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("should dispatch a WorkerPacket and write a sealed result file", async () => {
    // Compile a WorkerPacket with result_file_contract
    const workerPacket: WorkerPacket = compileImplPacket({
      runId: "test-run-id",
      clusterId: "test-cluster-id",
      childId: "POL-197",
      branch: "test-branch",
      stateFile: stateFile,
      telemetryFile: path.join(testDir, "telemetry.jsonl"),
      issueContext: {
        id: "POL-197",
        title: "Provider smoke tests for sealed local packets",
        key_requirements: ["Implement tests"],
      },
      resultFile: resultFilePath, // This is key for sealed packets
    });

    // Manually call the mock adapter's dispatch method
    const adapter = makeMockWorkerPacketAdapter()();
    const dispatchResult = await adapter.dispatch(workerPacket, { provider: adapter.name });

    expect(dispatchResult.exit_code).toBe(0);
    expect(dispatchResult.provider_used).toBe(adapter.name);

    // Verify that the result file was created
    expect(existsSync(resultFilePath)).toBe(true);

    // Verify the content of the result file
    const rawResult = await readFile(resultFilePath, "utf-8");
    const sealedResult: SealedWorkerResult = JSON.parse(rawResult);

    expect(sealedResult.run_id).toBe("test-run-id");
    expect(sealedResult.child_id).toBe("POL-197");
    expect(sealedResult.status).toBe("success");
    expect(sealedResult.commit).toBe("test-commit-sha");
    expect(sealedResult.validation).toEqual({ checks: ["pass"] });
  });

  it("should not write a sealed result file if resultFile is not specified in WorkerPacket", async () => {
    // Compile a WorkerPacket without result_file_contract
    const workerPacket: WorkerPacket = compileImplPacket({
      runId: "test-run-id",
      clusterId: "test-cluster-id",
      childId: "POL-197-no-sealed-file",
      branch: "test-branch",
      stateFile: stateFile,
      telemetryFile: path.join(testDir, "telemetry.jsonl"),
      issueContext: {
        id: "POL-197-no-sealed-file",
        title: "No sealed result file expected",
        key_requirements: [],
      },
      // resultFile is intentionally omitted
    });

    const adapter = makeMockWorkerPacketAdapter()();
    await adapter.dispatch(workerPacket, { provider: adapter.name });

    // Verify that no result file was created for this packet
    const nonSealedResultFilePath = path.join(testDir, "sealed-results", "pol-197-no-sealed-file-result.json");
    expect(existsSync(nonSealedResultFilePath)).toBe(false);
  });
});
