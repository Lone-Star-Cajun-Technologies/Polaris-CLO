/**
 * Agent-subtask adapter — dispatches a worker as a native agent subtask.
 *
 * In an environment that supports native subtask dispatch (e.g. Claude Code
 * with the TaskCreate tool), the parent invokes a subtask rather than spawning
 * a shell process. The contract is identical: one bootstrap packet in, one
 * compact return JSON out.
 *
 * When native dispatch is unavailable at runtime this adapter throws so the
 * caller can fall back to terminal-cli or surface a clear error.
 */

import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./types.js";

export interface AgentSubtaskRequest {
  packet: BootstrapPacket;
  instructions: string;
  returnContract: string[];
}

export type AgentSubtaskDispatcher = (
  request: AgentSubtaskRequest
) => Promise<string | Record<string, unknown>>;

const RETURN_CONTRACT = [
  "child_id",
  "status",
  "commit_hash",
  "validation_summary",
  "next_action",
  "warnings",
];

function defaultDispatcher(): AgentSubtaskDispatcher | undefined {
  const host = globalThis as typeof globalThis & {
    __POLARIS_AGENT_SUBTASK_DISPATCH__?: AgentSubtaskDispatcher;
  };
  return host.__POLARIS_AGENT_SUBTASK_DISPATCH__;
}

function buildInstructions(packet: BootstrapPacket): string {
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
    `Required return fields: ${RETURN_CONTRACT.join(", ")}`,
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
    const returnedChild = parsed.child_id ?? parsed.active_child;
    if (returnedChild !== packet.active_child) {
      return `Native subtask returned mismatched child_id: expected ${packet.active_child}, got ${String(returnedChild)}`;
    }
    if (!["done", "blocked", "error"].includes(String(parsed.status))) {
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
    const commandRun = `agent-subtask:${packet.active_child}`;
    const provider = options.provider || "agent-subtask";
    const instructions = buildInstructions(packet);

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

    if (options.dryRun) {
      return {
        exit_code: 0,
        provider_used: provider,
        command_run: commandRun,
        summary: JSON.stringify({
          child_id: packet.active_child,
          status: "done",
          validation_summary: "dry-run: native ephemeral agent subtask dispatch not executed",
          next_action: "resume-parent",
          warnings: ["dry-run"],
        }),
      };
    }

    try {
      const rawSummary = await this.dispatcher({
        packet,
        instructions,
        returnContract: RETURN_CONTRACT,
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
