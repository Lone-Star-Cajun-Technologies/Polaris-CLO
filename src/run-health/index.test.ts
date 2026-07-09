import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSymptom,
  createRunHealthReport,
  getRunHealthReportPath,
  markBypassed,
  markMedicDecision,
  readRunHealthReport,
  validateRunHealthReport,
  type RunHealthSymptom,
  type SourceActor,
} from "./index.js";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

function makeActor(overrides?: Partial<SourceActor>): SourceActor {
  return {
    role: "worker",
    child_id: "POL-517",
    worker_id: "w-001",
    provider: "claude",
    ...overrides,
  };
}

function makeSymptom(overrides?: Partial<RunHealthSymptom>): RunHealthSymptom {
  return {
    id: "sym-001",
    severity: "high",
    code: "build-failure",
    message: "tsc exited with code 1",
    source_actor: makeActor(),
    evidence_refs: [".polaris/clusters/POL-516/qc/qc-run-001.json"],
    occurred_at: "2026-07-09T14:00:00.000Z",
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "polaris-run-health-"));
});

function cleanupTmp(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
}

// ──────────────────────────────────────────────
// Schema validation
// ──────────────────────────────────────────────

describe("validateRunHealthReport", () => {
  it("accepts a minimal valid report", () => {
    const report = {
      schema_version: "1",
      run_id: "run-001",
      cluster_id: "POL-516",
      symptoms: [makeSymptom()],
      evidence_refs: [],
      created_at: "2026-07-09T14:00:00.000Z",
      updated_at: "2026-07-09T14:00:00.000Z",
      source_actor: makeActor(),
    };
    const result = validateRunHealthReport(report);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects missing required fields", () => {
    const result = validateRunHealthReport({ run_id: "x" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects unknown schema_version", () => {
    const report = {
      schema_version: "99",
      run_id: "run-001",
      cluster_id: "POL-516",
      symptoms: [],
      evidence_refs: [],
      created_at: "2026-07-09T14:00:00.000Z",
      updated_at: "2026-07-09T14:00:00.000Z",
      source_actor: makeActor(),
    };
    const result = validateRunHealthReport(report);
    expect(result.valid).toBe(false);
  });

  it("rejects invalid symptom severity", () => {
    const report = {
      schema_version: "1",
      run_id: "run-001",
      cluster_id: "POL-516",
      symptoms: [{ ...makeSymptom(), severity: "extreme" }],
      evidence_refs: [],
      created_at: "2026-07-09T14:00:00.000Z",
      updated_at: "2026-07-09T14:00:00.000Z",
      source_actor: makeActor(),
    };
    const result = validateRunHealthReport(report);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("severity"))).toBe(true);
  });

  it("accepts optional medic_consult with chart/treatment refs", () => {
    const report = {
      schema_version: "1",
      run_id: "run-001",
      cluster_id: "POL-516",
      symptoms: [makeSymptom()],
      evidence_refs: [],
      medic_consult: {
        status: "resolved",
        chart_refs: ["CHART-2026-07-09-001"],
        treatment_packet_refs: [".polaris/clusters/POL-516/medic/tp-001.json"],
        resolved_at: "2026-07-09T15:00:00.000Z",
        resolution_notes: "Fixed by reverting commit abc123",
      },
      created_at: "2026-07-09T14:00:00.000Z",
      updated_at: "2026-07-09T14:00:00.000Z",
      source_actor: makeActor(),
    };
    const result = validateRunHealthReport(report);
    expect(result.valid).toBe(true);
  });
});

// ──────────────────────────────────────────────
// readRunHealthReport — missing report
// ──────────────────────────────────────────────

describe("readRunHealthReport", () => {
  it("returns null when no report exists", () => {
    const result = readRunHealthReport("nonexistent-run", tmpRoot);
    expect(result).toBeNull();
  });

  it("throws when file exists but is corrupt", () => {
    // Write garbage to the expected path
    const path = getRunHealthReportPath("bad-run", tmpRoot);
    mkdirSync(join(tmpRoot, ".polaris", "runs", "bad-run"), { recursive: true });
    writeFileSync(path, "{not valid json}", "utf-8");

    expect(() => readRunHealthReport("bad-run", tmpRoot)).toThrow();
    cleanupTmp();
  });
});

