import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../../config/loader.js";
import { TerminalCliAdapter } from "./terminal-cli.js";
import type { BootstrapPacket } from "./types.js";

type SubtaskDispatchRequest = {
  packet: BootstrapPacket;
  instructions: string;
  returnContract: string[];
};

type GlobalSubtaskDispatcher = (
  request: SubtaskDispatchRequest
) => Promise<string | Record<string, unknown>>;

type PacketWithResultContract = BootstrapPacket & {
  result_file_contract?: { result_file?: string };
};

function selectBridgeProvider(providers: Record<string, unknown>): string | null {
  const preferred = process.env.POLARIS_NATIVE_SUBTASK_PROVIDER?.trim();
  if (preferred && preferred.length > 0 && Object.prototype.hasOwnProperty.call(providers, preferred)) {
    return preferred;
  }
  if (Object.prototype.hasOwnProperty.call(providers, "copilot")) {
    return "copilot";
  }
  return null;
}

function parseSummaryObject(summary: string): Record<string, unknown> | null {
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(candidate) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeSealedStatus(raw: unknown): "success" | "failure" | "blocked" {
  const status = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (status === "done" || status === "success") {
    return "success";
  }
  if (status === "blocked") {
    return "blocked";
  }
  return "failure";
}

function hasValidationFailedSymptom(raw: unknown): boolean {
  return (
    Array.isArray(raw) &&
    raw.some(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        (s as Record<string, unknown>)["category"] === "validation-failed",
    )
  );
}

function normalizeSealedValidation(
  raw: unknown,
  runHealthSymptoms: unknown,
): "passed" | "failed" | "skipped" | undefined {
  if (hasValidationFailedSymptom(runHealthSymptoms)) {
    return "failed";
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const v = raw as Record<string, unknown>;
    const failed = Array.isArray(v["failed"]) ? (v["failed"] as unknown[]).length : 0;
    const passed = Array.isArray(v["passed"]) ? (v["passed"] as unknown[]).length : 0;
    if (failed > 0) return "failed";
    if (passed > 0) return "passed";
    return "skipped";
  }
  if (raw === "passed" || raw === "failed" || raw === "skipped") {
    return raw;
  }
  return undefined;
}

function normalizeSealedNextAction(
  raw: unknown,
  status: "success" | "failure" | "blocked",
  validation: "passed" | "failed" | "skipped" | undefined,
): "continue" | "stop" | "investigate" | undefined {
  if (validation === "failed" || status === "failure" || status === "blocked") {
    return "stop";
  }
  if (typeof raw === "string") {
    const action = raw.trim().toLowerCase();
    if (action === "continue") return "continue";
    if (action === "stop") return "stop";
    if (action === "escalate" || action === "investigate") return "investigate";
  }
  return undefined;
}

function writeSealedResultFromSummary(
  packet: PacketWithResultContract,
  parsedSummary: Record<string, unknown>,
): void {
  const resultFile = packet.result_file_contract?.result_file;
  if (!resultFile) {
    return;
  }

  const status = normalizeSealedStatus(parsedSummary["status"]);
  const commit =
    (typeof parsedSummary["commit"] === "string" && parsedSummary["commit"]) ||
    (typeof parsedSummary["commit_hash"] === "string" && parsedSummary["commit_hash"]) ||
    (typeof parsedSummary["commit_sha"] === "string" && parsedSummary["commit_sha"]) ||
    undefined;
  const rawValidation = parsedSummary["validation"] ?? parsedSummary["validation_summary"];
  const runHealthSymptoms = parsedSummary["run_health_symptoms"];
  let validation = normalizeSealedValidation(rawValidation, runHealthSymptoms);
  if (validation === undefined) {
    validation = status === "success" ? "passed" : status === "blocked" ? "skipped" : "failed";
  }
  if (status === "success" && validation === "skipped") {
    validation = "passed";
  }
  let nextAction = normalizeSealedNextAction(
    parsedSummary["next_recommended_action"] ?? parsedSummary["next_action"],
    status,
    validation,
  );
  if (nextAction === undefined) {
    nextAction = status === "success" && validation === "passed" ? "continue" : "stop";
  }

  const sealedResult: Record<string, unknown> = {
    run_id: packet.run_id,
    child_id: packet.active_child,
    status,
    validation,
    next_recommended_action: nextAction,
  };
  if (commit) {
    sealedResult["commit"] = commit;
  }
  if (Array.isArray(runHealthSymptoms)) {
    sealedResult["run_health_symptoms"] = runHealthSymptoms;
  }

  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, JSON.stringify(sealedResult, null, 2), "utf-8");
}

export function installCliSubtaskBridge(repoRoot: string): void {
  const host = globalThis as typeof globalThis & {
    __POLARIS_AGENT_SUBTASK_DISPATCH__?: GlobalSubtaskDispatcher;
  };
  if (host.__POLARIS_AGENT_SUBTASK_DISPATCH__) {
    return;
  }

  const config = loadConfig(repoRoot);
  const execution = config.execution;
  if (!execution || !execution.providers) {
    return;
  }

  const provider = selectBridgeProvider(execution.providers);
  if (!provider) {
    return;
  }

  const adapter = new TerminalCliAdapter(execution);

  host.__POLARIS_AGENT_SUBTASK_DISPATCH__ = async ({ packet }) => {
    const result = await adapter.dispatch(packet, { provider });
    const summary = result.summary ?? result.stdout ?? result.stderr ?? "";
    if (result.exit_code !== 0) {
      throw new Error(
        `CLI subtask bridge provider "${provider}" failed: ${summary || "no summary available"}`
      );
    }
    const parsedSummary = parseSummaryObject(summary);
    if (!parsedSummary) {
      throw new Error(
        `CLI subtask bridge provider "${provider}" returned non-JSON summary required for sealed result contract`
      );
    }
    writeSealedResultFromSummary(packet as PacketWithResultContract, parsedSummary);
    return parsedSummary;
  };
}
