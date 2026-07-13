import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunHealthReport,
  readRunHealthReport,
  type RunHealthSymptom,
  type SourceActor,
} from "../run-health/index.js";
import { runMedicRunHealthConsult } from "./run-health-consult.js";
import type {
  MedicRunHealthPacket,
  MedicTreatmentPacket,
  TreatmentWorkerResult,
} from "../types/result-packet.js";
import type { CompileTreatmentWorkerPacketInput } from "./treatment-packets.js";

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
    evidence_refs: ["src/foo.ts"],
    occurred_at: "2026-07-09T14:00:00.000Z",
    ...overrides,
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "polaris-medic-rh-"));
  mkdirSync(join(tmpRoot, ".polaris", "clusters", "POL-516", "medic"), { recursive: true });
});

function cleanup(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function makePacket(overrides?: Partial<MedicRunHealthPacket>): MedicRunHealthPacket {
  const runId = "run-001";
  return {
    role: "medic-run-health",
    run_id: runId,
    dispatch_id: "disp-001",
    cluster_id: "POL-516",
    run_health_report_path: join(tmpRoot, ".polaris", "runs", runId, "run-health-report.json"),
    qc_artifact_refs: [".polaris/clusters/POL-516/qc/qc-run-001.json"],
    telemetry_path: join(tmpRoot, "telemetry.jsonl"),
    cluster_state_path: join(tmpRoot, ".polaris", "clusters", "POL-516", "state.json"),
    policy_limits: { max_treatment_rounds: 2 },
    result_path: join(tmpRoot, "medic-result.json"),
    allowed_write_paths: ["smartdocs/medic/charts", ".polaris/runs"],
    prohibited_write_paths: [],
    ...overrides,
  };
}

function telemetryEvents(): Record<string, unknown>[] {
  const content = readFileSync(join(tmpRoot, "telemetry.jsonl"), "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runMedicRunHealthConsult", () => {
  it("no-treatment-needed: writes a chart and resolves the report", async () => {
    const runId = "run-no-treatment";
    createRunHealthReport({
      runId,
      clusterId: "POL-516",
      firstSymptom: makeSymptom({ severity: "low", id: "sym-low" }),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const result = await runMedicRunHealthConsult({
      packet: makePacket({ run_id: runId }),
      repoRoot: tmpRoot,
      stateFile: join(tmpRoot, "current-state.json"),
      telemetryFile: join(tmpRoot, "telemetry.jsonl"),
      branch: "main",
    });

    expect(result.status).toBe("resolved");
    expect(result.decision).toBe("no-treatment-needed");
    expect(result.terminal_outcome).toBe("no-treatment-needed");
    expect(result.chart_id).toMatch(/^CHART-\d{4}-\d{2}-\d{2}-\d{3}$/);

    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.medic_consult?.status).toBe("resolved");
    expect(report?.medic_consult?.chart_refs).toContain(result.chart_id);
    expect(report?.medic_consult?.treatment_packet_refs).toEqual([]);

    const chartPath = join(tmpRoot, "smartdocs", "medic", "charts", `${result.chart_id}.md`);
    expect(readFileSync(chartPath, "utf-8")).toContain("## Symptoms");

    const events = telemetryEvents();
    expect(events.some((e) => e.event === "medic-run-health-consult-started")).toBe(true);
    expect(events.some((e) => e.event === "medic-run-health-chart-created")).toBe(true);
    expect(events.some((e) => e.event === "medic-run-health-terminal")).toBe(true);

    cleanup();
  });

  it("creates treatment packets with required fields", async () => {
    const runId = "run-treatment-packets";
    createRunHealthReport({
      runId,
      clusterId: "POL-516",
      firstSymptom: makeSymptom({
        id: "sym-high",
        severity: "high",
        evidence_refs: ["src/run-health/index.ts"],
      }),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const captured: CompileTreatmentWorkerPacketInput[] = [];
    const dispatchFn = async (
      input: CompileTreatmentWorkerPacketInput,
    ): Promise<TreatmentWorkerResult> => {
      captured.push(input);
      return { packet_id: input.treatment.packet_id, status: "success" };
    };

    const result = await runMedicRunHealthConsult({
      packet: makePacket({ run_id: runId, policy_limits: { max_treatment_rounds: 1 } }),
      repoRoot: tmpRoot,
      stateFile: join(tmpRoot, "current-state.json"),
      telemetryFile: join(tmpRoot, "telemetry.jsonl"),
      branch: "main",
      dispatchTreatmentWorkerFn: dispatchFn,
    });

    expect(captured).toHaveLength(1);
    const treatment = captured[0]!.treatment;
    expect(treatment.source_symptom_ids).toEqual(["sym-high"]);
    expect(treatment.round).toBe(1);
    expect(treatment.allowed_scope).toContain("src/run-health/index.ts");
    expect(treatment.validation_commands).toContain("npm run build");
    expect(treatment.dispatch_metadata.result_file).toContain("medic");

    expect(result.status).toBe("resolved");
    expect(result.terminal_outcome).toBe("treatment-success");

    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.medic_consult?.treatment_packet_refs.length).toBeGreaterThan(0);

    const events = telemetryEvents();
    expect(events.some((e) => e.event === "medic-run-health-treatment-packets-created")).toBe(true);
    expect(events.some((e) => e.event === "medic-run-health-treatment-completed")).toBe(true);

    cleanup();
  });

  it("treatment worker success resolves the report", async () => {
    const runId = "run-treatment-success";
    createRunHealthReport({
      runId,
      clusterId: "POL-516",
      firstSymptom: makeSymptom({ id: "sym-a", severity: "high" }),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const dispatchFn = async (
      input: CompileTreatmentWorkerPacketInput,
    ): Promise<TreatmentWorkerResult> => ({
      packet_id: input.treatment.packet_id,
      status: "success",
      commit_sha: "abc1234",
    });

    const result = await runMedicRunHealthConsult({
      packet: makePacket({ run_id: runId }),
      repoRoot: tmpRoot,
      stateFile: join(tmpRoot, "current-state.json"),
      telemetryFile: join(tmpRoot, "telemetry.jsonl"),
      branch: "main",
      dispatchTreatmentWorkerFn: dispatchFn,
    });

    expect(result.status).toBe("resolved");
    expect(result.terminal_outcome).toBe("treatment-success");

    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.medic_consult?.status).toBe("resolved");

    cleanup();
  });

  it("treatment worker failure emits a terminal failure outcome", async () => {
    const runId = "run-treatment-failure";
    createRunHealthReport({
      runId,
      clusterId: "POL-516",
      firstSymptom: makeSymptom({ id: "sym-b", severity: "high" }),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const dispatchFn = async (
      input: CompileTreatmentWorkerPacketInput,
    ): Promise<TreatmentWorkerResult> => ({
      packet_id: input.treatment.packet_id,
      status: "failure",
      error_message: "could not fix",
    });

    const result = await runMedicRunHealthConsult({
      packet: makePacket({ run_id: runId, policy_limits: { max_treatment_rounds: 1 } }),
      repoRoot: tmpRoot,
      stateFile: join(tmpRoot, "current-state.json"),
      telemetryFile: join(tmpRoot, "telemetry.jsonl"),
      branch: "main",
      dispatchTreatmentWorkerFn: dispatchFn,
    });

    expect(result.status).toBe("blocked");
    expect(result.terminal_outcome).toBe("max-rounds");

    const events = telemetryEvents();
    const terminal = events.find((e) => e.event === "medic-run-health-terminal");
    expect(terminal?.outcome).toBe("max-rounds");

    cleanup();
  });

  it("retries failed symptoms until max rounds are exhausted", async () => {
    const runId = "run-max-rounds";
    createRunHealthReport({
      runId,
      clusterId: "POL-516",
      firstSymptom: makeSymptom({ id: "sym-c", severity: "high" }),
      sourceActor: makeActor(),
      repoRoot: tmpRoot,
    });

    const attempts: { round: number; packetId: string }[] = [];
    const dispatchFn = async (
      input: CompileTreatmentWorkerPacketInput,
    ): Promise<TreatmentWorkerResult> => {
      attempts.push({ round: input.treatment.round, packetId: input.treatment.packet_id });
      return { packet_id: input.treatment.packet_id, status: "failure" };
    };

    const result = await runMedicRunHealthConsult({
      packet: makePacket({ run_id: runId, policy_limits: { max_treatment_rounds: 3 } }),
      repoRoot: tmpRoot,
      stateFile: join(tmpRoot, "current-state.json"),
      telemetryFile: join(tmpRoot, "telemetry.jsonl"),
      branch: "main",
      dispatchTreatmentWorkerFn: dispatchFn,
    });

    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.round)).toEqual([1, 2, 3]);
    expect(result.terminal_outcome).toBe("max-rounds");

    cleanup();
  });
});
