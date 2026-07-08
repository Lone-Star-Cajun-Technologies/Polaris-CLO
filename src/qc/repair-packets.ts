import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { QcConfig } from "../config/schema.js";
import type {
  QcFinding,
  QcRepairPacket,
  QcRepairPacketManifest,
  QcResult,
  QcRoutingDecision,
  QcSeverity,
} from "./types.js";
import { compareSeverity, maxSeverity } from "./severity.js";
import { decideRepairRouting } from "./routing.js";
import { validateRepairPacketManifest } from "./schemas.js";

/** Input to the QC repair packet compiler. */
export interface CompileRepairPacketsInput {
  clusterId: string;
  round: number;
  qcResults: QcResult[];
  config: QcConfig;
  validationCommands?: string[];
  repoRoot?: string;
  compiledAt?: string;
}

/** Output of the QC repair packet compiler. */
export interface CompiledRepairPackets {
  clusterId: string;
  round: number;
  packets: QcRepairPacket[];
  manifest: QcRepairPacketManifest;
  manifestPath: string;
}

/** Scope patterns that autonomous repair packets must not touch. */
export const GOVERNANCE_SCOPE_PATTERNS: string[] = [
  "**/.polaris/**",
  "**/.taskchain_artifacts/**",
  "**/polaris.config.*",
  "**/package.json",
  "**/tsconfig*.json",
  "**/.github/**",
  "**/policy*",
  "**/governance*",
];

const HIGH_RISK_CATEGORY_PATTERN =
  /security|secret|vulnerability|vuln|auth|crypto|injection|xss|csrf|sql|data-loss|migration|governance|compliance|privacy|pii|gdpr|hipaa/i;

/** Determine whether a finding category is high-risk/sensitive. */
export function isHighRiskCategory(category: string | undefined): boolean {
  if (!category) return false;
  return HIGH_RISK_CATEGORY_PATTERN.test(category);
}

function riskLevel(finding: QcFinding): "normal" | "high-risk" {
  return isHighRiskCategory(finding.category) ? "high-risk" : "normal";
}

function confidenceBand(finding: QcFinding): "clear" | "unclear" {
  return finding.attribution.confidence === "high" || finding.attribution.confidence === "medium"
    ? "clear"
    : "unclear";
}

function subsystemFromFilePath(filePath: string | undefined): string {
  if (!filePath) return "unknown";
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? "root" : filePath.slice(0, lastSlash);
}

interface EnrichedFinding extends QcFinding {
  routingTarget: QcRoutingDecision;
  risk: "normal" | "high-risk";
  confidenceBand: "clear" | "unclear";
  subsystem: string;
  sourceQcRunId: string;
}

function enrichFinding(finding: QcFinding, config: QcConfig, sourceQcRunId: string): EnrichedFinding {
  return {
    ...finding,
    routingTarget: resolveRoutingTarget(finding, config),
    risk: riskLevel(finding),
    confidenceBand: confidenceBand(finding),
    subsystem: subsystemFromFilePath(finding.filePath),
    sourceQcRunId,
  };
}

/**
 * Resolve the routing target for a finding, applying conservative safety overrides
 * before falling back to the pre-computed routing decision or the routing policy.
 */
function resolveRoutingTarget(finding: QcFinding, config: QcConfig): QcRoutingDecision {
  // Critical/high severity or high-risk categories are escalated to operator review.
  if (compareSeverity(finding.severity, "high") >= 0 || riskLevel(finding) === "high-risk") {
    return "operator-review";
  }

  // Broad findings without a concrete file path cannot be safely dispatched to repair workers.
  if (!finding.filePath) {
    return compareSeverity(finding.severity, "high") >= 0 ? "operator-review" : "follow-up";
  }

  // Pre-existing findings are deferred unless severity already escalated above.
  if (finding.attribution.reason === "pre-existing") {
    return "follow-up";
  }

  // Low/unattributed confidence is not safe for autonomous repair.
  if (finding.attribution.confidence === "low" || finding.attribution.confidence === "unattributed") {
    return finding.attribution.childId ? "repair-worker" : "follow-up";
  }

  return finding.routingDecision ?? decideRepairRouting(finding, config, finding.autofixEligible);
}

function rangesOverlapOrAdjacent(
  a: QcFinding["range"],
  b: QcFinding["range"],
  adjacency = 5,
): boolean {
  if (!a || !b) return false;
  const aStart = a.startLine ?? 1;
  const aEnd = a.endLine ?? a.startLine ?? 1;
  const bStart = b.startLine ?? 1;
  const bEnd = b.endLine ?? b.startLine ?? 1;
  return !(aEnd + adjacency < bStart || bEnd + adjacency < aStart);
}

/**
 * Conservative grouping predicate.
 *
 * Findings in the same file are always grouped under the same routing target
 * and risk level to avoid parallel edit conflicts. Cross-file grouping requires
 * an exact match on severity, attribution confidence, category, and a specific
 * subsystem directory (at least one path segment deep) so top-level directories
 * do not collapse unrelated files.
 */
