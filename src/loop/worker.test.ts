/**
 * Unit tests for src/loop/worker.ts
 *
 * Uses a mock executeChild hook and mock bootstrap packet to verify:
 * - CompactReturn schema validity on success
 * - current-state.json child completion fields updated
 * - Telemetry JSONL events appended
 * - Worker does not continue to next child
 * - Failure path returns correct CompactReturn
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeOneChild, readBootstrapPacket } from "./worker.js";
import { validateCompactReturn } from "./compact-return.js";
import type { CompactReturn } from "./compact-return.js";
import type { BootstrapPacket } from "./adapters/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `polaris-worker-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStateFile(dir: string, childId: string): string {
  const stateFile = join(dir, "current-state.json");
  const state = {
    schema_version: "1.0",
    run_id: "test-run-001",
    cluster_id: "POL-99",
    skill: "polaris-run",
    artifact_dir: dir,
    branch: "feature/test",
    step_cursor: "dispatching",
    status: "executing",
    session_type: "implementation",
    active_child: childId,
    last_commit: "abc1234",
    next_open_child: childId,
    completed_children: ["POL-68"],
    open_children: [childId, "POL-70"],
    open_children_meta: {},
    context_budget: {
      children_completed: 1,
      files_touched_total: 5,
      max_children_per_session: 3,
    },
    updated_at: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
  return stateFile;
}

function makeTelemetryFile(dir: string, runId: string): string {
  const telemetryFile = join(dir, "runs", runId, "telemetry.jsonl");
  mkdirSync(join(dir, "runs", runId), { recursive: true });
  writeFileSync(telemetryFile, "", "utf-8");
  return telemetryFile;
}

function makePacket(
  stateFile: string,
  telemetryFile: string,
  childId = "POL-69",
  runId = "test-run-001",
): BootstrapPacket {
  return {
    schema_version: "1.0",
    run_id: runId,
    cluster_id: "POL-99",
    active_child: childId,
    state_file: stateFile,
    telemetry_file: telemetryFile,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executeOneChild", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns a valid CompactReturn JSON for a successful child", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);

    let childExecuted = false;
    const result = await executeOneChild(packet, {
      repoRoot: tmpDir,
      executeChild: (childId) => {
        expect(childId).toBe("POL-69");
        childExecuted = true;
      },
    });

    expect(childExecuted).toBe(true);

    // Schema validity
    const errors = validateCompactReturn(result);
    expect(errors).toHaveLength(0);

    // Core fields
    expect(result.child_id).toBe("POL-69");
    expect(result.status).toBe("done");
    expect(result.validation).toBe("passed");
    expect(result.telemetry_updated).toBe(true);
    expect(result.state_updated).toBe(true);
    expect(result.next_recommended_action).toBe("continue");
  });

  it("updates current-state.json child completion fields", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);

    await executeOneChild(packet, {
      repoRoot: tmpDir,
      executeChild: () => { /* noop */ },
    });

    const savedState = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;

    // POL-69 moved from open_children to completed_children
    expect(savedState["open_children"]).not.toContain("POL-69");
    expect(savedState["completed_children"]).toContain("POL-69");

    // active_child cleared
    expect(savedState["active_child"]).toBe("");

    // children_completed incremented
    const budget = savedState["context_budget"] as Record<string, number>;
    expect(budget["children_completed"]).toBe(2); // was 1, now 2

    // status reflects remaining children
    expect(savedState["status"]).toBe("running"); // POL-70 still open
  });

  it("does not emit intermediate step-complete telemetry events on success", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);

    await executeOneChild(packet, {
      repoRoot: tmpDir,
      executeChild: () => { /* noop */ },
    });

    // Worker writes no telemetry on the success path — the parent emits
    // child-complete via polaris loop continue (checkpoint cadence).
    const raw = readFileSync(telemetryFile, "utf-8").trim();
    const lines = raw ? raw.split("\n").filter(Boolean) : [];
    const stepCompleteEvents = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e["event"] === "step-complete");

    expect(stepCompleteEvents).toHaveLength(0);
  });

  it("returns status=failed when executeChild throws", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);

    const result = await executeOneChild(packet, {
      repoRoot: tmpDir,
      executeChild: () => {
        throw new Error("mock child failure");
      },
    });

    const errors = validateCompactReturn(result);
    expect(errors).toHaveLength(0);

    expect(result.child_id).toBe("POL-69");
    expect(result.status).toBe("failed");
    expect(result.validation).toBe("failed");
    expect(result.state_updated).toBe(false);
    expect(result.next_recommended_action).toBe("investigate");
  });

  it("does not continue to the next child (single execution only)", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);

    let callCount = 0;
    await executeOneChild(packet, {
      repoRoot: tmpDir,
      executeChild: () => {
        callCount += 1;
      },
    });

    // executeChild must be called exactly once — never for POL-70 or any other child
    expect(callCount).toBe(1);
  });

  it("calls applyRouteCognitionDelta and writes route-health.json when touchedFiles match file-routes", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);

    mkdirSync(join(tmpDir, ".polaris", "map"), { recursive: true });
    mkdirSync(join(tmpDir, "src", "cognition"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "cognition", "POLARIS.md"), "# Cognition", "utf-8");
    writeFileSync(
      join(tmpDir, ".polaris", "map", "file-routes.json"),
      JSON.stringify({
        "src/cognition/route-cognition-delta.ts": {
          domain: "cognition",
          route: "src/cognition",
          taskchain: "polaris-cognition",
          confidence: 0.9,
          classification: "indexed",
          last_updated: new Date().toISOString(),
          updated_by: "test",
          tags: ["cognition"],
          instructionFile: "src/cognition/POLARIS.md",
          role_owner: "worker",
        },
      }),
      "utf-8",
    );

    const result = await executeOneChild(packet, {
      repoRoot: tmpDir,
      touchedFiles: ["src/cognition/route-cognition-delta.ts"],
      executeChild: () => { /* noop */ },
    });

    expect(result.status).toBe("done");

    const routeHealthPath = join(tmpDir, ".polaris", "map", "route-health.json");
    expect(existsSync(routeHealthPath)).toBe(true);
    const routeHealth = JSON.parse(readFileSync(routeHealthPath, "utf-8"));
    expect(routeHealth["src/cognition/route-cognition-delta.ts"]).toBe("healthy");

    const telemetryRaw = readFileSync(telemetryFile, "utf-8").trim();
    const telemetryEvents = telemetryRaw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const cognitionDeltaEvent = telemetryEvents.find((e) => e["event"] === "cognition-delta");
    expect(cognitionDeltaEvent).toBeDefined();
    expect(cognitionDeltaEvent?.["health_state"]).toBe("healthy");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POL-221: worker-acknowledged event emission tests
