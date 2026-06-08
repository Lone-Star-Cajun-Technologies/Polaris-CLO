import { createHash, randomUUID } from 'node:crypto';
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  readClusterState,
  writeClusterState,
} from "../../cluster-state/store.js";
import type {
  ClusterState,
  TrackerMutationReference,
  TrackerMutationStatus,
} from "../../cluster-state/types.js";
import { LocalGraph } from "../local-graph.js";
import { loadMutationQueue, saveMutationQueue } from "./queue-store.js";
import { resolveLifecycleTransition, type TrackerLifecyclePolicy } from "../lifecycle-policy.js";

export interface MutationEvidence {
  runId: string;
  clusterId: string;
  childId: string;
  packetFile: string;
  resultFile: string;
  sourceStateGeneration: number;
  commit: string;
  validatedAt: string;
}

/**
 * Represents a record of a mutation operation to be applied to a tracker.
 * This includes an idempotency key to prevent duplicate operations.
 */
export interface MutationRecord {
  id: string;
  operationId: string;
  type: 'create' | 'update' | 'delete' | 'link' | 'comment';
  entityType: string;
  entityId: string;
  payload: Record<string, any>;
  status: TrackerMutationStatus | 'sent';
  timestamp: string;
  retries: number;
  error?: string;
  remoteId?: string;
  evidence?: MutationEvidence;
}

export interface TrackerSyncInput {
  trackerId: string;
  lastSyncTimestamp?: string;
  dryRun?: boolean;
}

export interface ReconciliationReport {
  syncedInCount: number;
  mutationsQueuedCount: number;
  mutationsAppliedCount: number;
  conflictsDetectedCount: number;
  failedMutationsCount: number;
  details: string[];
}

export interface TrackerAdapter {
  fetchData(input: TrackerSyncInput): Promise<any>;
  applyMutation(mutation: MutationRecord): Promise<MutationRecord>;
  detectConflict(localEntity: any, remoteEntity: any): boolean;
  generateRemoteFingerprint(entity: any): string;
}

interface TrackerSyncServiceOptions {
  repoRoot?: string;
  clusterId?: string;
  queueFilePath?: string;
  lifecyclePolicy?: TrackerLifecyclePolicy;
}

interface PreparedQueueResult {
  preparedCount: number;
  failureCount: number;
  details: string[];
}

interface ValidatedCompletionEvidence {
  runId: string;
  packetFile: string;
  resultFile: string;
  commit: string;
  sourceStateGeneration: number;
  validatedAt: string;
}

interface SealedWorkerResult {
  run_id?: string;
  child_id?: string;
  status?: string;
  commit?: string;
  validation?: unknown;
}

interface WorkerPacketShape {
  run_id?: string;
  cluster_id?: string;
  active_child?: string;
}

export class TrackerSyncService {
  private adapter: TrackerAdapter;
  private mutationQueue: MutationRecord[] = [];
  private localGraphRef: LocalGraph;
  private readonly repoRoot: string;
  private readonly clusterId?: string;
  private readonly queueFilePath: string;
  private readonly lifecyclePolicy?: TrackerLifecyclePolicy;
  readonly ready: Promise<void>;

  constructor(adapter: TrackerAdapter, localGraph: LocalGraph, options: TrackerSyncServiceOptions = {}) {
    this.adapter = adapter;
    this.localGraphRef = localGraph;
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.clusterId = options.clusterId;
    this.queueFilePath = options.queueFilePath ?? path.join(this.repoRoot, ".taskchain_artifacts", "polaris-run", "mutation-queue.json");
    this.lifecyclePolicy = options.lifecyclePolicy;
    this.ready = this.loadQueue();
  }

  private async loadQueue(): Promise<void> {
    this.mutationQueue = await loadMutationQueue(this.queueFilePath);
    console.log(`Loaded ${this.mutationQueue.length} mutations from queue store.`);
  }

  private async saveQueue(): Promise<void> {
    await saveMutationQueue(this.mutationQueue, this.queueFilePath);
    console.log(`Saved ${this.mutationQueue.length} mutations to queue store.`);
  }

  async syncIn(input: TrackerSyncInput): Promise<ReconciliationReport> {
    console.log(`Starting sync-in for tracker: ${input.trackerId}`);
    const fetchedData = await this.adapter.fetchData(input);
    let syncedInCount = 0;

    if (Array.isArray(fetchedData) && fetchedData.length > 0) {
      syncedInCount = fetchedData.length;
      console.log(`Synced in ${syncedInCount} items.`);
    }

    return {
      syncedInCount,
      mutationsQueuedCount: this.mutationQueue.length,
      mutationsAppliedCount: 0,
      conflictsDetectedCount: 0,
      failedMutationsCount: 0,
      details: [`Sync-in completed. ${syncedInCount} items processed.`],
    };
  }

