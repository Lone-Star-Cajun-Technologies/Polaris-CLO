import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, normalize, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readState, validateState, type ChildDispatchRecord, type DispatchMode, type WorkerRuntimeState, type WorkerAssignmentRecord } from "./checkpoint.js";
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
  /** Dispatch mode - delegated or direct-worker */
  dispatch_mode?: DispatchMode;
  /** Runtime state - detailed lifecycle tracking */
  runtime_state?: WorkerRuntimeState;
  /** Last heartbeat timestamp (if any) */
  last_heartbeat_at?: string;
  /** Last known step from heartbeat */
  last_heartbeat_step?: string;
  /** Worker assignment record (for delegated mode) */
  worker_assignment?: WorkerAssignmentRecord;
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
      dispatch_mode: dispatchRecord.dispatch_mode,
      runtime_state: dispatchRecord.runtime_state,
      last_heartbeat_at: dispatchRecord.last_heartbeat_at,
      last_heartbeat_step: dispatchRecord.last_heartbeat_step,
      worker_assignment: dispatchRecord.worker_assignment,
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

interface RuntimeArtifactSurface {
  path: string;
  role: string;
  classification: "canonical" | "compatibility" | "derived" | "debug" | "legacy";
  exists: boolean;
}

function classifyCurrentStateSurface(repoRoot: string, stateFile: string): RuntimeArtifactSurface {
  const relativePath = getRelativePath(repoRoot, stateFile);
  const normalizedPath = relativePath.split(sep).join("/");
  const targetPath = join(".polaris", "runs", "current-state.json").split(sep).join("/");

  if (normalizedPath === targetPath) {
    return {
      path: relativePath,
      role: "legacy/transitional current-state snapshot",
      classification: "legacy",
      exists: existsSync(stateFile),
    };
  }

  return {
    path: relativePath,
    role: "compatibility/debug current-state surface",
    classification: "compatibility",
    exists: existsSync(stateFile),
  };
}

