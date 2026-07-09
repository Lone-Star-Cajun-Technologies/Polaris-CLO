import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Mock external finalize steps so these tests focus on QC trigger wiring.
vi.mock("./steps/07-push.js", () => ({ stepPush: vi.fn() }));
vi.mock("./steps/08-create-pr.js", () => ({ stepCreatePr: vi.fn() }));
vi.mock("./steps/11-update-linear.js", () => ({ stepUpdateLinear: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./steps/12-archive.js", () => ({ stepArchive: vi.fn() }));
vi.mock("../qc/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../qc/index.js")>();
  return {
    ...actual,
    runQcAtTrigger: vi.fn(),
  };
});

import { runQcAtTrigger } from "../qc/index.js";
import { stepCreatePr } from "./steps/08-create-pr.js";
import { runFinalize } from "./index.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-finalize-qc-${Date.now()}`);
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

function writeCanonicalState(dir: string, clusterId: string): string {
  const stateFile = join(dir, ".polaris", "clusters", clusterId, "state.json");
  mkdirSync(join(dir, ".polaris", "clusters", clusterId), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      schema_version: "1.0",
      run_id: "test-finalize-qc-001",
      cluster_id: clusterId,
      active_child: "",
      completed_children: ["POL-9"],
      open_children: [],
      step_cursor: "CLUSTER-COMPLETE",
      context_budget: { children_completed: 1 },
      status: "complete",
      next_open_child: null,
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
    }, null, 2),
  );
  return stateFile;
}

function writeClusterArtifacts(dir: string, clusterId: string): void {
  const clusterDir = join(dir, ".polaris", "clusters", clusterId);
  mkdirSync(join(clusterDir, "packets"), { recursive: true });
  mkdirSync(join(clusterDir, "results"), { recursive: true });
  mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
  writeFileSync(
    join(clusterDir, "cluster-state.json"),
    JSON.stringify({
      schema_version: "1.0",
      cluster_id: clusterId,
      state_generation: 1,
      child_states: [],
      claim_metadata: {},
      packet_pointers: {},
      result_pointers: {},
      validation_results: {},
      commits: {},
      tracker_mutations: {},
      blockers: [],
      qc_runs: {},
    }),
  );
  writeFileSync(join(clusterDir, "clusters.json"), "{}");
  writeFileSync(join(clusterDir, "packets", "packet.json"), "{}");
  writeFileSync(join(clusterDir, "results", "result.json"), "{}");
  writeFileSync(join(dir, ".polaris", "runs", "ledger.jsonl"), "{}\n");
}

function writeAtlas(dir: string): void {
  const mapDir = join(dir, ".polaris", "map");
  mkdirSync(mapDir, { recursive: true });
  for (const file of ["file-routes.json", "needs-review.json", "exemptions.json", "atlas-index.json"]) {
    writeFileSync(join(mapDir, file), "{}");
  }
}

function stageFile(dir: string, relativePath: string, content = "test\n"): void {
  const fullPath = join(dir, relativePath);
  const dirPart = relativePath.includes("/") ? relativePath.split("/").slice(0, -1).join("/") : ".";
  mkdirSync(join(dir, dirPart), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["add", relativePath], { cwd: dir, stdio: "pipe" });
}

describe("runFinalize QC trigger integration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    vi.mocked(runQcAtTrigger).mockReset();
    vi.mocked(stepCreatePr).mockReset();
    vi.mocked(stepCreatePr).mockReturnValue("https://github.com/org/repo/pull/42");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("runs completed-cluster QC before commit and PR QC after PR creation", async () => {
    const clusterId = "POL-6";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "completed-cluster",
          providers: {
            test: { name: "test", mode: "local" },
          },
          repairRouting: "route",
        },
      }),
    );

    vi.mocked(runQcAtTrigger).mockResolvedValue({
      trigger: "completed-cluster",
      results: [],
      action: "pass",
      summary: "ok",
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true });
    } catch (err) {
      // process.exit throws in tests; ignore if it is our marker.
      if (!(err instanceof Error && err.message === "process.exit called")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    const calls = vi.mocked(runQcAtTrigger).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]![0].trigger).toBe("completed-cluster");
    expect(calls[0]![0].baseRef).toBe("main");
    expect(calls[1]![0].trigger).toBe("pr");
    expect(calls[1]![0].prUrl).toBe("https://github.com/org/repo/pull/42");
  });

  it("blocks finalize when completed-cluster QC returns block", async () => {
    const clusterId = "POL-6";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "completed-cluster",
          providers: {
            test: { name: "test", mode: "local" },
          },
          repairRouting: "block",
        },
      }),
    );

    vi.mocked(runQcAtTrigger).mockResolvedValue({
      trigger: "completed-cluster",
      results: [],
      action: "block",
      summary: "blocked",
    });

    let exitCode: number | null = null;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("process.exit called");
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true }),
    ).rejects.toThrow("process.exit called");

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("blocked finalize"));

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
