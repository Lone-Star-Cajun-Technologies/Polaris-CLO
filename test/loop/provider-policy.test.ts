/**
 * Provider policy enforcement tests.
 *
 * Covers:
 *   - dispatch rejects provider selected from rotation when outside worker policy
 *   - worker policy ["copilot","codex"] with rotation ["claude","codex"] selects codex, never claude
 *   - explicit --provider is rejected if outside role policy
 *   - if no allowed provider is available, dispatch fails clearly before any state mutation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { runLoopDispatch } from "../../src/loop/dispatch.js";
import { readState } from "../../src/loop/checkpoint.js";
import type { LoopState } from "../../src/loop/checkpoint.js";
import { createBootstrapSeal } from "../../src/loop/run-bootstrap.js";
import { initialDispatchBoundary } from "../../src/loop/dispatch-boundary.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `polaris-policy-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  // Simulate a non-base delivery branch
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/pol-268-delivery\n");
  return dir;
}

const MINIMAL_CHILD_BODY =
  "## Goal\nImplement the fix.\n\n## Scope\n- src/**\n\n## Validation\n- npm test";

function makeFreshState(overrides: Partial<LoopState> = {}): LoopState {
  const runId = "polaris-run-policy-test-001";
  const clusterId = "POL-268";
  return {
    schema_version: "1.0",
    run_id: runId,
    cluster_id: clusterId,
    active_child: "",
    completed_children: [],
    open_children: ["POL-268-1"],
    open_children_meta: {
      "POL-268-1": { title: "Fix POL-268-1", body: MINIMAL_CHILD_BODY },
    },
    step_cursor: null,
    context_budget: { children_completed: 0, max_children_per_session: 5 },
    status: "running",
    next_open_child: "POL-268-1",
    dispatch_boundary: initialDispatchBoundary(),
    run_bootstrap_seal: createBootstrapSeal(runId, clusterId, ["POL-268-1"]),
    ...overrides,
  };
}

function writeStateFile(dir: string, state: Partial<LoopState> & { run_id: string }): string {
  const stateDir = join(dir, ".polaris", "runs");
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "current-state.json");
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

function writePolarisConfig(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, "polaris.config.json"), JSON.stringify(config, null, 2));
}

interface DispatchOutcome {
  /** Selected provider from dispatch_record in state file. */
  provider: string | undefined;
  /** Provider selection reason from dispatch_record. */
  selectionReason: string | undefined;
  stderrOutput: string;
  threw: boolean;
}

