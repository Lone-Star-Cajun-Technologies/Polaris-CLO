import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PolarisConfig, ExecutionConfig, ExecutionRole, RoleExecutionConfig } from "../config/schema.js";
import { archiveCognitionNotes, type ArchiveCognitionNotesOptions } from "../cognition/index.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./adapters/types.js";
import { compileFinalizePacket, compileStartupPacket, type WorkerPacket, type WorkerRole } from "./worker-packet.js";

export type LifecyclePhase = "startup" | "finalize";

export type LifecycleResultError =
  | "adapter_error"
  | "missing_result"
  | "malformed_result"
  | "mismatched_result"
  | "failed_result";

export interface LifecycleDispatchAdapter extends Pick<ExecutionAdapter, "name"> {
  dispatch(packet: BootstrapPacket, options: DispatchOptions): Promise<DispatchResult>;
}

export interface ResolvedLifecycleProvider {
  adapter: string;
  provider: string;
  model?: string;
}

export interface DispatchLifecyclePhaseOptions {
  phase: LifecyclePhase;
  runId: string;
  clusterId: string;
  branch: string;
  repoRoot?: string;
  stateFile: string;
  telemetryFile: string;
  config: Required<PolarisConfig>;
  adapter: LifecycleDispatchAdapter;
  dryRun?: boolean;
  resultFile?: string;
}

export type LifecycleDispatchResult =
  | {
      ok: true;
      role: WorkerRole;
      provider: string;
      model?: string;
      resultFile: string;
      result: Record<string, unknown>;
    }
  | {
      ok: false;
      role: WorkerRole;
      provider: string;
      model?: string;
      resultFile: string;
      error: LifecycleResultError;
      message: string;
    };

function appendTelemetry(telemetryFile: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}

function roleForPhase(phase: LifecyclePhase): WorkerRole {
  return phase === "startup" ? "startup" : "finalize";
}

function executionRoleForPhase(phase: LifecyclePhase): ExecutionRole {
  return phase === "startup" ? "startup" : "finalizer";
}

function firstConfiguredProvider(execution: ExecutionConfig): string {
  return (
    execution.rotation?.[0] ??
    Object.keys(execution.providers ?? {})[0] ??
    "default"
  );
}

function materializeRoleProvider(
  execution: ExecutionConfig,
  roleName: ExecutionRole,
  roleConfig: RoleExecutionConfig | undefined,
): string {
  const provider = roleConfig?.provider ?? firstConfiguredProvider(execution);
  if (!roleConfig?.command) {
    return provider;
  }

  // Create a new provider key to avoid mutating shared config
  const newProviderKey = `${provider}#${roleName}`;
  const existingConfig = execution.providers?.[provider] ?? {};

  execution.providers = {
    ...(execution.providers ?? {}),
    [newProviderKey]: {
      ...existingConfig,
      command: roleConfig.command,
      args: roleConfig.args,
    },
  };
  return newProviderKey;
}

export function resolveLifecycleProvider(
  config: Required<PolarisConfig>,
  phase: LifecyclePhase,
): ResolvedLifecycleProvider {
  const execution = config.execution;
  const roleName = executionRoleForPhase(phase);
  const roles = execution.roles ?? {};
  const roleConfig = roles[roleName];
  const provider = materializeRoleProvider(execution, roleName, roleConfig);

  return {
    adapter: roleConfig?.adapter ?? execution.adapter ?? "terminal-cli",
    provider,
    model: roleConfig?.model,
  };
}

function resultPath(options: DispatchLifecyclePhaseOptions): string {
  if (options.resultFile) {
    return options.resultFile;
  }
  return join(
    dirname(options.telemetryFile),
    `${options.phase}-result-${randomUUID()}.json`,
  );
}

