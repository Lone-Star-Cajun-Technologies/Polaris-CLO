import {
  promises as fs,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import * as path from 'path';
import { ClusterState, ChildState, QcRunPointer } from './types';
import type { QcArtifactAvailability } from './types';
import { LocalGraph } from '../tracker/local-graph';
import type { QcResult } from '../qc/types.js';
import { writeQcArtifact, validateQcArtifactPointers } from '../qc/artifacts.js';

const getClusterStatePath = (clusterId: string, repoRoot?: string): string => {
  return path.join(repoRoot || process.cwd(), '.polaris', 'clusters', clusterId, 'cluster-state.json');
};

const normalizeClusterState = (state: ClusterState): ClusterState => ({
  ...state,
  tracker_mutations: state.tracker_mutations ?? {},
  qc_runs: state.qc_runs ?? {},
});

const toRepoRelative = (repoRoot: string, p: string): string => {
  return path.relative(repoRoot, path.resolve(repoRoot, p));
};

export function pruneExpiredClaims(
  state: ClusterState,
  now: Date = new Date(),
): { state: ClusterState; expiredChildIds: string[] } {
  const nowMs = now.getTime();
  const expiredChildIds: string[] = [];
  const nextClaimMetadata: ClusterState["claim_metadata"] = {};

  for (const [childId, claim] of Object.entries(state.claim_metadata ?? {})) {
    const expiresAtMs = new Date(claim.expires_at).getTime();
    const active = Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
    if (active) {
      nextClaimMetadata[childId] = claim;
      continue;
    }
    expiredChildIds.push(childId);
  }

  if (expiredChildIds.length === 0) {
    return { state, expiredChildIds };
  }

  const expiredSet = new Set(expiredChildIds);
  const recoverableStatuses = new Set<ChildState["status"]>(["claimed", "dispatched", "running"]);
  const child_states = state.child_states.map((child) => {
    if (!expiredSet.has(child.id) || !recoverableStatuses.has(child.status)) {
      return child;
    }
    return { ...child, status: "ready" as const };
  });

  return {
    state: {
      ...state,
      state_generation: state.state_generation + 1,
      claim_metadata: nextClaimMetadata,
      child_states,
    },
    expiredChildIds,
  };
}

export const readClusterState = async (clusterId: string, repoRoot?: string): Promise<ClusterState | null> => {
  const filePath = getClusterStatePath(clusterId, repoRoot);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    if (!data) {
      return null;
    }
    return normalizeClusterState(JSON.parse(data) as ClusterState);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

export const readClusterStateSync = (clusterId: string, repoRoot?: string): ClusterState | null => {
  const filePath = getClusterStatePath(clusterId, repoRoot);
  try {
    const data = readFileSync(filePath, 'utf-8');
    if (!data) {
      return null;
    }
    return normalizeClusterState(JSON.parse(data) as ClusterState);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

export const writeClusterState = async (clusterId: string, state: ClusterState, repoRoot?: string): Promise<void> => {
  const filePath = getClusterStatePath(clusterId, repoRoot);
  const lockFilePath = filePath + '.lock';
  const tempFilePath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  // Acquire lock (simple lock file approach with retry)
  let lockAcquired = false;
  const maxRetries = 50;
  const retryDelayMs = 100;
  const staleLockThresholdMs = 30000; // 30 seconds

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Try to create lock file exclusively (fails if it already exists)
      await fs.writeFile(lockFilePath, String(process.pid), { flag: 'wx' });
      lockAcquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock file exists, check if it's stale before retrying
        try {
          const lockStat = await fs.stat(lockFilePath);
          const lockAge = Date.now() - lockStat.mtimeMs;

          if (lockAge > staleLockThresholdMs) {
            // Lock is stale, try to read the PID
            let isStale = true;
            try {
              const lockContent = await fs.readFile(lockFilePath, 'utf-8');
              const lockPid = parseInt(lockContent.trim(), 10);

              // Check if the process is still running
              if (!isNaN(lockPid)) {
                try {
                  // process.kill with signal 0 checks existence without killing
                  process.kill(lockPid, 0);
                  // Process exists, lock is not stale
                  isStale = false;
                } catch (pidError) {
                  // Process doesn't exist (ESRCH) or no permission (EPERM)
                  // If EPERM, process exists but we can't signal it, so not stale
                  if ((pidError as NodeJS.ErrnoException).code === 'EPERM') {
                    isStale = false;
                  }
                  // Otherwise (ESRCH), process doesn't exist, lock is stale
                }
              }
            } catch {
              // If we can't read the lock file or parse PID, consider it stale based on age
            }

            if (isStale) {
              console.warn(`Removing stale lock file for cluster ${clusterId} (age: ${lockAge}ms)`);
              try {
                await fs.unlink(lockFilePath);
                // Retry immediately after removing stale lock
                continue;
              } catch (unlinkError) {
                // Race condition: another process may have removed it
                if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
                  throw unlinkError;
                }
              }
            }
          }
        } catch (statError) {
          // If lock file disappeared between EEXIST and stat, retry
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
          // Other errors during stat, just retry with delay
        }

        // Lock file exists and is not stale, wait and retry
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      } else {
        throw error;
      }
    }
  }

  if (!lockAcquired) {
    throw new Error(`Failed to acquire lock for cluster state ${clusterId} after ${maxRetries} attempts`);
  }

  try {
    // Re-read current state under lock
    const currentState = await readClusterState(clusterId, repoRoot);

    if (currentState && currentState.state_generation >= state.state_generation) {
      throw new Error('Stale state: state_generation is not greater than current state.');
    }

    // Write to unique temp file and atomically rename
    await fs.writeFile(tempFilePath, JSON.stringify(state, null, 2));
    await fs.rename(tempFilePath, filePath);
  } finally {
    // Release lock
    try {
      await fs.unlink(lockFilePath);
    } catch {
      // Ignore errors during lock cleanup
    }
  }
};

