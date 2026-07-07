import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getQcArtifactDir, listQcArtifactIds, readQcArtifact, writeQcArtifact } from "./artifacts.js";
import type { QcResult } from "./types.js";

function makeResult(qcRunId: string): QcResult {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    qcRunId,
    runId: "run-1",
    clusterId: "POL-ARTIFACT",
    trigger: "completed-cluster",
    provider: "coderabbit",
    providerMode: "local",
    startedAt: now,
    completedAt: now,
    status: "passed",
    findings: [],
    rawArtifactPaths: [],
    parserVersion: "coderabbit-1.0",
    policyDecision: {
      blocksDelivery: false,
      requiresOperatorReview: false,
      routedToRepair: false,
      summary: "ok",
    },
  };
}

describe("QC artifact persistence", () => {
  const repoRoot = path.join(process.cwd(), ".test-scratch", `qc-artifacts-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(repoRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("writes an artifact under the cluster evidence surface", () => {
    const result = makeResult("qc-run-1");
    const artifactPath = writeQcArtifact("POL-ARTIFACT", result, repoRoot);

    expect(artifactPath).toContain(path.join(".polaris", "clusters", "POL-ARTIFACT", "qc", "qc-run-1.json"));
    expect(readQcArtifact("POL-ARTIFACT", "qc-run-1", repoRoot)).toEqual(result);
  });

  it("lists persisted QC run ids", () => {
    writeQcArtifact("POL-ARTIFACT", makeResult("qc-run-a"), repoRoot);
    writeQcArtifact("POL-ARTIFACT", makeResult("qc-run-b"), repoRoot);

    const ids = listQcArtifactIds("POL-ARTIFACT", repoRoot);
    expect(ids).toContain("qc-run-a");
    expect(ids).toContain("qc-run-b");
  });

  it("returns null for missing artifacts", () => {
    expect(readQcArtifact("POL-ARTIFACT", "missing", repoRoot)).toBeNull();
  });

  it("returns null for invalid artifacts", () => {
    const dir = getQcArtifactDir("POL-ARTIFACT", repoRoot);
    mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(dir, "invalid.json");
    const badContent = JSON.stringify({ not: "a result" });
    writeFileSync(artifactPath, badContent, "utf-8");

    expect(readQcArtifact("POL-ARTIFACT", "invalid", repoRoot)).toBeNull();
  });

  it("throws for malformed JSON artifacts", () => {
    const dir = getQcArtifactDir("POL-ARTIFACT", repoRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "broken.json"), "{not-json", "utf-8");
    expect(() => readQcArtifact("POL-ARTIFACT", "broken", repoRoot)).toThrow();
  });

  it("isolates clusters by path", () => {
    writeQcArtifact("POL-A", makeResult("run-a"), repoRoot);
    writeQcArtifact("POL-B", makeResult("run-b"), repoRoot);

    expect(readQcArtifact("POL-A", "run-a", repoRoot)).toBeDefined();
    expect(readQcArtifact("POL-A", "run-b", repoRoot)).toBeNull();
    expect(readQcArtifact("POL-B", "run-b", repoRoot)).toBeDefined();
  });
});
