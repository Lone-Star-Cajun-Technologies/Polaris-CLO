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

/** Classification of a non-finding provider failure. */
export type QcFailureReason =
  | "timeout"
  | "rate-limited"
  | "auth-failure"
  | "command-not-found"
  | "nonzero-exit"
  | "parse-failed"
  | "empty-output"
  | "unusable-output"
  | "unsupported-mode"
  | "unavailable-provider";

/** Result of parsing provider output. */
export type QcParserResult = "success" | "partial" | "failed";

/** Lifecycle status of a single provider attempt. */
export type QcProviderAttemptStatus = "success" | "failure" | "fallback" | "skipped";

/** Provider-neutral record of a single QC provider attempt. */
export interface QcProviderAttempt {
  provider: string;
  status: QcProviderAttemptStatus;
  failureReason?: QcFailureReason;
  fallbackSource?: string;
  rawOutputAvailable: boolean;
  rawOutputRetained: boolean;
  rawOutputArtifactPath?: string;
  parserResult?: QcParserResult;
  exitCode?: number;
  stdoutLength: number;
  stderrLength: number;
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
  providerAttempt?: QcProviderAttempt;
  allProvidersFailed?: boolean;
}

/** Lifecycle status of a compiled repair packet. */
export type QcRepairPacketStatus =
  | "pending"
  | "dispatched"
  | "completed"
  | "failed"
  | "escalated";

/** Compiled cluster-scoped repair packet manifest produced by the QC compiler. */
export interface QcRepairPacket {
  packetId: string;
  round: number;
  clusterId: string;
  sourceQcRunIds: string[];
  findingIds: string[];
  severityFloor: QcSeverity;
  rootCauseHint: string;
  allowedScope: string[];
  prohibitedScope: string[];
  validationCommands: string[];
  routingTarget: QcRoutingDecision;
  parallelGroup: string | null;
  conflicts: string[];
  medic: boolean;
  status: QcRepairPacketStatus;
  createdAt: string;
}

/** Durable repair-round manifest persisted for Foreman discovery. */
export interface QcRepairPacketManifest {
  schemaVersion: string;
  clusterId: string;
  round: number;
  compiledAt: string;
  sourceQcRunIds: string[];
  packets: QcRepairPacket[];
}

/** Allowed outcomes for an operator resolution artifact. */
export const QC_RESOLUTION_OUTCOMES = ["pass", "no-repairable"] as const;

/** Outcome an operator records in a QC resolution artifact. */
export type QcResolutionOutcome = (typeof QC_RESOLUTION_OUTCOMES)[number];

/** Operator-written resolution artifact for a QC repair-loop round. */
export interface QcResolutionArtifact {
  schemaVersion: string;
  clusterId: string;
  round: number;
  resolvedAt: string;
  resolver: string;
  resolvedOutcome: QcResolutionOutcome;
  reason: string;
  findings: string[];
}