export const writeClusterStateSync = (clusterId: string, state: ClusterState, repoRoot?: string): void => {
  const filePath = getClusterStatePath(clusterId, repoRoot);
  const lockFilePath = filePath + '.lock';
  const tempFilePath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  let lockAcquired = false;
  const maxRetries = 50;
  const retryDelayMs = 100;
  const staleLockThresholdMs = 30000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      mkdirSync(path.dirname(lockFilePath), { recursive: true });
      writeFileSync(lockFilePath, String(process.pid), { flag: 'wx' });
      lockAcquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      try {
        const lockStat = statSync(lockFilePath);
        const lockAge = Date.now() - lockStat.mtimeMs;

        if (lockAge > staleLockThresholdMs) {
          let isStale = true;
          try {
            const lockContent = readFileSync(lockFilePath, 'utf-8');
            const lockPid = parseInt(lockContent.trim(), 10);
            if (!isNaN(lockPid)) {
              try {
                process.kill(lockPid, 0);
                isStale = false;
              } catch (pidError) {
                if ((pidError as NodeJS.ErrnoException).code === 'EPERM') {
                  isStale = false;
                }
              }
            }
          } catch {
            // Ignore parse/read failure and fall back to age-based stale handling.
          }

          if (isStale) {
            try {
              unlinkSync(lockFilePath);
              continue;
            } catch (unlinkError) {
              if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw unlinkError;
              }
            }
          }
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs);
    }
  }

  if (!lockAcquired) {
    throw new Error(`Failed to acquire lock for cluster state ${clusterId} after ${maxRetries} attempts`);
  }

  try {
    const currentState = readClusterStateSync(clusterId, repoRoot);
    if (currentState && currentState.state_generation >= state.state_generation) {
      throw new Error('Stale state: state_generation is not greater than current state.');
    }

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(tempFilePath, JSON.stringify(state, null, 2));
    renameSync(tempFilePath, filePath);
  } finally {
    try {
      unlinkSync(lockFilePath);
    } catch {
      // Ignore errors during lock cleanup.
    }
  }
};

export const initializeClusterState = async (clusterId: string, repoRoot?: string): Promise<ClusterState> => {
  const graph = await LocalGraph.load(clusterId, repoRoot);
  const activeCluster = graph.getActiveCluster();

  if (!activeCluster) {
    throw new Error(`Cluster ${clusterId} not found in graph.`);
  }

  // Exclude cluster root from child states — mirrors buildBootstrapPlan logic.
  const clusterRoot = activeCluster.cluster_root;
  const runnableChildren = clusterRoot
    ? activeCluster.children.filter((id) => id !== clusterRoot)
    : activeCluster.children;
  const childrenToInitialize =
    runnableChildren.length > 0 ? runnableChildren : [clusterId];

  const childStates: ChildState[] = childrenToInitialize.map(childId => ({
    id: childId,
    status: 'ready',
  }));

  const initialState: ClusterState = {
    schema_version: '1.0',
    cluster_id: clusterId,
    state_generation: 1,
    child_states: childStates,
    claim_metadata: {},
    packet_pointers: {},
    result_pointers: {},
    validation_results: {},
    commits: {},
    tracker_mutations: {},
    blockers: [],
    qc_runs: {},
  };

  await writeClusterState(clusterId, initialState, repoRoot);
  return initialState;
};

/**
 * Persist a QC result artifact under the active cluster's evidence surface and
 * record a pointer in the cluster state. This is the only supported way to
 * durably store QC runs; callers must not write QC artifacts directly outside
 * `.polaris/clusters/<cluster-id>/qc/`.
 */
