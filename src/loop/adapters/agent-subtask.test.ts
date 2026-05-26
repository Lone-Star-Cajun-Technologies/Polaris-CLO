import { describe, expect, it } from "vitest";
import { AgentSubtaskAdapter } from "./agent-subtask.js";
import type { BootstrapPacket } from "./types.js";

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
