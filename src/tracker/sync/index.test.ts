import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClusterState, writeClusterState } from '../../cluster-state/store.js';
import { LocalGraph } from '../local-graph.js';
import { TrackerSyncService, type TrackerAdapter, type MutationRecord } from './index.js';
import { loadMutationQueue } from './queue-store.js';

const scratchRoots: string[] = [];

function makeRepoRoot(name: string): string {
  const repoRoot = path.join(
    process.cwd(),
    '.test-scratch',
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(repoRoot, { recursive: true });
  scratchRoots.push(repoRoot);
  return repoRoot;
}

function makeLocalGraph(clusterId: string, childId: string): LocalGraph {
  return LocalGraph.fromGraph({
    schemaVersion: 'v2',
    source: { id: clusterId, type: 'Linear' },
    nodes: {
      [clusterId]: { id: clusterId, title: 'Cluster', status: 'In Progress' },
      [childId]: { id: childId, title: 'Child', status: 'Done', sessionType: 'implement' },
    },
    dependencies: {
      [childId]: [],
    },
    clusters: {
      [clusterId]: { id: clusterId, title: 'Cluster', children: [childId] },
    },
    activeCluster: clusterId,
  });
}

async function seedValidatedCompletion(repoRoot: string, clusterId: string, childId: string) {
  const clusterDir = path.join(repoRoot, '.polaris', 'clusters', clusterId);
  mkdirSync(clusterDir, { recursive: true });

  const packetFile = path.join(clusterDir, `${childId}.packet.json`);
  const resultFile = path.join(clusterDir, `${childId}.result.json`);
  const commit = 'abc123def456';
  const runId = `run-${childId}`;

  writeFileSync(
    packetFile,
    JSON.stringify({ run_id: runId, cluster_id: clusterId, active_child: childId }, null, 2),
    'utf-8',
  );
  writeFileSync(
    resultFile,
    JSON.stringify({ run_id: runId, child_id: childId, status: 'success', commit }, null, 2),
    'utf-8',
  );

  await writeClusterState(
    clusterId,
    {
      schema_version: '1.0',
      cluster_id: clusterId,
      state_generation: 1,
      child_states: [{ id: childId, status: 'done', commit }],
      claim_metadata: {},
      packet_pointers: { [childId]: packetFile },
      result_pointers: { [childId]: resultFile },
      validation_results: { [childId]: { passed: true, output: 'ok' } },
      commits: { [childId]: commit },
      tracker_mutations: {},
      blockers: [],
    },
    repoRoot,
  );

  return { packetFile, resultFile, commit, runId };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repoRoot of scratchRoots.splice(0)) {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe('TrackerSyncService', () => {
  it('queues and applies a tracker mutation only once for validated sealed results', async () => {
    const clusterId = 'POL-201';
    const childId = 'POL-207';
    const repoRoot = makeRepoRoot('tracker-sync-success');
    const queueFilePath = path.join(repoRoot, '.taskchain_artifacts', 'polaris-run', 'mutation-queue.json');
    await seedValidatedCompletion(repoRoot, clusterId, childId);

    const adapter: TrackerAdapter = {
      fetchData: vi.fn().mockResolvedValue(null),
      applyMutation: vi.fn(async (mutation: MutationRecord) => ({
        ...mutation,
        status: 'succeeded',
        remoteId: `remote-${mutation.entityId}`,
      })),
      detectConflict: vi.fn().mockReturnValue(false),
      generateRemoteFingerprint: vi.fn().mockReturnValue('fingerprint'),
    };

    const service = new TrackerSyncService(adapter, makeLocalGraph(clusterId, childId), {
      repoRoot,
      clusterId,
      queueFilePath,
    });

    const firstReport = await service.reconcile();
    expect(firstReport.mutationsAppliedCount).toBe(1);
    expect(firstReport.failedMutationsCount).toBe(0);
    expect(adapter.applyMutation).toHaveBeenCalledTimes(1);

    const queueAfterFirstRun = await loadMutationQueue(queueFilePath);
    expect(queueAfterFirstRun).toHaveLength(1);
    expect(queueAfterFirstRun[0]?.status).toBe('succeeded');

    const clusterState = await readClusterState(clusterId, repoRoot);
    expect(clusterState?.tracker_mutations[childId]?.status).toBe('succeeded');
    expect(clusterState?.tracker_mutations[childId]?.mutation_ids).toEqual([queueAfterFirstRun[0]?.id]);

    const secondReport = await service.reconcile();
    expect(secondReport.mutationsAppliedCount).toBe(0);
    expect(adapter.applyMutation).toHaveBeenCalledTimes(1);
  });

  it('blocks ghost completions that lack sealed result evidence', async () => {
    const clusterId = 'POL-201';
    const childId = 'POL-207';
    const repoRoot = makeRepoRoot('tracker-sync-blocked');
    const queueFilePath = path.join(repoRoot, '.taskchain_artifacts', 'polaris-run', 'mutation-queue.json');
    const { packetFile, commit } = await seedValidatedCompletion(repoRoot, clusterId, childId);

    await writeClusterState(
      clusterId,
      {
        schema_version: '1.0',
        cluster_id: clusterId,
        state_generation: 2,
        child_states: [{ id: childId, status: 'done', commit }],
        claim_metadata: {},
        packet_pointers: { [childId]: packetFile },
        result_pointers: {},
        validation_results: { [childId]: { passed: true, output: 'ok' } },
        commits: { [childId]: commit },
        tracker_mutations: {},
        blockers: [],
      },
      repoRoot,
    );

    const adapter: TrackerAdapter = {
      fetchData: vi.fn().mockResolvedValue(null),
      applyMutation: vi.fn(),
      detectConflict: vi.fn().mockReturnValue(false),
      generateRemoteFingerprint: vi.fn().mockReturnValue('fingerprint'),
    };

    const service = new TrackerSyncService(adapter, makeLocalGraph(clusterId, childId), {
      repoRoot,
      clusterId,
      queueFilePath,
    });

    const report = await service.reconcile();
    expect(report.failedMutationsCount).toBe(1);
    expect(report.details).toContain('Skipped POL-207: missing sealed result pointer');
    expect(adapter.applyMutation).not.toHaveBeenCalled();

    const clusterState = await readClusterState(clusterId, repoRoot);
    expect(clusterState?.tracker_mutations[childId]?.status).toBe('blocked');
  });

  it('records conflicts in cluster-state and keeps the mutation queued for manual resolution', async () => {
    const clusterId = 'POL-201';
    const childId = 'POL-207';
    const repoRoot = makeRepoRoot('tracker-sync-conflict');
    const queueFilePath = path.join(repoRoot, '.taskchain_artifacts', 'polaris-run', 'mutation-queue.json');
    await seedValidatedCompletion(repoRoot, clusterId, childId);

    const adapter: TrackerAdapter = {
      fetchData: vi.fn().mockResolvedValue({ id: childId, state: 'Backlog' }),
      applyMutation: vi.fn(),
      detectConflict: vi.fn().mockReturnValue(true),
      generateRemoteFingerprint: vi.fn().mockReturnValue('fingerprint'),
    };

    const service = new TrackerSyncService(adapter, makeLocalGraph(clusterId, childId), {
      repoRoot,
      clusterId,
      queueFilePath,
    });

    const report = await service.reconcile();
    expect(report.conflictsDetectedCount).toBe(1);
    expect(adapter.applyMutation).not.toHaveBeenCalled();

    const queue = await loadMutationQueue(queueFilePath);
    expect(queue[0]?.status).toBe('conflicted');

    const clusterState = await readClusterState(clusterId, repoRoot);
    expect(clusterState?.tracker_mutations[childId]?.status).toBe('conflicted');
    expect(clusterState?.tracker_mutations[childId]?.last_error).toContain('Remote tracker entity changed');
  });
});
