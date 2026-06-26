import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const helper = join(process.cwd(), ".codex/plugins/polaris/skills/polaris-tools/tools.js");

function runHelper(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, PATH: options.path ?? "/definitely-no-polaris" };
  const result = spawnSync(process.execPath, [helper, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    json: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
  };
}

function tempRepoWithState(state) {
  const repo = mkdtempSync(join(tmpdir(), "polaris-tools-"));
  const stateDir = join(repo, ".taskchain_artifacts", "polaris-run");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "current-state.json"), JSON.stringify(state, null, 2));
  return repo;
}

describe("polaris Codex plugin helper", () => {
  it("ships a helper that runs inside a type module repository", () => {
    const repo = tempRepoWithState({
      run_id: "run-esm",
      cluster_id: "POL-ESM",
      status: "ready",
      active_child: null,
      completed_children: [],
      open_children: [],
    });
    const helperDir = join(repo, ".polaris", "skills", "polaris-tools");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module" }));
    copyFileSync(helper, join(helperDir, "tools.js"));

    const result = spawnSync(
      process.execPath,
      [join(helperDir, "tools.js"), "polaris_status"],
      {
        cwd: repo,
        env: { ...process.env, PATH: "/definitely-no-polaris" },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      tool: "polaris_status",
      run_id: "run-esm",
      cluster_id: "POL-ESM",
      status: "ready",
    });
  });

  it("returns a clear missing-binary error when status has no CLI and no state file", () => {
    const repo = mkdtempSync(join(tmpdir(), "polaris-tools-empty-"));

    const result = runHelper(["polaris_loop_status"], { cwd: repo });

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      tool: "polaris_loop_status",
      error: expect.stringContaining("polaris binary not found"),
    });
  });

  it("returns compact status from current-state.json when the CLI is unavailable", () => {
    const repo = tempRepoWithState({
      run_id: "run-123",
      cluster_id: "POL-97",
      status: "running",
      active_child: "",
      next_open_child: "POL-100",
      completed_children: ["POL-98", "POL-99"],
      open_children: ["POL-100", "POL-101"],
      updated_at: "2026-05-26T00:00:00.000Z",
      internal_notes: "must not be emitted",
    });

    const result = runHelper(["polaris_status"], { cwd: repo });

    expect(result.status).toBe(0);
    expect(result.json).toEqual({
      tool: "polaris_status",
      run_id: "run-123",
      cluster_id: "POL-97",
      status: "running",
      active_child: null,
      next_open_child: "POL-100",
      completed_children: ["POL-98", "POL-99"],
      open_children: ["POL-100", "POL-101"],
      updated_at: "2026-05-26T00:00:00.000Z",
    });
  });

  it("blocks direct run and ungated loop continue as operator-only", () => {
    const run = runHelper(["polaris_run", "POL-100"]);
    const loopContinue = runHelper(["polaris_loop_continue"]);

    expect(run.status).toBe(1);
    expect(run.json).toMatchObject({
      tool: "polaris_run",
      error: "operator_only",
    });
    expect(loopContinue.status).toBe(1);
    expect(loopContinue.json).toMatchObject({
      tool: "polaris_loop_continue",
      error: "operator_only",
    });
  });
});
