
/**
 * @file This module defines interfaces and types for tracker synchronization and reconciliation.
 */

import { LocalGraph } from '../local-graph.js';
import { loadMutationQueue, saveMutationQueue } from './queue-store.js';

/**
 * Represents a record of a mutation operation to be applied to a tracker.
 * This includes an idempotency key to prevent duplicate operations.
 */
export interface MutationRecord {
  id: string; // Unique ID for this mutation record
  operationId: string; // Idempotency key for the tracker operation
  type: 'create' | 'update' | 'delete' | 'link' | 'comment'; // Type of mutation
  entityType: string; // e.g., 'issue', 'comment', 'project'
  entityId: string; // ID of the entity being mutated (local ID)
  payload: Record<string, any>; // The data to be sent to the tracker
  status: 'pending' | 'sent' | 'succeeded' | 'failed' | 'conflicted';
  timestamp: string; // ISO date string
  retries: number;
  error?: string;
  remoteId?: string; // ID assigned by the remote tracker after creation
}

/**
 * Input parameters for the tracker sync-in process.
 */
export interface TrackerSyncInput {
  trackerId: string; // Identifier for the specific tracker
  lastSyncTimestamp?: string; // Optional: last successful sync time for incremental sync
  dryRun?: boolean; // If true, performs a dry run without actual changes
}

/**
 * Represents the outcome of a reconciliation process.
 */
export interface ReconciliationReport {
  syncedInCount: number;
  mutationsQueuedCount: number;
  mutationsAppliedCount: number;
  conflictsDetectedCount: number;
  failedMutationsCount: number;
  details: string[]; // Human-readable summary of actions and conflicts
}

/**
 * Abstract interface for interacting with a remote tracker system.
 * This adapter will be responsible for fetching data and applying mutations.
 * Concrete implementations (e.g., LinearAdapter) will implement this.
 */
export interface TrackerAdapter {
  /**
   * Fetches data from the tracker based on the provided input.
   * @param input - The sync input parameters.
   * @returns A promise resolving to the fetched data (e.g., issues, projects).
   */
  fetchData(input: TrackerSyncInput): Promise<any>;

  /**
   * Applies a mutation record to the remote tracker.
   * @param mutation - The mutation record to apply.
   * @returns A promise resolving to the updated mutation record,
   *          including any remote IDs or updated status.
   */
  applyMutation(mutation: MutationRecord): Promise<MutationRecord>;

  /**
   * Compares local state with remote state to detect conflicts.
   * @param localEntity - The local representation of an entity.
   * @param remoteEntity - The remote representation of the same entity.
   * @returns True if a conflict is detected, false otherwise.
   */
  detectConflict(localEntity: any, remoteEntity: any): boolean;

  /**
   * Generates a remote fingerprint for a given entity.
   * This fingerprint can be used for quick comparison to detect changes.
   * @param entity - The entity to generate a fingerprint for.
   * @returns A string representing the remote fingerprint.
   */
  generateRemoteFingerprint(entity: any): string;
}

/**
 * Service for managing tracker synchronization and reconciliation.
 */
export class TrackerSyncService {
  private adapter: TrackerAdapter;
  private mutationQueue: MutationRecord[] = [];
  private localGraphRef: LocalGraph;
  /** Resolves when the persisted mutation queue has been loaded. Await before any mutation. */
  readonly ready: Promise<void>;

  constructor(adapter: TrackerAdapter, localGraph: LocalGraph) {
    this.adapter = adapter;
    this.localGraphRef = localGraph;
    this.ready = this.loadQueue();
  }

  private async loadQueue() {
    this.mutationQueue = await loadMutationQueue();
    console.log(`Loaded ${this.mutationQueue.length} mutations from queue store.`);
  }

  private async saveQueue() {
    await saveMutationQueue(this.mutationQueue);
    console.log(`Saved ${this.mutationQueue.length} mutations to queue store.`);
  }

