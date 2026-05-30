import { isWorkerPacket } from "../worker-packet.js";
import type { BootstrapPacket } from "./types.js";

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
    `STATE FILE: ${packet.state_file}`,
    `TELEMETRY FILE: ${packet.telemetry_file}`,
    ...(packet.result_file_contract?.result_file
      ? [
          `SEALED RESULT FILE: ${packet.result_file_contract.result_file}`,
          `Write a JSON object to the sealed result file with: run_id, child_id, status ("success" or "failure"), commit, validation, and error_message when applicable.`,
          `Also print the compact return JSON to stdout as the final line.`,
        ]
      : []),
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

/** Build terminal/agent worker instructions for this packet. */
export function buildWorkerInstructions(packet: BootstrapPacket): string {
  return buildCompiledInstructions(packet);
}

/** Returns the return contract for this packet (compiled or legacy). */
export function returnContractFor(packet: BootstrapPacket): string[] {
  return isWorkerPacket(packet) ? packet.return_contract : LEGACY_RETURN_CONTRACT;
}
