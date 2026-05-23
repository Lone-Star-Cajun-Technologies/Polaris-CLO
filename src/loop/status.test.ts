import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runLoopStatus } from "./status.js";
import type { BootstrapPacket } from "./bootstrap-packet.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-status-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function writeState(dir: string, state: object): string {
  const stateFile = join(dir, ".polaris", "runs", "current-state.json");
  mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

function shaOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writePacket(dir: string, packet: BootstrapPacket): void {
  const bootstrapDir = join(dir, ".polaris", "bootstrap");
  mkdirSync(bootstrapDir, { recursive: true });
  const filename = `${packet.run_id}-2026-01-01T00-00-00-000Z.json`;
  writeFileSync(join(bootstrapDir, filename), JSON.stringify(packet, null, 2));
}

const baseState = {
  schema_version: "1.0",
  run_id: "pol-5-session-1",
  cluster_id: "POL-5",
  session_type: "implement",
  active_child: "POL-26",
  completed_children: ["POL-23", "POL-24", "POL-25"],
  open_children: ["POL-26", "POL-27"],
  step_cursor: "implement-child",
  context_budget: { children_completed: 3, max_children_per_session: 3 },
  status: "running",
  next_open_child: "POL-26",
};

describe("runLoopStatus", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("prints human-readable status from state file", () => {
    const stateFile = writeState(testDir, baseState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    const output = logs.join("\n");
    expect(output).toContain("Polaris Loop Status");
    expect(output).toContain("pol-5-session-1");
    expect(output).toContain("POL-5");
    expect(output).toContain("implement");
    expect(output).toContain("POL-26");
    expect(output).toContain("POL-23, POL-24, POL-25");
    expect(output).toContain("Blocked:         none");
  });

  it("emits JSON output with --json flag", () => {
    const stateFile = writeState(testDir, baseState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.run_id).toBe("pol-5-session-1");
    expect(parsed.completed_children).toEqual(["POL-23", "POL-24", "POL-25"]);
    expect(parsed.open_children).toEqual(["POL-26", "POL-27"]);
    expect(parsed.deadlock).toBe(false);
  });

  it("reports bootstrap packet as fresh when SHA matches", () => {
    const stateFile = writeState(testDir, baseState);
    const stateContent = JSON.stringify(baseState, null, 2);
    const sha = shaOf(stateContent);
    const packet: BootstrapPacket = {
      run_id: "pol-5-session-1",
      skill: "bootstrap-run",
      branch: "main",
      base_commit_sha: "abc123",
      last_completed_step: "checkpoint",
      last_completed_child: "POL-25",
      next_step: "03-execute-child",
      open_children: ["POL-26", "POL-27"],
      artifact_pointers: {
        current_state: stateFile,
        telemetry: "/tmp/telemetry.jsonl",
      },
      context_budget: { children_completed: 3, files_touched_total: 0, stop_threshold_remaining: 0 },
      current_state_sha: sha,
      resume_instructions: "Run polaris loop resume",
    };
    writePacket(testDir, packet);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("(fresh)");
    expect(logs.join("\n")).toContain("matches current-state.json ✓");
  });

  it("reports bootstrap packet as stale when SHA mismatches", () => {
    const stateFile = writeState(testDir, baseState);
    const packet: BootstrapPacket = {
      run_id: "pol-5-session-1",
      skill: "bootstrap-run",
      branch: "main",
      base_commit_sha: "abc123",
      last_completed_step: "checkpoint",
      last_completed_child: "POL-25",
      next_step: "03-execute-child",
      open_children: ["POL-26", "POL-27"],
      artifact_pointers: {
        current_state: stateFile,
        telemetry: "/tmp/telemetry.jsonl",
      },
      context_budget: { children_completed: 3, files_touched_total: 0, stop_threshold_remaining: 0 },
      current_state_sha: "wrongsha",
      resume_instructions: "Run polaris loop resume",
    };
    writePacket(testDir, packet);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("stale");
    expect(logs.join("\n")).toContain("MISMATCH");
  });

  it("detects deadlock when all open children are blocked", () => {
    const deadlockState = {
      ...baseState,
      open_children: ["POL-26"],
      blocked_children: ["POL-26"],
    };
    const stateFile = writeState(testDir, deadlockState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("DEADLOCK DETECTED");
    expect(logs.join("\n")).toContain("POL-26 — blocked");
    expect(logs.join("\n")).toContain("polaris loop resume");
  });

  it("reports no deadlock when only some children are blocked", () => {
    const partialBlockState = {
      ...baseState,
      open_children: ["POL-26", "POL-27"],
      blocked_children: ["POL-27"],
    };
    const stateFile = writeState(testDir, partialBlockState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).not.toContain("DEADLOCK DETECTED");
  });

  it("exits with error when state file is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        runLoopStatus({
          repoRoot: testDir,
          stateFile: join(testDir, "nonexistent.json"),
        }),
      ).toThrow();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("cannot read state file"));
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("includes deadlock info in JSON output", () => {
    const deadlockState = {
      ...baseState,
      open_children: ["POL-26"],
      blocked_children: ["POL-26"],
    };
    const stateFile = writeState(testDir, deadlockState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.deadlock).toBe(true);
    expect(parsed.blocked_children).toEqual(["POL-26"]);
  });
});
