import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePolarisClaimChild } from "./claim-child.js";

const originalCwd = process.cwd();

function makeTempRepo(): string {
  return join(tmpdir(), `polaris-claim-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("handlePolarisClaimChild()", () => {
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

  it("sets active_child for an open child and appends telemetry", async () => {
    writeState(repoRoot, "polaris-run", {
      schema_version: "1.0",
      run_id: "run-claim",
      cluster_id: "POL-105",
      active_child: null,
      open_children: ["POL-111"],
      completed_children: [],
      context_budget: { children_completed: 0 },
      status: "running",
      step_cursor: "03-select-child",
    });

    const result = await handlePolarisClaimChild({ child_id: "POL-111" });

    expect(result["ok"]).toBe(true);
    expect(result["active_child"]).toBe("POL-111");
    expect(readState(repoRoot, "polaris-run")["active_child"]).toBe("POL-111");

    const telemetry = readFileSync(
      join(repoRoot, ".taskchain_artifacts", "polaris-run", "runs", "run-claim", "telemetry.jsonl"),
      "utf-8",
    );
    expect(telemetry).toContain("\"event\":\"mcp-claim-child\"");
    expect(telemetry).toContain("\"child_id\":\"POL-111\"");
  });

  it("returns already_claimed when active_child is already set", async () => {
    writeState(repoRoot, "polaris-run", {
      schema_version: "1.0",
      run_id: "run-claim",
      cluster_id: "POL-105",
      active_child: "POL-110",
      open_children: ["POL-111"],
      completed_children: [],
      context_budget: { children_completed: 0 },
      status: "running",
      step_cursor: "03-select-child",
    });

    const result = await handlePolarisClaimChild({ child_id: "POL-111" });

    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("already_claimed");
    expect(result["active_child"]).toBe("POL-110");
    expect(readState(repoRoot, "polaris-run")["active_child"]).toBe("POL-110");
  });
});
