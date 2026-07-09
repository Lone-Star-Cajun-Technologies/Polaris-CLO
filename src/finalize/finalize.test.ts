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

function writeCanonicalState(dir: string, clusterId: string, extra: object = {}): string {
  const stateFile = join(dir, ".polaris", "clusters", clusterId, "state.json");
  mkdirSync(join(dir, ".polaris", "clusters", clusterId), { recursive: true });
  const state = {
    schema_version: "1.0",
    run_id: "test-finalize-001",
    cluster_id: clusterId,
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

function commitFile(dir: string, relativePath: string, content: string, message: string): string {
  const fullPath = join(dir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["add", relativePath], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
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
    expect(content).toContain("| **Branch** | test/finalize-integration |");
    expect(content).toContain("| **Validation** | passed |");
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
      stepUpdateLinear(state, "test-branch", "https://example.com/pr/1", true, false, undefined, undefined),
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
    const stateFile = writeCanonicalState(testDir, "POL-6");
    writeEmptyAtlas(testDir);
    writeDurableClusterArtifacts(testDir, "POL-6");
    
    // Checkout branch matching the cluster_id
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    
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
    expect(report).toContain("| **Validation** | passed |");

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

describe("runFinalize implementation evidence preflight", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("passes with canonical completed-child commit evidence when only artifacts are staged", async () => {
    const { runFinalize } = await import("./index.js");
    const childId = "POL-9";
    const stateFile = writeCanonicalState(testDir, "POL-6", {
      completed_children: [childId],
      context_budget: { children_completed: 1 },
    });
    writeEmptyAtlas(testDir);

    // Create a delivery branch so the delivery-integrity check can diff main...pol-6-delivery.
    // In real Polaris runs workers commit implementation to the delivery branch, not main.
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });

    const commit = commitFile(
      testDir,
      "src/pol277-evidence.ts",
      "export const pol277Evidence = true;\n",
      "impl evidence",
    );

    const clusterDir = join(testDir, ".polaris", "clusters", "POL-6");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      `${JSON.stringify({
        commits: { [childId]: commit },
        validation_results: { [childId]: { passed: true, output: "npm run build" } },
        result_pointers: {},
      }, null, 2)}\n`,
      "utf-8",
    );
    writeFileSync(join(clusterDir, "clusters.json"), "{\"active\":true}\n");
    mkdirSync(join(clusterDir, "packets"), { recursive: true });
    mkdirSync(join(clusterDir, "results"), { recursive: true });
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });
    writeFileSync(join(testDir, ".polaris", "runs", "ledger.jsonl"), "{\"event\":\"run-complete\"}\n");

    stageFile(testDir, ".taskchain_artifacts/polaris-run/current-state.json", "{\"scratch\":true}\n");

    await expect(runFinalize({ repoRoot: testDir, stateFile, skipDelivery: true })).resolves.toBeUndefined();
  });

  it("blocks when no staged source files and no completed-child commit evidence exists", async () => {
    const { runFinalize } = await import("./index.js");
    const childId = "POL-9";
    const stateFile = writeCanonicalState(testDir, "POL-6", {
      completed_children: [childId],
      context_budget: { children_completed: 1 },
    });
    writeEmptyAtlas(testDir);
    writeDurableClusterArtifacts(testDir, "POL-6");
    
    // Checkout branch matching the cluster_id
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    
    writeFileSync(
      join(testDir, ".polaris", "clusters", "POL-6", "cluster-state.json"),
      `${JSON.stringify({ commits: {}, validation_results: {}, result_pointers: {} }, null, 2)}\n`,
      "utf-8",
    );
    stageFile(testDir, ".taskchain_artifacts/polaris-run/current-state.json", "{\"scratch\":true}\n");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    let stderr = "";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as never);

    await expect(runFinalize({ repoRoot: testDir, stateFile, skipDelivery: true })).rejects.toThrow("process.exit called");
    expect(stderr).toContain("No implementation evidence found");
    expect(stderr).toContain("no commit hash");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("blocks artifact-only child commit evidence when packet does not allow artifact_only", async () => {
    const { runFinalize } = await import("./index.js");
    const childId = "POL-9";
    const stateFile = writeCanonicalState(testDir, "POL-6", {
      completed_children: [childId],
      context_budget: { children_completed: 1 },
      open_children_meta: {
        [childId]: {
          dispatch_record: {
            packet_path: `.polaris/clusters/POL-6/packets/${childId}.json`,
          },
        },
      },
    });
    writeEmptyAtlas(testDir);
    writeDurableClusterArtifacts(testDir, "POL-6");

    // Checkout branch matching the cluster_id
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });

    const artifactCommit = commitFile(
      testDir,
      ".polaris/clusters/POL-6/results/evidence.json",
      "{\"ok\":true}\n",
      "artifact-only evidence",
    );

    writeFileSync(
      join(testDir, ".polaris", "clusters", "POL-6", "cluster-state.json"),
      `${JSON.stringify({
        commits: { [childId]: artifactCommit },
        validation_results: { [childId]: { passed: true, output: "npm run build" } },
        result_pointers: {},
      }, null, 2)}\n`,
      "utf-8",
    );
    writeFileSync(
      join(testDir, ".polaris", "clusters", "POL-6", "packets", `${childId}.json`),
      "{\"instructions\":{}}\n",
      "utf-8",
    );

    stageFile(testDir, ".taskchain_artifacts/polaris-run/current-state.json", "{\"scratch\":true}\n");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    let stderr = "";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as never);

    await expect(runFinalize({ repoRoot: testDir, stateFile, skipDelivery: true })).rejects.toThrow("process.exit called");
    expect(stderr).toContain("artifact_only: true");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe("runFinalize Closeout Librarian gate", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  function setupFinalizeRun(clusterId = "POL-6"): string {
    const stateFile = writeCanonicalState(testDir, clusterId);
    writeEmptyAtlas(testDir);
    writeDurableClusterArtifacts(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    stageFile(testDir, "src/impl.ts", "export const impl = true;\n");
    return stateFile;
  }

  function writeLibrarianPacket(
    clusterId: string,
    dispatchId: string,
    resultPath: string,
    runId = "test-finalize-001",
  ): string {
    const packetsDir = join(testDir, ".polaris", "clusters", clusterId, "packets");
    mkdirSync(packetsDir, { recursive: true });
    const packetPath = join(packetsDir, `librarian-packet-${dispatchId}.json`);
    writeFileSync(
      packetPath,
      JSON.stringify({ schema_version: "1.0", role: "closeout-librarian", run_id: runId, dispatch_id: dispatchId, cluster_id: clusterId, result_path: resultPath }, null, 2),
      "utf-8",
    );
    return packetPath;
  }

  function writeLibrarianResult(
    resultPath: string,
    clusterId: string,
    dispatchId: string,
    status: "success" | "partial" | "blocked" | "failure" = "success",
    runId = "test-finalize-001",
  ): void {
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(
      resultPath,
      JSON.stringify({
        schema_version: "1.0",
        role: "closeout-librarian",
        run_id: runId,
        dispatch_id: dispatchId,
        cluster_id: clusterId,
        status,
        commit_sha: null,
        commit_message: "docs: closeout librarian",
        files_committed: [],
        polaris_md_updates: [],
        summary_md_updates: [],
        docs_ingested: [],
        docs_archived: [],
        yaml_updates: [],
        cognition_archived: [],
        link_validation: { checked: 0, broken: [], warnings: [] },
        blockers: [],
        reconciled_at: new Date().toISOString(),
        evidence_summary: "ok",
      }, null, 2),
      "utf-8",
    );
  }

  it("aborts when no librarian packet exists", async () => {
    const { runFinalize } = await import("./index.js");
    const stateFile = setupFinalizeRun();

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    let stderr = "";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as never);

    await expect(runFinalize({ repoRoot: testDir, stateFile })).rejects.toThrow("process.exit called");
    expect(stderr).toContain("Closeout Librarian has not been dispatched");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("aborts when packet exists but result is missing", async () => {
    const { runFinalize } = await import("./index.js");
    const stateFile = setupFinalizeRun();
    const resultPath = join(testDir, ".polaris", "clusters", "POL-6", "results", "librarian-d-1.json");
    writeLibrarianPacket("POL-6", "d-1", resultPath);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    let stderr = "";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as never);

    await expect(runFinalize({ repoRoot: testDir, stateFile })).rejects.toThrow("process.exit called");
    expect(stderr).toContain("Closeout Librarian has not written its sealed result yet");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("proceeds past the gate when a valid librarian result exists", async () => {
    const { runFinalize } = await import("./index.js");
    const stateFile = setupFinalizeRun();
    const resultPath = join(testDir, ".polaris", "clusters", "POL-6", "results", "librarian-d-2.json");
    writeLibrarianPacket("POL-6", "d-2", resultPath);
    writeLibrarianResult(resultPath, "POL-6", "d-2");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runFinalize({ repoRoot: testDir, stateFile })).rejects.toThrow();
    const logs = logSpy.mock.calls.map(([line]) => String(line));
    expect(logs.some((line) => line.includes("Closeout Librarian gate passed."))).toBe(true);
    logSpy.mockRestore();
  });

  it("bypasses gate checks when --skip-librarian is set", async () => {
    const { runFinalize } = await import("./index.js");
    const stateFile = setupFinalizeRun();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true })).rejects.toThrow();
    const logs = logSpy.mock.calls.map(([line]) => String(line));
    expect(logs.some((line) => line.includes("Closeout Librarian gate skipped (--skip-librarian)."))).toBe(true);
    logSpy.mockRestore();
  });
});

