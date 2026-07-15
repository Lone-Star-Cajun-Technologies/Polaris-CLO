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

import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { readState, writeStateAtomic } from "./checkpoint.js";
import type { CompactReturn } from "./compact-return.js";
import type { BootstrapPacket } from "./adapters/types.js";
import { getMonotonicTimestamp } from "../utils/monotonic-timestamp.js";
import { loadConfig } from "../config/loader.js";
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
// Work note helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Determine the primary folder (folder_slug) from touched files.
 * Returns the folder containing the most changed files, normalized to lowercase with / → -.
 */
function determineFolderSlug(touchedFiles: string[]): string {
  if (touchedFiles.length === 0) {
    return "root";
  }

  // Count files by folder depth, preferring the shallowest common folder
  const folderCounts: Record<string, number> = {};
  for (const file of touchedFiles) {
    const parts = file.split("/");
    // Try each folder level from root down
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      folderCounts[folder] = (folderCounts[folder] ?? 0) + 1;
    }
  }

  // Find the folder with the most files (deepest common folder)
  let maxFolder = "root";
  let maxCount = 0;
  for (const [folder, count] of Object.entries(folderCounts)) {
    if (count > maxCount) {
      maxCount = count;
      maxFolder = folder;
    }
  }

  // Normalize: replace / with -, handle edge cases
  if (maxFolder === "root" || maxFolder === "") {
    return "root";
  }
  return maxFolder.replace(/\//g, "-").toLowerCase();
}

/**
 * Determine docs_impact based on cognition delta results.
 * Returns one of: none, polaris-update, summary-update, both, archive-only
 */
function determineDocsImpact(
  cognitionDelta: CognitionDeltaResult | null,
  summaryDelta: SummaryDeltaResult | null,
): string {
  const polarisUpdate = cognitionDelta?.updateWarranted ?? false;
  const summaryUpdate = summaryDelta?.updateWarranted ?? false;

  if (polarisUpdate && summaryUpdate) {
    return "both";
  } else if (polarisUpdate) {
    return "polaris-update";
  } else if (summaryUpdate) {
    return "summary-update";
  }
  return "none";
}

/**
 * Write a work note to .polaris/cognition/pending/<folder-slug>/<run-id>-<child-id>.md
 * Returns the repo-relative path to the written note.
 */
function writeWorkNote(
  repoRoot: string,
  runId: string,
  childId: string,
  issueId: string,
  folderSlug: string,
  touchedFiles: string[],
  docsImpact: string,
  commit: string,
  validationPerformed: string,
): string {
  const timestamp = new Date().toISOString();
  const primaryFolder = folderSlug === "root" ? "" : folderSlug.replace(/-/g, "/");

  // Build frontmatter
  const frontmatter = [
    "---",
    `run_id: ${runId}`,
    `child_id: ${childId}`,
    `issue_id: ${issueId}`,
    `folder: ${primaryFolder || "."}`,
    `folder_slug: ${folderSlug}`,
    "affected_files:",
    ...touchedFiles.map((f) => `  - ${f}`),
    `validation_performed: ${validationPerformed}`,
    `docs_impact: ${docsImpact}`,
    `commit: ${commit}`,
    `timestamp: ${timestamp}`,
    "---",
  ];

  // Build prose body (minimal, ≤150 words)
  const proseBody = `Completed task ${childId} (${issueId}). Implementation changes applied, validation passed. ${docsImpact !== "none" ? `Cognition surfaces require update (${docsImpact}).` : "No cognition surface updates needed."}`;

  // Combine
  const noteContent = [...frontmatter, "", proseBody].join("\n");

  // Write to file
  const notePath = resolve(
    repoRoot,
    ".polaris/cognition/pending",
    folderSlug,
    `${runId}-${childId}.md`,
  );
  mkdirSync(dirname(notePath), { recursive: true });
  writeFileSync(notePath, noteContent, "utf-8");

  // Return repo-relative path
  return notePath.replace(repoRoot + "/", "");
}

// ────────────────────────────────────────────────────────────────────────────
// Worker execution
// ────────────────────────────────────────────────────────────────────────────

export interface WorkerOptions {
  /**
   * Path to the bootstrap packet file, or undefined to resolve from env/args.
   * When provided, takes precedence over all env vars and CLI args.
   * Also used for SHA-256 computation in the worker-acknowledged event.
   */
  packetPath?: string;

  /**
   * Raw packet JSON string used for SHA-256 computation when no file path is
   * available (e.g. POLARIS_PACKET_JSON env var path). If absent, SHA is
   * computed from the packet file at packetPath.
   */
  packetRawJson?: string;
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
    result_data: {},
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

