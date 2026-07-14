import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  MedicChart,
  MedicChartDecision,
  MedicChartSymptom,
  MedicRunHealthPacket,
  MedicRunHealthResult,
  MedicTreatmentPacket,
  TreatmentWorkerResult,
} from "../types/result-packet.js";
import type { WorkerPacket } from "../loop/worker-packet.js";
import {
  readRunHealthReport,
  markMedicDecision,
  type RunHealthReport,
  type RunHealthSymptom,
} from "../run-health/index.js";
import { generateNextChartId } from "./chart-id.js";
import type { RouteHealthState } from "../cognition/route-cognition-delta.js";
import {
  buildTreatmentPacketId,
  buildTreatmentPackets,
  DEFAULT_TREATMENT_VALIDATION_COMMANDS,
  type CompileTreatmentWorkerPacketInput,
} from "./treatment-packets.js";

export interface RunMedicRunHealthConsultInput {
  /** The Medic run-health consult packet. */
  packet: MedicRunHealthPacket;
  /** Repository root. */
  repoRoot: string;
  /** Absolute path to current-state.json (passed through to treatment packets). */
  stateFile: string;
  /** Absolute path to telemetry JSONL. */
  telemetryFile: string;
  /** Git branch name. */
  branch: string;
  /** Optional validation commands for treatment workers. */
  validationCommands?: string[];
  /** Optional max concurrent workers passed to treatment packets. */
  maxConcurrentWorkers?: number;
  /** If true, do not actually dispatch treatment workers. */
  dryRun?: boolean;
  /**
   * Dispatch a compiled treatment WorkerPacket through the normal Foreman adapter.
   * When omitted and treatment is required, the function fails closed.
   */
  dispatchTreatmentWorkerFn?: (
    input: CompileTreatmentWorkerPacketInput,
  ) => Promise<TreatmentWorkerResult>;
}

function appendTelemetry(telemetryFile: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  writeFileSync(telemetryFile, JSON.stringify(event) + "\n", { flag: "a", encoding: "utf-8" });
}

function symptomNeedsTreatment(symptom: RunHealthSymptom): boolean {
  return symptom.severity === "critical" || symptom.severity === "high";
}

function deriveQcArtifactRefs(report: RunHealthReport): string[] {
  const refs = new Set<string>([
    ...report.evidence_refs,
    ...report.symptoms.flatMap((s) => s.evidence_refs),
  ]);
  return Array.from(refs);
}

function deriveDiagnosis(report: RunHealthReport): string {
  const codes = report.symptoms.map((s) => s.code);
  const unique = Array.from(new Set(codes));
  return `Run-health report for ${report.run_id} recorded ${report.symptoms.length} symptom(s): ${unique.join(", ")}.`;
}

function deriveDecision(report: RunHealthReport): {
  decision: MedicChartDecision;
  rationale: string;
  treatmentPlan?: string[];
} {
  const treatable = report.symptoms.filter(symptomNeedsTreatment);
  if (treatable.length === 0) {
    return {
      decision: "no-treatment-needed",
      rationale:
        "No critical or high-severity symptoms recorded; observation and follow-up are sufficient.",
    };
  }

  const plan = treatable.map(
    (s) => `Round-1 treatment for ${s.id} (${s.code}): address ${s.message}`,
  );
  return {
    decision: "treatment-required",
    rationale: `${treatable.length} symptom(s) require treatment.`,
    treatmentPlan: plan,
  };
}

export interface WriteChartInput extends MedicChart {
  /** Route path for this chart. */
  route?: string;
  /** Canonical route health state (from POL-564). */
  health_state?: RouteHealthState;
  /** Optional problem statement override. */
  problem?: string;
  /** Chart status. */
  status?: string;
}