// ---- preflight: state file authority gate ----------------------------------

describe("preflight: state file authority gate", () => {
  it("rejects .taskchain_artifacts/polaris-run/current-state.json (debug path)", async () => {
    const { runFinalize } = await import("./index.js");
    const testDir = makeTestDir();

    try {
      const stateFile = join(testDir, ".taskchain_artifacts", "polaris-run", "current-state.json");
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({
        schema_version: "1.0",
        run_id: "test-finalize-001",
        cluster_id: "POL-1",
        active_child: "",
        completed_children: [],
        open_children: [],
        step_cursor: "CLUSTER-COMPLETE",
        context_budget: { children_completed: 0 },
        status: "complete",
        branch: "",
      }, null, 2));
      writeEmptyAtlas(testDir);
      writeDurableClusterArtifacts(testDir, "POL-1");

      execFileSync("git", ["checkout", "-b", "pol-1-delivery"], { cwd: testDir, stdio: "pipe" });

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      let stderr = "";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }) as never);

      await expect(runFinalize({ repoRoot: testDir, stateFile })).rejects.toThrow("process.exit called");
      expect(stderr).toContain("compatibility/debug path");

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    } finally {
      rmSync(testDir, { recursive: true });
    }
  });

  it("rejects .polaris/runs/current-state.json (legacy path)", async () => {
    const { runFinalize } = await import("./index.js");
    const testDir = makeTestDir();

    try {
      const stateFile = join(testDir, ".polaris", "runs", "current-state.json");
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({
        schema_version: "1.0",
        run_id: "test-finalize-001",
        cluster_id: "POL-1",
        active_child: "",
        completed_children: [],
        open_children: [],
        step_cursor: "CLUSTER-COMPLETE",
        context_budget: { children_completed: 0 },
        status: "complete",
        branch: "",
      }, null, 2));
      writeEmptyAtlas(testDir);
      writeDurableClusterArtifacts(testDir, "POL-1");

      execFileSync("git", ["checkout", "-b", "pol-1-delivery"], { cwd: testDir, stdio: "pipe" });

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      let stderr = "";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }) as never);

      await expect(runFinalize({ repoRoot: testDir, stateFile })).rejects.toThrow("process.exit called");
      expect(stderr).toContain("legacy path");

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    } finally {
      rmSync(testDir, { recursive: true });
    }
  });
});