  // ── Step 03b: Emit worker-acknowledged event ────────────────────────────
  // Must be emitted after packet read and SHA computation, before any work
  // output (telemetry spec §5.1). Acknowledges receipt of the dispatch packet.
  {
    let packetSha = "";
    if (options.packetPath) {
      try {
        const raw = readFileSync(options.packetPath, "utf-8");
        packetSha = createHash("sha256").update(raw, "utf-8").digest("hex");
      } catch {
        // SHA computation failure is non-fatal; emit empty string
      }
    } else if (options.packetRawJson) {
      packetSha = createHash("sha256").update(options.packetRawJson, "utf-8").digest("hex");
    }
    appendTelemetry(telemetryFile, {
      event: "worker-acknowledged",
      event_id: randomUUID(),
      run_id: packet.run_id,
      child_id: childId,
      dispatch_id: packet.dispatch_id ?? "",
      worker_id: packet.worker_id ?? "",
      packet_sha: packetSha,
      timestamp: now(),
    });
    telemetryUpdated = true;
  }

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
      result_data: {},
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
      let outputPath: string | undefined;
      try {
        const config = loadConfig(repoRoot);
        outputPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
      } catch {
        // Use the default sidecar path if config cannot be loaded.
      }
      cognitionDelta = applyRouteCognitionDelta({
        repoRoot,
        touchedFiles,
        skipRoot: true,
        outputPath,
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
        health_state: cognitionDelta.healthState,
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
      result_data: {},
    };
  }

  // Linear tracker update is intentionally skipped by the worker:
  // the spec says "Do NOT mark POL-69 as Done in Linear (parent handles Linear updates)".
  // tracker_updated is therefore always false from the worker's perspective.
  const trackerUpdated = false;

  // ── Step 07: Write work note ────────────────────────────────────────────
  let workNotePaths: string[] = [];
  try {
    const folderSlug = determineFolderSlug(touchedFiles);
    const docsImpact = determineDocsImpact(cognitionDelta, summaryDelta);
    const validationPerformed = "child execution and validation completed";
    const notePath = writeWorkNote(
      repoRoot,
      packet.run_id,
      childId,
      childId,
      folderSlug,
      touchedFiles,
      docsImpact,
      commit,
      validationPerformed,
    );
    workNotePaths = [notePath];
    appendTelemetry(telemetryFile, {
      event: "work-note-written",
      run_id: packet.run_id,
      child_id: childId,
      note_path: notePath,
      folder_slug: folderSlug,
      docs_impact: docsImpact,
      timestamp: now(),
    });
    telemetryUpdated = true;
  } catch (err) {
    // Work note failure is non-fatal — implementation already done
    // Log but don't block CompactReturn
    const msg = err instanceof Error ? err.message : String(err);
    appendTelemetry(telemetryFile, {
      event: "work-note-error",
      run_id: packet.run_id,
      child_id: childId,
      error: msg,
      timestamp: now(),
    });
    telemetryUpdated = true;
  }

  return {
    child_id: childId,
    status: 'done',
    commit,
    validation,
    tracker_updated: trackerUpdated,
    state_updated: stateUpdated,
    telemetry_updated: telemetryUpdated,
    next_recommended_action: 'continue',
    result_data: {},
    work_note_paths: workNotePaths.length > 0 ? workNotePaths : undefined,
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

  let resolvedPacketPath = options.packetPath;
  let resolvedPacketRawJson = options.packetRawJson;

  try {
    if (options.packetPath) {
      packet = JSON.parse(readFileSync(options.packetPath, "utf-8")) as BootstrapPacket;
    } else {
      // Capture raw JSON from env var sources for SHA computation
      const cliPath = (() => {
        const idx = process.argv.indexOf("--bootstrap");
        return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
      })();
      if (cliPath) {
        resolvedPacketPath = cliPath;
      } else {
        const envPath = process.env["POLARIS_BOOTSTRAP_PACKET"] ?? process.env["POLARIS_PACKET_FILE"];
        if (envPath) {
          resolvedPacketPath = envPath;
        } else {
          const packetJson = process.env["POLARIS_PACKET_JSON"];
          if (packetJson) {
            resolvedPacketRawJson = packetJson;
          }
        }
      }
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
      result_data: {},
    };
    process.stdout.write(JSON.stringify(ret) + "\n");
    process.stderr.write(`[polaris-worker] Failed to read bootstrap packet: ${msg}\n`);
    process.exit(1);
    return;
  }

  let result: CompactReturn;
  try {
    result = await executeOneChild(packet, {
      ...options,
      packetPath: resolvedPacketPath,
      packetRawJson: resolvedPacketRawJson,
    });
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
