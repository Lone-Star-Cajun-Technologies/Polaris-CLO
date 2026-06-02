import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { backfillClusterStateEvidence, isPlaceholderCommit } from "./evidence-backfill.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeJson(root: string, rel: string, value: unknown): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, JSON.stringify(value, null, 2), "utf-8");
}

function readJson(root: string, rel: string): unknown {
  return JSON.parse(readFileSync(join(root, rel), "utf-8"));
}

function makeStateFile(opts: {
  clusterId: string;
  completedChildren: string[];
  openChildrenMeta?: Record<string, unknown>;
}): object {
  return {
    schema_version: "1.0",
    run_id: `polaris-run-${opts.clusterId}-test`,
    cluster_id: opts.clusterId,
    active_child: "",
    completed_children: opts.completedChildren,
    open_children: [],
    open_children_meta: opts.openChildrenMeta ?? {},
    step_cursor: null,
    context_budget: { children_completed: opts.completedChildren.length },
    status: "running",
    next_open_child: null,
  };
}

function makeClusterState(clusterId: string, childIds: string[]): object {
  return {
    schema_version: "1.0",
    cluster_id: clusterId,
    state_generation: 1,
    child_states: childIds.map((id) => ({ id, status: "ready" })),
    claim_metadata: {},
    packet_pointers: {},
    result_pointers: {},
    validation_results: {},
    commits: {},
    tracker_mutations: {},
    blockers: [],
  };
}

const created: string[] = [];

function makeRoot(label: string): string {
  const root = join(process.cwd(), `.vitest-backfill-${label}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  created.push(root);
  return root;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// isPlaceholderCommit
// ---------------------------------------------------------------------------

describe("isPlaceholderCommit", () => {
  it("accepts full 40-char hex SHA", () => {
    expect(isPlaceholderCommit("af422bba2433e6c833c3944e45a619224c326570")).toBe(false);
  });

  it("accepts 7-char short SHA", () => {
    expect(isPlaceholderCommit("af422bb")).toBe(false);
  });

  it("rejects pending-single-commit", () => {
    expect(isPlaceholderCommit("pending-single-commit")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isPlaceholderCommit("")).toBe(true);
  });

  it("rejects undefined / null", () => {
    expect(isPlaceholderCommit(undefined)).toBe(true);
    expect(isPlaceholderCommit(null)).toBe(true);
  });

  it("accepts strings with uppercase hex", () => {
    expect(isPlaceholderCommit("AF422BBA")).toBe(false);
  });

  it("accepts 64-char SHA-256 hex", () => {
    expect(isPlaceholderCommit("A".repeat(64))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// backfillClusterStateEvidence
// ---------------------------------------------------------------------------

const CLUSTER_ID = "POL-TEST";
const COMMIT_278 = "af422bba2433e6c833c3944e45a619224c326570";
const COMMIT_279 = "43ef1484ae0a029a0efb876a8c51b79fcb92f970";
const COMMIT_280 = "6ce3d945654eb7faa26c30751146b90c86daba24";

function setupStandardFixtures(root: string) {
  // current-state.json: 4 completed children, POL-277 first (has placeholder commit)
  writeJson(root, ".taskchain_artifacts/polaris-run/current-state.json",
    makeStateFile({
      clusterId: CLUSTER_ID,
      completedChildren: ["POL-277", "POL-278", "POL-279", "POL-280"],
    }));

  // cluster-state.json: all children in ready state, nothing backfilled yet
  writeJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`,
    makeClusterState(CLUSTER_ID, ["POL-277", "POL-278", "POL-279", "POL-280"]));

  // Result files
  writeJson(root, `.polaris/clusters/${CLUSTER_ID}/results/POL-277-aaaa.json`, {
    child_id: "POL-277",
    status: "done",
    commit: "pending-single-commit",
    validation: { passed: ["npm run build"], failed: [] },
  });
  writeJson(root, `.polaris/clusters/${CLUSTER_ID}/results/POL-278-bbbb.json`, {
    child_id: "POL-278",
    status: "done",
    commit: COMMIT_278,
    validation: { passed: ["npm run build", "npm test"], failed: [] },
  });
  writeJson(root, `.polaris/clusters/${CLUSTER_ID}/results/POL-279-cccc.json`, {
    child_id: "POL-279",
    status: "done",
    commit: COMMIT_279,
    validation: { passed: ["npm run build"] },
  });
  writeJson(root, `.polaris/clusters/${CLUSTER_ID}/results/POL-280-dddd.json`, {
    child_id: "POL-280",
    status: "done",
    commit: COMMIT_280,
    validation: { passed: ["npm test"] },
  });
}

