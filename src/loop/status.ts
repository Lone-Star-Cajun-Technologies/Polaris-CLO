import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readState, validateState, type ChildDispatchRecord } from "./checkpoint.js";
import { loadConfig } from "../config/loader.js";
import type { BootstrapPacket } from "./bootstrap-packet.js";

/**
 * Dispatch evidence for status reporting.
 */
export interface DispatchEvidence {
  /** Child ID */
  child_id: string;
  /** Dispatch ID */
  dispatch_id: string;
  /** Path to the packet file */
  packet_path: string;
  /** Expected result path */
  expected_result_path: string;
  /** Whether result file exists */
  result_present: boolean;
  /** Dispatch status */
  dispatch_status: "dispatched" | "completed" | "failed";
  /** Provider if known */
  provider?: string;
  /** Dispatch timestamp */
  dispatched_at: string;
}

/**
 * Find dispatch evidence for the active child.
 * Searches cluster-scoped layout and open_children_meta.
 */
function findDispatchEvidence(
  repoRoot: string,
  clusterId: string,
  activeChild: string | null,
  openChildrenMeta?: Record<string, { type?: string; title?: string; labels?: string[]; result_file?: string; dispatch_record?: ChildDispatchRecord }>,
): DispatchEvidence | null {
  if (!activeChild) return null;

  // First check open_children_meta for dispatch_record
  const childMeta = openChildrenMeta?.[activeChild];
  const dispatchRecord = childMeta?.dispatch_record;

  if (dispatchRecord) {
    // Check if result file exists
    const resultPresent = existsSync(dispatchRecord.expected_result_path);

    return {
      child_id: dispatchRecord.child_id,
      dispatch_id: dispatchRecord.dispatch_id,
      packet_path: dispatchRecord.packet_path,
      expected_result_path: dispatchRecord.expected_result_path,
      result_present: resultPresent,
      dispatch_status: dispatchRecord.status,
      provider: dispatchRecord.provider,
      dispatched_at: dispatchRecord.dispatched_at,
    };
  }

  // Fallback: scan cluster packets directory for matching files
  const packetDir = join(repoRoot, ".polaris", "clusters", clusterId, "packets");
  if (!existsSync(packetDir)) return null;

  // Look for files matching <child-id>-*.json pattern
  const files = readdirSync(packetDir).filter((f) =>
    f.startsWith(`${activeChild}-`) && f.endsWith(".json")
  );

  if (files.length === 0) return null;

  // Use the most recent file (sorted by name, which includes timestamp/UUID)
  const latestFile = files.sort().at(-1)!;
  const packetPath = join(packetDir, latestFile);

  // Derive result path from packet path
  const resultDir = join(repoRoot, ".polaris", "clusters", clusterId, "results");
  const resultPath = join(resultDir, latestFile);

  // Check if result exists
  const resultPresent = existsSync(resultPath);

  // Extract dispatch ID from filename (format: <child-id>-<dispatch-id>.json)
  const dispatchId = latestFile.replace(`${activeChild}-`, "").replace(".json", "");

  return {
    child_id: activeChild,
    dispatch_id: dispatchId,
    packet_path: packetPath,
    expected_result_path: resultPath,
    result_present: resultPresent,
    dispatch_status: resultPresent ? "completed" : "dispatched",
    dispatched_at: "unknown", // Cannot determine from file alone
  };
}

/**
 * Get relative path from repo root if path is inside repo.
 */
function getRelativePath(repoRoot: string, absolutePath: string): string {
  if (absolutePath.startsWith(repoRoot + "/")) {
    return absolutePath.slice(repoRoot.length + 1);
  }
  return absolutePath;
}

/**
 * Worker heartbeat telemetry entry.
 */
interface WorkerHeartbeat {
  event: "worker-heartbeat";
  run_id: string;
  child_id: string;
  step_cursor: string;
  timestamp: string;
  progress_pct?: number;
  files_changed?: number;
  current_file?: string;
}

/**
 * Find latest worker heartbeat for active child from telemetry.
 */