  /**
   * Performs a sync-in operation, fetching data from the tracker
   * and updating the local graph and sidecars.
   */
  async syncIn(input: TrackerSyncInput): Promise<ReconciliationReport> {
    console.log(`Starting sync-in for tracker: ${input.trackerId}`);
    const fetchedData = await this.adapter.fetchData(input);
    let syncedInCount = 0;

    // TODO: Implement actual processing of fetchedData to update localGraph and sidecars.
    // This will likely involve a dedicated local graph manager or direct file writes.
    if (fetchedData && fetchedData.length > 0) {
      syncedInCount = fetchedData.length;
      console.log(`Synced in ${syncedInCount} items.`);
      // Example placeholder: await this.localGraphManager.update(fetchedData);
    }

    // After sync-in, we might also want to trigger a reconciliation for any pending mutations
    // that might have been affected by the incoming sync.
    // However, for now, we'll keep sync-in and reconcile as separate explicit steps.

    return {
      syncedInCount,
      mutationsQueuedCount: this.mutationQueue.length,
      mutationsAppliedCount: 0,
      conflictsDetectedCount: 0,
      failedMutationsCount: 0,
      details: [`Sync-in completed. ${syncedInCount} items processed.`],
    };
  }

  /**
   * Adds a mutation to the queue.
   */
  async addMutation(mutation: Omit<MutationRecord, 'id' | 'status' | 'timestamp' | 'retries'>): Promise<void> {
    await this.ready;
    const newMutation: MutationRecord = {
      ...mutation,
      id: `mut-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // Unique ID
      status: 'pending',
      timestamp: new Date().toISOString(),
      retries: 0,
    };
    this.mutationQueue.push(newMutation);
    await this.saveQueue(); // Persist the updated queue
    console.log(`Mutation added to queue: ${newMutation.id}`);
  }

  /**
   * Processes the mutation queue and applies changes to the remote tracker.
   * Handles idempotency, retries, and conflict detection.
   */
  async reconcile(dryRun: boolean = false): Promise<ReconciliationReport> {
    await this.ready;
    console.log(`Starting reconciliation (dryRun: ${dryRun})`);
    let mutationsAppliedCount = 0;
    let conflictsDetectedCount = 0;
    let failedMutationsCount = 0;
    const details: string[] = [];

    // Filter for pending or failed mutations to retry
    const mutationsToProcess = this.mutationQueue.filter(
      (m) => m.status === 'pending' || m.status === 'failed'
    );

    for (const mutation of mutationsToProcess) {
      if (dryRun) {
        details.push(`Dry run: Would apply mutation ${mutation.id} (${mutation.type} ${mutation.entityType}:${mutation.entityId})`);
        continue;
      }

      try {
        const localEntity = this.localGraphRef.getNode(mutation.entityId);

        if (localEntity) {
          const remoteEntity = await this.adapter.fetchData({
            trackerId: mutation.entityId,
          });

          if (remoteEntity && this.adapter.detectConflict(localEntity, remoteEntity)) {
            mutation.status = 'conflicted';
            conflictsDetectedCount++;
            details.push(`Conflict detected for mutation ${mutation.id}. Remote entity changed.`);
            console.warn(`Conflict detected for mutation ${mutation.id}`);
            continue;
          }
        }

        mutation.status = 'sent';
        const updatedMutation = await this.adapter.applyMutation(mutation);
        Object.assign(mutation, updatedMutation); // Update status, remoteId, etc.

        const finalStatus = (mutation as MutationRecord).status;
        if (finalStatus === 'succeeded') {
          mutationsAppliedCount++;
          details.push(`Successfully applied mutation ${mutation.id}`);
          console.log(`Successfully applied mutation ${mutation.id}`);
        } else {
          failedMutationsCount++;
          details.push(`Failed to apply mutation ${mutation.id}: ${mutation.error}`);
          console.error(`Failed to apply mutation ${mutation.id}: ${mutation.error}`);
        }

      } catch (error: any) {
        mutation.retries++;
        mutation.error = error.message;
        mutation.status = 'failed';
        failedMutationsCount++;
        details.push(`Error applying mutation ${mutation.id} (retry ${mutation.retries}): ${error.message}`);
        console.error(`Error applying mutation ${mutation.id}:`, error);
        // TODO: Implement exponential backoff for retries
      }
    }

    await this.saveQueue(); // Persist the updated queue state

    const report: ReconciliationReport = {
      syncedInCount: 0,
      mutationsQueuedCount: this.mutationQueue.filter(m => m.status === 'pending' || m.status === 'failed').length,
      mutationsAppliedCount,
      conflictsDetectedCount,
      failedMutationsCount,
      details,
    };

    console.log(`Reconciliation completed. Applied: ${mutationsAppliedCount}, Conflicts: ${conflictsDetectedCount}, Failed: ${failedMutationsCount}`);
    return report;
  }

  /**
   * Returns the current state of the mutation queue.
   */
  getMutationQueue(): MutationRecord[] {
    return this.mutationQueue;
  }
}


