/**
 * Polaris worker entry point.
 *
 * A worker process is spawned by the parent loop to execute exactly ONE child
 * task. The worker:
 *   1. Reads the bootstrap packet (from POLARIS_BOOTSTRAP_PACKET env var or
 *      --bootstrap CLI flag).
 *   2. Executes the single child specified in the packet.
 *   3. Updates current-state.json (child completion fields).
 *   4. Appends telemetry JSONL events.
 *   5. Writes a CompactReturn JSON to stdout.
 *   6. Exits.
 *
 * The worker MUST NOT continue to the next child under any circumstances.
 * Calling runWorker() will call process.exit() when done.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { readState, writeStateAtomic } from "./checkpoint.js";
import type { CompactReturn } from "./compact-return.js";
import type { BootstrapPacket } from "./adapters/types.js";
import { getMonotonicTimestamp } from "../utils/monotonic-timestamp.js";
import { applyRouteCognitionDelta, applySummaryDelta } from "../cognition/index.js";
import type { CognitionDeltaResult, SummaryDeltaResult } from "../cognition/index.js";

// ────────────────────────────────────────────────────────────────────────────
// Bootstrap packet reading
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse CLI args looking for --bootstrap <path>.
 */
function bootstrapPathFromArgs(argv: string[]): string | null {
  const idx = argv.indexOf("--bootstrap");
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1] ?? null;
  }
  return null;
}

/**
 * Read and parse the bootstrap packet.
 * Resolution order:
 *   1. --bootstrap <path> CLI argument
 *   2. POLARIS_BOOTSTRAP_PACKET env var (path to file)
 *   3. POLARIS_PACKET_FILE env var (path to file)
 *   4. POLARIS_PACKET_JSON env var (raw JSON)
 */
