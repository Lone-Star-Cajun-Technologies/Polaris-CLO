/**
 * Run bootstrap delegator tests.
 *
 * Validates that the bootstrap seal gate works correctly:
 *   - `polaris loop bootstrap` creates valid sealed run state
 *   - `polaris loop dispatch` refuses state without a seal
 *   - `polaris loop run` refuses state without a seal
 *   - Seal binds run_id and cluster_id; mismatches are rejected
 *   - Invalid/tampered sealer fields are rejected
 *   - A bootstrapped run can be dispatched immediately
 *   - State written by the bootstrap command passes validateState()
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  runLoopBootstrapInit,
  assertBootstrapSeal,
  createBootstrapSeal,
  computeChildrenSha,
  deriveRunId,
  BOOTSTRAP_REQUIRED_ERROR,
  type RunBootstrapSeal,
} from "../../src/loop/run-bootstrap.js";
import { runLoopDispatch } from "../../src/loop/dispatch.js";
import { runParentLoop } from "../../src/loop/parent.js";
import { readState, validateState } from "../../src/loop/checkpoint.js";
import type { LoopState } from "../../src/loop/checkpoint.js";
import type { ExecutionAdapter, BootstrapPacket, DispatchOptions, DispatchResult } from "../../src/loop/adapters/types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `polaris-bootstrap-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/test-branch\n");
  return dir;
}

function writeRawState(dir: string, state: Partial<LoopState> & { run_id: string }): string {
  const stateDir = join(dir, ".polaris", "runs");
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "current-state.json");
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

function suppressOutput(fn: () => void): void {
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// createBootstrapSeal unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe("createBootstrapSeal", () => {
  it("creates a seal with the correct sealer", () => {
    const seal = createBootstrapSeal("run-1", "POL-100", ["POL-101"]);
    expect(seal.sealer).toBe("polaris-loop-bootstrap");
  });

  it("binds run_id and cluster_id", () => {
    const seal = createBootstrapSeal("run-abc", "POL-200", ["POL-201"]);
    expect(seal.run_id).toBe("run-abc");
    expect(seal.cluster_id).toBe("POL-200");
  });

  it("includes an open_children_sha (non-empty hex string)", () => {
    const seal = createBootstrapSeal("run-1", "POL-100", ["POL-101", "POL-102"]);
    expect(seal.open_children_sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes a sealed_at ISO timestamp", () => {
    const seal = createBootstrapSeal("run-1", "POL-100", []);
    expect(() => new Date(seal.sealed_at)).not.toThrow();
    expect(seal.sealed_at).toMatch(/^\d{4}-/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeChildrenSha unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe("computeChildrenSha", () => {
  it("returns a 64-char hex string", () => {
    const sha = computeChildrenSha(["POL-101", "POL-102"]);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across runs (deterministic)", () => {
    const a = computeChildrenSha(["POL-101", "POL-102"]);
    const b = computeChildrenSha(["POL-101", "POL-102"]);
    expect(a).toBe(b);
  });

  it("is order-independent (sorts before hashing)", () => {
    const ordered = computeChildrenSha(["POL-101", "POL-102"]);
    const reversed = computeChildrenSha(["POL-102", "POL-101"]);
    expect(ordered).toBe(reversed);
  });

  it("differs for different child sets", () => {
    const a = computeChildrenSha(["POL-101"]);
    const b = computeChildrenSha(["POL-102"]);
    expect(a).not.toBe(b);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// deriveRunId unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe("deriveRunId", () => {
  it("produces a string starting with polaris-run-", () => {
    const id = deriveRunId("POL-100");
    expect(id).toMatch(/^polaris-run-/);
  });

  it("lowercases and slugifies the cluster ID", () => {
    const id = deriveRunId("POL-100");
    expect(id).toContain("pol-100");
    expect(id).not.toContain("POL");
  });

  it("includes a YYYY-MM-DD date component", () => {
    const id = deriveRunId("POL-100");
    expect(id).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// assertBootstrapSeal unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe("assertBootstrapSeal", () => {
  const fakeFile = "/tmp/polaris-bootstrap-test-telemetry.jsonl";

  function makeState(seal?: Partial<RunBootstrapSeal> | null): LoopState {
    const base: LoopState = {
      schema_version: "1.0",
      run_id: "run-100",
      cluster_id: "POL-100",
      active_child: "",
      completed_children: [],
      open_children: ["POL-101"],
      step_cursor: null,
      context_budget: { children_completed: 0 },
      status: "running",
      next_open_child: "POL-101",
    };
    if (seal === null) return base; // no seal
    if (seal === undefined) {
      // valid seal
      base.run_bootstrap_seal = createBootstrapSeal("run-100", "POL-100", ["POL-101"]);
    } else {
      base.run_bootstrap_seal = {
        sealer: "polaris-loop-bootstrap",
        run_id: "run-100",
        cluster_id: "POL-100",
        open_children_sha: computeChildrenSha(["POL-101"]),
        sealed_at: new Date().toISOString(),
        ...seal,
      };
    }
    return base;
  }

  it("passes for a valid seal", () => {
    const state = makeState();
    expect(() => assertBootstrapSeal(state, fakeFile)).not.toThrow();
  });

  it("throws when run_bootstrap_seal is absent", () => {
    const state = makeState(null);
    expect(() => assertBootstrapSeal(state, fakeFile)).toThrow();
  });

  it("error message includes BOOTSTRAP_REQUIRED_ERROR guidance", () => {
    const state = makeState(null);
    try {
      assertBootstrapSeal(state, fakeFile);
      expect.fail("should have thrown");
    } catch (err) {
      expect(String(err)).toContain("polaris loop bootstrap");
    }
  });

  it("throws when sealer is wrong value", () => {
    const state = makeState({ sealer: "something-else" as "polaris-loop-bootstrap" });
    expect(() => assertBootstrapSeal(state, fakeFile)).toThrow(/sealer/);
  });

  it("throws when run_id does not match state", () => {
    const state = makeState({ run_id: "different-run" });
    expect(() => assertBootstrapSeal(state, fakeFile)).toThrow(/run_id/);
  });

  it("throws when cluster_id does not match state", () => {
    const state = makeState({ cluster_id: "POL-999" });
    expect(() => assertBootstrapSeal(state, fakeFile)).toThrow(/cluster_id/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runLoopBootstrapInit integration tests
// ──────────────────────────────────────────────────────────────────────────────

describe("runLoopBootstrapInit", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates current-state.json with a valid bootstrap seal", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");

    suppressOutput(() =>
      runLoopBootstrapInit({
        clusterId: "POL-200",
        runId: "polaris-run-pol-200-2026-05-27-001",
        openChildren: ["POL-201", "POL-202"],
        stateFile,
        repoRoot: testDir,
      }),
    );

    const state = readState(stateFile);
    expect(state.run_bootstrap_seal).toBeDefined();
    expect(state.run_bootstrap_seal?.sealer).toBe("polaris-loop-bootstrap");
    expect(state.run_bootstrap_seal?.run_id).toBe("polaris-run-pol-200-2026-05-27-001");
    expect(state.run_bootstrap_seal?.cluster_id).toBe("POL-200");
  });

  it("creates state with correct run_id, cluster_id, and open_children", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");

    suppressOutput(() =>
      runLoopBootstrapInit({
        clusterId: "POL-300",
        runId: "polaris-run-pol-300-2026-05-27-001",
        openChildren: ["POL-301", "POL-302", "POL-303"],
        stateFile,
        repoRoot: testDir,
      }),
    );

    const state = readState(stateFile);
    expect(state.run_id).toBe("polaris-run-pol-300-2026-05-27-001");
    expect(state.cluster_id).toBe("POL-300");
    expect(state.open_children).toEqual(["POL-301", "POL-302", "POL-303"]);
    expect(state.completed_children).toEqual([]);
    expect(state.active_child).toBe("");
    expect(state.status).toBe("running");
  });

  it("creates state that passes validateState()", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");

    suppressOutput(() =>
      runLoopBootstrapInit({
        clusterId: "POL-400",
        runId: "polaris-run-pol-400-2026-05-27-001",
        openChildren: ["POL-401"],
        stateFile,
        repoRoot: testDir,
      }),
    );

    const state = readState(stateFile);
    const errors = validateState(state);
    expect(errors).toEqual([]);
  });

  it("initialises dispatch_boundary at epoch 0", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");

    suppressOutput(() =>
      runLoopBootstrapInit({
        clusterId: "POL-500",
        runId: "polaris-run-pol-500-2026-05-27-001",
        openChildren: ["POL-501"],
        stateFile,
        repoRoot: testDir,
      }),
    );

    const state = readState(stateFile);
    expect(state.dispatch_boundary?.dispatch_epoch).toBe(0);
    expect(state.dispatch_boundary?.continue_epoch).toBe(0);
    expect(state.dispatch_boundary?.last_dispatched_child).toBeNull();
  });

  it("auto-derives run_id when not provided", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");

    suppressOutput(() =>
      runLoopBootstrapInit({
        clusterId: "POL-600",
        openChildren: ["POL-601"],
        stateFile,
        repoRoot: testDir,
      }),
    );

    const state = readState(stateFile);
    expect(state.run_id).toMatch(/^polaris-run-pol-600-/);
  });

  it("emits a JSON summary to stdout on success", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");
    const stdoutChunks: string[] = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Buffer) => {
      stdoutChunks.push(chunk.toString());
      return true;
    };
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;

    try {
      runLoopBootstrapInit({
        clusterId: "POL-700",
        runId: "polaris-run-pol-700-2026-05-27-001",
        openChildren: ["POL-701"],
        stateFile,
        repoRoot: testDir,
      });
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }

    const summary = JSON.parse(stdoutChunks.join(""));
    expect(summary.run_id).toBe("polaris-run-pol-700-2026-05-27-001");
    expect(summary.cluster_id).toBe("POL-700");
    expect(summary.children).toBe(1);
    expect(summary.state_file).toBe(stateFile);
  });

  it("exits with error when cluster_id is empty", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    process.stderr.write = () => true;

    try {
      expect(() =>
        runLoopBootstrapInit({
          clusterId: "",
          openChildren: ["POL-101"],
          stateFile,
          repoRoot: testDir,
        }),
      ).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("exits with error when openChildren is empty", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    process.stderr.write = () => true;

    try {
      expect(() =>
        runLoopBootstrapInit({
          clusterId: "POL-800",
          openChildren: [],
          stateFile,
          repoRoot: testDir,
        }),
      ).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Dispatch refuses state without bootstrap seal
// ──────────────────────────────────────────────────────────────────────────────

describe("runLoopDispatch: bootstrap seal gate", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("refuses to dispatch when run_bootstrap_seal is absent", () => {
    // Hand-crafted state — no seal
    const state: Partial<LoopState> & { run_id: string } = {
      schema_version: "1.0",
      run_id: "hand-crafted-run",
      cluster_id: "POL-100",
      active_child: "",
      completed_children: [],
      open_children: ["POL-101"],
      step_cursor: null,
      context_budget: { children_completed: 0 },
      status: "running",
      next_open_child: "POL-101",
      // NO run_bootstrap_seal
    };
    const stateFile = writeRawState(testDir, state);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const stderrChunks: string[] = [];
    process.stderr.write = (chunk: string | Buffer) => {
      stderrChunks.push(chunk.toString());
      return true;
    };

    try {
      expect(() => runLoopDispatch({ stateFile, repoRoot: testDir })).toThrow();
    } finally {
      exitSpy.mockRestore();
    }

    expect(stderrChunks.join("")).toMatch(/bootstrap/i);
  });

  it("refuses to dispatch when seal has wrong run_id", () => {
    const state: Partial<LoopState> & { run_id: string } = {
      schema_version: "1.0",
      run_id: "correct-run-id",
      cluster_id: "POL-100",
      active_child: "",
      completed_children: [],
      open_children: ["POL-101"],
      step_cursor: null,
      context_budget: { children_completed: 0 },
      status: "running",
      next_open_child: "POL-101",
      dispatch_boundary: { dispatch_epoch: 0, continue_epoch: 0, last_dispatched_child: null },
      run_bootstrap_seal: {
        sealer: "polaris-loop-bootstrap",
        run_id: "wrong-run-id",  // Mismatched
        cluster_id: "POL-100",
        open_children_sha: computeChildrenSha(["POL-101"]),
        sealed_at: new Date().toISOString(),
      },
    };
    const stateFile = writeRawState(testDir, state);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    process.stderr.write = () => true;

    try {
      expect(() => runLoopDispatch({ stateFile, repoRoot: testDir })).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("allows dispatch when seal is valid (bootstrapped run)", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });

    // Bootstrap first (the correct path)
    suppressOutput(() =>
      runLoopBootstrapInit({
        clusterId: "POL-100",
        runId: "polaris-run-pol-100-2026-05-27-001",
        openChildren: ["POL-101", "POL-102"],
        stateFile,
        repoRoot: testDir,
      }),
    );

    // Dispatch should succeed
    let packet: Record<string, unknown> | null = null;
    const stdoutChunks: string[] = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Buffer) => {
      stdoutChunks.push(chunk.toString());
      return true;
    };
    try {
      runLoopDispatch({ stateFile, repoRoot: testDir });
      packet = JSON.parse(stdoutChunks.join(""));
    } finally {
      process.stdout.write = origStdout;
    }

    expect(packet).toBeDefined();
    expect(packet!["active_child"]).toBe("POL-101");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Parent loop refuses state without bootstrap seal
// ──────────────────────────────────────────────────────────────────────────────

describe("runParentLoop: bootstrap seal gate", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns state-invalid when run_bootstrap_seal is absent", async () => {
    const state: Partial<LoopState> & { run_id: string } = {
      schema_version: "1.0",
      run_id: "hand-crafted-run",
      cluster_id: "POL-100",
      active_child: "",
      completed_children: [],
      open_children: ["POL-101"],
      step_cursor: null,
      context_budget: { children_completed: 0 },
      status: "running",
      next_open_child: "POL-101",
      // NO run_bootstrap_seal
    };
    const stateFile = writeRawState(testDir, state);

    const result = await runParentLoop({ stateFile, repoRoot: testDir, dryRun: true });

    expect(result.haltReason).toBe("state-invalid");
    expect(result.message).toMatch(/bootstrap/i);
    expect(result.childrenDispatched).toBe(0);
  });

  it("does NOT mutate state when bootstrap seal is absent", async () => {
    const state: Partial<LoopState> & { run_id: string } = {
      schema_version: "1.0",
      run_id: "no-seal-run",
      cluster_id: "POL-100",
      active_child: "",
      completed_children: [],
      open_children: ["POL-101"],
      step_cursor: null,
      context_budget: { children_completed: 0 },
      status: "running",
      next_open_child: "POL-101",
    };
    const stateFile = writeRawState(testDir, state);
    const before = readFileSync(stateFile, "utf-8");

    await runParentLoop({ stateFile, repoRoot: testDir, dryRun: true });

    // State file must be unchanged
    const after = readFileSync(stateFile, "utf-8");
    expect(after).toBe(before);
  });

  it("provides the correct guidance in the error message", async () => {
    const state: Partial<LoopState> & { run_id: string } = {
      schema_version: "1.0",
      run_id: "unsealed-run",
      cluster_id: "POL-100",
      active_child: "",
      completed_children: [],
      open_children: ["POL-101"],
      step_cursor: null,
      context_budget: { children_completed: 0 },
      status: "running",
      next_open_child: "POL-101",
    };
    const stateFile = writeRawState(testDir, state);

    const result = await runParentLoop({ stateFile, repoRoot: testDir, dryRun: true });

    expect(result.message).toContain("polaris loop bootstrap");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// End-to-end: bootstrap → dispatch → state is consistent
// ──────────────────────────────────────────────────────────────────────────────

describe("bootstrap → dispatch flow", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("bootstrapped state has dispatch_boundary at epoch 0", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");

    suppressOutput(() =>
      runLoopBootstrapInit({
        clusterId: "POL-900",
        runId: "polaris-run-pol-900-2026-05-27-001",
        openChildren: ["POL-901", "POL-902"],
        stateFile,
        repoRoot: testDir,
      }),
    );

    const state = readState(stateFile);
    expect(state.dispatch_boundary?.dispatch_epoch).toBe(0);
    expect(state.dispatch_boundary?.continue_epoch).toBe(0);
  });

  it("after dispatch, dispatch_epoch = 1 and seal is preserved", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");

    suppressOutput(() =>
      runLoopBootstrapInit({
        clusterId: "POL-910",
        runId: "polaris-run-pol-910-2026-05-27-001",
        openChildren: ["POL-911", "POL-912"],
        stateFile,
        repoRoot: testDir,
      }),
    );

    suppressOutput(() => runLoopDispatch({ stateFile, repoRoot: testDir }));

    const state = readState(stateFile);
    expect(state.dispatch_boundary?.dispatch_epoch).toBe(1);
    expect(state.dispatch_boundary?.continue_epoch).toBe(0);
    expect(state.run_bootstrap_seal?.sealer).toBe("polaris-loop-bootstrap");
    expect(state.run_bootstrap_seal?.cluster_id).toBe("POL-910");
  });

  it("seal is preserved after dispatch (not stripped from state)", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");

    suppressOutput(() =>
      runLoopBootstrapInit({
        clusterId: "POL-920",
        runId: "polaris-run-pol-920-2026-05-27-001",
        openChildren: ["POL-921"],
        stateFile,
        repoRoot: testDir,
      }),
    );

    suppressOutput(() => runLoopDispatch({ stateFile, repoRoot: testDir }));

    const state = readState(stateFile);
    // Seal must still be present and valid after dispatch
    expect(() => assertBootstrapSeal(state, "/tmp/fake-telemetry.jsonl")).not.toThrow();
  });
});