export function writeChart(chart: WriteChartInput, runId: string, repoRoot: string): string {
  const chartsDir = join(repoRoot, "smartdocs", "medic", "charts");
  mkdirSync(chartsDir, { recursive: true });

  const nextId = generateNextChartId(chartsDir);
  const chartId = nextId.full;
  const now = new Date().toISOString();

  const routeText = chart.route ?? "src/run-health";
  const statusText = chart.status ?? "active";
  const problemText = chart.problem ?? `Run-health symptoms were recorded during ${runId}.`;
  const healthStateLine = chart.health_state ? `health_state: ${chart.health_state}\n` : "";

  const treatmentPlanText =
    chart.treatment_plan && chart.treatment_plan.length > 0
      ? chart.treatment_plan.map((p) => `- ${p}`).join("\n")
      : "No treatment required.";

  const followUpText =
    chart.follow_up_conditions && chart.follow_up_conditions.length > 0
      ? chart.follow_up_conditions.map((c) => `- ${c}`).join("\n")
      : "None.";

  const noTreatmentText = chart.no_treatment_rationale
    ? chart.no_treatment_rationale
    : "N/A";

  const content = `---
chart_id: ${chartId}
cluster_id: ${chart.cluster_id}
route: ${routeText}
status: ${statusText}
${healthStateLine}related_charts: []
created: ${now}
updated: ${now}
---

## Problem

${problemText}

## Symptoms

${chart.symptoms.map((s) => `- **${s.code}** (${s.id}): ${s.message}`).join("\n")}

## Root Cause

${chart.diagnosis}

## Affected Files

${chart.evidence_refs.join("\n")}

## Treatment

${treatmentPlanText}

## Validation

Treatment workers must pass their embedded validation commands.

## Prevention

Review run-health symptoms and root causes to prevent recurrence.

## When To Read This Chart

When similar symptoms appear in future runs.

## Decision

**Decision:** ${chart.decision}

**No-treatment rationale:** ${noTreatmentText}

**Follow-up conditions:**
${followUpText}
`;

  const filePath = join(chartsDir, `${chartId}.md`);
  writeFileSync(filePath, content, "utf-8");
  return relative(repoRoot, filePath);
}

function markInProgress(
  report: RunHealthReport,
  chartRef: string,
  repoRoot: string,
): void {
  markMedicDecision(
    report.run_id,
    { status: "in-progress", chartRefs: [chartRef] },
    repoRoot,
  );
}

function markResolved(
  report: RunHealthReport,
  chartRef: string,
  treatmentRefs: string[],
  outcome: string,
  repoRoot: string,
): void {
  const success = outcome === "treatment-success" || outcome === "no-treatment-needed";
  markMedicDecision(
    report.run_id,
    {
      status: success ? "resolved" : "in-progress",
      chartRefs: [chartRef],
      treatmentPacketRefs: treatmentRefs,
      resolvedAt: success ? new Date().toISOString() : undefined,
      resolutionNotes: `Terminal outcome: ${outcome}`,
    },
    repoRoot,
  );
}