function findWorkerHeartbeat(
  telemetryFile: string,
  activeChild: string | null,
): WorkerHeartbeat | null {
  if (!activeChild || !existsSync(telemetryFile)) return null;

  try {
    const content = readFileSync(telemetryFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Parse from most recent to find latest heartbeat for this child
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]) as WorkerHeartbeat;
        if (event.event === "worker-heartbeat" && event.child_id === activeChild) {
          return event;
        }
      } catch {
        continue; // Skip malformed lines
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Format heartbeat for display.
 */
function formatHeartbeat(heartbeat: WorkerHeartbeat): string {
  const time = new Date(heartbeat.timestamp).toLocaleTimeString();
  let status = heartbeat.step_cursor;
  if (heartbeat.progress_pct !== undefined) {
    status += ` (${heartbeat.progress_pct}%)`;
  }
  if (heartbeat.current_file) {
    status += ` - ${heartbeat.current_file}`;
  }
  return `${time}: ${status}`;
}

/**
 * Worker blocked event from telemetry.
 */
interface WorkerBlockedEvent {
  event: "worker-blocked";
  run_id: string;
  child_id: string;
  reason: "needs-approval" | "approval-timeout" | "error" | "unknown";
  approval_type?: "destructive" | "cost" | "security" | "ambiguous" | "external";
  description?: string;
  blocker_id?: string;
  timestamp: string;
}

/**
 * Find latest worker-blocked event for active child.
 */
function findWorkerBlocked(
  telemetryFile: string,
  activeChild: string | null,
): WorkerBlockedEvent | null {
  if (!activeChild || !existsSync(telemetryFile)) return null;

  try {
    const content = readFileSync(telemetryFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]) as WorkerBlockedEvent;
        if (event.event === "worker-blocked" && event.child_id === activeChild) {
          return event;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Format blocked event for display.
 */
function formatBlockedEvent(event: WorkerBlockedEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString();
  let msg = `${time}: ${event.reason}`;
  if (event.approval_type) {
    msg += ` (${event.approval_type})`;
  }
  if (event.description) {
    msg += ` - ${event.description.slice(0, 60)}${event.description.length > 60 ? "..." : ""}`;
  }
  return msg;
}

/**
 * Worker auto-approved event from telemetry.
 */
interface WorkerAutoApprovedEvent {
  event: "worker-auto-approved";
  run_id: string;
  child_id: string;
  approval_type: "destructive" | "cost" | "security" | "ambiguous" | "external";
  description: string;
  timestamp: string;
}

/**
 * Find all auto-approved events for active child.
 */
function findAutoApprovedEvents(
  telemetryFile: string,
  activeChild: string | null,
): WorkerAutoApprovedEvent[] {
  if (!activeChild || !existsSync(telemetryFile)) return [];

  const events: WorkerAutoApprovedEvent[] = [];
  try {
    const content = readFileSync(telemetryFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as WorkerAutoApprovedEvent;
        if (event.event === "worker-auto-approved" && event.child_id === activeChild) {
          events.push(event);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return events;
}

export interface StatusOptions {
  stateFile?: string;
  repoRoot: string;
  json?: boolean;
}

function getCurrentBranch(repoRoot: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function computeStateSha(stateFile: string): string {
  const content = readFileSync(stateFile, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

function findLatestPacket(
  bootstrapDir: string,
  runId?: string,
): { path: string; packet: BootstrapPacket } | null {
  let entries: string[];
  try {
    entries = readdirSync(bootstrapDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const candidates = runId
    ? entries.filter((f) => f.startsWith(`${runId}-`)).sort()
    : entries.sort();
  if (candidates.length === 0) return null;
  const latest = candidates.at(-1)!;
  const fullPath = join(bootstrapDir, latest);
  try {
    const raw = readFileSync(fullPath, "utf-8");
    return { path: fullPath, packet: JSON.parse(raw) as BootstrapPacket };
  } catch {
    return null;
  }
}

export function runLoopStatus(options: StatusOptions): void {
  const { repoRoot } = options;
  const config = loadConfig(repoRoot);
  const bootstrapDir = resolve(
    repoRoot,
    config.loop.bootstrapOutputPath ?? ".polaris/bootstrap",
  );
  const stateFile =
    options.stateFile ?? join(repoRoot, ".polaris", "runs", "current-state.json");

  let state: ReturnType<typeof readState>;
  try {
    const raw = readState(stateFile);
    const errors = validateState(raw);
    if (errors.length > 0) {
      console.error(`current-state.json invalid:\n${errors.join("\n")}`);
      process.exit(1);
    }
    state = raw;
  } catch (err) {
    console.error(
      `Error: cannot read state file ${stateFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const branch = getCurrentBranch(repoRoot);
  const openChildren: string[] = state.open_children ?? [];
  const blockedChildren: string[] = ((state as unknown as Record<string, unknown>)["blocked_children"] as string[] | undefined) ?? [];

  const packetResult = findLatestPacket(bootstrapDir, state.run_id);
  let packetFresh: boolean | null = null;
  let packetPathDisplay: string | null = null;
  let stateSha: string | null = null;

  if (packetResult) {
    try {
      stateSha = computeStateSha(stateFile);
      packetFresh = packetResult.packet.current_state_sha === stateSha;
      packetPathDisplay = packetResult.path.startsWith(repoRoot + "/")
        ? packetResult.path.slice(repoRoot.length + 1)
        : packetResult.path;
    } catch {
      packetFresh = false;
    }
  }

  const isDeadlock =
    openChildren.length > 0 &&
    blockedChildren.length > 0 &&
    openChildren.every((c) => blockedChildren.includes(c));

  // ── Find dispatch evidence for active child ────────────────────────────────
  const dispatchEvidence = findDispatchEvidence(
    repoRoot,
    state.cluster_id,
    state.active_child || null,
    state.open_children_meta,
  );

  // ── Find worker heartbeat for active child ──────────────────────────────────
  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  const telemetryFile = join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
  const workerHeartbeat = findWorkerHeartbeat(telemetryFile, state.active_child || null);
  const workerBlocked = findWorkerBlocked(telemetryFile, state.active_child || null);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          run_id: state.run_id,
          cluster_id: state.cluster_id,
          branch,
          session_type: state.session_type ?? null,
          active_child: state.active_child || null,
          step_cursor: state.step_cursor,
          status: state.status,
          context_budget: state.context_budget,
          completed_children: state.completed_children,
          open_children: openChildren,
          blocked_children: blockedChildren,
          deadlock: isDeadlock,
          bootstrap_packet: packetPathDisplay
            ? { path: packetPathDisplay, fresh: packetFresh }
            : null,
          state_sha: stateSha ? stateSha.slice(0, 12) : null,
          dispatch: dispatchEvidence
            ? {
                child_id: dispatchEvidence.child_id,
                dispatch_status: dispatchEvidence.dispatch_status,
                packet_path: getRelativePath(repoRoot, dispatchEvidence.packet_path),
                expected_result_path: getRelativePath(repoRoot, dispatchEvidence.expected_result_path),
                result_present: dispatchEvidence.result_present,
                provider: dispatchEvidence.provider ?? null,
                dispatched_at: dispatchEvidence.dispatched_at,
              }
            : null,
          worker: workerHeartbeat
            ? {
                child_id: workerHeartbeat.child_id,
                step_cursor: workerHeartbeat.step_cursor,
                last_seen: workerHeartbeat.timestamp,
                progress_pct: workerHeartbeat.progress_pct ?? null,
                files_changed: workerHeartbeat.files_changed ?? null,
                current_file: workerHeartbeat.current_file ?? null,
              }
            : null,
          blocked: workerBlocked
            ? {
                reason: workerBlocked.reason,
                approval_type: workerBlocked.approval_type ?? null,
                description: workerBlocked.description ?? null,
                blocker_id: workerBlocked.blocker_id ?? null,
                timestamp: workerBlocked.timestamp,
              }
            : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  const maxChildren = state.context_budget.max_children_per_session ?? 3;
  const completed = state.context_budget.children_completed;
  const remaining = Math.max(0, maxChildren - completed);

  const lines: string[] = [
    "Polaris Loop Status",
    "───────────────────",
    `Run ID:          ${state.run_id}`,
    `Cluster:         ${state.cluster_id}`,
    `Branch:          ${branch}`,
    `Session type:    ${state.session_type ?? "(not set)"}`,
    `Active child:    ${state.active_child || "(none)"}`,
    `Step cursor:     ${state.step_cursor ?? "(none)"}`,
    `Context budget:  ${completed}/${maxChildren} children completed (${remaining} remaining)`,
    "",
    `Completed:       ${state.completed_children.length > 0 ? state.completed_children.join(", ") + ` (${state.completed_children.length})` : "none"}`,
    `Open:            ${openChildren.length > 0 ? openChildren.join(", ") + ` (${openChildren.length})` : "none"}`,
    `Blocked:         ${blockedChildren.length > 0 ? blockedChildren.join(", ") : "none"}`,
  ];

  if (packetPathDisplay) {
    const freshLabel = packetFresh
      ? "(fresh)"
      : "(stale — re-run `polaris loop continue`)";
    lines.push("");
    lines.push(`Bootstrap packet: ${packetPathDisplay} ${freshLabel}`);
    if (stateSha) {
      const matchLabel = packetFresh
        ? "matches current-state.json ✓"
        : "MISMATCH — state has changed";
      lines.push(`State SHA:        ${stateSha.slice(0, 12)}... (${matchLabel})`);
    }
  } else {
    lines.push("");
    lines.push("Bootstrap packet: (none found)");
  }

  // ── Dispatch evidence ─────────────────────────────────────────────────────
  if (dispatchEvidence) {
    lines.push("");
    lines.push("Dispatch Evidence:");
    lines.push(`  Child:            ${dispatchEvidence.child_id}`);
    lines.push(`  Status:           ${dispatchEvidence.dispatch_status}`);
    lines.push(`  Packet:           ${getRelativePath(repoRoot, dispatchEvidence.packet_path)}`);
    lines.push(`  Expected result:  ${getRelativePath(repoRoot, dispatchEvidence.expected_result_path)}`);
    lines.push(`  Result present:   ${dispatchEvidence.result_present ? "✓ yes" : "✗ no (worker still running)"}`);
    if (dispatchEvidence.provider) {
      lines.push(`  Provider:         ${dispatchEvidence.provider}`);
    }
    lines.push(`  Dispatched at:    ${dispatchEvidence.dispatched_at}`);
  } else if (state.active_child) {
    lines.push("");
    lines.push("⚠ No dispatch evidence found for active child");
    lines.push(`  Child ${state.active_child} is active but no packet/result artifacts exist.`);
    lines.push("  This may indicate a dispatch failure or orphaned state.");
  }

  // ── Worker blocked (needs approval) ───────────────────────────────────────
  if (workerBlocked) {
    lines.push("");
    lines.push("🛑 WORKER BLOCKED - AWAITING APPROVAL");
    lines.push(`  Reason:      ${workerBlocked.reason}`);
    if (workerBlocked.approval_type) {
      lines.push(`  Type:        ${workerBlocked.approval_type}`);
    }
    if (workerBlocked.description) {
      lines.push(`  Details:     ${workerBlocked.description}`);
    }
    if (workerBlocked.blocker_id) {
      lines.push(`  Blocker ID:  ${workerBlocked.blocker_id}`);
    }
    lines.push(`  Blocked at:  ${formatBlockedEvent(workerBlocked)}`);
    lines.push("");
    lines.push("To resolve:");
    lines.push(`  1. Read the packet: cat ${dispatchEvidence?.packet_path ?? "<packet path>"}`);
    lines.push(`  2. Check worker context in the packet instructions`);
    lines.push(`  3. Either:`);
    lines.push(`     a) Approve: Append approval response to telemetry and resume`);
    lines.push(`     b) Abort: Run 'polaris loop abort --child ${state.active_child}' to unblock`);
    lines.push("");
    lines.push("⚠️  DO NOT dispatch another worker until this block is resolved!");
  }

  // ── Worker heartbeat (progress) ───────────────────────────────────────────
  else if (workerHeartbeat) {
    lines.push("");
    lines.push("Worker Progress (last heartbeat):");
    lines.push(`  Step:      ${workerHeartbeat.step_cursor}`);
    if (workerHeartbeat.progress_pct !== undefined) {
      lines.push(`  Progress:  ${workerHeartbeat.progress_pct}%`);
    }
    if (workerHeartbeat.files_changed !== undefined) {
      lines.push(`  Files:     ${workerHeartbeat.files_changed} changed`);
    }
    if (workerHeartbeat.current_file) {
      lines.push(`  Current:   ${workerHeartbeat.current_file}`);
    }
    lines.push(`  Last seen: ${formatHeartbeat(workerHeartbeat)}`);
  } else if (dispatchEvidence && !dispatchEvidence.result_present) {
    lines.push("");
    lines.push("⚠ No worker heartbeats detected");
    lines.push(`  Worker for ${dispatchEvidence.child_id} has not emitted any progress telemetry.`);
    lines.push("  Worker may be:");
    lines.push("    - Starting up (heartbeats start after packet read)");
    lines.push("    - Stuck or crashed (no heartbeats in telemetry.jsonl)");
    lines.push("    - Blocked on approval (old worker version without block telemetry)");
    lines.push("    - Running without heartbeat compliance (old worker version)");
  }

  if (isDeadlock) {
    lines.push("");
    lines.push("⚠ DEADLOCK DETECTED");
    lines.push("Blocked children:");
    for (const c of blockedChildren) {
      lines.push(`  ${c} — blocked`);
    }
    lines.push("Resolve blockers in Linear, then run: polaris loop resume");
  }

  console.log(lines.join("\n"));
}
