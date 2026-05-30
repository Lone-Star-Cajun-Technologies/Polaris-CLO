import { promises as fs } from 'fs';
import * as path from 'path';
import { ClusterState, ChildState } from './types';
import { LocalGraph } from '../tracker/local-graph';

const getClusterStatePath = (clusterId: string, repoRoot?: string): string => {
  return path.join(repoRoot || process.cwd(), '.polaris', 'clusters', clusterId, 'cluster-state.json');
};

export const readClusterState = async (clusterId: string, repoRoot?: string): Promise<ClusterState | null> => {
  const filePath = getClusterStatePath(clusterId, repoRoot);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data) as ClusterState;
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

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Try to create lock file exclusively (fails if it already exists)
      await fs.writeFile(lockFilePath, String(process.pid), { flag: 'wx' });
      lockAcquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock file exists, wait and retry
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

export const initializeClusterState = async (clusterId: string, repoRoot?: string): Promise<ClusterState> => {
  const graph = await LocalGraph.load(clusterId);
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
    blockers: [],
  };

  await writeClusterState(clusterId, initialState, repoRoot);
  return initialState;
};
