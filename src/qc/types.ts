/**
 * Provider-neutral Quality Control types.
 *
 * These types mirror the normalized finding schema defined in the QC architecture
 * spec. They intentionally do not reference tracker-specific or provider-specific
 * shapes so that Polaris can support multiple QC backends without vendor lock-in.
 */

/** Severity of a normalized QC finding. */
export type QcSeverity = "critical" | "high" | "medium" | "low" | "info";

/** Lifecycle status of a finding after policy application. */
export type QcFindingStatus =
  | "open"
  | "autofixed"
  | "repaired"
  | "waived"
  | "follow-up";

/** Routing decision applied to a finding. */
export type QcRoutingDecision =
  | "original-worker"
  | "repair-worker"
  | "follow-up"
  | "operator-review";

/** Attribution confidence for a finding. */
export type QcAttributionConfidence =
  | "high"
  | "medium"
  | "low"
  | "unattributed";

/** Reason code explaining attribution confidence. */
export type QcAttributionReason =
  | "commit-line-match"
  | "changed-file-owner"
  | "child-scope-match"
  | "shared-file"
  | "pre-existing"
  | "provider-uncertain"
  | "unattributed";

/** Source line/column range. */
export interface QcCodeRange {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

/** Attribution evidence linking a finding to a child or scope. */
export interface QcAttribution {
  confidence: QcAttributionConfidence;
  reason: QcAttributionReason;
  childId?: string;
  filePath?: string;
  commitSha?: string;
}

/** Normalized QC finding. */
export interface QcFinding {
  findingId: string;
  providerFindingId?: string;
  severity: QcSeverity;
  category?: string;
  title: string;
  message?: string;
  filePath?: string;
  commitSha?: string;
  range?: QcCodeRange;
  confidence?: number;
  suggestedAction?: string;
  fixAvailable: boolean;
  autofixEligible: boolean;
  attribution: QcAttribution;
  routingDecision?: QcRoutingDecision;
  status: QcFindingStatus;
}

/** Result of applying QC policy to a set of findings. */
export interface QcPolicyDecision {
  blocksDelivery: boolean;
  requiresOperatorReview: boolean;
  routedToRepair: boolean;
  summary: string;
}

/** Normalized result of a single QC run. */
export interface QcResult {
  schemaVersion: string;
  qcRunId: string;
  runId: string;
  clusterId: string;
  trigger: "pr" | "completed-cluster" | "child";
  provider: string;
  providerMode: "local" | "pr" | "metrics-import";
  prUrl?: string;
  startedAt: string;
  completedAt: string;
  status: "passed" | "findings" | "blocked" | "failed" | "skipped";
  findings: QcFinding[];
  rawArtifactPaths: string[];
  parserVersion: string;
  policyDecision: QcPolicyDecision;
}