describe("backfillClusterStateEvidence — standard run", () => {
  it("backfills POL-278, POL-279, POL-280 and skips POL-277 (placeholder commit)", () => {
    const root = makeRoot("standard");
    setupStandardFixtures(root);

    const report = backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    expect(report.clusterId).toBe(CLUSTER_ID);
    expect(report.backfilled.map((b) => b.childId)).toEqual(["POL-278", "POL-279", "POL-280"]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.childId).toBe("POL-277");
    expect(report.skipped[0]!.reason).toMatch(/placeholder/);
  });

  it("writes commits to cluster-state.json for backfilled children", () => {
    const root = makeRoot("commits");
    setupStandardFixtures(root);

    backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    const cs = readJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`) as Record<string, unknown>;
    const commits = cs["commits"] as Record<string, string>;
    expect(commits["POL-278"]).toBe(COMMIT_278);
    expect(commits["POL-279"]).toBe(COMMIT_279);
    expect(commits["POL-280"]).toBe(COMMIT_280);
    expect(commits["POL-277"]).toBeUndefined();
  });

  it("writes result_pointers for backfilled children", () => {
    const root = makeRoot("result-ptrs");
    setupStandardFixtures(root);

    backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    const cs = readJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`) as Record<string, unknown>;
    const ptrs = cs["result_pointers"] as Record<string, string>;
    expect(ptrs["POL-278"]).toMatch(/POL-278/);
    expect(ptrs["POL-279"]).toMatch(/POL-279/);
    expect(ptrs["POL-280"]).toMatch(/POL-280/);
    expect(ptrs["POL-277"]).toBeUndefined();
  });

  it("writes validation_results with passed=true for backfilled children", () => {
    const root = makeRoot("val-results");
    setupStandardFixtures(root);

    backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    const cs = readJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`) as Record<string, unknown>;
    const vr = cs["validation_results"] as Record<string, { passed: boolean }>;
    expect(vr["POL-278"]?.passed).toBe(true);
    expect(vr["POL-279"]?.passed).toBe(true);
    expect(vr["POL-280"]?.passed).toBe(true);
    expect(vr["POL-277"]).toBeUndefined();
  });

  it("sets child_states[*].status = done for backfilled children", () => {
    const root = makeRoot("child-status");
    setupStandardFixtures(root);

    backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    const cs = readJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`) as Record<string, unknown>;
    const states = cs["child_states"] as Array<{ id: string; status: string }>;
    const byId = Object.fromEntries(states.map((s) => [s.id, s.status]));
    expect(byId["POL-278"]).toBe("done");
    expect(byId["POL-279"]).toBe("done");
    expect(byId["POL-280"]).toBe("done");
    // POL-277 was skipped — status must not be set to done
    expect(byId["POL-277"]).not.toBe("done");
  });

  it("increments state_generation", () => {
    const root = makeRoot("gen");
    setupStandardFixtures(root);

    backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    const cs = readJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`) as Record<string, unknown>;
    expect(cs["state_generation"]).toBe(2);
  });

  it("dry-run does not write cluster-state.json", () => {
    const root = makeRoot("dry");
    setupStandardFixtures(root);

    const report = backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
      dryRun: true,
    });

    expect(report.backfilled).toHaveLength(3);
    const cs = readJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`) as Record<string, unknown>;
    // state_generation must still be 1 (unchanged)
    expect(cs["state_generation"]).toBe(1);
    expect((cs["commits"] as Record<string, string>)["POL-278"]).toBeUndefined();
  });
});

