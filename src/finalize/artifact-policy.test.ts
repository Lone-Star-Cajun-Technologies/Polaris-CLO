import { describe, expect, it } from "vitest";
import {
  classifyArtifactPath,
  explainArtifactPolicy,
  findArtifactPromotionViolations,
  getArtifactPromotionPolicy,
  getArtifactPromotionStageTargets,
  isPromotedArtifactPath,
  getGitignorePatterns,
  formatGitignoreBlock,
  isPathBlockedFromStaging,
  filterStageablePaths,
} from "./artifact-policy.js";

describe("artifact promotion policy", () => {
  it("promotes only durable evidence for the active cluster", () => {
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/clusters.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/cluster-state.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/state.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/packets/worker.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/results/worker.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/qc/qc-run-1.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/clusters/POL-242/qc/repair-rounds/1/repair-packets.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/runs/ledger.jsonl", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/cognition/archive/src/loop/cognition-index.json", "POL-242")).toBe(true);
    expect(isPromotedArtifactPath(".polaris/map/file-routes.json", "POL-242")).toBe(true);
  });

  it("flags workspace scratch, legacy run files, and foreign cluster evidence", () => {
    expect(classifyArtifactPath(".taskchain_artifacts/polaris-run/current-state.json", "POL-242")).toBe("workspace-scratch");
    expect(classifyArtifactPath(".taskchain_artifacts/polaris-run/runs/run-1/telemetry.jsonl", "POL-242")).toBe("workspace-scratch");
    expect(classifyArtifactPath(".polaris/runs/mutation-queue.json", "POL-242")).toBe("legacy-run-artifact");
    expect(classifyArtifactPath(".polaris/runs/current-state.json", "POL-242")).toBe("legacy-run-artifact");
    expect(classifyArtifactPath(".polaris/runs/run-report.md", "POL-242")).toBe("legacy-run-artifact");
    expect(classifyArtifactPath(".polaris/runs/evo-run-archive/run-1/telemetry.jsonl", "POL-242")).toBe("legacy-run-artifact");
    expect(classifyArtifactPath(".polaris/clusters/POL-240/cluster-state.json", "POL-242")).toBe("foreign-cluster-artifact");
    expect(classifyArtifactPath(".polaris/clusters/POL-240/qc/qc-run-1.json", "POL-242")).toBe("foreign-cluster-artifact");
    expect(classifyArtifactPath("src/finalize/steps/06-commit.ts", "POL-242")).toBe("non-artifact");
  });

  it("classifies per-run archive snapshots as git-ignored, non-promotable artifacts", () => {
    expect(classifyArtifactPath(".polaris/runs/run-1/telemetry.jsonl", "POL-242")).toBe("legacy-run-artifact");
    expect(classifyArtifactPath(".polaris/runs/run-1/run-report.md", "POL-242")).toBe("legacy-run-artifact");
    expect(classifyArtifactPath(".polaris/runs/run-1/current-state.json", "POL-242")).toBe("legacy-run-artifact");
    expect(classifyArtifactPath(".polaris/runs/run-1/file-routes.json", "POL-242")).toBe("legacy-run-artifact");
    expect(classifyArtifactPath(".polaris/runs/run-1/", "POL-242")).toBe("legacy-run-artifact");
  });

  it("flags per-run archive paths as delivery violations so they are never staged by finalize", () => {
    expect(findArtifactPromotionViolations([
      ".polaris/runs/run-1/telemetry.jsonl",
      ".polaris/runs/run-1/run-report.md",
      ".polaris/runs/run-1/current-state.json",
    ], "POL-242")).toEqual([
      {
        path: ".polaris/runs/run-1/telemetry.jsonl",
        classification: "legacy-run-artifact",
        message: explainArtifactPolicy(".polaris/runs/run-1/telemetry.jsonl", "POL-242"),
      },
      {
        path: ".polaris/runs/run-1/run-report.md",
        classification: "legacy-run-artifact",
        message: explainArtifactPolicy(".polaris/runs/run-1/run-report.md", "POL-242"),
      },
      {
        path: ".polaris/runs/run-1/current-state.json",
        classification: "legacy-run-artifact",
        message: explainArtifactPolicy(".polaris/runs/run-1/current-state.json", "POL-242"),
      },
    ]);
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
        ".polaris/clusters/POL-242/state.json",
        ".polaris/clusters/POL-242/packets/**",
        ".polaris/clusters/POL-242/results/**",
        ".polaris/clusters/POL-242/qc/**",
        ".polaris/runs/ledger.jsonl",
        ".polaris/cognition/archive/**",
        ".polaris/map/**",
      ],
      blocked: [
        ".taskchain_artifacts/**",
        "*.bak",
        ".polaris/runs/mutation-queue.json",
        ".polaris/runs/current-state.json",
        ".polaris/runs/run-report.md",
        ".polaris/runs/current-state.pre-pol-198.json",
        ".polaris/runs/evo-run-archive/**",
        ".polaris/bootstrap/**",
        ".polaris/session-type",
        ".polaris/tmp/**",
        ".polaris/clusters/<other-cluster>/**",
      ],
    });
  });

  it("derives git-add stage targets from promoted policy patterns", () => {
    expect(getArtifactPromotionStageTargets("POL-242")).toEqual([
      ".polaris/clusters/POL-242/clusters.json",
      ".polaris/clusters/POL-242/cluster-state.json",
      ".polaris/clusters/POL-242/state.json",
      ".polaris/clusters/POL-242/packets",
      ".polaris/clusters/POL-242/results",
      ".polaris/clusters/POL-242/qc",
      ".polaris/runs/ledger.jsonl",
      ".polaris/cognition/archive",
      ".polaris/map",
    ]);
  });
});

