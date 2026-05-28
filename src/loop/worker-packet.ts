/**
 * Compiled worker packet for delegated-chain execution.
 *
 * Instead of workers ingesting the full Polaris skill on each dispatch,
 * the parent compiles a WorkerPacket containing pre-baked instructions,
 * allowed scope, and lifecycle teardown rules. Workers read the packet
 * and execute immediately — no skill re-ingestion required.
 *
 * WorkerPacket extends BootstrapPacket so all existing adapters that
 * accept BootstrapPacket transparently accept WorkerPacket.
 */

import type { BootstrapPacket } from "./adapters/types.js";
import {
  buildPromptFromPacketInput,
  type WorkerPromptMode,
  type WorkerPromptMetrics,
} from "./worker-prompt.js";

// ── Worker roles ─────────────────────────────────────────────────────────────

export type WorkerRole =
  | 'startup'
  | 'impl'
  | 'finalize'
  | 'preflight'
  | 'validation'
  | 'repair'
  | 'analysis'
  | 'librarian';

// ── Compiled instructions ─────────────────────────────────────────────────────

export interface IssueContext {
  id: string;
  title: string;
  key_requirements: string[];
}

export interface CompiledSteps {
  /** High-level objective for this worker. Replaces full skill ingestion. */
  primary_goal: string;
  /** Ordered execution steps — fully pre-resolved. Workers execute directly. */
  steps: string[];
  /** Files or glob patterns this worker is allowed to modify. */
  allowed_scope: string[];
  /** Commands to verify success before returning compact JSON. */
  validation_commands: string[];
  /** Pre-fetched issue context — workers do not re-fetch from Linear. */
  issue_context?: IssueContext;
}

// ── Lifecycle contract ────────────────────────────────────────────────────────

export interface WorkerLifecycleContract {
  /** Session MUST terminate after returning compact JSON. */
  terminate_after_completion: true;
  /** Maximum workers the parent allows concurrently. */
  max_concurrent: number;
  /** Cleanup behaviour at worker exit. */
  cleanup_on_exit: 'commit-and-exit' | 'exit-immediately';
}

// ── Sealed result file ────────────────────────────────────────────────────────

/**
 * When a worker completes, it MUST write a result file with this shape.
 * The path is specified in the SealedResultFileContract.
 */
export interface SealedWorkerResult {
  /** Matches the run_id from the dispatched WorkerPacket. */
  run_id: string;

  /** Matches the active_child from the dispatched WorkerPacket. */
  child_id: string;

  /** Final status of the worker execution. */
  status: "success" | "failure" | "in-progress";

  /** The git commit hash produced by this worker. Only for 'impl' role. */
  commit?: string;

  /** For 'impl' role, validation results. */
  validation?: unknown;

  /** For 'finalize' role, the PR URL. */
  pr_url?: string;

  /** If status is 'failure', a descriptive error message. */
  error_message?: string;

  /** Any other fields from the return_contract. */
  [key: string]: unknown;
}

/**
 * Contract for the sealed result file a worker MUST write on completion.
 */
export interface SealedResultFileContract {
  /**
   * Path where the worker MUST write its SealedWorkerResult.
   * If not present, worker returns compact JSON to stdout (legacy).
   */
  result_file: string;
}

// ── WorkerPacket ──────────────────────────────────────────────────────────────

/**
 * Compiled worker packet — extends BootstrapPacket so all existing adapters
 * accept it without changes.
 *
 * When an adapter receives a WorkerPacket it SHOULD use
 * `instructions.primary_goal` and `instructions.steps` as the worker prompt
 * rather than generating instructions from raw skill files.
 */
export interface WorkerPacket extends BootstrapPacket {
  /** Distinguishes v2 compiled packets from v1 BootstrapPackets. */
  schema_version: '2.0';
  worker_role: WorkerRole;
  /** Pre-compiled execution instructions. */
  instructions: CompiledSteps;
  /** Lifecycle teardown contract attached to every dispatch. */
  lifecycle: WorkerLifecycleContract;
  /** Fields the worker MUST include in its compact return JSON. */
  return_contract: string[];
  /** Optional contract for writing a sealed result file instead of stdout. */
  result_file_contract?: SealedResultFileContract;
  /** Prompt dispatch mode: compact (default for narrow children) or full. */
  prompt_mode: WorkerPromptMode;
  /** Lightweight prompt size metrics recorded at compile time. */
  prompt_metrics: WorkerPromptMetrics;
}