export async function runMedicRunHealthConsult(
  input: RunMedicRunHealthConsultInput,
): Promise<MedicRunHealthResult> {
  const {
    packet,
    repoRoot,
    stateFile,
    telemetryFile,
    branch,
    validationCommands,
    maxConcurrentWorkers,
    dryRun,
    dispatchTreatmentWorkerFn,
  } = input;

  const now = new Date().toISOString();

  appendTelemetry(telemetryFile, {
    event: "medic-run-health-consult-started",
    run_id: packet.run_id,
    cluster_id: packet.cluster_id,
    dispatch_id: packet.dispatch_id,
    timestamp: now,
  });

  const report = readRunHealthReport(packet.run_id, repoRoot);
  if (!report) {
    const error = `No run-health report found for run "${packet.run_id}"`;
    appendTelemetry(telemetryFile, {
      event: "medic-run-health-terminal",
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      dispatch_id: packet.dispatch_id,
      outcome: "error",
      error,
      timestamp: new Date().toISOString(),
    });
    return {
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      dispatch_id: packet.dispatch_id,
      status: "error",
      chart_id: null,
      decision: "terminal",
      treatment_packet_refs: [],
      terminal_outcome: "error",
      error_message: error,
      timestamp: new Date().toISOString(),
    };
  }

  const decisionInfo = deriveDecision(report);
  const chart: MedicChart = {
    chart_id: "", // filled in after write
    cluster_id: packet.cluster_id,
    symptoms: report.symptoms.map(
      (s): MedicChartSymptom => ({ id: s.id, code: s.code, message: s.message }),
    ),
    diagnosis: deriveDiagnosis(report),
    evidence_refs: deriveQcArtifactRefs(report),
    decision: decisionInfo.decision,
    treatment_plan: decisionInfo.treatmentPlan,
    no_treatment_rationale: decisionInfo.rationale,
    follow_up_conditions: ["Re-check run-health report after next run."],
    created_at: now,
  };

  const chartRef = writeChart(chart, packet.run_id, repoRoot);
  chart.chart_id = chartRef.replace("smartdocs/medic/charts/", "").replace(".md", "");

  appendTelemetry(telemetryFile, {
    event: "medic-run-health-chart-created",
    run_id: packet.run_id,
    cluster_id: packet.cluster_id,
    dispatch_id: packet.dispatch_id,
    chart_id: chart.chart_id,
    chart_ref: chartRef,
    decision: chart.decision,
    timestamp: new Date().toISOString(),
  });

  markInProgress(report, chart.chart_id, repoRoot);

  if (chart.decision === "no-treatment-needed") {
    const outcome = "no-treatment-needed";
    markResolved(report, chart.chart_id, [], outcome, repoRoot);
    appendTelemetry(telemetryFile, {
      event: "medic-run-health-terminal",
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      dispatch_id: packet.dispatch_id,
      outcome,
      chart_id: chart.chart_id,
      timestamp: new Date().toISOString(),
    });
    return {
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      dispatch_id: packet.dispatch_id,
      status: "resolved",
      chart_id: chart.chart_id,
      decision: chart.decision,
      treatment_packet_refs: [],
      terminal_outcome: outcome,
      timestamp: new Date().toISOString(),
    };
  }

  if (!dispatchTreatmentWorkerFn) {
    const error = "dispatchTreatmentWorkerFn is required when treatment is required";
    appendTelemetry(telemetryFile, {
      event: "medic-run-health-terminal",
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      dispatch_id: packet.dispatch_id,
      outcome: "error",
      error,
      chart_id: chart.chart_id,
      timestamp: new Date().toISOString(),
    });
    return {
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      dispatch_id: packet.dispatch_id,
      status: "error",
      chart_id: chart.chart_id,
      decision: "terminal",
      treatment_packet_refs: [],
      terminal_outcome: "error",
      error_message: error,
      timestamp: new Date().toISOString(),
    };
  }

  const maxRounds = Math.max(1, packet.policy_limits.max_treatment_rounds);
  let round = 1;
  let remainingSymptoms = report.symptoms.filter(symptomNeedsTreatment);
  const allTreatmentRefs: string[] = [];
  const terminalEvent = (outcome: string) =>
    appendTelemetry(telemetryFile, {
      event: "medic-run-health-terminal",
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      dispatch_id: packet.dispatch_id,
      outcome,
      chart_id: chart.chart_id,
      rounds_completed: round,
      timestamp: new Date().toISOString(),
    });

  while (round <= maxRounds && remainingSymptoms.length > 0) {
    const syntheticReport: RunHealthReport = {
      ...report,
      symptoms: remainingSymptoms,
    };

    const treatmentPackets = buildTreatmentPackets({
      report: syntheticReport,
      round,
      repoRoot,
      validationCommands: validationCommands ?? DEFAULT_TREATMENT_VALIDATION_COMMANDS,
    });

    const treatmentRefs = treatmentPackets.map((t) =>
      join(
        ".polaris",
        "clusters",
        t.cluster_id,
        "medic",
        `${t.packet_id}.json`,
      ),
    );
    allTreatmentRefs.push(...treatmentRefs);

    appendTelemetry(telemetryFile, {
      event: "medic-run-health-treatment-packets-created",
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      dispatch_id: packet.dispatch_id,
      round,
      packet_count: treatmentPackets.length,
      packet_refs: treatmentRefs,
      timestamp: new Date().toISOString(),
    });

    const results: TreatmentWorkerResult[] = [];
    try {
      for (const treatment of treatmentPackets) {
        if (dryRun) {
          results.push({ packet_id: treatment.packet_id, status: "success" });
          continue;
        }
        const result = await dispatchTreatmentWorkerFn({
          treatment,
          stateFile,
          telemetryFile,
          branch,
          maxConcurrentWorkers,
        });
        results.push(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTelemetry(telemetryFile, {
        event: "medic-run-health-treatment-dispatch-error",
        run_id: packet.run_id,
        cluster_id: packet.cluster_id,
        dispatch_id: packet.dispatch_id,
        round,
        error: msg,
        timestamp: new Date().toISOString(),
      });
      const outcome = "dispatch-failure";
      markResolved(report, chart.chart_id, allTreatmentRefs, outcome, repoRoot);
      terminalEvent(outcome);
      return {
        run_id: packet.run_id,
        cluster_id: packet.cluster_id,
        dispatch_id: packet.dispatch_id,
        status: "error",
        chart_id: chart.chart_id,
        decision: "terminal",
        treatment_packet_refs: allTreatmentRefs,
        terminal_outcome: outcome,
        error_message: msg,
        timestamp: new Date().toISOString(),
      };
    }

    const failed = results.filter((r) => r.status === "failure");
    const succeeded = results.filter((r) => r.status === "success");

    appendTelemetry(telemetryFile, {
      event: "medic-run-health-treatment-completed",
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      dispatch_id: packet.dispatch_id,
      round,
      success_count: succeeded.length,
      failure_count: failed.length,
      failed_packet_ids: failed.map((f) => f.packet_id),
      timestamp: new Date().toISOString(),
    });

    if (failed.length === 0) {
      const outcome = "treatment-success";
      markResolved(report, chart.chart_id, allTreatmentRefs, outcome, repoRoot);
      terminalEvent(outcome);
      return {
        run_id: packet.run_id,
        cluster_id: packet.cluster_id,
        dispatch_id: packet.dispatch_id,
        status: "resolved",
        chart_id: chart.chart_id,
        decision: "terminal",
        treatment_packet_refs: allTreatmentRefs,
        terminal_outcome: outcome,
        timestamp: new Date().toISOString(),
      };
    }

    if (round < maxRounds) {
      const failedIds = new Set(failed.map((f) => f.packet_id));
      remainingSymptoms = remainingSymptoms.filter((s) =>
        failedIds.has(buildTreatmentPacketId(report.run_id, round, s.id)),
      );
      round += 1;
    } else {
      const outcome = "max-rounds";
      markResolved(report, chart.chart_id, allTreatmentRefs, outcome, repoRoot);
      terminalEvent(outcome);
      return {
        run_id: packet.run_id,
        cluster_id: packet.cluster_id,
        dispatch_id: packet.dispatch_id,
        status: "blocked",
        chart_id: chart.chart_id,
        decision: "terminal",
        treatment_packet_refs: allTreatmentRefs,
        terminal_outcome: outcome,
        timestamp: new Date().toISOString(),
      };
    }
  }

  const outcome = remainingSymptoms.length === 0 ? "treatment-success" : "max-rounds";
  markResolved(report, chart.chart_id, allTreatmentRefs, outcome, repoRoot);
  terminalEvent(outcome);
  return {
    run_id: packet.run_id,
    cluster_id: packet.cluster_id,
    dispatch_id: packet.dispatch_id,
    status: remainingSymptoms.length === 0 ? "resolved" : "blocked",
    chart_id: chart.chart_id,
    decision: "terminal",
    treatment_packet_refs: allTreatmentRefs,
    terminal_outcome: outcome,
    timestamp: new Date().toISOString(),
  };
}
