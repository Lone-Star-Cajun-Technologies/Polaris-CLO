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
  `  - Your FINAL RESPONSE must be EXCLUSIVELY the compact return JSON object — a single JSON object on one line, nothing else.`,
  `  - Do NOT include any preamble, explanation, narration, or text before or after the JSON in your final response.`,
  `  - Do NOT summarize what you did. Do NOT say "Here is the compact return:". Output only the raw JSON.`,
  `  - The foreman session receives only your final response. Keep it to the JSON alone so it cannot observe your work.`,
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

  if (instructions.validation_expectations && instructions.validation_expectations.length > 0) {
    lines.push(
      ``,
      `VALIDATION EXPECTATIONS:`,
      ...instructions.validation_expectations.map((e) => `  ${e}`),
    );
  }

  lines.push(
    ``,
    `REQUIRED RETURN FIELDS: ${return_contract.join(", ")}`,
    `STATE FILE: ${packet.state_file}`,
    `TELEMETRY FILE: ${packet.telemetry_file}`,
    `SEALED RESULT FILE: ${packet.result_file_contract.result_file}`,
    `Write the sealed result file as a JSON object with EXACTLY this shape:`,
    `  { "run_id": "<run_id>", "child_id": "<child_id>", "status": "success" | "failure",`,
    `    "commit": "<full 40-char SHA>", "validation": { "passed": ["<cmd>", ...], "failed": ["<cmd>", ...] },`,
    `    "next_recommended_action": "continue" | "stop" | "investigate",`,
    `    "error_message": "<string or omit if success>" }`,
    `If a validation command fails, move it from validation.passed to validation.failed, set status to "failure", and set next_recommended_action to "stop". Do not list a failed command under passed.`,
    `commit MUST be the full 40-character git SHA (git rev-parse HEAD). Do NOT use a short hash.`,
    `Your final response MUST be ONLY the compact return JSON — a single JSON object, no other text.`,
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
    `Execute only ${packet.active_child}, update the state and telemetry files named in the packet, and return ONLY the compact JSON as your final response — no preamble, no narration, no other text.`,
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
