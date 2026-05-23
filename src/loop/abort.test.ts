import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runLoopAbort } from "./abort.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-abort-test-${Date.now()}`);
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

const baseState = {
  schema_version: "1.0",
  run_id: "pol-5-session-1",
  cluster_id: "POL-5",
  session_type: "implement",
  active_child: "POL-26",
  completed_children: ["POL-23"],
  open_children: ["POL-26", "POL-27"],
  step_cursor: "implement-child",
  context_budget: { children_completed: 1, max_children_per_session: 3 },
  status: "running",
  next_open_child: "POL-26",
};

describe("runLoopAbort", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writes blocked status and blocker record to current-state.json", () => {
    const stateFile = writeState(testDir, baseState);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({ reason: "test blocker", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const saved = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(saved.status).toBe("blocked");
    expect(saved.blocker.reason).toBe("test blocker");
    expect(saved.blocker.child_id).toBe("POL-26");
    expect(saved.blocker.resolved).toBe(false);
    expect(saved.blocker.timestamp).toBeTruthy();
  });

  it("uses --child override for blocker child_id", () => {
    const stateFile = writeState(testDir, baseState);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({
          reason: "dependency not done",
          childId: "POL-27",
          repoRoot: testDir,
          stateFile,
        }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const saved = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(saved.blocker.child_id).toBe("POL-27");
  });

  it("appends loop-aborted JSONL event to telemetry file", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "bootstrap-run");
    const telemetryFile = join(artifactDir, "runs", "pol-5-session-1", "telemetry.jsonl");
    const stateFile = writeState(testDir, baseState);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({ reason: "test blocker", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const lines = readFileSync(telemetryFile, "utf-8").trim().split("\n");
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.event).toBe("loop-aborted");
    expect(event.run_id).toBe("pol-5-session-1");
    expect(event.reason).toBe("test blocker");
  });

  it("prints abort message to stderr and exits 1", () => {
    const stateFile = writeState(testDir, baseState);
    const stderrMessages: string[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((msg) => {
        stderrMessages.push(String(msg));
        return true;
      });

    try {
      expect(() =>
        runLoopAbort({ reason: "blocked by missing dep", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrMessages.some((m) => m.includes("Loop aborted"))).toBe(true);
      expect(stderrMessages.some((m) => m.includes("blocked by missing dep"))).toBe(true);
      expect(stderrMessages.some((m) => m.includes("polaris loop resume"))).toBe(true);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("exits with error when state file is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({
          reason: "test",
          repoRoot: testDir,
          stateFile: join(testDir, "nonexistent.json"),
        }),
      ).toThrow("process.exit called");
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("cannot read state file"),
      );
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