function buildRuntimeArtifactSurfaces(
  repoRoot: string,
  clusterId: string,
  stateFile: string,
  bootstrapDir: string,
  telemetryFile: string,
): {
  cluster_state: RuntimeArtifactSurface;
  current_state: RuntimeArtifactSurface;
  bootstrap_packets: RuntimeArtifactSurface;
  telemetry: RuntimeArtifactSurface;
} {
  const clusterStatePath = join(repoRoot, ".polaris", "clusters", clusterId, "cluster-state.json");
  return {
    cluster_state: {
      path: getRelativePath(repoRoot, clusterStatePath),
      role: "live execution authority",
      classification: "canonical",
      exists: existsSync(clusterStatePath),
    },
    current_state: classifyCurrentStateSurface(repoRoot, stateFile),
    bootstrap_packets: {
      path: getRelativePath(repoRoot, bootstrapDir),
      role: "sealed handoff snapshots",
      classification: "derived",
      exists: existsSync(bootstrapDir),
    },
    telemetry: {
      path: getRelativePath(repoRoot, telemetryFile),
      role: "append-only audit/debug stream",
      classification: "debug",
      exists: existsSync(telemetryFile),
    },
  };
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

/**
 * States that indicate the worker has acknowledged the dispatch packet.
 * These are states at or after the "acknowledged" lifecycle stage.
 */
const ACKNOWLEDGED_OR_LATER_STATES: ReadonlySet<string> = new Set([
  "acknowledged",
  "running",
  "waiting-for-approval",
  "blocked",
  "completed",
  "failed",
  "orphaned",
]);

/**
 * Worker acknowledged telemetry event (minimal shape for scanning).
 */
interface WorkerAcknowledgedEvent {
  event: "worker-acknowledged";
  dispatch_id?: string;
  run_id?: string;
  child_id?: string;
}

/**
 * Check whether the worker for the given dispatch has acknowledged the packet.
 *
 * Primary: checks runtime_state on the ChildDispatchRecord against the set of
 * states at or after "acknowledged".
 * Fallback: scans telemetry log for a worker-acknowledged event with a matching
 * dispatch_id.
 *
 * Returns false for unknown dispatch_id (does not throw).
 */
export function hasWorkerAcknowledged(
  dispatch_id: string,
  state: ReturnType<typeof readState>,
  telemetryFile?: string,
): boolean {
  // Search all open_children_meta for a matching dispatch record
  const meta = state.open_children_meta ?? {};
  for (const childKey of Object.keys(meta)) {
    const record = meta[childKey]?.dispatch_record;
    if (record && record.dispatch_id === dispatch_id) {
      // Primary check: runtime_state
      if (record.runtime_state && ACKNOWLEDGED_OR_LATER_STATES.has(record.runtime_state)) {
        return true;
      }
      break; // Found the record but not acknowledged by state; try telemetry fallback
    }
  }

  // Fallback: scan telemetry log for worker-acknowledged event
  if (telemetryFile && existsSync(telemetryFile)) {
    try {
      const content = readFileSync(telemetryFile, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as WorkerAcknowledgedEvent;
          if (event.event === "worker-acknowledged" && event.dispatch_id === dispatch_id) {
            return true;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return false;
}

/**
 * Check whether a session can be attached to the worker for the given dispatch.
 *
 * Returns true only when attachment_capable === true AND session_id is non-null/undefined
 * on the ChildDispatchRecord. Does NOT scan telemetry.
 *
 * Returns false for unknown dispatch_id (does not throw).
 */
export function canSessionBeAttached(
  dispatch_id: string,
  state: ReturnType<typeof readState>,
): boolean {
  const meta = state.open_children_meta ?? {};
  for (const childKey of Object.keys(meta)) {
    const record = meta[childKey]?.dispatch_record;
    if (record && record.dispatch_id === dispatch_id) {
      return record.attachment_capable === true &&
        record.session_id !== null &&
        record.session_id !== undefined;
    }
  }
  return false;
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
  const runtimeArtifacts = buildRuntimeArtifactSurfaces(
    repoRoot,
    state.cluster_id,
    stateFile,
    bootstrapDir,
    telemetryFile,
  );
  const workerHeartbeat = findWorkerHeartbeat(telemetryFile, state.active_child || null);
  const workerBlocked = findWorkerBlocked(telemetryFile, state.active_child || null);

  // ── Role context from active dispatch record ───────────────────────────────
  const activeDispatch = state.open_children_meta?.[state.active_child]?.dispatch_record;

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
          runtime_artifacts: runtimeArtifacts,
          state_sha: stateSha ? stateSha.slice(0, 12) : null,
          role_context: activeDispatch?.role ? {
            role: activeDispatch.role,
            role_authority: activeDispatch.role_authority ?? null,
            may_implement: activeDispatch.may_implement ?? null,
            session_type: activeDispatch.session_type ?? null,
          } : null,
          dispatch: dispatchEvidence
            ? {
                child_id: dispatchEvidence.child_id,
                dispatch_status: dispatchEvidence.dispatch_status,
                packet_path: getRelativePath(repoRoot, dispatchEvidence.packet_path),
                expected_result_path: getRelativePath(repoRoot, dispatchEvidence.expected_result_path),
                result_present: dispatchEvidence.result_present,
                provider: dispatchEvidence.provider ?? null,
                dispatched_at: dispatchEvidence.dispatched_at,
                dispatch_mode: dispatchEvidence.dispatch_mode ?? null,
                // Derive runtime state: delegated mode defaults to "delegated", else "unknown"
                runtime_state: dispatchEvidence.runtime_state ??
                  ((dispatchEvidence.dispatch_mode ?? "delegated") === "delegated" ? "delegated" : "unknown"),
                last_heartbeat_at: dispatchEvidence.last_heartbeat_at ?? null,
                last_heartbeat_step: dispatchEvidence.last_heartbeat_step ?? null,
                worker_assignment: dispatchEvidence.worker_assignment ?? null,
                worker_acknowledged: hasWorkerAcknowledged(dispatchEvidence.dispatch_id, state, telemetryFile),
                session_attachable: canSessionBeAttached(dispatchEvidence.dispatch_id, state),
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

  // ── Role block ────────────────────────────────────────────────────────────
  const roleLines: string[] = [];
  if (activeDispatch?.role) {
    const roleName = activeDispatch.role.charAt(0).toUpperCase() + activeDispatch.role.slice(1);
    const authorityLabel = activeDispatch.role_authority ?? "(unknown)";
    const mayImpl = activeDispatch.may_implement === true ? "Yes" : activeDispatch.may_implement === false ? "No" : "(unknown)";
    const mayAssign = activeDispatch.role === "foreman" ? "Yes" : activeDispatch.role === "worker" ? "No" : "(unknown)";
    roleLines.push("", "Role Context:");
    roleLines.push(`  Role:               ${roleName}`);
    roleLines.push(`  Authority:          ${authorityLabel}`);
    roleLines.push(`  May Implement:      ${mayImpl}`);
    roleLines.push(`  May Assign Workers: ${mayAssign}`);
  }

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

  lines.push(...roleLines);
  lines.push("");
  lines.push("Runtime Artifacts:");
  lines.push(`  Cluster state:    ${runtimeArtifacts.cluster_state.path} (${runtimeArtifacts.cluster_state.classification}; ${runtimeArtifacts.cluster_state.role}; ${runtimeArtifacts.cluster_state.exists ? "exists" : "missing"})`);
  lines.push(`  Current state:    ${runtimeArtifacts.current_state.path} (${runtimeArtifacts.current_state.classification}; ${runtimeArtifacts.current_state.role}; ${runtimeArtifacts.current_state.exists ? "exists" : "missing"})`);
  lines.push(`  Bootstrap dir:    ${runtimeArtifacts.bootstrap_packets.path} (${runtimeArtifacts.bootstrap_packets.classification}; ${runtimeArtifacts.bootstrap_packets.role}; ${runtimeArtifacts.bootstrap_packets.exists ? "exists" : "missing"})`);
  lines.push(`  Telemetry:        ${runtimeArtifacts.telemetry.path} (${runtimeArtifacts.telemetry.classification}; ${runtimeArtifacts.telemetry.role}; ${runtimeArtifacts.telemetry.exists ? "exists" : "missing"})`);

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
    // Show dispatch mode and runtime state
    const mode = dispatchEvidence.dispatch_mode ?? "delegated";
    // Derive runtime state: for delegated mode without explicit state, default to "delegated"
    // for direct-worker mode without explicit state, default to "unknown"
    const runtimeState = dispatchEvidence.runtime_state ??
      (mode === "delegated" ? "delegated" : "unknown");
    lines.push(`  Mode:             ${mode}`);
    lines.push(`  Runtime state:    ${runtimeState}`);

    if (dispatchEvidence.provider) {
      lines.push(`  Provider:         ${dispatchEvidence.provider}`);
    }

    // Show mode-specific messaging
    if (mode === "delegated") {
      lines.push(`  Visibility:       limited (orchestrator-owned)`);

      // Show worker assignment info if available
      if (dispatchEvidence.worker_assignment) {
        const wa = dispatchEvidence.worker_assignment;
        lines.push(`  Assignment:       ${wa.assignment_type}`);
        if (wa.assignment_type === "subagent" && wa.subagent_session_id) {
          lines.push(`  Subagent session: ${wa.subagent_session_id}`);
        } else if (wa.assignment_type === "external-process" && wa.process_pid) {
          lines.push(`  Process PID:      ${wa.process_pid}`);
        } else if (wa.assignment_type === "pending-escalation" && wa.escalation_reason) {
          lines.push(`  Escalation:       ${wa.escalation_reason}`);
        }
        lines.push(`  Assigned at:      ${wa.assigned_at}`);
      } else {
        // No assignment yet - Foreman seal compliance notice
        lines.push(`  Assignment:       (none yet)`);
      }
    }

    lines.push(`  Packet:           ${getRelativePath(repoRoot, dispatchEvidence.packet_path)}`);
    lines.push(`  Expected result:  ${getRelativePath(repoRoot, dispatchEvidence.expected_result_path)}`);
    lines.push(`  Result present:   ${dispatchEvidence.result_present ? "✓ yes" : "✗ no"}`);

    // Show heartbeat info if available
    if (dispatchEvidence.last_heartbeat_at) {
      const heartbeatAge = Math.round((Date.now() - new Date(dispatchEvidence.last_heartbeat_at).getTime()) / 1000);
      lines.push(`  Last heartbeat:   ${heartbeatAge}s ago${dispatchEvidence.last_heartbeat_step ? ` (${dispatchEvidence.last_heartbeat_step})` : ""}`);
    } else if (mode === "direct-worker" && !dispatchEvidence.result_present) {
      lines.push(`  Last heartbeat:   (none yet)`);
    }

    lines.push(`  Dispatched at:    ${dispatchEvidence.dispatched_at}`);

    // Show state-specific warnings
    if (runtimeState === "waiting-for-approval") {
      lines.push("");
      lines.push("  ⏳ Waiting for approval - worker is blocked");
    } else if (runtimeState === "orphaned") {
      lines.push("");
      lines.push("  ⚠ Worker appears orphaned - no recent heartbeats");
    } else if (runtimeState === "blocked") {
      lines.push("");
      lines.push("  ⚠ Worker blocked - no heartbeat within expected interval");
    }

    // Foreman seal compliance notice for delegated mode without assignment
    if (mode === "delegated" && !dispatchEvidence.worker_assignment && !dispatchEvidence.result_present) {
      lines.push("");
      lines.push("  📋 Foreman Seal Compliance:");
      lines.push("     Foreman coordinates; Foreman does NOT implement.");
      lines.push("     A worker must be assigned or escalated.");
      if (!dispatchEvidence.worker_assignment) {
        lines.push("");
        lines.push("     ⚠️  No worker assigned - implementation would violate seal");
        lines.push("     Action: Assign worker or escalate to manual dispatch");
      }
    }
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
