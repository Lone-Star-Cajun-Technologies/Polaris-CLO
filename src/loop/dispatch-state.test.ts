/**
 * Tests for dispatch-state.ts — state machine transitions and backward compat helpers.
 */

import { describe, it, expect } from "vitest";
import { isValidTransition } from "./dispatch-state.js";
import type { ChildDispatchRecord } from "./checkpoint.js";

// ─────────────────────────────────────────────────────────────────────────────
// Transition tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidTransition — added transitions", () => {
  it("packet-created → failed is valid", () => {
    expect(isValidTransition("packet-created", "failed")).toBe(true);
  });

  it("running → orphaned is valid", () => {
    expect(isValidTransition("running", "orphaned")).toBe(true);
  });

  it("delegated → blocked is valid", () => {
    expect(isValidTransition("delegated", "blocked")).toBe(true);
  });
});

describe("isValidTransition — pre-existing transitions still valid", () => {
  it("packet-created → delegated", () => {
    expect(isValidTransition("packet-created", "delegated")).toBe(true);
  });

  it("delegated → launching", () => {
    expect(isValidTransition("delegated", "launching")).toBe(true);
  });

  it("running → completed", () => {
    expect(isValidTransition("running", "completed")).toBe(true);
  });

  it("blocked → orphaned", () => {
    expect(isValidTransition("blocked", "orphaned")).toBe(true);
  });
});

describe("isValidTransition — terminal states cannot transition", () => {
  it("completed → running is invalid", () => {
    expect(isValidTransition("completed", "running")).toBe(false);
  });

  it("failed → running is invalid", () => {
    expect(isValidTransition("failed", "running")).toBe(false);
  });

  it("orphaned → running is invalid", () => {
    expect(isValidTransition("orphaned", "running")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compat helper tests for ChildDispatchRecord optional fields
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve worker_id with backward-compat fallback.
 * Records created before worker_id was added fall back to dispatch_id.
 */
function resolveWorkerId(record: ChildDispatchRecord): string {
  return record.worker_id ?? record.dispatch_id;
}

function resolveSessionId(record: ChildDispatchRecord): string | null {
  return record.session_id !== undefined ? record.session_id : null;
}

function resolveAttachmentCapable(record: ChildDispatchRecord): boolean {
  return record.attachment_capable ?? false;
}

function resolveHeartbeatCount(record: ChildDispatchRecord): number {
  return record.heartbeat_count ?? 0;
}

describe("ChildDispatchRecord backward compat", () => {
  const legacyRecord: ChildDispatchRecord = {
    dispatch_id: "legacy-dispatch-id",
    child_id: "POL-001",
    run_id: "run-1",
    cluster_id: "cluster-1",
    packet_path: "/path/to/packet",
    expected_result_path: "/path/to/result",
    dispatched_at: new Date().toISOString(),
    status: "dispatched",
  };

  it("worker_id falls back to dispatch_id when absent", () => {
    expect(resolveWorkerId(legacyRecord)).toBe("legacy-dispatch-id");
  });

  it("session_id defaults to null when absent", () => {
    expect(resolveSessionId(legacyRecord)).toBeNull();
  });

  it("attachment_capable defaults to false when absent", () => {
    expect(resolveAttachmentCapable(legacyRecord)).toBe(false);
  });

  it("heartbeat_count defaults to 0 when absent", () => {
    expect(resolveHeartbeatCount(legacyRecord)).toBe(0);
  });
});

describe("ChildDispatchRecord new fields when present", () => {
  const newRecord: ChildDispatchRecord = {
    dispatch_id: "dispatch-abc",
    child_id: "POL-219",
    run_id: "run-2",
    cluster_id: "cluster-2",
    packet_path: "/path/to/packet",
    expected_result_path: "/path/to/result",
    dispatched_at: new Date().toISOString(),
    status: "dispatched",
    worker_id: "worker-uuid-xyz",
    session_id: "session-123",
    attachment_capable: true,
    heartbeat_count: 5,
    first_heartbeat_at: "2026-05-29T00:00:00.000Z",
  };

  it("worker_id uses explicit value", () => {
    expect(resolveWorkerId(newRecord)).toBe("worker-uuid-xyz");
  });

  it("session_id returns explicit value", () => {
    expect(resolveSessionId(newRecord)).toBe("session-123");
  });

  it("attachment_capable returns true when set", () => {
    expect(resolveAttachmentCapable(newRecord)).toBe(true);
  });

  it("heartbeat_count returns explicit count", () => {
    expect(resolveHeartbeatCount(newRecord)).toBe(5);
  });

  it("first_heartbeat_at is present", () => {
    expect(newRecord.first_heartbeat_at).toBe("2026-05-29T00:00:00.000Z");
  });
});
