import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runLoopResume } from "./resume.js";
import { runLoopDispatch } from "./dispatch.js";
import { createBootstrapSeal } from "./run-bootstrap.js";
import type { BootstrapPacket } from "./bootstrap-packet.js";
import type { ClusterState } from "../cluster-state/types.js";

function getHeadSha(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function getCurrentBranch(dir: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf-8" }).trim();
  } catch {
    return "main";
  }
}

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-resume-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  // Custody requirement: dispatch must not run on a base/protected branch.
  execFileSync("git", ["checkout", "-b", "feature-branch"], { cwd: dir });
  return dir;
}

function writeState(dir: string, state: object): string {
  const stateFile = join(dir, ".polaris", "runs", "current-state.json");
  mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
  const content = JSON.stringify(state, null, 2);
  writeFileSync(stateFile, content);
  return stateFile;
}

function writeClusterState(dir: string, state: ClusterState): string {
  const stateFile = join(dir, ".polaris", "clusters", state.cluster_id, "cluster-state.json");
  mkdirSync(join(dir, ".polaris", "clusters", state.cluster_id), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

function shaOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writePacket(dir: string, packet: BootstrapPacket): string {
  const bootstrapDir = join(dir, ".polaris", "bootstrap");
  mkdirSync(bootstrapDir, { recursive: true });
  const filename = `${packet.run_id}-2026-01-01T00-00-00-000Z.json`;
  const path = join(bootstrapDir, filename);
  writeFileSync(path, JSON.stringify(packet, null, 2));
  return path;
}

function makePacket(
  stateFile: string,
  stateContent: object,
  testDir: string,
  overrides: Partial<BootstrapPacket> = {},
): BootstrapPacket {
  const sha = shaOf(JSON.stringify(stateContent, null, 2));
  return {
    run_id: "pol-5-session-1",
    skill: "bootstrap-run",
    branch: getCurrentBranch(testDir),
    base_commit_sha: getHeadSha(testDir),
    last_completed_step: "checkpoint",
    last_completed_child: "POL-23",
    next_step: "03-execute-child",
    open_children: { next_child: "POL-24", remaining_count: 1 },
    artifact_pointers: {
      current_state: stateFile,
      telemetry: "/tmp/telemetry.jsonl",
    },
    context_budget: { children_completed: 1, files_touched_total: 0, stop_threshold_remaining: 2 },
    current_state_sha: sha,
    resume_instructions: "Run polaris loop resume pol-5-session-1",
    ...overrides,
  };
}

describe("runLoopResume", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("emits bootstrap packet JSON to stdout when all checks pass", () => {
    const stateContent = { schema_version: "1.0", run_id: "pol-5-session-1" };
    const stateFile = writeState(testDir, stateContent);
    const packet = makePacket(stateFile, stateContent, testDir);
    writePacket(testDir, packet);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      runLoopResume({ repoRoot: testDir, stateFile });
    } finally {
      console.log = origLog;
    }

    const emitted = JSON.parse(logs.join("\n")) as BootstrapPacket;
    expect(emitted.run_id).toBe("pol-5-session-1");
    expect(emitted.current_state_sha).toBeTruthy();
  });

  it("selects packet by run_id when provided", () => {
    const stateContent = { schema_version: "1.0", run_id: "pol-5-session-1" };
    const stateFile = writeState(testDir, stateContent);
    const packet = makePacket(stateFile, stateContent, testDir);
    writePacket(testDir, packet);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      runLoopResume({ runId: "pol-5-session-1", repoRoot: testDir, stateFile });
    } finally {
      console.log = origLog;
    }

    expect(logs.join("")).toContain("pol-5-session-1");
  });

  it("appends run-resumed to the global ledger and creates it when absent", () => {
    const stateContent = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      branch: getCurrentBranch(testDir),
      active_child: "",
      completed_children: ["POL-23"],
      open_children: ["POL-24"],
      step_cursor: "checkpoint",
      context_budget: { children_completed: 1 },
      status: "running",
      next_open_child: "POL-24",
      last_commit: "abc1234",
    };
    const stateFile = writeState(testDir, stateContent);
    const packet = makePacket(stateFile, stateContent, testDir);
    writePacket(testDir, packet);

    const origLog = console.log;
    console.log = () => {};
    try {
      runLoopResume({ runId: "pol-5-session-1", repoRoot: testDir, stateFile });
    } finally {
      console.log = origLog;
    }

    const ledgerFile = join(testDir, ".polaris", "runs", "ledger.jsonl");
    expect(existsSync(ledgerFile)).toBe(true);
    const events = readFileSync(ledgerFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      event: "run-resumed",
      run_id: "pol-5-session-1",
      run_type: "implement",
      cluster_id: "POL-5",
      issue_id: null,
      status: "running",
      completed_children: ["POL-23"],
      open_children: ["POL-24"],
      next_child: "POL-24",
      last_commit: "abc1234",
      pr_url: null,
      resume_source: "bootstrap",
      resume_reason: "polaris loop resume selected bootstrap packet",
    });
  });

  it("halts with exit 1 when current-state SHA does not match packet", () => {
    const stateContent = { schema_version: "1.0", run_id: "pol-5-session-1" };
    const stateFile = writeState(testDir, stateContent);
    // Use a wrong SHA in the packet
    const packet = makePacket(stateFile, stateContent, testDir, { current_state_sha: "wrongsha" });
    writePacket(testDir, packet);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => runLoopResume({ repoRoot: testDir, stateFile })).toThrow();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("state packet stale"));
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("halts when no bootstrap packets exist", () => {
    const stateContent = { schema_version: "1.0", run_id: "pol-5-session-1" };
    const stateFile = writeState(testDir, stateContent);
    mkdirSync(join(testDir, ".polaris", "bootstrap"), { recursive: true });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => runLoopResume({ repoRoot: testDir, stateFile })).toThrow();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("No bootstrap packets found"));
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("halts when run_id packet not found", () => {
    const stateContent = { schema_version: "1.0", run_id: "pol-5-session-1" };
    const stateFile = writeState(testDir, stateContent);
    const packet = makePacket(stateFile, stateContent, testDir);
    writePacket(testDir, packet);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() =>
        runLoopResume({ runId: "nonexistent-run", repoRoot: testDir, stateFile }),
      ).toThrow();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent-run"));
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("rebuilds current-state.json from cluster-state.json when the workspace state is absent", () => {
    const stateFile = join(testDir, ".taskchain_artifacts", "polaris-run", "current-state.json");
    const clusterState: ClusterState = {
      schema_version: "1.0",
      cluster_id: "POL-5",
      state_generation: 3,
      child_states: [
        { id: "POL-23", status: "done", commit: "abc1234" },
        { id: "POL-24", status: "ready" },
      ],
      claim_metadata: {},
      packet_pointers: {},
      result_pointers: {},
      validation_results: {},
      commits: { "POL-23": "abc1234" },
      tracker_mutations: {},
      blockers: [],
    };
    writeClusterState(testDir, clusterState);
    const packet = makePacket(stateFile, { missing: true }, testDir, {
      artifact_pointers: {
        current_state: ".taskchain_artifacts/polaris-run/current-state.json",
        telemetry: "/tmp/telemetry.jsonl",
      },
      current_state_sha: "missing",
    });
    writePacket(testDir, packet);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      runLoopResume({ runId: "pol-5-session-1", repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const emitted = JSON.parse(logs.join("\n")) as BootstrapPacket;
    const rebuiltState = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(rebuiltState.cluster_id).toBe("POL-5");
    expect(rebuiltState.completed_children).toEqual(["POL-23"]);
    expect(rebuiltState.open_children).toEqual(["POL-24"]);
    expect(rebuiltState.next_open_child).toBe("POL-24");
    expect(rebuiltState.last_commit).toBe("abc1234");
    expect(emitted.current_state_sha).toBe(
      shaOf(JSON.stringify(JSON.parse(readFileSync(stateFile, "utf-8")), null, 2)),
    );
    expect(emitted.artifact_pointers.current_state).toBe(
      ".taskchain_artifacts/polaris-run/current-state.json",
    );
  });

  it("fails with a clear error when neither current-state.json nor matching cluster-state.json exist", () => {
    const stateFile = join(testDir, ".taskchain_artifacts", "polaris-run", "current-state.json");
    const packet = makePacket(stateFile, { missing: true }, testDir, {
      artifact_pointers: {
        current_state: ".taskchain_artifacts/polaris-run/current-state.json",
        telemetry: "/tmp/telemetry.jsonl",
      },
      current_state_sha: "missing",
    });
    writePacket(testDir, packet);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => runLoopResume({ runId: "pol-5-session-1", repoRoot: testDir })).toThrow();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("cannot reconstruct state"),
      );
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  // ── Blocked-idle resume tests ──────────────────────────────────────────────
  //
  // After `loop abort` clears a stale dispatch, current-state.json has:
  //   status: "blocked", active_child: "", balanced dispatch_boundary.
  // The bootstrap packet's current_state_sha was computed before the abort
  // and no longer matches.  Resume must clear the blocker rather than
  // reporting "state packet stale".

  // Shared blocked-idle state shape used across these tests.
  const MINIMAL_BODY = "## Goal\nImplement the fix.\n\n## Scope\n- src/**\n\n## Validation\n- npm test";

  function makeBlockedIdleState(testDir: string) {
    return {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      branch: getCurrentBranch(testDir),
      active_child: "",
      completed_children: ["POL-23"],
      open_children: ["POL-24"],
      open_children_meta: {
        "POL-24": { title: "Fix POL-24", body: MINIMAL_BODY },
      },
      step_cursor: null as null,
      context_budget: { children_completed: 1, max_children_per_session: 3 },
      status: "blocked",
      blocker: {
        reason: "stale dispatch cleared",
        child_id: "POL-24",
        timestamp: "2024-01-01T00:00:00.000Z",
        resolved: false,
      },
      next_open_child: "POL-24",
      dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 1, last_dispatched_child: "POL-24" },
      run_bootstrap_seal: createBootstrapSeal("pol-5-session-1", "POL-5", ["POL-24"]),
    };
  }

  it("clears blocked status when active_child is empty and dispatch boundary is balanced (blocked-idle)", () => {
    const blockedIdleState = makeBlockedIdleState(testDir);

    // Write state with a different (pre-abort) SHA in the packet to simulate
    // the abort having modified current-state.json after the packet was created.
    const stalePacketContent = { schema_version: "1.0", run_id: "pol-5-session-1", status: "running" };
    const stateFile = writeState(testDir, stalePacketContent);
    const packet = makePacket(stateFile, stalePacketContent, testDir);
    // Overwrite with the post-abort blocked-idle state (SHA now differs from packet)
    writeFileSync(stateFile, JSON.stringify(blockedIdleState, null, 2));
    writePacket(testDir, packet);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopResume({ repoRoot: testDir, stateFile });
    } finally {
      console.log = origLog;
    }

    const saved = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(saved["status"]).toBe("running");
    expect(saved["blocker"]).toBeUndefined();
    expect(saved["active_child"]).toBe("");
  });

  it("refuses to resume when blocked with active_child present", () => {
    const blockedWithActiveChild = {
      ...makeBlockedIdleState(testDir),
      active_child: "POL-24",
    };

    const stalePacketContent = { schema_version: "1.0", run_id: "pol-5-session-1", status: "running" };
    const stateFile = writeState(testDir, stalePacketContent);
    const packet = makePacket(stateFile, stalePacketContent, testDir);
    writeFileSync(stateFile, JSON.stringify(blockedWithActiveChild, null, 2));
    writePacket(testDir, packet);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => runLoopResume({ repoRoot: testDir, stateFile })).toThrow("process.exit called");
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("active_child set"),
      );
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("refuses to resume when blocked with unbalanced dispatch boundary", () => {
    const blockedUnbalanced = {
      ...makeBlockedIdleState(testDir),
      // dispatch_epoch > continue_epoch → outstanding dispatch
      dispatch_boundary: { dispatch_epoch: 2, continue_epoch: 1, last_dispatched_child: "POL-24" },
    };

    const stalePacketContent = { schema_version: "1.0", run_id: "pol-5-session-1", status: "running" };
    const stateFile = writeState(testDir, stalePacketContent);
    const packet = makePacket(stateFile, stalePacketContent, testDir);
    writeFileSync(stateFile, JSON.stringify(blockedUnbalanced, null, 2));
    writePacket(testDir, packet);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => runLoopResume({ repoRoot: testDir, stateFile })).toThrow("process.exit called");
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("unbalanced dispatch boundary"),
      );
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("after blocked-idle resume, loop dispatch creates a fresh packet", () => {
    const blockedIdleState = makeBlockedIdleState(testDir);

    // Write cluster state so dispatch can sync
    const clusterState: ClusterState = {
      schema_version: "1.0",
      cluster_id: "POL-5",
      state_generation: 1,
      child_states: [
        { id: "POL-23", status: "done" },
        { id: "POL-24", status: "ready" },
      ],
      claim_metadata: {},
      packet_pointers: {},
      result_pointers: {},
      validation_results: {},
      commits: {},
      tracker_mutations: {},
      blockers: [],
    };
    writeClusterState(testDir, clusterState);

    const stalePacketContent = { schema_version: "1.0", run_id: "pol-5-session-1", status: "running" };
    const stateFile = writeState(testDir, stalePacketContent);
    const packet = makePacket(stateFile, stalePacketContent, testDir);
    writeFileSync(stateFile, JSON.stringify(blockedIdleState, null, 2));
    writePacket(testDir, packet);

    // Step 1: resume clears blocked status
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopResume({ repoRoot: testDir, stateFile });
    } finally {
      console.log = origLog;
    }

    const afterResume = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(afterResume["status"]).toBe("running");

    // Step 2: dispatch creates a fresh packet
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      runLoopDispatch({ stateFile, repoRoot: testDir });
    } finally {
      stdoutSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const afterDispatch = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(afterDispatch["active_child"]).toBe("POL-24");
    const meta = afterDispatch["open_children_meta"] as Record<string, { dispatch_record?: { status?: string } }>;
    expect(meta["POL-24"]?.dispatch_record?.status).toBe("dispatched");
  });
});
