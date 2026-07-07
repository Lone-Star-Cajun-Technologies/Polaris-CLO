import path from "node:path";

export type ArtifactPathClass =
  | "non-artifact"
  | "promoted-cluster-artifact"
  | "promoted-run-ledger"
  | "promoted-cognition-archive"
  | "promoted-map-artifact"
  | "workspace-scratch"
  | "foreign-cluster-artifact"
  | "legacy-run-artifact";

export interface ArtifactPromotionViolation {
  path: string;
  classification: Exclude<ArtifactPathClass, "non-artifact" | "promoted-cluster-artifact" | "promoted-run-ledger" | "promoted-cognition-archive" | "promoted-map-artifact">;
  message: string;
}

const PROMOTED_RUN_LEDGER = ".polaris/runs/ledger.jsonl";
const PROMOTED_COGNITION_ARCHIVE_PREFIX = ".polaris/cognition/archive/";
const PROMOTED_MAP_PREFIX = ".polaris/map/";
const WORKSPACE_SCRATCH_PREFIX = ".taskchain_artifacts/";
const LEGACY_RUN_ARTIFACTS = new Set([
  ".polaris/runs/mutation-queue.json",
  ".polaris/runs/current-state.pre-pol-198.json",
]);

function normalizeArtifactPath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function getActiveClusterPrefix(activeClusterId: string): string {
  return `.polaris/clusters/${activeClusterId}/`;
}

function isPromotedClusterArtifact(relativePath: string, activeClusterId: string): boolean {
  const activeClusterPrefix = getActiveClusterPrefix(activeClusterId);
  if (!relativePath.startsWith(activeClusterPrefix)) {
    return false;
  }

  const suffix = relativePath.slice(activeClusterPrefix.length);
  return (
    suffix === "clusters.json"
    || suffix === "cluster-state.json"
    || suffix.startsWith("packets/")
    || suffix.startsWith("results/")
    || suffix.startsWith("qc/")
  );
}

export function classifyArtifactPath(filePath: string, activeClusterId: string): ArtifactPathClass {
  const relativePath = normalizeArtifactPath(filePath);

  if (relativePath.endsWith(".bak")) {
    return "workspace-scratch";
  }

  if (!relativePath.startsWith(".polaris/") && !relativePath.startsWith(WORKSPACE_SCRATCH_PREFIX)) {
    return "non-artifact";
  }

  if (relativePath.startsWith(WORKSPACE_SCRATCH_PREFIX)) {
    return "workspace-scratch";
  }

  if (LEGACY_RUN_ARTIFACTS.has(relativePath) || relativePath.startsWith(".polaris/runs/evo-run-archive/")) {
    return "legacy-run-artifact";
  }

  if (relativePath === PROMOTED_RUN_LEDGER) {
    return "promoted-run-ledger";
  }

  if (relativePath.startsWith(PROMOTED_COGNITION_ARCHIVE_PREFIX)) {
    return "promoted-cognition-archive";
  }

  if (relativePath.startsWith(PROMOTED_MAP_PREFIX)) {
    return "promoted-map-artifact";
  }

  if (isPromotedClusterArtifact(relativePath, activeClusterId)) {
    return "promoted-cluster-artifact";
  }

  if (relativePath.startsWith(".polaris/clusters/")) {
    return "foreign-cluster-artifact";
  }

  if (relativePath.startsWith(".polaris/runs/")) {
    return "legacy-run-artifact";
  }

  return "non-artifact";
}

export function isPromotedArtifactPath(filePath: string, activeClusterId: string): boolean {
  const classification = classifyArtifactPath(filePath, activeClusterId);
  return (
    classification === "promoted-cluster-artifact"
    || classification === "promoted-run-ledger"
    || classification === "promoted-cognition-archive"
    || classification === "promoted-map-artifact"
  );
}

export function explainArtifactPolicy(filePath: string, activeClusterId: string): string {
  const relativePath = normalizeArtifactPath(filePath);
  const classification = classifyArtifactPath(relativePath, activeClusterId);

  switch (classification) {
    case "promoted-cluster-artifact":
      return "active cluster evidence is eligible for promotion into finalize commits";
    case "promoted-run-ledger":
      return "the run ledger is durable audit evidence and stays commit-eligible";
    case "promoted-cognition-archive":
      return "archived cognition reconciliation notes are durable provenance and stay commit-eligible";
    case "promoted-map-artifact":
      return "atlas outputs under .polaris/map/ are durable derived artifacts";
    case "workspace-scratch":
      return "workspace scratch under .taskchain_artifacts/ and backup files must never be promoted into delivery commits";
    case "foreign-cluster-artifact":
      return "only the active cluster's durable evidence may be promoted during finalize";
    case "legacy-run-artifact":
      return "legacy or workspace-run artifacts under .polaris/runs/ stay out of delivery commits unless explicitly promoted by newer policy";
    case "non-artifact":
    default:
      return "this path is not a Polaris-managed artifact and should be evaluated by the normal source/document review flow";
  }
}

