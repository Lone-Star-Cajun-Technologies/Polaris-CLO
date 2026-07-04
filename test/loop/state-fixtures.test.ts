/**
 * Fixture validation for durable loop run states checked into the repo under
 * `.polaris/clusters/<cluster>/state.json`.
 *
 * These fixtures (POL-394, POL-395) are added by the PR that reconciles
 * historical Polaris run records. They are validated against the existing
 * `validateState()` schema gate from `src/loop/checkpoint.ts` to guard
 * against malformed run-history data ever being checked in.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateState } from "../../src/loop/checkpoint.js";

const repoRoot = process.cwd();

function readClusterState(clusterId: string): unknown {
  const statePath = join(repoRoot, ".polaris", "clusters", clusterId, "state.json");
  return JSON.parse(readFileSync(statePath, "utf8"));
}

describe.each(["POL-394", "POL-395"])("%s state.json fixture", (clusterId) => {
  it("passes validateState() with no schema errors", () => {
    const state = readClusterState(clusterId);
    expect(validateState(state)).toEqual([]);
  });

  it("is a completed run with a matching cluster_id and non-empty completed_children", () => {
    const state = readClusterState(clusterId) as Record<string, unknown>;
    expect(state.cluster_id).toBe(clusterId);
    expect(state.status).toBe("complete");
    expect(Array.isArray(state.completed_children)).toBe(true);
    expect((state.completed_children as unknown[]).length).toBeGreaterThan(0);
    expect(state.open_children).toEqual([]);
    expect(state.next_open_child).toBeNull();
  });

  it("has a dispatch_boundary where dispatch_epoch is >= continue_epoch", () => {
    const state = readClusterState(clusterId) as {
      dispatch_boundary?: { dispatch_epoch: number; continue_epoch: number };
    };
    expect(state.dispatch_boundary).toBeDefined();
    expect(state.dispatch_boundary!.dispatch_epoch).toBeGreaterThanOrEqual(state.dispatch_boundary!.continue_epoch);
  });

  it("has a run_bootstrap_seal bound to the same run_id and cluster_id", () => {
    const state = readClusterState(clusterId) as {
      run_id: string;
      cluster_id: string;
      run_bootstrap_seal?: { sealer: string; run_id: string; cluster_id: string };
    };
    expect(state.run_bootstrap_seal).toBeDefined();
    expect(state.run_bootstrap_seal!.sealer).toBe("polaris-loop-bootstrap");
    expect(state.run_bootstrap_seal!.run_id).toBe(state.run_id);
    expect(state.run_bootstrap_seal!.cluster_id).toBe(state.cluster_id);
  });
});

describe("POL-394 state.json fixture specifics", () => {
  it("records the four completed setup-interview children in order", () => {
    const state = readClusterState("POL-394") as { completed_children: string[] };
    expect(state.completed_children).toEqual(["POL-398", "POL-399", "POL-400", "POL-401"]);
  });

  it("links each completed child's dispatch record back to itself", () => {
    const state = readClusterState("POL-394") as {
      open_children_meta: Record<string, { dispatch_record?: { child_id: string } }>;
    };
    for (const childId of ["POL-398", "POL-399", "POL-400", "POL-401"]) {
      const meta = state.open_children_meta[childId];
      expect(meta.dispatch_record?.child_id).toBe(childId);
    }
  });
});

describe("POL-395 state.json fixture specifics", () => {
  it("records the four completed operator-interview children in order", () => {
    const state = readClusterState("POL-395") as { completed_children: string[] };
    expect(state.completed_children).toEqual(["POL-402", "POL-403", "POL-404", "POL-405"]);
  });

  it("carries a pull request URL for the delivered branch", () => {
    const state = readClusterState("POL-395") as { pr_url?: string; branch?: string };
    expect(state.branch).toBe("pol-395-delivery");
    expect(state.pr_url).toMatch(/^https:\/\/github\.com\//);
  });
});