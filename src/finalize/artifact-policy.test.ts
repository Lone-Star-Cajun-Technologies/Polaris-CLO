import { describe, expect, it } from "vitest";
import {
  classifyArtifactPath,
  explainArtifactPolicy,
  findArtifactPromotionViolations,
  getArtifactPromotionPolicy,
  isPromotedArtifactPath,
} from "./artifact-policy.js";

describe("artifact promotion policy", () => {
  it("promotes only durable evidence for the active cluster", () => {
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/clusters.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/cluster-state.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/packets/worker.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/results/worker.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/runs/ledger.jsonl", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/map/file-routes.json", "POL-242")).toBe(true);
  });

  it("flags workspace scratch, legacy run files, and foreign cluster evidence", () => {
    expect(classifyArtifactPath(".taskchain_artifacts/polaris-run/current-state.json", "POL-242")).toBe("workspace-scratch");
    expect(classifyArtifactPath(".taskchain_artifacts/polaris-run/runs/run-1/telemetry.jsonl", "POL-242")).toBe("workspace-scratch");
    expect(classifyArtifactPath(".polaris/runs/mutation-queue.json", "POL-242")).toBe("legacy-run-artifact");
    expect(classifyArtifactPath(".polaris/clusters/POL-240/cluster-state.json", "POL-242")).toBe("foreign-cluster-artifact");
    expect(classifyArtifactPath("src/finalize/steps/06-commit.ts", "POL-242")).toBe("non-artifact");
  });

  it("reports actionable commit-hygiene violations without blocking non-artifact files", () => {
    expect(findArtifactPromotionViolations([
      "src/finalize/index.ts",
      ".taskchain_artifacts/polaris-run/current-state.json",
      ".polaris/runs/mutation-queue.json",
      ".polaris/clusters/POL-240/results/POL-240.json",
      ".taskchain_artifacts/polaris-run/current-state.json.backup.bak",
    ], "POL-242")).toEqual([
      {
        path: ".taskchain_artifacts/polaris-run/current-state.json",
        classification: "workspace-scratch",
        message: explainArtifactPolicy(".taskchain_artifacts/polaris-run/current-state.json", "POL-242"),
      },
      {
        path: ".polaris/runs/mutation-queue.json",
        classification: "legacy-run-artifact",
        message: explainArtifactPolicy(".polaris/runs/mutation-queue.json", "POL-242"),
      },
      {
        path: ".polaris/clusters/POL-240/results/POL-240.json",
        classification: "foreign-cluster-artifact",
        message: explainArtifactPolicy(".polaris/clusters/POL-240/results/POL-240.json", "POL-242"),
      },
      {
        path: ".taskchain_artifacts/polaris-run/current-state.json.backup.bak",
        classification: "workspace-scratch",
        message: explainArtifactPolicy(".taskchain_artifacts/polaris-run/current-state.json.backup.bak", "POL-242"),
      },
    ]);
  });

  it("exposes promoted and blocked policy patterns for finalize consumers", () => {
    expect(getArtifactPromotionPolicy("POL-242")).toEqual({
      promoted: [
        ".polaris/clusters/POL-242/clusters.json",
        ".polaris/clusters/POL-242/cluster-state.json",
        ".polaris/clusters/POL-242/packets/**",
        ".polaris/clusters/POL-242/results/**",
        ".polaris/runs/ledger.jsonl",
        ".polaris/map/**",
      ],
      blocked: [
        ".taskchain_artifacts/**",
        "*.bak",
        ".polaris/runs/mutation-queue.json",
        ".polaris/runs/current-state.pre-pol-198.json",
        ".polaris/runs/evo-run-archive/**",
        ".polaris/clusters/<other-cluster>/**",
      ],
    });
  });
});