export function findArtifactPromotionViolations(
  stagedPaths: readonly string[],
  activeClusterId: string,
): ArtifactPromotionViolation[] {
  const violations: ArtifactPromotionViolation[] = [];

  for (const stagedPath of stagedPaths) {
    const relativePath = normalizeArtifactPath(stagedPath);
    const classification = classifyArtifactPath(relativePath, activeClusterId);

    if (
      classification === "non-artifact"
      || classification === "promoted-cluster-artifact"
      || classification === "promoted-run-ledger"
      || classification === "promoted-cognition-archive"
      || classification === "promoted-map-artifact"
    ) {
      continue;
    }

    violations.push({
      path: relativePath,
      classification,
      message: explainArtifactPolicy(relativePath, activeClusterId),
    });
  }

  return violations;
}

export function getArtifactPromotionPolicy(activeClusterId: string): {
  promoted: string[];
  blocked: string[];
} {
  const activeClusterPrefix = getActiveClusterPrefix(activeClusterId);

  return {
    promoted: [
      `${activeClusterPrefix}clusters.json`,
      `${activeClusterPrefix}cluster-state.json`,
      `${activeClusterPrefix}packets/**`,
      `${activeClusterPrefix}results/**`,
      `${activeClusterPrefix}qc/**`,
      PROMOTED_RUN_LEDGER,
      `${PROMOTED_COGNITION_ARCHIVE_PREFIX}**`,
      `${PROMOTED_MAP_PREFIX}**`,
    ],
    blocked: [
      `${WORKSPACE_SCRATCH_PREFIX}**`,
      "*.bak",
      ".polaris/runs/mutation-queue.json",
      ".polaris/runs/current-state.pre-pol-198.json",
      ".polaris/runs/evo-run-archive/**",
      ".polaris/clusters/<other-cluster>/**",
    ],
  };
}

export function getArtifactPromotionStageTargets(activeClusterId: string): string[] {
  return getArtifactPromotionPolicy(activeClusterId).promoted.map((pattern) => (
    pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern
  ));
}

/**
 * Returns gitignore patterns for runtime and crash-recovery artifact classes.
 * These patterns should be added to .gitignore to prevent accidental staging.
 */
export function getGitignorePatterns(): string[] {
  return [
    "# Polaris workspace scratch — never commit",
    ".taskchain_artifacts/**",
    "*.bak",
    ".polaris/runs/mutation-queue.json",
    ".polaris/runs/current-state.pre-pol-198.json",
    ".polaris/runs/evo-run-archive/**",
    ".polaris/bootstrap/**",
    ".polaris/session-type",
    "# Cognition staging — ephemeral, not committed",
    ".polaris/cognition/pending/**",
  ];
}

/**
 * Formats gitignore patterns as a block suitable for appending to .gitignore.
 */
export function formatGitignoreBlock(): string {
  return getGitignorePatterns().join("\n");
}

/**
 * Returns true if the given path should be blocked from staging by adoption.
 * This is a stricter check than promotion violations — it blocks all runtime/crash-recovery
 * classes, not just violations during finalize.
 */
export function isPathBlockedFromStaging(filePath: string): boolean {
  const relativePath = normalizeArtifactPath(filePath);

  // Block workspace scratch
  if (relativePath.startsWith(WORKSPACE_SCRATCH_PREFIX)) {
    return true;
  }

  // Block backup files
  if (relativePath.endsWith(".bak")) {
    return true;
  }

  // Block legacy run artifacts
  if (LEGACY_RUN_ARTIFACTS.has(relativePath) || relativePath.startsWith(".polaris/runs/evo-run-archive/")) {
    return true;
  }

  // Block runtime crash-recovery artifacts
  if (
    relativePath === ".polaris/runs/mutation-queue.json" ||
    relativePath === ".polaris/runs/current-state.pre-pol-198.json" ||
    relativePath.startsWith(".polaris/bootstrap/") ||
    relativePath === ".polaris/session-type"
  ) {
    return true;
  }

  // Block cognition pending staging
  if (relativePath.startsWith(".polaris/cognition/pending/")) {
    return true;
  }

  return false;
}

/**
 * Filters a list of paths to return only those that are safe to stage.
 * This is used by adoption to ensure runtime artifacts are not staged.
 */
export function filterStageablePaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !isPathBlockedFromStaging(path));
}