// ─────────────────────────────────────────────────────────────────────────────

describe("executeOneChild — worker-acknowledged event (POL-221)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("emits worker-acknowledged event with dispatch_id, worker_id, packet_sha", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);
    packet.dispatch_id = "dispatch-uuid-001";
    packet.worker_id = "worker-uuid-001";

    // Write the packet to a file so SHA can be computed
    const packetPath = tmpDir + "/packet.json";
    writeFileSync(packetPath, JSON.stringify(packet), "utf-8");

    await executeOneChild(packet, {
      repoRoot: tmpDir,
      packetPath,
      executeChild: () => { /* noop */ },
    });

    const raw = readFileSync(telemetryFile, "utf-8").trim();
    const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

    const ackEvent = events.find((e) => e["event"] === "worker-acknowledged");
    expect(ackEvent).toBeDefined();
    expect(ackEvent?.["dispatch_id"]).toBe("dispatch-uuid-001");
    expect(ackEvent?.["worker_id"]).toBe("worker-uuid-001");
    expect(typeof ackEvent?.["packet_sha"]).toBe("string");
    expect((ackEvent?.["packet_sha"] as string).length).toBe(64); // SHA-256 hex
  });

  it("emits worker-acknowledged before any other telemetry events", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);
    packet.dispatch_id = "dispatch-uuid-002";
    packet.worker_id = "worker-uuid-002";

    await executeOneChild(packet, {
      repoRoot: tmpDir,
      executeChild: () => { /* noop */ },
    });

    const raw = readFileSync(telemetryFile, "utf-8").trim();
    const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.["event"]).toBe("worker-acknowledged");
  });

  it("emits worker-acknowledged with empty packet_sha when no packet file or raw JSON provided", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);
    packet.dispatch_id = "dispatch-uuid-003";
    packet.worker_id = "worker-uuid-003";

    // No packetPath or packetRawJson — SHA will be empty string
    await executeOneChild(packet, {
      repoRoot: tmpDir,
      executeChild: () => { /* noop */ },
    });

    const raw = readFileSync(telemetryFile, "utf-8").trim();
    const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

    const ackEvent = events.find((e) => e["event"] === "worker-acknowledged");
    expect(ackEvent).toBeDefined();
    expect(ackEvent?.["packet_sha"]).toBe("");
  });

  it("computes packet_sha from packetRawJson when no file path provided", async () => {
    const stateFile = makeStateFile(tmpDir, "POL-69");
    const telemetryFile = makeTelemetryFile(tmpDir, "test-run-001");
    const packet = makePacket(stateFile, telemetryFile);
    packet.dispatch_id = "dispatch-uuid-004";
    packet.worker_id = "worker-uuid-004";

    const rawJson = JSON.stringify(packet);

    await executeOneChild(packet, {
      repoRoot: tmpDir,
      packetRawJson: rawJson,
      executeChild: () => { /* noop */ },
    });

    const raw = readFileSync(telemetryFile, "utf-8").trim();
    const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

    const ackEvent = events.find((e) => e["event"] === "worker-acknowledged");
    expect(ackEvent).toBeDefined();
    expect(typeof ackEvent?.["packet_sha"]).toBe("string");
    expect((ackEvent?.["packet_sha"] as string).length).toBe(64);
  });
});