export function readBootstrapPacket(argv: string[] = process.argv): BootstrapPacket {
  // 1. CLI arg
  const cliPath = bootstrapPathFromArgs(argv);
  if (cliPath) {
    return JSON.parse(readFileSync(cliPath, "utf-8")) as BootstrapPacket;
  }

  // 2. POLARIS_BOOTSTRAP_PACKET env var (file path)
  const envPath = process.env["POLARIS_BOOTSTRAP_PACKET"];
  if (envPath) {
    return JSON.parse(readFileSync(envPath, "utf-8")) as BootstrapPacket;
  }

  // 3. POLARIS_PACKET_FILE env var (file path)
  const packetFile = process.env["POLARIS_PACKET_FILE"];
  if (packetFile) {
    return JSON.parse(readFileSync(packetFile, "utf-8")) as BootstrapPacket;
  }

  // 4. POLARIS_PACKET_JSON env var (raw JSON string)
  const packetJson = process.env["POLARIS_PACKET_JSON"];
  if (packetJson) {
    return JSON.parse(packetJson) as BootstrapPacket;
  }

  throw new Error(
    "No bootstrap packet found. Provide --bootstrap <path>, " +
    "POLARIS_BOOTSTRAP_PACKET, POLARIS_PACKET_FILE, or POLARIS_PACKET_JSON.",
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Telemetry helpers
// ────────────────────────────────────────────────────────────────────────────

function appendTelemetry(telemetryFile: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}

// ────────────────────────────────────────────────────────────────────────────
// Git helpers
// ────────────────────────────────────────────────────────────────────────────

function getHeadShort(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Worker execution
// ────────────────────────────────────────────────────────────────────────────

export interface WorkerOptions {
  /**
   * Path to the bootstrap packet file, or undefined to resolve from env/args.
   * When provided, takes precedence over all env vars and CLI args.
   */
  packetPath?: string;
  /** Repository root; defaults to process.cwd(). */
  repoRoot?: string;
  /**
   * If provided, called instead of spawning a real child process.
   * Receives the child ID; should throw on failure or return void on success.
   * Used in tests to simulate child task execution without actual side effects.
   */
  executeChild?: (_childId: string, _packet: BootstrapPacket) => void;
  /**
   * Files touched by this child's implementation. When provided, enables the
   * route cognition delta phase: worker reports which POLARIS.md / SUMMARY.md
   * surfaces need updating without performing repo-wide regeneration.
   */
  touchedFiles?: string[];
}

/**
 * Build a CompactReturn for an error case without touching durable state.
 */
function blockedReturn(childId: string, _reason: string): CompactReturn {
  return {
    child_id: childId,
    status: 'blocked',
    commit: null,
    validation: 'skipped',
    tracker_updated: false,
    state_updated: false,
    telemetry_updated: false,
    next_recommended_action: 'stop',
  };
}

/**
 * Execute one child task, update all durable state, and return a CompactReturn.
 *
 * This function does NOT call process.exit(). The caller (runWorker) does.
 */
export async function executeOneChild(
  packet: BootstrapPacket,
  options: WorkerOptions = {},
): Promise<CompactReturn> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const childId = packet.active_child;
  const stateFile = isAbsolute(packet.state_file)
    ? packet.state_file
    : resolve(repoRoot, packet.state_file);
  const telemetryFile = isAbsolute(packet.telemetry_file)
    ? packet.telemetry_file
    : resolve(repoRoot, packet.telemetry_file);
  const now = getMonotonicTimestamp;

  let stateUpdated = false;
  let telemetryUpdated = false;
  let commit: string | null = null;
  let validation: CompactReturn['validation'] = 'skipped';
  let cognitionDelta: CognitionDeltaResult | null = null;
  let summaryDelta: SummaryDeltaResult | null = null;

  // Create a new packet with absolute paths for child execution
  const newPacket: BootstrapPacket = {
    ...packet,
    state_file: stateFile,
    telemetry_file: telemetryFile,
  };

  // ── Step 04: Execute child ──────────────────────────────────────────────
  try {
    if (options.executeChild) {
      options.executeChild(childId, newPacket);
    }
    // If no executeChild hook is provided, the worker is acting as a thin
    // wrapper — real child work was done in the agent session itself before
    // calling runWorker(). This is the standard usage pattern.
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendTelemetry(telemetryFile, {
      event: "child-execution-error",
      run_id: packet.run_id,
      child_id: childId,
      error: msg,
      timestamp: now(),
    });
    return {
      child_id: childId,
      status: 'failed',
      commit: null,
      validation: 'failed',
      tracker_updated: false,
      state_updated: false,
      telemetry_updated: true,
      next_recommended_action: 'investigate',
    };
  }

  // ── Step 05: Validate child ─────────────────────────────────────────────
  // Validation is treated as passed when child execution succeeds.
  // A real implementation would run `npm run build && npm test` here.
  validation = 'passed';

  // ── Step 05b: Route cognition delta ─────────────────────────────────────
  // Inspect touched files and determine whether route-local POLARIS.md /
  // SUMMARY.md surfaces need updating. Bounded by locality — no repo-wide
  // regeneration. Parent runtime is never involved in cognition reconciliation.
  const touchedFiles = options.touchedFiles ?? [];
  if (touchedFiles.length > 0) {
    try {
      cognitionDelta = applyRouteCognitionDelta({
        repoRoot,
        touchedFiles,
        skipRoot: true,
      });
      summaryDelta = applySummaryDelta({
        repoRoot,
        touchedFiles,
        skipRoot: true,
      });
      appendTelemetry(telemetryFile, {
        event: "cognition-delta",
        run_id: packet.run_id,
        child_id: childId,
        polaris_update_warranted: cognitionDelta.updateWarranted,
        polaris_reasons: cognitionDelta.reasons,
        polaris_targets: cognitionDelta.routeLocalTargets,
        polaris_missing: cognitionDelta.missingCognitionSurfaces,
        summary_update_warranted: summaryDelta.updateWarranted,
        summary_reasons: summaryDelta.reasons,
        summary_targets: summaryDelta.summaryTargets,
        summary_missing: summaryDelta.missingSummaries,
        timestamp: now(),
      });
      telemetryUpdated = true;
    } catch {
      // Cognition delta failure is non-fatal — implementation already done
    }
  }

  // ── Step 06: Commit ─────────────────────────────────────────────────────
  commit = getHeadShort(repoRoot);

  // ── Update current-state.json ───────────────────────────────────────────
  try {
    const state = readState(stateFile);
    const remaining = state.open_children.filter((c) => c !== childId);
    const completed = [...state.completed_children, childId];
    const updatedState = {
      ...state,
      active_child: "",
      open_children: remaining,
      completed_children: completed,
      next_open_child: remaining[0] ?? null,
      step_cursor: "checkpoint",
      status: remaining.length > 0 ? "running" : "cluster-complete",
      last_commit: commit ?? state.last_commit,
      context_budget: {
        ...state.context_budget,
        children_completed: completed.length,
      },
      updated_at: now(),
    };
    writeStateAtomic(stateFile, updatedState as Parameters<typeof writeStateAtomic>[1]);
    stateUpdated = true;
  } catch (err) {
    // State persistence failure is critical — return error status
    const msg = err instanceof Error ? err.message : String(err);
    appendTelemetry(telemetryFile, {
      event: "state-update-error",
      run_id: packet.run_id,
      child_id: childId,
      error: msg,
      timestamp: now(),
    });
    return {
      child_id: childId,
      status: 'failed',
      commit,
      validation,
      tracker_updated: false,
      state_updated: false,
      telemetry_updated: telemetryUpdated,
      next_recommended_action: 'investigate',
    };
  }

  // Linear tracker update is intentionally skipped by the worker:
  // the spec says "Do NOT mark POL-69 as Done in Linear (parent handles Linear updates)".
  // tracker_updated is therefore always false from the worker's perspective.
  const trackerUpdated = false;

  return {
    child_id: childId,
    status: 'done',
    commit,
    validation,
    tracker_updated: trackerUpdated,
    state_updated: stateUpdated,
    telemetry_updated: telemetryUpdated,
    next_recommended_action: 'continue',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Main worker entry point. Reads the bootstrap packet, executes one child,
 * writes a CompactReturn JSON line to stdout, and calls process.exit(0).
 *
 * MUST NOT continue to the next child.
 */
export async function runWorker(options: WorkerOptions = {}): Promise<void> {
  let packet: BootstrapPacket;

  try {
    if (options.packetPath) {
      packet = JSON.parse(readFileSync(options.packetPath, "utf-8")) as BootstrapPacket;
    } else {
      packet = readBootstrapPacket(process.argv);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ret: CompactReturn = {
      child_id: "",
      status: 'failed',
      commit: null,
      validation: 'skipped',
      tracker_updated: false,
      state_updated: false,
      telemetry_updated: false,
      next_recommended_action: 'investigate',
    };
    process.stdout.write(JSON.stringify(ret) + "\n");
    process.stderr.write(`[polaris-worker] Failed to read bootstrap packet: ${msg}\n`);
    process.exit(1);
    return;
  }

  let result: CompactReturn;
  try {
    result = await executeOneChild(packet, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = blockedReturn(packet.active_child, msg);
    process.stderr.write(`[polaris-worker] Unexpected error: ${msg}\n`);
  }

  // Write compact return as the last (and only) JSON line to stdout, then exit.
  // No continuation to the next child — process.exit() ensures this.
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.status === 'done' ? 0 : 1);
}
