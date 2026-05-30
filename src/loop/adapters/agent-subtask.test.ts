import { describe, expect, it } from "vitest";
import { AgentSubtaskAdapter } from "./agent-subtask.js";
import type { BootstrapPacket } from "./types.js";
import { compileImplPacket, compileFinalizePacket } from "../worker-packet.js";

function makePacket(overrides: Partial<BootstrapPacket> = {}): BootstrapPacket {
  return {
    schema_version: "1.0",
    run_id: "run-001",
    cluster_id: "POL-105",
    active_child: "POL-110",
    state_file: "/repo/.taskchain_artifacts/polaris-run/current-state.json",
    telemetry_file: "/repo/.taskchain_artifacts/polaris-run/runs/run-001/telemetry.jsonl",
    context: { branch: "feature/pol-105" },
    ...overrides,
  };
}

describe("AgentSubtaskAdapter", () => {
  it("dispatches an ephemeral bootstrap packet through the native subtask dispatcher", async () => {
    const packet = makePacket();
    const adapter = new AgentSubtaskAdapter(async (request) => {
      expect(request.packet).toEqual(packet);
      expect(request.instructions).toContain("ephemeral");
      expect(request.instructions).toContain("POL-110");
      expect(request.returnContract).toEqual([
        "child_id",
        "status",
        "commit_hash",
        "validation_summary",
        "next_action",
        "warnings",
      ]);
      return {
        child_id: "POL-110",
        status: "done",
        commit_hash: "abc1234",
        validation_summary: "passed",
        next_action: "resume-parent",
        warnings: [],
      };
    });

    const result = await adapter.dispatch(packet, { provider: "agent-subtask" });

    expect(result).toMatchObject({
      exit_code: 0,
      provider_used: "agent-subtask",
      command_run: "agent-subtask:POL-110",
    });
    expect(JSON.parse(result.summary ?? "{}")).toMatchObject({
      child_id: "POL-110",
      status: "done",
      commit_hash: "abc1234",
    });
  });

  it("returns a dispatch error result when native subtask dispatch fails", async () => {
    const adapter = new AgentSubtaskAdapter(async () => {
      throw new Error("native dispatch unavailable");
    });

    const result = await adapter.dispatch(makePacket(), { provider: "agent-subtask" });

    expect(result.exit_code).toBe(1);
    expect(result.provider_used).toBe("agent-subtask");
    expect(result.stderr).toContain("native dispatch unavailable");
    expect(result.summary).toContain("native dispatch unavailable");
  });
});

// ── WorkerPacket (compiled) dispatch ──────────────────────────────────────────

const WORKER_PACKET_BASE = {
  runId: "run-001",
  clusterId: "POL-120",
  branch: "feature/pol-120",
  stateFile: "/repo/.taskchain_artifacts/polaris-run/current-state.json",
  telemetryFile: "/repo/.taskchain_artifacts/polaris-run/runs/run-001/telemetry.jsonl",
  allowedScope: ["src/**"],
};

describe("AgentSubtaskAdapter — compiled WorkerPacket", () => {
  it("uses pre-compiled instructions from WorkerPacket instead of generating them", async () => {
    const packet = compileImplPacket({ ...WORKER_PACKET_BASE, childId: "POL-121" });
    let capturedInstructions = "";

    const adapter = new AgentSubtaskAdapter(async (request) => {
      capturedInstructions = request.instructions;
      return {
        child_id: "POL-121",
        status: "done",
        commit_hash: "abc1234",
        validation_summary: "passed",
        next_action: "resume-parent",
        warnings: [],
      };
    });

    const result = await adapter.dispatch(packet, { provider: "agent-subtask" });
    expect(result.exit_code).toBe(0);

    // Compiled instructions must contain the primary_goal, not generic "ephemeral" boilerplate
    expect(capturedInstructions).toContain(packet.instructions.primary_goal);
    expect(capturedInstructions).toContain("impl");
    expect(capturedInstructions).toContain("TERMINATE");
  });

  it("includes lifecycle teardown notice in compiled instructions", async () => {
    const packet = compileImplPacket({ ...WORKER_PACKET_BASE, childId: "POL-121" });
    let capturedInstructions = "";

    const adapter = new AgentSubtaskAdapter(async (request) => {
      capturedInstructions = request.instructions;
      return { child_id: "POL-121", status: "done" };
    });

    await adapter.dispatch(packet, { provider: "agent-subtask" });
    expect(capturedInstructions).toContain("LIFECYCLE CONTRACT");
    expect(capturedInstructions).toContain("TERMINATE THIS SESSION IMMEDIATELY");
  });

  it("uses the return_contract from WorkerPacket, not the legacy fallback", async () => {
    const packet = compileImplPacket({ ...WORKER_PACKET_BASE, childId: "POL-121" });
    let capturedContract: string[] = [];

    const adapter = new AgentSubtaskAdapter(async (request) => {
      capturedContract = request.returnContract;
      return { child_id: "POL-121", status: "done" };
    });

    await adapter.dispatch(packet, { provider: "agent-subtask" });
    expect(capturedContract).toEqual(packet.return_contract);
    // Compiled contract must not contain legacy-only fields
    expect(capturedContract).not.toContain("commit_hash");
  });

  it("dispatches finalize worker with empty active_child correctly", async () => {
    const packet = compileFinalizePacket(WORKER_PACKET_BASE);
    const adapter = new AgentSubtaskAdapter(async (request) => {
      // Finalize worker returns run_id instead of child_id
      expect(request.instructions).toContain("finalize");
      return { run_id: "run-001", status: "done", pr_url: "https://example.com/pr/1" };
    });

    // Finalize packet has active_child = "" — validation should not check child_id mismatch
    const result = await adapter.dispatch(packet, { provider: "agent-subtask" });
    expect(result.exit_code).toBe(0);
  });

  it("accepts lifecycle sealed-result status values for finalize workers", async () => {
    const packet = compileFinalizePacket(WORKER_PACKET_BASE);
    const adapter = new AgentSubtaskAdapter(async () => ({
      run_id: "run-001",
      role: "finalize",
      status: "success",
      tracker_reconciliation_ready: true,
    }));

    const result = await adapter.dispatch(packet, { provider: "agent-subtask" });
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.summary ?? "{}")).toMatchObject({
      role: "finalize",
      status: "success",
    });
  });

  it("returns exit_code 1 with error when no dispatcher is configured", async () => {
    const packet = compileImplPacket({ ...WORKER_PACKET_BASE, childId: "POL-121" });
    const adapter = new AgentSubtaskAdapter(undefined);
    const result = await adapter.dispatch(packet, { provider: "agent-subtask" });
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("unavailable");
  });
});
