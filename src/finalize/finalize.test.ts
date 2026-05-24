import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// ---- helpers ----------------------------------------------------------------

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-finalize-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function writeState(dir: string, extra: object = {}): string {
  const stateFile = join(dir, ".polaris", "runs", "current-state.json");
  mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
  const state = {
    schema_version: "1.0",
    run_id: "test-finalize-001",
    cluster_id: "POL-6",
    active_child: "",
    completed_children: ["POL-9", "POL-10", "POL-11"],
    open_children: [],
    step_cursor: "CLUSTER-COMPLETE",
    context_budget: { children_completed: 3 },
    status: "complete",
    next_open_child: null,
    ...extra,
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

function writeEmptyAtlas(dir: string): void {
  const mapDir = join(dir, ".polaris", "map");
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(mapDir, "file-routes.json"), "{}");
  writeFileSync(join(mapDir, "needs-review.json"), "{}");
  writeFileSync(join(mapDir, "exemptions.json"), "{}");
}

// ---- step 03: schema validate -----------------------------------------------

describe("stepSchemaValidate", () => {
  it("passes for valid state", async () => {
    const { stepSchemaValidate } = await import("./steps/03-schema-validate.js");
    const validState = {
      schema_version: "1.0",
      run_id: "test-finalize-001",
      cluster_id: "POL-6",
      active_child: "",
      completed_children: [],
      open_children: [],
      step_cursor: "CLUSTER-COMPLETE",
      context_budget: { children_completed: 3 },
      status: "complete",
    };
    expect(() => stepSchemaValidate(validState)).not.toThrow();
  });

  it("calls process.exit(1) for invalid state", async () => {
    const { stepSchemaValidate } = await import("./steps/03-schema-validate.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    expect(() => stepSchemaValidate({ schema_version: "1.0" })).toThrow("process.exit called");
    exitSpy.mockRestore();
  });
});

// ---- step 05: generate report -----------------------------------------------

describe("stepGenerateReport", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("writes run-report.md with correct sections", async () => {
    const { stepGenerateReport } = await import("./steps/05-generate-report.js");
    const stateFile = writeState(testDir);
    const { readState } = await import("../loop/checkpoint.js");
    const state = readState(stateFile);
    const reportPath = stepGenerateReport(testDir, state, "test/finalize-integration", true);

    expect(existsSync(reportPath)).toBe(true);
    const content = readFileSync(reportPath, "utf-8");
    expect(content).toContain("# Run Report: test-finalize-001");
    expect(content).toContain("**Branch:** test/finalize-integration");
    expect(content).toContain("**Validation:** passed");
    expect(content).toContain("POL-9");
    expect(content).toContain("POL-10");
    expect(content).toContain("POL-11");
  });
});

// ---- step 09: update state --------------------------------------------------

describe("stepUpdateState", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("writes pr_url to current-state.json", async () => {
    const { stepUpdateState } = await import("./steps/09-update-state.js");
    const { readState } = await import("../loop/checkpoint.js");
    const stateFile = writeState(testDir);
    const state = readState(stateFile);
    stepUpdateState(stateFile, state, "https://github.com/test/repo/pull/42");

    const updated = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(updated["pr_url"]).toBe("https://github.com/test/repo/pull/42");
  });
});

// ---- step 10: append jsonl --------------------------------------------------

describe("stepAppendJsonl", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("appends pr-opened and run-complete events", async () => {
    const { stepAppendJsonl } = await import("./steps/10-append-jsonl.js");
    const { readState } = await import("../loop/checkpoint.js");
    const stateFile = writeState(testDir);
    const state = readState(stateFile);
    const telemetryFile = join(testDir, "telemetry.jsonl");
    const prUrl = "https://github.com/test/repo/pull/42";

    stepAppendJsonl(telemetryFile, state, prUrl);

    const lines = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(lines).toHaveLength(2);
    expect(lines[0]!["event"]).toBe("pr-opened");
    expect(lines[0]!["pr_url"]).toBe(prUrl);
    expect(lines[0]!["run_id"]).toBe("test-finalize-001");
    expect(lines[1]!["event"]).toBe("run-complete");
    expect(lines[1]!["children_completed"]).toBe(3);
  });
});

// ---- step 11: update linear (disabled) --------------------------------------

describe("stepUpdateLinear", () => {
  it("skips when linearEnabled is false", async () => {
    const { stepUpdateLinear } = await import("./steps/11-update-linear.js");
    const { readState } = await import("../loop/checkpoint.js");
    const dir = makeTestDir();
    const stateFile = writeState(dir);
    const state = readState(stateFile);
    // Should resolve without error when disabled
    await expect(
      stepUpdateLinear(state, "test-branch", "https://example.com/pr/1", true, false),
    ).resolves.toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---- step 12: archive -------------------------------------------------------

describe("stepArchive", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("copies state and report to .polaris/runs/<run_id>/", async () => {
    const { stepArchive } = await import("./steps/12-archive.js");
    const { readState } = await import("../loop/checkpoint.js");
    const stateFile = writeState(testDir);
    const state = readState(stateFile);

    const reportPath = join(testDir, ".polaris", "runs", "run-report.md");
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });
    writeFileSync(reportPath, "# Run Report: test-finalize-001\n");

    stepArchive(testDir, state, stateFile, reportPath);

    const archiveDir = join(testDir, ".polaris", "runs", "test-finalize-001");
    expect(existsSync(join(archiveDir, "current-state.json"))).toBe(true);
    expect(existsSync(join(archiveDir, "run-report.md"))).toBe(true);
  });
});

// ---- runFinalize steps 1–6 (skip-delivery) ----------------------------------

describe("runFinalize (steps 1–6, skip-delivery)", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("runs steps 1–6 end-to-end and creates a commit", async () => {
    const { runFinalize } = await import("./index.js");
    const stateFile = writeState(testDir);
    writeEmptyAtlas(testDir);

    // Capture stdout
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runFinalize({ repoRoot: testDir, stateFile, skipDelivery: true });
    } finally {
      logSpy.mockRestore();
    }

    // Step 5 verification: run-report.md written
    const reportPath = join(testDir, ".polaris", "runs", "run-report.md");
    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, "utf-8");
    expect(report).toContain("# Run Report: test-finalize-001");
    expect(report).toContain("**Validation:** passed");

    // Step 6 verification: commit created
    const log = execFileSync("git", ["log", "--oneline", "-1"], {
      cwd: testDir,
      encoding: "utf-8",
    });
    expect(log).toContain("polaris finalize: test-finalize-001");
  });

  it("aborts on missing state file", async () => {
    const { runFinalize } = await import("./index.js");
    writeEmptyAtlas(testDir);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runFinalize({
        repoRoot: testDir,
        stateFile: join(testDir, "nonexistent.json"),
        skipDelivery: true,
      }),
    ).rejects.toThrow("process.exit called");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