describe("readBootstrapPacket", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    // Restore env vars
    delete process.env["POLARIS_BOOTSTRAP_PACKET"];
    delete process.env["POLARIS_PACKET_FILE"];
    delete process.env["POLARIS_PACKET_JSON"];
  });

  it("reads packet from --bootstrap CLI argument", () => {
    const packetFile = join(tmpDir, "packet.json");
    const packet: BootstrapPacket = {
      schema_version: "1.0",
      run_id: "run-1",
      cluster_id: "POL-99",
      active_child: "POL-69",
      state_file: "/tmp/state.json",
      telemetry_file: "/tmp/telemetry.jsonl",
    };
    writeFileSync(packetFile, JSON.stringify(packet), "utf-8");

    const result = readBootstrapPacket(["node", "worker.js", "--bootstrap", packetFile]);
    expect(result.active_child).toBe("POL-69");
    expect(result.run_id).toBe("run-1");
  });

  it("reads packet from POLARIS_BOOTSTRAP_PACKET env var", () => {
    const packetFile = join(tmpDir, "packet.json");
    const packet: BootstrapPacket = {
      schema_version: "1.0",
      run_id: "run-2",
      cluster_id: "POL-99",
      active_child: "POL-70",
      state_file: "/tmp/state.json",
      telemetry_file: "/tmp/telemetry.jsonl",
    };
    writeFileSync(packetFile, JSON.stringify(packet), "utf-8");
    process.env["POLARIS_BOOTSTRAP_PACKET"] = packetFile;

    const result = readBootstrapPacket(["node", "worker.js"]);
    expect(result.active_child).toBe("POL-70");
  });

  it("reads packet from POLARIS_PACKET_JSON env var", () => {
    const packet: BootstrapPacket = {
      schema_version: "1.0",
      run_id: "run-3",
      cluster_id: "POL-99",
      active_child: "POL-71",
      state_file: "/tmp/state.json",
      telemetry_file: "/tmp/telemetry.jsonl",
    };
    process.env["POLARIS_PACKET_JSON"] = JSON.stringify(packet);

    const result = readBootstrapPacket(["node", "worker.js"]);
    expect(result.active_child).toBe("POL-71");
  });

  it("throws when no packet source is available", () => {
    expect(() => readBootstrapPacket(["node", "worker.js"])).toThrow(
      /No bootstrap packet found/,
    );
  });
});

describe("validateCompactReturn", () => {
  it("accepts a valid CompactReturn", () => {
    const valid: CompactReturn = {
      child_id: "POL-69",
      status: "done",
      commit: "abc1234",
      validation: "passed",
      tracker_updated: false,
      state_updated: true,
      telemetry_updated: true,
      next_recommended_action: "continue",
    };
    expect(validateCompactReturn(valid)).toHaveLength(0);
  });

  it("rejects missing child_id", () => {
    const invalid = {
      child_id: "",
      status: "done",
      commit: null,
      validation: "passed",
      tracker_updated: false,
      state_updated: true,
      telemetry_updated: true,
      next_recommended_action: "continue",
    };
    expect(validateCompactReturn(invalid).length).toBeGreaterThan(0);
  });

  it("rejects invalid status value", () => {
    const invalid = {
      child_id: "POL-69",
      status: "unknown",
      commit: null,
      validation: "passed",
      tracker_updated: false,
      state_updated: true,
      telemetry_updated: true,
      next_recommended_action: "continue",
    };
    expect(validateCompactReturn(invalid).length).toBeGreaterThan(0);
  });
});