// ---- preflight: cluster_id branch match ----

describe("preflight: cluster_id branch match", () => {
  it("rejects when cluster_id does not match current branch", async () => {
    const { runFinalize } = await import("./index.js");
    const testDir = makeTestDir();

    try {
      const stateFile = join(testDir, ".polaris", "clusters", "POL-289", "state.json");
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({
        schema_version: "1.0",
        run_id: "test-finalize-001",
        cluster_id: "POL-289",
        active_child: "",
        completed_children: [],
        open_children: [],
        step_cursor: "CLUSTER-COMPLETE",
        context_budget: { children_completed: 0 },
        status: "complete",
        branch: "",
      }, null, 2));
      writeEmptyAtlas(testDir);
      writeDurableClusterArtifacts(testDir, "POL-289");

      execFileSync("git", ["checkout", "-b", "pol-296-delivery"], { cwd: testDir, stdio: "pipe" });

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      let stderr = "";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }) as never);

      await expect(runFinalize({ repoRoot: testDir, stateFile })).rejects.toThrow("process.exit called");
      expect(stderr).toContain("cluster_id mismatch");
      expect(stderr).toContain("POL-289");

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    } finally {
      rmSync(testDir, { recursive: true });
    }
  });

  it("accepts when cluster_id matches branch (case-insensitive, hyphen-normalized)", async () => {
    const { runFinalize } = await import("./index.js");
    const testDir = makeTestDir();

    try {
      const stateFile = join(testDir, ".polaris", "clusters", "POL-296", "state.json");
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({
        schema_version: "1.0",
        run_id: "test-finalize-001",
        cluster_id: "POL-296",
        active_child: "",
        completed_children: [],
        open_children: [],
        step_cursor: "CLUSTER-COMPLETE",
        context_budget: { children_completed: 0 },
        status: "complete",
        branch: "",
      }, null, 2));
      writeEmptyAtlas(testDir);
      writeDurableClusterArtifacts(testDir, "POL-296");

      execFileSync("git", ["checkout", "-b", "pol-296-delivery"], { cwd: testDir, stdio: "pipe" });

      // Stage at least one non-artifact file
      stageFile(testDir, "src/implementation.ts", "// test\n");

      await expect(runFinalize({ repoRoot: testDir, stateFile, dryRun: true })).resolves.not.toThrow();
    } finally {
      rmSync(testDir, { recursive: true });
    }
  });
});