function captureDispatch(
  stateFile: string,
  repoRoot: string,
  provider?: string,
): DispatchOutcome {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const stderrChunks: string[] = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrChunks.push(chunk.toString());
    return true;
  };
  const origStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  let threw = false;
  try {
    runLoopDispatch({ stateFile, repoRoot, provider });
  } catch {
    threw = true;
  } finally {
    exitSpy.mockRestore();
    process.stderr.write = origStderr;
    process.stdout.write = origStdout;
  }

  // Read provider from state file's dispatch_record (canonical source)
  let selectedProvider: string | undefined;
  let selectionReason: string | undefined;
  try {
    const updatedState = readState(stateFile);
    const firstChild = Object.keys(updatedState.open_children_meta ?? {})[0];
    const dr = firstChild ? updatedState.open_children_meta?.[firstChild]?.dispatch_record : undefined;
    selectedProvider = dr?.provider;
    selectionReason = dr?.provider_selection_reason;
  } catch {
    // state read failed — dispatch threw
  }

  return {
    provider: selectedProvider,
    selectionReason,
    stderrOutput: stderrChunks.join(""),
    threw,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Provider policy tests
// ──────────────────────────────────────────────────────────────────────────────

describe("provider policy: rotation filtered by worker policy", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("selects codex when rotation=[claude,codex] and worker policy=[copilot,codex]", () => {
    writePolarisConfig(testDir, {
      execution: {
        adapter: "terminal-cli",
        providers: {
          claude: { command: "claude", args: ["{{worker_prompt}}"] },
          codex: { command: "codex", args: ["{{worker_prompt}}"] },
          copilot: { command: "copilot", args: ["{{worker_prompt}}"] },
        },
        rotation: ["claude", "codex"],
        providerPolicy: {
          worker: { providers: ["copilot", "codex"], allowNativeSubagent: false },
        },
      },
    });

    const state = makeFreshState();
    const stateFile = writeStateFile(testDir, state);
    const { provider, threw } = captureDispatch(stateFile, testDir);

    expect(threw).toBe(false);
    // codex is the first rotation entry in the filtered list (claude not in policy; copilot not in rotation)
    expect(provider).toBe("codex");
  });

  it("never selects claude when worker policy excludes it", () => {
    writePolarisConfig(testDir, {
      execution: {
        adapter: "terminal-cli",
        providers: {
          claude: { command: "claude", args: ["{{worker_prompt}}"] },
          codex: { command: "codex", args: ["{{worker_prompt}}"] },
          copilot: { command: "copilot", args: ["{{worker_prompt}}"] },
        },
        rotation: ["claude", "codex", "copilot"],
        providerPolicy: {
          worker: { providers: ["copilot", "codex"], allowNativeSubagent: false },
        },
      },
    });

    const state = makeFreshState();
    const stateFile = writeStateFile(testDir, state);
    const { provider, threw } = captureDispatch(stateFile, testDir);

    expect(threw).toBe(false);
    // codex comes first in the filtered rotation ([claude,codex,copilot] ∩ [copilot,codex] → [codex,copilot])
    expect(provider).toBe("codex");
  });

  it("falls back to first policy provider when rotation has no overlap with policy", () => {
    writePolarisConfig(testDir, {
      execution: {
        adapter: "terminal-cli",
        providers: {
          claude: { command: "claude", args: ["{{worker_prompt}}"] },
          copilot: { command: "copilot", args: ["{{worker_prompt}}"] },
        },
        rotation: ["claude"],
        providerPolicy: {
          worker: { providers: ["copilot"], allowNativeSubagent: false },
        },
      },
    });

    const state = makeFreshState();
    const stateFile = writeStateFile(testDir, state);
    const { provider, threw } = captureDispatch(stateFile, testDir);

    expect(threw).toBe(false);
    expect(provider).toBe("copilot");
  });

  it("rejects explicit --provider claude when worker policy excludes claude", () => {
    writePolarisConfig(testDir, {
      execution: {
        adapter: "terminal-cli",
        providers: {
          claude: { command: "claude", args: ["{{worker_prompt}}"] },
          codex: { command: "codex", args: ["{{worker_prompt}}"] },
        },
        rotation: ["claude", "codex"],
        providerPolicy: {
          worker: { providers: ["codex"], allowNativeSubagent: false },
        },
      },
    });

    const state = makeFreshState();
    const stateFile = writeStateFile(testDir, state);
    const { stderrOutput, threw } = captureDispatch(stateFile, testDir, "claude");

    expect(threw).toBe(true);
    expect(stderrOutput.toLowerCase()).toContain("forbidden");
  });

  it("fails clearly before dispatch when no provider in policy is available", () => {
    // providers: [] disables the worker role entirely — dispatch must fail before any state mutation
    writePolarisConfig(testDir, {
      execution: {
        adapter: "terminal-cli",
        providers: {
          claude: { command: "claude", args: ["{{worker_prompt}}"] },
        },
        rotation: ["claude"],
        providerPolicy: {
          worker: { providers: [], allowNativeSubagent: false },
        },
      },
    });

    const state = makeFreshState();
    const stateFile = writeStateFile(testDir, state);
    const stateBefore = readFileSync(stateFile, "utf-8");

    const { stderrOutput, threw } = captureDispatch(stateFile, testDir);

    expect(threw).toBe(true);
    // State must not have been mutated
    expect(readFileSync(stateFile, "utf-8")).toBe(stateBefore);
    // Error must mention the policy violation
    expect(stderrOutput.toLowerCase()).toContain("forbidden");
  });

  it("dispatch selects provider from rotation that is in policy, not first from policy", () => {
    // rotation: [codex, copilot], policy: [copilot, codex]
    // filtered rotation: [codex, copilot] → picks codex (first in filtered rotation)
    writePolarisConfig(testDir, {
      execution: {
        adapter: "terminal-cli",
        providers: {
          codex: { command: "codex", args: ["{{worker_prompt}}"] },
          copilot: { command: "copilot", args: ["{{worker_prompt}}"] },
        },
        rotation: ["codex", "copilot"],
        providerPolicy: {
          worker: { providers: ["copilot", "codex"], allowNativeSubagent: false },
        },
      },
    });

    const state = makeFreshState();
    const stateFile = writeStateFile(testDir, state);
    const { provider, threw } = captureDispatch(stateFile, testDir);

    expect(threw).toBe(false);
    // codex comes first in the filtered rotation (codex is first in [codex, copilot]
    // and both are in policy)
    expect(provider).toBe("codex");
  });
});
