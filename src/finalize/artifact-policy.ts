import path from "node:path";

export type ArtifactPathClass =
  | "non-artifact"
  | "promoted-cluster-artifact"
  | "promoted-run-ledger"
  | "promoted-map-artifact"
  | "workspace-scratch"
  | "foreign-cluster-artifact"
  | "legacy-run-artifact";

export interface ArtifactPromotionViolation {
  path: string;
  classification: Exclude<ArtifactPathClass, "non-artifact" | "promoted-cluster-artifact" | "promoted-run-ledger" | "promoted-map-artifact">;
  message: string;
}

const PROMOTED_RUN_LEDGER = ".polaris/runs/ledger.jsonl";
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
  );
}

export function classifyArtifactPath(filePath: string, activeClusterId: string): ArtifactPathClass {
  const relativePath = normalizeArtifactPath(filePath);

  if (!relativePath.startsWith(".polaris/") && !relativePath.startsWith(WORKSPACE_SCRATCH_PREFIX)) {
    return "non-artifact";
  }

  if (relativePath.endsWith(".bak") || relativePath.startsWith(WORKSPACE_SCRATCH_PREFIX)) {
    return "workspace-scratch";
  }

  if (LEGACY_RUN_ARTIFACTS.has(relativePath) || relativePath.startsWith(".polaris/runs/evo-run-archive/")) {
    return "legacy-run-artifact";
  }

  if (relativePath === PROMOTED_RUN_LEDGER) {
    return "promoted-run-ledger";
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
      PROMOTED_RUN_LEDGER,
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