// ---- preflight: state.branch match ----

describe("preflight: state.branch match", () => {
  it("rejects when state.branch differs from current git branch", async () => {
    const { runFinalize } = await import("./index.js");
    const testDir = makeTestDir();

    try {
      const stateFile = join(testDir, ".polaris", "clusters", "POL-302", "state.json");
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({
        schema_version: "1.0",
        run_id: "test-finalize-001",
        cluster_id: "POL-302",
        active_child: "",
        completed_children: [],
        open_children: [],
        step_cursor: "CLUSTER-COMPLETE",
        context_budget: { children_completed: 0 },
        status: "complete",
        branch: "pol-296-delivery",
      }, null, 2));
      writeEmptyAtlas(testDir);
      writeDurableClusterArtifacts(testDir, "POL-302");

      execFileSync("git", ["checkout", "-b", "pol-302-fix"], { cwd: testDir, stdio: "pipe" });

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      let stderr = "";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }) as never);

      await expect(runFinalize({ repoRoot: testDir, stateFile })).rejects.toThrow("process.exit called");
      expect(stderr).toContain("state.branch mismatch");
      expect(stderr).toContain("pol-296-delivery");
      expect(stderr).toContain("pol-302-fix");

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    } finally {
      rmSync(testDir, { recursive: true });
    }
  });

  it("accepts when state.branch matches current git branch", async () => {
    const { runFinalize } = await import("./index.js");
    const testDir = makeTestDir();

    try {
      const stateFile = join(testDir, ".polaris", "clusters", "POL-296", "state.json");
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({
        schema_version: "1.0",
        run_id: "test-finalize-001",
        cluster_id: "POL-296",
        active_child: "",
        completed_children: [],
        open_children: [],
        step_cursor: "CLUSTER-COMPLETE",
        context_budget: { children_completed: 0 },
        status: "complete",
        branch: "pol-296-delivery",
      }, null, 2));
      writeEmptyAtlas(testDir);
      writeDurableClusterArtifacts(testDir, "POL-296");

      execFileSync("git", ["checkout", "-b", "pol-296-delivery"], { cwd: testDir, stdio: "pipe" });

      // Stage at least one non-artifact file
      stageFile(testDir, "src/implementation.ts", "// test\n");

      await expect(runFinalize({ repoRoot: testDir, stateFile, dryRun: true })).resolves.not.toThrow();
    } finally {
      rmSync(testDir, { recursive: true });
    }
  });

  it("accepts when state.branch is empty", async () => {
    const { runFinalize } = await import("./index.js");
    const testDir = makeTestDir();

    try {
      const stateFile = join(testDir, ".polaris", "clusters", "POL-296", "state.json");
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({
        schema_version: "1.0",
        run_id: "test-finalize-001",
        cluster_id: "POL-296",
        active_child: "",
        completed_children: [],
        open_children: [],
        step_cursor: "CLUSTER-COMPLETE",
        context_budget: { children_completed: 0 },
        status: "complete",
        branch: "",
      }, null, 2));
      writeEmptyAtlas(testDir);
      writeDurableClusterArtifacts(testDir, "POL-296");

      execFileSync("git", ["checkout", "-b", "pol-296-delivery"], { cwd: testDir, stdio: "pipe" });

      // Stage at least one non-artifact file
      stageFile(testDir, "src/implementation.ts", "// test\n");

      await expect(runFinalize({ repoRoot: testDir, stateFile, dryRun: true })).resolves.not.toThrow();
    } finally {
      rmSync(testDir, { recursive: true });
    }
  });
});

