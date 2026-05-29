import { promises as fs } from 'fs';
import * as path from 'path';
import { ClusterState, ChildState } from './types';
import { LocalGraph } from '../tracker/local-graph';

const getClusterStatePath = (clusterId: string): string => {
  return path.join(process.cwd(), '.polaris', 'clusters', clusterId, 'cluster-state.json');
};

export const readClusterState = async (clusterId: string): Promise<ClusterState | null> => {
  const filePath = getClusterStatePath(clusterId);
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

export const writeClusterState = async (clusterId: string, state: ClusterState): Promise<void> => {
  const filePath = getClusterStatePath(clusterId);
  const tempFilePath = filePath + '.tmp';

  const currentState = await readClusterState(clusterId);

  if (currentState && currentState.state_generation >= state.state_generation) {
    throw new Error('Stale state: state_generation is not greater than current state.');
  }

  await fs.writeFile(tempFilePath, JSON.stringify(state, null, 2));
  await fs.rename(tempFilePath, filePath);
};

export const initializeClusterState = async (clusterId: string): Promise<ClusterState> => {
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

  await writeClusterState(clusterId, initialState);
  return initialState;
};
