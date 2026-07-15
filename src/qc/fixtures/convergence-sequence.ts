import type { QcResult } from "../types.js";
import type { QcOrchestratorResult } from "../orchestration.js";
import { makeFinding, makeResult } from "./repair-packets.js";

export const CONVERGENCE_TARGET_FILE = "src/convergence-target.ts";
export const PLANTED_FINDING_ID = "f-convergence-planted";
export const SECOND_DEFECT_FINDING_ID = "f-convergence-second-defect";

export function makePlantedFinding() {
  return makeFinding({
    findingId: PLANTED_FINDING_ID,
    filePath: CONVERGENCE_TARGET_FILE,
    category: "style",
    severity: "medium",
    attribution: {
      confidence: "high",
      reason: "changed-file-owner",
      childId: "POL-577",
    },
    routingDecision: "repair-worker",
    status: "open",
  });
}

export function makeSecondDefectFinding() {
  return makeFinding({
    findingId: SECOND_DEFECT_FINDING_ID,
    filePath: CONVERGENCE_TARGET_FILE,
    category: "style",
    severity: "medium",
    attribution: {
      confidence: "high",
      reason: "changed-file-owner",
      childId: "POL-577",
    },
    routingDecision: "repair-worker",
    status: "open",
  });
}

export function makePlantedResult(): QcResult {
  return makeResult({
    qcRunId: "qc-convergence-1",
    status: "findings",
    findings: [makePlantedFinding()],
    policyDecision: {
      blocksDelivery: true,
      requiresOperatorReview: false,
      routedToRepair: true,
      summary: "repair required",
    },
  });
}

export function makeSecondDefectResult(): QcOrchestratorResult {
  return {
    trigger: "completed-cluster",
    results: [
      makeResult({
        qcRunId: "qc-convergence-2",
        status: "findings",
        findings: [makeSecondDefectFinding()],
        policyDecision: {
          blocksDelivery: true,
          requiresOperatorReview: false,
          routedToRepair: true,
          summary: "new defect introduced by repair",
        },
      }),
    ],
    action: "block",
    summary: "new defect introduced by repair",
  };
}

export function makeConvergencePassResult(): QcOrchestratorResult {
  return {
    trigger: "completed-cluster",
    results: [
      makeResult({
        qcRunId: "qc-convergence-3",
        status: "passed",
        findings: [],
        policyDecision: {
          blocksDelivery: false,
          requiresOperatorReview: false,
          routedToRepair: false,
          summary: "convergence reached",
        },
      }),
    ],
    action: "pass",
    summary: "convergence reached",
  };
}