// ---- createDraftPr: validation ----

describe("createDraftPr validation", () => {
  function makeMinimalState(overrides: Partial<Record<string, unknown>> = {}): import("../loop/checkpoint.js").LoopState {
    return {
      schema_version: "1.0",
      run_id: "polaris-run-pol-296-2026-06-03-001",
      cluster_id: "POL-296",
      active_child: "",
      completed_children: ["POL-297", "POL-298"],
      open_children: [],
      step_cursor: "CLUSTER-COMPLETE",
      context_budget: { children_completed: 2 },
      status: "complete",
      next_open_child: null,
      ...overrides,
    } as import("../loop/checkpoint.js").LoopState;
  }

  it("throws if state.cluster_id is empty", async () => {
    const { createDraftPr } = await import("./github.js");
    const state = makeMinimalState({ cluster_id: "" });
    expect(() =>
      createDraftPr({ repoRoot: "/tmp", branch: "pol-296-delivery", state, draft: true })
    ).toThrow(/state\.cluster_id is empty/);
  });

  it("throws if branch does not contain the cluster ID slug", async () => {
    const { createDraftPr } = await import("./github.js");
    const state = makeMinimalState({ cluster_id: "POL-296" });
    expect(() =>
      createDraftPr({ repoRoot: "/tmp", branch: "pol-999-delivery", state, draft: true })
    ).toThrow(/branch.*pol-999-delivery.*does not contain cluster ID slug.*pol-296/);
  });

  it("rejects branch with prefix collision (POL-29 should not match pol-296-delivery)", async () => {
    const { createDraftPr } = await import("./github.js");
    const state = makeMinimalState({ cluster_id: "POL-29" });
    expect(() =>
      createDraftPr({ repoRoot: "/tmp", branch: "pol-296-delivery", state, draft: true })
    ).toThrow(/branch.*pol-296-delivery.*does not contain cluster ID slug.*pol-29/);
  });

  it("accepts branch when cluster ID matches as a full token (POL-29 matches pol-29-delivery)", async () => {
    // Clear module cache and mock execFileSync before importing
    vi.resetModules();
    const mockExecFileSync = vi.fn(() => "https://github.com/test/repo/pull/42");
    vi.doMock("node:child_process", () => ({ execFileSync: mockExecFileSync }));
    const { createDraftPr } = await import("./github.js");
    const state = makeMinimalState({ cluster_id: "POL-29" });
    // This should not throw
    expect(() =>
      createDraftPr({ repoRoot: "/tmp", branch: "pol-29-delivery", state, draft: true })
    ).not.toThrow();
  });
});

// ---- QC repair-loop terminal state gate (unit tests) ----