/** Type guard: returns true when packet is a compiled WorkerPacket. */
export function isWorkerPacket(packet: BootstrapPacket): packet is WorkerPacket {
  const p = packet as unknown as Record<string, unknown>;
  const isV2 =
    packet.schema_version === '2.0' &&
    typeof p['worker_role'] === 'string' &&
    typeof p['instructions'] === 'object' && p['instructions'] !== null && !Array.isArray(p['instructions']) &&
    typeof p['lifecycle'] === 'object' && p['lifecycle'] !== null &&
    Array.isArray(p['return_contract']);

  if (!isV2) {
    return false;
  }

  // If result_file_contract is present, validate its shape.
  if ('result_file_contract' in p) {
    const rfc = p.result_file_contract;
    // undefined means no contract — that's valid (resultFile was not specified)
    if (rfc !== undefined) {
      if (rfc === null || typeof rfc !== 'object' || Array.isArray(rfc)) {
        return false;
      }
      const rfcRecord = rfc as Record<string, unknown>;
      return typeof rfcRecord.result_file === 'string';
    }
  }

  return true;
}

// ── Return contracts ──────────────────────────────────────────────────────────

export const IMPL_RETURN_CONTRACT: string[] = [
  'child_id',
  'status',
  'commit',
  'validation',
  'next_recommended_action',
];

export const FINALIZE_RETURN_CONTRACT: string[] = [
  'run_id',
  'status',
  'pr_url',
  'commit',
  'next_recommended_action',
];

export const PREFLIGHT_RETURN_CONTRACT: string[] = [
  'status',
  'checks_passed',
  'blockers',
  'next_recommended_action',
];

export const STARTUP_RETURN_CONTRACT: string[] = [
  'run_id',
  'status',
  'execution_plan',
  'first_child',
  'next_recommended_action',
];

// ── Lifecycle helpers ─────────────────────────────────────────────────────────

function defaultLifecycle(
  maxConcurrent: number,
  cleanupOnExit: WorkerLifecycleContract['cleanup_on_exit'],
): WorkerLifecycleContract {
  return {
    terminate_after_completion: true,
    max_concurrent: maxConcurrent,
    cleanup_on_exit: cleanupOnExit,
  };
}

// ── Impl worker packet compiler ───────────────────────────────────────────────

export interface CompileStartupPacketInput {
  runId: string;
  clusterId: string;
  branch: string;
  stateFile: string;
  telemetryFile: string;
  maxConcurrentWorkers?: number;
  resultFile?: string;
}

/**
 * Build a compiled startup worker packet.
 * Startup workers prepare tracker/graph/config/run-state evidence; the parent
 * consumes the sealed result before selecting the first implementation child.
 */
export function compileStartupPacket(input: CompileStartupPacketInput): WorkerPacket {
  const steps = [
    `Sync or import tracker data for cluster ${input.clusterId} when configured.`,
    `Build or refresh the local execution graph for ${input.clusterId}.`,
    `Validate Polaris config and the execution provider roster.`,
    `Prepare run ledger/state evidence for ${input.runId}.`,
    `Select the execution plan and first child without implementing it.`,
    `Write compact startup JSON to stdout (fields: ${STARTUP_RETURN_CONTRACT.join(', ')}).`,
    `TERMINATE SESSION IMMEDIATELY.`,
  ];

  return {
    schema_version: '2.0',
    worker_role: 'startup',
    run_id: input.runId,
    cluster_id: input.clusterId,
    active_child: '',
    state_file: input.stateFile,
    telemetry_file: input.telemetryFile,
    instructions: {
      primary_goal:
        `Startup cluster ${input.clusterId} for run ${input.runId}: sync tracker data, refresh graph, ` +
        `validate config/providers, and return the first executable dispatch plan.`,
      steps,
      allowed_scope: [
        '.taskchain_artifacts/**',
        '.polaris/runs/**',
        '.polaris/map/**',
      ],
      validation_commands: [],
    },
    lifecycle: defaultLifecycle(input.maxConcurrentWorkers ?? 1, 'commit-and-exit'),
    return_contract: STARTUP_RETURN_CONTRACT,
    prompt_mode: 'full',
    prompt_metrics: { mode: 'full', char_count: 0, estimated_tokens: 0 },
    result_file_contract: input.resultFile ? { result_file: input.resultFile } : undefined,
    context: {
      branch: input.branch,
      worker_role: 'startup',
    },
  };
}

