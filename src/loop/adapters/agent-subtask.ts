/**
 * Agent-subtask adapter — dispatches a worker as a native agent subtask.
 *
 * When the packet is a compiled WorkerPacket (schema_version === '2.0') the
 * adapter uses pre-compiled instructions from `packet.instructions` rather
 * than generating generic instructions from packet metadata. This eliminates
 * per-dispatch skill re-ingestion and reduces worker token burn.
 *
 * The adapter also includes the lifecycle teardown contract in every prompt so
 * the worker session terminates immediately after returning compact JSON.
 */

import { isWorkerPacket } from "../worker-packet.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./types.js";

export interface AgentSubtaskRequest {
  packet: BootstrapPacket;
  instructions: string;
  returnContract: string[];
}

export type AgentSubtaskDispatcher = (
  request: AgentSubtaskRequest
) => Promise<string | Record<string, unknown>>;

/** Fallback return contract for legacy v1 BootstrapPackets. */
const LEGACY_RETURN_CONTRACT = [
  "child_id",
  "status",
  "commit_hash",
  "validation_summary",
  "next_action",
  "warnings",
];

/** Lifecycle teardown preamble appended to every worker prompt. */
const LIFECYCLE_TEARDOWN_NOTICE = [
  `LIFECYCLE CONTRACT (mandatory):`,
  `  - Execute ONLY the single child or task named in this packet.`,
  `  - After writing compact return JSON to stdout, TERMINATE THIS SESSION IMMEDIATELY.`,
  `  - Do NOT select, claim, or execute any other child.`,
  `  - Do NOT continue looping after one child completes.`,
  `  - One worker. One child. One commit. Then exit.`,
].join("\n");

function defaultDispatcher(): AgentSubtaskDispatcher | undefined {
  const host = globalThis as typeof globalThis & {
    __POLARIS_AGENT_SUBTASK_DISPATCH__?: AgentSubtaskDispatcher;
  };
  return host.__POLARIS_AGENT_SUBTASK_DISPATCH__;
}

/**
 * Build instructions for a compiled WorkerPacket.
 * Uses pre-baked steps from packet.instructions — no skill ingestion.
 */
function buildCompiledInstructions(packet: BootstrapPacket): string {
  if (!isWorkerPacket(packet)) {
    return buildLegacyInstructions(packet);
  }

  const { instructions, lifecycle, return_contract, worker_role, run_id, cluster_id } = packet;
  const lines = [
    `POLARIS WORKER — role: ${worker_role}`,
    `Run: ${run_id} | Cluster: ${cluster_id}`,
    ``,
    `OBJECTIVE:`,
    instructions.primary_goal,
    ``,
    `EXECUTION STEPS (pre-compiled — do not re-read skill files):`,
    ...instructions.steps.map((s, i) => `  ${i + 1}. ${s}`),
  ];

  if (instructions.allowed_scope.length > 0) {
    lines.push(``, `ALLOWED SCOPE:`, ...instructions.allowed_scope.map((s) => `  ${s}`));
  }

  if (instructions.validation_commands.length > 0) {
    lines.push(
      ``,
      `VALIDATION COMMANDS (run before returning):`,
      ...instructions.validation_commands.map((c) => `  ${c}`),
    );
  }

  lines.push(
    ``,
    `REQUIRED RETURN FIELDS: ${return_contract.join(", ")}`,
    ``,
    LIFECYCLE_TEARDOWN_NOTICE,
    ``,
    `Session must terminate after max_concurrent=${lifecycle.max_concurrent} active workers.`,
    `cleanup_on_exit: ${lifecycle.cleanup_on_exit}`,
  );

  return lines.join("\n");
}

/**
 * Build instructions for a legacy v1 BootstrapPacket.
 * Kept for backward compat; generates generic instructions from packet metadata.
 */
