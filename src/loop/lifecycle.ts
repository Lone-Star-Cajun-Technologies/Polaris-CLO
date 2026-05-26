/**
 * Worker lifecycle manager for delegated-chain execution.
 *
 * Enforces the one-active-worker policy: by default the parent may have at
 * most one live worker at a time. The parent calls register() immediately
 * before dispatch and release() immediately after the worker returns a result.
 *
 * On session startup the parent should call forceReleaseAll() to recover from
 * any orphaned registrations left by a previous crashed session.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkerRecord {
  worker_id: string;
  /** Child being executed, or null for finalize/preflight workers. */
  child_id: string | null;
  /** Worker role: impl | finalize | preflight | validation. */
  role: string;
  dispatched_at: string;
}

// ── WorkerLifecycleManager ────────────────────────────────────────────────────

export class WorkerLifecycleManager {
  private readonly workers = new Map<string, WorkerRecord>();
  readonly maxConcurrentWorkers: number;

  constructor(maxConcurrentWorkers = 1) {
    if (maxConcurrentWorkers < 1) {
      throw new RangeError(`maxConcurrentWorkers must be >= 1, got ${maxConcurrentWorkers}`);
    }
    this.maxConcurrentWorkers = maxConcurrentWorkers;
  }

  // ── Slot management ─────────────────────────────────────────────────────────

  /** Returns true when a new worker can be dispatched without exceeding the limit. */
  canDispatch(): boolean {
    return this.workers.size < this.maxConcurrentWorkers;
  }

  /**
   * Register a worker before dispatch.
   * Throws `Error` if the active-worker limit would be exceeded.
   */
  register(workerId: string, childId: string | null, role: string): WorkerRecord {
    if (this.workers.has(workerId)) {
      throw new Error(`Worker "${workerId}" is already registered`);
    }
    if (!this.canDispatch()) {
      const active = this.describeActive();
      throw new Error(
        `Cannot dispatch worker "${workerId}": ` +
          `${this.workers.size}/${this.maxConcurrentWorkers} worker slot(s) in use. ` +
          `Active: ${active}. ` +
          `Release the active worker before dispatching a new one.`,
      );
    }
    const record: WorkerRecord = {
      worker_id: workerId,
      child_id: childId,
      role,
      dispatched_at: new Date().toISOString(),
    };
    this.workers.set(workerId, record);
    return record;
  }

  /**
   * Release a worker after it returns.
   * No-op if the worker ID is not registered (idempotent).
   */
  release(workerId: string): void {
    this.workers.delete(workerId);
  }

  // ── Inspection ──────────────────────────────────────────────────────────────

  /** Returns snapshot of currently registered workers. */
  getActiveWorkers(): WorkerRecord[] {
    return Array.from(this.workers.values());
  }

  /** Active worker count. */
  get activeCount(): number {
    return this.workers.size;
  }

  /** Returns true when any workers remain registered (orphan indicator). */
  hasOrphanedWorkers(): boolean {
    return this.workers.size > 0;
  }

  // ── Recovery ────────────────────────────────────────────────────────────────

  /**
   * Force-release all active registrations without waiting for workers.
   * Use at session startup to recover from orphaned state.
   * Returns the IDs that were released.
   */
  forceReleaseAll(): string[] {
    const ids = Array.from(this.workers.keys());
    this.workers.clear();
    return ids;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private describeActive(): string {
    if (this.workers.size === 0) return '(none)';
    return Array.from(this.workers.values())
      .map((w) => `${w.worker_id}[${w.role}:${w.child_id ?? 'no-child'}]`)
      .join(', ');
  }
}
