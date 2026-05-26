/**
 * Unit tests for src/loop/lifecycle.ts
 *
 * Verifies one-active-worker enforcement, register/release semantics,
 * and orphan recovery via forceReleaseAll().
 */

import { describe, expect, it } from "vitest";
import { WorkerLifecycleManager } from "./lifecycle.js";

// ── Constructor ───────────────────────────────────────────────────────────────

describe("WorkerLifecycleManager constructor", () => {
  it("defaults to maxConcurrentWorkers = 1", () => {
    const m = new WorkerLifecycleManager();
    expect(m.maxConcurrentWorkers).toBe(1);
  });

  it("accepts a custom maxConcurrentWorkers", () => {
    const m = new WorkerLifecycleManager(3);
    expect(m.maxConcurrentWorkers).toBe(3);
  });

  it("throws RangeError for maxConcurrentWorkers < 1", () => {
    expect(() => new WorkerLifecycleManager(0)).toThrow(RangeError);
    expect(() => new WorkerLifecycleManager(-1)).toThrow(RangeError);
  });
});

// ── canDispatch ───────────────────────────────────────────────────────────────

describe("canDispatch", () => {
  it("returns true when no workers are registered", () => {
    const m = new WorkerLifecycleManager(1);
    expect(m.canDispatch()).toBe(true);
  });

  it("returns false when the slot is full", () => {
    const m = new WorkerLifecycleManager(1);
    m.register("w1", "POL-121", "impl");
    expect(m.canDispatch()).toBe(false);
  });

  it("returns true after all slots are released", () => {
    const m = new WorkerLifecycleManager(1);
    m.register("w1", "POL-121", "impl");
    m.release("w1");
    expect(m.canDispatch()).toBe(true);
  });
});

// ── register ──────────────────────────────────────────────────────────────────

describe("register", () => {
  it("returns the worker record", () => {
    const m = new WorkerLifecycleManager(1);
    const rec = m.register("w1", "POL-121", "impl");
    expect(rec.worker_id).toBe("w1");
    expect(rec.child_id).toBe("POL-121");
    expect(rec.role).toBe("impl");
    expect(typeof rec.dispatched_at).toBe("string");
  });

  it("throws when slot limit is already reached", () => {
    const m = new WorkerLifecycleManager(1);
    m.register("w1", "POL-121", "impl");
    expect(() => m.register("w2", "POL-122", "impl")).toThrow(/slot/i);
  });

  it("allows null child_id for finalize workers", () => {
    const m = new WorkerLifecycleManager(1);
    const rec = m.register("w1", null, "finalize");
    expect(rec.child_id).toBeNull();
  });

  it("increments activeCount after register", () => {
    const m = new WorkerLifecycleManager(2);
    expect(m.activeCount).toBe(0);
    m.register("w1", "POL-121", "impl");
    expect(m.activeCount).toBe(1);
    m.register("w2", "POL-122", "impl");
    expect(m.activeCount).toBe(2);
  });
});

// ── release ───────────────────────────────────────────────────────────────────

describe("release", () => {
  it("removes the worker from active set", () => {
    const m = new WorkerLifecycleManager(1);
    m.register("w1", "POL-121", "impl");
    m.release("w1");
    expect(m.activeCount).toBe(0);
  });

  it("is idempotent — releasing an unknown ID is a no-op", () => {
    const m = new WorkerLifecycleManager(1);
    expect(() => m.release("unknown-worker")).not.toThrow();
  });

  it("frees the slot for the next dispatch", () => {
    const m = new WorkerLifecycleManager(1);
    m.register("w1", "POL-121", "impl");
    m.release("w1");
    expect(() => m.register("w2", "POL-122", "impl")).not.toThrow();
  });
});

// ── getActiveWorkers ──────────────────────────────────────────────────────────

describe("getActiveWorkers", () => {
  it("returns empty array when no workers registered", () => {
    const m = new WorkerLifecycleManager(1);
    expect(m.getActiveWorkers()).toEqual([]);
  });

  it("returns all registered worker records", () => {
    const m = new WorkerLifecycleManager(3);
    m.register("w1", "POL-121", "impl");
    m.register("w2", null, "finalize");
    const workers = m.getActiveWorkers();
    expect(workers).toHaveLength(2);
    expect(workers.map((w) => w.worker_id).sort()).toEqual(["w1", "w2"]);
  });
});

// ── hasOrphanedWorkers ────────────────────────────────────────────────────────

describe("hasOrphanedWorkers", () => {
  it("returns false when no workers registered", () => {
    const m = new WorkerLifecycleManager(1);
    expect(m.hasOrphanedWorkers()).toBe(false);
  });

  it("returns true when workers are registered", () => {
    const m = new WorkerLifecycleManager(1);
    m.register("w1", "POL-121", "impl");
    expect(m.hasOrphanedWorkers()).toBe(true);
  });
});

// ── forceReleaseAll ───────────────────────────────────────────────────────────

describe("forceReleaseAll", () => {
  it("returns empty array when nothing registered", () => {
    const m = new WorkerLifecycleManager(1);
    expect(m.forceReleaseAll()).toEqual([]);
  });

  it("clears all workers and returns their IDs", () => {
    const m = new WorkerLifecycleManager(3);
    m.register("w1", "POL-121", "impl");
    m.register("w2", "POL-122", "impl");
    const released = m.forceReleaseAll();
    expect(released.sort()).toEqual(["w1", "w2"]);
    expect(m.activeCount).toBe(0);
  });

  it("allows new registrations after force release", () => {
    const m = new WorkerLifecycleManager(1);
    m.register("w1", "POL-121", "impl");
    m.forceReleaseAll();
    expect(() => m.register("w2", "POL-122", "impl")).not.toThrow();
  });
});

// ── One-active-worker enforcement (integration) ───────────────────────────────

describe("one-active-worker policy (default)", () => {
  it("enforces serial dispatch: second register fails until first is released", () => {
    const m = new WorkerLifecycleManager();
    m.register("worker-POL-121", "POL-121", "impl");

    expect(() => m.register("worker-POL-122", "POL-122", "impl")).toThrow();

    m.release("worker-POL-121");
    // Now should succeed
    expect(() => m.register("worker-POL-122", "POL-122", "impl")).not.toThrow();
  });
});