export interface CompileImplPacketInput {
  runId: string;
  clusterId: string;
  childId: string;
  branch: string;
  stateFile: string;
  telemetryFile: string;
  issueContext?: IssueContext;
  allowedScope?: string[];
  validationCommands?: string[];
  maxConcurrentWorkers?: number;
  resultFile?: string;
  /**
   * Prompt dispatch mode. Defaults to 'compact' for narrow children.
   * Pass 'full' for cross-cutting or architectural children.
   */
  promptMode?: WorkerPromptMode;
}

/**
 * Build a compiled impl worker packet.
 * Workers receive pre-baked steps and do NOT need to read a skill file.
 */
export function compileImplPacket(input: CompileImplPacketInput): WorkerPacket {
  const childRef = input.issueContext?.id ?? input.childId;
  const childTitle = input.issueContext?.title ?? input.childId;
  const promptMode = input.promptMode ?? 'compact';

  const requirementLines =
    input.issueContext?.key_requirements.map((r, i) => `   ${i + 1}. ${r}`) ?? [];

  const steps = [
    `Verify: read ${input.stateFile} and confirm active_child === "${input.childId}".`,
    `Implement ${childRef}: "${childTitle}".`,
    ...(requirementLines.length > 0 ? [`Requirements:`, ...requirementLines] : []),
    `Run validation commands and confirm all pass.`,
    `Create exactly ONE git commit: [${input.childId}] ${childTitle}.`,
    `Update ${input.stateFile}: move "${input.childId}" from open_children to completed_children.`,
    `Append a telemetry event to ${input.telemetryFile}.`,
    `Write compact return JSON to stdout (fields: ${IMPL_RETURN_CONTRACT.join(', ')}).`,
    `TERMINATE SESSION IMMEDIATELY. Do not select or execute the next child.`,
  ];

  // Build compact or full prompt; primary_goal uses the structured template.
  const promptResult = buildPromptFromPacketInput({
    issueId: input.childId,
    title: childTitle,
    worktree: '.',
    branch: input.branch,
    stateFile: input.stateFile,
    telemetryFile: input.telemetryFile,
    issueContext: input.issueContext,
    allowedScope: input.allowedScope,
    validationCommands: input.validationCommands,
    mode: promptMode,
  });

  return {
    schema_version: '2.0',
    worker_role: 'impl',
    run_id: input.runId,
    cluster_id: input.clusterId,
    active_child: input.childId,
    state_file: input.stateFile,
    telemetry_file: input.telemetryFile,
    instructions: {
      primary_goal: promptResult.prompt,
      steps,
      allowed_scope: input.allowedScope ?? [],
      validation_commands: input.validationCommands ?? [],
      issue_context: input.issueContext,
    },
    lifecycle: defaultLifecycle(input.maxConcurrentWorkers ?? 1, 'commit-and-exit'),
    return_contract: IMPL_RETURN_CONTRACT,
    prompt_mode: promptMode,
    prompt_metrics: promptResult.metrics,
    result_file_contract: input.resultFile ? { result_file: input.resultFile } : undefined,
    context: {
      branch: input.branch,
      worker_role: 'impl',
    },
  };
}

// ── Finalize worker packet compiler ──────────────────────────────────────────

export interface CompileFinalizePacketInput {
  runId: string;
  clusterId: string;
  branch: string;
  stateFile: string;
  telemetryFile: string;
  targetBranch?: string;
  maxConcurrentWorkers?: number;
  resultFile?: string;
}

