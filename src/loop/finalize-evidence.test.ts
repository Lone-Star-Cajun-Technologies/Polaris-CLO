import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { verifyCompletedChildFinalizeEvidence } from "./finalize-evidence.js";

function initRepo(repoRoot: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Polaris Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "polaris@example.com"], { cwd: repoRoot, stdio: "pipe" });
  writeFileSync(join(repoRoot, "README.md"), "seed\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: repoRoot, stdio: "pipe" });
}

function writeJson(repoRoot: string, relativePath: string, value: unknown): void {
  const fullPath = join(repoRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function makeCommit(repoRoot: string, filePath: string, content: string): string {
  const fullPath = join(repoRoot, filePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  execFileSync("git", ["add", filePath], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", `update ${filePath}`], { cwd: repoRoot, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim();
}

function makeStateBase(childId: string) {
  return {
    schema_version: "1.0",
    run_id: "run-1",
    cluster_id: "POL-999",
    active_child: "",
    completed_children: [childId],
    open_children: [],
    open_children_meta: {
      [childId]: {
        dispatch_record: {
          packet_path: `.polaris/clusters/POL-999/packets/${childId}.json`,
          expected_result_path: `.polaris/clusters/POL-999/results/${childId}.json`,
        },
      },
    },
    step_cursor: null,
    context_budget: {
      children_completed: 1,
    },
    status: "running",
    next_open_child: null,
  };
}

const createdDirs: string[] = [];

function makeRepo(name: string): string {
  const repoRoot = join(process.cwd(), `.vitest-finalize-evidence-${name}-${Date.now()}`);
  mkdirSync(repoRoot, { recursive: true });
  createdDirs.push(repoRoot);
  initRepo(repoRoot);
  return repoRoot;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("verifyCompletedChildFinalizeEvidence", () => {
  it("fails and lists children when commit evidence is empty", () => {
    const repoRoot = makeRepo("empty-commit");
    const childId = "POL-1";
    const state = makeStateBase(childId);

    writeJson(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json", state);
    writeJson(repoRoot, ".polaris/clusters/POL-999/packets/POL-1.json", {
      instructions: {},
    });
    writeJson(repoRoot, ".polaris/clusters/POL-999/results/POL-1.json", {
      child_id: childId,
      status: "done",
      validation: { passed: ["npm test"] },
    });
    writeJson(repoRoot, ".polaris/clusters/POL-999/cluster-state.json", {
      commits: {},
      validation_results: {},
    });

    const report = verifyCompletedChildFinalizeEvidence(
      repoRoot,
      join(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json"),
    );

    expect(report.ok).toBe(false);
    expect(report.failures[0]?.childId).toBe(childId);
    expect(report.failures[0]?.reasons.join(" ")).toContain("no commit hash");
  });

  it("passes artifact-only commit when packet sets artifact_only true", () => {
    const repoRoot = makeRepo("artifact-only-pass");
    const childId = "POL-2";
    const state = makeStateBase(childId);
    const commit = makeCommit(
      repoRoot,
      ".polaris/clusters/POL-999/results/POL-2-evidence.json",
      "{\"ok\":true}\n",
    );

    writeJson(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json", state);
    writeJson(repoRoot, ".polaris/clusters/POL-999/packets/POL-2.json", {
      instructions: { artifact_only: true },
    });
    writeJson(repoRoot, ".polaris/clusters/POL-999/results/POL-2.json", {
      child_id: childId,
      status: "done",
      commit,
      validation: { passed: ["npm run build"] },
    });
    writeJson(repoRoot, ".polaris/clusters/POL-999/cluster-state.json", {
      commits: {},
      validation_results: {},
    });

    const report = verifyCompletedChildFinalizeEvidence(
      repoRoot,
      join(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json"),
    );
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("passes real implementation child with non-artifact diff and passed validation", () => {
    const repoRoot = makeRepo("impl-pass");
    const childId = "POL-3";
    const state = makeStateBase(childId);
    const commit = makeCommit(repoRoot, "src/cli/new-feature.ts", "export const x = 1;\n");

    writeJson(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json", state);
    writeJson(repoRoot, ".polaris/clusters/POL-999/packets/POL-3.json", {
      instructions: {},
    });
    writeJson(repoRoot, ".polaris/clusters/POL-999/results/POL-3.json", {
      child_id: childId,
      status: "done",
      commit,
      validation: "passed",
    });
    writeJson(repoRoot, ".polaris/clusters/POL-999/cluster-state.json", {
      commits: {},
      validation_results: {},
    });

    const report = verifyCompletedChildFinalizeEvidence(
      repoRoot,
      join(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json"),
    );
    expect(report.ok).toBe(true);
  });

  it("rejects artifact-only commit when packet does not set artifact_only true", () => {
    const repoRoot = makeRepo("artifact-only-reject");
    const childId = "POL-4";
    const state = makeStateBase(childId);
    const commit = makeCommit(
      repoRoot,
      ".polaris/clusters/POL-999/results/POL-4-evidence.json",
      "{\"ok\":true}\n",
    );

    writeJson(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json", state);
    writeJson(repoRoot, ".polaris/clusters/POL-999/packets/POL-4.json", {
      instructions: {},
    });
    writeJson(repoRoot, ".polaris/clusters/POL-999/results/POL-4.json", {
      child_id: childId,
      status: "done",
      commit,
      validation: { passed: ["npm run build"] },
    });
    writeJson(repoRoot, ".polaris/clusters/POL-999/cluster-state.json", {
      commits: {},
      validation_results: {},
    });

    const report = verifyCompletedChildFinalizeEvidence(
      repoRoot,
      join(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json"),
    );
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.reasons.join(" ")).toContain("artifact_only: true");
  });

  it("passes finalize when cluster-state has bridged commit+validation and open_children_meta is absent for completed child", () => {
    // Simulates the state after loop continue bridges evidence: no open_children_meta for the
    // completed child, but cluster-state.commits and cluster-state.validation_results are set.
    const repoRoot = makeRepo("bridge-pass");
    const childId = "POL-5";
    const commit = makeCommit(repoRoot, "src/feature.ts", "export const x = 1;\n");

    const stateWithoutMeta = {
      schema_version: "1.0",
      run_id: "run-1",
      cluster_id: "POL-999",
      active_child: "",
      completed_children: [childId],
      open_children: [],
      // no open_children_meta for childId — it was pruned by loop continue
      open_children_meta: {},
      step_cursor: null,
      context_budget: { children_completed: 1 },
      status: "cluster-complete",
      next_open_child: null,
    };

    writeJson(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json", stateWithoutMeta);
    // cluster-state has the bridged evidence written by loop continue
    writeJson(repoRoot, ".polaris/clusters/POL-999/cluster-state.json", {
      commits: { [childId]: commit },
      result_pointers: {},
      validation_results: { [childId]: { passed: true, output: "npm test" } },
    });

    const report = verifyCompletedChildFinalizeEvidence(
      repoRoot,
      join(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json"),
    );
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("still fails finalize when cluster-state has no evidence and open_children_meta is absent", () => {
    // Confirms finalize does not infer success from completed_children alone.
    const repoRoot = makeRepo("bridge-absent");
    const childId = "POL-6";

    const stateWithoutMeta = {
      schema_version: "1.0",
      run_id: "run-1",
      cluster_id: "POL-999",
      active_child: "",
      completed_children: [childId],
      open_children: [],
      open_children_meta: {},
      step_cursor: null,
      context_budget: { children_completed: 1 },
      status: "cluster-complete",
      next_open_child: null,
    };

    writeJson(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json", stateWithoutMeta);
    writeJson(repoRoot, ".polaris/clusters/POL-999/cluster-state.json", {
      commits: {},
      result_pointers: {},
      validation_results: {},
    });

    const report = verifyCompletedChildFinalizeEvidence(
      repoRoot,
      join(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json"),
    );
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.childId).toBe(childId);
    expect(report.failures[0]?.reasons.join(" ")).toContain("no commit hash");
  });
});