describe("validateQcRepairLoopGate", () => {
  function makeState(overrides: Partial<Record<string, unknown>> = {}): import("../loop/checkpoint.js").LoopState {
    return {
      schema_version: "1.0",
      run_id: "test-run-001",
      cluster_id: "POL-6",
      active_child: "",
      completed_children: ["POL-9"],
      open_children: [],
      step_cursor: "CLUSTER-COMPLETE",
      context_budget: { children_completed: 1 },
      status: "complete",
      next_open_child: null,
      ...overrides,
    } as import("../loop/checkpoint.js").LoopState;
  }

  it("returns null when QC is disabled", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(makeState(), { enabled: false });
    expect(result).toBeNull();
  });

  it("returns null when repair routing is 'log'", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(makeState(), {
      enabled: true,
      repairRouting: "log",
    });
    expect(result).toBeNull();
  });

  it("returns null when repair routing is 'block'", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(makeState(), {
      enabled: true,
      repairRouting: "block",
    });
    expect(result).toBeNull();
  });

  it("blocks when no qc_repair_loop state exists", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(makeState(), {
      enabled: true,
      repairRouting: "route",
    });
    expect(result).toBeTruthy();
    expect(result).toContain("no qc_repair_loop state");
  });

  it("blocks when terminal_outcome is null (in-flight)", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(
      makeState({
        qc_repair_loop: {
          current_round: 1,
          max_rounds: 2,
          source_qc_run_ids: [],
          manifest_path: null,
          pending_packet_ids: [],
          completed_packet_ids: [],
          rerun_requested: false,
          rerun_qc_run_ids: {},
          terminal_outcome: null,
          initiated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }),
      { enabled: true, repairRouting: "route" },
    );
    expect(result).toBeTruthy();
    expect(result).toContain("still in-flight");
  });

  it("blocks on 'all-providers-failed' outcome", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(
      makeState({
        qc_repair_loop: {
          current_round: 1,
          max_rounds: 2,
          source_qc_run_ids: [],
          manifest_path: null,
          pending_packet_ids: [],
          completed_packet_ids: [],
          rerun_requested: false,
          rerun_qc_run_ids: {},
          terminal_outcome: "all-providers-failed",
          initiated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }),
      { enabled: true, repairRouting: "route" },
    );
    expect(result).toBeTruthy();
    expect(result).toContain("all-providers-failed");
    expect(result).toContain("untrusted outcome");
  });

  it("blocks on 'max-rounds' outcome", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(
      makeState({
        qc_repair_loop: {
          current_round: 2,
          max_rounds: 2,
          source_qc_run_ids: [],
          manifest_path: null,
          pending_packet_ids: [],
          completed_packet_ids: [],
          rerun_requested: false,
          rerun_qc_run_ids: {},
          terminal_outcome: "max-rounds",
          initiated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }),
      { enabled: true, repairRouting: "route" },
    );
    expect(result).toBeTruthy();
    expect(result).toContain("max-rounds");
  });

  it("returns null on 'pass' outcome", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(
      makeState({
        qc_repair_loop: {
          current_round: 1,
          max_rounds: 2,
          source_qc_run_ids: [],
          manifest_path: null,
          pending_packet_ids: [],
          completed_packet_ids: [],
          rerun_requested: false,
          rerun_qc_run_ids: {},
          terminal_outcome: "pass",
          initiated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }),
      { enabled: true, repairRouting: "route" },
    );
    expect(result).toBeNull();
  });

  it("returns null on 'no-repairable' outcome", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(
      makeState({
        qc_repair_loop: {
          current_round: 1,
          max_rounds: 2,
          source_qc_run_ids: [],
          manifest_path: null,
          pending_packet_ids: [],
          completed_packet_ids: [],
          rerun_requested: false,
          rerun_qc_run_ids: {},
          terminal_outcome: "no-repairable",
          initiated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }),
      { enabled: true, repairRouting: "follow-up" },
    );
    expect(result).toBeNull();
  });

  it("returns null on 'qc-disabled' outcome", async () => {
    const { validateQcRepairLoopGate } = await import("./index.js");
    const result = validateQcRepairLoopGate(
      makeState({
        qc_repair_loop: {
          current_round: 0,
          max_rounds: 2,
          source_qc_run_ids: [],
          manifest_path: null,
          pending_packet_ids: [],
          completed_packet_ids: [],
          rerun_requested: false,
          rerun_qc_run_ids: {},
          terminal_outcome: "qc-disabled",
          initiated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }),
      { enabled: true, repairRouting: "route" },
    );
    expect(result).toBeNull();
  });
});

