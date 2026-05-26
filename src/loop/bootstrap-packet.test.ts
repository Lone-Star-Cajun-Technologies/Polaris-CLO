/**
 * Unit tests for src/loop/bootstrap-packet.ts
 *
 * Covers:
 *   - compact_mode propagation from compact config (all three levels)
 *   - compact_mode default (no config) → "standard"
 *   - level shorthand wins over orchestratorMode when level is set
 *   - packet shape sanity checks
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as child_process from "node:child_process";
import { buildBootstrapPacket } from "./bootstrap-packet.js";
import type { LoopState } from "./checkpoint.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const mockedExecFileSync = vi.mocked(child_process.execFileSync);

beforeEach(() => {
  vi.resetAllMocks();
  // Default git mocks: branch + HEAD sha
  mockedExecFileSync.mockImplementation(
    (_cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];
      if (argsArr && argsArr[0] === "branch") {
        return Buffer.from("feature/pol-120\n");
      }
      if (argsArr && argsArr[0] === "rev-parse") {
        return Buffer.from("abc1234567890\n");
      }
      return Buffer.from("");
    },
  );
});

const BASE_STATE: LoopState = {
  schema_version: "1.0",
  run_id: "run-test-001",
  cluster_id: "POL-114",
  skill: "polaris-run",
  active_child: "",
  completed_children: ["POL-115"],
  open_children: ["POL-120"],
  step_cursor: "checkpoint",
  context_budget: {
    children_completed: 5,
    files_touched_total: 20,
    max_children_per_session: 6,
  },
  status: "running",
  next_open_child: "POL-120",
  artifact_dir: "/repo/.taskchain_artifacts/polaris-run",
};

describe("buildBootstrapPacket — compact_mode propagation", () => {
  it("defaults compact_mode to 'standard' when no compactConfig is provided", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
    );

    expect(packet.compact_mode).toBe("standard");
  });

  it("defaults compact_mode to 'standard' when compactConfig is empty object", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
      undefined,
      undefined,
      {},
    );

    expect(packet.compact_mode).toBe("standard");
  });

  it("sets compact_mode to 'standard' when level is 'standard'", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
      undefined,
      undefined,
      { level: "standard" },
    );

    expect(packet.compact_mode).toBe("standard");
  });

  it("sets compact_mode to 'strict' when level is 'strict'", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
      undefined,
      undefined,
      { level: "strict" },
    );

    expect(packet.compact_mode).toBe("strict");
  });

  it("sets compact_mode to 'minimal' when level is 'minimal'", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
      undefined,
      undefined,
      { level: "minimal" },
    );

    expect(packet.compact_mode).toBe("minimal");
  });

  it("uses orchestratorMode when level is not set", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
      undefined,
      undefined,
      { orchestratorMode: "strict" },
    );

    expect(packet.compact_mode).toBe("strict");
  });

  it("level wins over orchestratorMode when both are set", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
      undefined,
      undefined,
      { level: "minimal", orchestratorMode: "strict" },
    );

    // level takes priority per bootstrap-packet.ts implementation
    expect(packet.compact_mode).toBe("minimal");
  });
});

describe("buildBootstrapPacket — execution_adapter carries compact_mode", () => {
  it("execution_adapter.compact_bootstrap_state.compact_mode matches packet compact_mode (standard)", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
      undefined,
      undefined,
      { level: "standard" },
    );

    expect(packet.execution_adapter?.compact_bootstrap_state.compact_mode).toBe(
      "standard",
    );
    expect(packet.compact_mode).toBe("standard");
  });

  it("execution_adapter.compact_bootstrap_state.compact_mode matches packet compact_mode (strict)", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
      undefined,
      undefined,
      { level: "strict" },
    );

    expect(packet.execution_adapter?.compact_bootstrap_state.compact_mode).toBe(
      "strict",
    );
    expect(packet.compact_mode).toBe("strict");
  });

  it("execution_adapter.compact_bootstrap_state.compact_mode matches packet compact_mode (minimal)", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
      undefined,
      undefined,
      { level: "minimal" },
    );

    expect(packet.execution_adapter?.compact_bootstrap_state.compact_mode).toBe(
      "minimal",
    );
    expect(packet.compact_mode).toBe("minimal");
  });

  it("compact_bootstrap_state and packet compact_mode are in sync for default case", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
    );

    expect(packet.compact_mode).toBe("standard");
    expect(packet.execution_adapter?.compact_bootstrap_state.compact_mode).toBe(
      "standard",
    );
  });
});

describe("buildBootstrapPacket — packet shape", () => {
  it("sets run_id, skill, and open_children from state", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
    );

    expect(packet.run_id).toBe("run-test-001");
    expect(packet.skill).toBe("polaris-run");
    expect(packet.open_children).toEqual(["POL-120"]);
    expect(packet.last_completed_child).toBe("POL-119");
  });

  it("sets next_step to CLUSTER-COMPLETE when no open children remain", () => {
    const state: LoopState = {
      ...BASE_STATE,
      open_children: [],
      next_open_child: null,
    };

    const packet = buildBootstrapPacket(
      state,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-120",
    );

    expect(packet.next_step).toBe("CLUSTER-COMPLETE");
  });

  it("sets next_step to '03-execute-child' when open children remain", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
    );

    expect(packet.next_step).toBe("03-execute-child");
  });

  it("includes artifact_pointers with relative paths", () => {
    const packet = buildBootstrapPacket(
      BASE_STATE,
      "/repo/.taskchain_artifacts/polaris-run/current-state.json",
      "sha256abc",
      "/repo",
      "POL-119",
    );

    expect(packet.artifact_pointers.current_state).toMatch(
      /\.taskchain_artifacts/,
    );
    expect(packet.artifact_pointers.telemetry).toMatch(/telemetry\.jsonl$/);
  });
});