function compilePacket(
  options: DispatchLifecyclePhaseOptions,
  sealedResultFile: string,
  model: string | undefined,
): WorkerPacket {
  const base = {
    runId: options.runId,
    clusterId: options.clusterId,
    branch: options.branch,
    stateFile: options.stateFile,
    telemetryFile: options.telemetryFile,
    resultFile: sealedResultFile,
  };
  const packet = options.phase === "startup"
    ? compileStartupPacket(base)
    : compileFinalizePacket({
        ...base,
        targetBranch: options.config.finalize?.targetBranch,
      });
  return {
    ...packet,
    context: {
      ...(packet.context ?? {}),
      model,
    },
  };
}

function parseResultFile(path: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: LifecycleResultError; message: string } {
  if (!existsSync(path)) {
    return { ok: false, error: "missing_result", message: `Sealed lifecycle result file is missing: ${path}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "malformed_result", message: `Sealed lifecycle result file is malformed JSON: ${msg}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "malformed_result", message: "Sealed lifecycle result file must contain a JSON object" };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function resolveRepoRoot(options: DispatchLifecyclePhaseOptions): string {
  if (options.repoRoot) {
    return options.repoRoot;
  }

  let current = dirname(options.stateFile);
  while (true) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return dirname(options.stateFile);
    }
    current = parent;
  }
}

function deriveCognitionArchiveOptions(
  result: Record<string, unknown>,
  repoRoot: string,
): ArchiveCognitionNotesOptions | null {
  const candidate = isRecord(result.cognition_archive)
    ? result.cognition_archive
    : isRecord(result.cognition_reconcile)
      ? result.cognition_reconcile
      : result;

  const reconcileId = readString(candidate.reconcile_id) ?? readString(candidate.reconcileId);
  const runId = readString(candidate.run_id) ?? readString(candidate.runId) ?? readString(result.run_id);
  const notesConsumed = readStringArray(
    candidate.notes_consumed
    ?? candidate.notesConsumed
    ?? candidate.note_paths
    ?? candidate.notePaths
    ?? candidate.consumed_notes,
  );

  if (!reconcileId || !runId || notesConsumed.length === 0) {
    return null;
  }

  const status = readString(candidate.archive_status)
    ?? readString(candidate.reconcile_status)
    ?? readString(candidate.result)
    ?? readString(candidate.status);

  return {
    repoRoot,
    reconcileId,
    runId,
    notesConsumed,
    polarisMdUpdated: readBoolean(candidate.polaris_md_updated ?? candidate.polarisMdUpdated),
    summaryMdUpdated: readBoolean(candidate.summary_md_updated ?? candidate.summaryMdUpdated),
    reconciledAt: readString(candidate.reconciled_at) ?? readString(candidate.reconciledAt),
    status:
      candidate.rejected === true
      || candidate.applied === false
      || candidate.accepted === false
      || status === "rejected"
        ? "rejected"
        : "applied",
    rejectionReason:
      readString(candidate.reason)
      ?? readString(candidate.rejection_reason)
      ?? readString(candidate.error_message),
    result,
  };
}

function validateLifecycleResult(
  result: Record<string, unknown>,
  packet: WorkerPacket,
): { ok: true } | { ok: false; error: LifecycleResultError; message: string } {
  if (result["run_id"] !== packet.run_id) {
    return {
      ok: false,
      error: "mismatched_result",
      message: `Lifecycle result run_id mismatch: expected ${packet.run_id}, got ${String(result["run_id"])}`,
    };
  }

  const returnedRole = result["role"];
  if (returnedRole !== undefined && returnedRole !== packet.worker_role) {
    return {
      ok: false,
      error: "mismatched_result",
      message: `Lifecycle result role mismatch: expected ${packet.worker_role}, got ${String(returnedRole)}`,
    };
  }

  if (result["status"] !== "success") {
    return {
      ok: false,
      error: "failed_result",
      message: `Lifecycle result status is not success: ${String(result["status"])}`,
    };
  }

  return { ok: true };
}