  async addMutation(mutation: Omit<MutationRecord, 'id' | 'status' | 'timestamp' | 'retries'>): Promise<void> {
    await this.ready;
    const newMutation: MutationRecord = {
      ...mutation,
      id: randomUUID(),
      status: 'pending',
      timestamp: new Date().toISOString(),
      retries: 0,
    };
    this.mutationQueue.push(newMutation);
    await this.saveQueue();
    console.log(`Mutation added to queue: ${newMutation.id}`);
  }

  async reconcile(dryRun = false): Promise<ReconciliationReport> {
    await this.ready;
    console.log(`Starting reconciliation (dryRun: ${dryRun})`);

    const prepared = await this.prepareValidatedQueue(dryRun);
    let mutationsAppliedCount = 0;
    let conflictsDetectedCount = 0;
    let failedMutationsCount = prepared.failureCount;
    const details = [...prepared.details];

    const mutationsToProcess = this.mutationQueue.filter((mutation) =>
      mutation.status === 'pending' || mutation.status === 'failed',
    );

    for (const mutation of mutationsToProcess) {
      if (dryRun) {
        details.push(
          `Dry run: Would apply mutation ${mutation.id} (${mutation.type} ${mutation.entityType}:${mutation.entityId})`,
        );
        continue;
      }

      try {
        const localEntity = this.localGraphRef.getNode(mutation.entityId);
        if (localEntity) {
          const remoteEntity = await this.adapter.fetchData({ trackerId: mutation.entityId });
          if (remoteEntity && this.adapter.detectConflict(localEntity, remoteEntity)) {
            mutation.status = 'conflicted';
            conflictsDetectedCount++;
            mutation.error = 'Remote tracker entity changed since local validation.';
            await this.syncClusterMutationStatus(mutation, 'conflicted', mutation.error);
            details.push(`Conflict detected for mutation ${mutation.id}. Remote entity changed.`);
            continue;
          }
        }

        mutation.status = 'sent';
        await this.syncClusterMutationStatus(mutation, 'sent');
        const updatedMutation = await this.adapter.applyMutation(mutation);
        Object.assign(mutation, updatedMutation);

        if (updatedMutation.status === 'succeeded') {
          mutationsAppliedCount++;
          await this.syncClusterMutationStatus(mutation, 'succeeded');
          details.push(`Successfully applied mutation ${mutation.id}`);
        } else {
          mutation.status = updatedMutation.status === 'conflicted' ? 'conflicted' : 'failed';
          mutation.error = updatedMutation.error;
          failedMutationsCount++;
          await this.syncClusterMutationStatus(mutation, mutation.status, mutation.error);
          details.push(`Failed to apply mutation ${mutation.id}: ${mutation.error ?? 'Unknown error'}`);
        }
      } catch (error) {
        mutation.retries += 1;
        mutation.error = error instanceof Error ? error.message : String(error);
        mutation.status = 'failed';
        failedMutationsCount++;
        await this.syncClusterMutationStatus(mutation, 'failed', mutation.error);
        details.push(`Error applying mutation ${mutation.id} (retry ${mutation.retries}): ${mutation.error}`);
      }
    }

    await this.saveQueue();

    const report: ReconciliationReport = {
      syncedInCount: 0,
      mutationsQueuedCount: this.mutationQueue.filter(
        (mutation) => mutation.status === 'pending' || mutation.status === 'failed',
      ).length,
      mutationsAppliedCount,
      conflictsDetectedCount,
      failedMutationsCount,
      details,
    };

    console.log(
      `Reconciliation completed. Applied: ${mutationsAppliedCount}, Conflicts: ${conflictsDetectedCount}, Failed: ${failedMutationsCount}`,
    );
    return report;
  }

  getMutationQueue(): MutationRecord[] {
    return this.mutationQueue;
  }