describe("gitignore pattern generation", () => {
  it("returns comprehensive patterns for runtime and crash-recovery artifacts", () => {
    const patterns = getGitignorePatterns();
    expect(patterns).toContain("# Polaris workspace scratch — never commit");
    expect(patterns).toContain(".taskchain_artifacts/**");
    expect(patterns).toContain("*.bak");
    expect(patterns).toContain(".polaris/runs/mutation-queue.json");
    expect(patterns).toContain(".polaris/runs/current-state.json");
    expect(patterns).toContain(".polaris/runs/run-report.md");
    expect(patterns).toContain(".polaris/runs/current-state.pre-pol-198.json");
    expect(patterns).toContain(".polaris/runs/*/");
    expect(patterns).toContain(".polaris/runs/evo-run-archive/**");
    expect(patterns).toContain(".polaris/bootstrap/**");
    expect(patterns).toContain(".polaris/session-type");
    expect(patterns).toContain("# Cognition staging — ephemeral, not committed");
    expect(patterns).toContain(".polaris/cognition/pending/**");
  });

  it("formats patterns as a gitignore block", () => {
    const block = formatGitignoreBlock();
    expect(block).toContain("# Polaris workspace scratch — never commit");
    expect(block).toContain(".taskchain_artifacts/**");
    expect(block.split("\n")).toHaveLength(getGitignorePatterns().length);
  });
});

describe("adoption staging policy", () => {
  it("blocks workspace scratch from staging", () => {
    expect(isPathBlockedFromStaging(".taskchain_artifacts/polaris-run/current-state.json")).toBe(true);
    expect(isPathBlockedFromStaging(".taskchain_artifacts/polaris-run/runs/run-1/telemetry.jsonl")).toBe(true);
    expect(isPathBlockedFromStaging(".taskchain_artifacts/polaris-run/mutation-queue.json")).toBe(true);
  });

  it("blocks backup files from staging", () => {
    expect(isPathBlockedFromStaging("src/file.ts.bak")).toBe(true);
    expect(isPathBlockedFromStaging(".polaris/config.json.bak")).toBe(true);
  });

  it("blocks legacy run artifacts from staging", () => {
    expect(isPathBlockedFromStaging(".polaris/runs/mutation-queue.json")).toBe(true);
    expect(isPathBlockedFromStaging(".polaris/runs/current-state.json")).toBe(true);
    expect(isPathBlockedFromStaging(".polaris/runs/run-report.md")).toBe(true);
    expect(isPathBlockedFromStaging(".polaris/runs/current-state.pre-pol-198.json")).toBe(true);
    expect(isPathBlockedFromStaging(".polaris/runs/evo-run-archive/run-1/telemetry.jsonl")).toBe(true);
  });

  it("blocks runtime crash-recovery artifacts from staging", () => {
    expect(isPathBlockedFromStaging(".polaris/bootstrap/packet.json")).toBe(true);
    expect(isPathBlockedFromStaging(".polaris/session-type")).toBe(true);
  });

  it("blocks cognition pending staging", () => {
    expect(isPathBlockedFromStaging(".polaris/cognition/pending/index.json")).toBe(true);
    expect(isPathBlockedFromStaging(".polaris/cognition/pending/batch-1/")).toBe(true);
  });

  it("allows commit-eligible artifacts for staging", () => {
    expect(isPathBlockedFromStaging(".polaris/adoption-plan.json")).toBe(false);
    expect(isPathBlockedFromStaging(".polaris/clusters/POL-242/clusters.json")).toBe(false);
    expect(isPathBlockedFromStaging(".polaris/clusters/POL-242/cluster-state.json")).toBe(false);
    expect(isPathBlockedFromStaging(".polaris/clusters/POL-242/packets/worker.json")).toBe(false);
    expect(isPathBlockedFromStaging(".polaris/clusters/POL-242/results/worker.json")).toBe(false);
    expect(isPathBlockedFromStaging(".polaris/clusters/POL-242/qc/qc-run-1.json")).toBe(false);
    expect(isPathBlockedFromStaging(".polaris/runs/ledger.jsonl")).toBe(false);
    expect(isPathBlockedFromStaging(".polaris/runs/run-1/telemetry.jsonl")).toBe(false);
    expect(isPathBlockedFromStaging(".polaris/cognition/archive/src/loop/cognition-index.json")).toBe(false);
    expect(isPathBlockedFromStaging(".polaris/map/file-routes.json")).toBe(false);
    expect(isPathBlockedFromStaging("src/finalize/steps/06-commit.ts")).toBe(false);
    expect(isPathBlockedFromStaging("polaris.config.json")).toBe(false);
  });

  it("filters stageable paths correctly", () => {
    const paths = [
      "src/finalize/index.ts",
      ".taskchain_artifacts/polaris-run/current-state.json",
      ".polaris/adoption-plan.json",
      ".polaris/runs/mutation-queue.json",
      ".polaris/clusters/POL-242/clusters.json",
      "src/file.ts.bak",
      ".polaris/cognition/pending/index.json",
    ];
    const stageable = filterStageablePaths(paths);
    expect(stageable).toEqual([
      "src/finalize/index.ts",
      ".polaris/adoption-plan.json",
      ".polaris/clusters/POL-242/clusters.json",
    ]);
  });
});
