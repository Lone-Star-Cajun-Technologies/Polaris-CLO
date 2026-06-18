/**
 * Polaris Run Bootstrap Delegator
 *
 * The run bootstrap delegator is the runtime gate to the dispatch machinery.
 * Parent sessions may NOT hand-create run state. The runtime MUST initialize
 * the loop before any child can be selected or dispatched.
 *
 * Enforcement:
 *   - `polaris loop bootstrap` is the ONLY command that may create initial
 *     run state. It writes a RunBootstrapSeal into current-state.json.
 *   - `polaris loop dispatch` and `polaris loop run` verify the seal before
 *     allowing any child to be selected. If the seal is absent or invalid,
 *     dispatch is refused with a hard exit(1).
 *
 * The seal binds:
 *   - The run_id and cluster_id (must match state fields)
 *   - A SHA-256 of the initial open_children list (forensic tamper record)
 *   - The sealer identity ("polaris-loop-bootstrap" — only this value is valid)
 *
 * This module also exports the CLI handler runLoopBootstrapInit(), which
 * is registered as `polaris loop bootstrap` in src/loop/index.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeStateAtomic, type LoopState } from "./checkpoint.js";
import {
  appendDispatchViolationEvent,
} from "./dispatch-boundary.js";
import { initialDispatchBoundary } from "./dispatch-boundary.js";
import { initializeClusterState, readClusterState, writeClusterState } from "../cluster-state/store.js";
import { buildDeliveryBranchName } from "./git-custody.js";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A runtime-issued bootstrap seal.
 *
 * Written into current-state.json by `polaris loop bootstrap`. Any state
 * lacking a valid seal is refused by dispatch and parent-loop commands.
 *
 * The seal does NOT need to be cryptographically unforgeable — enforcement
 * is about model behaviour, not adversarial security. The sealer field is
 * the primary gate; run_id and cluster_id cross-bind the seal to the state.
 */
export interface RunBootstrapSeal {
  /**
   * The runtime component that issued this seal.
   * Only "polaris-loop-bootstrap" is a valid value. Any other value is refused.
   */
  sealer: "polaris-loop-bootstrap";
  /** Must match state.run_id at time of seal verification. */
  run_id: string;
  /** Must match state.cluster_id at time of seal verification. */
  cluster_id: string;
  /**
   * SHA-256 of the sorted initial open_children list (children joined by ",").
   * Stored as a tamper-detection audit record; not re-verified at dispatch time
   * (open_children mutates as children complete).
   */
  open_children_sha: string;
  /** ISO-8601 timestamp when the seal was issued. */
  sealed_at: string;
}

/**
 * Options for `runLoopBootstrapInit` — the `polaris loop bootstrap` handler.
 */
