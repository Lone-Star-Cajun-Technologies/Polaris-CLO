/**
 * Tests for Foreman-side symptom emission.
 *
 * Validates:
 * - isForemanSymptomEnabled() returns false when policy not set (default).
 * - isForemanSymptomEnabled() returns true only when explicitly enabled.
 * - appendForemanSymptom() creates a run-health report when policy is enabled.
 * - appendForemanSymptom() does NOT create a run-health report when policy is disabled.
 * - appendForemanSymptom() appends to an existing report when one already exists.
 * - All defined symptom codes map to expected severities.
 * - appendForemanSymptom() is silent (no throw) when called with disabled policy.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendForemanSymptom,
  isForemanSymptomEnabled,
  type ForemanSymptomCode,
} from "./foreman-symptoms.js";
import { readRunHealthReport } from "./index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(enabled: boolean) {
  return { run_health: { foreman_symptoms: { enabled } } };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "polaris-foreman-sym-"));
});

function cleanup() {
  rmSync(tmpRoot, { recursive: true, force: true });
}

// ── Policy tests ──────────────────────────────────────────────────────────────

describe("isForemanSymptomEnabled", () => {
  it("returns false when config is null", () => {
    expect(isForemanSymptomEnabled(null)).toBe(false);
  });

  it("returns false when config is undefined", () => {
    expect(isForemanSymptomEnabled(undefined)).toBe(false);
  });

  it("returns false when run_health is absent", () => {
    expect(isForemanSymptomEnabled({})).toBe(false);
  });

  it("returns false when foreman_symptoms is absent", () => {
    expect(isForemanSymptomEnabled({ run_health: {} })).toBe(false);
  });

  it("returns false when enabled is explicitly false", () => {
    expect(isForemanSymptomEnabled(makeConfig(false))).toBe(false);
  });

  it("returns true when enabled is explicitly true", () => {
    expect(isForemanSymptomEnabled(makeConfig(true))).toBe(true);
  });
});

// ── appendForemanSymptom — disabled policy ─────────────────────────────────────

describe("appendForemanSymptom — policy disabled", () => {
  it("does NOT create a run-health report when config.run_health.foreman_symptoms.enabled is false", () => {
    appendForemanSymptom({
      runId: "run-001",
      clusterId: "POL-TEST",
      code: "foreman-state-repair",
      message: "State fallback triggered",
      repoRoot: tmpRoot,
      config: makeConfig(false),
    });
    const report = readRunHealthReport("run-001", tmpRoot);
    expect(report).toBeNull();
    cleanup();
  });

  it("does NOT create a run-health report when config is null", () => {
    appendForemanSymptom({
      runId: "run-001b",
      clusterId: "POL-TEST",
      code: "foreman-state-repair",
      message: "State fallback triggered",
      repoRoot: tmpRoot,
      config: null,
    });
    expect(readRunHealthReport("run-001b", tmpRoot)).toBeNull();
    cleanup();
  });

  it("does NOT create a run-health report when run_health is absent from config", () => {
    appendForemanSymptom({
      runId: "run-001c",
      clusterId: "POL-TEST",
      code: "foreman-state-repair",
      message: "State fallback triggered",
      repoRoot: tmpRoot,
      config: {},
    });
    expect(readRunHealthReport("run-001c", tmpRoot)).toBeNull();
    cleanup();
  });

  it("never throws even when disabled", () => {
    expect(() =>
      appendForemanSymptom({
        runId: "run-001",
        clusterId: "POL-TEST",
        code: "foreman-dispatch-boundary-repair",
        message: "Boundary violation",
        repoRoot: tmpRoot,
        config: makeConfig(false),
      }),
    ).not.toThrow();
    cleanup();
  });
});

// ── appendForemanSymptom — enabled policy ──────────────────────────────────────

describe("appendForemanSymptom — policy enabled", () => {
  it("creates a run-health report for the first symptom when enabled is true", () => {
    appendForemanSymptom({
      runId: "run-001",
      clusterId: "POL-TEST",
      code: "foreman-state-repair",
      message: "State file corrupted; fallback applied",
      evidenceRefs: [".taskchain_artifacts/telemetry.jsonl"],
      repoRoot: tmpRoot,
      config: makeConfig(true),
    });

    const report = readRunHealthReport("run-001", tmpRoot);
    expect(report).not.toBeNull();
    expect(report?.symptoms).toHaveLength(1);
    expect(report?.symptoms[0].code).toBe("foreman-state-repair");
    expect(report?.symptoms[0].severity).toBe("high");
    expect(report?.symptoms[0].source_actor.role).toBe("foreman");
    expect(report?.symptoms[0].evidence_refs).toContain(".taskchain_artifacts/telemetry.jsonl");
    cleanup();
  });

  it("creates a run-health report when called without config (caller is responsible for policy gating)", () => {
    // When config is not passed, the function always writes (policy gating is caller's responsibility)
    appendForemanSymptom({
      runId: "run-001-noconfig",
      clusterId: "POL-TEST",
      code: "foreman-state-repair",
      message: "No config provided — always writes",
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport("run-001-noconfig", tmpRoot);
    expect(report).not.toBeNull();
    cleanup();
  });

  it("appends to an existing report", () => {
    appendForemanSymptom({
      runId: "run-002",
      clusterId: "POL-TEST",
      code: "foreman-state-repair",
      message: "First symptom",
      repoRoot: tmpRoot,
      config: makeConfig(true),
    });
    appendForemanSymptom({
      runId: "run-002",
      clusterId: "POL-TEST",
      code: "foreman-qc-runtime-failure",
      message: "Second symptom",
      repoRoot: tmpRoot,
      config: makeConfig(true),
    });

    const report = readRunHealthReport("run-002", tmpRoot);
    expect(report?.symptoms).toHaveLength(2);
    expect(report?.symptoms.map((s) => s.code)).toContain("foreman-state-repair");
    expect(report?.symptoms.map((s) => s.code)).toContain("foreman-qc-runtime-failure");
    cleanup();
  });

  it("never throws even when the report write fails (best-effort)", () => {
    // Pass a non-writable path to trigger a write error (simulate by using a file as dir).
    expect(() =>
      appendForemanSymptom({
        runId: "run-003",
        clusterId: "POL-TEST",
        code: "foreman-manual-intervention",
        message: "Operator intervened",
        repoRoot: "/dev/null/nonexistent",
        config: makeConfig(true),
      }),
    ).not.toThrow();
  });
});

// ── Severity mapping ──────────────────────────────────────────────────────────

describe("appendForemanSymptom — severity mapping", () => {
  const codeToSeverity: [ForemanSymptomCode, string][] = [
    ["foreman-dispatch-boundary-repair", "critical"],
    ["foreman-state-repair", "high"],
    ["foreman-cluster-repair", "high"],
    ["foreman-packet-repair", "high"],
    ["foreman-qc-runtime-failure", "high"],
    ["foreman-binary-mismatch", "high"],
    ["foreman-wrong-run-telemetry", "high"],
    ["foreman-finalize-recovery", "medium"],
    ["foreman-manual-intervention", "low"],
  ];

  for (const [code, expectedSeverity] of codeToSeverity) {
    it(`maps ${code} → ${expectedSeverity}`, () => {
      const runId = `run-sev-${code}`;
      appendForemanSymptom({
        runId,
        clusterId: "POL-TEST",
        code,
        message: `Testing ${code}`,
        repoRoot: tmpRoot,
        config: makeConfig(true),
      });
      const report = readRunHealthReport(runId, tmpRoot);
      expect(report?.symptoms[0].severity).toBe(expectedSeverity);
    });
  }

  afterEach(() => {
    // Clean after each severity test
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* no-op */ }
    tmpRoot = mkdtempSync(join(tmpdir(), "polaris-foreman-sev-"));
  });
});