  private async prepareValidatedQueue(dryRun: boolean): Promise<PreparedQueueResult> {
    if (!this.clusterId) {
      return { preparedCount: 0, failureCount: 0, details: [] };
    }

    const clusterState = await readClusterState(this.clusterId, this.repoRoot);
    if (!clusterState) {
      return {
        preparedCount: 0,
        failureCount: 1,
        details: [`Cluster state for ${this.clusterId} is missing; cannot prepare tracker reconciliation.`],
      };
    }

    const nextQueue = [...this.mutationQueue];
    const trackerMutations = { ...(clusterState.tracker_mutations ?? {}) };
    const preparedDetails: string[] = [];
    let preparedCount = 0;
    let failureCount = 0;
    let changed = false;
    const sourceGeneration = clusterState.state_generation;

    for (const childState of clusterState.child_states) {
      if (childState.status !== 'done') {
        continue;
      }

      const existingRef = trackerMutations[childState.id];
      if (existingRef?.status === 'succeeded') {
        continue;
      }

      const evidence = await this.validateCompletionEvidence(clusterState, childState.id);
      if (!evidence.valid) {
        failureCount += 1;
        preparedDetails.push(`Skipped ${childState.id}: ${evidence.reason}`);
        const blockedRef = this.buildTrackerReference({
          existing: existingRef,
          childId: childState.id,
          idempotencyKey: existingRef?.idempotency_key ?? `blocked:${childState.id}`,
          mutationIds: existingRef?.mutation_ids ?? [],
          status: 'blocked',
          resultFile: clusterState.result_pointers[childState.id] ?? '',
          packetFile: clusterState.packet_pointers[childState.id],
          commit: clusterState.commits[childState.id],
          sourceStateGeneration: sourceGeneration,
          error: evidence.reason,
        });
        if (!this.sameTrackerReference(existingRef, blockedRef)) {
          trackerMutations[childState.id] = blockedRef;
          changed = true;
        }
        continue;
      }

      const idempotencyKey = this.buildIdempotencyKey(evidence.value);
      const existingQueueMutation = nextQueue.find((mutation) => mutation.operationId === idempotencyKey);
      if (existingRef?.idempotency_key === idempotencyKey && existingQueueMutation) {
        trackerMutations[childState.id] = this.buildTrackerReference({
          existing: existingRef,
          childId: childState.id,
          idempotencyKey,
          mutationIds: [existingQueueMutation.id],
          status: this.normalizeMutationStatus(existingQueueMutation.status),
          resultFile: evidence.value.resultFile,
          packetFile: evidence.value.packetFile,
          commit: evidence.value.commit,
          sourceStateGeneration: evidence.value.sourceStateGeneration,
          error: existingQueueMutation.error,
        });
        continue;
      }

      let queuedMutation: MutationRecord | undefined = existingQueueMutation;
      if (!queuedMutation) {
        // Resolve the lifecycle state from policy for validation-passed children
        const lifecycleTransition = resolveLifecycleTransition("child-validation-passed", this.lifecyclePolicy);

        // Skip creating a mutation if the policy says to skip or target is no_status_change
        if (lifecycleTransition.skip || lifecycleTransition.targetState === "no_status_change") {
          continue;
        }

        const targetState = lifecycleTransition.targetState;

        const newMutation: MutationRecord = {
          id: randomUUID(),
          operationId: idempotencyKey,
          type: "update",
          entityType: "issue",
          entityId: childState.id,
          payload: {
            state: targetState,
          },
          status: "pending",
          timestamp: new Date().toISOString(),
          retries: 0,
          evidence: {
            ...evidence.value,
            clusterId: this.clusterId,
            childId: childState.id,
          },
        };
        nextQueue.push(newMutation);
        queuedMutation = newMutation;
        preparedCount += 1;
        changed = true;
        preparedDetails.push(
          `Queued validated tracker mutation for ${childState.id} (target state: ${targetState}).`
        );
      }

      if (!queuedMutation) {
        continue;
      }

      const pendingRef = this.buildTrackerReference({
        existing: existingRef,
        childId: childState.id,
        idempotencyKey,
        mutationIds: [queuedMutation.id],
        status: this.normalizeMutationStatus(queuedMutation.status),
        resultFile: evidence.value.resultFile,
        packetFile: evidence.value.packetFile,
        commit: evidence.value.commit,
        sourceStateGeneration: evidence.value.sourceStateGeneration,
        error: queuedMutation.error,
      });
      if (!this.sameTrackerReference(existingRef, pendingRef)) {
        trackerMutations[childState.id] = pendingRef;
        changed = true;
      }
    }

    if (!dryRun && changed) {
      this.mutationQueue = nextQueue;
      await this.saveQueue();
      await writeClusterState(
        this.clusterId,
        {
          ...clusterState,
          state_generation: clusterState.state_generation + 1,
          tracker_mutations: trackerMutations,
        },
        this.repoRoot,
      );
    }

    return { preparedCount, failureCount, details: preparedDetails };
  }

