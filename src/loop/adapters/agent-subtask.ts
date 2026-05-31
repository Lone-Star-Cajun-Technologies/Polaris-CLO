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
import { buildWorkerInstructions, returnContractFor } from "./worker-instructions.js";

export interface AgentSubtaskRequest {
  packet: BootstrapPacket;
  instructions: string;
  returnContract: string[];
}

export type AgentSubtaskDispatcher = (
  request: AgentSubtaskRequest
) => Promise<string | Record<string, unknown>>;

function defaultDispatcher(): AgentSubtaskDispatcher | undefined {
  const host = globalThis as typeof globalThis & {
    __POLARIS_AGENT_SUBTASK_DISPATCH__?: AgentSubtaskDispatcher;
  };
  return host.__POLARIS_AGENT_SUBTASK_DISPATCH__;
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

    const instructions = buildWorkerInstructions(packet);
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
