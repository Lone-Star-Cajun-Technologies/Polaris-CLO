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

// ── Worker roles ─────────────────────────────────────────────────────────────

export type WorkerRole = 'impl' | 'finalize' | 'preflight' | 'validation';

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
}

/** Type guard: returns true when packet is a compiled WorkerPacket. */
export function isWorkerPacket(packet: BootstrapPacket): packet is WorkerPacket {
  return (
    packet.schema_version === '2.0' &&
    'worker_role' in packet &&
    'instructions' in packet &&
    'lifecycle' in packet
  );
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
}

/**
 * Build a compiled impl worker packet.
 * Workers receive pre-baked steps and do NOT need to read a skill file.
 */
export function compileImplPacket(input: CompileImplPacketInput): WorkerPacket {
  const childRef = input.issueContext?.id ?? input.childId;
  const childTitle = input.issueContext?.title ?? input.childId;

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

  return {
    schema_version: '2.0',
    worker_role: 'impl',
    run_id: input.runId,
    cluster_id: input.clusterId,
    active_child: input.childId,
    state_file: input.stateFile,
    telemetry_file: input.telemetryFile,
    instructions: {
      primary_goal:
        `Execute exactly ONE child: ${childRef} ("${childTitle}"). ` +
        `Commit, update state, and terminate. Do not continue to the next child.`,
      steps,
      allowed_scope: input.allowedScope ?? [],
      validation_commands: input.validationCommands ?? [],
      issue_context: input.issueContext,
    },
    lifecycle: defaultLifecycle(input.maxConcurrentWorkers ?? 1, 'commit-and-exit'),
    return_contract: IMPL_RETURN_CONTRACT,
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
    context: {
      branch: input.branch,
      worker_role: 'preflight',
    },
  };
}
