import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateDeliveryIntegrity } from "./delivery-integrity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

function makeRepo(label: string): string {
  const dir = join(process.cwd(), `.vitest-delivery-integrity-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@polaris.test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Polaris Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
  writeFile(dir, "README.md", "seed\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function commitFile(dir: string, rel: string, content: string): string {
  writeFile(dir, rel, content);
  execFileSync("git", ["add", rel], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", `add ${rel}`], { cwd: dir, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
}

function createBranch(dir: string, name: string): void {
  execFileSync("git", ["checkout", "-b", name], { cwd: dir, stdio: "pipe" });
}

function checkoutBranch(dir: string, name: string): void {
  execFileSync("git", ["checkout", name], { cwd: dir, stdio: "pipe" });
}

function stageFile(dir: string, rel: string, content: string): void {
  writeFile(dir, rel, content);
  execFileSync("git", ["add", rel], { cwd: dir, stdio: "pipe" });
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const CLUSTER_ID = "POL-289";

function baseOpts(dir: string, overrides: Partial<{
  currentBranch: string;
  baseBranch: string;
  completedChildren: string[];
  childCommits: Record<string, string>;
}> = {}) {
  return {
    repoRoot: dir,
    currentBranch: overrides.currentBranch ?? "pol-289-delivery",
    baseBranch: overrides.baseBranch ?? "main",
    clusterId: CLUSTER_ID,
    completedChildren: overrides.completedChildren ?? ["POL-290", "POL-291"],
    childCommits: overrides.childCommits ?? {},
  };
}

// ---------------------------------------------------------------------------
// Test 1: Artifact-only delivery branch
// Branch has only cluster artifact commits — no source implementation files.
// ---------------------------------------------------------------------------
describe("validateDeliveryIntegrity — artifact-only delivery branch", () => {
  it("rejects a branch that contains only cluster artifact files", () => {
    const dir = makeRepo("artifact-only");
    createBranch(dir, "pol-289-delivery");

    // Commit only a Polaris cluster artifact (promoted-cluster-artifact for active cluster)
    commitFile(
      dir,
      ".polaris/clusters/POL-289/results/POL-290.json",
      '{"status":"done"}\n',
    );

    const result = validateDeliveryIntegrity(baseOpts(dir));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("artifact-only");
    expect(result.reason).toContain("artifact");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Map-only delivery branch with all child commits already on base
// This is the exact PR #93 failure mode.
// ---------------------------------------------------------------------------
describe("validateDeliveryIntegrity — map-only delivery branch (PR #93 scenario)", () => {
  it("rejects when branch has only map artifacts and implementation is already on main", () => {
    const dir = makeRepo("map-only");

    // Implementation commits happen on main (simulating POL-290..POL-294 landing on main)
    const implCommit1 = commitFile(dir, "src/feature-a.ts", "export const a = 1;\n");
    const implCommit2 = commitFile(dir, "src/feature-b.ts", "export const b = 2;\n");

    // Delivery branch is created AFTER implementation is already on main
    createBranch(dir, "pol-289-delivery");

    // Only map artifacts are committed to the delivery branch
    commitFile(dir, ".polaris/map/index.json", '{"files":{}}\n');
    commitFile(dir, ".polaris/map/needs-review.json", '[]\n');

    const result = validateDeliveryIntegrity(
      baseOpts(dir, {
        childCommits: {
          "POL-290": implCommit1,
          "POL-291": implCommit2,
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("impl-already-on-base");
    expect(result.reason).toContain("POL-290");
    expect(result.reason).toContain("POL-291");
    expect(result.reason).toContain("main");
  });

  it("rejects with map-only kind when branch has only map files and no child commits recorded", () => {
    const dir = makeRepo("map-only-no-commits");
    createBranch(dir, "pol-289-delivery");

    commitFile(dir, ".polaris/map/index.json", '{"files":{}}\n');
    commitFile(dir, ".polaris/map/needs-review.json", '[]\n');

    const result = validateDeliveryIntegrity(baseOpts(dir, { childCommits: {} }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("map-only");
    expect(result.reason).toContain("map artifact");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Telemetry-only delivery branch
// Branch has only the run ledger (promoted-run-ledger).
// ---------------------------------------------------------------------------
describe("validateDeliveryIntegrity — telemetry-only delivery branch", () => {
  it("rejects a branch containing only the run ledger", () => {
    const dir = makeRepo("telemetry-only");
    createBranch(dir, "pol-289-delivery");

    commitFile(dir, ".polaris/runs/ledger.jsonl", '{"event":"run-complete"}\n');

    const result = validateDeliveryIntegrity(baseOpts(dir, { childCommits: {} }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("telemetry-only");
    expect(result.reason).toContain("telemetry");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Missing implementation commits (empty branch relative to base)
// Branch was created from main but nothing was committed to it.
// ---------------------------------------------------------------------------
describe("validateDeliveryIntegrity — empty delivery branch", () => {
  it("rejects a branch with no changes relative to the base branch", () => {
    const dir = makeRepo("empty-branch");

    // Create delivery branch but commit nothing to it
    createBranch(dir, "pol-289-delivery");

    // No staged files either
    const result = validateDeliveryIntegrity(baseOpts(dir, { childCommits: {} }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("empty-branch");
    expect(result.reason).toContain("Nothing to deliver");
  });

  it("rejects when branch has no commits and child commits with no recorded hashes", () => {
    const dir = makeRepo("empty-branch-no-hashes");
    createBranch(dir, "pol-289-delivery");

    const result = validateDeliveryIntegrity(
      baseOpts(dir, {
        completedChildren: ["POL-290"],
        childCommits: {}, // No commit hashes recorded
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("empty-branch");
  });
});

// ---------------------------------------------------------------------------
// Test 5: Child completion with no corresponding implementation diff
// Children are recorded as completed with commit hashes, but their commits
// only changed artifact files — not source implementation files.
// The delivery branch also has no non-artifact source files.
// ---------------------------------------------------------------------------
describe("validateDeliveryIntegrity — child with artifact-only commit, no impl diff", () => {
  it("rejects when all child commits are artifact-only and branch diff is artifact-only", () => {
    const dir = makeRepo("artifact-child");

    // Worker commits only an artifact file (cluster result) on the delivery branch
    createBranch(dir, "pol-289-delivery");
    const artifactCommit = commitFile(
      dir,
      ".polaris/clusters/POL-289/results/POL-290.json",
      '{"status":"done"}\n',
    );

    // The child is recorded as completed with this commit hash
    const result = validateDeliveryIntegrity(
      baseOpts(dir, {
        completedChildren: ["POL-290"],
        childCommits: { "POL-290": artifactCommit },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The artifact commit is NOT on main, so kind should NOT be impl-already-on-base.
    // It should be artifact-only because there are no impl source files in the diff.
    expect(result.kind).toBe("artifact-only");
  });

  it("rejects when multiple children have only artifact commits and none are on base", () => {
    const dir = makeRepo("multi-artifact-child");
    createBranch(dir, "pol-289-delivery");

    const commit1 = commitFile(dir, ".polaris/map/index.json", '{"v":1}\n');
    const commit2 = commitFile(dir, ".polaris/runs/ledger.jsonl", '{"event":"run"}\n');

    const result = validateDeliveryIntegrity(
      baseOpts(dir, {
        completedChildren: ["POL-290", "POL-291"],
        childCommits: { "POL-290": commit1, "POL-291": commit2 },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["artifact-only", "runtime-artifacts-only", "map-only", "telemetry-only"]).toContain(
      result.kind,
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6: Valid implementation branch
// Branch has real source file commits.
// ---------------------------------------------------------------------------
describe("validateDeliveryIntegrity — valid implementation branch", () => {
  it("accepts a branch with committed non-artifact source files", () => {
    const dir = makeRepo("valid-impl");
    createBranch(dir, "pol-289-delivery");

    commitFile(dir, "src/new-feature.ts", "export const feature = true;\n");

    const result = validateDeliveryIntegrity(baseOpts(dir));

    expect(result.ok).toBe(true);
  });

  it("accepts a branch where implementation is staged (not yet committed)", () => {
    const dir = makeRepo("valid-staged");
    createBranch(dir, "pol-289-delivery");

    // Implementation is staged for the finalize commit, not yet in committed history
    stageFile(dir, "src/impl.ts", "export const impl = 1;\n");

    const result = validateDeliveryIntegrity(baseOpts(dir));

    expect(result.ok).toBe(true);
  });

  it("accepts when branch has both implementation commits and cluster artifacts", () => {
    const dir = makeRepo("valid-impl-with-artifacts");
    createBranch(dir, "pol-289-delivery");

    // Implementation commit from worker
    const implCommit = commitFile(dir, "src/feature.ts", "export const x = 1;\n");
    // Map artifact from finalize step
    commitFile(dir, ".polaris/map/index.json", '{"files":{}}\n');

    const result = validateDeliveryIntegrity(
      baseOpts(dir, {
        completedChildren: ["POL-290"],
        childCommits: { "POL-290": implCommit },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("accepts when implementation is in committed history even though staging is artifact-only", () => {
    const dir = makeRepo("valid-committed-impl");
    createBranch(dir, "pol-289-delivery");

    // Worker committed implementation on the delivery branch
    commitFile(dir, "src/resolver.ts", "export const resolve = () => {};\n");

    // Only artifacts staged now (as would be typical during finalize)
    stageFile(dir, ".polaris/clusters/POL-289/results/POL-290.json", '{"done":true}\n');

    const result = validateDeliveryIntegrity(baseOpts(dir));

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Additional: partial child commits already on base (not all)
// ---------------------------------------------------------------------------
describe("validateDeliveryIntegrity — partial commits on base", () => {
  it("accepts when some child commits are on base but delivery branch has new impl work", () => {
    const dir = makeRepo("partial-on-base");

    // One implementation commit on main (for POL-290)
    const commitOnMain = commitFile(dir, "src/part-a.ts", "export const a = 1;\n");

    // Delivery branch with additional implementation (for POL-291)
    createBranch(dir, "pol-289-delivery");
    commitFile(dir, "src/part-b.ts", "export const b = 2;\n");

    const result = validateDeliveryIntegrity(
      baseOpts(dir, {
        completedChildren: ["POL-290", "POL-291"],
        childCommits: {
          "POL-290": commitOnMain, // already on main
          // POL-291 has no commit hash — only part-b.ts is in the branch diff
        },
      }),
    );

    // Branch has src/part-b.ts which is non-artifact, so it should pass.
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge case: baseBranch === currentBranch (direct-main scenarios)
// ---------------------------------------------------------------------------
describe("validateDeliveryIntegrity — same base and current branch", () => {
  it("passes when staged files contain non-artifact source changes", () => {
    const dir = makeRepo("same-branch-staged");
    // Running on main directly; branch === base branch

    stageFile(dir, "src/hotfix.ts", "export const fix = true;\n");

    const result = validateDeliveryIntegrity(
      baseOpts(dir, { currentBranch: "main", baseBranch: "main" }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects when same branch and nothing staged or in diff", () => {
    const dir = makeRepo("same-branch-empty");

    const result = validateDeliveryIntegrity(
      baseOpts(dir, { currentBranch: "main", baseBranch: "main", childCommits: {} }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("empty-branch");
  });
});