// ---- Authoritative completed-child state cross-check (unit tests) ----

describe("validateAuthoritativeChildState", () => {
  let testDir: string;
  beforeEach(() => { testDir = makeTestDir(); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  function makeState(overrides: Partial<Record<string, unknown>> = {}): import("../loop/checkpoint.js").LoopState {
    return {
      schema_version: "1.0",
      run_id: "test-run-001",
      cluster_id: "POL-6",
      active_child: "",
      completed_children: ["POL-9", "POL-10", "POL-11"],
      open_children: [],
      step_cursor: "CLUSTER-COMPLETE",
      context_budget: { children_completed: 3 },
      status: "complete",
      next_open_child: null,
      ...overrides,
    } as import("../loop/checkpoint.js").LoopState;
  }

  it("returns ok when no cluster state exists (backward-compat)", async () => {
    const { validateAuthoritativeChildState } = await import("./index.js");
    const state = makeState();
    const result = validateAuthoritativeChildState(state, testDir);
    expect(result.ok).toBe(true);
    expect(result.authoritativeCount).toBe(3);
    expect(result.stateCount).toBe(3);
  });

  it("returns ok when cluster-state done count matches loop state", async () => {
    const { validateAuthoritativeChildState } = await import("./index.js");
    const state = makeState();
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-6");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-6",
        state_generation: 1,
        child_states: [
          { id: "POL-9", status: "done" },
          { id: "POL-10", status: "done" },
          { id: "POL-11", status: "done" },
        ],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }),
    );
    const result = validateAuthoritativeChildState(state, testDir);
    expect(result.ok).toBe(true);
    expect(result.authoritativeCount).toBe(3);
  });

  it("returns ok when cluster-state has more done children than loop state", async () => {
    const { validateAuthoritativeChildState } = await import("./index.js");
    const state = makeState({ completed_children: ["POL-9"] });
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-6");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-6",
        state_generation: 1,
        child_states: [
          { id: "POL-9", status: "done" },
          { id: "POL-10", status: "done" },
        ],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }),
    );
    const result = validateAuthoritativeChildState(state, testDir);
    expect(result.ok).toBe(true);
    expect(result.authoritativeCount).toBe(2);
  });

  it("blocks when cluster-state has 0 done children but loop state has completions (stale state)", async () => {
    const { validateAuthoritativeChildState } = await import("./index.js");
    const state = makeState();
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-6");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-6",
        state_generation: 1,
        child_states: [
          { id: "POL-9", status: "ready" },
          { id: "POL-10", status: "ready" },
          { id: "POL-11", status: "ready" },
        ],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }),
    );
    const result = validateAuthoritativeChildState(state, testDir);
    expect(result.ok).toBe(false);
    expect(result.authoritativeCount).toBe(0);
    expect(result.stateCount).toBe(3);
    expect(result.reason).toContain("Stale cluster state");
  });

  it("blocks when cluster-state has fewer done children than loop state claims", async () => {
    const { validateAuthoritativeChildState } = await import("./index.js");
    const state = makeState();
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-6");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-6",
        state_generation: 1,
        child_states: [
          { id: "POL-9", status: "done" },
          { id: "POL-10", status: "running" },
          { id: "POL-11", status: "ready" },
        ],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }),
    );
    const result = validateAuthoritativeChildState(state, testDir);
    expect(result.ok).toBe(false);
    expect(result.authoritativeCount).toBe(1);
    expect(result.stateCount).toBe(3);
    expect(result.reason).toContain("count mismatch");
  });

  it("treats 'reviewed' and 'finalized' child states as done", async () => {
    const { validateAuthoritativeChildState } = await import("./index.js");
    const state = makeState();
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-6");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-6",
        state_generation: 1,
        child_states: [
          { id: "POL-9", status: "done" },
          { id: "POL-10", status: "reviewed" },
          { id: "POL-11", status: "finalized" },
        ],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }),
    );
    const result = validateAuthoritativeChildState(state, testDir);
    expect(result.ok).toBe(true);
    expect(result.authoritativeCount).toBe(3);
  });
});
