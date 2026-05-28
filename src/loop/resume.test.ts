import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runLoopResume } from "./resume.js";
import type { BootstrapPacket } from "./bootstrap-packet.js";

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
  return dir;
}

function writeState(dir: string, state: object): string {
  const stateFile = join(dir, ".polaris", "runs", "current-state.json");
  mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
  const content = JSON.stringify(state, null, 2);
  writeFileSync(stateFile, content);
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
    open_children: ["POL-24"],
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
});