describe("backfillClusterStateEvidence — edge cases", () => {
  it("skips child with no result file", () => {
    const root = makeRoot("no-result");
    writeJson(root, ".taskchain_artifacts/polaris-run/current-state.json",
      makeStateFile({ clusterId: CLUSTER_ID, completedChildren: ["POL-999"] }));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`,
      makeClusterState(CLUSTER_ID, ["POL-999"]));

    const report = backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    expect(report.backfilled).toHaveLength(0);
    expect(report.skipped[0]!.childId).toBe("POL-999");
    expect(report.skipped[0]!.reason).toMatch(/no result file/);
  });

  it("skips child with missing validation when no validation_waiver on packet", () => {
    const root = makeRoot("no-validation");
    writeJson(root, ".taskchain_artifacts/polaris-run/current-state.json",
      makeStateFile({ clusterId: CLUSTER_ID, completedChildren: ["POL-AAA"] }));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`,
      makeClusterState(CLUSTER_ID, ["POL-AAA"]));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/results/POL-AAA-uuid.json`, {
      child_id: "POL-AAA",
      status: "done",
      commit: "abc1234",
      validation: { passed: [], failed: ["npm test"] },
    });

    const report = backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    expect(report.backfilled).toHaveLength(0);
    expect(report.skipped[0]!.reason).toMatch(/validation/);
  });

  it("accepts child with empty validation when packet has validation_waiver", () => {
    const root = makeRoot("waiver");
    writeJson(root, ".taskchain_artifacts/polaris-run/current-state.json",
      makeStateFile({ clusterId: CLUSTER_ID, completedChildren: ["POL-BBB"] }));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`,
      makeClusterState(CLUSTER_ID, ["POL-BBB"]));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/results/POL-BBB-uuid.json`, {
      child_id: "POL-BBB",
      status: "done",
      commit: "abc1234",
      validation: { passed: [], failed: [] },
    });
    // Packet with validation_waiver
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/packets/POL-BBB-uuid.json`, {
      schema_version: "2.1",
      instructions: { validation_waiver: "no tests required for doc-only change" },
    });

    const report = backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    expect(report.backfilled).toHaveLength(1);
    expect(report.backfilled[0]!.childId).toBe("POL-BBB");
  });

  it("uses dispatch_record.expected_result_path when present in open_children_meta", () => {
    const root = makeRoot("dispatch-record");
    const resultRelPath = `.polaris/clusters/${CLUSTER_ID}/results/POL-CCC-explicit.json`;
    writeJson(root, ".taskchain_artifacts/polaris-run/current-state.json",
      makeStateFile({
        clusterId: CLUSTER_ID,
        completedChildren: ["POL-CCC"],
        openChildrenMeta: {
          "POL-CCC": {
            dispatch_record: {
              packet_path: `.polaris/clusters/${CLUSTER_ID}/packets/POL-CCC-explicit.json`,
              expected_result_path: resultRelPath,
            },
          },
        },
      }));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`,
      makeClusterState(CLUSTER_ID, ["POL-CCC"]));
    writeJson(root, resultRelPath, {
      child_id: "POL-CCC",
      status: "done",
      commit: "deadbeef",
      validation: { passed: ["npm run build"] },
    });

    const report = backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    expect(report.backfilled).toHaveLength(1);
    expect(report.backfilled[0]!.commit).toBe("deadbeef");
  });

  it("uses result_file from open_children_meta over dispatch_record.expected_result_path", () => {
    const root = makeRoot("result-file-meta");
    const overridePath = `.polaris/clusters/${CLUSTER_ID}/results/POL-DDD-override.json`;
    const defaultPath = `.polaris/clusters/${CLUSTER_ID}/results/POL-DDD-default.json`;
    writeJson(root, ".taskchain_artifacts/polaris-run/current-state.json",
      makeStateFile({
        clusterId: CLUSTER_ID,
        completedChildren: ["POL-DDD"],
        openChildrenMeta: {
          "POL-DDD": {
            result_file: overridePath,
            dispatch_record: {
              expected_result_path: defaultPath,
            },
          },
        },
      }));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`,
      makeClusterState(CLUSTER_ID, ["POL-DDD"]));
    writeJson(root, overridePath, {
      child_id: "POL-DDD",
      status: "done",
      commit: "cafe1234",
      validation: { passed: ["npm run build"] },
    });

    const report = backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    expect(report.backfilled).toHaveLength(1);
    expect(report.backfilled[0]!.commit).toBe("cafe1234");
  });

  it("chooses deterministic file match order when scanning result files", () => {
    const root = makeRoot("deterministic-scan");
    writeJson(root, ".taskchain_artifacts/polaris-run/current-state.json",
      makeStateFile({ clusterId: CLUSTER_ID, completedChildren: ["POL-DET"] }));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`,
      makeClusterState(CLUSTER_ID, ["POL-DET"]));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/results/POL-DET-z.json`, {
      child_id: "POL-DET",
      status: "done",
      commit: "abc1234",
      validation: { passed: ["npm run build"] },
    });
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/results/POL-DET-a.json`, {
      child_id: "POL-DET",
      status: "done",
      commit: "pending-single-commit",
      validation: { passed: ["npm run build"] },
    });

    const report = backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    expect(report.backfilled).toHaveLength(0);
    expect(report.skipped).toContainEqual({
      childId: "POL-DET",
      reason: "placeholder or missing commit: pending-single-commit",
    });
  });

  it("evicts claim_metadata for backfilled children", () => {
    const root = makeRoot("claim-metadata");
    writeJson(root, ".taskchain_artifacts/polaris-run/current-state.json",
      makeStateFile({ clusterId: CLUSTER_ID, completedChildren: ["POL-CLM"] }));
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`, {
      ...makeClusterState(CLUSTER_ID, ["POL-CLM"]),
      claim_metadata: {
        "POL-CLM": {
          worker_id: "worker-123",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      },
    });
    writeJson(root, `.polaris/clusters/${CLUSTER_ID}/results/POL-CLM-result.json`, {
      child_id: "POL-CLM",
      status: "done",
      commit: "abc1234",
      validation: { passed: ["npm run build"] },
    });

    backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    const cs = readJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`) as Record<string, unknown>;
    const claims = cs["claim_metadata"] as Record<string, unknown>;
    expect(claims["POL-CLM"]).toBeUndefined();
  });

  it("does not weaken finalize — cluster-state already backfilled is idempotent-safe on re-run", () => {
    const root = makeRoot("idempotent");
    setupStandardFixtures(root);

    backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    // Second run: state_generation is now 2; re-running should still increment
    const report2 = backfillClusterStateEvidence({
      repoRoot: root,
      stateFile: join(root, ".taskchain_artifacts/polaris-run/current-state.json"),
    });

    expect(report2.backfilled).toHaveLength(3);
    const cs = readJson(root, `.polaris/clusters/${CLUSTER_ID}/cluster-state.json`) as Record<string, unknown>;
    expect(cs["state_generation"]).toBe(3);
  });
});