export async function dispatchLifecyclePhase(
  options: DispatchLifecyclePhaseOptions,
): Promise<LifecycleDispatchResult> {
  const role = roleForPhase(options.phase);
  const resolved = resolveLifecycleProvider(options.config, options.phase);
  const sealedResultFile = resultPath(options);
  const packet = compilePacket(options, sealedResultFile, resolved.model);

  appendTelemetry(options.telemetryFile, {
    event: "lifecycle-dispatched",
    run_id: options.runId,
    cluster_id: options.clusterId,
    role,
    phase: options.phase,
    adapter: resolved.adapter,
    provider: resolved.provider,
    model: resolved.model ?? null,
    result_file: sealedResultFile,
    timestamp: new Date().toISOString(),
  });

  let dispatchResult: DispatchResult;
  try {
    // Use the resolved adapter instead of options.adapter
    const adapterToUse = options.adapter; // Note: resolved.adapter is the name string, not the adapter instance
    dispatchResult = await adapterToUse.dispatch(packet, {
      provider: resolved.provider,
      dryRun: options.dryRun,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendTelemetry(options.telemetryFile, {
      event: "lifecycle-result-rejected",
      run_id: options.runId,
      role,
      error: "adapter_error",
      message: `Adapter threw exception: ${message}`,
      timestamp: new Date().toISOString(),
    });
    return {
      ok: false,
      role,
      provider: resolved.provider,
      model: resolved.model,
      resultFile: sealedResultFile,
      error: "adapter_error",
      message: `Adapter threw exception: ${message}`,
    };
  }

  if (dispatchResult.exit_code !== 0) {
    const message = dispatchResult.summary ?? `Lifecycle ${role} dispatch exited with code ${dispatchResult.exit_code}`;
    appendTelemetry(options.telemetryFile, {
      event: "lifecycle-result-rejected",
      run_id: options.runId,
      role,
      error: "adapter_error",
      message,
      timestamp: new Date().toISOString(),
    });
    return {
      ok: false,
      role,
      provider: resolved.provider,
      model: resolved.model,
      resultFile: sealedResultFile,
      error: "adapter_error",
      message,
    };
  }

  const parsed = parseResultFile(sealedResultFile);
  if (!parsed.ok) {
    appendTelemetry(options.telemetryFile, {
      event: "lifecycle-result-rejected",
      run_id: options.runId,
      role,
      error: parsed.error,
      message: parsed.message,
      result_file: sealedResultFile,
      timestamp: new Date().toISOString(),
    });
    return {
      ok: false,
      role,
      provider: resolved.provider,
      model: resolved.model,
      resultFile: sealedResultFile,
      error: parsed.error,
      message: parsed.message,
    };
  }

  const validation = validateLifecycleResult(parsed.value, packet);
  if (!validation.ok) {
    appendTelemetry(options.telemetryFile, {
      event: "lifecycle-result-rejected",
      run_id: options.runId,
      role,
      error: validation.error,
      message: validation.message,
      result_file: sealedResultFile,
      timestamp: new Date().toISOString(),
    });
    return {
      ok: false,
      role,
      provider: resolved.provider,
      model: resolved.model,
      resultFile: sealedResultFile,
      error: validation.error,
      message: validation.message,
    };
  }

  try {
    const cognitionArchiveOptions = deriveCognitionArchiveOptions(parsed.value, resolveRepoRoot(options));
    if (cognitionArchiveOptions) {
      archiveCognitionNotes(cognitionArchiveOptions);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendTelemetry(options.telemetryFile, {
      event: "lifecycle-result-rejected",
      run_id: options.runId,
      role,
      error: "failed_result",
      message: `Lifecycle post-validation apply failed: ${message}`,
      result_file: sealedResultFile,
      timestamp: new Date().toISOString(),
    });
    return {
      ok: false,
      role,
      provider: resolved.provider,
      model: resolved.model,
      resultFile: sealedResultFile,
      error: "failed_result",
      message: `Lifecycle post-validation apply failed: ${message}`,
    };
  }

  appendTelemetry(options.telemetryFile, {
    event: "lifecycle-result-accepted",
    run_id: options.runId,
    role,
    result_file: sealedResultFile,
    timestamp: new Date().toISOString(),
  });

  return {
    ok: true,
    role,
    provider: resolved.provider,
    model: resolved.model,
    resultFile: sealedResultFile,
    result: parsed.value,
  };
}