  private async validateCompletionEvidence(
    clusterState: ClusterState,
    childId: string,
  ): Promise<{ valid: true; value: ValidatedCompletionEvidence } | { valid: false; reason: string }> {
    const packetFile = clusterState.packet_pointers[childId];
    if (!packetFile) {
      return { valid: false, reason: 'missing packet pointer' };
    }

    const resultFile = clusterState.result_pointers[childId];
    if (!resultFile) {
      return { valid: false, reason: 'missing sealed result pointer' };
    }

    const validation = clusterState.validation_results[childId];
    if (!validation?.passed) {
      return { valid: false, reason: 'validation result is missing or failed' };
    }

    const commit = clusterState.commits[childId];
    if (!commit) {
      return { valid: false, reason: 'missing commit evidence' };
    }

    let packet: WorkerPacketShape;
    let result: SealedWorkerResult;
    try {
      packet = JSON.parse(await readFile(packetFile, 'utf-8')) as WorkerPacketShape;
    } catch (error) {
      return {
        valid: false,
        reason: `unable to read packet file (${error instanceof Error ? error.message : String(error)})`,
      };
    }

    try {
      result = JSON.parse(await readFile(resultFile, 'utf-8')) as SealedWorkerResult;
    } catch (error) {
      return {
        valid: false,
        reason: `unable to read result file (${error instanceof Error ? error.message : String(error)})`,
      };
    }

    if (packet.cluster_id !== this.clusterId || packet.active_child !== childId || !packet.run_id) {
      return { valid: false, reason: 'packet metadata does not match the active cluster child' };
    }

    if (result.run_id !== packet.run_id || result.child_id !== childId) {
      return { valid: false, reason: 'sealed result does not match packet run/child identifiers' };
    }

    if (result.status !== 'success') {
      return { valid: false, reason: `sealed result status is ${result.status ?? 'missing'}` };
    }

    if (!result.commit || result.commit !== commit) {
      return { valid: false, reason: 'sealed result commit does not match cluster-state commit evidence' };
    }

    return {
      valid: true,
      value: {
        runId: packet.run_id,
        packetFile,
        resultFile,
        commit,
        sourceStateGeneration: clusterState.state_generation,
        validatedAt: new Date().toISOString(),
      },
    };
  }

  private buildIdempotencyKey(evidence: ValidatedCompletionEvidence): string {
    return createHash('sha256')
      .update([
        this.clusterId ?? '',
        evidence.runId,
        evidence.resultFile,
        evidence.commit,
      ].join(':'))
      .digest('hex');
  }

  private async syncClusterMutationStatus(
    mutation: MutationRecord,
    status: TrackerMutationStatus,
    error?: string,
  ): Promise<void> {
    if (!this.clusterId || !mutation.evidence) {
      return;
    }

    const clusterState = await readClusterState(this.clusterId, this.repoRoot);
    if (!clusterState) {
      return;
    }

    const existing = clusterState.tracker_mutations[mutation.entityId];
    const next = this.buildTrackerReference({
      existing,
      childId: mutation.entityId,
      idempotencyKey: mutation.operationId,
      mutationIds: [mutation.id],
      status,
      resultFile: mutation.evidence.resultFile,
      packetFile: mutation.evidence.packetFile,
      commit: mutation.evidence.commit,
      sourceStateGeneration: mutation.evidence.sourceStateGeneration,
      error,
      attemptedAt: new Date().toISOString(),
    });

    if (this.sameTrackerReference(existing, next)) {
      return;
    }

    await writeClusterState(
      this.clusterId,
      {
        ...clusterState,
        state_generation: clusterState.state_generation + 1,
        tracker_mutations: {
          ...clusterState.tracker_mutations,
          [mutation.entityId]: next,
        },
      },
      this.repoRoot,
    );
  }

  private buildTrackerReference(input: {
    existing?: TrackerMutationReference;
    childId: string;
    idempotencyKey: string;
    mutationIds: string[];
    status: TrackerMutationStatus;
    resultFile: string;
    packetFile?: string;
    commit?: string;
    sourceStateGeneration: number;
    error?: string;
    attemptedAt?: string;
  }): TrackerMutationReference {
    const updatedAt = new Date().toISOString();
    return {
      mutation_ids: input.mutationIds,
      idempotency_key: input.idempotencyKey,
      source_state_generation: input.sourceStateGeneration,
      result_file: input.resultFile,
      packet_file: input.packetFile,
      commit: input.commit,
      status: input.status,
      updated_at: updatedAt,
      last_attempted_at: input.attemptedAt ?? input.existing?.last_attempted_at,
      last_error: input.error,
    };
  }

  private normalizeMutationStatus(status: MutationRecord['status']): TrackerMutationStatus {
    if (status === 'sent') {
      return 'sent';
    }
    return status;
  }

  private sameTrackerReference(
    left: TrackerMutationReference | undefined,
    right: TrackerMutationReference,
  ): boolean {
    if (!left) {
      return false;
    }

    const normalize = (value: TrackerMutationReference) => ({
      ...value,
      updated_at: undefined,
    });
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }
}
