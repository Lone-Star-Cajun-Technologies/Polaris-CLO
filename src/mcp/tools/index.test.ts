/**
 * Unit tests for src/mcp/tools/index.ts
 *
 * Covers:
 * - dispatchTool() returns unknown_tool error for unregistered tool name
 * - TOOLS array contains the expected tools
 * - dispatchTool() result has content array with a text item containing valid JSON
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the handler modules before importing index.ts
vi.mock("./status.js", () => ({
  handlePolarisStatus: vi.fn().mockResolvedValue({ ok: true, status: "running" }),
  handlePolarisLoopStatus: vi.fn().mockResolvedValue({ ok: true, status: "idle" }),
}));

vi.mock("./current-state.js", () => ({
  handlePolarisCurrentState: vi.fn().mockResolvedValue({
    ok: true,
    artifact_dir: "polaris-run",
    state: { run_id: "test-run" },
  }),
}));

vi.mock("./loop-dry-run.js", () => ({
  handleLoopContinueDryRun: vi.fn().mockResolvedValue({ ok: true, eligible: true }),
}));

vi.mock("./loop-continue.js", () => ({
  handleLoopContinueConfirmed: vi.fn().mockResolvedValue({
    ok: true,
    next_child: "POL-85",
    message: "Continuation approved. Worker dispatch is not yet implemented.",
  }),
}));

vi.mock("./linear.js", () => ({
  LINEAR_TOOLS: [
    { name: "linear_list_issues", description: "List Linear issues", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "linear_save_issue", description: "Save a Linear issue", inputSchema: { type: "object", properties: {}, required: [] } },
  ],
  handleLinearListIssues: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
  handleLinearSaveIssue: vi.fn().mockResolvedValue({ ok: true }),
}));

import { TOOLS, dispatchTool } from "./index.js";
import { handlePolarisStatus, handlePolarisLoopStatus } from "./status.js";
import { handlePolarisCurrentState } from "./current-state.js";
import { handleLoopContinueConfirmed } from "./loop-continue.js";

const mockHandlePolarisStatus = vi.mocked(handlePolarisStatus);
const mockHandlePolarisLoopStatus = vi.mocked(handlePolarisLoopStatus);
const mockHandlePolarisCurrentState = vi.mocked(handlePolarisCurrentState);
const mockHandleLoopContinueConfirmed = vi.mocked(handleLoopContinueConfirmed);

describe("TOOLS array", () => {
  it("has exactly 9 tools", () => {
    expect(TOOLS).toHaveLength(9);
  });

  it("contains polaris_status", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("polaris_status");
  });

  it("contains polaris_loop_status", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("polaris_loop_status");
  });

  it("contains polaris_current_state", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("polaris_current_state");
  });

  it("contains polaris_loop_continue_dry_run", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("polaris_loop_continue_dry_run");
  });

  it("contains polaris_loop_continue_confirmed", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("polaris_loop_continue_confirmed");
  });

  it("has the exact set of tools", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      "linear_list_issues",
      "linear_save_issue",
      "polaris_claim_child",
      "polaris_current_state",
      "polaris_dispatch_result",
      "polaris_loop_continue_confirmed",
      "polaris_loop_continue_dry_run",
      "polaris_loop_status",
      "polaris_status",
    ]);
  });
});

describe("dispatchTool()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an unknown_tool error for an unregistered tool name", async () => {
    const response = await dispatchTool("nonexistent_tool", {});
    expect(response.content).toHaveLength(1);
    expect(response.content[0]?.type).toBe("text");
    const parsed = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(false);
    expect(parsed["error"]).toBe("unknown_tool");
  });

  it("result has a content array with at least one item", async () => {
    const response = await dispatchTool("polaris_status", {});
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content.length).toBeGreaterThan(0);
  });

  it("result content item has type 'text'", async () => {
    const response = await dispatchTool("polaris_status", {});
    expect(response.content[0]?.type).toBe("text");
  });

  it("result content text item contains valid JSON", async () => {
    const response = await dispatchTool("polaris_status", {});
    expect(() => JSON.parse(response.content[0]!.text)).not.toThrow();
  });

  it("dispatches polaris_status to handlePolarisStatus", async () => {
    mockHandlePolarisStatus.mockResolvedValue({ ok: true, run_id: "pol-test" });
    const response = await dispatchTool("polaris_status", {});
    expect(mockHandlePolarisStatus).toHaveBeenCalledOnce();
    const parsed = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(true);
    expect(parsed["run_id"]).toBe("pol-test");
  });

  it("dispatches polaris_loop_status to handlePolarisLoopStatus", async () => {
    mockHandlePolarisLoopStatus.mockResolvedValue({ ok: true, status: "loop-running" });
    const response = await dispatchTool("polaris_loop_status", {});
    expect(mockHandlePolarisLoopStatus).toHaveBeenCalledOnce();
    const parsed = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(true);
    expect(parsed["status"]).toBe("loop-running");
  });

  it("dispatches polaris_current_state to handlePolarisCurrentState", async () => {
    mockHandlePolarisCurrentState.mockResolvedValue({
      ok: true,
      artifact_dir: "polaris-run",
      state: { run_id: "state-test" },
    });
    const response = await dispatchTool("polaris_current_state", { artifact_dir: "polaris-run" });
    expect(mockHandlePolarisCurrentState).toHaveBeenCalledOnce();
    expect(mockHandlePolarisCurrentState).toHaveBeenCalledWith({ artifact_dir: "polaris-run" });
    const parsed = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(true);
    expect(parsed["artifact_dir"]).toBe("polaris-run");
  });

  it("dispatches polaris_loop_continue_confirmed to handleLoopContinueConfirmed", async () => {
    mockHandleLoopContinueConfirmed.mockResolvedValue({
      ok: true,
      next_child: "POL-85",
      message: "Continuation approved. Worker dispatch is not yet implemented.",
    });
    const envelopeArgs = {
      artifact_dir: "polaris-run",
      run_id: "run-123",
      expected_step_cursor: "06-decide-continuation",
      fingerprint: "abc123",
      runtime_generation: 1,
      issued_at: "2026-05-25T00:00:00.000Z",
      expires_at: "2026-05-25T01:00:00.000Z",
      nonce: "nonce-xyz",
      requested_action: "loop_continue",
    };
    const response = await dispatchTool("polaris_loop_continue_confirmed", envelopeArgs);
    expect(mockHandleLoopContinueConfirmed).toHaveBeenCalledOnce();
    expect(mockHandleLoopContinueConfirmed).toHaveBeenCalledWith(envelopeArgs);
    const parsed = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(true);
    expect(parsed["next_child"]).toBe("POL-85");
  });

  it("unknown_tool error message includes the tool name", async () => {
    const response = await dispatchTool("made_up_tool", {});
    const parsed = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(parsed["message"]).toContain("made_up_tool");
  });
});