/**
 * Build a compiled finalize worker packet.
 * Delegates the 12-step delivery sequence to a disposable finalize worker.
 */
export function compileFinalizePacket(input: CompileFinalizePacketInput): WorkerPacket {
  const targetBranch = input.targetBranch ?? 'main';

  const steps = [
    `Read ${input.stateFile} — confirm status is "cluster-complete" (open_children is empty).`,
    `Run polaris map validate.`,
    `Run polaris finalize run --state-file ${input.stateFile} --skip-delivery (local validation only).`,
    `Push branch "${input.branch}" to origin.`,
    `Create PR targeting "${targetBranch}".`,
    `Write PR URL to ${input.stateFile}.`,
    `Update Linear parent issue ${input.clusterId} to Done.`,
    `Append finalize telemetry events to ${input.telemetryFile}.`,
    `Write compact finalize JSON to stdout (fields: ${FINALIZE_RETURN_CONTRACT.join(', ')}).`,
    `TERMINATE SESSION IMMEDIATELY.`,
  ];

  return {
    schema_version: '2.0',
    worker_role: 'finalize',
    run_id: input.runId,
    cluster_id: input.clusterId,
    active_child: '',
    state_file: input.stateFile,
    telemetry_file: input.telemetryFile,
    instructions: {
      primary_goal:
        `Finalize cluster ${input.clusterId} on branch "${input.branch}" and create PR targeting "${targetBranch}". ` +
        `This is a delivery-only pass — no implementation work.`,
      steps,
      allowed_scope: ['**/*'],
      validation_commands: ['npm run build', 'npm test'],
    },
    lifecycle: defaultLifecycle(input.maxConcurrentWorkers ?? 1, 'commit-and-exit'),
    return_contract: FINALIZE_RETURN_CONTRACT,
    prompt_mode: 'full',
    prompt_metrics: { mode: 'full', char_count: 0, estimated_tokens: 0 },
    result_file_contract: input.resultFile ? { result_file: input.resultFile } : undefined,
    context: {
      branch: input.branch,
      worker_role: 'finalize',
      target_branch: targetBranch,
    },
  };
}

// ── Preflight worker packet compiler ─────────────────────────────────────────

export interface CompilePreflightPacketInput {
  runId: string;
  clusterId: string;
  branch: string;
  stateFile: string;
  telemetryFile: string;
  maxConcurrentWorkers?: number;
  resultFile?: string;
}

/**
 * Build a compiled preflight worker packet.
 * Preflight validates state, branch, and map integrity before the first impl dispatch.
 */
export function compilePreflightPacket(input: CompilePreflightPacketInput): WorkerPacket {
  const steps = [
    `Read ${input.stateFile} and validate schema (required fields, correct types).`,
    `Confirm current git branch is "${input.branch}".`,
    `Confirm working tree has no unexpected dirty files.`,
    `Confirm active_child is empty (no orphaned worker claims in state).`,
    `Run polaris map validate.`,
    `Write compact preflight JSON to stdout (fields: ${PREFLIGHT_RETURN_CONTRACT.join(', ')}).`,
    `TERMINATE SESSION IMMEDIATELY.`,
  ];

  return {
    schema_version: '2.0',
    worker_role: 'preflight',
    run_id: input.runId,
    cluster_id: input.clusterId,
    active_child: '',
    state_file: input.stateFile,
    telemetry_file: input.telemetryFile,
    instructions: {
      primary_goal:
        `Preflight check for cluster ${input.clusterId}: validate state integrity, branch, and map before impl dispatch.`,
      steps,
      allowed_scope: [],
      validation_commands: [],
    },
    lifecycle: defaultLifecycle(input.maxConcurrentWorkers ?? 1, 'exit-immediately'),
    return_contract: PREFLIGHT_RETURN_CONTRACT,
    prompt_mode: 'full',
    prompt_metrics: { mode: 'full', char_count: 0, estimated_tokens: 0 },
    result_file_contract: input.resultFile ? { result_file: input.resultFile } : undefined,
    context: {
      branch: input.branch,
      worker_role: 'preflight',
    },
  };
}