function shouldGroup(a: EnrichedFinding, b: EnrichedFinding): boolean {
  if (a.routingTarget !== b.routingTarget) return false;
  if (a.risk !== b.risk) return false;

  const sameFile = a.filePath && b.filePath && a.filePath === b.filePath;
  if (sameFile) return true;

  const sameCategory = a.category && b.category && a.category === b.category;
  const sameSubsystem = a.subsystem !== "unknown" && a.subsystem === b.subsystem;
  const specificSubsystem = sameSubsystem && a.subsystem.includes("/");

  if (
    a.severity === b.severity &&
    a.confidenceBand === b.confidenceBand &&
    sameCategory &&
    specificSubsystem
  ) {
    return true;
  }

  return false;
}

class UnionFind {
  parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      // Deterministic: lower index becomes root.
      this.parent[rb] = ra;
    }
  }
}

function groupFindings(findings: EnrichedFinding[]): EnrichedFinding[][] {
  const sorted = [...findings].sort((a, b) => a.findingId.localeCompare(b.findingId));
  const uf = new UnionFind(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (shouldGroup(sorted[i], sorted[j])) {
        uf.union(i, j);
      }
    }
  }
  const groups = new Map<number, EnrichedFinding[]>();
  for (let i = 0; i < sorted.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(sorted[i]);
  }
  return [...groups.values()].sort((a, b) => a[0].findingId.localeCompare(b[0].findingId));
}

function buildProviderFailurePacket(
  result: QcResult,
  index: number,
  clusterId: string,
  round: number,
  createdAt: string,
): QcRepairPacket {
  const packetId = `pkt-${clusterId}-r${round}-${String(index).padStart(3, "0")}`;
  return {
    packetId,
    round,
    clusterId,
    sourceQcRunIds: [result.qcRunId],
    findingIds: [],
    severityFloor: "critical",
    rootCauseHint: `provider failure: ${result.status}; operator review required`,
    allowedScope: [],
    prohibitedScope: ["**/*"],
    validationCommands: [],
    routingTarget: "operator-review",
    parallelGroup: null,
    conflicts: [],
    medic: true,
    status: "pending",
    createdAt,
  };
}

function buildPacket(
  group: EnrichedFinding[],
  index: number,
  clusterId: string,
  round: number,
  allRunIds: string[],
  validationCommands: string[],
  createdAt: string,
): QcRepairPacket {
  const packetId = `pkt-${clusterId}-r${round}-${String(index).padStart(3, "0")}`;
  const findingIds = group.map((f) => f.findingId).sort();
  const sourceRunIds = [...new Set(group.map((f) => f.sourceQcRunId))].sort();
  const severityFloor = group.reduce(
    (acc, f) => maxSeverity(acc, f.severity),
    "info" as QcSeverity,
  );
  const categories = [...new Set(group.map((f) => f.category).filter(Boolean))].sort();
  const filePaths = group.map((f) => f.filePath).filter((f): f is string => Boolean(f));
  const files = [...new Set(filePaths)].sort();

  const rootCauseHint = [
    `categories=[${categories.join(", ") || "uncategorized"}]`,
    `files=[${files.join(", ") || "none"}]`,
    `confidence=${group[0]?.confidenceBand ?? "clear"}`,
    `severity=${severityFloor}`,
  ].join("; ");

  const hasHighRisk = group.some((f) => f.risk === "high-risk");
  const medic =
    group[0].routingTarget === "operator-review" &&
    (compareSeverity(severityFloor, "high") >= 0 || hasHighRisk);

  return {
    packetId,
    round,
    clusterId,
    sourceQcRunIds: sourceRunIds.length > 0 ? sourceRunIds : allRunIds,
    findingIds,
    severityFloor,
    rootCauseHint,
    allowedScope: files,
    prohibitedScope: hasHighRisk ? GOVERNANCE_SCOPE_PATTERNS : [],
    validationCommands,
    routingTarget: group[0].routingTarget,
    parallelGroup: null,
    conflicts: [],
    medic,
    status: "pending",
    createdAt,
  };
}

function scopeOverlap(a: QcRepairPacket, b: QcRepairPacket): boolean {
  const aScope = new Set([...a.allowedScope, ...a.prohibitedScope]);
  const bScope = new Set([...b.allowedScope, ...b.prohibitedScope]);
  for (const s of aScope) {
    if (bScope.has(s)) return true;
  }
  return false;
}

function packetsConflict(a: QcRepairPacket, b: QcRepairPacket): boolean {
  // Medic packets are never parallel-safe.
  if (a.medic || b.medic) return true;
  return scopeOverlap(a, b);
}

function assignParallelGroups(packets: QcRepairPacket[]): QcRepairPacket[] {
  const sorted = [...packets].sort((a, b) => a.packetId.localeCompare(b.packetId));
  const groups: QcRepairPacket[][] = [];

  for (const packet of sorted) {
    let assigned = false;
    for (let i = 0; i < groups.length; i++) {
      if (!groups[i].some((p) => packetsConflict(p, packet))) {
        groups[i].push(packet);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      groups.push([packet]);
    }
  }

  const packetToGroup = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((p) => packetToGroup.set(p.packetId, i)));

  return sorted.map((packet) => {
    const groupIndex = packetToGroup.get(packet.packetId);
    const conflicts = sorted
      .filter((p) => p.packetId !== packet.packetId && packetsConflict(packet, p))
      .map((p) => p.packetId)
      .sort();
    return {
      ...packet,
      parallelGroup:
        groupIndex === undefined ? null : `g-${String(groupIndex).padStart(3, "0")}`,
      conflicts,
    };
  });
}

