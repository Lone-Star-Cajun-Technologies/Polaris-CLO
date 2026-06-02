/**
 * Git branch custody tests.
 *
 * Covers:
 *   - assertNotOnBaseBranch rejects dispatch on main/master/etc.
 *   - assertDeliveryBranchMatch fails when branches differ
 *   - verifyChildCommitCustody blocks commits already on base branch
 *   - hasNonArtifactSourceChanges excludes .polaris and .taskchain_artifacts
 *   - runLoopDispatch refuses to dispatch on base/main branch
 *   - runLoopDispatch records delivery branch in cluster state on first dispatch
 *   - runLoopDispatch fails when current branch does not match recorded delivery branch
 *   - runLoopContinue rejects commit evidence when commit is already on base branch
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  isProtectedBranch,
  assertNotOnBaseBranch,
  assertDeliveryBranchMatch,
  verifyChildCommitCustody,
  hasNonArtifactSourceChanges,
  buildCustodyRecord,
  buildDeliveryBranchName,
  BranchCustodyViolation,
  PROTECTED_BASE_BRANCHES,
} from "../../src/loop/git-custody.js";
import { runLoopDispatch } from "../../src/loop/dispatch.js";
import { runLoopContinue } from "../../src/loop/continue.js";
import { readState } from "../../src/loop/checkpoint.js";
import { readClusterStateSync } from "../../src/cluster-state/store.js";
import type { LoopState } from "../../src/loop/checkpoint.js";
import { createBootstrapSeal } from "../../src/loop/run-bootstrap.js";
import { initialDispatchBoundary } from "../../src/loop/dispatch-boundary.js";

// ──────────────────────────────────────────────────────────────────────────────
// Git repo helper — creates a real git repo so git commands work
// ──────────────────────────────────────────────────────────────────────────────

function makeGitRepo(branchName = "delivery/pol-268"): {
  dir: string;
  mainSha: string;
} {
  const dir = join(tmpdir(), `polaris-custody-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

  git("init", "-b", "main");
  git("config", "user.email", "test@polaris.local");
  git("config", "user.name", "Polaris Test");
  git("config", "commit.gpgsign", "false");

  // Initial commit on main
  writeFileSync(join(dir, "README.md"), "# Polaris\n");
  git("add", "README.md");
  git("commit", "-m", "chore: init");
  const mainSha = git("rev-parse", "HEAD").trim();

  // Create delivery branch
  git("checkout", "-b", branchName);

  return { dir, mainSha };
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `polaris-custody-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  // Fake git dir so getCurrentBranch falls back to env
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** Real git repo that stays on main (no delivery branch created). */
function makeMainRepo(): { dir: string; mainSha: string } {
  const dir = join(tmpdir(), `polaris-custody-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

  git("init", "-b", "main");
  git("config", "user.email", "test@polaris.local");
  git("config", "user.name", "Polaris Test");
  git("config", "commit.gpgsign", "false");

  writeFileSync(join(dir, "README.md"), "# Polaris\n");
  git("add", "README.md");
  git("commit", "-m", "chore: init");
  const mainSha = git("rev-parse", "HEAD").trim();

  return { dir, mainSha };
}

const MINIMAL_CHILD_BODY =
  "## Goal\nImplement the fix.\n\n## Scope\n- src/**\n\n## Validation\n- npm test";

function makeFreshState(overrides: Partial<LoopState> = {}): LoopState {
  const runId = "polaris-run-custody-test-001";
  const clusterId = "POL-268";
  return {
    schema_version: "1.0",
    run_id: runId,
    cluster_id: clusterId,
    active_child: "",
    completed_children: [],
    open_children: ["POL-268-1"],
    open_children_meta: {
      "POL-268-1": { title: "Fix POL-268-1", body: MINIMAL_CHILD_BODY },
    },
    step_cursor: null,
    context_budget: { children_completed: 0, max_children_per_session: 5 },
    status: "running",
    next_open_child: "POL-268-1",
    dispatch_boundary: initialDispatchBoundary(),
    run_bootstrap_seal: createBootstrapSeal(runId, clusterId, ["POL-268-1"]),
    ...overrides,
  };
}

function writeStateFile(dir: string, state: Partial<LoopState> & { run_id: string }): string {
  const stateDir = join(dir, ".polaris", "runs");
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "current-state.json");
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests for git-custody helpers
// ──────────────────────────────────────────────────────────────────────────────

describe("isProtectedBranch", () => {
  it("returns true for main", () => expect(isProtectedBranch("main")).toBe(true));
  it("returns true for master", () => expect(isProtectedBranch("master")).toBe(true));
  it("returns true for develop", () => expect(isProtectedBranch("develop")).toBe(true));
  it("returns true for staging", () => expect(isProtectedBranch("staging")).toBe(true));
  it("returns false for a delivery branch", () =>
    expect(isProtectedBranch("pol-268-recovery")).toBe(false));
  it("returns false for feature branches", () =>
    expect(isProtectedBranch("feat/my-feature")).toBe(false));
  it("is case-insensitive", () => expect(isProtectedBranch("MAIN")).toBe(true));
  it("PROTECTED_BASE_BRANCHES set contains expected entries", () => {
    expect(PROTECTED_BASE_BRANCHES.has("main")).toBe(true);
    expect(PROTECTED_BASE_BRANCHES.has("master")).toBe(true);
  });
});

describe("assertNotOnBaseBranch", () => {
  it("throws BranchCustodyViolation on main", () => {
    expect(() => assertNotOnBaseBranch("main")).toThrow(BranchCustodyViolation);
  });
  it("throws on master", () => {
    expect(() => assertNotOnBaseBranch("master")).toThrow(BranchCustodyViolation);
  });
  it("does not throw on a delivery branch", () => {
    expect(() => assertNotOnBaseBranch("pol-268-delivery")).not.toThrow();
  });
  it("error message contains the branch name", () => {
    expect(() => assertNotOnBaseBranch("main")).toThrow(/\"main\"/);
  });
});

describe("assertDeliveryBranchMatch", () => {
  it("passes when branches match", () => {
    expect(() =>
      assertDeliveryBranchMatch("pol-268-delivery", "pol-268-delivery"),
    ).not.toThrow();
  });
  it("throws when branches differ", () => {
    expect(() =>
      assertDeliveryBranchMatch("other-branch", "pol-268-delivery"),
    ).toThrow(BranchCustodyViolation);
  });
  it("error message includes both branch names", () => {
    try {
      assertDeliveryBranchMatch("wrong", "pol-268-delivery");
      expect.fail("should have thrown");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("wrong");
      expect(msg).toContain("pol-268-delivery");
    }
  });
});

describe("verifyChildCommitCustody (with real git)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when commit is on delivery branch but not on base", () => {
    ({ dir } = makeGitRepo("delivery/pol-268"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

    // Make a commit on the delivery branch
    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
    git("add", "src.ts");
    git("commit", "-m", "feat: implement");
    const deliveryCommit = git("rev-parse", "HEAD").trim();

    const result = verifyChildCommitCustody(
      dir,
      deliveryCommit,
      "delivery/pol-268",
      "main",
    );
    expect(result).toBeNull();
  });

  it("returns error when commit is already reachable from base", () => {
    ({ dir } = makeGitRepo("delivery/pol-268"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

    // The initial commit is on main; get its sha
    git("checkout", "main");
    const mainCommit = git("rev-parse", "HEAD").trim();
    git("checkout", "delivery/pol-268");

    // This commit is already reachable from main (it's the merge base)
    const result = verifyChildCommitCustody(
      dir,
      mainCommit,
      "delivery/pol-268",
      "main",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("already reachable from base branch");
  });

  it("returns error when commit is not reachable from delivery branch", () => {
    ({ dir } = makeGitRepo("delivery/pol-268"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

    // Make a commit on a third branch that's not on delivery
    git("checkout", "main");
    git("checkout", "-b", "other-branch");
    writeFileSync(join(dir, "other.ts"), "// other\n");
    git("add", "other.ts");
    git("commit", "-m", "other commit");
    const otherCommit = git("rev-parse", "HEAD").trim();
    git("checkout", "delivery/pol-268");

    const result = verifyChildCommitCustody(
      dir,
      otherCommit,
      "delivery/pol-268",
      "main",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("not reachable from delivery branch");
  });
});

describe("hasNonArtifactSourceChanges (with real git)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns true when non-artifact source file changed", () => {
    ({ dir } = makeGitRepo("delivery/pol-268"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
    git("add", "src.ts");
    git("commit", "-m", "feat: source change");

    expect(hasNonArtifactSourceChanges(dir, "main", "POL-268", "delivery/pol-268")).toBe(true);
  });

  it("returns false when only .polaris/ artifacts changed", () => {
    ({ dir } = makeGitRepo("delivery/pol-268"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

    mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
    writeFileSync(
      join(dir, ".polaris", "runs", "ledger.jsonl"),
      JSON.stringify({ event: "test" }) + "\n",
    );
    git("add", ".polaris/runs/ledger.jsonl");
    git("commit", "-m", "chore: artifact only");

    expect(hasNonArtifactSourceChanges(dir, "main", "POL-268", "delivery/pol-268")).toBe(false);
  });

  it("returns false when only .taskchain_artifacts/ changed", () => {
    ({ dir } = makeGitRepo("delivery/pol-268"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

    mkdirSync(join(dir, ".taskchain_artifacts"), { recursive: true });
    writeFileSync(
      join(dir, ".taskchain_artifacts", "state.json"),
      "{}",
    );
    git("add", ".taskchain_artifacts/state.json");
    git("commit", "-m", "chore: scratch only");

    // .taskchain_artifacts is workspace-scratch, not non-artifact
    expect(hasNonArtifactSourceChanges(dir, "main", "POL-268", "delivery/pol-268")).toBe(false);
  });

  it("returns false when no changes beyond base", () => {
    ({ dir } = makeGitRepo("delivery/pol-268"));
    // No additional commits on delivery branch
    expect(hasNonArtifactSourceChanges(dir, "main", "POL-268", "delivery/pol-268")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: runLoopDispatch custody enforcement
// ──────────────────────────────────────────────────────────────────────────────

describe("runLoopDispatch: branch custody enforcement", () => {
  let testDir: string;

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("auto-creates delivery branch on first dispatch from main", () => {
    // Real git repo is needed so git checkout -b can actually execute.
    const { dir: gitDir } = makeMainRepo();
    testDir = gitDir;
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });

    const state = makeFreshState();
    const stateFile = writeStateFile(testDir, state);

    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      runLoopDispatch({ stateFile, repoRoot: testDir });
    } finally {
      process.stdout.write = origStdout;
    }

    // Cluster state should record the auto-created delivery branch.
    const clusterState = readClusterStateSync("POL-268", testDir);
    const expectedBranch = buildDeliveryBranchName("POL-268");
    expect(clusterState?.delivery_branch).toBe(expectedBranch);

    // Git should now be checked out on the delivery branch.
    const currentBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: testDir,
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe(expectedBranch);
  });

  it("fails with custody violation when dispatching on main after delivery branch is recorded", () => {
    testDir = makeTempDir();
    // Pre-seed cluster state with a recorded delivery branch so we take the
    // "custody already recorded" path, which asserts branch match rather than
    // auto-creating.
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-268");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-268",
        state_generation: 1,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
        base_branch: "main",
        base_sha: "abc123",
        delivery_branch: "pol-268-delivery",
      }),
    );

    process.env["POLARIS_BRANCH"] = "main";
    try {
      mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });
      const state = makeFreshState();
      const stateFile = writeStateFile(testDir, state);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      const stderrChunks: string[] = [];
      const origStderr = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: string | Uint8Array) => {
        stderrChunks.push(chunk.toString());
        return true;
      };

      try {
        expect(() => runLoopDispatch({ stateFile, repoRoot: testDir })).toThrow();
      } finally {
        exitSpy.mockRestore();
        process.stderr.write = origStderr;
      }

      expect(stderrChunks.join("").toLowerCase()).toContain("custody");
    } finally {
      delete process.env["POLARIS_BRANCH"];
    }
  });

  it("records delivery branch in cluster state on first dispatch", () => {
    testDir = makeTempDir();
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });

    // Use POLARIS_BRANCH env to simulate being on a delivery branch
    // (makeTempDir creates a fake .git dir so getCurrentBranch falls back to env)
    process.env["POLARIS_BRANCH"] = "pol-268-delivery";
    try {
      const state = makeFreshState();
      const stateFile = writeStateFile(testDir, state);

      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      try {
        runLoopDispatch({ stateFile, repoRoot: testDir });
      } finally {
        process.stdout.write = origWrite;
      }

      const clusterState = readClusterStateSync("POL-268", testDir);
      expect(clusterState?.delivery_branch).toBe("pol-268-delivery");
      expect(clusterState?.base_branch).toBeDefined();
      expect(clusterState?.base_sha).toBeDefined();
    } finally {
      delete process.env["POLARIS_BRANCH"];
    }
  });

  it("fails when current branch does not match recorded delivery branch", () => {
    testDir = makeTempDir();
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });

    // Pre-seed cluster state with a recorded delivery branch
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-268");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-268",
        state_generation: 1,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
        base_branch: "main",
        base_sha: "abc123",
        delivery_branch: "pol-268-delivery",
      }),
    );

    // Simulate being on a different (non-base) branch via env
    process.env["POLARIS_BRANCH"] = "wrong-branch";
    try {
      const state = makeFreshState();
      const stateFile = writeStateFile(testDir, state);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      const origStderr = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;

      try {
        expect(() => runLoopDispatch({ stateFile, repoRoot: testDir })).toThrow();
      } finally {
        exitSpy.mockRestore();
        process.stderr.write = origStderr;
      }
    } finally {
      delete process.env["POLARIS_BRANCH"];
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: runLoopContinue custody check
// ──────────────────────────────────────────────────────────────────────────────

describe("runLoopContinue: child commit custody check", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rejects commit already reachable from base branch", () => {
    ({ dir } = makeGitRepo("delivery/pol-268"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

    // The initial commit on main is the merge-base (reachable from both)
    const mainCommit = git("rev-parse", "main").trim();

    // Write cluster state with custody info
    const clusterDir = join(dir, ".polaris", "clusters", "POL-268");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-268",
        state_generation: 1,
        child_states: [{ id: "POL-268-1", status: "dispatched" }],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
        base_branch: "main",
        base_sha: mainCommit,
        delivery_branch: "delivery/pol-268",
      }),
    );

    // Write result file with the mainCommit (already on base — custody violation)
    const resultDir = join(clusterDir, "results");
    mkdirSync(resultDir, { recursive: true });
    const resultFile = join(resultDir, "POL-268-1-result.json");
    writeFileSync(
      resultFile,
      JSON.stringify({
        run_id: "polaris-run-custody-test-001",
        child_id: "POL-268-1",
        status: "done",
        commit: mainCommit,
        validation: "passed",
      }),
    );

    const runId = "polaris-run-custody-test-001";
    const clusterId = "POL-268";
    const state: LoopState = {
      schema_version: "1.0",
      run_id: runId,
      cluster_id: clusterId,
      active_child: "POL-268-1",
      completed_children: [],
      open_children: ["POL-268-1"],
      open_children_meta: {
        "POL-268-1": {
          title: "Fix POL-268-1",
          body: MINIMAL_CHILD_BODY,
          result_file: resultFile,
          dispatch_record: {
            dispatch_id: randomUUID(),
            child_id: "POL-268-1",
            run_id: runId,
            cluster_id: clusterId,
            packet_path: "relative/packet.json",
            expected_result_path: resultFile,
            dispatched_at: new Date().toISOString(),
            status: "dispatched",
          },
        },
      },
      step_cursor: "dispatch",
      context_budget: { children_completed: 0, max_children_per_session: 5 },
      status: "running",
      next_open_child: "POL-268-1",
      dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 0, last_dispatched_child: "POL-268-1" },
      run_bootstrap_seal: createBootstrapSeal(runId, clusterId, ["POL-268-1"]),
    };

    const stateDir = join(dir, ".polaris", "runs");
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, "current-state.json");
    writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderrChunks: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrChunks.push(chunk.toString());
      return true;
    };
    const origLog = console.log;
    console.log = () => {};
    const origError = console.error;
    console.error = (...args: unknown[]) =>
      stderrChunks.push(args.map(String).join(" "));
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;

    try {
      expect(() => runLoopContinue({ stateFile, repoRoot: dir })).toThrow();
    } finally {
      exitSpy.mockRestore();
      process.stderr.write = origStderr;
      process.stdout.write = origStdout;
      console.log = origLog;
      console.error = origError;
    }

    const allOutput = stderrChunks.join("");
    expect(allOutput.toLowerCase()).toContain("custody");
  });
});
