import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { readClusterState, writeClusterState, initializeClusterState } from './store';
import { ClusterState } from './types';
import { LocalGraph } from '../tracker/local-graph';
import v2Fixture from './fixtures/test-clusters.json';

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
  },
}));

vi.mock('../tracker/local-graph');

const MOCK_CLUSTER_ID = 'POL-TEST-1';

describe('Cluster State Store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('readClusterState', () => {
    it('should read and parse the cluster state file', async () => {
      const mockState: ClusterState = {
        schema_version: '1.0',
        cluster_id: MOCK_CLUSTER_ID,
        state_generation: 1,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        blockers: [],
      };
      (fs.readFile as vi.Mock).mockResolvedValue(JSON.stringify(mockState));

      const state = await readClusterState(MOCK_CLUSTER_ID);
      expect(state).toEqual(mockState);
      expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('cluster-state.json'), 'utf-8');
    });

    it('should return null if the file does not exist', async () => {
      const error = new Error('ENOENT: no such file or directory');
      (error as any).code = 'ENOENT';
      (fs.readFile as vi.Mock).mockRejectedValue(error);

      const state = await readClusterState(MOCK_CLUSTER_ID);
      expect(state).toBeNull();
    });

    it('should re-throw other errors', async () => {
      const error = new Error('Read error');
      (fs.readFile as vi.Mock).mockRejectedValue(error);
      await expect(readClusterState(MOCK_CLUSTER_ID)).rejects.toThrow('Read error');
    });
  });

  describe('writeClusterState', () => {
    it('should write the cluster state atomically', async () => {
      const newState: ClusterState = {
        schema_version: '1.0',
        cluster_id: MOCK_CLUSTER_ID,
        state_generation: 2,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        blockers: [],
      };

      // Mock existing state as null
      (fs.readFile as vi.Mock).mockResolvedValueOnce(null);

      await writeClusterState(MOCK_CLUSTER_ID, newState);

      const filePath = path.join(process.cwd(), '.polaris', 'clusters', MOCK_CLUSTER_ID, 'cluster-state.json');
      expect(fs.writeFile).toHaveBeenCalledWith(filePath + '.tmp', JSON.stringify(newState, null, 2));
      expect(fs.rename).toHaveBeenCalledWith(filePath + '.tmp', filePath);
    });

    it('should throw an error for a stale state generation', async () => {
      const existingState: ClusterState = {
        schema_version: '1.0',
        cluster_id: MOCK_CLUSTER_ID,
        state_generation: 2,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        blockers: [],
      };
      const newState: ClusterState = { ...existingState, state_generation: 2 };
      
      (fs.readFile as vi.Mock).mockResolvedValue(JSON.stringify(existingState));

      await expect(writeClusterState(MOCK_CLUSTER_ID, newState)).rejects.toThrow('Stale state: state_generation is not greater than current state.');
    });
  });

  describe('initializeClusterState', () => {
    it('should initialize state from a LocalGraph', async () => {
      const mockActiveCluster = {
        id: MOCK_CLUSTER_ID,
        title: 'Test Cluster',
        children: ['CHILD-1', 'CHILD-2'],
      };
      const mockGraphInstance = {
        getActiveCluster: vi.fn().mockReturnValue(mockActiveCluster),
      };
      (LocalGraph as any).load.mockResolvedValue(mockGraphInstance);

      // Simulate file not existing for the initial write
      const error = new Error('ENOENT');
      (error as any).code = 'ENOENT';
      (fs.readFile as vi.Mock).mockRejectedValue(error);
      
      vi.spyOn(fs, 'writeFile');

      const initialState = await initializeClusterState(MOCK_CLUSTER_ID);

      expect(LocalGraph.load).toHaveBeenCalledWith(MOCK_CLUSTER_ID);
      expect(initialState.cluster_id).toBe(MOCK_CLUSTER_ID);
      expect(initialState.state_generation).toBe(1);
      expect(initialState.child_states).toHaveLength(2);
      expect(initialState.child_states[0]).toEqual({ id: 'CHILD-1', status: 'ready' });
      expect(initialState.child_states[1]).toEqual({ id: 'CHILD-2', status: 'ready' });
      
      expect(fs.writeFile).toHaveBeenCalled();
    });
  });
});