// ──────────────────────────────────────────────
// createRunHealthReport
// ──────────────────────────────────────────────

describe("createRunHealthReport", () => {
  it("creates a report with the first symptom", () => {
    const symptom = makeSymptom();
    const report = createRunHealthReport({
      runId: "run-create-001",
      clusterId: "POL-516",
      firstSymptom: symptom,
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    expect(report.run_id).toBe("run-create-001");
    expect(report.cluster_id).toBe("POL-516");
    expect(report.symptoms).toHaveLength(1);
    expect(report.symptoms[0].id).toBe("sym-001");
    expect(report.schema_version).toBe("1");
  });

  it("persists the report to disk", () => {
    createRunHealthReport({
      runId: "run-persist-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom(),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const read = readRunHealthReport("run-persist-001", tmpRoot);
    expect(read).not.toBeNull();
    expect(read?.run_id).toBe("run-persist-001");
  });

  it("throws if report already exists", () => {
    createRunHealthReport({
      runId: "run-dup-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom(),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    expect(() =>
      createRunHealthReport({
        runId: "run-dup-001",
        clusterId: "POL-516",
        firstSymptom: makeSymptom({ id: "sym-002" }),
        sourceActor: makeActor(),
        repoRoot: tmpRoot,
      }),
    ).toThrow("already exists");
  });

  it("returns an immutable copy (frozen)", () => {
    const report = createRunHealthReport({
      runId: "run-immutable-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom(),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    expect(Object.isFrozen(report)).toBe(true);
  });

  it("does not require evidence_refs", () => {
    const report = createRunHealthReport({
      runId: "run-noevidence-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom({ evidence_refs: [] }),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });
    expect(report.evidence_refs).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// appendSymptom
// ──────────────────────────────────────────────

describe("appendSymptom", () => {
  it("appends a symptom to an existing report", () => {
    createRunHealthReport({
      runId: "run-append-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom({ id: "sym-001" }),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const updated = appendSymptom(
      "run-append-001",
      makeSymptom({ id: "sym-002", code: "test-regression" }),
      tmpRoot,
    );

    expect(updated.symptoms).toHaveLength(2);
    expect(updated.symptoms[1].id).toBe("sym-002");
  });

  it("throws when no report exists", () => {
    expect(() =>
      appendSymptom("nonexistent-run", makeSymptom(), tmpRoot),
    ).toThrow();
  });

  it("returns an immutable copy", () => {
    createRunHealthReport({
      runId: "run-append-imm-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom({ id: "sym-001" }),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const updated = appendSymptom(
      "run-append-imm-001",
      makeSymptom({ id: "sym-002" }),
      tmpRoot,
    );
    expect(Object.isFrozen(updated)).toBe(true);
  });
});

// ──────────────────────────────────────────────
// markBypassed
// ──────────────────────────────────────────────

describe("markBypassed", () => {
  it("records bypass metadata on the report", () => {
    createRunHealthReport({
      runId: "run-bypass-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom(),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const bypass = {
      reason: "Operator approved — known flaky test environment",
      bypassed_by: "ops@example.com",
      bypassed_at: "2026-07-09T15:00:00.000Z",
    };

    const updated = markBypassed("run-bypass-001", bypass, tmpRoot);
    expect(updated.policy_bypass).toBeDefined();
    expect(updated.policy_bypass?.bypassed_by).toBe("ops@example.com");
    expect(updated.policy_bypass?.reason).toBe(bypass.reason);
  });

  it("persists bypass to disk", () => {
    createRunHealthReport({
      runId: "run-bypass-persist-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom(),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    markBypassed(
      "run-bypass-persist-001",
      {
        reason: "manual override",
        bypassed_by: "admin",
        bypassed_at: "2026-07-09T15:00:00.000Z",
      },
      tmpRoot,
    );

    const read = readRunHealthReport("run-bypass-persist-001", tmpRoot);
    expect(read?.policy_bypass?.bypassed_by).toBe("admin");
  });

  it("throws when no report exists", () => {
    expect(() =>
      markBypassed(
        "nonexistent-run",
        { reason: "x", bypassed_by: "y", bypassed_at: "2026-07-09T15:00:00.000Z" },
        tmpRoot,
      ),
    ).toThrow();
  });

  it("returns an immutable copy", () => {
    createRunHealthReport({
      runId: "run-bypass-imm-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom(),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const updated = markBypassed(
      "run-bypass-imm-001",
      { reason: "x", bypassed_by: "y", bypassed_at: "2026-07-09T15:00:00.000Z" },
      tmpRoot,
    );
    expect(Object.isFrozen(updated)).toBe(true);
  });
});

// ──────────────────────────────────────────────
// markMedicDecision
// ──────────────────────────────────────────────

describe("markMedicDecision", () => {
  it("records Medic consult status on the report", () => {
    createRunHealthReport({
      runId: "run-medic-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom(),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const updated = markMedicDecision(
      "run-medic-001",
      {
        status: "resolved",
        chartRefs: ["CHART-2026-07-09-001"],
        treatmentPacketRefs: [".polaris/clusters/POL-516/medic/tp-001.json"],
        resolvedAt: "2026-07-09T16:00:00.000Z",
        resolutionNotes: "Root cause identified and fixed",
      },
      tmpRoot,
    );

    expect(updated.medic_consult?.status).toBe("resolved");
    expect(updated.medic_consult?.chart_refs).toContain("CHART-2026-07-09-001");
    expect(updated.medic_consult?.treatment_packet_refs).toContain(
      ".polaris/clusters/POL-516/medic/tp-001.json",
    );
  });

  it("merges chart refs across multiple calls", () => {
    createRunHealthReport({
      runId: "run-medic-merge-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom(),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    markMedicDecision(
      "run-medic-merge-001",
      { status: "in-progress", chartRefs: ["CHART-2026-07-09-001"] },
      tmpRoot,
    );

    const updated = markMedicDecision(
      "run-medic-merge-001",
      { status: "resolved", chartRefs: ["CHART-2026-07-09-002"] },
      tmpRoot,
    );

    expect(updated.medic_consult?.chart_refs).toEqual([
      "CHART-2026-07-09-001",
      "CHART-2026-07-09-002",
    ]);
  });

  it("throws when no report exists", () => {
    expect(() =>
      markMedicDecision("nonexistent-run", { status: "pending" }, tmpRoot),
    ).toThrow();
  });

  it("returns an immutable copy", () => {
    createRunHealthReport({
      runId: "run-medic-imm-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom(),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const updated = markMedicDecision(
      "run-medic-imm-001",
      { status: "pending" },
      tmpRoot,
    );
    expect(Object.isFrozen(updated)).toBe(true);
  });
});

// ──────────────────────────────────────────────
// upsertWorkerSymptoms
// ──────────────────────────────────────────────

import { upsertWorkerSymptoms } from "./index.js";
import type { WorkerRunHealthSymptom } from "../types/result-packet.js";

function makeWorkerSymptom(
  category: WorkerRunHealthSymptom['category'],
  message?: string,
): WorkerRunHealthSymptom {
  return {
    category,
    message: message ?? `observed ${category}`,
    occurred_at: "2026-07-09T15:00:00.000Z",
  };
}

describe("upsertWorkerSymptoms", () => {
  it("returns null when symptoms array is empty — no report created", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-noop-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [],
      repoRoot: tmpRoot,
    });
    expect(result).toBeNull();
    // No file should have been created
    const report = readRunHealthReport("run-upsert-noop-001", tmpRoot);
    expect(report).toBeNull();
  });

  it("creates a new report when symptoms are present and no report exists", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-create-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [makeWorkerSymptom("validation-failed", "tsc exited with code 1")],
      repoRoot: tmpRoot,
    });
    expect(result).not.toBeNull();
    expect(result?.symptoms).toHaveLength(1);
    expect(result?.symptoms[0].code).toBe("validation-failed");
    expect(result?.symptoms[0].source_actor.child_id).toBe("POL-518");
    expect(result?.run_id).toBe("run-upsert-create-001");
  });

  it("appends to an existing report when one already exists", () => {
    const runId = "run-upsert-append-001";
    // Create initial report
    upsertWorkerSymptoms({
      runId,
      clusterId: "POL-516",
      childId: "POL-517",
      symptoms: [makeWorkerSymptom("worker-blocked", "Missing API key")],
      repoRoot: tmpRoot,
    });
    // Append from second worker
    const updated = upsertWorkerSymptoms({
      runId,
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [makeWorkerSymptom("validation-failed", "Build failed")],
      repoRoot: tmpRoot,
    });
    expect(updated?.symptoms).toHaveLength(2);
    expect(updated?.symptoms[0].code).toBe("worker-blocked");
    expect(updated?.symptoms[1].code).toBe("validation-failed");
  });

  it("handles multiple symptoms from a single worker", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-multi-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [
        makeWorkerSymptom("validation-failed"),
        makeWorkerSymptom("repeated-rework"),
      ],
      repoRoot: tmpRoot,
    });
    expect(result?.symptoms).toHaveLength(2);
  });

  it("maps worker-blocked to severity high", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-sev-blocked-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [makeWorkerSymptom("worker-blocked")],
      repoRoot: tmpRoot,
    });
    expect(result?.symptoms[0].severity).toBe("high");
  });

  it("maps validation-failed to severity high", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-sev-val-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [makeWorkerSymptom("validation-failed")],
      repoRoot: tmpRoot,
    });
    expect(result?.symptoms[0].severity).toBe("high");
  });

  it("maps repeated-rework to severity medium", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-sev-rework-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [makeWorkerSymptom("repeated-rework")],
      repoRoot: tmpRoot,
    });
    expect(result?.symptoms[0].severity).toBe("medium");
  });

  it("maps unclear-requirements to severity medium", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-sev-unclear-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [makeWorkerSymptom("unclear-requirements")],
      repoRoot: tmpRoot,
    });
    expect(result?.symptoms[0].severity).toBe("medium");
  });

  it("maps unusual-assumption to severity low", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-sev-assumption-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [makeWorkerSymptom("unusual-assumption")],
      repoRoot: tmpRoot,
    });
    expect(result?.symptoms[0].severity).toBe("low");
  });

  it("persists symptoms to disk with correct schema", () => {
    upsertWorkerSymptoms({
      runId: "run-upsert-persist-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [makeWorkerSymptom("validation-failed")],
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport("run-upsert-persist-001", tmpRoot);
    expect(report).not.toBeNull();
    const validation = validateRunHealthReport(report);
    expect(validation.valid).toBe(true);
  });

  it("includes workerId and provider in source_actor when provided", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-actor-001",
      clusterId: "POL-516",
      childId: "POL-518",
      workerId: "w-worker-123",
      provider: "claude",
      symptoms: [makeWorkerSymptom("unusual-assumption")],
      repoRoot: tmpRoot,
    });
    expect(result?.symptoms[0].source_actor.worker_id).toBe("w-worker-123");
    expect(result?.symptoms[0].source_actor.provider).toBe("claude");
  });

  it("forwards evidence_refs from worker symptom to run-health symptom", () => {
    const result = upsertWorkerSymptoms({
      runId: "run-upsert-evidence-001",
      clusterId: "POL-516",
      childId: "POL-518",
      symptoms: [
        {
          category: "validation-failed",
          message: "build failed",
          evidence_refs: ["logs/build.txt"],
          occurred_at: "2026-07-09T15:00:00.000Z",
        },
      ],
      repoRoot: tmpRoot,
    });
    expect(result?.symptoms[0].evidence_refs).toContain("logs/build.txt");
  });
});

describe("atomic write safety", () => {
  it("report file is valid after create + append + markBypassed", () => {
    createRunHealthReport({
      runId: "run-atomic-001",
      clusterId: "POL-516",
      firstSymptom: makeSymptom({ id: "sym-001" }),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    appendSymptom(
      "run-atomic-001",
      makeSymptom({ id: "sym-002", code: "test-regression" }),
      tmpRoot,
    );

    markBypassed(
      "run-atomic-001",
      { reason: "override", bypassed_by: "admin", bypassed_at: "2026-07-09T15:00:00.000Z" },
      tmpRoot,
    );

    const report = readRunHealthReport("run-atomic-001", tmpRoot);
    expect(report).not.toBeNull();
    expect(report?.symptoms).toHaveLength(2);
    expect(report?.policy_bypass?.bypassed_by).toBe("admin");

    const validation = validateRunHealthReport(report);
    expect(validation.valid).toBe(true);
  });
});