export interface BootstrapInitOptions {
  /** Cluster (parent issue) ID, e.g. "POL-100". */
  clusterId: string;
  /**
   * Run ID. If omitted, auto-generated from cluster ID and current date.
   * Format: polaris-run-<cluster-slug>-<YYYY-MM-DD>-001
   */
  runId?: string;
  /** Ordered list of child issue IDs to execute. */
  openChildren: string[];
  /** Metadata keyed by child ID (title, body, type, labels). */
  openChildrenMeta?: Record<string, { title?: string; body?: string; type?: string; labels?: string[] }>;
  /** Absolute path to write current-state.json. */
  stateFile: string;
  /** Repository root. */
  repoRoot: string;
  /** Git branch for this run (defaults to empty string). */
  branch?: string;
  /** Session type — default "implement". */
  sessionType?: "analyze" | "implement";
  /** Maximum children per session (default 1 — one per dispatch cycle). */
  maxChildrenPerSession?: number;
  /** Artifact directory override. */
  artifactDir?: string;
  /** If true, archive existing state file and start fresh instead of failing. */
  overwrite?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Error constants
// ──────────────────────────────────────────────────────────────────────────────

export const BOOTSTRAP_REQUIRED_ERROR =
  "Run state must be initialized through 'polaris loop bootstrap' before dispatch. " +
  "Parent sessions may not hand-create run state. " +
  "Use: npx polaris loop bootstrap --cluster-id <ID> --children <CSV>";

// ──────────────────────────────────────────────────────────────────────────────
// Seal helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 of an open_children list.
 * Sorts the list before hashing to ensure stability.
 */
export function computeChildrenSha(openChildren: string[]): string {
  const sorted = [...openChildren].sort();
  return createHash("sha256").update(sorted.join(",")).digest("hex");
}

/**
 * Create a bootstrap seal for the given run/cluster/children.
 */
export function createBootstrapSeal(
  runId: string,
  clusterId: string,
  openChildren: string[],
): RunBootstrapSeal {
  return {
    sealer: "polaris-loop-bootstrap",
    run_id: runId,
    cluster_id: clusterId,
    open_children_sha: computeChildrenSha(openChildren),
    sealed_at: new Date().toISOString(),
  };
}

/**
 * Derive a run_id from a cluster ID and the current date.
 * Format: polaris-run-<cluster-slug>-<YYYY-MM-DD>-001
 */
export function deriveRunId(clusterId: string): string {
  const slug = clusterId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `polaris-run-${slug}-${date}-001`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Enforcement guard
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Assert that the current state was initialized through `polaris loop bootstrap`.
 *
 * Verifies:
 *   1. `run_bootstrap_seal` is present in state
 *   2. `seal.sealer === "polaris-loop-bootstrap"`
 *   3. `seal.run_id === state.run_id`
 *   4. `seal.cluster_id === state.cluster_id`
 *
 * Emits a `dispatch-required` telemetry event on failure and throws.
 * The caller must NOT mutate state after this throws.
 *
 * @throws Error with BOOTSTRAP_REQUIRED_ERROR if seal is absent or invalid
 */
export function assertBootstrapSeal(state: LoopState, telemetryFile: string): void {
  const seal = state.run_bootstrap_seal;

  let reason: string | null = null;

  if (!seal) {
    reason = `No run_bootstrap_seal found in state. ${BOOTSTRAP_REQUIRED_ERROR}`;
  } else if (seal.sealer !== "polaris-loop-bootstrap") {
    reason = `Invalid run_bootstrap_seal.sealer: "${seal.sealer}". Only "polaris-loop-bootstrap" is accepted.`;
  } else if (seal.run_id !== state.run_id) {
    reason = `run_bootstrap_seal.run_id "${seal.run_id}" does not match state.run_id "${state.run_id}".`;
  } else if (seal.cluster_id !== state.cluster_id) {
    reason = `run_bootstrap_seal.cluster_id "${seal.cluster_id}" does not match state.cluster_id "${state.cluster_id}".`;
  }

  if (reason) {
    appendDispatchViolationEvent(telemetryFile, {
      event: "dispatch-required",
      run_id: state.run_id,
      from_state: "unbootstrapped",
      to_state: "dispatched",
      reason,
      timestamp: new Date().toISOString(),
    });
    throw new Error(reason);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Bootstrap init command handler
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Create the initial run state and write it to the state file.
 *
 * This is the CLI handler for `polaris loop bootstrap`. It is the ONLY
 * legitimate path to creating a new current-state.json. Any state file
 * that was not written by this function will be refused by dispatch.
 */
export function runLoopBootstrapInit(options: BootstrapInitOptions): Promise<void> {
  const {
    clusterId,
    openChildren,
    openChildrenMeta,
    stateFile,
    repoRoot,
    branch,
    sessionType,
    maxChildrenPerSession,
    artifactDir,
    overwrite,
  } = options;

  if (!clusterId) {
    process.stderr.write("Error: --cluster-id is required\n");
    process.exit(1);
  }

  if (!openChildren || openChildren.length === 0) {
    process.stderr.write("Error: --children is required and must be non-empty\n");
    process.exit(1);
  }

  const runId = options.runId ?? deriveRunId(clusterId);
  const seal = createBootstrapSeal(runId, clusterId, openChildren);
  const deliveryBranch = branch ?? buildDeliveryBranchName(clusterId);

  const initialState: LoopState = {
    schema_version: "1.0",
    run_id: runId,
    cluster_id: clusterId,
    skill: "polaris-run",
    branch: deliveryBranch,
    session_type: sessionType ?? "implement",
    active_child: "",
    completed_children: [],
    open_children: openChildren,
    open_children_meta: openChildrenMeta,
    step_cursor: null,
    context_budget: {
      children_completed: 0,
      max_children_per_session: maxChildrenPerSession ?? 1,
    },
    status: "running",
    next_open_child: openChildren[0] ?? null,
    artifact_dir: artifactDir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run"),
    dispatch_boundary: initialDispatchBoundary()!,
    run_bootstrap_seal: seal,
  };

  // Check if current-state.json already exists before making any modifications
  if (existsSync(stateFile)) {
    if (!overwrite) {
      process.stderr.write(
        `Error: State file already exists at ${stateFile}\n` +
        `Cannot overwrite existing run state. Either:\n` +
        `  1. Use --overwrite to archive the existing state and start fresh, or\n` +
        `  2. Use a different --state-file path\n`
      );
      process.exit(1);
    }
    // Archive the existing state before overwriting
    const backupPath = `${stateFile}.${Date.now()}.bak`;
    renameSync(stateFile, backupPath);
    process.stderr.write(`Warning: Archived existing state to ${backupPath}\n`);
  }

  // Initialize cluster-state.json if it doesn't exist.
  // This is best-effort and must not block bootstrap state creation.
  const clusterStateInitPromise = (async () => {
    try {
      const existingClusterState = await readClusterState(clusterId, repoRoot);
      if (!existingClusterState) {
        process.stderr.write(`Initializing new cluster-state.json for ${clusterId}...\n`);
        await initializeClusterState(clusterId, repoRoot);
        // Bind the delivery branch immediately so finalize doesn't inherit stale metadata
        const freshState = await readClusterState(clusterId, repoRoot);
        if (freshState && !freshState.delivery_branch) {
          await writeClusterState(clusterId, {
            ...freshState,
            state_generation: (freshState.state_generation ?? 0) + 1,
            delivery_branch: deliveryBranch,
            base_branch: "main",
          }, repoRoot);
        }
      } else if (!existingClusterState.delivery_branch) {
        // Existing cluster state without delivery branch — bind it now
        await writeClusterState(clusterId, {
          ...existingClusterState,
          state_generation: (existingClusterState.state_generation ?? 0) + 1,
          delivery_branch: deliveryBranch,
          base_branch: existingClusterState.base_branch ?? "main",
        }, repoRoot);
      }
    } catch (error) {
      process.stderr.write(`Warning: Failed to initialize cluster-state.json for ${clusterId}: ${error instanceof Error ? error.message : String(error)}\n`);
      // Continue without hard-failing bootstrap.
    }
  })();

  // Validate the state we're about to write
  // (uses validateState from checkpoint.ts — but we don't import it here to
  //  avoid circular deps; validateState is called by dispatch which is downstream)

  mkdirSync(dirname(stateFile), { recursive: true });

  const sha = writeStateAtomic(stateFile, initialState);

  const summary = {
    run_id: runId,
    cluster_id: clusterId,
    children: openChildren.length,
    first_child: openChildren[0],
    state_file: stateFile,
    seal_sha: sha.slice(0, 12),
    sealed_at: seal.sealed_at,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.stderr.write(
    `Bootstrap complete. State initialized at: ${stateFile}\n` +
    `Run ID: ${runId}\n` +
    `Children: ${openChildren.join(", ")}\n` +
    `Next: npx polaris loop dispatch\n`,
  );

  return clusterStateInitPromise;
}
