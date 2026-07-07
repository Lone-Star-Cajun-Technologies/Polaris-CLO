import { z } from "zod";
import type { QcAttribution, QcFinding, QcPolicyDecision, QcResult } from "./types.js";

export const qcSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);

export const qcFindingStatusSchema = z.enum([
  "open",
  "autofixed",
  "repaired",
  "waived",
  "follow-up",
]);

export const qcRoutingDecisionSchema = z.enum([
  "original-worker",
  "repair-worker",
  "follow-up",
  "operator-review",
]);

export const qcAttributionConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
  "unattributed",
]);

export const qcAttributionReasonSchema = z.enum([
  "commit-line-match",
  "changed-file-owner",
  "child-scope-match",
  "shared-file",
  "pre-existing",
  "provider-uncertain",
  "unattributed",
]);

export const qcCodeRangeSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
});

export const qcAttributionSchema = z.object({
  confidence: qcAttributionConfidenceSchema,
  reason: qcAttributionReasonSchema,
  childId: z.string().optional(),
  filePath: z.string().optional(),
  commitSha: z.string().optional(),
});

export const qcFindingSchema: z.ZodType<QcFinding> = z.object({
  findingId: z.string(),
  providerFindingId: z.string().optional(),
  severity: qcSeveritySchema,
  category: z.string().optional(),
  title: z.string(),
  message: z.string().optional(),
  filePath: z.string().optional(),
  range: qcCodeRangeSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  suggestedAction: z.string().optional(),
  fixAvailable: z.boolean(),
  autofixEligible: z.boolean(),
  attribution: qcAttributionSchema as z.ZodType<QcAttribution>,
  routingDecision: qcRoutingDecisionSchema.optional(),
  status: qcFindingStatusSchema,
});

export const qcPolicyDecisionSchema: z.ZodType<QcPolicyDecision> = z.object({
  blocksDelivery: z.boolean(),
  requiresOperatorReview: z.boolean(),
  routedToRepair: z.boolean(),
  summary: z.string(),
});

export const qcResultSchema: z.ZodType<QcResult> = z.object({
  schemaVersion: z.string(),
  qcRunId: z.string(),
  runId: z.string(),
  clusterId: z.string(),
  trigger: z.enum(["pr", "completed-cluster", "child"]),
  provider: z.string(),
  providerMode: z.enum(["local", "pr", "metrics-import"]),
  prUrl: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  status: z.enum(["passed", "findings", "blocked", "failed", "skipped"]),
  findings: z.array(qcFindingSchema),
  rawArtifactPaths: z.array(z.string()),
  parserVersion: z.string(),
  policyDecision: qcPolicyDecisionSchema,
});

/**
 * Validate an unknown value as a normalized QC result.
 * Returns a typed result on success or a Zod-safe parsed error on failure.
 */
export function validateQcResult(value: unknown): { success: true; result: QcResult } | { success: false; errors: string[] } {
  const parsed = qcResultSchema.safeParse(value);
  if (parsed.success) {
    return { success: true, result: parsed.data };
  }
  return { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
}

/**
 * Validate an unknown value as a normalized QC finding.
 */
export function validateQcFinding(value: unknown): { success: true; finding: QcFinding } | { success: false; errors: string[] } {
  const parsed = qcFindingSchema.safeParse(value);
  if (parsed.success) {
    return { success: true, finding: parsed.data };
  }
  return { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
}