/** Returns the directory for a repair-round manifest. */
export function getRepairRoundDir(clusterId: string, round: number, repoRoot?: string): string {
  return path.join(
    repoRoot || process.cwd(),
    ".polaris",
    "clusters",
    clusterId,
    "qc",
    "repair-rounds",
    String(round),
  );
}

/** Returns the persisted path for a repair-round manifest. */
export function getRepairPacketManifestPath(
  clusterId: string,
  round: number,
  repoRoot?: string,
): string {
  return path.join(getRepairRoundDir(clusterId, round, repoRoot), "repair-packets.json");
}

/**
 * Compile normalized QC findings into cluster-scoped repair packet manifests.
 *
 * The compiler is deterministic for the same inputs (grouping, conflict detection,
 * and parallel group assignment are stable) and is conservative about merging
 * unrelated security/auth/data-loss/migration/governance findings with normal repairs.
 */
export function compileRepairPackets(input: CompileRepairPacketsInput): CompiledRepairPackets {
  const {
    clusterId,
    round,
    qcResults,
    config,
    validationCommands = [],
    repoRoot,
    compiledAt = new Date().toISOString(),
  } = input;

  const sortedResults = [...qcResults].sort((a, b) => a.qcRunId.localeCompare(b.qcRunId));
  const allRunIds = sortedResults.map((r) => r.qcRunId);
  const packets: QcRepairPacket[] = [];

  // Provider failure artifacts that require operator review are surfaced as Medic packets.
  for (const result of sortedResults) {
    if (result.allProvidersFailed || result.status === "failed" || result.status === "blocked") {
      packets.push(buildProviderFailurePacket(result, packets.length, clusterId, round, compiledAt));
    }
  }

  // Actionable findings from successful runs.
  const actionableFindings: EnrichedFinding[] = [];
  for (const result of sortedResults) {
    if (result.status === "failed" || result.status === "blocked") {
      continue;
    }
    for (const finding of result.findings) {
      if (
        finding.status === "waived" ||
        finding.status === "autofixed" ||
        finding.status === "repaired"
      ) {
        continue;
      }
      actionableFindings.push(enrichFinding(finding, config, result.qcRunId));
    }
  }

  // Deduplicate by findingId; keep first occurrence in sorted run order.
  const seenIds = new Set<string>();
  const uniqueFindings: EnrichedFinding[] = [];
  for (const finding of actionableFindings) {
    if (seenIds.has(finding.findingId)) continue;
    seenIds.add(finding.findingId);
    uniqueFindings.push(finding);
  }

  const groups = groupFindings(uniqueFindings);
  for (const group of groups) {
    packets.push(
      buildPacket(group, packets.length, clusterId, round, allRunIds, validationCommands, compiledAt),
    );
  }

  const finalPackets = assignParallelGroups(packets);

  const manifest: QcRepairPacketManifest = {
    schemaVersion: "1.0",
    clusterId,
    round,
    compiledAt,
    sourceQcRunIds: allRunIds,
    packets: finalPackets,
  };

  const manifestPath = getRepairPacketManifestPath(clusterId, round, repoRoot);

  return {
    clusterId,
    round,
    packets: finalPackets,
    manifest,
    manifestPath,
  };
}

/**
 * Persist a compiled repair packet manifest as a durable cluster artifact.
 * Writes atomically via a temp file + rename and returns the absolute path.
 */
export function writeRepairPacketManifest(
  manifest: QcRepairPacketManifest,
  repoRoot?: string,
): string {
  const manifestPath = getRepairPacketManifestPath(manifest.clusterId, manifest.round, repoRoot);
  const dir = path.dirname(manifestPath);
  mkdirSync(dir, { recursive: true });

  const tempPath = `${manifestPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tempPath, JSON.stringify(manifest, null, 2), "utf-8");
    renameSync(tempPath, manifestPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failure.
    }
    throw error;
  }

  return manifestPath;
}

/** Convenience helper that compiles and persists repair packets in one call. */
export function compileAndWriteRepairPackets(
  input: CompileRepairPacketsInput,
): CompiledRepairPackets & { manifestPath: string } {
  const result = compileRepairPackets(input);
  writeRepairPacketManifest(result.manifest, input.repoRoot);
  return result;
}

/**
 * Read and validate a persisted repair packet manifest.
 * Returns null if the file is missing or fails schema validation.
 */
export function readRepairPacketManifest(
  clusterId: string,
  round: number,
  repoRoot?: string,
): QcRepairPacketManifest | null {
  const manifestPath = getRepairPacketManifestPath(clusterId, round, repoRoot);
  try {
    const data = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(data) as unknown;
    const validation = validateRepairPacketManifest(parsed);
    if (!validation.success) {
      return null;
    }
    return validation.manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}