function buildLegacyInstructions(packet: BootstrapPacket): string {
  return [
    `You are the dedicated Polaris worker subagent for exactly one child issue: ${packet.active_child}.`,
    `Run id: ${packet.run_id}`,
    `Parent cluster: ${packet.cluster_id}`,
    `Execution mode: ephemeral agent subtask.`,
    ``,
    `Use the bootstrap packet below as the durable continuation boundary.`,
    `Execute only ${packet.active_child}, update the state and telemetry files named in the packet, and return only compact JSON.`,
    `Do not include a transcript or continue to another child.`,
    ``,
    `Required return fields: ${LEGACY_RETURN_CONTRACT.join(", ")}`,
    ``,
    LIFECYCLE_TEARDOWN_NOTICE,
    ``,
    `Bootstrap packet:`,
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

function normalizeSummary(value: string | Record<string, unknown>): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function validateSummary(summary: string, packet: BootstrapPacket): string | null {
  try {
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    // For finalize/preflight workers active_child is "" — skip child_id check.
    if (packet.active_child) {
      const returnedChild = parsed.child_id ?? parsed.active_child;
      if (returnedChild !== packet.active_child) {
        return `Native subtask returned mismatched child_id: expected ${packet.active_child}, got ${String(returnedChild)}`;
      }
    }
    if (!["done", "blocked", "error", "success", "failure"].includes(String(parsed.status))) {
      return `Native subtask returned invalid status: ${String(parsed.status)}`;
    }
    return null;
  } catch {
    return "Native subtask returned malformed compact JSON";
  }
}

/** Returns the return contract for this packet (compiled or legacy). */
function returnContractFor(packet: BootstrapPacket): string[] {
  return isWorkerPacket(packet) ? packet.return_contract : LEGACY_RETURN_CONTRACT;
}

export class AgentSubtaskAdapter implements ExecutionAdapter {
  readonly name = 'agent-subtask';

  constructor(private readonly dispatcher: AgentSubtaskDispatcher | undefined = defaultDispatcher()) {}

  async dispatch(packet: BootstrapPacket, options: DispatchOptions): Promise<DispatchResult> {
    const label = packet.active_child || (isWorkerPacket(packet) ? packet.worker_role : 'worker');
    const commandRun = `agent-subtask:${label}`;
    const provider = options.provider || "agent-subtask";

    if (!this.dispatcher) {
      const error =
        "Native ephemeral agent subtask dispatch is unavailable in this host environment. " +
        "Use manual handoff or a configured terminal-cli adapter.";
      return {
        exit_code: 1,
        provider_used: provider,
        command_run: commandRun,
        summary: error,
        stderr: error,
      };
    }

    if (isWorkerPacket(packet) && packet.worker_role === 'impl') {
      const allowed = Array.isArray(packet.instructions?.allowed_scope) ? packet.instructions.allowed_scope : [];
      if (allowed.length === 0) {
        const blockedMsg = `Worker blocked: impl packet for ${packet.active_child} has empty allowed_scope. Foreman must provide scope or approve override.`;
        return {
          exit_code: 1,
          provider_used: provider,
          command_run: commandRun,
          summary: JSON.stringify({
            child_id: packet.active_child,
            status: "blocked",
            validation_summary: blockedMsg,
            next_action: "escalate",
            warnings: ["empty-allowed-scope"],
          }),
          stderr: blockedMsg,
        };
      }
    }

    if (options.dryRun) {
      const childId = packet.active_child || 'no-child';
      return {
        exit_code: 0,
        provider_used: provider,
        command_run: commandRun,
        summary: JSON.stringify({
          child_id: childId,
          status: "done",
          validation_summary: "dry-run: native ephemeral agent subtask dispatch not executed",
          next_action: "resume-parent",
          warnings: ["dry-run"],
        }),
      };
    }

    const instructions = buildCompiledInstructions(packet);
    const returnContract = returnContractFor(packet);

    try {
      const rawSummary = await this.dispatcher({
        packet,
        instructions,
        returnContract,
      });
      const summary = normalizeSummary(rawSummary);
      const validationError = validateSummary(summary, packet);
      if (validationError) {
        return {
          exit_code: 1,
          provider_used: provider,
          command_run: commandRun,
          summary: validationError,
          stderr: validationError,
        };
      }
      return {
        exit_code: 0,
        provider_used: provider,
        command_run: commandRun,
        summary,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exit_code: 1,
        provider_used: provider,
        command_run: commandRun,
        summary: `Native ephemeral agent subtask dispatch failed: ${msg}`,
        stderr: msg,
      };
    }
  }
}
