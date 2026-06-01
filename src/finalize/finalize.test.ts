import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// ---- helpers ----------------------------------------------------------------

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-finalize-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
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

function writeDurableClusterArtifacts(dir: string, clusterId: string): void {
  const clusterDir = join(dir, ".polaris", "clusters", clusterId);
  mkdirSync(join(clusterDir, "packets"), { recursive: true });
  mkdirSync(join(clusterDir, "results"), { recursive: true });
  mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
  writeFileSync(join(clusterDir, "cluster-state.json"), "{\"status\":\"ready\"}\n");
  writeFileSync(join(clusterDir, "clusters.json"), "{\"active\":true}\n");
  writeFileSync(join(clusterDir, "packets", "packet.json"), "{\"packet\":true}\n");
  writeFileSync(join(clusterDir, "results", "result.json"), "{\"result\":true}\n");
  writeFileSync(join(dir, ".polaris", "runs", "ledger.jsonl"), "{\"event\":\"run-complete\"}\n");
}

function stageFile(dir: string, relativePath: string, content = "test\n"): void {
  const fullPath = join(dir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["add", relativePath], { cwd: dir, stdio: "pipe" });
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

describe("stepRunChecks staged artifact preflight", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("aborts on staged workspace scratch, backups, and mutation queue artifacts", async () => {
    const { stepRunChecks } = await import("./steps/04-run-checks.js");
    stageFile(testDir, ".taskchain_artifacts/polaris-run/current-state.json", "{}\n");
    stageFile(testDir, "notes/snapshot.bak", "backup\n");
    stageFile(testDir, ".polaris/runs/mutation-queue.json", "[]\n");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    let stderr = "";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as never);

    expect(() => stepRunChecks(testDir, [], { activeClusterId: "POL-242" })).toThrow("process.exit called");
    expect(stderr).toContain(".taskchain_artifacts/polaris-run/current-state.json");
    expect(stderr).toContain("notes/snapshot.bak");
    expect(stderr).toContain(".polaris/runs/mutation-queue.json");
    expect(stderr).toContain("git restore --staged <path>");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("warns on staged foreign-cluster artifacts without aborting", async () => {
    const { stepRunChecks } = await import("./steps/04-run-checks.js");
    stageFile(testDir, ".polaris/clusters/POL-240/results/POL-240.json", "{}\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => stepRunChecks(testDir, [], { activeClusterId: "POL-242" })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain(".polaris/clusters/POL-240/results/POL-240.json");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("git restore --staged <path>");

    warnSpy.mockRestore();
  });

  it("skips the staged artifact preflight during skip-delivery finalize runs", async () => {
    const { stepRunChecks } = await import("./steps/04-run-checks.js");
    stageFile(testDir, ".taskchain_artifacts/polaris-run/current-state.json", "{}\n");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => stepRunChecks(testDir, [], { activeClusterId: "POL-242", skipDelivery: true })).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping staged delivery artifact check"));

    exitSpy.mockRestore();
    logSpy.mockRestore();
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

// ---- step 06: commit ---------------------------------------------------------

describe("stepCommit", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("stages only durable active-cluster artifacts alongside existing source changes", async () => {
    const { stepCommit } = await import("./steps/06-commit.js");
    const { readState } = await import("../loop/checkpoint.js");
    const stateFile = writeState(testDir);
    const state = readState(stateFile);
    const reportPath = join(testDir, ".polaris", "runs", "run-report.md");

    writeEmptyAtlas(testDir);
    writeDurableClusterArtifacts(testDir, state.cluster_id);
    mkdirSync(join(testDir, ".taskchain_artifacts", "polaris-run"), { recursive: true });
    writeFileSync(reportPath, "# Run Report: test-finalize-001\n");
    writeFileSync(join(testDir, ".taskchain_artifacts", "polaris-run", "current-state.json"), "{\"scratch\":true}\n");
    writeFileSync(join(testDir, "README.md"), "updated\n");
    execFileSync("git", ["add", "README.md"], { cwd: testDir, stdio: "pipe" });

    stepCommit(testDir, state, stateFile, reportPath);

    const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: testDir,
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean);

    expect(files).toContain("README.md");
    expect(files).toContain(`.polaris/clusters/${state.cluster_id}/cluster-state.json`);
    expect(files).toContain(`.polaris/clusters/${state.cluster_id}/clusters.json`);
    expect(files).toContain(`.polaris/clusters/${state.cluster_id}/packets/packet.json`);
    expect(files).toContain(`.polaris/clusters/${state.cluster_id}/results/result.json`);
    expect(files).toContain(".polaris/map/file-routes.json");
    expect(files).toContain(".polaris/runs/ledger.jsonl");
    expect(files).not.toContain(".polaris/runs/current-state.json");
    expect(files).not.toContain(".polaris/runs/run-report.md");
    expect(files).not.toContain(".taskchain_artifacts/polaris-run/current-state.json");
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
    writeDurableClusterArtifacts(testDir, "POL-6");
    stageFile(testDir, ".taskchain_artifacts/polaris-run/current-state.json", "{\"scratch\":true}\n");
    // Non-artifact implementation evidence required by the evidence gate
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

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

    const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: testDir,
      encoding: "utf-8",
    });
    expect(files).toContain(".polaris/clusters/POL-6/cluster-state.json");
    expect(files).toContain(".polaris/runs/ledger.jsonl");
    expect(files).not.toContain(".taskchain_artifacts/polaris-run/current-state.json");
    expect(files).not.toContain(".polaris/runs/current-state.json");
    expect(files).not.toContain(".polaris/runs/run-report.md");
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
