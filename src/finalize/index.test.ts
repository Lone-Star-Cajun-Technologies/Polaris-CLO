import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

vi.mock("./steps/06-commit.js", () => ({
  stepStageArtifacts: vi.fn(),
  stepCommit: vi.fn(() => "sha"),
}));

vi.mock("./steps/07-push.js", () => ({ stepPush: vi.fn() }));
vi.mock("./steps/08-create-pr.js", () => ({ stepCreatePr: vi.fn() }));
vi.mock("./steps/11-update-linear.js", () => ({
  stepUpdateLinear: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./steps/12-archive.js", () => ({ stepArchive: vi.fn() }));

vi.mock("../qc/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../qc/index.js")>();
  return {
    ...actual,
    runQcAtTrigger: vi.fn(),
    runQcRepairLoop: vi.fn(),
  };
});

import { runFinalize } from "./index.js";
import { stepStageArtifacts, stepCommit } from "./steps/06-commit.js";
import { stepPush } from "./steps/07-push.js";
import { stepCreatePr } from "./steps/08-create-pr.js";
import { runQcAtTrigger } from "../qc/index.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-finalize-index-${Date.now()}`);
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
    JSON.stringify(
      {
        schema_version: "1.0",
        run_id: "test-finalize-index-001",
        cluster_id: clusterId,
        active_child: "",
        completed_children: ["POL-9"],
        open_children: [],
        step_cursor: "CLUSTER-COMPLETE",
        context_budget: { children_completed: 1 },
        status: "complete",
        next_open_child: null,
      },
      null,
      2,
    ),
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

describe("runFinalize artifact staging order", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("stages durable Polaris artifacts before running completed-cluster QC", async () => {
    const clusterId = "POL-6";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify(
        {
          version: "1.0",
          qc: {
            enabled: true,
            defaultTrigger: "completed-cluster",
            providers: {
              test: { name: "test", mode: "local" },
            },
            repairRouting: "route",
          },
        },
        null,
        2,
      ),
    );

    vi.mocked(runQcAtTrigger).mockResolvedValue({
      trigger: "completed-cluster",
      results: [],
      action: "pass",
      summary: "ok",
    });

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true, skipDelivery: true }),
    ).resolves.toBeUndefined();

    const stageOrder = (stepStageArtifacts as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const qcOrder = (runQcAtTrigger as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const commitOrder = (stepCommit as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];

    expect(typeof stageOrder).toBe("number");
    expect(typeof qcOrder).toBe("number");
    expect(stageOrder).toBeLessThan(qcOrder);
    expect(commitOrder).toBeGreaterThan(qcOrder);
  });

  it("seals the final commit SHA for PR creation", async () => {
    const clusterId = "POL-6";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify(
        {
          version: "1.0",
          qc: {
            enabled: true,
            defaultTrigger: "completed-cluster",
            providers: {
              test: { name: "test", mode: "local" },
            },
            repairRouting: "route",
          },
        },
        null,
        2,
      ),
    );

    vi.mocked(runQcAtTrigger).mockResolvedValue({
      trigger: "completed-cluster",
      results: [],
      action: "pass",
      summary: "ok",
    });
    vi.mocked(stepCreatePr).mockReturnValue("https://github.com/test/repo/pull/42");
    vi.mocked(stepPush).mockReturnValue(undefined);

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true }),
    ).resolves.toBeUndefined();

    expect(stepCreatePr).toHaveBeenCalledOnce();
    const calledState = (stepCreatePr as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(calledState).toHaveProperty("qc_repair_loop.sealed_head_sha", "sha");
  });
});
