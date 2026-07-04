/**
 * Fixture validation for `.polaris/clusters/` snapshot data touched by this PR:
 *   - POL-374/cluster-state.json: bumped state_generation and a newly appended
 *     POL-432 child (done, validated, with matching pointers and commit).
 *   - POL-389/clusters.json: a new umbrella ANALYZE plan snapshot.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClusterState } from "../../src/cluster-state/types.js";

const repoRoot = process.cwd();

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(repoRoot, ...segments), "utf8")) as T;
}

describe("POL-374/cluster-state.json fixture", () => {
  const state = readJson<ClusterState>(".polaris", "clusters", "POL-374", "cluster-state.json");

  it("conforms to the ClusterState shape's required top-level fields", () => {
    expect(state.schema_version).toBe("1.0");
    expect(state.cluster_id).toBe("POL-374");
    expect(typeof state.state_generation).toBe("number");
    expect(Array.isArray(state.child_states)).toBe(true);
    expect(Array.isArray(state.blockers)).toBe(true);
  });

  it("bumped state_generation to 15 to reflect the newly appended child", () => {
    expect(state.state_generation).toBe(15);
  });

  it("appends POL-432 as a done child with a commit sha", () => {
    const pol432 = state.child_states.find((child) => child.id === "POL-432");
    expect(pol432).toBeDefined();
    expect(pol432?.status).toBe("done");
    expect(pol432?.commit).toBe("a16e76e6165700be3bc6dc18361ee70ca402a6a4");
  });

  it("records a passed validation result and matching commit/result pointer for POL-432", () => {
    expect(state.validation_results["POL-432"]).toEqual({ passed: true, output: "passed" });
    expect(state.commits["POL-432"]).toBe("a16e76e6165700be3bc6dc18361ee70ca402a6a4");
    expect(state.result_pointers["POL-432"]).toContain("POL-430/results/POL-432-");
  });

  it("does not regress any of the six previously completed children", () => {
    const previouslyDone = ["POL-375", "POL-376", "POL-377", "POL-378", "POL-379", "POL-380"];
    for (const childId of previouslyDone) {
      const child = state.child_states.find((c) => c.id === childId);
      expect(child?.status).toBe("done");
      expect(state.commits[childId]).toBeTruthy();
    }
    // Six pre-existing children plus the newly appended POL-432.
    expect(state.child_states).toHaveLength(7);
  });
});

interface PolAnalyzeChild {
  id: string;
  title: string;
  session_type: string;
  blockedBy: string[];
  implement_parent: string;
}

interface PolAnalyzeClusterSnapshot {
  source_id: string;
  analyze_source_id: string;
  source_type: string;
  clusters: { cluster_id: string; children: PolAnalyzeChild[] }[];
}

describe("POL-389/clusters.json fixture", () => {
  const snapshot = readJson<PolAnalyzeClusterSnapshot>(".polaris", "clusters", "POL-389", "clusters.json");

  it("is a linear-sourced umbrella ANALYZE plan for POL-389", () => {
    expect(snapshot.source_id).toBe("POL-389");
    expect(snapshot.analyze_source_id).toBe("POL-389");
    expect(snapshot.source_type).toBe("linear");
  });

  it("declares exactly one cluster with four ANALYZE children", () => {
    expect(snapshot.clusters).toHaveLength(1);
    expect(snapshot.clusters[0].children).toHaveLength(4);
    for (const child of snapshot.clusters[0].children) {
      expect(child.session_type).toBe("analyze");
    }
  });

  it("blocks POL-390/POL-391/POL-393 on POL-392 and leaves POL-392 unblocked", () => {
    const byId = Object.fromEntries(snapshot.clusters[0].children.map((child) => [child.id, child]));
    expect(byId["POL-392"].blockedBy).toEqual([]);
    expect(byId["POL-390"].blockedBy).toEqual(["POL-392"]);
    expect(byId["POL-391"].blockedBy).toEqual(["POL-392"]);
    expect(byId["POL-393"].blockedBy).toEqual(["POL-392"]);
  });

  it("maps each ANALYZE child to its corresponding IMPLEMENT cluster", () => {
    const byId = Object.fromEntries(snapshot.clusters[0].children.map((child) => [child.id, child]));
    expect(byId["POL-392"].implement_parent).toBe("POL-396");
    expect(byId["POL-390"].implement_parent).toBe("POL-394");
    expect(byId["POL-391"].implement_parent).toBe("POL-395");
    expect(byId["POL-393"].implement_parent).toBe("POL-397");
  });
});