import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLoopBootstrapInit } from './run-bootstrap';
import * as clusterStateStore from '../cluster-state/store';
import type { ClusterState } from '../cluster-state/types';
import { existsSync, writeFileSync } from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
  },
}));

vi.mock('../cluster-state/store', () => ({
  readClusterState: vi.fn(),
  initializeClusterState: vi.fn(),
}));

describe('runLoopBootstrapInit', () => {
  const mockOptions = {
    clusterId: 'POL-TEST-1',
    openChildren: ['CHILD-1'],
    stateFile: '/fake/path/current-state.json',
    repoRoot: '/fake/repo',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // Mock process.stdout.write to suppress console output in tests
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('should call initializeClusterState if no existing state is found', async () => {
    vi.mocked(clusterStateStore.readClusterState).mockResolvedValue(null);
    vi.mocked(existsSync).mockReturnValue(false);

    await runLoopBootstrapInit(mockOptions);

    expect(clusterStateStore.readClusterState).toHaveBeenCalledWith('POL-TEST-1', '/fake/repo');
    expect(clusterStateStore.initializeClusterState).toHaveBeenCalledWith('POL-TEST-1', '/fake/repo');
  });

  it('should not call initializeClusterState if state already exists', async () => {
    vi.mocked(clusterStateStore.readClusterState).mockResolvedValue({ cluster_id: 'POL-TEST-1' } as unknown as ClusterState);
    vi.mocked(existsSync).mockReturnValue(false);

    await runLoopBootstrapInit(mockOptions);

    expect(clusterStateStore.readClusterState).toHaveBeenCalledWith('POL-TEST-1', '/fake/repo');
    expect(clusterStateStore.initializeClusterState).not.toHaveBeenCalled();
  });

  it('should continue bootstrap even if initializeClusterState fails', async () => {
    vi.mocked(clusterStateStore.readClusterState).mockResolvedValue(null);
    vi.mocked(clusterStateStore.initializeClusterState).mockRejectedValue(new Error('Init failed'));
    vi.mocked(existsSync).mockReturnValue(false);

    await runLoopBootstrapInit(mockOptions);

    expect(writeFileSync).toHaveBeenCalled(); // Should still try to write the main state file
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('Warning: Failed to initialize cluster-state.json'));
  });
});
