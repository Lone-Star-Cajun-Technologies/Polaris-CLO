import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readClusterState } from "../cluster-state/store.js";
import { LocalGraph } from "../tracker/local-graph.js";
import { LinearAdapter } from "../tracker/adapters/linear/index.js";
import { loadConfig } from "../config/loader.js";
import { readState, validateState } from "./checkpoint.js";
import type { BootstrapInitOptions } from "./run-bootstrap.js";

type BootstrapHandler = (options: BootstrapInitOptions) => Promise<void> | void;

interface BootstrapPlan {
  openChildren: string[];
  openChildrenMeta: NonNullable<BootstrapInitOptions["openChildrenMeta"]>;
}

function getClusterStatePath(clusterId: string, repoRoot: string): string {
  return join(repoRoot, ".polaris", "clusters", clusterId, "cluster-state.json");
}

export interface EnsureClusterRunStateOptions {
  clusterId: string;
  stateFile: string;
  repoRoot: string;
  bootstrapHandler: BootstrapHandler;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function loadOrSyncGraph(clusterId: string, repoRoot: string): Promise<LocalGraph> {
  try {
    return await LocalGraph.load(clusterId, repoRoot);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }

    const config = loadConfig(repoRoot);
    if (!config.tracker?.linear?.enabled) {
      throw new Error(
        `No local cluster graph found for ${clusterId}. Run 'npx polaris tracker sync-in ${clusterId}' or bootstrap with --children.`,
      );
    }

    const graph = await new LinearAdapter(config).syncIn(clusterId);
    await graph.save(clusterId, repoRoot);
    return graph;
  }
}

