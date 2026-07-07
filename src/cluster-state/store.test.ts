import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { readClusterState, writeClusterState, initializeClusterState, pruneExpiredClaims } from './store';
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
        tracker_mutations: {},
        blockers: [],
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockState));

      const state = await readClusterState(MOCK_CLUSTER_ID);
      expect(state).toEqual(mockState);
      expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('cluster-state.json'), 'utf-8');
    });

    it('should return null if the file does not exist', async () => {
      const error = new Error('ENOENT: no such file or directory');
      (error as any).code = 'ENOENT';
      vi.mocked(fs.readFile).mockRejectedValue(error);

      const state = await readClusterState(MOCK_CLUSTER_ID);
      expect(state).toBeNull();
    });

    it('should re-throw other errors', async () => {
      const error = new Error('Read error');
      vi.mocked(fs.readFile).mockRejectedValue(error);
      await expect(readClusterState(MOCK_CLUSTER_ID)).rejects.toThrow('Read error');
    });

    describe('pruneExpiredClaims', () => {
      it('removes expired claims and recovers dispatched children to ready', () => {
        const now = new Date('2026-07-07T10:00:00.000Z');
        const state: ClusterState = {
          schema_version: '1.0',
          cluster_id: MOCK_CLUSTER_ID,
          state_generation: 7,
          child_states: [
            { id: 'POL-401', status: 'dispatched' },
            { id: 'POL-402', status: 'done' },
          ],
          claim_metadata: {
            'POL-401': {
              worker_id: 'worker-401',
              claimed_at: '2026-07-07T09:00:00.000Z',
              expires_at: '2026-07-07T09:30:00.000Z',
            },
            'POL-402': {
              worker_id: 'worker-402',
              claimed_at: '2026-07-07T09:59:00.000Z',
              expires_at: '2026-07-07T10:30:00.000Z',
            },
          },
          packet_pointers: {},
          result_pointers: {},
          validation_results: {},
          commits: {},
          tracker_mutations: {},
          blockers: [],
        };

        const result = pruneExpiredClaims(state, now);
        expect(result.expiredChildIds).toEqual(['POL-401']);
        expect(result.state.state_generation).toBe(8);
        expect(result.state.claim_metadata['POL-401']).toBeUndefined();
        expect(result.state.claim_metadata['POL-402']).toBeDefined();
        expect(result.state.child_states.find((child) => child.id === 'POL-401')?.status).toBe('ready');
        expect(result.state.child_states.find((child) => child.id === 'POL-402')?.status).toBe('done');
      });
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
        tracker_mutations: {},
        blockers: [],
      };

      // Mock existing state as null (cast required — real readFile never returns null, but mock does)
      vi.mocked(fs.readFile).mockResolvedValueOnce(null as unknown as string);

      await writeClusterState(MOCK_CLUSTER_ID, newState);

      const filePath = path.join(process.cwd(), '.polaris', 'clusters', MOCK_CLUSTER_ID, 'cluster-state.json');
      expect(fs.writeFile).toHaveBeenNthCalledWith(1, filePath + '.lock', expect.any(String), { flag: 'wx' });
      expect(fs.writeFile).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(filePath + '.tmp.'),
        JSON.stringify(newState, null, 2),
      );
      expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(filePath + '.tmp.'), filePath);
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
        tracker_mutations: {},
        blockers: [],
      };
      const newState: ClusterState = { ...existingState, state_generation: 2 };
      
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingState));

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
      vi.mocked(fs.readFile).mockRejectedValue(error);
      
      vi.spyOn(fs, 'writeFile');

      const initialState = await initializeClusterState(MOCK_CLUSTER_ID);

      expect(LocalGraph.load).toHaveBeenCalledWith(MOCK_CLUSTER_ID, undefined);
      expect(initialState.cluster_id).toBe(MOCK_CLUSTER_ID);
      expect(initialState.state_generation).toBe(1);
      expect(initialState.child_states).toHaveLength(2);
      expect(initialState.child_states[0]).toEqual({ id: 'CHILD-1', status: 'ready' });
      expect(initialState.child_states[1]).toEqual({ id: 'CHILD-2', status: 'ready' });
      
      expect(fs.writeFile).toHaveBeenCalled();
    });
  });
});
