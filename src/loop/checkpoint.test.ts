import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  writeStateAtomic,
  toValidationStatus,
  countTelemetryEvents,
  computePacketHashFromPath,
} from "./checkpoint.js";
import type { LoopState } from "./checkpoint.js";

function tmpStateFile(): string {
  const dir = join(tmpdir(), `pol-checkpoint-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "current-state.json");
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    schema_version: "1.0",
    run_id: "test-run-1",
    cluster_id: "POL-999",
    active_child: "POL-001",
    completed_children: [],
    open_children: ["POL-001", "POL-002", "POL-003"],
    step_cursor: "dispatch",
    context_budget: { children_completed: 0 },
    status: "running",
    next_open_child: "POL-001",
    ...overrides,
  };
}

describe("writeStateAtomic — body stripping", () => {
  it("strips body from all children except open_children[0]", () => {
    const stateFile = tmpStateFile();
    const state = makeState({
      open_children_meta: {
        "POL-001": { title: "Child 1", body: "body-1", labels: ["feat"] },
        "POL-002": { title: "Child 2", body: "body-2", labels: ["fix"] },
        "POL-003": { title: "Child 3", body: "body-3", labels: [] },
      },
    });

    writeStateAtomic(stateFile, state);
    const written = JSON.parse(readFileSync(stateFile, "utf-8")) as LoopState;
    const meta = written.open_children_meta!;

    // Next child (index 0) retains body
    expect(meta["POL-001"]!.body).toBe("body-1");

    // Remaining children have body stripped
    expect("body" in meta["POL-002"]!).toBe(false);
    expect("body" in meta["POL-003"]!).toBe(false);
  });

  it("preserves title, labels, type, dispatch_record, and result_file for non-next children", () => {
    const stateFile = tmpStateFile();
    const state = makeState({
      open_children_meta: {
        "POL-001": { title: "C1", body: "b1" },
        "POL-002": {
          title: "C2",
          body: "b2",
          labels: ["label-a"],
          type: "feature",
          result_file: "/tmp/result.json",
        },
      },
    });

    writeStateAtomic(stateFile, state);
    const written = JSON.parse(readFileSync(stateFile, "utf-8")) as LoopState;
    const meta = written.open_children_meta!;

    const c2 = meta["POL-002"]!;
    expect(c2.title).toBe("C2");
    expect(c2.labels).toEqual(["label-a"]);
    expect(c2.type).toBe("feature");
    expect(c2.result_file).toBe("/tmp/result.json");
    expect("body" in c2).toBe(false);
  });

  it("is a no-op when open_children_meta is absent", () => {
    const stateFile = tmpStateFile();
    const state = makeState();
    writeStateAtomic(stateFile, state);
    const written = JSON.parse(readFileSync(stateFile, "utf-8")) as LoopState;
    expect(written.open_children_meta).toBeUndefined();
  });

  it("works when open_children is empty (no next child)", () => {
    const stateFile = tmpStateFile();
    const state = makeState({
      open_children: [],
      open_children_meta: {
        "POL-001": { title: "Done", body: "b1" },
      },
    });

    writeStateAtomic(stateFile, state);
    const written = JSON.parse(readFileSync(stateFile, "utf-8")) as LoopState;
    const meta = written.open_children_meta!;

    // nextChild is undefined — all entries should have body stripped
    expect("body" in meta["POL-001"]!).toBe(false);
    expect(meta["POL-001"]!.title).toBe("Done");
  });
});

describe("toValidationStatus", () => {
  it("normalizes canonical strings", () => {
    expect(toValidationStatus("passed")).toBe("passed");
    expect(toValidationStatus("failed")).toBe("failed");
    expect(toValidationStatus("skipped")).toBe("skipped");
    expect(toValidationStatus("PASS")).toBe("passed");
  });

  it("returns passed for true and validation objects with passed entries", () => {
    expect(toValidationStatus(true)).toBe("passed");
    expect(toValidationStatus({ passed: ["npm run build"], failed: [] })).toBe("passed");
  });

  it("returns skipped for unknown values", () => {
    expect(toValidationStatus(undefined)).toBe("skipped");
    expect(toValidationStatus(null)).toBe("skipped");
    expect(toValidationStatus({})).toBe("skipped");
  });
});

describe("computePacketHashFromPath", () => {
  it("returns the SHA-256 of the packet file", () => {
    const dir = join(tmpdir(), `pol-checkpoint-hash-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const packetPath = join(dir, "packet.json");
    const content = JSON.stringify({ run_id: "r1", child_id: "POL-1" }, null, 2);
    writeFileSync(packetPath, content, "utf-8");
    const expected = createHash("sha256").update(content, "utf-8").digest("hex");
    expect(computePacketHashFromPath(packetPath)).toBe(expected);
  });

  it("returns an empty string for a missing packet", () => {
    const missingPath = join(tmpdir(), `pol-checkpoint-missing-${randomUUID()}`, "packet.json");
    expect(computePacketHashFromPath(missingPath)).toBe("");
  });
});

describe("countTelemetryEvents", () => {
  it("counts events by name and child", () => {
    const dir = join(tmpdir(), `pol-checkpoint-events-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const telemetryFile = join(dir, "telemetry.jsonl");
    writeFileSync(
      telemetryFile,
      [
        JSON.stringify({ event: "worker-heartbeat", child_id: "POL-1" }),
        JSON.stringify({ event: "worker-heartbeat", child_id: "POL-1" }),
        JSON.stringify({ event: "worker-blocked", child_id: "POL-1" }),
        JSON.stringify({ event: "worker-heartbeat", child_id: "POL-2" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    expect(countTelemetryEvents(telemetryFile, "worker-heartbeat", "POL-1")).toBe(2);
    expect(countTelemetryEvents(telemetryFile, "worker-blocked", "POL-1")).toBe(1);
    expect(countTelemetryEvents(telemetryFile, "worker-heartbeat", "POL-2")).toBe(1);
  });

  it("returns 0 for missing telemetry files", () => {
    const missingPath = join(tmpdir(), `pol-checkpoint-no-events-${randomUUID()}`, "telemetry.jsonl");
    expect(countTelemetryEvents(missingPath, "worker-heartbeat", "POL-1")).toBe(0);
  });
});