export const recordQcRun = async (
  clusterId: string,
  result: QcResult,
  repoRoot?: string,
): Promise<{ artifactPath: string; state: ClusterState }> => {
  const root = repoRoot || process.cwd();
  const artifactPath = writeQcArtifact(clusterId, result, repoRoot);
  const toRel = (p: string) => toRepoRelative(root, p);

  const currentState = await readClusterState(clusterId, repoRoot);
  if (!currentState) {
    throw new Error(`Cluster ${clusterId} state not found; cannot record QC run ${result.qcRunId}.`);
  }

  const rawArtifactPaths = (result.rawArtifactPaths ?? []).map(toRel);
  const providerAttemptRawPath = result.providerAttempt?.rawOutputArtifactPath
    ? toRel(result.providerAttempt.rawOutputArtifactPath)
    : undefined;

  const rawArtifactAbsPaths = (result.rawArtifactPaths ?? []).map((p) => path.resolve(root, p));
  const providerAttemptAbsPath = result.providerAttempt?.rawOutputArtifactPath
    ? path.resolve(root, result.providerAttempt.rawOutputArtifactPath)
    : undefined;
  const auditArtifactPaths = providerAttemptAbsPath
    ? [...rawArtifactAbsPaths, providerAttemptAbsPath]
    : rawArtifactAbsPaths;

  const failedRun =
    result.status === "failed" || result.status === "blocked" || result.allProvidersFailed === true;
  let availability: QcArtifactAvailability = "available";
  if (failedRun && auditArtifactPaths.some((p) => !existsSync(p))) {
    availability = "unavailable";
  }

  const pointer: QcRunPointer = {
    artifact_path: toRel(artifactPath),
    status: result.status,
    provider: result.provider,
    started_at: result.startedAt,
    completed_at: result.completedAt,
    availability,
    raw_artifact_paths: rawArtifactPaths.length > 0 ? rawArtifactPaths : undefined,
    provider_attempt_artifact_path: providerAttemptRawPath,
  };

  const normalizedQcRuns: Record<string, QcRunPointer> = {};
  for (const [runId, existing] of Object.entries(currentState.qc_runs ?? {})) {
    normalizedQcRuns[runId] = {
      ...existing,
      artifact_path: toRel(existing.artifact_path),
      raw_artifact_paths: existing.raw_artifact_paths
        ? existing.raw_artifact_paths.map(toRel)
        : undefined,
      provider_attempt_artifact_path: existing.provider_attempt_artifact_path
        ? toRel(existing.provider_attempt_artifact_path)
        : undefined,
    };
  }
  normalizedQcRuns[result.qcRunId] = pointer;

  const nextState: ClusterState = {
    ...currentState,
    state_generation: currentState.state_generation + 1,
    qc_runs: normalizedQcRuns,
  };

  await writeClusterState(clusterId, nextState, repoRoot);
  return { artifactPath, state: nextState };
};

export interface PruneQcRunPointersResult {
  state: ClusterState;
  pruned: string[];
  warnings: string[];
}

/**
 * Remove QC run pointers whose primary artifacts are missing and mark
 * pointers with missing raw audit artifacts as unavailable. Returns a new
 * state object; callers must persist the result if they want the cleanup to
 * be durable.
 */
export function pruneMissingQcRunPointers(
  state: ClusterState,
  repoRoot?: string,
): PruneQcRunPointersResult {
  const root = repoRoot || process.cwd();
  const warnings: string[] = [];
  const pruned: string[] = [];
  if (!state.qc_runs) {
    return { state, pruned, warnings };
  }

  const validation = validateQcArtifactPointers(state.qc_runs, root);
  if (validation.ok && validation.unavailable.length === 0) {
    return { state, pruned, warnings };
  }

  const nextQcRuns: Record<string, QcRunPointer> = {};
  for (const [runId, pointer] of Object.entries(state.qc_runs)) {
    if (validation.missing.includes(path.resolve(root, pointer.artifact_path))) {
      pruned.push(runId);
      warnings.push(
        `QC run ${runId} pointer pruned: artifact missing ${pointer.artifact_path}`,
      );
      continue;
    }

    const updated: QcRunPointer = { ...pointer };
    const hasMissingRaw =
      (pointer.raw_artifact_paths ?? []).some((p) =>
        validation.unavailable.includes(path.resolve(root, p))
      ) ||
      (pointer.provider_attempt_artifact_path &&
        validation.unavailable.includes(path.resolve(root, pointer.provider_attempt_artifact_path)));
    if (hasMissingRaw && updated.availability === "available") {
      updated.availability = "unavailable";
      warnings.push(
        `QC run ${runId} raw audit artifacts missing; marked unavailable`,
      );
    }
    nextQcRuns[runId] = updated;
  }

  return {
    state: {
      ...state,
      qc_runs: nextQcRuns,
    },
    pruned,
    warnings,
  };
}
