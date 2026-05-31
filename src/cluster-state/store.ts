import {
  promises as fs,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import * as path from 'path';
import { ClusterState, ChildState } from './types';
import { LocalGraph } from '../tracker/local-graph';

const getClusterStatePath = (clusterId: string, repoRoot?: string): string => {
  return path.join(repoRoot || process.cwd(), '.polaris', 'clusters', clusterId, 'cluster-state.json');
};

const normalizeClusterState = (state: ClusterState): ClusterState => ({
  ...state,
  tracker_mutations: state.tracker_mutations ?? {},
});

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

  const childStates: ChildState[] = activeCluster.children.map(childId => ({
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
  };

  await writeClusterState(clusterId, initialState, repoRoot);
  return initialState;
};