function topoSort(children: string[], getDeps: (id: string) => string[]): string[] {
  // Kahn's algorithm — only sorts within the given children set
  const childSet = new Set(children);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → [children that need dep]

  for (const child of children) {
    inDegree.set(child, 0);
    dependents.set(child, []);
  }

  for (const child of children) {
    for (const dep of getDeps(child)) {
      if (!childSet.has(dep)) continue; // external dep — ignore for ordering
      inDegree.set(child, (inDegree.get(child) ?? 0) + 1);
      dependents.get(dep)!.push(child);
    }
  }

  const queue: string[] = [];
  for (const [child, deg] of inDegree) {
    if (deg === 0) queue.push(child);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const dependent of dependents.get(node) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  // If sort is incomplete (cycle), fall back to original order for remaining nodes
  if (sorted.length < children.length) {
    const sortedSet = new Set(sorted);
    for (const child of children) {
      if (!sortedSet.has(child)) sorted.push(child);
    }
  }

  return sorted;
}

function buildBootstrapPlan(clusterId: string, graph: LocalGraph, repoRoot: string): BootstrapPlan {
  const activeCluster = graph.getActiveCluster();

  // Exclude the cluster root from runnable children when it has implementation
  // children. The root is a context/coordination node. If after filtering nothing
  // remains (leaf cluster), fall back to [clusterId] so the root runs as the sole
  // work item — matching single-target leaf semantics.
  const clusterRoot = activeCluster.cluster_root;
  const runnableChildren = clusterRoot
    ? activeCluster.children.filter((id) => id !== clusterRoot)
    : activeCluster.children;
  const unsortedChildren = runnableChildren.length > 0 ? runnableChildren : [clusterId];

  // If a cluster-plan.json exists, use its children order as the preferred
  // tiebreaker within each ready wave of the topological sort. The plan order
  // reflects the analyst's intended sequencing; clusters.json order is whatever
  // the tracker returned, which may be arbitrary.
  const planOrder = readClusterPlanOrder(clusterId, repoRoot);
  const preferredOrder = applyPlanOrder(unsortedChildren, planOrder);

  const openChildren = topoSort(preferredOrder, (id) => graph.getDependencies(id));

  const openChildrenMeta: BootstrapPlan["openChildrenMeta"] = {};

  const clusterNode = graph.getNode(clusterId);
  openChildrenMeta[clusterId] = {
    title: clusterNode?.title ?? activeCluster.title,
    ...(clusterNode?.body ? { body: clusterNode.body } : {}),
  };

  for (const childId of openChildren) {
    const node = graph.getNode(childId);
    openChildrenMeta[childId] = {
      ...openChildrenMeta[childId],
      title: node?.title ?? openChildrenMeta[childId]?.title ?? childId,
      ...(node?.body ? { body: node.body } : {}),
    };
  }

  return { openChildren, openChildrenMeta };
}

function readClusterPlanOrder(clusterId: string, repoRoot: string): string[] {
  const planPath = join(repoRoot, ".polaris", "clusters", clusterId, "cluster-plan.json");
  if (!existsSync(planPath)) return [];
  try {
    const plan = JSON.parse(readFileSync(planPath, "utf-8")) as { children?: Array<{ id: string }> };
    if (Array.isArray(plan.children)) {
      return plan.children.map((c) => c.id).filter(Boolean);
    }
  } catch {
    // malformed plan — fall back to no preferred order
  }
  return [];
}

function applyPlanOrder(children: string[], planOrder: string[]): string[] {
  if (planOrder.length === 0) return children;
  const childSet = new Set(children);
  const ordered = planOrder.filter((id) => childSet.has(id));
  const remaining = children.filter((id) => !ordered.includes(id));
  return [...ordered, ...remaining];
}

function preserveMismatchedState(stateFile: string): void {
  const suffix = (() => {
    try {
      const state = readState(stateFile);
      return `${state.run_id || "state"}-${Date.now()}`;
    } catch {
      return `state-${Date.now()}`;
    }
  })();

  renameSync(stateFile, `${stateFile}.${suffix}.bak`);
}

async function isGhostCompleteState(
  clusterId: string,
  repoRoot: string,
  completedChildren: string[],
  status?: string,
): Promise<boolean> {
  if (status !== "cluster-complete" && completedChildren.length === 0) {
    return false;
  }

  const clusterState = await readClusterState(clusterId, repoRoot);
  if (!clusterState) {
    return false;
  }

  const unfinishedStatuses = new Set(["ready", "claimed", "dispatched", "running", "failed", "blocked"]);
  return clusterState.child_states.some((child) => {
    if (!completedChildren.includes(child.id) && status !== "cluster-complete") {
      return false;
    }
    return unfinishedStatuses.has(child.status);
  });
}

async function assertCanonicalClusterState(
  clusterId: string,
  repoRoot: string,
  state: {
    active_child?: string;
    open_children?: string[];
    completed_children?: string[];
  },
): Promise<void> {
  const clusterStatePath = getClusterStatePath(clusterId, repoRoot);
  const clusterState = await readClusterState(clusterId, repoRoot);

  if (!clusterState) {
    throw new Error(
      `run-preflight: missing canonical cluster-state for ${clusterId} at ${clusterStatePath}. ` +
      "The live execution state must exist before Polaris reuses current-state.json.",
    );
  }

  const clusterChildIds = new Set(clusterState.child_states.map((child) => child.id));
  const referencedChildren = new Set([
    ...state.completed_children ?? [],
    ...state.open_children ?? [],
    ...(
      state.active_child && state.active_child.length > 0
        ? [state.active_child]
        : []
    ),
  ]);
  const missingChildren = [...referencedChildren].filter((childId) => !clusterChildIds.has(childId));

  if (missingChildren.length > 0) {
    throw new Error(
      `run-preflight: cluster-state for ${clusterId} is missing children referenced by current-state.json: ${missingChildren.join(", ")}`,
    );
  }
}

export async function ensureClusterRunState(options: EnsureClusterRunStateOptions): Promise<void> {
  const { clusterId, stateFile, repoRoot, bootstrapHandler } = options;

  if (existsSync(stateFile)) {
    let existingState;
    try {
      existingState = readState(stateFile);
    } catch (err) {
      if (!isEnoent(err)) {
        console.warn(
          `run-preflight: failed to read state file ${stateFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // ENOENT (race condition) or parse/IO error — proceed to bootstrap
    }

    if (existingState !== undefined) {
      const validationErrors = validateState(existingState);
      if (existingState.cluster_id === clusterId) {
        if (
          await isGhostCompleteState(
            clusterId,
            repoRoot,
            existingState.completed_children ?? [],
            existingState.status,
          )
        ) {
          preserveMismatchedState(stateFile);
        } else {
          // Valid state for this cluster — no bootstrap needed
          if (validationErrors.length === 0) {
            await assertCanonicalClusterState(clusterId, repoRoot, existingState);
            return;
          }
          // Leave invalid in-place so downstream validation reports the real state error.
          return;
        }
      } else {
        if (!existingState.cluster_id && validationErrors.length > 0) {
          return;
        }
        // Mismatched cluster_id — always preserve, with a warning if also invalid
        if (validationErrors.length > 0) {
          console.warn(
            `run-preflight: state file ${stateFile} has cluster_id "${existingState.cluster_id}" (expected "${clusterId}") and failed validation; preserving for inspection.`,
          );
        }
        preserveMismatchedState(stateFile);
      }
    }
  }

  const { openChildren, openChildrenMeta } = buildBootstrapPlan(
    clusterId,
    await loadOrSyncGraph(clusterId, repoRoot),
    repoRoot,
  );

  await bootstrapHandler({
    clusterId,
    openChildren,
    openChildrenMeta,
    stateFile,
    repoRoot,
    artifactDir: join(repoRoot, ".taskchain_artifacts", "polaris-run"),
  });
}
