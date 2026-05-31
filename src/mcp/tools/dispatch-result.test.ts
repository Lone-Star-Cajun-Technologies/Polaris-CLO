import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePolarisDispatchResult } from "./dispatch-result.js";

const originalCwd = process.cwd();

function makeTempRepo(): string {
  return join(tmpdir(), `polaris-dispatch-result-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function writeState(repoRoot: string, artifactDir: string, state: Record<string, unknown>): void {
  const dir = join(repoRoot, ".taskchain_artifacts", artifactDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "current-state.json"), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function readState(repoRoot: string, artifactDir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(repoRoot, ".taskchain_artifacts", artifactDir, "current-state.json"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("handlePolarisDispatchResult()", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempRepo();
    mkdirSync(repoRoot, { recursive: true });
    process.chdir(repoRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("records a matching active_child result in state and telemetry", async () => {
    writeState(repoRoot, "polaris-run", {
      schema_version: "1.0",
      run_id: "run-result",
      cluster_id: "POL-105",
      active_child: "POL-111",
      open_children: ["POL-111", "POL-112"],
      completed_children: ["POL-110"],
      open_children_meta: {
        "POL-111": { title: "Add MCP tools", status: "Backlog" },
        "POL-112": { title: "Smoke test", status: "Backlog" },
      },
      context_budget: { children_completed: 5 },
      status: "running",
      step_cursor: "04-execute-child",
    });

    const result = await handlePolarisDispatchResult({
      child_id: "POL-111",
      status: "completed",
      commit: "abc1234",
      validation: ["npm test -- src/mcp/tools/claim-child.test.ts src/mcp/tools/dispatch-result.test.ts"],
    });

    expect(result["ok"]).toBe(true);
    const state = readState(repoRoot, "polaris-run");
    expect(state["active_child"]).toBeNull();
    expect(state["completed_children"]).toEqual(["POL-110", "POL-111"]);
    expect(state["open_children"]).toEqual(["POL-112"]);
    expect(state["next_open_child"]).toBe("POL-112");
    expect(state["last_commit"]).toBe("abc1234");
    expect((state["last_worker_result"] as Record<string, unknown>)["child_id"]).toBe("POL-111");

    const telemetry = readFileSync(
      join(repoRoot, ".taskchain_artifacts", "polaris-run", "runs", "run-result", "telemetry.jsonl"),
      "utf-8",
    );
    expect(telemetry).toContain("\"event\":\"mcp-dispatch-result\"");
    expect(telemetry).toContain("\"commit\":\"abc1234\"");
  });

  it("returns error when run_id is missing from state", async () => {
    writeState(repoRoot, "polaris-run", {
      schema_version: "1.0",
      cluster_id: "POL-105",
      active_child: "POL-111",
      open_children: ["POL-111"],
      completed_children: [],
      status: "running",
      step_cursor: "04-execute-child",
    });

    const result = await handlePolarisDispatchResult({
      child_id: "POL-111",
      status: "completed",
      commit: "abc1234",
      validation: "passed",
    });

    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("invalid_run_id");
    expect(typeof result["message"]).toBe("string");
    expect(result["message"]).toContain("run_id");
  });

  it("returns active_child_mismatch when the result does not match active_child", async () => {
    writeState(repoRoot, "polaris-run", {
      schema_version: "1.0",
      run_id: "run-result",
      cluster_id: "POL-105",
      active_child: "POL-110",
      open_children: ["POL-111"],
      completed_children: [],
      context_budget: { children_completed: 0 },
      status: "running",
      step_cursor: "04-execute-child",
    });

    const result = await handlePolarisDispatchResult({
      child_id: "POL-111",
      status: "completed",
      commit: "abc1234",
      validation: "passed",
    });

    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("active_child_mismatch");
    expect(result["expected"]).toBe("POL-110");
    expect(readState(repoRoot, "polaris-run")["active_child"]).toBe("POL-110");
  });
});
